import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Verifies plexi-4.0 polish change 2 (N3 — uniform widget body text):
//   New token --fb-body-size:13px + `.fb-body { font-size:var(--fb-body-size);
//   line-height:1.5 }`. StickyWidget (was 18/24px), NoteWidget (was 14/16px),
//   and FieldEditor's cell/widget variants (was 12px cell / 14px widget) are
//   all normalised to .fb-body (13px). Card + Markdown were already 13px.
//   Headings, table column headers (11px), chrome labels, code blocks, office
//   editors, calculator/timer/color are explicitly LEFT ALONE — the point is
//   uniform BODY text, not a flattened type scale.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

async function computedFontSize(window: Page, selector: string): Promise<string> {
  return window.evaluate((sel: string) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`no element for selector ${sel}`)
    return getComputedStyle(el).fontSize
  }, selector)
}

// ── (d) sticky / note / field bodies all compute to 13px ───────────────────

test('(d) a sticky widget renders its body text at 13px in both rendered and edit states', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Sticky body size' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'sticky',
      content: 'Sticky body copy for font-size assertion',
      x: 100,
      y: 100,
      width: 240,
      height: 200
    })
    return { taskId: task.id, id: w.id }
  })
  await openTask(window, /Sticky body size/)
  await window.waitForSelector(`[data-widget-id="${seeded.id}"]`, { timeout: 5_000 })

  const renderedSize = await computedFontSize(window, `[data-widget-id="${seeded.id}"] .fb-sticky-rendered`)
  expect(renderedSize, 'sticky rendered body is 13px (was 18px/text-lg)').toBe('13px')

  // Enter edit mode (click into the rendered body) and check the textarea too.
  await window.locator(`[data-widget-id="${seeded.id}"] .fb-sticky-rendered`).click()
  await window.waitForTimeout(150)
  const editSize = await computedFontSize(window, `[data-widget-id="${seeded.id}"] .fb-sticky-textarea`)
  expect(editSize, 'sticky edit-mode textarea is 13px (was 18px/text-lg)').toBe('13px')
})

test('(d) a note widget renders its body text at 13px in both rendered and edit states', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Note body size' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'note',
      content: 'Note body copy for font-size assertion',
      x: 100,
      y: 100,
      width: 260,
      height: 200
    })
    return { taskId: task.id, id: w.id }
  })
  await openTask(window, /Note body size/)
  await window.waitForSelector(`[data-widget-id="${seeded.id}"]`, { timeout: 5_000 })

  const renderedSize = await computedFontSize(window, `[data-widget-id="${seeded.id}"] .fb-note-rendered`)
  expect(renderedSize, 'note rendered body is 13px (was 14px/text-sm)').toBe('13px')

  await window.locator(`[data-widget-id="${seeded.id}"] .fb-note-rendered`).click()
  await window.waitForTimeout(150)
  // NoteWidget's edit textarea has no dedicated class hook beyond fb-body;
  // it's the only <textarea> inside the widget frame while editing.
  const editSize = await computedFontSize(window, `[data-widget-id="${seeded.id}"] textarea`)
  expect(editSize, 'note edit-mode textarea is 13px (was 14px/text-sm)').toBe('13px')
})

test('(d) a field widget (text-short, "widget" variant) renders its input at 13px', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Field body size' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'field',
      title: 'Name',
      content: JSON.stringify({
        def: { type: 'text-short', label: 'Name', config: {} },
        value: 'Field body copy'
      }),
      x: 100,
      y: 100,
      width: 260,
      height: 160
    })
    return { taskId: task.id, id: w.id }
  })
  await openTask(window, /Field body size/)
  await window.waitForSelector(`[data-widget-id="${seeded.id}"]`, { timeout: 5_000 })

  const size = await computedFontSize(window, `[data-widget-id="${seeded.id}"] input.fb-body`)
  expect(size, 'field widget-variant input is 13px (was 14px/text-sm)').toBe('13px')
})

test('(d) a table cell (FieldEditor "cell" variant) renders at 13px and the table has no broken/overflowing rows', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Table cell body size' })
    const tbl = await api.tables.create({
      taskId: task.id,
      title: 'Cell size check',
      schema: {
        columns: [
          { id: 'c_name', label: 'Name', type: 'text-short', config: {} },
          { id: 'c_notes', label: 'Notes', type: 'text-short', config: {} }
        ]
      }
    } as never)
    await api.tables.createRow({
      tableId: tbl.id,
      cells: { c_name: 'Row one', c_notes: 'A moderately long note value for overflow checking' }
    } as never)
    await api.tables.createRow({
      tableId: tbl.id,
      cells: { c_name: 'Row two', c_notes: 'Another note' }
    } as never)
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'table',
      title: 'Cell size check',
      content: tbl.id,
      x: 100,
      y: 100,
      width: 460,
      height: 300
    })
    return { taskId: task.id, widgetId: w.id }
  })
  await openTask(window, /Table cell body size/)
  const frame = window.locator(`[data-widget-id="${seeded.widgetId}"]`)
  await expect(frame).toBeVisible({ timeout: 5_000 })
  await expect(frame.locator('table')).toBeVisible({ timeout: 5_000 })

  // Cell input is 13px (fb-body) — was text-[12px].
  const cellSize = await computedFontSize(window, `[data-widget-id="${seeded.widgetId}"] table tbody tr td input`)
  expect(cellSize, 'table cell input is 13px (was 12px)').toBe('13px')

  // Column header is UNCHANGED at 11px — the uniform-body change is body
  // copy only, not chrome/labels. `thead th` alone would match the FIRST th
  // in DOM order, which is the empty row-handle placeholder cell (no
  // font-size class of its own, so it inherits the wrapper div's ambient
  // 12px) rather than the real ColumnHeader cell — target the actual
  // column header via its `data-col-index` marker instead.
  const headerSize = await computedFontSize(window, `[data-widget-id="${seeded.widgetId}"] table thead th[data-col-index="0"]`)
  expect(headerSize, 'table column header stays 11px, untouched by the body-size change').toBe('11px')

  // No broken/overflowing rows: each data row renders with a sane, non-zero
  // height and the table body doesn't need to horizontally scroll to fit two
  // narrow text columns at the widened widget size (460px, 2 columns @
  // minWidth 140px each comfortably fits).
  // Scope to real data rows via `data-row-index` — plain `tbody tr` also
  // matches the trailing "Add row" footer <tr>, which isn't a data row.
  const rowMetrics = await window.evaluate((sel: string) => {
    const rows = Array.from(document.querySelectorAll(sel))
    return rows.map((r) => (r as HTMLElement).getBoundingClientRect().height)
  }, `[data-widget-id="${seeded.widgetId}"] table tbody tr[data-row-index]`)
  expect(rowMetrics.length, 'both seeded rows rendered').toBe(2)
  for (const h of rowMetrics) {
    expect(h, 'row height is sane (not collapsed, not blown out)').toBeGreaterThan(15)
    expect(h).toBeLessThan(80)
  }

  const bodyEl = window.locator('[data-testid="table-body"]')
  const overflowX = await bodyEl.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflowX, 'no horizontal overflow from the 12→13px cell font bump at this widget width').toBeLessThanOrEqual(4)
})

// ── (e) hierarchy preserved: headings stay bigger, table headers stay smaller ─

test('(e) a heading inside a page widget renders LARGER than the 13px body size', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Heading hierarchy check' })
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'A Big Heading' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Ordinary body paragraph text.' }] }
      ]
    }
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'page',
      title: 'Doc',
      content: JSON.stringify(doc),
      x: 100,
      y: 100,
      width: 420,
      height: 320
    })
    return { taskId: task.id, id: w.id }
  })
  await openTask(window, /Heading hierarchy check/)
  await window.waitForSelector(`[data-widget-id="${seeded.id}"]`, { timeout: 5_000 })
  await window.waitForTimeout(300)

  const h1Size = await computedFontSize(window, `[data-widget-id="${seeded.id}"] .md-rendered h1`)
  const pSize = await computedFontSize(window, `[data-widget-id="${seeded.id}"] .md-rendered p`)

  expect(pSize, 'the page body paragraph is the canonical 13px').toBe('13px')
  expect(parseFloat(h1Size), 'the heading is strictly larger than the 13px body').toBeGreaterThan(parseFloat(pSize))
  // h1 is 1.55em over a 13px base per globals.css → ~20.15px.
  expect(parseFloat(h1Size)).toBeGreaterThanOrEqual(19)
})

test('(e) a table column header stays smaller (~11px) than the uniform 13px body size', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Header hierarchy check' })
    const tbl = await api.tables.create({
      taskId: task.id,
      title: 'Header check',
      schema: { columns: [{ id: 'c_a', label: 'Column A', type: 'text-short', config: {} }] }
    } as never)
    await api.tables.createRow({ tableId: tbl.id, cells: { c_a: 'value' } } as never)
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'table',
      title: 'Header check',
      content: tbl.id,
      x: 100,
      y: 100,
      width: 380,
      height: 260
    })
    return { taskId: task.id, id: w.id }
  })
  await openTask(window, /Header hierarchy check/)
  const frame = window.locator(`[data-widget-id="${seeded.id}"]`)
  await expect(frame.locator('table')).toBeVisible({ timeout: 5_000 })

  const headerSize = await computedFontSize(window, `[data-widget-id="${seeded.id}"] table thead th[data-col-index="0"]`)
  const cellSize = await computedFontSize(window, `[data-widget-id="${seeded.id}"] table tbody tr td input`)

  expect(headerSize).toBe('11px')
  expect(cellSize).toBe('13px')
  expect(parseFloat(headerSize), 'the column header is smaller than the uniform body size').toBeLessThan(parseFloat(cellSize))
})
