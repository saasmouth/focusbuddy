import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// plexi-4.0 N5/N2/N3 wiring verification.
//
// N5: handleAutoArrange(opts) now takes a TidyOptions and delegates geometry
// to the pure tidyPositions() in lib/autoArrange.ts (already unit-tested,
// tests/unit/plxTidyModes.test.ts, 8/8 — this file does NOT re-derive that
// math). What's verified here is the wiring: the "Auto-arrange > Tidy" menu
// renders the new modes, clicking one actually drives a real widget through
// the real store/DB update path, and the resulting on-screen geometry matches
// the mode picked.
//
// N2: linked clustering (union-find over the link graph, pre-existing,
// unchanged by the refactor) is re-verified end-to-end so the refactor didn't
// regress it — linked widgets must still land adjacent after a tidy.
//
// N3: doc/sheet widgets spawned through the real "Add object" palette (right
// click > Add object > Files > Document/Spreadsheet > Create new) must open
// at the new bumped catalog defaults (860x760 / 880x580), as capped to the
// view since 364e801d (see the assertion for the rule).
//
// Driving method: hover the top pill's Tidy button and click a mode from its
// icon strip (DEC-038) — exactly the code path a user drives now that Tidy
// exists only there. Widget
// positions are read back through the exposed window.__fbWidgets store
// (same technique as wireTrustLayer.spec.ts / deskLayoutObjectOverlay.spec.ts)
// rather than DOM rects, since store x/y is what handleAutoArrange writes and
// is unaffected by camera pan/zoom.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface SeedWidget {
  title: string
  x: number
  y: number
  w?: number
  h?: number
}

// Seeds a fresh task with N sticky widgets at the given scattered positions.
// All widgets start at canvas x>=700 so a right-click at canvas (200,200) (or
// any point with x<700) always lands on bare canvas, never on a widget.
async function seedTask(
  window: Page,
  taskTitle: string,
  seeds: SeedWidget[]
): Promise<{ taskId: string; ids: string[] }> {
  return window.evaluate(
    async ({ taskTitle, seeds }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: taskTitle })
      const ids: string[] = []
      for (const s of seeds) {
        const w = await api.widgets.create({
          taskId: t.id,
          kind: 'sticky',
          title: s.title,
          content: s.title,
          x: s.x,
          y: s.y,
          width: s.w ?? 220,
          height: s.h ?? 180
        })
        ids.push(w.id)
        // Tiny stagger: z_index (assigned per-creation, monotonic) is what
        // actually orders listByTask, not created_at, so this isn't required
        // for correctness — kept only to make wall-clock inspection of the
        // seed easier if a run needs debugging.
        await new Promise((r) => setTimeout(r, 5))
      }
      return { taskId: t.id, ids }
    },
    { taskTitle, seeds }
  )
}

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(300)
}

// "Empty patch of canvas" is measured from the VISIBLE left edge: since the
// full-bleed desk (Edges + Glass Phase 1b) the canvas element starts beneath
// the dock column, so x is offset by --fb-dock-inset. Still needed by the
// "Add object" scenario, which drives the canvas menu (that menu keeps its
// other entries — only Tidy moved).
async function visibleOrigin(window: Page): Promise<number> {
  return window.evaluate(
    () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-dock-inset')) || 0
  )
}

// DEC-038: Tidy lives in ONE place now — the top pill. It used to also be a
// submenu on the desk right-click menu (Auto-arrange > Tidy > <mode>); that
// duplicate was removed, so this spec drives the pill instead. The modes are
// offered as ICONS, so they are addressed by test id / accessible name rather
// than by visible label text.
async function openTidyMenu(window: Page): Promise<void> {
  await window.locator('[data-testid="pill-tidy"]').hover()
  await expect(window.locator('[data-testid="tidy-menu"]')).toBeVisible()
}

/** Click one tidy mode from the pill's icon strip. */
async function pickTidy(window: Page, testId: string): Promise<void> {
  await openTidyMenu(window)
  await window.locator(`[data-testid="${testId}"]`).click()
  await window.waitForTimeout(500)
}

async function widgetPositions(
  window: Page,
  ids: string[]
): Promise<Record<string, { x: number; y: number }>> {
  return window.evaluate((ids: string[]) => {
    const w = window as unknown as {
      __fbWidgets?: { getState: () => { widgets: Array<{ id: string; x: number; y: number }> } }
    }
    const all = w.__fbWidgets?.getState().widgets ?? []
    const out: Record<string, { x: number; y: number }> = {}
    for (const id of ids) {
      const found = all.find((x) => x.id === id)
      if (found) out[id] = { x: found.x, y: found.y }
    }
    return out
  }, ids)
}

// ---------------------------------------------------------------------------
// (a) Tidy > Single column (vertical)
// ---------------------------------------------------------------------------
test('(a) Tidy > Single column (vertical) stacks 5 widgets in one column, y increasing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { ids } = await seedTask(window, 'Tidy vertical test', [
    { title: 'w0', x: 700, y: 500 },
    { title: 'w1', x: 1200, y: 100 },
    { title: 'w2', x: 900, y: 800 },
    { title: 'w3', x: 1500, y: 300 },
    { title: 'w4', x: 1000, y: 50 }
  ])
  await openTask(window, /Tidy vertical test/)
  await pickTidy(window, 'tidy-mode-vertical')

  const pos = await widgetPositions(window, ids)
  expect(Object.keys(pos)).toHaveLength(5)

  const xs = new Set(ids.map((id) => pos[id].x))
  expect(xs.size, 'one shared column').toBe(1)

  for (let i = 0; i < ids.length - 1; i++) {
    expect(pos[ids[i]].y, `w${i}.y < w${i + 1}.y`).toBeLessThan(pos[ids[i + 1]].y)
  }
})

// ---------------------------------------------------------------------------
// (b) Tidy > Single row (horizontal)
// ---------------------------------------------------------------------------
test('(b) Tidy > Single row (horizontal) lays 5 widgets in one row, x increasing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { ids } = await seedTask(window, 'Tidy horizontal test', [
    { title: 'w0', x: 700, y: 500 },
    { title: 'w1', x: 1200, y: 100 },
    { title: 'w2', x: 900, y: 800 },
    { title: 'w3', x: 1500, y: 300 },
    { title: 'w4', x: 1000, y: 50 }
  ])
  await openTask(window, /Tidy horizontal test/)
  await pickTidy(window, 'tidy-mode-horizontal')

  const pos = await widgetPositions(window, ids)
  expect(Object.keys(pos)).toHaveLength(5)

  const ys = new Set(ids.map((id) => pos[id].y))
  expect(ys.size, 'one shared row').toBe(1)

  for (let i = 0; i < ids.length - 1; i++) {
    expect(pos[ids[i]].x, `w${i}.x < w${i + 1}.x`).toBeLessThan(pos[ids[i + 1]].x)
  }
})

// ---------------------------------------------------------------------------
// (c) Tidy > Square grid
// ---------------------------------------------------------------------------
test('(c) Tidy > Square grid lays 4 widgets into a 2x2, columns aligned', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { ids } = await seedTask(window, 'Tidy square test', [
    { title: 'w0', x: 700, y: 500 },
    { title: 'w1', x: 1200, y: 100 },
    { title: 'w2', x: 900, y: 800 },
    { title: 'w3', x: 1500, y: 300 }
  ])
  await openTask(window, /Tidy square test/)
  await pickTidy(window, 'tidy-mode-square')
  await window.waitForTimeout(500)

  const pos = await widgetPositions(window, ids)
  expect(Object.keys(pos)).toHaveLength(4)
  const [w0, w1, w2, w3] = ids.map((id) => pos[id])

  // 2 columns -> w0,w1 top row; w2,w3 bottom row.
  expect(w0.y, 'w0/w1 share a row').toBe(w1.y)
  expect(w2.y, 'w2/w3 share a row').toBe(w3.y)
  expect(w2.y, 'row 2 below row 1').toBeGreaterThan(w0.y)
  expect(w0.x, 'column aligned: w0/w2').toBe(w2.x)
  expect(w1.x, 'column aligned: w1/w3').toBe(w3.x)

  const xs = new Set([w0.x, w1.x, w2.x, w3.x])
  const ys = new Set([w0.y, w1.y, w2.y, w3.y])
  expect(xs.size, 'two distinct columns').toBe(2)
  expect(ys.size, 'two distinct rows').toBe(2)
})

// ---------------------------------------------------------------------------
// (d) DEC-040: square grid derives its own shape — 6 widgets → 3 columns.
// This scenario used to drive "Columns... > 3 columns"; those explicit count
// buttons were removed ("I shouldn't need to select the amount"), and
// balancedColumns(6) === 3, so the expected geometry is unchanged.
// ---------------------------------------------------------------------------
test('(d) square grid spreads 6 widgets across three x values', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { ids } = await seedTask(window, 'Tidy columns test', [
    { title: 'w0', x: 700, y: 500 },
    { title: 'w1', x: 1200, y: 100 },
    { title: 'w2', x: 900, y: 800 },
    { title: 'w3', x: 1500, y: 300 },
    { title: 'w4', x: 1000, y: 50 },
    { title: 'w5', x: 1700, y: 650 }
  ])
  await openTask(window, /Tidy columns test/)
  await pickTidy(window, 'tidy-mode-square')

  const pos = await widgetPositions(window, ids)
  expect(Object.keys(pos)).toHaveLength(6)
  const xs = new Set(ids.map((id) => pos[id].x))
  expect(xs.size, 'three distinct columns').toBe(3)
  // 4th item wraps under the first column (matches the unit-tested contract).
  expect(pos[ids[3]].x, 'wraps to column 0').toBe(pos[ids[0]].x)
  expect(pos[ids[3]].y, 'wrapped row is below row 0').toBeGreaterThan(pos[ids[0]].y)
})

// ---------------------------------------------------------------------------
// (e) N2 regression: linked widgets still cluster after the refactor.
// ---------------------------------------------------------------------------
test('(e) linked widgets (A-B, C-D) stay adjacent after a Tidy, isolated E does not intrude', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Creation order is deliberately A, C, E, B, D — if clustering were broken
  // (e.g. a regression back to plain creation-order sort), the naive layout
  // would place them A,C,E,B,D in a row and A/B (and C/D) would NOT be
  // adjacent. Union-find clustering must re-sort this into [A,B,C,D,E] (or
  // [C,D,A,B,E] — whichever cluster's earliest member sorts first) so linked
  // pairs are always neighbours.
  const { taskId, ids } = await seedTask(window, 'Tidy cluster test', [
    { title: 'A', x: 700, y: 100 },
    { title: 'C', x: 1600, y: 700 },
    { title: 'E', x: 900, y: 900 },
    { title: 'B', x: 1300, y: 200 },
    { title: 'D', x: 2000, y: 400 }
  ])
  const [aId, cId, eId, bId, dId] = ids

  await window.evaluate(
    async ({ taskId, aId, bId, cId, dId }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgetLinks.create(aId, bId, taskId)
      await api.widgetLinks.create(cId, dId, taskId)
    },
    { taskId, aId, bId, cId, dId }
  )

  await openTask(window, /Tidy cluster test/)
  // Single row makes "adjacent" unambiguous: adjacency in sorted-x order maps
  // 1:1 onto adjacency in the algorithm's internal item order, with no
  // row-wrap boundary to complicate the check.
  await pickTidy(window, 'tidy-mode-horizontal')

  const pos = await widgetPositions(window, ids)
  expect(Object.keys(pos)).toHaveLength(5)

  const byX = [...ids].sort((x, y) => pos[x].x - pos[y].x)
  const indexOf = (id: string): number => byX.indexOf(id)

  expect(Math.abs(indexOf(aId) - indexOf(bId)), 'A and B are neighbours').toBe(1)
  expect(Math.abs(indexOf(cId) - indexOf(dId)), 'C and D are neighbours').toBe(1)
  // E must not sit between either linked pair.
  const eIdx = indexOf(eId)
  const abLo = Math.min(indexOf(aId), indexOf(bId))
  const abHi = Math.max(indexOf(aId), indexOf(bId))
  const cdLo = Math.min(indexOf(cId), indexOf(dId))
  const cdHi = Math.max(indexOf(cId), indexOf(dId))
  expect(eIdx < abLo || eIdx > abHi, 'E is outside the A-B pair').toBe(true)
  expect(eIdx < cdLo || eIdx > cdHi, 'E is outside the C-D pair').toBe(true)
})

// ---------------------------------------------------------------------------
// (f) N3 regression: doc/sheet widgets open at the new bumped catalog sizes
// when spawned through the real Add-object palette.
// ---------------------------------------------------------------------------
test('(f) Add object > Files > Document/Spreadsheet spawn at the new catalog default sizes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Add object size test' })
  })
  await openTask(window, /Add object size test/)

  const surface = window.locator('[data-canvas-surface="true"]')
  const menu = window.locator('[data-canvas-ctx-menu]')

  // --- Document ---
  await surface.click({ button: 'right', position: { x: 200 + (await visibleOrigin(window)), y: 200 } })
  await expect(menu.first()).toBeVisible()
  await menu.getByText('Add object', { exact: true }).hover()
  await window.waitForTimeout(200)
  await menu.getByText('Files', { exact: true }).hover()
  await window.waitForTimeout(200)
  await menu.getByText('Document', { exact: true }).click()

  const dialog = window.locator('[data-testid="office-add-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-add-new"]').click()
  await expect(dialog).toBeHidden({ timeout: 6_000 })

  // Placed at canvas (200,200) with width 860 -> spans roughly x:-230..630,
  // y:180..940. The second right-click below is well clear of that box.
  await window.waitForTimeout(300)

  // --- Spreadsheet (second right-click at a point clear of the just-placed doc) ---
  await surface.click({ button: 'right', position: { x: 900 + (await visibleOrigin(window)), y: 500 } })
  await expect(menu.first()).toBeVisible()
  await menu.getByText('Add object', { exact: true }).hover()
  await window.waitForTimeout(200)
  await menu.getByText('Files', { exact: true }).hover()
  await window.waitForTimeout(200)
  await menu.getByText('Spreadsheet', { exact: true }).click()

  await expect(dialog).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-add-new"]').click()
  await expect(dialog).toBeHidden({ timeout: 6_000 })
  await window.waitForTimeout(300)

  const sizes = await window.evaluate(() => {
    const w = window as unknown as {
      __fbWidgets?: {
        getState: () => { zoom: number; widgets: Array<{ kind: string; width: number; height: number }> }
      }
    }
    const st = w.__fbWidgets?.getState()
    const all = st?.widgets ?? []
    const surface = document.querySelector('[data-canvas-surface="true"]') as HTMLElement | null
    const r = surface?.getBoundingClientRect()
    return {
      view: { width: r?.width ?? 0, height: r?.height ?? 0, zoom: st?.zoom ?? 0 },
      doc: all.filter((x) => x.kind === 'doc').map((x) => ({ width: x.width, height: x.height })),
      sheet: all.filter((x) => x.kind === 'sheet').map((x) => ({ width: x.width, height: x.height }))
    }
  })

  // Since 364e801d ("Cap EVERY new widget to the view, in one place") a new
  // widget opening at its untouched catalogue default is scaled, both axes by
  // one factor, to fit within 3/4 of the visible canvas (measured in canvas
  // units at the current zoom), never below 240x160 and never enlarged. So the
  // catalogue default is the INPUT and the on-desk size is that default under
  // the cap. Spelled out here rather than imported, so a change to either the
  // defaults or the cap shows up as a failure instead of agreeing with itself.
  expect(sizes.view.width, 'the canvas viewport was measured').toBeGreaterThan(0)
  expect(sizes.view.height, 'the canvas viewport was measured').toBeGreaterThan(0)
  expect(sizes.view.zoom, 'the canvas zoom was read').toBeGreaterThan(0)
  const capped = (w: number, h: number): { width: number; height: number } => {
    const scale = Math.min(
      1,
      ((sizes.view.width / sizes.view.zoom) * 0.75) / w,
      ((sizes.view.height / sizes.view.zoom) * 0.75) / h
    )
    if (scale >= 1) return { width: w, height: h }
    return { width: Math.max(240, Math.round(w * scale)), height: Math.max(160, Math.round(h * scale)) }
  }

  expect(sizes.doc, 'exactly one doc widget was created').toHaveLength(1)
  expect(sizes.doc[0], 'doc opens at its 860x760 catalogue default, under the view cap').toEqual(
    capped(860, 760)
  )

  expect(sizes.sheet, 'exactly one sheet widget was created').toHaveLength(1)
  expect(sizes.sheet[0], 'sheet opens at its 880x580 catalogue default, under the view cap').toEqual(
    capped(880, 580)
  )
})
