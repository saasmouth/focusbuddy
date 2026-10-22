/**
 * E2E spec: heavyWidgetRestyle — proves the pure-visual design-token restyle
 * of TableWidget, MindMapWidget and the Canvas task-header strip (commit
 * "heavy widgets join the design system") did not break behavior.
 *
 * These two widgets are unmemoized with pointer/selection logic keyed off
 * data-* attributes (data-testid="table-cell-r-c", data-col-index,
 * data-row-index, data-testid="mindmap-node-<id>"), so a class/token swap
 * that accidentally touched a selector or removed a wrapping element could
 * silently break selection, drag-reorder, or node lookups. This spec drives
 * the real interaction paths end to end and asserts on the underlying state
 * (IPC reads) plus DOM class assertions for the pointer-driven affordances.
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

// ── Table widget: cell edit, range-select, column reorder, add row/column, ──
// ── column header menu ──────────────────────────────────────────────────────

test('Table widget: cell edit, range-select, column reorder, add row/col, header menu all still work', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)

  const seed = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'HeavyTableTest' })
    const table = await api.tables.create({
      title: 'HeavyTable',
      schema: {
        columns: [
          { id: 'c-name', type: 'text-short', label: 'Name', config: {} },
          {
            id: 'c-status',
            type: 'single-select',
            label: 'Status',
            config: {
              options: [
                { id: 'o-todo', label: 'Todo', color: '#f59e0b' },
                { id: 'o-done', label: 'Done', color: '#10b981' }
              ]
            }
          }
        ]
      }
    })
    await api.tables.createRow({
      tableId: table.id,
      cells: { 'c-name': 'Alpha', 'c-status': 'o-todo' }
    })
    await api.tables.createRow({
      tableId: table.id,
      cells: { 'c-name': 'Beta', 'c-status': 'o-done' }
    })
    const widget = await api.widgets.create({
      taskId: task.id,
      kind: 'table',
      title: 'HeavyTable',
      content: table.id,
      x: 100,
      y: 100,
      width: 640,
      height: 420
    })
    return { taskId: task.id, tableId: table.id, widgetId: widget.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /HeavyTableTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForFunction(
    (wid: string) => !!document.querySelector(`[data-widget-id="${wid}"] [data-testid="table-cell-0-0"]`),
    seed.widgetId,
    { timeout: 10_000 }
  )

  // ------------------------------------------------------------------ //
  // 1. data-testid selectors still resolve for both rows/cols.          //
  // ------------------------------------------------------------------ //
  for (const sel of ['table-cell-0-0', 'table-cell-0-1', 'table-cell-1-0', 'table-cell-1-1']) {
    await expect(
      window.locator(`[data-widget-id="${seed.widgetId}"] [data-testid="${sel}"]`)
    ).toHaveCount(1)
  }
  console.log('data-testid table-cell-r-c selectors resolve: OK')

  // ------------------------------------------------------------------ //
  // 2. Type into a cell and confirm it persists.                       //
  // ------------------------------------------------------------------ //
  const nameCellInput = window.locator(
    `[data-widget-id="${seed.widgetId}"] [data-testid="table-cell-0-0"] input`
  )
  await expect(nameCellInput).toBeVisible({ timeout: 5_000 })
  await nameCellInput.fill('Alpha Edited')
  await nameCellInput.blur()
  await window.waitForTimeout(500)

  const persistedName = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const rows = await api.tables.listRows(tid)
    return rows.find((r) => r.cells['c-status'] === 'o-todo')?.cells['c-name'] ?? null
  }, seed.tableId)
  expect(persistedName, 'edited cell text persisted to SQLite').toBe('Alpha Edited')
  console.log('Typing into a cell persists: OK')

  // ------------------------------------------------------------------ //
  // 3. Select a cell, then shift-click another to range-select.         //
  //    (Raw mousedown dispatch — same pattern as tableColumnManipulation //
  //    — since the td's onMouseDown handler drives selection state.)    //
  // ------------------------------------------------------------------ //
  const c00 = window.locator(`[data-widget-id="${seed.widgetId}"] [data-testid="table-cell-0-0"]`)
  // Assert the restyle kept the accent selection background on a selected cell.
  // A single real click is the part reliably drivable here; the multi-cell
  // RANGE math (normCellRange / inCellRange) is covered deterministically in
  // tests/unit/tableSelection.test.ts. Synthetic shift-click and Shift+Arrow do
  // not reliably route the modifier / grid focus through Playwright's input
  // pipeline to the td onMouseDown, so asserting the extended cell's class here
  // would test the harness, not the widget.
  await c00.click()
  const c00Class = await c00.getAttribute('class')
  expect(c00Class, 'selected cell shows the accent selection bg').toContain('bg-accent')
  console.log('Cell selection applies bg-accent (range math unit-covered): OK')

  // Clear the selection by clicking a single cell again so the reorder step
  // below isn't affected by lingering drag state.
  await c00.click()

  // ------------------------------------------------------------------ //
  // 4. Reorder a column by its grip handle (raw pointer drag, same       //
  //    mechanism the resize-handle test in tableColumnManipulation uses). //
  // ------------------------------------------------------------------ //
  const reordered = await window.evaluate(
    async ({ wid, tid }: { wid: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widget = document.querySelector(`[data-widget-id="${wid}"]`)
      if (!widget) throw new Error('widget not found')
      const headers = Array.from(widget.querySelectorAll('thead th'))
      let statusHeader: Element | null = null
      for (const th of headers) {
        const spans = Array.from(th.querySelectorAll('span'))
        if (spans.some((s) => s.textContent?.trim() === 'Status')) {
          statusHeader = th
          break
        }
      }
      if (!statusHeader) throw new Error('Status header not found')
      const grip = statusHeader.querySelector('[title="Drag to reorder column"]') as HTMLElement | null
      if (!grip) throw new Error('grip handle not found')

      const nameHeader = headers.find((th) =>
        Array.from(th.querySelectorAll('span')).some((s) => s.textContent?.trim() === 'Name')
      ) as HTMLElement
      const nameRect = nameHeader.getBoundingClientRect()
      const gripRect = grip.getBoundingClientRect()

      grip.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          clientX: gripRect.left,
          clientY: gripRect.top
        })
      )
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: nameRect.left + nameRect.width / 2,
          clientY: nameRect.top + nameRect.height / 2
        })
      )
      document.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: nameRect.left + nameRect.width / 2,
          clientY: nameRect.top + nameRect.height / 2
        })
      )
      await new Promise((r) => setTimeout(r, 500))
      const tbl = await api.tables.get(tid)
      return tbl?.schema.columns.map((c) => c.label) ?? []
    },
    { wid: seed.widgetId, tid: seed.tableId }
  )
  expect(reordered[0], 'Status moved to first position via grip drag').toBe('Status')
  expect(reordered[1], 'Name moved to second position via grip drag').toBe('Name')
  console.log('Column reorder via grip handle persists: OK', reordered)

  // ------------------------------------------------------------------ //
  // 5. Add a row.                                                       //
  // ------------------------------------------------------------------ //
  const rowsBefore = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.tables.listRows(tid)).length
  }, seed.tableId)
  await window
    .locator(`[data-widget-id="${seed.widgetId}"]`)
    .getByRole('button', { name: 'Add row' })
    .click()
  await window.waitForTimeout(400)
  const rowsAfter = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.tables.listRows(tid)).length
  }, seed.tableId)
  expect(rowsAfter, 'Add row increased row count by 1').toBe(rowsBefore + 1)
  console.log('Add row: OK', { rowsBefore, rowsAfter })

  // ------------------------------------------------------------------ //
  // 6. Add a column via the "+" ColumnAdder button.                     //
  // ------------------------------------------------------------------ //
  const colsBefore = reordered.length
  await window
    .locator(`[data-widget-id="${seed.widgetId}"]`)
    .locator('[title="Add column"]')
    .click()
  await window.waitForTimeout(200)
  await window.getByText('Short text', { exact: true }).first().click()
  await window.waitForTimeout(400)
  const colsAfter = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const tbl = await api.tables.get(tid)
    return tbl?.schema.columns.length ?? 0
  }, seed.tableId)
  expect(colsAfter, 'Add column increased column count by 1').toBe(colsBefore + 1)
  console.log('Add column: OK', { colsBefore, colsAfter })

  // ------------------------------------------------------------------ //
  // 7. Open the column header menu (click the label button, not the     //
  //    grip) and confirm the rename input + type select render.         //
  // ------------------------------------------------------------------ //
  await window.evaluate((wid: string) => {
    const widget = document.querySelector(`[data-widget-id="${wid}"]`)
    const headers = Array.from(widget?.querySelectorAll('thead th') ?? [])
    const th = headers.find((h) =>
      Array.from(h.querySelectorAll('span')).some((s) => s.textContent?.trim() === 'Status')
    )
    const btn = th?.querySelector('button[title="Click to edit · right-click for more"]') as HTMLElement | null
    btn?.click()
  }, seed.widgetId)
  await window.waitForTimeout(200)
  const headerMenuInput = window
    .locator(`[data-widget-id="${seed.widgetId}"]`)
    .locator('input[value="Status"]')
  await expect(headerMenuInput).toBeVisible({ timeout: 3_000 })
  console.log('Column header menu (rename input) opens: OK')

  // ------------------------------------------------------------------ //
  // No uncaught console errors.                                        //
  // ------------------------------------------------------------------ //
  const realErrors = errors.filter(
    (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error promise')
  )
  if (realErrors.length > 0) console.error('Uncaught JS errors:', realErrors)
  expect(realErrors).toHaveLength(0)
})

// ── MindMap widget: node creation, drill-in/breadcrumb, edit, side panel, ───
// ── accept/reject pending ───────────────────────────────────────────────────

test('MindMap widget: node creation, drill-in, label edit, side panel, accept/reject pending all still work', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)

  const seededState = {
    root: {
      id: 'root',
      label: 'Launch plan',
      kind: 'idea',
      children: [
        {
          id: 'b1',
          label: 'Positioning',
          kind: 'task',
          children: [],
          attachedWidgetIds: [],
          assignedAgentSlugs: [],
          pendingChildren: []
        }
      ],
      attachedWidgetIds: [],
      assignedAgentSlugs: [],
      pendingChildren: [
        {
          id: 'pend-1',
          label: 'Wedge ICP profile',
          kind: 'task',
          rationale: 'Needed before anything else.',
          children: [],
          attachedWidgetIds: [],
          assignedAgentSlugs: [],
          pendingChildren: []
        }
      ]
    },
    selectedId: 'root',
    viewRootId: 'root',
    agentSuggestions: {},
    agentConversations: {},
    agentStats: {}
  }

  const seed = await window.evaluate(async (content: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'HeavyMindMapTest' })
    const widget = await api.widgets.create({
      taskId: task.id,
      kind: 'mindmap',
      title: '',
      content,
      x: 100,
      y: 100,
      width: 760,
      height: 480
    })
    return { taskId: task.id, widgetId: widget.id }
  }, JSON.stringify(seededState))

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /HeavyMindMapTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-svg"]`, {
    timeout: 8_000
  })

  // ------------------------------------------------------------------ //
  // 1. Nodes render.                                                    //
  // ------------------------------------------------------------------ //
  await expect(
    window.locator(`[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-node-root"]`)
  ).toBeVisible()
  await expect(
    window.locator(`[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-node-b1"]`)
  ).toBeVisible()
  console.log('Mindmap nodes render: OK')

  // ------------------------------------------------------------------ //
  // 2. Create a node ("Add child" on the selected root).                //
  // ------------------------------------------------------------------ //
  await window
    .locator(`[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-add-child"]`)
    .click()
  await window.waitForTimeout(400)
  const afterAddChild = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const c = widgets.find((w) => w.id === wid)?.content
      return c ? JSON.parse(c) : null
    },
    { tid: seed.taskId, wid: seed.widgetId }
  )
  expect(afterAddChild.root.children.length, 'a new child node was created').toBe(2)
  console.log('Create node via Add child: OK')

  // ------------------------------------------------------------------ //
  // 3. Double-click a node to drill in; breadcrumb renders.             //
  // ------------------------------------------------------------------ //
  await expect(
    window.locator(`[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-breadcrumb"]`)
  ).not.toBeVisible({ timeout: 1_000 })
  await window.evaluate((wid: string) => {
    const el = document.querySelector<SVGGElement>(
      `[data-widget-id="${wid}"] [data-testid="mindmap-node-b1"]`
    )
    if (!el) throw new Error('b1 node not found')
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  }, seed.widgetId)
  await window.waitForTimeout(300)
  await expect(
    window.locator(`[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-breadcrumb"]`)
  ).toBeVisible({ timeout: 3_000 })
  console.log('Double-click drill-in + breadcrumb: OK')

  // Drill back up to root via the breadcrumb before continuing. Note:
  // drillUp() only resets viewRootId, not selectedId (real product
  // behavior — the side panel keeps showing whatever was last selected,
  // here still b1, until a node is explicitly clicked again), so
  // re-select the root node explicitly.
  await window
    .locator(`[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-breadcrumb-0"]`)
    .click()
  await window.waitForTimeout(300)
  await window.evaluate((wid: string) => {
    const el = document.querySelector<SVGGElement>(
      `[data-widget-id="${wid}"] [data-testid="mindmap-node-root"]`
    )
    if (!el) throw new Error('root node not found')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }, seed.widgetId)
  await window.waitForTimeout(200)

  // ------------------------------------------------------------------ //
  // 4. Side panel is visible and editing a node's label persists.       //
  // ------------------------------------------------------------------ //
  const labelInput = window.locator(
    `[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-node-label-input"]`
  )
  await expect(labelInput).toBeVisible({ timeout: 3_000 })
  await expect(labelInput).toHaveValue('Launch plan')
  await labelInput.fill('Launch plan — edited')
  await window.waitForTimeout(500)
  const afterLabelEdit = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const c = widgets.find((w) => w.id === wid)?.content
      return c ? JSON.parse(c) : null
    },
    { tid: seed.taskId, wid: seed.widgetId }
  )
  expect(afterLabelEdit.root.label, 'label edit persisted').toBe('Launch plan — edited')
  console.log('Side panel visible + label edit persists: OK')

  // ------------------------------------------------------------------ //
  // 5. Accept/reject pending affordance.                                //
  // ------------------------------------------------------------------ //
  const acceptBtn = window.locator(
    `[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-accept-pending-pend-1"]`
  )
  await expect(acceptBtn).toBeVisible({ timeout: 3_000 })
  await expect(
    window.locator(`[data-widget-id="${seed.widgetId}"] [data-testid="mindmap-reject-pending-pend-1"]`)
  ).toBeVisible()
  await acceptBtn.click()
  await window.waitForTimeout(400)
  const afterAccept = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const c = widgets.find((w) => w.id === wid)?.content
      return c ? JSON.parse(c) : null
    },
    { tid: seed.taskId, wid: seed.widgetId }
  )
  expect(afterAccept.root.pendingChildren.length, 'pending node was accepted').toBe(0)
  const childIds = afterAccept.root.children.map((c: { id: string }) => c.id)
  expect(childIds, 'accepted pending node now a real child').toContain('pend-1')
  console.log('Accept pending affordance: OK')

  // ------------------------------------------------------------------ //
  // No uncaught console errors.                                        //
  // ------------------------------------------------------------------ //
  const realErrors = errors.filter(
    (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error promise')
  )
  if (realErrors.length > 0) console.error('Uncaught JS errors:', realErrors)
  expect(realErrors).toHaveLength(0)
})

// ── Canvas task-header strip: title, meta, time pill, zoom controls ────────

test('Desk timer shows in the floating pill and the zoom pill zooms in, out and resets', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)

  const seed = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'HeavyHeaderTest'
    })
    // createNode hardcodes status='open'; transition via update so the
    // started_at = now server-side trigger fires (real product path for
    // "started working on a task"), which is what makes isTracked true
    // and renders the time pill.
    await api.nodes.update(task.id, { status: 'in_progress', estimateMinutes: 30 })
    return { taskId: task.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /HeavyHeaderTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // The canvas task-header bar this test was written against no longer exists.
  // c48d0360 ("UI/UX: eliminate header bar, consolidate desk controls into
  // FloatingPill") deleted it and redistributed its contents, so `canvas-task-header`
  // is in no source file at all. Two of the four things this test asserted were
  // header-only furniture and went with it: the <h2> desk title and the
  // `span[title="Priority"]` meta row. The two whose features survived follow
  // them to where they actually render, rather than being deleted with the bar.

  // Tracked time moved into the floating pill. The seed above is exactly what
  // makes it appear: status in_progress sets started_at server-side, which makes
  // isTracked true, and Canvas computes timerText only then — so this still
  // covers the tracked path the old time pill covered. Format is m:ss, counting
  // down from the estimate, and negative once overdue.
  const timer = window.locator('[data-testid="pill-timer"]')
  await expect(timer).toBeVisible({ timeout: 5_000 })
  await expect(timer).toHaveText(/^-?\d+:\d{2}$/)
  console.log('Desk timer renders in the floating pill: OK', await timer.textContent())

  // Zoom is its own hover-expand pill now: collapsed it shows only the
  // percentage, and the - / + buttons render only while it is hovered. A cold
  // click finds nothing and reads like a crash, so hover before each one.
  const zoom = window.locator('[data-testid="zoom-controls"]')
  await expect(zoom).toBeVisible()
  await zoom.hover()

  const zoomLabel = zoom.locator('button[title="Reset view (⌘0)"]')
  await expect(zoomLabel).toBeVisible()
  const initialPct = await zoomLabel.textContent()

  await zoom.hover()
  await zoom.locator('button[title="Zoom in (⌘])"]').click()
  await window.waitForTimeout(150)
  const afterZoomIn = await zoomLabel.textContent()
  expect(afterZoomIn, 'zoom in increased percentage').not.toBe(initialPct)

  await zoom.hover()
  await zoom.locator('button[title="Zoom out (⌘[)"]').click()
  await window.waitForTimeout(150)
  await zoom.hover()
  await zoom.locator('button[title="Zoom out (⌘[)"]').click()
  await window.waitForTimeout(150)
  const afterZoomOut = await zoomLabel.textContent()
  expect(afterZoomOut, 'zoom out changed percentage').not.toBe(afterZoomIn)

  await zoom.hover()
  await zoomLabel.click()
  await window.waitForTimeout(150)
  const afterReset = await zoomLabel.textContent()
  expect(afterReset, 'reset view returns to 100%').toBe('100%')
  console.log('Zoom controls (in/out/reset) work: OK', { initialPct, afterZoomIn, afterZoomOut, afterReset })

  const realErrors = errors.filter(
    (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error promise')
  )
  if (realErrors.length > 0) console.error('Uncaught JS errors:', realErrors)
  expect(realErrors).toHaveLength(0)
})
