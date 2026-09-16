import { useEffect, useRef, useState } from 'react'
import MentionTextarea from '../MentionTextarea'
import type { Widget } from '@shared/types'
import type {
  FbRow,
  FieldDefinition,
  FieldType,
  TableSchema,
  TableViewConfig,
  TableViewMode
} from '@shared/fields'
import {
  FIELD_TYPE_ICONS,
  FIELD_TYPE_LABELS,
  coerceFieldValue,
  defaultConfig,
  defaultValue
} from '@shared/fields'
import WidgetFrame from './WidgetFrame'
import TableImportDialog from './TableImportDialog'
import type { ParsedGrid } from '../../lib/tableImport'
import { useTablesStore } from '../../stores/tables'
import { useActionHistory } from '../../stores/actionHistory'
import { useWidgetStore } from '../../stores/widgets'
import FieldEditor from '../fields/FieldEditor'
import { DOC_DRAG_MIME, readDocDrag, primeDocMeta } from '../../lib/docMetaCache'
import RelationConfigEditor from '../fields/RelationConfigEditor'
import { coerceCellValue } from '../../lib/actionExecutor'
import {
  normCellRange,
  inCellRange,
  cellsToTsv,
  planTablePaste,
  type RC,
  type RCRange
} from '../../lib/tableSelection'
import { parseTsv } from '@shared/gridClipboard'
import Icon from '../Icon'
import { ListView, CardsView, KanbanView, CalendarView, GanttView } from './TableViews'
import UnifiedConnectedMenu from '../contextMenu/UnifiedConnectedMenu'
import TableFilterBar from './TableFilterBar'
import { applyFilters, groupRows } from '../../lib/tableFilter'
import type { RowGroup } from '../../lib/tableFilter'

// All available views with the icon + label that drive the switcher pill.
const VIEW_OPTIONS: Array<{ id: TableViewMode; label: string; icon: string }> = [
  { id: 'table', label: 'Table', icon: 'table_chart' },
  { id: 'list', label: 'List', icon: 'view_list' },
  { id: 'cards', label: 'Cards', icon: 'view_module' },
  { id: 'kanban', label: 'Kanban', icon: 'view_kanban' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar_month' },
  { id: 'gantt', label: 'Gantt', icon: 'timeline' }
]

// Table-view column geometry. The leading column holds the delete-row button,
// the trailing one holds the add-column button; data columns size to their
// per-column widthHint and fall back to DEFAULT_COL_WIDTH. Resizing never goes
// below MIN_COL_WIDTH so a column can't collapse to nothing.
const ROW_HANDLE_WIDTH = 32
const ADD_COL_WIDTH = 40
const DEFAULT_COL_WIDTH = 160
const MIN_COL_WIDTH = 64

interface Props {
  widget: Widget
  inline?: boolean
}

// Airtable-style table.
//
// widget.content stores the fb_tables.id. The widget loads the table's schema
// and rows on mount; edits go through the tables store (which writes through
// to SQLite via IPC). A fresh widget (no content yet) auto-creates a backing
// table on first render so the user never sees a "create table" step.
// Pointer-based drag-to-reorder, shared by columns and rows. HTML5 drag and
// drop is unreliable here: the table lives inside the canvas widget frame
// (react-rnd intercepts the gesture) and DataTransfer payloads are flaky in
// Electron. So we track the pointer ourselves. The caller marks each reorderable
// element with a data-<axis>-index attribute; on every move we find which
// element's bounding box the cursor sits inside along the drag axis (x for
// columns, y for rows) and read its index, committing that target on release.
// Hit-testing by rect (rather than elementFromPoint) is deterministic, works
// under test harnesses, and naturally scopes to the table under the cursor
// because only its elements span that screen position.
function usePointerReorder(
  indexAttr: string,
  axis: 'x' | 'y',
  onCommit: (id: string, targetIndex: number) => void
): {
  dragId: string | null
  overIndex: number | null
  start: (e: React.MouseEvent, id: string) => void
} {
  const [drag, setDrag] = useState<{ id: string; over: number | null } | null>(null)
  const ref = useRef<{ id: string; over: number | null } | null>(null)
  const set = (v: { id: string; over: number | null } | null): void => {
    ref.current = v
    setDrag(v)
  }
  const start = (e: React.MouseEvent, id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    set({ id, over: null })
    const onMove = (ev: MouseEvent): void => {
      const cur = ref.current
      if (!cur) return
      const els = Array.from(document.querySelectorAll(`[${indexAttr}]`)) as HTMLElement[]
      for (const el of els) {
        const r = el.getBoundingClientRect()
        const within =
          axis === 'x'
            ? ev.clientX >= r.left && ev.clientX <= r.right
            : ev.clientY >= r.top && ev.clientY <= r.bottom
        if (within) {
          set({ id: cur.id, over: Number(el.getAttribute(indexAttr)) })
          break
        }
      }
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const cur = ref.current
      if (cur && cur.over != null) onCommit(cur.id, cur.over)
      set(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  return { dragId: drag?.id ?? null, overIndex: drag?.over ?? null, start }
}

export default function TableWidget({ widget, inline = false }: Props): JSX.Element {
  const tables = useTablesStore((s) => s.tables)
  const rowsByTable = useTablesStore((s) => s.rows)
  const ensureTable = useTablesStore((s) => s.ensureTableLoaded)
  const ensureRows = useTablesStore((s) => s.ensureRowsLoaded)
  const createTable = useTablesStore((s) => s.createTable)
  const updateTable = useTablesStore((s) => s.updateTable)
  const setSchema = useTablesStore((s) => s.setSchema)
  const addRow = useTablesStore((s) => s.addRow)
  const updateCells = useTablesStore((s) => s.updateCells)
  const deleteRow = useTablesStore((s) => s.deleteRow)
  const reorderRows = useTablesStore((s) => s.reorderRows)
  const updateWidget = useWidgetStore((s) => s.update)

  const tableId = widget.content
  const table = tableId ? tables[tableId] : null
  const rows = tableId ? rowsByTable[tableId] ?? [] : []

  // Lazy creation: if the widget was just dropped on the canvas with no
  // backing table, we provision one with two starter columns so the user
  // sees something usable immediately.
  const provisionedRef = useRef(false)
  useEffect(() => {
    // Provision a fresh backing table and repoint the widget at it. Used both
    // for a brand-new table widget (no content) AND to SELF-HEAL a widget whose
    // content points at a table that doesn't exist — e.g. the AI emitted a
    // create-widget(table) with an invented id, which otherwise leaves the
    // widget stuck on "Loading table…" forever.
    const provision = async (): Promise<void> => {
      if (provisionedRef.current) return
      provisionedRef.current = true
      const created = await createTable({
        taskId: widget.taskId,
        title: widget.title || 'Untitled table',
        schema: {
          columns: [
            {
              id: 'c-name',
              type: 'text-short',
              label: 'Name',
              config: {} as never
            } as FieldDefinition,
            {
              id: 'c-done',
              type: 'checkbox',
              label: 'Done',
              config: {} as never
            } as FieldDefinition
          ]
        }
      })
      await updateWidget(widget.id, { content: created.id, title: widget.title || created.title })
    }

    if (tableId) {
      void ensureTable(tableId).then((t) => {
        if (t) void ensureRows(tableId)
        else void provision() // dangling id → heal into a real table
      })
      return
    }
    void provision()
  }, [tableId, ensureTable, ensureRows, createTable, updateWidget, widget.id, widget.taskId, widget.title])

  // ── In-table AI assistant state ─────────────────────────────────────────
  // These useState hooks MUST live above the `if (!table) return …` early
  // exit below. Hooks must be called in the same order every render — if
  // they sit below a conditional return, the first render (when `table` is
  // still null) calls fewer hooks than later renders, which throws "Rendered
  // more hooks than during the previous render" and blanks the app.
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  // File import wizard: the parsed grid (null = closed), the file label for the
  // header, and any pick/parse error to surface inline.
  const [importGrid, setImportGrid] = useState<ParsedGrid | null>(null)
  const [importFileLabel, setImportFileLabel] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  // Per-cell right-click "Create + connect" menu. The column label +
  // cell text are passed into the menu so the user-facing copy can
  // change ("Create new sticky from this cell" etc.). The spawn helper
  // (createConnectedTool) uses them as the new tool's seed content.
  const [cellCtxMenu, setCellCtxMenu] = useState<{
    x: number
    y: number
    columnLabel: string
    cellText: string
    rowId: string
  } | null>(null)
  const [aiCount, setAiCount] = useState(5)
  // When true, the AI is asked to generate as many rows as the prompt
  // naturally implies (no fixed N). The renderer signals this to the
  // backend by passing count=0 — main treats 0 as the "auto" sentinel.
  const [aiAutoCount, setAiAutoCount] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiStaged, setAiStaged] = useState<Array<Record<string, unknown>> | null>(null)
  // The AI may also propose new columns to fit the prompt. We surface
  // those FIRST as a separate decision — the user reviews + applies the
  // schema additions, THEN sees the row preview and decides about rows
  // independently. Two-step staging makes accidental wholesale apply less
  // likely and gives the user agency over what the AI changes.
  const [aiStagedColumns, setAiStagedColumns] = useState<Array<{
    label: string
    type: string
    options?: string[]
  }> | null>(null)
  // Tracks which staged columns the user has approved + applied. Once
  // applied we hide the column panel and reveal the row preview.
  const [columnsApplied, setColumnsApplied] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  // ── Table-view column manipulation state ────────────────────────────────
  // Right-click-on-header menu: anchor coords + which column it targets.
  const [headerMenu, setHeaderMenu] = useState<{
    x: number
    y: number
    columnId: string
    index: number
  } | null>(null)
  // Drag-to-reorder columns and rows via grip handles. The controller tracks
  // the dragged id + the index under the cursor so we can paint a drop marker.
  const colReorder = usePointerReorder('data-col-index', 'x', (id, target) => moveColumn(id, target))
  const rowReorder = usePointerReorder('data-row-index', 'y', (id, target) => moveRow(id, target))
  // Live resize override. While the user drags a column edge we hold the
  // in-flight width here so the render is smooth, then commit to the schema
  // (widthHint) on mouse-up. null when no resize is in progress.
  const [resize, setResize] = useState<{ columnId: string; width: number } | null>(null)
  // Cell-range selection for copy / bulk-paste (flat table view only). Indices
  // are into the filtered row list and the schema's columns.
  const [cellSel, setCellSel] = useState<{ a: RC; f: RC } | null>(null)
  const [selNote, setSelNote] = useState<string | null>(null)
  const selDrag = useRef(false)
  // The keyboard-focused cell (arrows / Tab / Enter navigate it). Distinct from
  // text editing: a cell is "active" first, and only enters edit when you type,
  // press Enter, or click into its input. bodyRef lets us pull focus back out of
  // a cell input so the arrow keys navigate instead of moving the text cursor.
  const [activeCell, setActiveCell] = useState<RC | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // End a cell-range drag on any mouseup. Declared here (above the early return)
  // so the hook order is stable whether or not the table has loaded yet.
  useEffect(() => {
    const up = (): void => {
      selDrag.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // The frame's rename now writes through to the table.
  //
  // Removing the inner title row removed the only way to rename a table: the
  // existing sync runs table -> widget, never the other way. Without this, the
  // header would accept a new name and the table would quietly keep the old
  // one -- an edit that appears to work and does not.
  useEffect(() => {
    if (!table) return
    const next = (widget.title ?? '').trim()
    if (!next || next === table.title) return
    // The header label carries the row count; strip it before comparing so a
    // row being added never looks like a rename.
    const bare = next.replace(/\s·\s\d+\s(row|rows)$/, '')
    if (!bare || bare === table.title) return
    renameTable(bare)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.title, table?.title])

  if (!table) {
    const body = (
      <div className="h-full w-full flex items-center justify-center text-[11px] text-[var(--ink-50)]">
        Loading table…
      </div>
    )
    if (inline) return body
    return (
      <WidgetFrame widget={widget} headerLabel="Table" headerAccent="bg-[var(--edge-firm)]">
        {body}
      </WidgetFrame>
    )
  }

  function addColumn(type: FieldType): void {
    addColumnAt(table!.schema.columns.length, type)
  }

  function removeColumn(columnId: string): void {
    const next: TableSchema = {
      ...table!.schema,
      columns: table!.schema.columns.filter((c) => c.id !== columnId)
    }
    void setSchema(table!.id, next)
  }

  function renameColumn(columnId: string, label: string): void {
    const next: TableSchema = {
      ...table!.schema,
      columns: table!.schema.columns.map((c) =>
        c.id === columnId ? ({ ...c, label } as FieldDefinition) : c
      )
    }
    void setSchema(table!.id, next)
  }

  function setColumnConfig(columnId: string, config: unknown): void {
    const next: TableSchema = {
      ...table!.schema,
      columns: table!.schema.columns.map((c) =>
        c.id === columnId ? ({ ...c, config } as FieldDefinition) : c
      )
    }
    void setSchema(table!.id, next)
  }

  // Change a column's field type. Resets its config to the new type's default
  // and coerces every existing cell value to the new shape (text↔number↔date
  // carry over; everything else starts clean) so the table never shows a value
  // the new type can't interpret. The column's label and width are preserved.
  function setColumnType(columnId: string, type: FieldType): void {
    const col = table!.schema.columns.find((c) => c.id === columnId)
    if (!col || col.type === type) return
    const next: TableSchema = {
      ...table!.schema,
      columns: table!.schema.columns.map((c) =>
        c.id === columnId
          ? ({ ...c, type, config: defaultConfig(type) } as FieldDefinition)
          : c
      )
    }
    void setSchema(table!.id, next)
    for (const r of rows) {
      if (!(columnId in r.cells)) continue
      const coerced = coerceFieldValue(col.type, type, r.cells[columnId])
      if (coerced !== r.cells[columnId]) void updateCells(r.id, { [columnId]: coerced })
    }
  }

  // Build a fresh column definition of the given type. Shared by the trailing
  // "+" adder and the insert-left / insert-right context-menu actions.
  function makeColumn(type: FieldType): FieldDefinition {
    const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    return {
      id,
      type,
      label: FIELD_TYPE_LABELS[type],
      config: defaultConfig(type) as never
    } as FieldDefinition
  }

  // Insert a new column at an explicit position. index === columns.length
  // appends (same as the trailing adder); index 0 prepends.
  function addColumnAt(index: number, type: FieldType): void {
    const cols = [...table!.schema.columns]
    const at = Math.max(0, Math.min(cols.length, index))
    cols.splice(at, 0, makeColumn(type))
    void setSchema(table!.id, { ...table!.schema, columns: cols })
  }

  // Reorder: pull the dragged column out and re-insert it so it lands before
  // the column that currently occupies targetIndex. The fromIdx < targetIndex
  // adjustment accounts for the array shrinking after the splice-out.
  function moveColumn(fromId: string, targetIndex: number): void {
    const cols = [...table!.schema.columns]
    const fromIdx = cols.findIndex((c) => c.id === fromId)
    if (fromIdx === -1) return
    const [moved] = cols.splice(fromIdx, 1)
    let insertAt = fromIdx < targetIndex ? targetIndex - 1 : targetIndex
    insertAt = Math.max(0, Math.min(cols.length, insertAt))
    if (insertAt === fromIdx) return // no-op drop onto itself
    cols.splice(insertAt, 0, moved)
    void setSchema(table!.id, { ...table!.schema, columns: cols })
  }

  // Reorder a row to land at targetIndex, mirroring moveColumn's geometry.
  // Persists the full id order via reorderRows. Only meaningful in the flat,
  // unfiltered table view (rowsReorderable below gates the grip handle), where
  // the rendered index maps directly onto the stored row order.
  function moveRow(fromId: string, targetIndex: number): void {
    const ids = rows.map((r) => r.id)
    const fromIdx = ids.indexOf(fromId)
    if (fromIdx === -1) return
    ids.splice(fromIdx, 1)
    let insertAt = fromIdx < targetIndex ? targetIndex - 1 : targetIndex
    insertAt = Math.max(0, Math.min(ids.length, insertAt))
    if (insertAt === fromIdx) return
    ids.splice(insertAt, 0, fromId)
    void reorderRows(table!.id, ids)
  }

  // Persist a resized width as the column's widthHint.
  function setColumnWidth(columnId: string, width: number): void {
    const w = Math.max(MIN_COL_WIDTH, Math.round(width))
    const next: TableSchema = {
      ...table!.schema,
      columns: table!.schema.columns.map((c) =>
        c.id === columnId ? ({ ...c, widthHint: w } as FieldDefinition) : c
      )
    }
    void setSchema(table!.id, next)
  }

  // The width a column should render at right now — the live drag value if it
  // is the one being resized, otherwise its stored hint or the default.
  function effectiveWidth(col: FieldDefinition): number {
    if (resize && resize.columnId === col.id) return resize.width
    return col.widthHint ?? DEFAULT_COL_WIDTH
  }

  // Begin an edge drag. Listeners live on the document so the pointer can
  // leave the 5px handle without dropping the gesture; mouse-up commits.
  function startResize(e: React.MouseEvent, col: FieldDefinition): void {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = effectiveWidth(col)
    const onMove = (ev: MouseEvent): void => {
      setResize({ columnId: col.id, width: Math.max(MIN_COL_WIDTH, startW + ev.clientX - startX) })
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setResize(null)
      setColumnWidth(col.id, Math.max(MIN_COL_WIDTH, startW + ev.clientX - startX))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function setViewMode(mode: TableViewMode): void {
    const next: TableSchema = { ...table!.schema, viewMode: mode }
    void setSchema(table!.id, next)
  }

  function setViewConfig(viewConfig: TableViewConfig): void {
    const next: TableSchema = { ...table!.schema, viewConfig }
    void setSchema(table!.id, next)
  }

  function commitCell(rowId: string, columnId: string, value: unknown): void {
    void updateCells(rowId, { [columnId]: value })
  }

  // Drop a PlexiOffice document onto a cell to reference it. Only cells in an
  // "Office file" (doc-ref) column accept the drop; the id is appended (single
  // -value columns replace). Priming the meta cache makes the chip render at
  // once. Non-doc-ref columns ignore the drop so ordinary drag behaviour is
  // unaffected.
  function onCellDocDrop(
    e: React.DragEvent,
    rowId: string,
    col: { id: string; type: string; config?: unknown }
  ): void {
    const payload = readDocDrag(e.dataTransfer)
    if (!payload || col.type !== 'doc-ref') return
    e.preventDefault()
    e.stopPropagation()
    primeDocMeta(payload.id, { title: payload.title, docType: payload.docType })
    const cfg = (col.config ?? {}) as { multi?: boolean }
    const current = Array.isArray(row0Cells(rowId)[col.id]) ? (row0Cells(rowId)[col.id] as string[]) : []
    if (current.includes(payload.id)) return
    const next = cfg.multi === false ? [payload.id] : [...current, payload.id]
    void updateCells(rowId, { [col.id]: next })
  }
  function row0Cells(rowId: string): Record<string, unknown> {
    return rows.find((r) => r.id === rowId)?.cells ?? {}
  }
  function cellAcceptsDoc(e: React.DragEvent, col: { type: string }): void {
    if (col.type === 'doc-ref' && e.dataTransfer.types.includes(DOC_DRAG_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function renameTable(title: string): void {
    void updateTable(table!.id, { title })
  }

  // Open the import wizard: pick a tabular file, read it into a grid, then show
  // the column-mapping dialog. CSV, JSON, XLS, and XLSX are supported.
  async function handleImport(): Promise<void> {
    setImportError(null)
    const path = await window.api.fileImport.pickGrid()
    if (!path) return
    const res = await window.api.fileImport.parseGrid(path)
    if (!res.ok) {
      setImportError(res.error)
      return
    }
    if (res.grid.headers.length === 0) {
      setImportError('No columns found in that file.')
      return
    }
    setImportFileLabel(path.split(/[\\/]/).pop() ?? 'file')
    setImportGrid(res.grid)
  }

  // ── In-table AI assistant handlers ──────────────────────────────────────
  // State for these lives above the `if (!table)` early return so the hook
  // call order stays constant. The handlers themselves use `table` which is
  // guaranteed non-null at this point because of the early-return guard.

  async function runAi(): Promise<void> {
    if (!aiPrompt.trim() || aiBusy || !table) return
    setAiBusy(true)
    setAiError(null)
    // Reset prior staging so a re-run can't conflate yesterday's columns
    // with today's rows.
    setAiStaged(null)
    setAiStagedColumns(null)
    setColumnsApplied(false)
    try {
      // count=0 signals the backend's "auto" mode.
      const requestedCount = aiAutoCount ? 0 : aiCount
      const resp = await window.api.ai.suggestTableRows(
        table.id,
        aiPrompt,
        requestedCount
      )
      if (!resp.ok) {
        setAiError(resp.error ?? 'AI request failed.')
        return
      }
      if (!resp.rows || resp.rows.length === 0) {
        setAiError('AI returned no rows.')
        return
      }
      setAiStaged(resp.rows)
      // Filter out columns whose label already exists in the current
      // schema (the AI sometimes echoes existing columns). This makes the
      // "add N columns" count match reality.
      const fresh = (resp.columnsToAdd ?? []).filter((c) => {
        const lc = c.label.toLowerCase().trim()
        return !table.schema.columns.some(
          (existing) => existing.label.toLowerCase().trim() === lc
        )
      })
      setAiStagedColumns(fresh.length > 0 ? fresh : null)
      // If no new columns are proposed we go straight to row staging.
      if (fresh.length === 0) setColumnsApplied(true)
    } finally {
      setAiBusy(false)
    }
  }

  function rejectAi(): void {
    setAiStaged(null)
    setAiStagedColumns(null)
    setColumnsApplied(false)
    setAiError(null)
  }

  // Phase 1 — user approves the schema additions. After this fires the
  // table actually gains the new columns and the row preview becomes the
  // active decision.
  async function applyColumns(): Promise<void> {
    if (!aiStagedColumns || !table) return
    const palette = [
      '#ef4444', '#f97316', '#eab308', '#22c55e',
      '#06b6d4', '#3b82f6', '#a855f7', '#ec4899'
    ]
    const newCols: FieldDefinition[] = aiStagedColumns.map((c) => {
      const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      let config: unknown = defaultConfig(c.type as FieldType) as never
      if (
        (c.type === 'single-select' || c.type === 'multi-select') &&
        Array.isArray(c.options)
      ) {
        config = {
          options: c.options.map((label, oi) => ({
            id: `o-${Date.now().toString(36)}-${oi}`,
            label,
            color: palette[oi % palette.length]
          }))
        }
      }
      return {
        id,
        type: c.type,
        label: c.label,
        config
      } as FieldDefinition
    })
    const nextSchema: TableSchema = {
      columns: [...table.schema.columns, ...newCols]
    }
    await setSchema(table.id, nextSchema)
    setColumnsApplied(true)
  }

  // Phase 2 — user approves the row preview. Inserts the rows using the
  // post-column-addition schema for coercion.
  async function applyRows(): Promise<void> {
    if (!aiStaged || !table) return
    const byKey = new Map<string, FieldDefinition>()
    for (const col of table.schema.columns) {
      byKey.set(col.id, col)
      byKey.set(col.label.toLowerCase().trim(), col)
    }
    let added = 0
    useActionHistory.getState().beginBatch()
    try {
      for (const aiRow of aiStaged) {
        const cells: Record<string, unknown> = {}
        for (const [key, raw] of Object.entries(aiRow)) {
          const col =
            byKey.get(key) ?? byKey.get(key.toLowerCase().trim()) ?? null
          if (!col) continue
          cells[col.id] = coerceCellValue(col.type, raw, col.config)
        }
        if (Object.keys(cells).length > 0) {
          await addRow(table.id, cells)
          added++
        }
      }
    } finally {
      useActionHistory.getState().endBatch(`Add ${added} row${added === 1 ? '' : 's'}`)
    }
    setAiStaged(null)
    setAiStagedColumns(null)
    setColumnsApplied(false)
    setAiPrompt('')
    setAiOpen(false)
  }

  const viewMode: TableViewMode = table.schema.viewMode ?? 'table'
  const viewConfig: TableViewConfig = table.schema.viewConfig ?? {}

  // Total table width = row-handle + every data column at its effective width
  // + the add-column gutter. Drives the fixed-layout table so resized columns
  // are honored exactly and the table scrolls horizontally when it overflows.
  const totalTableWidth =
    ROW_HANDLE_WIDTH +
    ADD_COL_WIDTH +
    table.schema.columns.reduce((sum, c) => sum + effectiveWidth(c), 0)

  // Rows after the active filter is applied — used by EVERY view so a filter
  // narrows the data everywhere, not just the table. Grouping is resolved
  // separately and only drives the table view's row layout.
  const filteredRows = applyFilters(rows, table.schema, viewConfig.filter)
  const groupColumn =
    viewConfig.group?.columnId
      ? table.schema.columns.find((c) => c.id === viewConfig.group?.columnId) ?? null
      : null
  const groups =
    groupColumn && viewMode === 'table'
      ? groupRows(filteredRows, groupColumn, viewConfig.group?.direction ?? 'asc')
      : null
  const collapsedGroups = new Set(viewConfig.group?.collapsed ?? [])

  function toggleGroupCollapsed(key: string): void {
    const current = viewConfig.group
    if (!current) return
    const collapsed = new Set(current.collapsed ?? [])
    if (collapsed.has(key)) collapsed.delete(key)
    else collapsed.add(key)
    setViewConfig({ ...viewConfig, group: { ...current, collapsed: Array.from(collapsed) } })
  }

  // ── Cell selection + copy / bulk paste (flat table view only) ─────────────
  const cols0 = table.schema.columns
  // Range selection geometry only makes sense in the flat table view; grouping
  // and the other view modes reorder/transform rows.
  const cellSelectable = !groups && viewMode === 'table'
  // Row drag-to-reorder is only coherent in the flat, ungrouped, unfiltered
  // table view — there the rendered order is the stored order, so a drop index
  // maps straight onto the persisted row sequence.
  const rowsReorderable =
    viewMode === 'table' && !groups && !(viewConfig.filter?.rules?.length)
  const selRange: RCRange | null = cellSel ? normCellRange(cellSel.a, cellSel.f) : null

  function onCellSelDown(r: number, c: number, shift: boolean): void {
    if (!cellSelectable) return
    if (shift && cellSel) setCellSel({ a: cellSel.a, f: { r, c } })
    else setCellSel({ a: { r, c }, f: { r, c } })
    setActiveCell({ r, c })
    selDrag.current = true
    setSelNote(null)
  }
  function onCellSelEnter(r: number, c: number): void {
    if (!cellSelectable || !selDrag.current || !cellSel) return
    // Only treat it as a range drag once the pointer leaves the anchor cell, so a
    // plain click still focuses the cell input for editing.
    if (cellSel.a.r === r && cellSel.a.c === c) return
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    setCellSel({ a: cellSel.a, f: { r, c } })
  }
  async function copySelection(): Promise<void> {
    if (!selRange) return
    await navigator.clipboard.writeText(cellsToTsv(filteredRows, cols0, selRange)).catch(() => {})
  }
  async function pasteSelection(): Promise<void> {
    if (!selRange) return
    const text = await navigator.clipboard.readText().catch(() => '')
    if (!text) return
    const { updates, clippedRows } = planTablePaste({
      rows: filteredRows,
      columns: cols0,
      range: selRange,
      matrix: parseTsv(text)
    })
    for (const u of updates) void updateCells(u.rowId, u.cells)
    setSelNote(
      clippedRows > 0
        ? `Pasted into ${updates.length} row${updates.length === 1 ? '' : 's'}; ${clippedRows} more didn't fit. Add rows first to paste the rest.`
        : null
    )
  }
  // Pull keyboard focus out of any cell input back to the table body, so the
  // arrow keys navigate cells instead of moving a text cursor.
  function focusBody(): void {
    bodyRef.current?.focus()
  }
  // Enter edit mode on a cell: focus its input/textarea and select its text.
  function editCell(r: number, c: number): void {
    const td = bodyRef.current?.querySelector(`[data-testid="table-cell-${r}-${c}"]`)
    const input = td?.querySelector('input, textarea, [contenteditable="true"]') as HTMLElement | null
    input?.focus()
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) input.select()
  }
  // Move the active cell by (dr, dc), wrapping horizontal overflow onto the next
  // or previous row (Tab behaviour). extend grows the selection from its anchor
  // instead of moving a single-cell selection.
  function moveActive(dr: number, dc: number, extend: boolean): void {
    const rowCount = filteredRows.length
    const colCount = cols0.length
    if (rowCount === 0 || colCount === 0) return
    const base = activeCell ?? cellSel?.f ?? { r: 0, c: 0 }
    let r = base.r + dr
    let c = base.c + dc
    if (c >= colCount) {
      c = 0
      r += 1
    } else if (c < 0) {
      c = colCount - 1
      r -= 1
    }
    r = Math.max(0, Math.min(rowCount - 1, r))
    c = Math.max(0, Math.min(colCount - 1, c))
    const target = { r, c }
    if (extend && cellSel) setCellSel({ a: cellSel.a, f: target })
    else setCellSel({ a: target, f: target })
    setActiveCell(target)
    focusBody()
  }
  function onTableKeyDown(e: React.KeyboardEvent): void {
    if (!cellSelectable) return
    // Use e.target (the element that received the keydown), not
    // document.activeElement: a cell input blurs itself synchronously on Enter
    // before this bubbles, so activeElement would already be the body and we'd
    // misread "editing" as "navigating". e.target is fixed at dispatch.
    const ae = e.target as Element
    const inEditor =
      (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) &&
      ae.closest('[data-testid^="table-cell-"]') != null

    if (e.key === 'Escape') {
      // First Escape leaves edit mode; a second clears the selection.
      if (inEditor) {
        focusBody()
        e.preventDefault()
      } else {
        setCellSel(null)
        setActiveCell(null)
      }
      return
    }

    // Enter: while editing, commit (blur via focusBody) and step down; while just
    // navigating, drop into edit on the active cell.
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      if (inEditor) moveActive(e.shiftKey ? -1 : 1, 0, false)
      else if (activeCell) editCell(activeCell.r, activeCell.c)
      else moveActive(0, 0, false)
      return
    }

    // Tab steps horizontally and wraps across rows; it always leaves edit mode.
    if (e.key === 'Tab') {
      e.preventDefault()
      moveActive(0, e.shiftKey ? -1 : 1, false)
      return
    }

    // Arrow keys navigate. While editing a text input they move the text cursor
    // instead (press Escape or Tab to leave the cell first). Shift extends the
    // range for copy.
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1]
    }
    if (e.key in arrows) {
      if (inEditor) return
      e.preventDefault()
      const [dr, dc] = arrows[e.key]
      moveActive(dr, dc, e.shiftKey)
      return
    }

    // Cmd/Ctrl + C / V over the selection.
    const mod = e.metaKey || e.ctrlKey
    if (!mod || !selRange) return
    const multi = selRange.r0 !== selRange.r1 || selRange.c0 !== selRange.c1
    if (inEditor && !multi) return // editing one cell — let the input copy/paste
    if (e.key.toLowerCase() === 'c') {
      e.preventDefault()
      void copySelection()
    } else if (e.key.toLowerCase() === 'v') {
      e.preventDefault()
      void pasteSelection()
    }
  }

  // One data <tr>. Extracted so the flat list and the grouped list render rows
  // identically. `idx` only drives the zebra stripe.
  function renderDataRow(row: FbRow, idx: number): JSX.Element {
    return (
      <tr
        key={row.id}
        data-row-index={idx}
        className={`border-b border-[var(--edge-soft)] group ${
          idx % 2 === 0
            ? 'bg-[var(--surface-raised)]'
            : 'bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]'
        } hover:bg-accent/[0.04] dark:hover:bg-accent/[0.08] ${
          rowReorder.dragId === row.id ? 'opacity-40' : ''
        } ${
          rowReorder.overIndex === idx && rowReorder.dragId !== null && rowReorder.dragId !== row.id
            ? 'border-t-2 border-t-accent'
            : ''
        }`}
      >
        <td className="w-8 px-0.5 py-1 border-r border-[var(--edge-soft)] align-middle">
          <div className="flex flex-col items-center gap-0.5">
            {rowsReorderable && (
              <span
                onMouseDown={(e) => rowReorder.start(e, row.id)}
                className="widget-nodrag text-[var(--ink-30)] hover:text-accent cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                title="Drag to reorder row"
              >
                <Icon name="drag_indicator" size={12} />
              </span>
            )}
            <button
              onClick={() => void deleteRow(row.id)}
              className="text-[var(--ink-30)] hover:text-rose-500 transition-colors"
              title="Delete row"
            >
              <Icon name="delete" size={13} />
            </button>
          </div>
        </td>
        {table!.schema.columns.map((col, ci) => (
          <td
            key={col.id}
            data-testid={`table-cell-${idx}-${ci}`}
            className={`border-r border-[var(--edge-soft)] align-top ${
              cellSelectable && inCellRange(selRange, idx, ci) ? 'bg-accent/[0.12]' : ''
            } ${
              cellSelectable && activeCell?.r === idx && activeCell?.c === ci
                ? 'ring-2 ring-inset ring-accent'
                : ''
            }`}
            style={{ minWidth: 140 }}
            onMouseDown={(e) => onCellSelDown(idx, ci, e.shiftKey)}
            onMouseEnter={() => onCellSelEnter(idx, ci)}
            onDragOver={(e) => cellAcceptsDoc(e, col)}
            onDrop={(e) => onCellDocDrop(e, row.id, col)}
            onContextMenu={(e) => {
              // Shift bypasses our menu and gives the OS clipboard menu.
              if (e.shiftKey) return
              e.preventDefault()
              const rawCell = row.cells[col.id]
              const cellStr =
                rawCell == null
                  ? ''
                  : typeof rawCell === 'string'
                    ? rawCell
                    : String(rawCell)
              setCellCtxMenu({
                x: e.clientX,
                y: e.clientY,
                columnLabel: col.label,
                cellText: cellStr,
                rowId: row.id
              })
            }}
          >
            <FieldEditor
              def={col}
              value={row.cells[col.id] ?? defaultValue(col.type)}
              variant="cell"
              onCommit={(next) => commitCell(row.id, col.id, next)}
            />
          </td>
        ))}
        <td className="border-r border-[var(--edge-soft)]" />
      </tr>
    )
  }

  const body = (
    <div
      ref={bodyRef}
      className="h-full w-full bg-[var(--surface-raised)] overflow-auto relative"
      data-testid="table-body"
      tabIndex={0}
      onKeyDown={onTableKeyDown}
    >
      {selNote && (
        <div
          className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-1.5 text-[12px]"
          data-testid="table-paste-note"
        >
          <span className="text-[var(--ink-70)]">{selNote}</span>
          <button onClick={() => setSelNote(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]">
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {/* The inner title row is GONE.
          It repeated the widget's own titlebar exactly -- same title, one row
          below it -- so a table carried two title bars and about 64px of
          chrome before any data. The title and the row count now live in the
          frame's header, and Import / AI in the frame's menu, where every
          other widget keeps its actions. */}
      {importError && (
        <div className="px-2.5 py-1 text-[11px] text-rose-500 bg-rose-500/10 border-b border-rose-500/10" data-testid="import-error">
          {importError}
        </div>
      )}
      {importGrid && table && (
        <TableImportDialog
          tableId={table.id}
          schema={table.schema}
          rows={rows.map((r) => ({ id: r.id, cells: r.cells }))}
          grid={importGrid}
          fileLabel={importFileLabel}
          onClose={() => setImportGrid(null)}
          onApplied={() => {
            setImportGrid(null)
          }}
        />
      )}
      {/* View switcher — pill of six view options. The active view is
          highlighted; clicking switches without losing data. Each non-
          table view uses TableSchema.viewConfig to remember which column
          drives its grouping (kanban lanes / calendar date / etc.). */}
      <div className="sticky top-[44px] z-[9] px-2.5 py-1.5 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] flex items-center gap-0.5 overflow-x-auto">
        {VIEW_OPTIONS.map((v) => {
          const active = v.id === viewMode
          return (
            <button
              key={v.id}
              onClick={() => setViewMode(v.id)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0 ${
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-[var(--ink-50)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
              }`}
              title={`Switch to ${v.label} view`}
              aria-pressed={active}
            >
              <Icon name={v.icon} size={12} />
              <span>{v.label}</span>
            </button>
          )
        })}
      </div>

      {/* Filter + group toolbar. Filtering applies to every view; grouping
          drives the table view's row layout. State lives in viewConfig so it
          persists with the schema. */}
      <TableFilterBar
        columns={table.schema.columns}
        viewConfig={viewConfig}
        setViewConfig={setViewConfig}
        filteredCount={filteredRows.length}
        totalCount={rows.length}
      />

      {/* Alternate views — each reads the same schema + rows and routes
          edits back through commitCell / addRow / deleteRow so the data
          contract is identical to the table view. The user can switch
          between any view without losing data. */}
      {viewMode !== 'table' && viewMode === 'list' && (
        <ListView
          schema={table.schema}
          rows={filteredRows}
          viewConfig={viewConfig}
          commitCell={commitCell}
          addRow={() => void addRow(table.id)}
          deleteRow={(id) => void deleteRow(id)}
          setViewConfig={setViewConfig}
        />
      )}
      {viewMode === 'cards' && (
        <CardsView
          schema={table.schema}
          rows={filteredRows}
          viewConfig={viewConfig}
          commitCell={commitCell}
          addRow={() => void addRow(table.id)}
          deleteRow={(id) => void deleteRow(id)}
          setViewConfig={setViewConfig}
        />
      )}
      {viewMode === 'kanban' && (
        <KanbanView
          schema={table.schema}
          rows={filteredRows}
          viewConfig={viewConfig}
          commitCell={commitCell}
          addRow={() => void addRow(table.id)}
          deleteRow={(id) => void deleteRow(id)}
          setViewConfig={setViewConfig}
        />
      )}
      {viewMode === 'calendar' && (
        <CalendarView
          schema={table.schema}
          rows={filteredRows}
          viewConfig={viewConfig}
          commitCell={commitCell}
          addRow={() => void addRow(table.id)}
          deleteRow={(id) => void deleteRow(id)}
          setViewConfig={setViewConfig}
        />
      )}
      {viewMode === 'gantt' && (
        <GanttView
          schema={table.schema}
          rows={filteredRows}
          viewConfig={viewConfig}
          commitCell={commitCell}
          addRow={() => void addRow(table.id)}
          deleteRow={(id) => void deleteRow(id)}
          setViewConfig={setViewConfig}
        />
      )}
      {viewMode === 'table' && (
      <div className="text-[12px]">
        <table
          className="border-collapse"
          style={{ tableLayout: 'fixed', width: totalTableWidth }}
        >
          <colgroup>
            <col style={{ width: ROW_HANDLE_WIDTH }} />
            {table.schema.columns.map((col) => (
              <col key={col.id} style={{ width: effectiveWidth(col) }} />
            ))}
            <col style={{ width: ADD_COL_WIDTH }} />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--edge-firm)] bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]">
              <th className="px-1 py-1.5" />
              {table.schema.columns.map((col, index) => (
                <ColumnHeader
                  key={col.id}
                  col={col}
                  index={index}
                  tableId={table.id}
                  isDragging={colReorder.dragId === col.id}
                  isDragOver={
                    colReorder.overIndex === index &&
                    colReorder.dragId !== null &&
                    colReorder.dragId !== col.id
                  }
                  onRename={(label) => renameColumn(col.id, label)}
                  onRemove={() => removeColumn(col.id)}
                  onSetConfig={(c) => setColumnConfig(col.id, c)}
                  onSetType={(t) => setColumnType(col.id, t)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setHeaderMenu({ x: e.clientX, y: e.clientY, columnId: col.id, index })
                  }}
                  onResizeStart={(e) => startResize(e, col)}
                  onReorderDown={(e) => colReorder.start(e, col.id)}
                />
              ))}
              <th className="px-1 py-1.5">
                <ColumnAdder onAdd={addColumn} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={table.schema.columns.length + 2}
                  className="py-8 text-center text-[12px] text-[var(--ink-40)]"
                >
                  <div className="flex flex-col items-center gap-1">
                    <Icon name="table_rows" size={20} className="text-[var(--ink-30)]" />
                    <span>No rows yet — click <strong className="text-[var(--ink-70)]">Add row</strong> below or use the <strong className="text-accent">AI</strong> button to generate some.</span>
                  </div>
                </td>
              </tr>
            )}
            {rows.length > 0 && filteredRows.length === 0 && (
              <tr>
                <td
                  colSpan={table.schema.columns.length + 2}
                  className="py-8 text-center text-[12px] text-[var(--ink-40)]"
                  data-testid="table-no-matches"
                >
                  <div className="flex flex-col items-center gap-1">
                    <Icon name="filter_list_off" size={20} className="text-[var(--ink-30)]" />
                    <span>No rows match the current filter.</span>
                  </div>
                </td>
              </tr>
            )}
            {/* Ungrouped: flat list of filtered rows. */}
            {!groups && filteredRows.map((row, idx) => renderDataRow(row, idx))}
            {/* Grouped: a collapsible header row per group, then its rows. */}
            {groups &&
              groups.map((g) => {
                const isCollapsed = collapsedGroups.has(g.key)
                return (
                  <GroupRows
                    key={g.key}
                    group={g}
                    collapsed={isCollapsed}
                    colSpan={table.schema.columns.length + 2}
                    onToggle={() => toggleGroupCollapsed(g.key)}
                    renderRow={renderDataRow}
                  />
                )
              })}
            {/* Add-row footer */}
            <tr>
              <td colSpan={table.schema.columns.length + 2} className="p-1.5 border-t border-[var(--edge-soft)]">
                <button
                  onClick={() => void addRow(table.id)}
                  className="w-full inline-flex items-center justify-center gap-1 text-[12px] py-1.5 rounded text-[var(--ink-50)] hover:text-accent hover:bg-accent/5 transition-colors"
                >
                  <Icon name="add" size={14} />
                  <span>Add row</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      )}

      {aiOpen && (
        <div className="absolute bottom-2 left-2 right-2 z-50 rounded-lg border border-accent bg-[var(--surface-raised)] shadow-xl p-3 max-h-[70%] flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Icon name="auto_awesome" size={13} className="text-accent" />
            <span className="text-[10px] uppercase tracking-wider font-semibold text-accent">
              AI assistant — generate rows
            </span>
            <button
              onClick={() => {
                setAiOpen(false)
                rejectAi()
              }}
              className="ml-auto h-5 w-5 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:bg-[var(--surface-sunken)]"
              aria-label="Close"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <MentionTextarea
            autoFocus
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void runAi()
              }
            }}
            placeholder='e.g. "Add 5 fictional podcast episodes about climate tech"'
            rows={2}
            className="fb-field w-full text-[13px] px-2.5 py-1.5 resize-none text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
          />
          <div className="flex items-center gap-2 text-[11px] flex-wrap">
            <label className="text-[var(--ink-50)]">Rows:</label>
            <label className="inline-flex items-center gap-1 cursor-pointer text-[var(--ink-70)]">
              <input
                type="checkbox"
                checked={aiAutoCount}
                onChange={(e) => setAiAutoCount(e.target.checked)}
                className="accent-accent"
              />
              <span>As many as needed</span>
            </label>
            {!aiAutoCount && (
              <>
                <span className="text-[var(--ink-30)]">·</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={aiCount}
                  onChange={(e) =>
                    setAiCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))
                  }
                  className="fb-field w-14 px-2 py-0.5 text-[var(--ink-90)]"
                />
                <span className="text-[var(--ink-40)]">fixed</span>
              </>
            )}
          </div>
          {aiError && (
            <div className="text-[11px] text-amber-700 dark:text-amber-400">
              {aiError}
            </div>
          )}
          {/* STAGE 1 — column staging. Visible until the user either
              applies the new columns OR runAi returned no proposed columns
              (columnsApplied auto-set true). Includes its own Apply/Skip
              buttons so the schema decision is explicit and separate from
              the row decision. */}
          {aiStagedColumns && aiStagedColumns.length > 0 && !columnsApplied && (
            <div className="rounded-md border-2 border-accent bg-accent/[0.06] p-2 space-y-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-accent text-white text-[10px] font-bold">1</span>
                <div className="text-[11px] uppercase tracking-wider text-accent font-semibold">
                  Step 1 — Approve {aiStagedColumns.length} new {aiStagedColumns.length === 1 ? 'column' : 'columns'}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {aiStagedColumns.map((c, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--surface-raised)] border border-accent/40 text-[11px] text-[var(--ink-70)]"
                    title={
                      c.options && c.options.length > 0
                        ? `Options: ${c.options.join(', ')}`
                        : c.type
                    }
                  >
                    <Icon name="view_column" size={11} className="text-accent" />
                    <strong className="text-[var(--ink-90)]">{c.label}</strong>
                    <span className="text-[var(--ink-40)]">{c.type}</span>
                  </span>
                ))}
              </div>
              <div className="text-[10px] text-[var(--ink-50)]">
                Adding these will update your table's schema. Rows preview unlocks once you decide.
              </div>
              <div className="flex justify-end gap-1.5">
                <button
                  onClick={() => {
                    // Skip column additions and proceed straight to row
                    // preview. We don't drop them from aiStagedColumns
                    // entirely (so the user can still see "AI suggested")
                    // but mark columnsApplied so the UI moves on.
                    setAiStagedColumns(null)
                    setColumnsApplied(true)
                  }}
                  className="text-[11px] px-3 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                >
                  Skip
                </button>
                <button
                  onClick={() => void applyColumns()}
                  className="text-[11px] px-3 py-1 rounded bg-accent text-white hover:brightness-110 inline-flex items-center gap-1"
                >
                  <Icon name="check" size={11} />
                  Add {aiStagedColumns.length} {aiStagedColumns.length === 1 ? 'column' : 'columns'}
                </button>
              </div>
            </div>
          )}
          {/* STAGE 2 — row preview. Only renders once the schema decision
              is locked in (either applied columns or explicitly skipped),
              so the user is making one decision at a time. */}
          {aiStaged && aiStaged.length > 0 && columnsApplied && (
            <div className="flex-1 min-h-0 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-accent text-white text-[10px] font-bold">2</span>
                <div className="text-[11px] uppercase tracking-wider text-accent font-semibold">
                  Step 2 — Approve {aiStaged.length} {aiStaged.length === 1 ? 'row' : 'rows'}
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-auto bg-[var(--surface-sunken)] rounded-md">
                <table className="w-full text-[11px]">
                  <thead className="bg-[var(--surface-sunken)] sticky top-0">
                    <tr>
                      {table.schema.columns.map((col) => (
                        <th
                          key={col.id}
                          className="text-left px-2 py-1 font-medium text-[var(--ink-70)] border-r border-[var(--edge-soft)]"
                        >
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {aiStaged.map((row, i) => (
                      <tr
                        key={i}
                        className="border-b border-[var(--edge-soft)]"
                      >
                        {table.schema.columns.map((col) => {
                          const v =
                            row[col.label] ??
                            row[col.label.toLowerCase().trim()] ??
                            row[col.id] ??
                            ''
                          const display = Array.isArray(v)
                            ? v.join(', ')
                            : typeof v === 'boolean'
                              ? v ? '✓' : ''
                              : String(v ?? '')
                          return (
                            <td
                              key={col.id}
                              className="px-2 py-1 text-[var(--ink-70)] border-r border-[var(--edge-soft)] align-top max-w-[200px] truncate"
                              title={display}
                            >
                              {display || <span className="text-[var(--ink-30)]">—</span>}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-1.5">
            {aiStaged && columnsApplied ? (
              <>
                <button
                  onClick={rejectAi}
                  className="text-[11px] px-3 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                >
                  Discard
                </button>
                <button
                  onClick={() => void runAi()}
                  disabled={!aiPrompt.trim() || aiBusy}
                  className="fb-btn-surface text-[11px] px-3 py-1 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                >
                  {aiBusy ? 'Regenerating…' : 'Regenerate'}
                </button>
                <button
                  onClick={() => void applyRows()}
                  className="text-[11px] px-3 py-1 rounded bg-accent text-white hover:brightness-110 inline-flex items-center gap-1"
                >
                  <Icon name="check" size={11} />
                  Add {aiStaged.length} {aiStaged.length === 1 ? 'row' : 'rows'}
                </button>
              </>
            ) : (
              <button
                onClick={() => void runAi()}
                disabled={!aiPrompt.trim() || aiBusy}
                className="text-[11px] px-3 py-1 rounded bg-accent text-white hover:brightness-110 disabled:opacity-50 inline-flex items-center gap-1"
              >
                {aiBusy ? (
                  <>
                    <Icon name="autorenew" size={11} className="animate-spin" />
                    Drafting…
                  </>
                ) : (
                  <>
                    <Icon name="auto_awesome" size={11} />
                    Draft
                  </>
                )}
              </button>
            )}
          </div>
          <div className="text-[9px] text-[var(--ink-40)]">
            Cmd+Enter to draft · rows are previewed before they touch the table
          </div>
        </div>
      )}
      {cellCtxMenu && (
        // The cell right-click now resolves through the unified menu. The cell
        // text becomes the selection (so AI Assist and Create both work on it),
        // and the cell/row granularity lets the table provider offer row
        // actions. This retires the bespoke per-cell create list.
        <UnifiedConnectedMenu
          sourceWidgetId={widget.id}
          x={cellCtxMenu.x}
          y={cellCtxMenu.y}
          selectionContext={{ selectionText: cellCtxMenu.cellText }}
          granularity="cell"
          payload={{
            rowId: cellCtxMenu.rowId,
            columnLabel: cellCtxMenu.columnLabel,
            tableId: tableId ?? ''
          }}
          onClose={() => setCellCtxMenu(null)}
        />
      )}
      {headerMenu && (
        <HeaderContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          canDelete={table.schema.columns.length > 1}
          onInsert={(side, type) => {
            addColumnAt(side === 'left' ? headerMenu.index : headerMenu.index + 1, type)
            setHeaderMenu(null)
          }}
          onDelete={() => {
            removeColumn(headerMenu.columnId)
            setHeaderMenu(null)
          }}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </div>
  )

  if (inline) return body
  return (
    <WidgetFrame
      widget={widget}
      // The count rides in the one title bar rather than earning a second.
      headerLabel={`${table.title || 'Untitled table'} · ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
      headerAccent="bg-[var(--edge-firm)]"
      headerMenuExtras={[
        {
          label: 'Import CSV, JSON or Excel…',
          icon: 'upload_file',
          onClick: () => void handleImport()
        },
        {
          label: aiOpen ? 'Hide the AI assistant' : 'Generate rows with AI…',
          icon: 'auto_awesome',
          onClick: () => setAiOpen((v) => !v)
        },
        { separator: true }
      ]}
    >
      {body}
    </WidgetFrame>
  )
}

// ── Grouped rows — a collapsible header row plus its data rows ────────────────
function GroupRows({
  group,
  collapsed,
  colSpan,
  onToggle,
  renderRow
}: {
  group: RowGroup
  collapsed: boolean
  colSpan: number
  onToggle: () => void
  renderRow: (row: FbRow, idx: number) => JSX.Element
}): JSX.Element {
  return (
    <>
      <tr className="bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)] border-b border-[var(--edge-firm)]">
        <td colSpan={colSpan} className="px-2 py-1.5">
          <button
            onClick={onToggle}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--ink-70)] hover:text-accent"
          >
            <Icon
              name={collapsed ? 'chevron_right' : 'expand_more'}
              size={15}
              className="text-[var(--ink-40)]"
            />
            {group.color && (
              <span
                className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: group.color }}
              />
            )}
            <span className="truncate max-w-[280px]">{group.label}</span>
            <span className="text-[var(--ink-40)] font-normal tabular-nums">
              {group.rows.length}
            </span>
          </button>
        </td>
      </tr>
      {!collapsed && group.rows.map((row, idx) => renderRow(row, idx))}
    </>
  )
}

// ── Column header with rename + config + delete popover ──────────────────────
// Also the anchor for the three column-manipulation gestures: the title button
// is draggable to reorder columns, a right-edge handle resizes the column, and
// right-clicking opens the insert/delete context menu (onContextMenu).
function ColumnHeader({
  col,
  index,
  tableId,
  isDragging,
  isDragOver,
  onRename,
  onRemove,
  onSetConfig,
  onSetType,
  onContextMenu,
  onResizeStart,
  onReorderDown
}: {
  col: FieldDefinition
  index: number
  tableId: string
  isDragging: boolean
  isDragOver: boolean
  onRename: (label: string) => void
  onRemove: () => void
  onSetConfig: (config: unknown) => void
  onSetType: (type: FieldType) => void
  onContextMenu: (e: React.MouseEvent) => void
  onResizeStart: (e: React.MouseEvent) => void
  onReorderDown: (e: React.MouseEvent) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLTableCellElement | null>(null)
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <th
      ref={ref}
      data-col-index={index}
      onContextMenu={onContextMenu}
      className={`text-left px-2 py-1 font-medium text-[11px] text-[var(--ink-70)] relative ${
        isDragging ? 'opacity-40' : ''
      } ${isDragOver ? 'border-l-2 border-l-accent' : ''}`}
    >
      <div className="flex items-center gap-0.5">
        {/* Grip — press and drag to reorder this column. widget-nodrag stops the
            same gesture from moving the table widget on the canvas. */}
        <span
          onMouseDown={onReorderDown}
          className="widget-nodrag shrink-0 text-[var(--ink-30)] hover:text-accent cursor-grab active:cursor-grabbing"
          title="Drag to reorder column"
        >
          <Icon name="drag_indicator" size={12} />
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 hover:bg-[var(--surface-sunken)] rounded px-1 py-0.5 flex-1 min-w-0 text-left"
          title="Click to edit · right-click for more"
        >
          <Icon name={FIELD_TYPE_ICONS[col.type]} size={11} className="text-[var(--ink-40)] shrink-0" />
          <span className="truncate">{col.label}</span>
        </button>
      </div>
      {/* Resize handle — a thin grab strip on the right edge. Uses raw mouse
          events (not HTML5 drag) so it never starts a column-reorder. */}
      <div
        onMouseDown={onResizeStart}
        onClick={(e) => e.stopPropagation()}
        className="absolute top-0 right-0 h-full w-[5px] cursor-col-resize hover:bg-accent/40 z-10"
        title="Drag to resize column"
      />
      {open && (
        <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-50 mt-1 left-0 w-56 p-2 space-y-1.5 text-[var(--ink-70)] font-normal">
          <input
            value={col.label}
            onChange={(e) => onRename(e.target.value)}
            placeholder="Column name"
            className="fb-field w-full text-[11px] px-2 py-1 text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
          />
          <div className="text-[10px] uppercase tracking-wider text-[var(--ink-40)]">
            Type
          </div>
          <select
            value={col.type}
            onChange={(e) => onSetType(e.target.value as FieldType)}
            className="fb-field w-full text-[11px] px-2 py-1 text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
            title="Change this column's field type"
          >
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {(col.type === 'single-select' || col.type === 'multi-select') && (
            <SelectOptionsMini
              options={
                (col.config as { options: { id: string; label: string; color?: string }[] })
                  .options ?? []
              }
              onChange={(options) =>
                onSetConfig({ ...col.config, options })
              }
            />
          )}
          {col.type === 'relation' && (
            <RelationConfigEditor
              config={col.config as {
                tableId: string | null
                displayColumnId?: string | null
                multi?: boolean
              }}
              excludeTableId={tableId}
              onChange={(c) => onSetConfig(c)}
            />
          )}
          <button
            onClick={() => {
              onRemove()
              setOpen(false)
            }}
            className="w-full text-[11px] text-rose-500 hover:bg-rose-500/10 rounded px-2 py-1 text-left"
          >
            <Icon name="delete" size={11} className="inline mr-1" />
            Delete column
          </button>
        </div>
      )}
    </th>
  )
}

function SelectOptionsMini({
  options,
  onChange
}: {
  options: { id: string; label: string; color?: string }[]
  onChange: (next: { id: string; label: string; color?: string }[]) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const palette = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899']
  function add(): void {
    const label = draft.trim()
    if (!label) return
    const id = `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    onChange([
      ...options,
      { id, label, color: palette[options.length % palette.length] }
    ])
    setDraft('')
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-[var(--ink-40)]">Options</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <span
            key={o.id}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
            style={{ backgroundColor: `${o.color ?? '#78716c'}26`, color: o.color ?? '#78716c' }}
          >
            {o.label}
            <button
              onClick={() => onChange(options.filter((x) => x.id !== o.id))}
              className="opacity-60 hover:opacity-100"
            >
              <Icon name="close" size={9} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder="New option…"
          className="fb-field flex-1 text-[10px] px-1.5 py-0.5 text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-white disabled:opacity-50"
        >
          add
        </button>
      </div>
    </div>
  )
}

// ── Column-add menu ─────────────────────────────────────────────────────────
function ColumnAdder({ onAdd }: { onAdd: (t: FieldType) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-[var(--edge-soft)] text-[var(--ink-50)]"
        title="Add column"
      >
        <Icon name="add" size={12} />
      </button>
      {open && (
        <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 z-50 mt-1 w-44 py-1">
          {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                onAdd(t)
                setOpen(false)
              }}
              className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-[var(--surface-sunken)] text-left font-normal text-[var(--ink-70)]"
            >
              <Icon name={FIELD_TYPE_ICONS[t]} size={11} className="text-[var(--ink-40)]" />
              <span className="text-[11px]">{FIELD_TYPE_LABELS[t]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Header right-click menu — insert left / right + delete ───────────────────
// A two-level menu: the main view offers insert-left, insert-right and delete;
// choosing an insert side switches to a field-type picker so the user picks the
// new column's type at creation time (column type can't be changed afterwards).
function HeaderContextMenu({
  x,
  y,
  canDelete,
  onInsert,
  onDelete,
  onClose
}: {
  x: number
  y: number
  canDelete: boolean
  onInsert: (side: 'left' | 'right', type: FieldType) => void
  onDelete: () => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [mode, setMode] = useState<'main' | 'left' | 'right'>('main')
  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  // Keep the menu on-screen by clamping its top-left away from the viewport
  // edges. Width is fixed at 208px (w-52).
  const left = Math.min(x, window.innerWidth - 216)
  const top = Math.min(y, window.innerHeight - 320)
  return (
    <div
      ref={ref}
      className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in fixed z-[100] w-52 py-1 text-[var(--ink-70)]"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {mode === 'main' ? (
        <>
          <button
            onClick={() => setMode('left')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-[var(--surface-sunken)] text-left"
          >
            <Icon name="keyboard_tab_rtl" size={13} className="text-[var(--ink-40)]" />
            <span className="flex-1">Insert column left</span>
            <Icon name="chevron_right" size={13} className="text-[var(--ink-40)]" />
          </button>
          <button
            onClick={() => setMode('right')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-[var(--surface-sunken)] text-left"
          >
            <Icon name="keyboard_tab" size={13} className="text-[var(--ink-40)]" />
            <span className="flex-1">Insert column right</span>
            <Icon name="chevron_right" size={13} className="text-[var(--ink-40)]" />
          </button>
          <div className="my-1 border-t border-[var(--edge-soft)]" />
          <button
            onClick={onDelete}
            disabled={!canDelete}
            title={canDelete ? undefined : 'A table needs at least one column'}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-rose-500 hover:bg-rose-500/10 text-left disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Icon name="delete" size={13} />
            <span>Delete column</span>
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => setMode('main')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] uppercase tracking-wider text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] text-left"
          >
            <Icon name="chevron_left" size={13} />
            <span>Insert {mode === 'left' ? 'left' : 'right'} — pick type</span>
          </button>
          <div className="border-t border-[var(--edge-soft)] max-h-64 overflow-auto">
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
              <button
                key={t}
                onClick={() => onInsert(mode === 'left' ? 'left' : 'right', t)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-[var(--surface-sunken)] text-left font-normal"
              >
                <Icon name={FIELD_TYPE_ICONS[t]} size={12} className="text-[var(--ink-40)]" />
                <span>{FIELD_TYPE_LABELS[t]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
