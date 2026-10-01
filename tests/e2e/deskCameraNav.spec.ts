import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Walking the desk with the arrow keys.
//
// The choice of widget and the camera arithmetic are unit-tested in
// deskCameraNav.test.ts. What cannot be tested there is everything this spec
// covers: that the listener is actually attached, that it reads the live store
// rather than a stale closure, that the camera really lands where the maths says
// — measured against the real viewport and the real dock inset — and that the
// guards hold, so the feature does not quietly eat ⌘← or an arrow key meant for
// a text field.
//
// Each test seeds only the widgets it reasons about. The first version put all
// of them on one desk, including a very wide one further down, and then asserted
// that → at the end of the top row did nothing -- but that wide widget extended
// past the row, so it genuinely WAS to the right and navigation correctly went
// there. The feature was right and the fixture was wrong, which is the most
// expensive kind of failing test.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const mid = (w: Box): { x: number; y: number } => ({
  x: w.x + w.width / 2,
  y: w.y + w.height / 2
})

interface Seeded {
  deskId: string
  /** Stored geometry, keyed by title. Read back, never assumed -- see below. */
  box: Record<string, Box>
  idOf: Record<string, string>
}

/**
 * Create a desk with these widgets, open it, and report what was actually
 * stored.
 *
 * The read-back matters: widgets.create clamps a size it considers too large
 * (a 1900px-tall widget came back 900 tall), so expectations computed from the
 * values passed in are fiction, and the resulting failures look like navigation
 * bugs rather than fixture bugs.
 */
async function seedDesk(window: Page, layout: Record<string, Box>): Promise<Seeded> {
  const deskId = await window.evaluate(async (l) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Camera nav' })
    for (const [title, box] of Object.entries(l)) {
      await api.widgets.create({
        taskId: desk.id,
        kind: 'sticky',
        title,
        content: title,
        ...(box as Record<string, number>)
      })
    }
    return desk.id as string
  }, layout)

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
  // The persisted camera is restored asynchronously and would otherwise clobber
  // whatever we set a frame later.
  await window.waitForFunction(
    (id) =>
      (window as unknown as { __fbWidgets: { getState: () => { layoutHydratedFor: string | null } } })
        .__fbWidgets.getState().layoutHydratedFor === id,
    deskId,
    { timeout: 15_000 }
  )

  const read = await window.evaluate((id) => {
    const st = (window as unknown as { __fbWidgets: { getState: () => Record<string, any> } })
      .__fbWidgets.getState()
    const box: Record<string, Box> = {}
    const idOf: Record<string, string> = {}
    for (const w of st.widgets as Array<Record<string, any>>) {
      if (w.taskId !== id) continue
      box[w.title as string] = { x: w.x, y: w.y, width: w.width, height: w.height }
      idOf[w.title as string] = w.id as string
    }
    return { box, idOf }
  }, deskId)

  return { deskId, ...read }
}

interface Cam {
  zoom: number
  /** Title of the single selected widget, which is where the camera landed. */
  at: string | null
  /** Canvas-space point at the middle of the visible canvas. */
  centre: { x: number; y: number }
}

/**
 * Read the camera the way the feature computes it: from the live store plus the
 * measured surface, including the dock inset. Deliberately not a regex over the
 * transform — the inset is where this is easy to get wrong, and the transform
 * alone cannot show it. Reports a title rather than an id so a failure says
 * "expected c, got huge" instead of comparing two uuids.
 */
async function camera(window: Page): Promise<Cam> {
  return window.evaluate(() => {
    const st = (window as unknown as { __fbWidgets: { getState: () => Record<string, any> } })
      .__fbWidgets.getState()
    const sel = st.selectedIds as string[]
    const hit = (st.widgets as Array<Record<string, any>>).find((w) => w.id === sel[0])
    const surface = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
    const r = surface!.getBoundingClientRect()
    const visibleW = Math.max(1, r.width - st.dockInset)
    return {
      zoom: st.zoom as number,
      at: hit ? (hit.title as string) : null,
      centre: {
        x: (st.dockInset + visibleW / 2 - st.panX) / st.zoom,
        y: (r.height / 2 - st.panY) / st.zoom
      }
    }
  })
}

/** Park the anchor on a known widget, zoomed out, so a step is deterministic. */
async function startFrom(window: Page, id: string): Promise<void> {
  await window.evaluate((wid) => {
    const st = (window as unknown as { __fbWidgets: { getState: () => Record<string, any> } })
      .__fbWidgets.getState()
    st.setSelection([wid])
    st.setZoom(0.5)
  }, id)
}

const step = async (window: Page, key: string): Promise<Cam> => {
  await window.keyboard.press(key)
  // Comfortably past the 280ms camera transition.
  await window.waitForTimeout(450)
  return camera(window)
}

const ROW: Record<string, Box> = {
  a: { x: 0, y: 0, width: 300, height: 240 },
  b: { x: 700, y: 0, width: 300, height: 240 },
  c: { x: 1400, y: 0, width: 300, height: 240 },
  below: { x: 700, y: 800, width: 300, height: 240 }
}

test('arrow keys move the camera from widget to widget, framing each one', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { box, idOf } = await seedDesk(window, ROW)
  await startFrom(window, idOf.a)

  // → steps to the next widget along and centres it.
  let cam = await step(window, 'ArrowRight')
  expect(cam.at).toBe('b')
  expect(cam.centre.x).toBeCloseTo(mid(box.b).x, 0)
  expect(cam.centre.y).toBeCloseTo(mid(box.b).y, 0)

  // It zoomed IN from 0.5 to make the widget usable, and stopped at the cap
  // rather than filling the screen with it the way focus mode would.
  expect(cam.zoom).toBeGreaterThan(0.5)
  expect(cam.zoom).toBeCloseTo(1.25, 2)

  // One widget at a time, not straight to the end of the row.
  cam = await step(window, 'ArrowRight')
  expect(cam.at).toBe('c')
  expect(cam.centre.x).toBeCloseTo(mid(box.c).x, 0)

  // Nothing further right: it stays put rather than wrapping to the far side,
  // which would be indistinguishable from the camera losing its place.
  cam = await step(window, 'ArrowRight')
  expect(cam.at).toBe('c')
  expect(cam.centre.x).toBeCloseTo(mid(box.c).x, 0)

  // ← comes back.
  cam = await step(window, 'ArrowLeft')
  expect(cam.at).toBe('b')

  // ↓ leaves the row instead of continuing along it.
  cam = await step(window, 'ArrowDown')
  expect(cam.at).toBe('below')
  expect(cam.centre.y).toBeCloseTo(mid(box.below).y, 0)

  // ↑ returns, so the walk is reversible.
  cam = await step(window, 'ArrowUp')
  expect(cam.at).toBe('b')
})

test('a widget too big to fit is zoomed out until it does', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { box, idOf } = await seedDesk(window, {
    start: { x: 0, y: 0, width: 300, height: 240 },
    wide: { x: 0, y: 900, width: 2600, height: 900 }
  })
  await startFrom(window, idOf.start)

  const cam = await step(window, 'ArrowDown')
  expect(cam.at).toBe('wide')

  // "A size appropriate to use it" has to include being able to see all of it.
  expect(cam.zoom).toBeLessThan(1)
  const fits = await window.evaluate(
    ({ zoom, w }) => {
      const r = document
        .querySelector<HTMLElement>('[data-canvas-surface="true"]')!
        .getBoundingClientRect()
      const st = (window as unknown as { __fbWidgets: { getState: () => { dockInset: number } } })
        .__fbWidgets.getState()
      return {
        widthOk: w.width * zoom <= r.width - st.dockInset + 1,
        heightOk: w.height * zoom <= r.height + 1
      }
    },
    { zoom: cam.zoom, w: box.wide }
  )
  expect(fits.widthOk).toBe(true)
  expect(fits.heightOk).toBe(true)
})

test('the arrow keys stay out of the way of modifiers and text fields', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { idOf } = await seedDesk(window, {
    a: ROW.a,
    b: ROW.b
  })
  await startFrom(window, idOf.a)
  const before = await camera(window)

  // ⌘→ is back/forward through navigation history and must not move the camera.
  let now = await step(window, 'Meta+ArrowRight')
  expect(now.at).toBe('a')
  expect(now.zoom).toBeCloseTo(before.zoom, 6)

  // Nor may a plain arrow while the caret is in a text field. Tested through a
  // real focused input, because that is exactly what the guard inspects.
  await window.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'camera-nav-probe'
    document.body.appendChild(input)
    input.focus()
  })
  now = await step(window, 'ArrowRight')
  expect(now.at).toBe('a')
  expect(now.zoom).toBeCloseTo(before.zoom, 6)

  await window.evaluate(() => document.getElementById('camera-nav-probe')?.remove())
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  // And with the field gone it works again — so that was a guard, not a feature
  // that had quietly stopped working.
  now = await step(window, 'ArrowRight')
  expect(now.at).toBe('b')
})

/** Point the mouse at the middle of the canvas so wheel events land on it. */
async function hoverCanvas(window: Page): Promise<void> {
  const r = await window.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  await window.mouse.move(r.x, r.y)
}

test('a decisive two-finger flick steps a widget; a gentle one still pans', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { idOf } = await seedDesk(window, { a: ROW.a, b: ROW.b })
  await startFrom(window, idOf.a)
  await hoverCanvas(window)

  // A flick: fast (each event well past the per-event threshold) and clearly
  // along one axis. Real wheel events, so this exercises the same handler a
  // trackpad drives -- what it cannot tell us is how the thresholds FEEL, which
  // is why the behaviour sits behind a preference.
  for (let i = 0; i < 5; i++) await window.mouse.wheel(45, 0)
  await window.waitForTimeout(500)
  let cam = await camera(window)
  expect(cam.at).toBe('b')
  expect(cam.zoom).toBeCloseTo(1.25, 2)

  // A crawl must NOT step. Two-finger panning is an established feature with
  // its own sensitivity setting, and silently turning it into a carousel would
  // be a worse outcome than not having swipe navigation at all.
  //
  // Dispatched inside the page rather than through 30 mouse.wheel round trips.
  // The round-trip version passed with the per-event threshold set to ZERO,
  // because the protocol latency between events exceeded the window in which a
  // gesture accumulates -- so every event started a fresh gesture and nothing
  // could ever have stepped. It was asserting latency, not the threshold.
  await startFrom(window, idOf.a)
  const before = await camera(window)
  await window.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!
    const b = el.getBoundingClientRect()
    for (let i = 0; i < 30; i++) {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: 6,
          deltaY: 0,
          clientX: b.x + b.width / 2,
          clientY: b.y + b.height / 2,
          bubbles: true,
          cancelable: true
        })
      )
    }
  })
  await window.waitForTimeout(400)
  cam = await camera(window)
  expect(cam.at).toBe('a')
  expect(cam.zoom).toBeCloseTo(before.zoom, 6)
  // It panned instead: the camera moved, but it did not jump to a widget.
  expect(Math.abs(cam.centre.x - before.centre.x)).toBeGreaterThan(20)

  // Nor may a fast DIAGONAL drag step. A diagonal is someone moving the camera
  // across the desk, not picking a direction, and guessing which axis they
  // "meant" would send the view somewhere they did not ask for.
  await startFrom(window, idOf.a)
  const beforeDiag = await camera(window)
  await window.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!
    const b = el.getBoundingClientRect()
    for (let i = 0; i < 8; i++) {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: 45,
          deltaY: 45,
          clientX: b.x + b.width / 2,
          clientY: b.y + b.height / 2,
          bubbles: true,
          cancelable: true
        })
      )
    }
  })
  await window.waitForTimeout(400)
  cam = await camera(window)
  expect(cam.at).toBe('a')
  expect(cam.zoom).toBeCloseTo(beforeDiag.zoom, 6)
})

test('swipe navigation can be turned off, and then only pans', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Written the way the Settings toggle writes it, and written BEFORE the desk
  // is seeded so the reload seedDesk already does is the one that picks it up --
  // an extra reload here raced the debounced desk-layout save and tripped the
  // main process mid-write.
  await window.evaluate(() => {
    const raw = localStorage.getItem('fb.nav.prefs')
    const p = raw ? JSON.parse(raw) : {}
    p.swipeToWidget = false
    localStorage.setItem('fb.nav.prefs', JSON.stringify(p))
  })

  const { idOf } = await seedDesk(window, { a: ROW.a, b: ROW.b })
  await startFrom(window, idOf.a)
  await hoverCanvas(window)

  for (let i = 0; i < 5; i++) await window.mouse.wheel(45, 0)
  await window.waitForTimeout(500)
  const cam = await camera(window)
  expect(cam.at).toBe('a')

  // The arrow keys are unaffected — the toggle is about the trackpad only.
  const stepped = await step(window, 'ArrowRight')
  expect(stepped.at).toBe('b')
})
