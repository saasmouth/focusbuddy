import { useMemo, useState } from 'react'
import type {
  FbRow,
  FieldDefinition,
  TableSchema,
  TableViewConfig
} from '@shared/fields'
import FieldEditor from '../fields/FieldEditor'
import { ATTACHMENT_DROP_OVER_CLASS, AttachmentDropZone } from '../fields/AttachmentDrop'
import { defaultValue } from '@shared/fields'
import Icon from '../Icon'

// Alternate views for the Table widget. The table view itself remains in
// TableWidget.tsx (it's deeply intertwined with the existing AI assistant
// + column-add logic). These views read the same schema + rows and route
// edits back through the same callbacks — they're presentation layers
// over the same data.
//
// Each view is built around a sensible auto-pick for its required column
// (date / select / two-dates) so the user can switch without any setup,
// then optionally pin a different column in the per-view config bar.

interface ViewProps {
  schema: TableSchema
  rows: FbRow[]
  viewConfig: TableViewConfig
  // Commits one cell change. Mirrors TableWidget's existing commitCell.
  commitCell: (rowId: string, columnId: string, value: unknown) => void
  // Adds a new empty row. Mirrors TableWidget's addRow(tableId).
  addRow: () => void
  // Deletes a row by id.
  deleteRow: (rowId: string) => void
  // Updates the view config (the per-view config bar uses this to repin
  // which column drives kanban lanes / calendar dates / etc.).
  setViewConfig: (next: TableViewConfig) => void
  // A cell's value as stored NOW (TableWidget reads its store). A picture
  // dropped on an attachment field appends to this when its fetch lands, not to
  // the value it was rendered with.
  readCell?: (rowId: string, columnId: string) => unknown
}

/**
 * One field's block (its label and its editor). An attachment field's block is
 * a drop zone as a whole: a picture dragged in from a browser, or a file from
 * Finder, dropped anywhere on it is attached to this record.
 */
function FieldBlock({
  col,
  row,
  commitCell,
  readCell,
  className,
  children
}: {
  col: FieldDefinition
  row: FbRow
  commitCell: ViewProps['commitCell']
  readCell?: ViewProps['readCell']
  className: string
  children: React.ReactNode
}): JSX.Element {
  if (col.type !== 'attachment') return <div className={className}>{children}</div>
  return (
    <AttachmentDropZone
      current={() => (readCell ? readCell(row.id, col.id) : row.cells[col.id])}
      commit={(next) => commitCell(row.id, col.id, next)}
    >
      {(drop) => (
        <div
          {...drop.handlers}
          data-attachment-drop={drop.over ? 'over' : 'idle'}
          className={`${className} rounded ${drop.over ? ATTACHMENT_DROP_OVER_CLASS : ''}`}
        >
          {children}
        </div>
      )}
    </AttachmentDropZone>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Column-pick helpers — each view auto-picks the first column of the
// right type if the user hasn't pinned one explicitly. This keeps the
// view useful with zero config; pinning happens only when the user wants
// to choose a different column.

function pickTitleColumn(
  schema: TableSchema,
  viewConfig: TableViewConfig
): FieldDefinition | null {
  if (viewConfig.titleColumnId) {
    const c = schema.columns.find((c) => c.id === viewConfig.titleColumnId)
    if (c) return c
  }
  return (
    schema.columns.find((c) => c.type === 'text-short') ||
    schema.columns[0] ||
    null
  )
}

function pickSelectColumn(
  schema: TableSchema,
  viewConfig: TableViewConfig
): FieldDefinition | null {
  if (viewConfig.kanbanColumnId) {
    const c = schema.columns.find((c) => c.id === viewConfig.kanbanColumnId)
    if (c && c.type === 'single-select') return c
  }
  return schema.columns.find((c) => c.type === 'single-select') || null
}

function pickDateColumn(
  schema: TableSchema,
  viewConfig: TableViewConfig
): FieldDefinition | null {
  if (viewConfig.calendarColumnId) {
    const c = schema.columns.find((c) => c.id === viewConfig.calendarColumnId)
    if (c && c.type === 'date') return c
  }
  return schema.columns.find((c) => c.type === 'date') || null
}

function pickStartEndDateColumns(
  schema: TableSchema,
  viewConfig: TableViewConfig
): { start: FieldDefinition | null; end: FieldDefinition | null } {
  const dateCols = schema.columns.filter((c) => c.type === 'date')
  const startId = viewConfig.ganttStartColumnId
  const endId = viewConfig.ganttEndColumnId
  const start =
    (startId ? dateCols.find((c) => c.id === startId) : null) || dateCols[0] || null
  const end =
    (endId ? dateCols.find((c) => c.id === endId) : null) || dateCols[1] || null
  return { start, end }
}

function getCellNumber(row: FbRow, col: FieldDefinition | null): number | null {
  if (!col) return null
  const v = row.cells[col.id]
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  return null
}

function getCellString(row: FbRow, col: FieldDefinition | null): string {
  if (!col) return ''
  const v = row.cells[col.id]
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

// ────────────────────────────────────────────────────────────────────────
// LIST VIEW — flat one-row-per-line layout, primary column as the heading,
// other columns inline as compact key:value pairs underneath. Good for
// scrolling lots of rows without horizontal scroll fatigue.

export function ListView({
  schema,
  rows,
  viewConfig,
  commitCell,
  addRow,
  deleteRow,
  readCell
}: ViewProps): JSX.Element {
  const titleCol = pickTitleColumn(schema, viewConfig)
  const detailCols = schema.columns.filter((c) => c.id !== titleCol?.id)

  return (
    <div className="px-3 py-2 space-y-1.5">
      {rows.length === 0 && <EmptyState onAdd={addRow} />}
      {rows.map((row) => (
        <div
          key={row.id}
          className="group fb-tile px-3 py-2"
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {titleCol && (
                <FieldEditor
                  def={titleCol}
                  value={row.cells[titleCol.id] ?? defaultValue(titleCol.type)}
                  variant="cell"
                  onCommit={(v) => commitCell(row.id, titleCol.id, v)}
                />
              )}
              {detailCols.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-2.5">
                  {detailCols.map((c) => (
                    <FieldBlock
                      key={c.id}
                      col={c}
                      row={row}
                      commitCell={commitCell}
                      readCell={readCell}
                      className="inline-flex items-center gap-1 text-[11px] min-w-0"
                    >
                      <span className="text-[var(--ink-40)] uppercase tracking-wider">
                        {c.label}
                      </span>
                      <div className="max-w-[220px]">
                        <FieldEditor
                          def={c}
                          value={row.cells[c.id] ?? defaultValue(c.type)}
                          variant="cell"
                          onCommit={(v) => commitCell(row.id, c.id, v)}
                        />
                      </div>
                    </FieldBlock>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => deleteRow(row.id)}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-40)] hover:text-red-500 transition-opacity"
              title="Delete row"
              aria-label="Delete row"
            >
              <Icon name="delete" size={14} />
            </button>
          </div>
        </div>
      ))}
      <AddRowFooter onAdd={addRow} />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// CARDS VIEW — gallery of card tiles, each row is a card. Title column
// becomes the card heading; the rest are stacked field rows inside the
// card. Good for visual-first datasets.

export function CardsView({
  schema,
  rows,
  viewConfig,
  commitCell,
  addRow,
  deleteRow,
  readCell
}: ViewProps): JSX.Element {
  const titleCol = pickTitleColumn(schema, viewConfig)
  const detailCols = schema.columns.filter((c) => c.id !== titleCol?.id)

  return (
    <div className="px-3 py-2">
      {rows.length === 0 && <EmptyState onAdd={addRow} />}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className="group fb-tile p-3 flex flex-col gap-1.5"
          >
            {titleCol && (
              <div className="text-[13px] font-medium text-[var(--ink-90)]">
                <FieldEditor
                  def={titleCol}
                  value={row.cells[titleCol.id] ?? defaultValue(titleCol.type)}
                  variant="cell"
                  onCommit={(v) => commitCell(row.id, titleCol.id, v)}
                />
              </div>
            )}
            {detailCols.map((c) => (
              <FieldBlock
                key={c.id}
                col={c}
                row={row}
                commitCell={commitCell}
                readCell={readCell}
                className="flex flex-col gap-0.5"
              >
                <span className="text-[9px] uppercase tracking-wider text-[var(--ink-40)]">
                  {c.label}
                </span>
                <FieldEditor
                  def={c}
                  value={row.cells[c.id] ?? defaultValue(c.type)}
                  variant="cell"
                  onCommit={(v) => commitCell(row.id, c.id, v)}
                />
              </FieldBlock>
            ))}
            <button
              onClick={() => deleteRow(row.id)}
              className="self-end mt-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-40)] hover:text-red-500 transition-opacity"
              title="Delete row"
              aria-label="Delete row"
            >
              <Icon name="delete" size={12} />
            </button>
          </div>
        ))}
        <button
          onClick={addRow}
          className="rounded-lg border-2 border-dashed border-[var(--edge-firm)] hover:border-accent text-[var(--ink-40)] hover:text-accent flex items-center justify-center min-h-[110px] transition-colors"
        >
          <Icon name="add" size={20} />
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// KANBAN VIEW — lanes grouped by a single-select column's options. Each
// row is a draggable-looking card in its lane. Drag-to-reassign uses
// HTML5 drag + commitCell; if no single-select column exists, the user
// sees a configure hint.

export function KanbanView({
  schema,
  rows,
  viewConfig,
  commitCell,
  addRow,
  deleteRow,
  setViewConfig
}: ViewProps): JSX.Element {
  const selectCols = schema.columns.filter((c) => c.type === 'single-select')
  const groupCol = pickSelectColumn(schema, viewConfig)
  const titleCol = pickTitleColumn(schema, viewConfig)

  if (!groupCol) {
    return (
      <ConfigureHint
        icon="view_kanban"
        title="Kanban needs a single-select column"
        body="Add a single-select column (e.g. Status) to use the kanban view. Each option becomes a lane; rows become draggable cards."
        onAdd={addRow}
      />
    )
  }

  // Lanes are the column's options + an implicit "Unassigned" lane for
  // rows with no value.
  const options =
    (groupCol.config as { options?: Array<{ id: string; label: string; color?: string }> })
      .options ?? []
  const laneIds = ['__unassigned', ...options.map((o) => o.id)]
  const lanesById = new Map(
    options.map((o) => [o.id, o] as const)
  )

  const byLane = new Map<string, FbRow[]>()
  for (const id of laneIds) byLane.set(id, [])
  for (const row of rows) {
    const v = row.cells[groupCol.id]
    if (typeof v === 'string' && byLane.has(v)) byLane.get(v)!.push(row)
    else byLane.get('__unassigned')!.push(row)
  }

  return (
    <div className="px-3 py-2">
      {/* Per-view config bar: which column drives the lanes */}
      {selectCols.length > 1 && (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--ink-50)]">
          <span>Lanes:</span>
          <select
            value={groupCol.id}
            onChange={(e) =>
              setViewConfig({ ...viewConfig, kanbanColumnId: e.target.value })
            }
            className="fb-field px-1.5 py-0.5 text-[var(--ink-70)]"
          >
            {selectCols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {laneIds.map((laneId) => {
          const opt = lanesById.get(laneId)
          const laneRows = byLane.get(laneId) ?? []
          const label = laneId === '__unassigned' ? 'Unassigned' : opt?.label ?? laneId
          const accent = opt?.color ?? '#78716c'
          return (
            <div
              key={laneId}
              className="shrink-0 w-[240px] rounded-md bg-[var(--surface-sunken)] flex flex-col"
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('text/fb-row-id')) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }
              }}
              onDrop={(e) => {
                const rowId = e.dataTransfer.getData('text/fb-row-id')
                if (!rowId) return
                e.preventDefault()
                commitCell(
                  rowId,
                  groupCol.id,
                  laneId === '__unassigned' ? null : laneId
                )
              }}
            >
              <div className="px-2.5 py-1.5 border-b border-[var(--edge-soft)] flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: accent }}
                />
                <span className="text-[11px] font-medium text-[var(--ink-70)] truncate flex-1 min-w-0">
                  {label}
                </span>
                <span className="text-[10px] text-[var(--ink-40)] font-mono">
                  {laneRows.length}
                </span>
              </div>
              <div className="flex-1 min-h-[80px] p-1.5 space-y-1.5">
                {laneRows.map((row) => (
                  <div
                    key={row.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/fb-row-id', row.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    className="fb-card group p-2 hover:border-accent/40 cursor-grab active:cursor-grabbing transition-colors"
                  >
                    {titleCol && (
                      <div className="text-[12px] text-[var(--ink-90)]">
                        <FieldEditor
                          def={titleCol}
                          value={
                            row.cells[titleCol.id] ?? defaultValue(titleCol.type)
                          }
                          variant="cell"
                          onCommit={(v) => commitCell(row.id, titleCol.id, v)}
                        />
                      </div>
                    )}
                    <div className="flex items-center justify-end mt-1">
                      <button
                        onClick={() => deleteRow(row.id)}
                        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-40)] hover:text-red-500 transition-opacity"
                        title="Delete row"
                        aria-label="Delete row"
                      >
                        <Icon name="delete" size={11} />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  onClick={addRow}
                  className="w-full text-[11px] py-1 rounded text-[var(--ink-40)] hover:text-accent hover:bg-accent/5 inline-flex items-center justify-center gap-1"
                >
                  <Icon name="add" size={11} />
                  Add
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// CALENDAR VIEW — month grid with rows positioned on their date. Click an
// empty day to add a new row anchored on that date. Click an event to
// edit it inline at the bottom. Honest scope: month grid only in v1, no
// week/day toggles.

export function CalendarView({
  schema,
  rows,
  viewConfig,
  commitCell,
  addRow,
  setViewConfig
}: ViewProps): JSX.Element {
  const dateCols = schema.columns.filter((c) => c.type === 'date')
  const dateCol = pickDateColumn(schema, viewConfig)
  const titleCol = pickTitleColumn(schema, viewConfig)
  const [monthOffset, setMonthOffset] = useState(0)

  if (!dateCol) {
    return (
      <ConfigureHint
        icon="event"
        title="Calendar needs a date column"
        body="Add a date column to use the calendar view. Each row will appear on its date; click an empty day to add a row anchored on it."
        onAdd={addRow}
      />
    )
  }

  // Anchor today, then advance by monthOffset full calendar months.
  const today = new Date()
  const anchor = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1)
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const startWeekday = firstDay.getDay() // 0 = Sun
  const daysInMonth = lastDay.getDate()
  // Build a 6×7 grid covering the month + leading/trailing padding so the
  // grid never reflows.
  const gridStart = new Date(year, month, 1 - startWeekday)
  const cells: Date[] = []
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i))
  }

  // Group rows by yyyy-mm-dd of their date column.
  const rowsByDay = new Map<string, FbRow[]>()
  for (const row of rows) {
    const v = row.cells[dateCol.id]
    let key: string | null = null
    if (typeof v === 'number') {
      const d = new Date(v)
      key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    } else if (typeof v === 'string') {
      const d = new Date(v)
      if (!Number.isNaN(d.getTime())) {
        key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      }
    }
    if (key) {
      const arr = rowsByDay.get(key) ?? []
      arr.push(row)
      rowsByDay.set(key, arr)
    }
  }

  const monthName = anchor.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })
  void daysInMonth

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMonthOffset((o) => o - 1)}
            className="h-6 w-6 inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)]"
            aria-label="Previous month"
          >
            <Icon name="chevron_left" size={16} />
          </button>
          <span className="text-[12px] font-medium text-[var(--ink-90)] min-w-[110px] text-center">
            {monthName}
          </span>
          <button
            onClick={() => setMonthOffset((o) => o + 1)}
            className="h-6 w-6 inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)]"
            aria-label="Next month"
          >
            <Icon name="chevron_right" size={16} />
          </button>
          <button
            onClick={() => setMonthOffset(0)}
            className="text-[10px] px-1.5 py-0.5 rounded text-[var(--ink-50)] hover:text-accent ml-1"
          >
            Today
          </button>
        </div>
        {dateCols.length > 1 && (
          <div className="text-[11px] text-[var(--ink-50)] inline-flex items-center gap-1.5">
            <span>Date:</span>
            <select
              value={dateCol.id}
              onChange={(e) =>
                setViewConfig({ ...viewConfig, calendarColumnId: e.target.value })
              }
              className="fb-field px-1.5 py-0.5 text-[var(--ink-70)]"
            >
              {dateCols.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="grid grid-cols-7 gap-px bg-[var(--surface-sunken)] rounded overflow-hidden text-[11px]">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div
            key={d}
            className="bg-[var(--surface-sunken)] px-1.5 py-1 text-[var(--ink-50)] text-[10px] uppercase tracking-wider font-medium"
          >
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === month
          const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
          const dayRows = rowsByDay.get(key) ?? []
          const isToday =
            d.getFullYear() === today.getFullYear() &&
            d.getMonth() === today.getMonth() &&
            d.getDate() === today.getDate()
          return (
            <div
              key={i}
              className={`min-h-[64px] p-1 ${
                inMonth
                  ? 'bg-[var(--surface-raised)]'
                  : 'bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]'
              }`}
            >
              <div
                className={`text-[10px] mb-1 flex items-center justify-between ${
                  inMonth
                    ? 'text-[var(--ink-70)]'
                    : 'text-[var(--ink-30)]'
                }`}
              >
                <span
                  className={
                    isToday
                      ? 'inline-flex items-center justify-center h-4 w-4 rounded-full bg-accent text-white'
                      : ''
                  }
                >
                  {d.getDate()}
                </span>
                {inMonth && (
                  <button
                    onClick={addRow}
                    className="opacity-0 hover:opacity-100 text-[var(--ink-40)] hover:text-accent text-[10px]"
                    title={`Add row on ${d.toLocaleDateString()}`}
                  >
                    +
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {dayRows.slice(0, 3).map((row) => (
                  <div
                    key={row.id}
                    className="text-[10px] px-1 py-0.5 rounded bg-accent/10 text-accent truncate"
                    title={getCellString(row, titleCol) || '(untitled)'}
                  >
                    {getCellString(row, titleCol) || '(untitled)'}
                  </div>
                ))}
                {dayRows.length > 3 && (
                  <div className="text-[9px] text-[var(--ink-40)]">
                    +{dayRows.length - 3} more
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {void commitCell}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// GANTT VIEW — horizontal timeline. Each row is a bar from its start
// date to its end date, sized to the timeline scale. Honest scope: bars
// are read-only-positioned in v1 (no drag-to-extend); the user edits
// dates in the table view or via the inline fields below the chart.

export function GanttView({
  schema,
  rows,
  viewConfig,
  setViewConfig,
  addRow
}: ViewProps): JSX.Element {
  const dateCols = schema.columns.filter((c) => c.type === 'date')
  const { start: startCol, end: endCol } = pickStartEndDateColumns(schema, viewConfig)
  const titleCol = pickTitleColumn(schema, viewConfig)

  // Compute the timeline window from all row start/end dates, with a 5% pad on
  // each side. This hook MUST run before any early return below so the hook order
  // stays stable when the date columns appear/disappear (otherwise React throws
  // "rendered more hooks than during the previous render" and the view crashes).
  const dated = useMemo(() => {
    if (!startCol || !endCol) return []
    const out: Array<{ row: FbRow; start: number; end: number }> = []
    for (const row of rows) {
      const sN = getCellNumber(row, startCol) ?? Date.parse(getCellString(row, startCol))
      const eN = getCellNumber(row, endCol) ?? Date.parse(getCellString(row, endCol))
      if (!Number.isFinite(sN) || !Number.isFinite(eN)) continue
      out.push({ row, start: Math.min(sN, eN), end: Math.max(sN, eN) })
    }
    return out
  }, [rows, startCol, endCol])

  if (!startCol || !endCol) {
    return (
      <ConfigureHint
        icon="timeline"
        title="Gantt needs two date columns"
        body="Add at least two date columns (e.g. Start and End) to use the gantt view. Each row's bar spans from start to end."
        onAdd={addRow}
      />
    )
  }

  if (dated.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-[var(--ink-50)]">
        <Icon
          name="timeline"
          size={22}
          className="text-[var(--ink-30)] mx-auto mb-1.5"
        />
        Add start + end dates to your rows to see them on the timeline.
        <div className="mt-2">
          <button
            onClick={addRow}
            className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white"
          >
            Add a row
          </button>
        </div>
      </div>
    )
  }

  const tMin = Math.min(...dated.map((d) => d.start))
  const tMax = Math.max(...dated.map((d) => d.end))
  const span = Math.max(tMax - tMin, 86_400_000)
  const padded = span * 1.1
  const padStart = tMin - span * 0.05

  function pct(t: number): number {
    return ((t - padStart) / padded) * 100
  }

  // Build a sparse axis: month boundaries falling inside the window.
  const axis: Array<{ pct: number; label: string }> = []
  const startD = new Date(padStart)
  startD.setDate(1)
  for (let m = 0; m < 24; m++) {
    const d = new Date(startD.getFullYear(), startD.getMonth() + m, 1)
    if (d.getTime() > padStart + padded) break
    axis.push({
      pct: pct(d.getTime()),
      label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
    })
  }

  return (
    <div className="px-3 py-2">
      {dateCols.length > 2 && (
        <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--ink-50)]">
          <span>Start:</span>
          <select
            value={startCol.id}
            onChange={(e) =>
              setViewConfig({ ...viewConfig, ganttStartColumnId: e.target.value })
            }
            className="fb-field px-1.5 py-0.5 text-[var(--ink-70)]"
          >
            {dateCols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <span>End:</span>
          <select
            value={endCol.id}
            onChange={(e) =>
              setViewConfig({ ...viewConfig, ganttEndColumnId: e.target.value })
            }
            className="fb-field px-1.5 py-0.5 text-[var(--ink-70)]"
          >
            {dateCols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* Axis */}
      <div className="relative h-5 mb-1 border-b border-[var(--edge-soft)]">
        {axis.map((a, i) => (
          <div
            key={i}
            className="absolute top-0 text-[9px] uppercase tracking-wider text-[var(--ink-40)]"
            style={{ left: `${a.pct}%` }}
          >
            {a.label}
          </div>
        ))}
      </div>
      {/* Rows */}
      <div className="space-y-1">
        {dated.map(({ row, start, end }) => {
          const left = pct(start)
          const width = Math.max(2, pct(end) - left)
          return (
            <div key={row.id} className="flex items-center gap-2 group">
              <div className="w-32 shrink-0 text-[11px] text-[var(--ink-70)] truncate">
                {getCellString(row, titleCol) || '(untitled)'}
              </div>
              <div className="relative flex-1 h-6">
                <div className="absolute inset-y-1 left-0 right-0 rounded bg-[var(--surface-sunken)]" />
                <div
                  className="absolute top-1 bottom-1 rounded bg-accent/85 shadow-sm flex items-center px-1.5"
                  style={{ left: `${left}%`, width: `${width}%`, minWidth: 6 }}
                  title={`${new Date(start).toLocaleDateString()} → ${new Date(
                    end
                  ).toLocaleDateString()}`}
                >
                  <span className="text-[9px] text-white truncate">
                    {Math.round((end - start) / 86_400_000)}d
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Shared helpers

function EmptyState({ onAdd }: { onAdd: () => void }): JSX.Element {
  return (
    <div className="py-8 text-center text-[12px] text-[var(--ink-40)]">
      <Icon
        name="layers_clear"
        size={20}
        className="text-[var(--ink-30)] mx-auto mb-1"
      />
      <div>No rows yet.</div>
      <button
        onClick={onAdd}
        className="mt-2 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white"
      >
        Add a row
      </button>
    </div>
  )
}

function AddRowFooter({ onAdd }: { onAdd: () => void }): JSX.Element {
  return (
    <button
      onClick={onAdd}
      className="w-full inline-flex items-center justify-center gap-1 text-[12px] py-1.5 rounded text-[var(--ink-50)] hover:text-accent hover:bg-accent/5 transition-colors"
    >
      <Icon name="add" size={14} />
      <span>Add row</span>
    </button>
  )
}

function ConfigureHint({
  icon,
  title,
  body,
  onAdd
}: {
  icon: string
  title: string
  body: string
  onAdd: () => void
}): JSX.Element {
  return (
    <div className="px-3 py-6 text-center text-[12px] text-[var(--ink-50)] max-w-md mx-auto">
      <Icon
        name={icon}
        size={24}
        className="text-[var(--ink-30)] mx-auto mb-1.5"
      />
      <div className="font-medium text-[var(--ink-70)] mb-1">{title}</div>
      <div className="leading-relaxed">{body}</div>
      <button
        onClick={onAdd}
        className="mt-3 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white"
      >
        Add a row anyway
      </button>
    </div>
  )
}
