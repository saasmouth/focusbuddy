// The multi-app focus view's make-room slide (owner, 2026-11-03: "fix" — the
// slide never ran). SplitGrid's comments promised a CSS transition on
// .fb-split-cluster that springs the grid tracks between layouts, but the class
// was defined nowhere, and the grid jumped straight to the next shape (one
// column → two cannot interpolate anyway). Now: the next shape is rendered first
// with the incoming cell collapsed to a seam (makeRoomFrom), then sprung to its
// real tracks, so the pane already there shrinks into its cell while the drop
// well grows out of the seam.
//
// Proven on the real grid: its computed grid-template-columns, sampled every
// frame while a dock tile is held over the body, must pass through in-between
// widths — not just a start and an end. Dragging left opens the well on the
// left; under reduced motion the change is instant.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, clickWidgetTool, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function boot(): Promise<{ window: Page; a: string; b: string }> {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Split slide desk' })
    const mk = async (title: string, x: number): Promise<string> =>
      ((await api.widgets.create({ taskId: task.id, kind: 'sticky', title, content: title, x, y: 160, width: 220, height: 180 } as never)) as { id: string }).id
    return { a: await mk('Pane A', 160), b: await mk('Pane B', 460) }
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Split slide desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  const el = window.locator(`[data-widget-id="${ids.a}"]`).first()
  await expect(el).toBeVisible({ timeout: 5_000 })
  await el.hover()
  await clickWidgetTool(window, ids.a, 'Full view')
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toBeVisible({ timeout: 5_000 })
  await window.waitForTimeout(600)
  return { window, ...ids }
}

/** Hold dock tile `id` over the body at x fraction `fx`; return the grid's first column width (px) every frame meanwhile. */
async function holdAndSample(window: Page, id: string, fx: number): Promise<{ first: number[]; total: number }> {
  await window.evaluate(() => {
    const w = window as unknown as { __cols: string[]; __stop: boolean }
    w.__cols = []
    w.__stop = false
    const tick = (): void => {
      const g = document.querySelector<HTMLElement>('[data-testid="focus-split-grid"][data-previewing="true"]')
      if (g) w.__cols.push(getComputedStyle(g).gridTemplateColumns)
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const tile = (await window.locator(`[data-testid="focus-dock-tile-${id}"]`).boundingBox())!
  const vp = window.viewportSize() ?? { width: 1440, height: 900 }
  const start = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 }
  const end = { x: vp.width * fx, y: vp.height * 0.5 }
  await window.mouse.move(start.x, start.y)
  await window.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await window.mouse.move(start.x + (end.x - start.x) * (i / 12), start.y + (end.y - start.y) * (i / 12))
    await window.waitForTimeout(30)
  }
  await window.waitForTimeout(700) // hold: the slide runs and settles
  const cols = await window.evaluate(() => {
    const w = window as unknown as { __cols: string[]; __stop: boolean }
    w.__stop = true
    return w.__cols
  })
  await window.mouse.up()
  const parsed = cols.filter((c) => c.split(' ').length === 2).map((c) => c.split(' ').map((v) => parseFloat(v)))
  expect(parsed.length, `two-column samples (got ${JSON.stringify(cols.slice(0, 4))})`).toBeGreaterThan(3)
  return { first: parsed.map((p) => p[0]!), total: parsed[parsed.length - 1]![0]! + parsed[parsed.length - 1]![1]! }
}

const between = (v: number, a: number, b: number): boolean => v > Math.min(a, b) + 2 && v < Math.max(a, b) - 2
/**
 * The last slide in the samples: the last frame the first column sat at an
 * extreme (`atStart`: pane full width, or the well a seam), then the frames
 * after it. The well follows the pointer's side, and a drag from the dock can
 * cross the middle on its way, re-opening the split on the other side.
 */
function lastSlide(first: number[], atStart: (v: number) => boolean): { from: number; frames: number[] } {
  let i = -1
  for (let k = 0; k < first.length; k++) if (atStart(first[k]!)) i = k
  return { from: i >= 0 ? first[i]! : NaN, frames: i >= 0 ? first.slice(i + 1) : [] }
}

test('FS-1 — dragged in on the right: the pane slides left and the well grows out of a seam on the right', async () => {
  test.setTimeout(90_000)
  const { window, b } = await boot()
  const { first, total } = await holdAndSample(window, b, 0.72)
  const settled = first[first.length - 1]!
  const slide = lastSlide(first, (v) => v > total * 0.95)
  const seen = first.map(Math.round).join(',')
  expect(slide.from, `the pane starts at full width: ${seen}`).toBeGreaterThan(total * 0.95)
  expect(settled, 'settles at the split').toBeLessThan(total * 0.7)
  expect(slide.frames.filter((v) => between(v, slide.from, settled)).length, `in-between widths after it: ${seen}`).toBeGreaterThanOrEqual(3)
})

test('FS-2 — dragged in on the left: the well opens on the left, growing from a seam', async () => {
  test.setTimeout(90_000)
  const { window, b } = await boot()
  const { first, total } = await holdAndSample(window, b, 0.22)
  const settled = first[first.length - 1]!
  const slide = lastSlide(first, (v) => v < total * 0.05)
  const seen = first.map(Math.round).join(',')
  expect(slide.from, `the left (well) column starts as a seam: ${seen}`).toBeLessThan(total * 0.05)
  expect(settled, 'settles at the split').toBeGreaterThan(total * 0.3)
  expect(slide.frames.filter((v) => between(v, slide.from, settled)).length, `in-between widths after it: ${seen}`).toBeGreaterThanOrEqual(3)
})

test('FS-3 — under reduced motion the split appears at once, without the slide', async () => {
  test.setTimeout(90_000)
  const { window, b } = await boot()
  await window.emulateMedia({ reducedMotion: 'reduce' })
  const { first } = await holdAndSample(window, b, 0.72)
  const settled = first[first.length - 1]!
  expect(first.filter((v) => Math.abs(v - settled) > 2).length, `widths seen: ${first.map(Math.round).join(',')}`).toBe(0)
})
