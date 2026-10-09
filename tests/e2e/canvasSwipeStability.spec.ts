// Swiping a busy desk must not take the renderer down.
//
// Reported 2026-10-10: "screen goes white and [yjs source] is printed on screen
// on swipe". The cause was a MutationObserver on document.body with
// subtree: true that re-measured the canvas — two getBoundingClientRect calls,
// so a forced synchronous reflow — on EVERY DOM mutation in the app. A swipe
// mutates the DOM continuously: the pan transform changes, off-viewport
// widgets mount and unmount, and the minimap auto-opens with an animation. Each
// of those mutations forced another reflow, and the renderer could be driven
// into a layout-thrash storm until the window went white.
//
// The inset it existed for now comes from the assistant's own store, so this
// test is the guard that no one reintroduces a document-wide observer: a
// sustained swipe over a busy desk, with the assistant open, must leave the
// canvas rendered and the renderer error-free.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

test('CSS-1 — a sustained swipe on a busy desk keeps the renderer alive', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`)
  })

  // Enough widgets, spread wide enough, that virtualisation churns while panning.
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.nodes.create({ parentId: null, kind: 'task', title: 'Swipe desk' })
    for (let i = 0; i < 40; i++) {
      await api.widgets.create({
        taskId: d.id,
        kind: 'sticky',
        title: `s${i}`,
        content: `sticky ${i}`,
        x: (i % 8) * 520,
        y: Math.floor(i / 8) * 420,
        width: 280,
        height: 220
      })
    }
    return d.id
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })

  // Assistant open: that is the state whose geometry the removed observer was
  // watching for, so it is the state to swipe in.
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  await window.waitForTimeout(600)

  const surface = window.locator('[data-canvas-surface="true"]')
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2
  await window.mouse.move(cx, cy)

  // A long two-finger swipe: many wheel events, as a trackpad delivers them.
  for (let i = 0; i < 120; i++) {
    await window.mouse.wheel(i % 2 === 0 ? 40 : -30, i % 3 === 0 ? 50 : -40)
  }
  await window.waitForTimeout(900)

  // Still a desk, not a white window.
  await expect(surface).toBeVisible()
  const alive = await window.evaluate(() => {
    const surf = document.querySelector('[data-canvas-surface="true"]')
    return {
      hasSurface: !!surf,
      widgets: document.querySelectorAll('[data-widget-id]').length,
      // The crash printed library source into the document; nothing should.
      leakedSource: /readItemContent|unexpectedCase\(\)|structSkipRefNumber/.test(
        document.body.innerText
      )
    }
  })
  expect(alive.hasSurface, 'the canvas surface survived the swipe').toBe(true)
  expect(alive.widgets, 'widgets are still mounted').toBeGreaterThan(0)
  expect(alive.leakedSource, 'no module source rendered into the page').toBe(false)

  // And the camera actually moved, so the swipe was real.
  const panned = await window.evaluate(() => {
    const w = window as unknown as {
      __fbWidgets?: { getState: () => { panX: number; panY: number } }
    }
    const s = w.__fbWidgets!.getState()
    return Math.abs(s.panX) + Math.abs(s.panY)
  })
  expect(panned, 'the swipe panned the canvas').toBeGreaterThan(0)

  expect(errors, 'no renderer errors during the swipe').toEqual([])
})
