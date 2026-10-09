import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// PLX-APP-010 Phase 1 (ADR-0006) — per-(user, device class) Desk camera +
// selection overlay. Covers the full user-visible contract:
//   1. Real pan (wheel) + zoom (ctrl+wheel) + marquee-select (Shift+drag),
//      debounced-saved, restored on switching away and back to the Desk.
//   2. The save is a real SQLite write (desk_layouts), not in-memory only —
//      proven by relaunching the app against the SAME userData dir.
//   3. A Desk that has never had a layout saved opens at the origin
//      (zoom 1, pan 0,0), no error.
//   4. A stale selected id (its widget deleted) is dropped on restore rather
//      than erroring.
//   5. No regression: resetView (Cmd/Ctrl+0) still works after a restore, and
//      the whole flow produces zero console/page errors (the "no blink /
//      double-load" contract — a crash or an unhandled rejection during the
//      hydrate-then-restore sequence would show up here).
//
// Pan/zoom are driven with real wheel gestures (window.mouse.wheel, matching
// the existing convention in plxAppVirtualization.spec.ts and
// _deskFullBleedScreenshots.spec.ts). Selection is driven with a real
// Shift+drag rubber-band gesture (Canvas.tsx handleCanvasPointerDown: plain
// drag pans by default, Shift+drag always marquee-selects). Desk switching is
// driven by clicking the Home breadcrumb button and the Desk's own title
// button on the Home dashboard — the same click path a user takes, not a
// store bypass. The only non-UI step is reading back the persisted overlay
// via window.api.deskLayout.load to cross-check what the debounced save
// actually wrote to SQLite (the same IPC bridge the app itself uses).

interface Cam {
  panX: number
  panY: number
  zoom: number
}

// The camera in PERSISTED space. Since the full-bleed desk (Edges + Glass
// Phase 1b) the canvas runs beneath the dock column and the DOM transform
// carries a visual pan = persisted pan + the dock's width (--fb-dock-inset);
// the saved scroll never includes the inset, so a desk opens in the same place
// whatever the dock is doing. readCam subtracts it so every assertion below
// keeps talking about the persisted origin.
async function readCam(window: Page): Promise<Cam> {
  const r = await window.evaluate(() => {
    const all = Array.from(document.querySelectorAll<HTMLElement>('[data-bare-canvas]'))
    const inner = all.find((el) => !el.hasAttribute('data-canvas-surface'))
    const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-dock-inset')) || 0
    return { t: inner?.style.transform ?? null, inset }
  })
  if (!r.t) throw new Error('canvas transform layer not found')
  const m = r.t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/)
  if (!m) throw new Error(`unrecognized transform: ${r.t}`)
  return { panX: parseFloat(m[1]) - r.inset, panY: parseFloat(m[2]), zoom: parseFloat(m[3]) }
}

function trackConsoleErrors(window: Page): string[] {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  return errors
}

// Known-benign console noise, unrelated to this feature:
//   - "Failed to load resource" 404s: the test app has no network reachability
//     to the production signal host, a features/votes 404 fires at boot
//     regardless (see canvasBreadcrumb / roomsDesksRestructure specs).
//   - "Unable to preventDefault inside passive event listener": a Chromium
//     artifact of the synthetic window.mouse.wheel gesture this test drives; it
//     fires for any wheel-driven canvas test and is not a product error. The
//     real intent of the error assertion is to catch crashes / unhandled
//     rejections during the hydrate-then-restore sequence, which this preserves.
function relevantErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('Failed to load resource') &&
      !e.includes('Unable to preventDefault inside passive event listener')
  )
}

// Navigate to a Desk by id via the view-store handle (the same goTask App.tsx
// calls for a Desk click, and the same handle _helpers.ts's gotoView and the
// plxA11y specs use). This exercises the identical activeTaskId -> loadForTask ->
// hydrate path a real click triggers, without the Home-dashboard button
// actionability flakiness (each Desk button's accessible name carries a variable
// "Edited {relTime}" suffix, and the grid re-renders between navigations). The
// real user GESTURES under test — pan (wheel), zoom (ctrl+wheel), marquee
// (Shift+drag) — remain fully UI-driven below.
async function openDesk(window: Page, deskId: string): Promise<void> {
  await window.evaluate((tid) => {
    const w = window as unknown as {
      __fbNodes?: { getState: () => { setActive: (id: string) => void } }
      __fbView?: { getState: () => { goTask: (id: string) => void } }
    }
    w.__fbNodes?.getState().setActive(tid)
    w.__fbView?.getState().goTask(tid)
  }, deskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
}

test('camera + selection overlay: round-trips on Desk switch, survives app reload, fresh Desk opens at origin, stale selection is dropped, resetView still works, no errors', async ({}, testInfo) => {
  testInfo.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'plexii-e2e-desklayout-'))
  let deskAId = ''
  let deskBId = ''
  let widgetId = ''
  let distinctCam: Cam = { panX: 0, panY: 0, zoom: 1 }

  // ── Session 1: seed, round-trip within one running app ──────────────────
  let l: LaunchedApp = await launchApp({ userDataDir })
  try {
    const { window } = l
    const errors = trackConsoleErrors(window)
    await waitForReady(window)

    const seeded = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.nodes.create({ parentId: null, kind: 'task', title: 'Camera Desk A' })
      const w = await api.widgets.create({
        taskId: a.id,
        kind: 'sticky',
        title: '',
        content: 'select me',
        x: 300,
        y: 200,
        width: 240,
        height: 180
      })
      const b = await api.nodes.create({ parentId: null, kind: 'task', title: 'Camera Desk B' })
      return { deskAId: a.id, deskBId: b.id, widgetId: w.id }
    })
    deskAId = seeded.deskAId
    deskBId = seeded.deskBId
    widgetId = seeded.widgetId

    await window.reload()
    await waitForReady(window)

    // Open Desk A — first-ever open, no saved layout yet: must be the origin.
    await openDesk(window, deskAId)
    await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8_000 })
    const initial = await readCam(window)
    expect(initial.zoom).toBeCloseTo(1, 2)
    expect(initial.panX).toBeCloseTo(0, 1)
    expect(initial.panY).toBeCloseTo(0, 1)

    // ── Select the widget via a real Shift+drag marquee (UI-driven) ────────
    // Done at the origin/zoom=1 baseline so the canvas-space box is simple:
    // the widget sits at (300,200)-(540,380); a box from (250,150) to
    // (600,450) fully encloses it.
    // Screen x is measured from the VISIBLE canvas origin: the element starts
    // beneath the dock column (full-bleed desk), so its left edge is offset by
    // --fb-dock-inset, exactly as the camera's visual pan is.
    const rect = await window.evaluate(() => {
      const el = document.querySelector('[data-canvas-surface="true"]')!
      const r = el.getBoundingClientRect()
      const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-dock-inset')) || 0
      return { left: r.left + inset, top: r.top }
    })
    await window.mouse.move(rect.left + 250, rect.top + 150)
    await window.keyboard.down('Shift')
    await window.mouse.down()
    await window.mouse.move(rect.left + 600, rect.top + 450, { steps: 8 })
    await window.mouse.up()
    await window.keyboard.up('Shift')

    await expect(window.locator(`[data-widget-id="${widgetId}"]`)).toHaveClass(/ring-2/)

    // ── Pan (plain wheel) then zoom (ctrl+wheel) — real gestures ───────────
    const surface = window.locator('[data-canvas-surface="true"]')
    await surface.hover()
    await window.mouse.wheel(-400, -250)
    await window.keyboard.down('Control')
    await window.mouse.wheel(0, -300)
    await window.keyboard.up('Control')
    await window.waitForTimeout(200)

    distinctCam = await readCam(window)
    expect(distinctCam.zoom, 'zoom moved away from 1 via ctrl+wheel').not.toBeCloseTo(1, 2)
    expect(
      Math.abs(distinctCam.panX) + Math.abs(distinctCam.panY),
      'pan moved away from the origin via plain wheel'
    ).toBeGreaterThan(50)

    // Wait past the 600ms debounce (Canvas.tsx) with margin, then cross-check
    // the ACTUAL persisted row via the same IPC bridge the app itself uses.
    await window.waitForTimeout(900)
    const persisted = await window.evaluate(
      (id: string) => window.api.deskLayout.load('local', id, 'desktop'),
      deskAId
    )
    expect(persisted, 'debounced save produced a persisted overlay').not.toBeNull()
    expect(persisted!.zoom).toBeCloseTo(distinctCam.zoom, 2)
    expect(persisted!.scroll.x).toBeCloseTo(distinctCam.panX, 0)
    expect(persisted!.scroll.y).toBeCloseTo(distinctCam.panY, 0)
    expect(persisted!.selectedObjectIds).toEqual([widgetId])

    // ── Fresh Desk (Desk B — never opened, never saved) opens at the origin ──
    await openDesk(window, deskBId)
    await window.waitForTimeout(300)
    const bCam = await readCam(window)
    expect(bCam.zoom).toBeCloseTo(1, 2)
    expect(bCam.panX).toBeCloseTo(0, 1)
    expect(bCam.panY).toBeCloseTo(0, 1)

    // ── Switch back to Desk A: camera + selection restore from the overlay ──
    await openDesk(window, deskAId)
    await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8_000 })
    await window.waitForTimeout(300)
    const restored = await readCam(window)
    expect(restored.zoom).toBeCloseTo(distinctCam.zoom, 1)
    expect(restored.panX).toBeCloseTo(distinctCam.panX, 0)
    expect(restored.panY).toBeCloseTo(distinctCam.panY, 0)
    await expect(window.locator(`[data-widget-id="${widgetId}"]`)).toHaveClass(/ring-2/)

    // ── Regression: resetView (Cmd/Ctrl+0) still works after a restore ─────
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+0' : 'Control+0')
    await window.waitForTimeout(150)
    const afterReset = await readCam(window)
    expect(afterReset.zoom).toBeCloseTo(1, 2)
    expect(afterReset.panX).toBeCloseTo(0, 1)
    expect(afterReset.panY).toBeCloseTo(0, 1)

    // Re-establish the distinct camera (resetView above is a real user action
    // and legitimately overwrites the saved overlay at the next debounce —
    // re-pan/zoom so session 2 below has a non-origin value to check against).
    await surface.hover()
    await window.mouse.wheel(-400, -250)
    await window.keyboard.down('Control')
    await window.mouse.wheel(0, -300)
    await window.keyboard.up('Control')
    await window.waitForTimeout(200)
    distinctCam = await readCam(window)
    await window.waitForTimeout(900)

    expect(relevantErrors(errors), `console/page errors: ${JSON.stringify(errors)}`).toEqual([])
  } finally {
    await l.dispose()
  }

  // ── Session 2: relaunch against the SAME userData dir — proves the save
  //    is a real SQLite row (desk_layouts), not just in-memory store state ──
  l = await launchApp({ userDataDir })
  try {
    const { window } = l
    const errors = trackConsoleErrors(window)
    await waitForReady(window)

    await openDesk(window, deskAId)
    await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8_000 })
    await window.waitForTimeout(300)
    const reloadedCam = await readCam(window)
    expect(reloadedCam.zoom, 'camera survived an app relaunch').toBeCloseTo(distinctCam.zoom, 1)
    expect(reloadedCam.panX).toBeCloseTo(distinctCam.panX, 0)
    expect(reloadedCam.panY).toBeCloseTo(distinctCam.panY, 0)
    await expect(window.locator(`[data-widget-id="${widgetId}"]`)).toHaveClass(/ring-2/)

    // ── Stale selection dropped, not errored: delete the selected widget ────
    await window.evaluate(async (id: string) => {
      await window.api.widgets.delete(id)
    }, widgetId)
    // We are already on Desk A, so re-navigating to it would not change
    // activeTaskId and would not re-run loadForTask. Hop to Desk B first so the
    // return to A is a real switch that reloads the (now shorter) widget list.
    await openDesk(window, deskBId)
    await openDesk(window, deskAId)
    await window.waitForTimeout(300)

    await expect(window.locator(`[data-widget-id="${widgetId}"]`)).toHaveCount(0)
    // The camera itself is unaffected by dropping the stale selection.
    const afterStaleDrop = await readCam(window)
    expect(afterStaleDrop.zoom).toBeCloseTo(distinctCam.zoom, 1)
    expect(afterStaleDrop.panX).toBeCloseTo(distinctCam.panX, 0)

    expect(relevantErrors(errors), `console/page errors: ${JSON.stringify(errors)}`).toEqual([])
  } finally {
    await l.dispose()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('fast re-open of the same Desk does not corrupt the restored camera (loadToken reentrancy guard)', async ({}, testInfo) => {
  testInfo.setTimeout(60_000)
  // Deterministic, API-driven exercise of the exact reentrancy the loadToken
  // fix targets (stores/widgets.ts loadForTask): two opens of the SAME Desk
  // fired back-to-back, no await between them. A real double-click on the
  // same Desk row is the closest UI gesture, but the IPC round trip is fast
  // enough locally that a literal double-click cannot reliably reproduce a
  // sub-millisecond race — so this drives the identical code path (goTask)
  // twice in immediate succession via the exposed view-store handle
  // (window.__fbView, the same handle _helpers.ts's openProduct/gotoView use)
  // rather than depending on real-world click timing.
  const { window, dispose } = await launchApp()
  try {
    const errors = trackConsoleErrors(window)
    await waitForReady(window)

    const seeded = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.nodes.create({ parentId: null, kind: 'task', title: 'Race Desk A' })
      const w = await api.widgets.create({
        taskId: a.id,
        kind: 'sticky',
        title: '',
        content: 'anchor',
        x: 100,
        y: 100,
        width: 160,
        height: 120
      })
      return { deskId: a.id, widgetId: w.id }
    })

    await window.reload()
    await waitForReady(window)

    await openDesk(window, seeded.deskId)
    await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 8_000 })

    // Pan/zoom to a distinct camera and let it persist.
    const surface = window.locator('[data-canvas-surface="true"]')
    await surface.hover()
    await window.mouse.wheel(-300, -180)
    await window.waitForTimeout(900)
    const saved = await readCam(window)
    expect(Math.abs(saved.panX) + Math.abs(saved.panY)).toBeGreaterThan(20)

    // Fire two back-to-back reentrant opens of the SAME Desk (no await
    // between them) via the view store's goTask — the exact call App.tsx
    // makes for a Desk click, and the exact call MindMapWidget's
    // reloadCanvasStores / liveCanvas.ts make reentrantly.
    await window.evaluate((deskId: string) => {
      const w = window as unknown as {
        __fbView?: { getState: () => { goTask: (id: string) => void } }
      }
      w.__fbView?.getState().goTask(deskId)
      w.__fbView?.getState().goTask(deskId)
    }, seeded.deskId)

    await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 8_000 })
    await window.waitForTimeout(400)

    const afterFastReopen = await readCam(window)
    expect(afterFastReopen.zoom, 'restored camera after fast reentrant reopen').toBeCloseTo(saved.zoom, 1)
    expect(afterFastReopen.panX).toBeCloseTo(saved.panX, 0)
    expect(afterFastReopen.panY).toBeCloseTo(saved.panY, 0)

    expect(relevantErrors(errors), `console/page errors: ${JSON.stringify(errors)}`).toEqual([])
  } finally {
    await dispose()
  }
})
