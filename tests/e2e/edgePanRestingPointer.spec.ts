/**
 * edgePanRestingPointer.spec.ts — the desk must not drift away from a resting
 * pointer (4.3.41), driven with the REAL mouse.
 *
 * Edge-pan pans the desk while the pointer is inside an 80 px zone at the
 * visible edges. Two faults let it pan for a pointer that never moved into it:
 *
 *  1. The desk surface was `overflow: hidden`, which is still scrollable.
 *     focus(), scrollIntoView, caret placement, Playwright's actionability
 *     retry all scrolled it ~104 px sideways for a frame before Canvas pinned
 *     it back, and anything that measured layout in that frame (Playwright
 *     did) aimed at the shifted point next to the dock: inside the zone. The
 *     desk then panned at ~750 px/s under the resting pointer
 *     (stickyWidget.spec.ts's 30 s hang). The surface is `overflow: clip` now.
 *  2. useEdgePan kept the pointer's position relative to the canvas from the
 *     last event. When the geometry changed under a resting pointer (the side
 *     menu expanding moves --fb-dock-inset) that position went stale: a
 *     pointer 120 px from the right edge was computed to be past it, and the
 *     desk flew off with no event at all. The hook now derives the position
 *     every frame and only ARMS on a pointer that moved into the zone.
 *
 * Real CGEvents (tests/e2e/_macMouse.ts), not Playwright's mouse: the bug is
 * about what Chromium does with a resting OS cursor, and CDP input takes a
 * different path. The OS cursor is put back where it was afterwards; the
 * window is pinned on top while the spec runs and unpinned after. Nothing
 * touches the clipboard.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { cursorLocation, moveMouse, path, pinWindowForRealInput, postMouse, unpinWindow, type ScreenPoint } from './_macMouse'

test.skip(process.platform !== 'darwin', 'posts macOS mouse events')

let app: LaunchedApp
let window: Page
let toScreen: (p: { x: number; y: number }) => ScreenPoint
let savedCursor: ScreenPoint
let anchorId = ''

interface Pan { x: number; y: number }
const readPan = (): Promise<Pan> =>
  window.evaluate(() => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { panX: number; panY: number } } }).__fbWidgets.getState()
    return { x: s.panX, y: s.panY }
  })

/** Camera motion over `ms` with nothing touched: the distance it travelled. */
async function driftOver(ms: number): Promise<{ before: Pan; after: Pan; moved: number }> {
  const before = await readPan()
  await window.waitForTimeout(ms)
  const after = await readPan()
  return { before, after, moved: Math.hypot(after.x - before.x, after.y - before.y) }
}

const surfaceRect = (): Promise<{ left: number; top: number; right: number; bottom: number; height: number }> =>
  window.evaluate(() => {
    const r = document.querySelector('[data-canvas-surface="true"]')!.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }
  })
const dockInset = (): Promise<number> =>
  window.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-dock-inset')) || 0)

/** Rest the real pointer at a page point, arriving by a short real move (so it is a real hover there). */
async function restAt(p: { x: number; y: number }, from: { dx: number }): Promise<void> {
  postMouse(path(toScreen({ x: p.x + from.dx, y: p.y }), toScreen(p), 6).map((at) => ({ kind: 'move' as const, at })))
  await window.waitForTimeout(400)
}

/** Collapse / expand the side menu by its own buttons, clicked from script so the pointer stays put. */
async function setMenu(expanded: boolean): Promise<void> {
  await window.evaluate((exp) => {
    const sel = exp ? '[data-testid="desk-sidebar-collapsed"] [title="Expand menu"]' : '[data-testid="desk-sidebar"] [data-testid="menu-minimize"]'
    const b = document.querySelector<HTMLElement>(sel)
    if (!b) throw new Error(`setMenu: ${sel} not found`)
    b.click()
  }, expanded)
  await window.waitForTimeout(500) // the dock's 200 ms width transition, then settle
}

/** Park the pointer mid-canvas (well outside every zone) so the camera rests. */
async function parkMidCanvas(): Promise<void> {
  const r = await surfaceRect()
  const inset = await dockInset()
  await restAt({ x: (r.left + inset + r.right) / 2, y: r.top + r.height / 2 }, { dx: 20 })
}

test.beforeAll(async () => {
  savedCursor = cursorLocation()
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.nodes.create({ parentId: null, kind: 'task', title: 'Resting pointer desk' })
    const anchor = await api.widgets.create({ taskId: d.id, kind: 'sticky', title: 'anchor', content: 'drag me', x: 120, y: 160, width: 260, height: 200 })
    // Far to the right, so the surface has real scroll range (scrollWidth >> clientWidth).
    for (let i = 0; i < 4; i++) {
      await api.widgets.create({ taskId: d.id, kind: 'sticky', title: `far${i}`, content: '', x: 2600 + i * 700, y: 200, width: 280, height: 220 })
    }
    return { deskId: d.id, anchorId: anchor.id }
  })
  anchorId = seeded.anchorId
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    ;(window as unknown as { __fbView: { getState: () => { goTask: (x: string) => void } } }).__fbView.getState().goTask(i)
  }, seeded.deskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${anchorId}"]`, { timeout: 8_000 })
  await window.waitForTimeout(800) // the desk's entrance animation
  toScreen = await pinWindowForRealInput(app.app, window)
})

test.afterAll(async () => {
  try {
    if (app) await unpinWindow(app.app).catch(() => undefined)
  } finally {
    if (savedCursor) moveMouse(savedCursor)
    await app?.dispose()
  }
})

test('ERP-1 the desk surface cannot be scrolled: assignment and scrollIntoView leave it at 0', async () => {
  const r = await window.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!
    const anchor = document.querySelector('[data-widget-id]')!.getBoundingClientRect().left
    s.scrollLeft = 104
    s.scrollTop = 40
    const afterAssign = { left: s.scrollLeft, top: s.scrollTop }
    // The far-right widget is off screen: scrollIntoView would scroll the
    // nearest scrollable box to reveal it.
    const far = Array.from(document.querySelectorAll('[data-widget-id]')).sort(
      (a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left
    )[0] as HTMLElement
    far.scrollIntoView({ block: 'center', inline: 'center' })
    const afterIntoView = { left: s.scrollLeft, top: s.scrollTop }
    const scrolledAncestors: string[] = []
    for (let e: HTMLElement | null = s; e; e = e.parentElement) {
      if (e.scrollLeft || e.scrollTop) scrolledAncestors.push(`${e.tagName}.${e.className.slice(0, 40)}:${e.scrollLeft},${e.scrollTop}`)
    }
    return {
      overflow: getComputedStyle(s).overflowX,
      range: s.scrollWidth - s.clientWidth,
      afterAssign,
      afterIntoView,
      scrolledAncestors,
      anchorShift: document.querySelector('[data-widget-id]')!.getBoundingClientRect().left - anchor
    }
  })
  console.log('[ERP-1]', JSON.stringify(r))
  // Content does reach past the right edge, so a scrollable box would scroll.
  expect(r.range, 'the desk content overflows the surface (else this proves nothing)').toBeGreaterThan(500)
  expect(r.afterAssign, 'scrollLeft/scrollTop stay 0 when assigned').toEqual({ left: 0, top: 0 })
  expect(r.afterIntoView, 'scrollIntoView does not scroll the surface').toEqual({ left: 0, top: 0 })
  expect(r.scrolledAncestors, 'nor any box around it').toEqual([])
  expect(Math.abs(r.anchorShift), 'the desk did not shift sideways, even for a frame').toBeLessThan(0.5)
})

test('ERP-2 menu expands under a pointer resting near the right edge: the camera stays put', async () => {
  await setMenu(false)
  const r = await surfaceRect()
  // 120 px in from the right edge: outside the 80 px zone, before and after.
  await restAt({ x: r.right - 120, y: r.top + r.height / 2 }, { dx: -40 })
  const settled = await driftOver(600)
  expect(settled.moved, 'resting outside the zone, the camera is still').toBeLessThan(1)
  await setMenu(true)
  // (Expanding the menu itself shifts panX once, by the inset change: the
  // camera compensates so the desk does not jump. Measure after that.)
  const drift = await driftOver(1500)
  console.log('[ERP-2]', JSON.stringify(drift))
  expect(drift.moved, 'no pan for a pointer that did not move').toBeLessThan(1)
})

test('ERP-3 menu expands so a resting pointer now sits in the zone by the dock: no pan', async () => {
  await setMenu(false)
  const r = await surfaceRect()
  await setMenu(true)
  const expandedInset = await dockInset()
  await setMenu(false)
  const collapsedInset = await dockInset()
  expect(expandedInset - collapsedInset, 'the menu really changes the inset').toBeGreaterThan(120)
  // 30 px right of where the expanded menu ends: far outside the zone while
  // collapsed, inside it once the menu expands.
  await restAt({ x: r.left + expandedInset + 30, y: r.top + r.height / 2 }, { dx: 40 })
  expect((await driftOver(600)).moved).toBeLessThan(1)
  await setMenu(true)
  const drift = await driftOver(1500)
  console.log('[ERP-3]', JSON.stringify(drift))
  expect(drift.moved, 'the zone sliding under a resting pointer does not start a pan').toBeLessThan(1)
})

test('ERP-4 a resting pointer near the dock survives scroll attempts and scrollIntoView', async () => {
  const r = await surfaceRect()
  const inset = await dockInset()
  // Outside the zone by 24 px: 104 px right of the dock's edge.
  await restAt({ x: r.left + inset + 104, y: r.top + r.height / 2 }, { dx: 30 })
  expect((await driftOver(600)).moved).toBeLessThan(1)
  await window.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!
    s.scrollLeft = 104
    const far = Array.from(document.querySelectorAll('[data-widget-id]')).sort(
      (a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left
    )[0] as HTMLElement
    far.scrollIntoView({ inline: 'end' })
    far.focus()
  })
  const drift = await driftOver(1500)
  console.log('[ERP-4]', JSON.stringify(drift))
  expect(drift.moved).toBeLessThan(1)
  expect(await window.evaluate(() => document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!.scrollLeft)).toBe(0)
})

test('ERP-5 a real drag of a widget into the right edge zone still pans, held still too', async () => {
  await parkMidCanvas()
  const handle = await window.evaluate((id) => {
    const h = document.querySelector(`[data-widget-id="${id}"] .widget-handle`) ?? document.querySelector(`[data-widget-id="${id}"]`)
    const b = h!.getBoundingClientRect()
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 }
  }, anchorId)
  const r = await surfaceRect()
  const target = { x: r.right - 25, y: handle.y }
  const start = await readPan()
  const pts = path(toScreen(handle), toScreen(target), 30)
  postMouse([{ kind: 'move', at: pts[0] }, { kind: 'down', at: pts[0] }, ...pts.slice(1).map((at) => ({ kind: 'drag' as const, at }))], 16)
  try {
    const dragging = await window.evaluate(() => document.documentElement.classList.contains('fb-canvas-dragging'))
    expect(dragging, 'the real press-and-move is a widget drag').toBe(true)
    // Held still at the edge: no further events, and the camera keeps going.
    const held = await driftOver(800)
    console.log('[ERP-5] held', JSON.stringify(held), 'from', JSON.stringify(start))
    expect(held.after.x, 'pointer at the right edge pans the world left').toBeLessThan(held.before.x - 100)
  } finally {
    postMouse([{ kind: 'up', at: pts[pts.length - 1] }])
  }
  await parkMidCanvas()
  const after = await driftOver(800)
  expect(after.moved, 'and stops once the pointer leaves the zone').toBeLessThan(1)
})
