/**
 * edgePanControls.spec.ts — a hand reaching for a control near the desk's edge
 * is not asking to pan (4.3.47).
 *
 * Edge-pan pans the desk while the pointer is inside an 80 px zone at the
 * visible edges. A widget near the edge has its buttons inside that zone, so
 * reaching for one armed the pan and the desk crept away under the hand at a
 * few px/s for as long as it rested there: the button slid off the pointer as
 * it was clicked. The 4.3.46 RC caught it three times as "element is not
 * stable" (customWidgetWizard 1 and 2, mailShowMore 4), and the owner saw it
 * as "the desk creeps when I click near its bottom edge".
 *
 * The rule now (lib/edgePanArming): a real move that ends on a control does not
 * arm, and a press stops a pan. Moving onto the bare desk in the zone still
 * pans: edge-pan is not switched off, it just stops mistaking a reach for a
 * request.
 *
 * Playwright's mouse (CDP input), in the background harness: no window is
 * shown, and the owner's real pointer is never touched.
 *
 * Signal for "did the camera pan": the [data-bare-canvas] transform layer's
 * translate(), which is what moves the desk on screen.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, chooseCloudAiSource, suppressFeatureSpotlights } from './_helpers'

let launched: LaunchedApp | null = null
let window: Page
let widgetId = ''

interface Pan { x: number; y: number }

async function readPan(): Promise<Pan> {
  return window.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-bare-canvas]')) as HTMLElement[]
    const el = els.find((e) => e.style.transform && e.style.transform.includes('translate'))
    const m = el?.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: NaN, y: NaN }
  })
}

async function canvasRect(): Promise<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> {
  return window.evaluate(() => {
    const r = document.querySelector('[data-canvas-surface="true"]')!.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  })
}

const dockInset = (): Promise<number> =>
  window.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-dock-inset')) || 0)

/** How far the desk travels over `ms` with the pointer left where it is. */
async function travelOver(ms: number): Promise<number> {
  const a = await readPan()
  await window.waitForTimeout(ms)
  const b = await readPan()
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Park the pointer mid-desk, clear of every zone, and let the camera settle. */
async function park(): Promise<void> {
  const r = await canvasRect()
  const inset = await dockInset()
  await window.mouse.move((r.left + inset + r.right) / 2, r.top + r.height / 2, { steps: 3 })
  await window.waitForTimeout(250)
}

/** Put the widget's header `fromBottom` px above the desk's bottom edge (inside the zone), by panning. */
async function headerToBottomZone(fromBottom: number): Promise<{ x: number; y: number }> {
  await park()
  const r = await canvasRect()
  const head = await window.evaluate((id) => {
    const t = document.querySelector(`[data-widget-id="${id}"] [data-header-title]`)!.getBoundingClientRect()
    return { x: t.left + t.width / 2, y: t.top + t.height / 2 }
  }, widgetId)
  const dy = r.bottom - fromBottom - head.y
  await window.evaluate((d) => {
    ;(window as unknown as { __fbWidgets: { getState: () => { panBy: (x: number, y: number) => void } } }).__fbWidgets.getState().panBy(0, d)
  }, dy)
  await window.waitForTimeout(300)
  return window.evaluate((id) => {
    const t = document.querySelector(`[data-widget-id="${id}"] [data-header-title]`)!.getBoundingClientRect()
    return { x: t.left + t.width / 2, y: t.top + t.height / 2 }
  }, widgetId)
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  window = launched.window
  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.nodes.create({ parentId: null, kind: 'task', title: 'Edge controls desk' })
    const w = await api.widgets.create({ taskId: d.id, kind: 'sticky', title: 'Near the edge', content: 'reach for my buttons', x: 420, y: 200, width: 320, height: 220 })
    return { deskId: d.id, widgetId: w.id }
  })
  widgetId = seeded.widgetId
  // The corner cards sit over the bottom edge, and edge-pan stands down over
  // floating chrome: clear them so the pointer measures the desk.
  await chooseCloudAiSource(window)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    ;(window as unknown as { __fbView: { getState: () => { goTask: (x: string) => void } } }).__fbView.getState().goTask(i)
  }, seeded.deskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8_000 })
  await window.waitForTimeout(800) // the desk's entrance animation
})

test.afterAll(async () => {
  await launched?.dispose()
})

test('EPC-1 resting on a widget\'s button inside the bottom zone: the desk stays put', async () => {
  const head = await headerToBottomZone(50)
  const r = await canvasRect()
  expect(r.bottom - head.y, 'the header is inside the 80 px zone').toBeLessThan(80)
  // Reach for the header, then for its AI button: the last move ends on the button.
  await window.mouse.move(head.x, head.y, { steps: 6 })
  const ai = window.locator(`[data-widget-id="${widgetId}"] [data-testid="widget-ai"]`)
  await expect(ai).toBeVisible()
  const b = (await ai.boundingBox())!
  expect(r.bottom - (b.y + b.height / 2), 'the button is inside the zone').toBeLessThan(80)
  await window.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 })
  await window.waitForTimeout(150)
  const moved = await travelOver(1500)
  expect(moved, 'the desk must not creep away from a hand resting on a button').toBeLessThan(0.5)
  // And the button is where the hand left it, so a click lands on it.
  const b2 = (await ai.boundingBox())!
  expect(Math.abs(b2.y - b.y)).toBeLessThan(0.5)
})

test('EPC-2 the same reach onto the bare desk still pans, and a click there stops it', async () => {
  await headerToBottomZone(50)
  const r = await canvasRect()
  const inset = await dockInset()
  // Bare desk, 30 px above the bottom edge, well clear of the widget.
  const x = r.left + inset + 120
  const y = r.bottom - 30
  const clear = await window.evaluate(([px, py]) => !document.elementFromPoint(px, py)?.closest('[data-widget-id], button, [data-floating-menu], .fb-floating-chrome'), [x, y])
  expect(clear, 'the probe point is bare desk').toBe(true)
  await window.mouse.move(x, y, { steps: 6 })
  expect(await travelOver(500), 'edge-pan still works for a hand that goes to the edge').toBeGreaterThan(2)
  await window.mouse.down()
  await window.mouse.up()
  await window.waitForTimeout(100)
  expect(await travelOver(1000), 'a click is acting on what is there, not panning').toBeLessThan(0.5)
  await park()
})
