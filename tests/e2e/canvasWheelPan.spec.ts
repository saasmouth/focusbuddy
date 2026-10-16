import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// "Swipe on the mouse and trackpad, edge perimeter canvas motion also doesn't
// work… click drag and release flick is working."
//
// THE SHAPE OF THE BUG, because that is the useful part. The wheel listener
// was attached in `useEffect(..., [])` against `dropRef.current`. That binds
// once, to whichever node existed at mount. When React recreates that div the
// ref is repointed at the new node while the listener stays on the old,
// detached one — and the effect never runs again, so nothing rebinds it. No
// error, no warning: the event reaches the element and nothing is listening.
//
// Edge-pan died with it because useEdgePan reads the same dropRef. Click-drag
// survived because it goes through React's own onPointerDown, which React
// rebinds for free. That asymmetry is exactly what was reported, and it is
// what a callback ref fixes.
//
// This dispatches a real wheel event and reads the camera out of the store.
// Reasoning about the cause got nowhere for several rounds; measuring found
// it immediately.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

async function openADesk(window: LaunchedApp['window']): Promise<void> {
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Wheel pan probe' })
    return task.id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const v = (window as unknown as {
      __fbView?: { getState: () => { goTask: (id: string) => void } }
    }).__fbView
    v?.getState().goTask(id)
  }, taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  await window.waitForTimeout(400)
}

test('a wheel gesture pans the canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openADesk(window)

  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const r = await window.evaluate(() => {
    const store = (window as unknown as {
      __fbWidgets?: { getState: () => { panX: number; panY: number; activeId: string | null } }
    }).__fbWidgets
    const el = document.querySelector('[data-canvas-surface="true"]') as HTMLElement | null
    if (!el || !store) return { ok: false as const, why: !el ? 'no surface' : 'no store' }

    const before = { x: store.getState().panX, y: store.getState().panY }
    const ev = new WheelEvent('wheel', { deltaX: 120, deltaY: 80, bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    const after = { x: store.getState().panX, y: store.getState().panY }
    return {
      ok: true as const,
      activeId: store.getState().activeId,
      moved: before.x !== after.x || before.y !== after.y,
      // The sharpest signal: false means the handler never ran at all, which
      // is what a listener bound to a replaced node looks like.
      defaultPrevented: ev.defaultPrevented
    }
  })

  expect(r.ok, JSON.stringify(r)).toBe(true)
  expect(errors, errors.join(' | ')).toEqual([])
  expect(r.defaultPrevented, `handler never ran: ${JSON.stringify(r)}`).toBe(true)
  expect(r.moved, `camera did not move: ${JSON.stringify(r)}`).toBe(true)
})

test('ctrl+wheel still zooms rather than panning', async () => {
  // The other branch of the same handler — a rebind that fixed one branch
  // and broke the other would otherwise pass unnoticed.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openADesk(window)

  const r = await window.evaluate(() => {
    const store = (window as unknown as {
      __fbWidgets?: { getState: () => { zoom: number } }
    }).__fbWidgets
    const el = document.querySelector('[data-canvas-surface="true"]') as HTMLElement | null
    if (!el || !store) return { ok: false as const, before: 0, after: 0 }
    const before = store.getState().zoom
    el.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
    )
    return { ok: true as const, before, after: store.getState().zoom }
  })

  expect(r.ok).toBe(true)
  expect(r.after, `zoom did not change from ${r.before}`).not.toBe(r.before)
})
