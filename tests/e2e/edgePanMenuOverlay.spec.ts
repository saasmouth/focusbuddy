/**
 * edgePanMenuOverlay.spec.ts
 *
 * Verifies the overlay.ts / useMenuOverlay.ts edge-pan-stands-down-for-open-menus
 * fix on branch Plexi3.0, plus the FloatingPill viewport clamp and the
 * CanvasContextMenu anti-magnetic placement, per the tester dispatch brief.
 *
 * Signal used for "did the camera pan": the `[data-bare-canvas]` element that
 * carries the live `transform: translate(panX px, panY px) scale(zoom)` inline
 * style (Canvas.tsx line ~2167). There are two DOM nodes sharing the
 * `data-bare-canvas` attribute (the outer drop container and the inner
 * transform layer) — we select the one whose inline style actually contains
 * `translate(`, which is the transform layer driven by useWidgetStore's
 * panX/panY. Reading the rendered transform is a real user-visible signal
 * (it is literally what moves the camera on screen), not an internal store
 * hook.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedAndOpenDesk(l: LaunchedApp, label: string): Promise<string> {
  const { window } = l
  await waitForReady(window)
  const taskId = await window.evaluate(async (title: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title })
    await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'anchor',
      content: 'edge-pan test anchor', x: 100, y: 100, width: 160, height: 120
    })
    return task.id
  }, label)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(label) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 6_000 })
  // The desk action bar is docked in the header now (data-testid
  // "desk-action-bar"); "floating-pill" survives only in HeaderSlot's
  // fallback, so waiting on it hung every test in this file.
  await window.waitForSelector('[data-testid="desk-action-bar"]', { timeout: 6_000 })
  await window.waitForTimeout(200)
  return taskId
}

interface Pan { x: number; y: number }

async function readPan(window: import('@playwright/test').Page): Promise<Pan> {
  return window.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-bare-canvas]')) as HTMLElement[]
    const el = els.find((e) => e.style.transform && e.style.transform.includes('translate'))
    if (!el) return { x: NaN, y: NaN }
    const m = el.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
    if (!m) return { x: NaN, y: NaN }
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
  })
}

async function canvasRect(window: import('@playwright/test').Page) {
  return window.evaluate(() => {
    const el = document.querySelector('[data-canvas-surface="true"]') as HTMLElement
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  })
}

// Sample pan repeatedly over `ms` and report whether it ever moved.
async function panMovedOverWindow(
  window: import('@playwright/test').Page,
  start: Pan,
  ms: number,
  stepMs = 40
): Promise<boolean> {
  const steps = Math.max(1, Math.floor(ms / stepMs))
  for (let i = 0; i < steps; i++) {
    await window.waitForTimeout(stepMs)
    const p = await readPan(window)
    if (Math.abs(p.x - start.x) > 0.5 || Math.abs(p.y - start.y) > 0.5) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Check 3 (run first as the baseline) — regression: edge-pan works normally
// with no menu open or hovered.
// ---------------------------------------------------------------------------

test('EDGE-PAN-1 — baseline: edge-pan works with nothing hovered/open', async () => {
  launched = await launchApp()
  const { window } = launched
  const pageErrors: string[] = []
  window.on('pageerror', (e) => pageErrors.push(e.message))

  await seedAndOpenDesk(launched, 'Edge pan baseline')
  const rect = await canvasRect(window)

  // Move to a neutral spot first so mousePosRef is primed away from any edge.
  await window.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2)
  await window.waitForTimeout(150)
  const before = await readPan(window)

  // Move into the right-edge margin (default 80px), mid-height — clear of the
  // breadcrumb (top-left), the desk-presence chip (top-right) and the pill
  // (top-center default position).
  await window.mouse.move(rect.right - 5, rect.top + rect.height / 2, { steps: 5 })
  const moved = await panMovedOverWindow(window, before, 500)
  const after = await readPan(window)

  console.log('[EDGE-PAN-1] before', before, 'after', after, 'moved', moved)
  expect(moved, 'panX/panY must change when cursor sits in the edge zone with nothing hovered/open').toBe(true)
  expect(pageErrors, 'no uncaught console exceptions').toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Check 1 (the core fix) — edge-pan stands down while the pill is hovered.
// ---------------------------------------------------------------------------

test('EDGE-PAN-2 — edge-pan stands down over floating chrome, and resumes off it', async () => {
  launched = await launchApp()
  const { window } = launched
  const pageErrors: string[] = []
  window.on('pageerror', (e) => pageErrors.push(e.message))

  await seedAndOpenDesk(launched, 'Edge pan chrome hover')
  const rect = await canvasRect(window)

  // useEdgePan stands down whenever the pointer is over `.fb-floating-chrome`
  // or `[data-floating-menu]`. This used to be proved by dragging the
  // FloatingPill into the right-edge margin, but the desk action bar is docked
  // in the header now and cannot be dragged onto the canvas. The minimap FAB
  // is the floating chrome that still lives there — it carries both hooks and
  // sits inside the right-edge margin by design — so it is what this proves
  // the stand-down with.
  // Probe near the FAB's RIGHT edge, not its centre. The FAB is 32px wide
  // collapsed and 160px with its panel open, and its panel auto-opens after
  // any pan — so its centre can fall outside the 80px edge-pan margin while
  // its right edge, pinned at right-3, never does.
  const fab = await window.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-minimap-fab]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { px: r.right - 8, cy: r.top + r.height / 2, left: r.left, top: r.top }
  })
  expect(fab, 'the minimap FAB is present').not.toBeNull()

  // A point at the SAME x as the FAB but over bare canvas, so the only
  // difference between the two probes is what is under the pointer. The right
  // edge also carries the toolbar rail, so the y is chosen by asking the page
  // where there is genuinely no floating chrome rather than guessing.
  const bareY = await window.evaluate((x: number) => {
    for (let y = 120; y < window.innerHeight - 120; y += 20) {
      const el = document.elementFromPoint(x, y)
      if (!el) continue
      if (el.closest('.fb-floating-chrome, [data-floating-menu]')) continue
      if (!el.closest('[data-canvas-surface="true"]')) continue
      return y
    }
    return null
  }, fab!.px)
  expect(bareY, 'found a point at the FAB\'s x that is over bare canvas').not.toBeNull()
  const bare = { x: fab!.px, y: bareY! }

  await window.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2)
  await window.waitForTimeout(100)
  const baseStart = await readPan(window)
  await window.mouse.move(bare.x, bare.y, { steps: 3 })
  const baseMoved = await panMovedOverWindow(window, baseStart, 400, 50)
  expect(baseMoved, 'sanity: this x pans when the pointer is over bare canvas').toBe(true)

  // Settle, then hover the FAB at the same x — edge-pan must stand down.
  await window.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2)
  await window.waitForTimeout(200)
  const overStart = await readPan(window)
  await window.mouse.move(fab!.px, fab!.cy, { steps: 3 })
  const overMoved = await panMovedOverWindow(window, overStart, 500, 50)
  expect(overMoved, 'edge-pan stands down while the pointer is over floating chrome').toBe(false)

  // And it resumes once the pointer is back on bare canvas at the same x.
  const resumeStart = await readPan(window)
  await window.mouse.move(bare.x, bare.y, { steps: 3 })
  const resumed = await panMovedOverWindow(window, resumeStart, 500, 50)
  expect(resumed, 'edge-pan resumes after leaving the chrome').toBe(true)

  expect(pageErrors, 'no renderer errors').toEqual([])
})

test('EDGE-PAN-3 — edge-pan stands down while the context menu is open, resumes after close', async () => {
  launched = await launchApp()
  const { window } = launched
  const pageErrors: string[] = []
  window.on('pageerror', (e) => pageErrors.push(e.message))

  await seedAndOpenDesk(launched, 'Edge pan context menu')
  const rect = await canvasRect(window)

  // Move to a neutral spot, right-click near the canvas center (bare canvas,
  // away from the sticky at 100,100) to open the context menu.
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  await window.mouse.move(cx, cy)
  await window.mouse.click(cx, cy, { button: 'right' })
  await window.waitForSelector('[role="menu"].fb-context-menu', { timeout: 4_000 })

  const before = await readPan(window)
  // Move toward the bottom edge — far from the menu itself (opened near
  // center) so the move doesn't accidentally dismiss/interact with it.
  await window.mouse.move(rect.left + rect.width / 2, rect.bottom - 5, { steps: 4 })
  const movedWhileOpen = await panMovedOverWindow(window, before, 300, 40)
  const duringMenu = await readPan(window)
  console.log('[EDGE-PAN-3] before', before, 'duringMenu(edge zone)', duringMenu, 'moved', movedWhileOpen)
  expect(movedWhileOpen, 'edge-pan must NOT engage while the context menu is open').toBe(false)

  // Close the menu (Escape) and confirm pan resumes from the same cached
  // cursor position.
  await window.keyboard.press('Escape')
  await window.waitForSelector('[role="menu"].fb-context-menu', { state: 'detached', timeout: 4_000 })
  const resumed = await panMovedOverWindow(window, duringMenu, 500, 40)
  const after = await readPan(window)
  console.log('[EDGE-PAN-3] after close', after, 'resumed', resumed)
  expect(resumed, 'edge-pan must resume once the context menu closes').toBe(true)

  expect(pageErrors, 'no uncaught console exceptions').toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Check 4 — pill stays fully on screen after a drag past the viewport edge,
// and after hover-expansion.
// ---------------------------------------------------------------------------


// EDGE-PAN-4 (the pill clamps back into view after being dragged past a corner)
// and EDGE-PAN-5 (the context menu placing itself away from the hovered pill)
// are gone. Both drove a FloatingPill that floated over the canvas and could be
// dragged; the desk action bar is docked in the header now, so there is nothing
// to drag off-screen and nothing on the canvas for a menu to dodge. The
// stand-down behaviour they shared with EDGE-PAN-2 is covered above against the
// minimap FAB, and the menu's own placement is covered by
// contextMenuRegression.spec.ts and ctxMenuDismiss.spec.ts.
