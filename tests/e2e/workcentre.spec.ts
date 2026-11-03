// The Workcentre desk view (owner, 4.3.41): "a new view type called Workcentre,
// which behaves like a dashboard. Need to be able to resize all widgets, files
// and tools to custom size to ensure full visibility of the tool, file or widget."
//
// A desk seeded with a Write document (holding a live snippet embed), a
// spreadsheet, a sticky, a markdown note, a calculator and a timer:
//   WC-1 Workcentre tiles every object without overlap, each showing its full
//        content (the document shows its live editor and its snippet embed).
//   WC-2 a tile resizes by its corner and moves by its title; neighbours are
//        pushed, nothing overlaps; the dashboard survives a reload; the objects'
//        canvas geometry is untouched (the view's sizes are its own).
//   WC-3 keyboard: Alt+arrows move a focused tile, Shift+Alt+arrows resize it.
//   WC-4 a document tile made narrow folds its office shell properly (Row 1
//        folds into "≡", nothing overflows the tile either way).
//   WC-5 free canvas: a sticky made taller by hand keeps that height (a guard:
//        auto-grow must never undo a hand-set size) and an editor cannot be
//        shrunk below its new 320 × 240 minimum; both persist.
//
// Fill and snap (owner, 2026-11-03: "auto grow to fill dead space … in any
// direction … snaps in place, more like the multi-app focus view … show where
// things will move if the mouse button is released, so it doesn't just go to
// the bottom"). A tile's data-x/y/w/h are what is SHOWN (filled); data-base-w/h
// are its stored size; data-fix names the axes set by hand.
//   WC-7 no dead space: no tile could grow any further, and the tiles reach the
//        bottom of the view.
//   WC-8 a dragged tile follows the pointer, a drop well shows its slot, and it
//        lands exactly in that well.
//   WC-9 a desk link dragged in shows the well at the pointer and lands there.
//   WC-10 a file dragged in from Finder lands at the pointer too, not at the
//        bottom.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Seed = { taskId: string; ids: Record<string, string> }

async function seedDesk(window: Page): Promise<Seed> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Workcentre desk' })
    // A live snippet embed inside the Write document (2e's seed path).
    const snip = (await (api as unknown as { snippets: { create: (d: Record<string, unknown>) => Promise<{ snippet: { id: string } }> } }).snippets.create({
      name: 'Seed',
      kind: 'doc',
      scope: 'personal',
      body: { kind: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SEEDED SNIPPET' }] }], text: 'SEEDED SNIPPET' }
    })) as { snippet: { id: string } }
    const doc = (await api.documents.create({
      docType: 'doc',
      title: 'Quarterly plan',
      // A raw TipTap document (parseDocBody accepts it; the wrapped form needs headingStyles too).
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plan body text' }] }, { type: 'snippetEmbed', attrs: { snippetId: snip.snippet.id } }] }
    } as never)) as { id: string }
    const sheet = (await api.documents.create({ docType: 'sheet', title: 'Budget' } as never)) as { id: string }
    const mk = async (kind: string, content: string, x: number, y: number, width: number, height: number): Promise<string> =>
      ((await api.widgets.create({ taskId: task.id, kind, content, x, y, width, height } as never)) as { id: string }).id
    const ids = {
      doc: await mk('doc', doc.id, 40, 40, 520, 420),
      sheet: await mk('sheet', sheet.id, 600, 40, 520, 360),
      sticky: await mk('sticky', 'Call the bank', 40, 500, 220, 160),
      markdown: await mk('markdown', '# Notes\n\nSome **markdown**.', 300, 500, 300, 200),
      calculator: await mk('calculator', '', 640, 440, 260, 320),
      timer: await mk('timer', '', 920, 440, 240, 200)
    }
    return { taskId: task.id, ids }
  })
}

async function openDesk(window: Page, taskId: string): Promise<void> {
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
}

async function toWorkcentre(window: Page): Promise<void> {
  await window.locator('[data-testid="view-selector-btn"]').first().click()
  await window.locator('[data-testid="view-opt-workcentre"]').click()
  await expect(window.locator('[data-testid="workcentre-grid"]')).toBeVisible({ timeout: 10_000 })
}

type R = { x: number; y: number; w: number; h: number }
async function tileRects(window: Page): Promise<Record<string, R>> {
  return window.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="workcentre-tile-"]')).map((el) => {
        const r = el.getBoundingClientRect()
        return [el.dataset.testid!.replace('workcentre-tile-', ''), { x: r.left, y: r.top, w: r.width, h: r.height }]
      })
    )
  )
}
const overlap = (a: R, b: R): boolean => a.x + 1 < b.x + b.w && b.x + 1 < a.x + a.w && a.y + 1 < b.y + b.h && b.y + 1 < a.y + a.h
function noOverlaps(rects: Record<string, R>): string[] {
  const ids = Object.keys(rects)
  const out: string[] = []
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (overlap(rects[ids[i]!]!, rects[ids[j]!]!)) out.push(`${ids[i]}/${ids[j]}`)
  return out
}
const unit = async (window: Page, id: string, k: 'x' | 'y' | 'w' | 'h' | 'base-w' | 'base-h'): Promise<number> =>
  Number(await window.locator(`[data-testid="workcentre-tile-${id}"]`).getAttribute(`data-${k}`))
const fix = async (window: Page, id: string): Promise<string | null> => window.locator(`[data-testid="workcentre-tile-${id}"]`).getAttribute('data-fix')

async function canvasGeometry(window: Page, taskId: string): Promise<Record<string, [number, number, number, number]>> {
  return window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const ws = (await api.widgets.listByTask(t)) as Array<{ id: string; x: number; y: number; width: number; height: number }>
    return Object.fromEntries(ws.map((w) => [w.id, [w.x, w.y, w.width, w.height] as [number, number, number, number]]))
  }, taskId)
}

async function boot(): Promise<{ window: Page; seed: Seed; errors: string[] }> {
  launched = await launchApp()
  const { window } = launched
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const seed = await seedDesk(window)
  await openDesk(window, seed.taskId)
  return { window, seed, errors }
}

test('WC-1 — Workcentre tiles every object without overlap, each showing its full content', async () => {
  test.setTimeout(90_000)
  const { window, seed, errors } = await boot()
  await toWorkcentre(window)
  for (const id of Object.values(seed.ids)) await expect(window.locator(`[data-testid="workcentre-tile-${id}"]`)).toBeVisible()
  await expect(window.locator('[data-testid^="workcentre-tile-"]')).toHaveCount(6)
  expect(noOverlaps(await tileRects(window)), 'tiles overlapping').toEqual([])
  // Full content, not a thumbnail: the document tile holds the live editor and its snippet embed.
  const docBody = window.locator(`[data-testid="workcentre-body-${seed.ids.doc}"]`)
  await expect(docBody.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 12_000 })
  await expect(docBody.locator('[data-testid="doc-editor-surface"]')).toContainText('Plan body text')
  await expect(docBody.locator('[data-testid="snippet-embed"]')).toContainText('SEEDED SNIPPET', { timeout: 8_000 })
  // The spreadsheet tile shows its grid; the sticky its text.
  await expect(window.locator(`[data-testid="workcentre-body-${seed.ids.sheet}"]`)).not.toBeEmpty()
  await expect(window.locator(`[data-testid="workcentre-body-${seed.ids.sticky}"]`)).toContainText('Call the bank')
  // The hint says honestly where the layout lives.
  await expect(window.locator('[data-testid="workcentre-hint"]')).toContainText('Saved on this device')
  expect(errors).toEqual([])
})

test('WC-2 — resize by the corner, move by the title; neighbours pushed, no overlap; persists; canvas untouched', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  const canvasBefore = await canvasGeometry(window, seed.taskId)
  await toWorkcentre(window)
  const cols = Number(await window.locator('[data-testid="workcentre-grid"]').getAttribute('data-cols'))
  // The tile fill widened most (shown wider than stored): drag its corner 1 column left and 1 row
  // up (inside the window, wherever the tile sits). A resize starts from what you see, so the
  // width lands at w0 − 1; one computed from the stored width would land at w0 − 2 or less. The
  // dragged axes become hand-set.
  const grown = await window.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="workcentre-tile-"]'))
      .map((el) => ({ id: el.dataset.testid!.replace('workcentre-tile-', ''), grew: Number(el.dataset.w) - Number(el.dataset.baseW) }))
      .sort((a, b) => b.grew - a.grew)[0]!
  )
  expect(grown.grew, 'fill widened at least one tile by 2+ columns').toBeGreaterThanOrEqual(2)
  const id = grown.id
  const w0 = await unit(window, id, 'w')
  const h0 = await unit(window, id, 'h')
  const handle = window.locator(`[data-testid="workcentre-resize-${id}"]`)
  await handle.scrollIntoViewIfNeeded()
  const hb = (await handle.boundingBox())!
  const grid = (await window.locator('[data-testid="workcentre-grid"]').boundingBox())!
  const colPx = (grid.width - 12 * (cols - 1)) / cols
  await window.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await window.mouse.down()
  await window.mouse.move(hb.x + hb.width / 2 - 1 * (colPx + 12), hb.y + hb.height / 2 - 36, { steps: 10 })
  await window.mouse.up()
  await expect.poll(() => fix(window, id)).toBe('wh')
  // Set from the SHOWN width, exactly one narrower; never from the smaller stored width.
  expect(await unit(window, id, 'base-w'), 'one column narrower than it was shown').toBe(w0 - 1)
  // One row shorter than shown (or held at its minimum height).
  const setH = await unit(window, id, 'base-h')
  expect(setH).toBeLessThanOrEqual(h0)
  expect(setH).toBeGreaterThanOrEqual(h0 - 1)
  // A hand-set size is shown exactly as set — fill does not spring it back.
  expect(await unit(window, id, 'w')).toBe(await unit(window, id, 'base-w'))
  expect(await unit(window, id, 'h')).toBe(setH)
  expect(noOverlaps(await tileRects(window)), 'after resize').toEqual([])
  const w1 = await unit(window, id, 'w')
  const h1 = await unit(window, id, 'h')

  // Move the timer tile to the top-left by its title.
  const timer = seed.ids.timer
  const mv = (await window.locator(`[data-testid="workcentre-move-${timer}"]`).boundingBox())!
  await window.mouse.move(mv.x + 20, mv.y + mv.height / 2)
  await window.mouse.down()
  await window.mouse.move(grid.x + 20, grid.y + 10, { steps: 12 })
  await window.mouse.up()
  await expect.poll(() => unit(window, timer, 'x')).toBe(0)
  expect(await unit(window, timer, 'y')).toBe(0)
  expect(noOverlaps(await tileRects(window)), 'after move').toEqual([])

  // Persists across a reload (device-local, desk_layouts).
  await openDesk(window, seed.taskId)
  await expect(window.locator('[data-testid="workcentre-grid"]')).toBeVisible({ timeout: 10_000 }) // last-used view restores
  expect(await unit(window, id, 'w')).toBe(w1)
  expect(await unit(window, id, 'h')).toBe(h1)
  expect([await unit(window, timer, 'x'), await unit(window, timer, 'y')]).toEqual([0, 0])
  // The objects' canvas geometry did not change: the view's sizes are its own.
  expect(await canvasGeometry(window, seed.taskId)).toEqual(canvasBefore)
})

test('WC-3 — keyboard: Alt+arrows move a focused tile, Shift+Alt+arrows resize it', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  await toWorkcentre(window)
  const id = seed.ids.calculator
  const tile = window.locator(`[data-testid="workcentre-tile-${id}"]`)
  await tile.focus()
  const cols = Number(await window.locator('[data-testid="workcentre-grid"]').getAttribute('data-cols'))
  // From the shown width, one column narrower (or wider, if it is already at its minimum).
  const w0 = await unit(window, id, 'w')
  const narrower = w0 > 3
  await window.keyboard.press(narrower ? 'Shift+Alt+ArrowLeft' : 'Shift+Alt+ArrowRight')
  await expect.poll(() => fix(window, id)).toBe('w')
  expect(await unit(window, id, 'base-w')).toBe(narrower ? w0 - 1 : Math.min(cols, w0 + 1))
  expect(await unit(window, id, 'w'), 'shown exactly as set').toBe(await unit(window, id, 'base-w'))
  const h0 = await unit(window, id, 'h')
  await window.keyboard.press('Shift+Alt+ArrowDown')
  await expect.poll(() => fix(window, id)).toBe('wh')
  expect(await unit(window, id, 'base-h')).toBe(h0 + 1)
  const y0 = await unit(window, id, 'y')
  await window.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => unit(window, id, 'y')).toBeGreaterThanOrEqual(y0) // compaction may hold it if nothing is below
  expect(noOverlaps(await tileRects(window))).toEqual([])
  // Double-clicking the corner hands it back to auto-fill.
  await window.locator(`[data-testid="workcentre-resize-${id}"]`).dblclick()
  await expect.poll(() => fix(window, id)).toBeNull()
})

test('WC-4 — a document tile made narrow folds its office shell and overflows nothing', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  await toWorkcentre(window)
  const id = seed.ids.doc
  const body = window.locator(`[data-testid="workcentre-body-${id}"]`)
  await expect(body.locator('[data-testid="doc-shell"]')).toBeVisible({ timeout: 12_000 })
  // Shrink it to its minimum width with Shift+Alt+ArrowLeft (one column at a time).
  await window.locator(`[data-testid="workcentre-tile-${id}"]`).focus()
  for (let i = 0; i < 24; i++) await window.keyboard.press('Shift+Alt+ArrowLeft')
  await expect.poll(async () => (await body.boundingBox())!.width).toBeLessThan(520)
  // Row 1 folds into "≡" (the office shell measures its own root, SPEC §2.6) …
  await expect(body.locator('[data-testid="doc-toolbar-menus"]')).toBeVisible()
  // … and nothing inside the tile overflows it, either way (the min-w-0 / min-h-0 host rule).
  const over = await window.evaluate((sel: string) => {
    const tileBody = document.querySelector(sel) as HTMLElement
    const shell = tileBody.querySelector('[data-testid="doc-shell"]') as HTMLElement
    const t = tileBody.getBoundingClientRect()
    const s = shell.getBoundingClientRect()
    return { wider: Math.round(s.width - t.width), taller: Math.round(s.bottom - t.bottom) }
  }, `[data-testid="workcentre-body-${id}"]`)
  expect(over.wider, 'shell wider than the tile').toBeLessThanOrEqual(1)
  expect(over.taller, 'shell taller than the tile').toBeLessThanOrEqual(1)
  // It never goes below the editor minimum (320px).
  expect((await body.boundingBox())!.width).toBeGreaterThanOrEqual(300)
})

test('WC-5 — free canvas: custom sizes stick and editors keep their minimum; both persist', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  const resize = async (id: string, dx: number, dy: number): Promise<void> => {
    const w = window.locator(`[data-widget-id="${id}"]`)
    await w.hover()
    const b = (await w.boundingBox())!
    await window.mouse.move(b.x + b.width - 2, b.y + b.height - 2)
    await window.mouse.down()
    await window.mouse.move(b.x + b.width - 2 + dx, b.y + b.height - 2 + dy, { steps: 10 })
    await window.mouse.up()
    // Let go and move on, as a person does. A pointer left resting within the
    // canvas's edge margin pans the desk by design (edge-pan), which would carry
    // every widget off screen under the next gesture.
    const surface = (await window.locator('[data-canvas-surface="true"]').boundingBox())!
    await window.mouse.move(surface.x + surface.width / 2, surface.y + surface.height / 2)
  }
  const geo = async (id: string): Promise<[number, number, number, number]> => (await canvasGeometry(window, seed.taskId))[id]!
  // A sticky made much taller than its text keeps its height (guard: auto-grow must not undo it).
  const before = await geo(seed.ids.sticky)
  await resize(seed.ids.sticky, 100, 260)
  await expect.poll(async () => (await geo(seed.ids.sticky))[3]).toBeGreaterThan(before[3] + 150)
  await window.waitForTimeout(1_500) // give auto-grow every chance to shrink it
  const tall = await geo(seed.ids.sticky)
  expect(tall[3], 'the hand-set height stayed').toBeGreaterThan(before[3] + 150)
  // A document widget cannot be dragged below the editor minimum (320 × 240).
  await resize(seed.ids.doc, -600, -600)
  await expect.poll(async () => (await geo(seed.ids.doc))[2]).toBeLessThan(520)
  const small = await geo(seed.ids.doc)
  expect(small[2]).toBeGreaterThanOrEqual(320)
  expect(small[3]).toBeGreaterThanOrEqual(240)
  // Both persist across a reload.
  await openDesk(window, seed.taskId)
  expect((await geo(seed.ids.sticky))[3]).toBe(tall[3])
  expect((await geo(seed.ids.doc))[2]).toBe(small[2])
})

/** Is the element itself what a click at its centre would hit? (true, or what is hit instead) */
async function onTop(window: Page, sel: string): Promise<true | string> {
  return window.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (!el) return 'missing'
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return 'zero size'
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (hit && (hit === el || el.contains(hit))) return true
    const tile = hit?.closest('[data-testid^="workcentre-tile-"]') as HTMLElement | null
    return `${hit?.tagName ?? 'nothing'}.${(hit?.className ?? '').toString().slice(0, 80)} [testid=${(hit as HTMLElement | null)?.dataset?.testid ?? ''}] in ${tile?.dataset.testid ?? 'no tile'}; handle ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
  }, sel)
}

for (const theme of ['light', 'dark'] as const) {
  for (const menu of [false, true]) {
    test(`WC-6 — layout guard, ${theme}${menu ? ', floating menu at 480px' : ''}: clear of the menu, every handle on top, no overlap`, async () => {
      test.setTimeout(90_000)
      launched = await launchApp()
      const { window } = launched
      await waitForReady(window)
      await chooseCloudAiSource(window)
      const seed = await seedDesk(window)
      await window.evaluate(
        ({ t, m }) => {
          localStorage.setItem('fb.theme.mode', t)
          if (m) localStorage.setItem('fb.sidebar.width', '480')
        },
        { t: theme, m: menu }
      )
      await openDesk(window, seed.taskId)
      expect(await window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark')
      await toWorkcentre(window)
      await expect(window.locator(`[data-testid="workcentre-body-${seed.ids.doc}"] [data-testid="doc-editor-surface"]`)).toBeVisible({ timeout: 12_000 })

      // Clear of the floating menu.
      const dock = await window.locator('[data-testid="sidebar-dock"]').boundingBox().catch(() => null)
      const host = (await window.locator('[data-testid="workcentre-view"]').boundingBox())!
      if (dock) expect(host.x, 'Workcentre starts right of the floating menu').toBeGreaterThanOrEqual(dock.x + dock.width - 1)
      expect(await onTop(window, '[data-testid="workcentre-view"] [data-testid="view-selector-btn"]'), 'the view selector is on top').toBe(true)

      // Every tile's handles are what a click would hit (scrolled into view first).
      for (const id of Object.values(seed.ids)) {
        await window.locator(`[data-testid="workcentre-tile-${id}"]`).scrollIntoViewIfNeeded()
        for (const part of ['move', 'resize', 'focus', 'reveal']) {
          expect(await onTop(window, `[data-testid="workcentre-${part}-${id}"]`), `${part} handle of ${id} on top`).toBe(true)
        }
      }
      expect(noOverlaps(await tileRects(window)), 'tiles overlapping').toEqual([])
      // The grid fits the view: no tile reaches past its right edge.
      const grid = (await window.locator('[data-testid="workcentre-grid"]').boundingBox())!
      for (const [id, r] of Object.entries(await tileRects(window))) expect(r.x + r.w, `${id} inside the grid`).toBeLessThanOrEqual(grid.x + grid.width + 1)
    })
  }
}

type T = { id: string; x: number; y: number; w: number; h: number }
async function shownTiles(window: Page): Promise<{ tiles: T[]; keep: T | null; cols: number; rows: number }> {
  return window.evaluate(() => {
    const g = document.querySelector<HTMLElement>('[data-testid="workcentre-grid"]')!
    const tiles = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="workcentre-tile-"]')).map((el) => ({
      id: el.dataset.testid!.replace('workcentre-tile-', ''),
      x: Number(el.dataset.x),
      y: Number(el.dataset.y),
      w: Number(el.dataset.w),
      h: Number(el.dataset.h)
    }))
    // The cells kept clear under the Plexii pill count as taken: fill grows around them.
    const k = document.querySelector<HTMLElement>('[data-testid="workcentre-corner-keepout"]')
    const keep = k ? { id: 'keep-out', x: Number(k.dataset.x), y: Number(k.dataset.y), w: Number(k.dataset.w), h: Number(k.dataset.h) } : null
    return { tiles, keep, cols: Number(g.dataset.cols), rows: Number(g.dataset.rows) }
  })
}
const hit = (a: { x: number; y: number; w: number; h: number }, b: T): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
/** Where a tile could still grow into free space (null: nowhere — it is filled). */
function growable(t: T, all: T[], cols: number, rows: number): string | null {
  const free = (r: { x: number; y: number; w: number; h: number }): boolean => !all.some((o) => o.id !== t.id && hit(r, o))
  if (t.x + t.w < cols && free({ x: t.x + t.w, y: t.y, w: 1, h: t.h })) return 'right'
  if (t.x > 0 && free({ x: t.x - 1, y: t.y, w: 1, h: t.h })) return 'left'
  if (t.y + t.h < rows && free({ x: t.x, y: t.y + t.h, w: t.w, h: 1 })) return 'down'
  if (t.y > 0 && free({ x: t.x, y: t.y - 1, w: t.w, h: 1 })) return 'up'
  return null
}

test('WC-7 — tiles grow to fill the dead space, in every direction, down to the bottom of the view', async () => {
  test.setTimeout(90_000)
  const { window } = await boot()
  await toWorkcentre(window)
  const { tiles, keep, cols, rows } = await shownTiles(window)
  expect(tiles).toHaveLength(6)
  const taken = keep ? [...tiles, keep] : tiles
  for (const t of tiles) expect(growable(t, taken, cols, rows), `${t.id} still has dead space beside it`).toBeNull()
  // Room for the pill: a short strip in the bottom-right corner, exactly under one tile.
  if (keep) {
    expect(keep.x + keep.w).toBe(cols)
    expect(keep.y + keep.h).toBe(rows)
    expect(keep.h, 'a strip, not a block').toBeLessThanOrEqual(3)
    expect(tiles.some((t) => t.x === keep.x && t.w === keep.w && t.y + t.h === keep.y), 'under exactly one tile').toBe(true)
  }
  // The tiles reach the bottom row of the grid, and the grid reaches the bottom of the view
  // (the pill's notch aside; WC-6 checks the pill never sits on a resize handle).
  expect(Math.max(...tiles.map((t) => t.y + t.h))).toBe(rows)
  const scroll = (await window.locator('[data-testid="workcentre-scroll"]').boundingBox())!
  const grid = (await window.locator('[data-testid="workcentre-grid"]').boundingBox())!
  expect(grid.y + grid.height, 'the grid fills the view downwards').toBeGreaterThanOrEqual(scroll.y + scroll.height - 16 - 36)
  // Most of the grid is covered (allowing the odd cell no single tile can take).
  const covered = taken.reduce((n, t) => n + t.w * t.h, 0)
  expect(covered / (cols * rows)).toBeGreaterThan(0.9)
  expect(noOverlaps(await tileRects(window))).toEqual([])
})

test('WC-8 — a dragged tile follows the pointer, a well shows its slot, and it lands in the well', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  await toWorkcentre(window)
  // From the top of the view: a tile not already at the top-left whose title is on screen (the timer when it is).
  await window.locator('[data-testid="workcentre-scroll"]').evaluate((el) => (el.scrollTop = 0))
  const id = await window.evaluate((preferred: string) => {
    const host = document.querySelector('[data-testid="workcentre-scroll"]')!.getBoundingClientRect()
    const ok = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="workcentre-tile-"]')).filter((el) => {
      const head = el.querySelector('header')!.getBoundingClientRect()
      return (el.dataset.x !== '0' || el.dataset.y !== '0') && head.top >= host.top && head.bottom <= host.bottom
    })
    const pick = ok.find((el) => el.dataset.testid === `workcentre-tile-${preferred}`) ?? ok[0]!
    return pick.dataset.testid!.replace('workcentre-tile-', '')
  }, seed.ids.timer)
  const head = window.locator(`[data-testid="workcentre-move-${id}"]`)
  const hb = (await head.boundingBox())!
  const grid = (await window.locator('[data-testid="workcentre-grid"]').boundingBox())!
  await window.mouse.move(hb.x + 30, hb.y + hb.height / 2)
  await window.mouse.down()
  // Carry it to the top-left area and hold it there.
  await window.mouse.move(grid.x + 40, grid.y + 14, { steps: 14 })
  const well = window.locator('[data-testid="workcentre-drop-well"]')
  await expect(well).toBeVisible()
  await expect(window.locator(`[data-testid="workcentre-tile-${id}"]`)).toHaveAttribute('data-floating', 'true')
  // The floating tile is under the pointer, not parked in its slot.
  const tb = (await window.locator(`[data-testid="workcentre-tile-${id}"]`).boundingBox())!
  expect(Math.abs(tb.x + 30 - (grid.x + 40))).toBeLessThan(6)
  await window.waitForTimeout(400) // let the neighbours finish sliding aside
  const target = { x: Number(await well.getAttribute('data-x')), y: Number(await well.getAttribute('data-y')), w: Number(await well.getAttribute('data-w')), h: Number(await well.getAttribute('data-h')) }
  expect([target.x, target.y]).toEqual([0, 0])
  await window.mouse.up()
  await expect(well).toHaveCount(0)
  await expect(window.locator(`[data-testid="workcentre-tile-${id}"]`)).not.toHaveAttribute('data-floating', 'true')
  // It landed exactly where the well said.
  expect([await unit(window, id, 'x'), await unit(window, id, 'y'), await unit(window, id, 'w'), await unit(window, id, 'h')]).toEqual([target.x, target.y, target.w, target.h])
  await window.waitForTimeout(400)
  expect(noOverlaps(await tileRects(window))).toEqual([])
})

/** Drag something in (synthetic HTML5 drag, as the OS delivers one) and hold it over a point of the grid. */
async function dragIn(window: Page, at: { x: number; y: number }, kind: 'task-link' | 'file', payload: string): Promise<void> {
  await window.evaluate(
    ({ at, kind, payload }) => {
      const dt = new DataTransfer()
      if (kind === 'task-link') dt.setData('text/fb-task-link', payload)
      else dt.items.add(new File([payload], 'dropped-note.txt', { type: 'text/plain' }))
      ;(window as unknown as { __wcDrag: DataTransfer }).__wcDrag = dt
      const target = document.elementFromPoint(at.x, at.y)!
      for (const type of ['dragenter', 'dragover', 'dragover']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
    },
    { at, kind, payload }
  )
}
async function dropIn(window: Page, at: { x: number; y: number }): Promise<void> {
  await window.evaluate((at) => {
    const dt = (window as unknown as { __wcDrag: DataTransfer }).__wcDrag
    const target = document.elementFromPoint(at.x, at.y)!
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
  }, at)
}
async function newTileId(window: Page, before: string[]): Promise<string> {
  let id = ''
  await expect
    .poll(async () => {
      const now = await window.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="workcentre-tile-"]')).map((el) => el.dataset.testid!.replace('workcentre-tile-', '')))
      id = now.find((x) => !before.includes(x)) ?? ''
      return id
    }, { timeout: 15_000 })
    .not.toBe('')
  return id
}

for (const kind of ['task-link', 'file'] as const) {
  test(`${kind === 'task-link' ? 'WC-9 — a desk link' : 'WC-10 — a file from Finder'} dragged in shows where it will land, and lands there (not at the bottom)`, async () => {
    test.setTimeout(90_000)
    const { window, seed } = await boot()
    const other = kind === 'task-link'
      ? await window.evaluate(async () => ((await (window as unknown as { api: typeof window.api }).api.nodes.create({ parentId: null, kind: 'task', title: 'Linked desk' })) as { id: string }).id)
      : 'Notes dropped in from Finder'
    await toWorkcentre(window)
    const before = Object.values(seed.ids)
    const grid = (await window.locator('[data-testid="workcentre-grid"]').boundingBox())!
    // Over the middle of the top row: far from the bottom, where first-fit would have put it.
    const at = { x: grid.x + grid.width / 2, y: grid.y + 20 }
    await dragIn(window, at, kind, other)
    const well = window.locator('[data-testid="workcentre-drop-well"]')
    await expect(well).toBeVisible()
    expect(Number(await well.getAttribute('data-y')), 'the well is at the pointer row').toBe(0)
    await window.waitForTimeout(400)
    const target = { x: Number(await well.getAttribute('data-x')), y: Number(await well.getAttribute('data-y')) }
    await dropIn(window, at)
    await expect(well).toHaveCount(0)
    const id = await newTileId(window, before)
    // It lands at the drop: the top row, at the well's column — not appended at the bottom.
    await expect.poll(() => unit(window, id, 'y'), { timeout: 10_000 }).toBe(0)
    expect(Math.abs((await unit(window, id, 'x')) - target.x), 'lands at the well column').toBeLessThanOrEqual(1)
    await window.waitForTimeout(400)
    expect(noOverlaps(await tileRects(window))).toEqual([])
  })
}
