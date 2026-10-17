import { useEffect, useState } from 'react'
import type { Widget } from '@shared/types'
import type { FbRow, FbTable, FieldDefinition } from '@shared/fields'
import { WIDGET_CATALOG } from '../../../lib/widgetCatalog'
import WidgetPreview from '../../WidgetPreview'
import Icon from '../../Icon'
import { resolveWidget } from './widgetLookup'

// A read-only card that embeds a live view of a desk widget inside a document,
// slide, design or drawing. It resolves the widget fresh on every mount, so
// reopening the document shows the widget's current content, and it never
// pretends: a deleted widget renders an explicit missing state, and a kind we
// cannot render meaningfully names itself instead of faking a preview.

// GFM task-list line, the shape todo lists are stored in (markdown widgets).
const TASK_LINE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/

interface TaskItem {
  done: boolean
  text: string
}

function parseTaskItems(content: string): TaskItem[] {
  const items: TaskItem[] = []
  for (const line of content.split('\n')) {
    const m = TASK_LINE.exec(line)
    if (m) items.push({ done: m[1].toLowerCase() === 'x', text: m[2] })
  }
  return items
}

// Flatten a cell value to display text. Select ids map to their option labels;
// everything unrenderable shows as a dash rather than an invented value.
function cellText(value: unknown, col: FieldDefinition): string {
  if (value == null || value === '') return ''
  if (col.type === 'single-select' || col.type === 'multi-select') {
    const options = col.config.options ?? []
    const ids = Array.isArray(value) ? value : [value]
    return ids
      .map((id) => options.find((o) => o.id === id)?.label ?? String(id))
      .join(', ')
  }
  if (col.type === 'checkbox') return value ? 'Yes' : 'No'
  if (col.type === 'date' && typeof value === 'number') return new Date(value).toLocaleDateString()
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ')
  if (typeof value === 'object') return '-'
  return String(value)
}

const MAX_TABLE_ROWS = 5
const MAX_TABLE_COLS = 4

function TableBody({ tableId }: { tableId: string }): JSX.Element {
  const [table, setTable] = useState<FbTable | null>(null)
  const [rows, setRows] = useState<FbRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    async function load(): Promise<void> {
      try {
        const [t, r] = await Promise.all([
          window.api.tables.get(tableId),
          window.api.tables.listRows(tableId)
        ])
        if (!alive) return
        setTable(t)
        setRows(r)
        if (!t) setError('The backing table no longer exists.')
      } catch (e) {
        if (alive) setError((e as Error).message)
      }
    }
    void load()
    // Rows change from flows, forms and other windows too; refetch on any
    // change to this table so the embed stays a live view.
    const off = window.api.tables.onRowsChanged((changedId) => {
      if (changedId === tableId) void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [tableId])

  if (error) return <div className="p-2 text-[11px] text-[var(--ink-40)]">{error}</div>
  if (!table || rows == null) return <div className="p-2 text-[11px] text-[var(--ink-40)]">Loading table…</div>

  const cols = table.schema.columns.slice(0, MAX_TABLE_COLS)
  const shown = rows.slice(0, MAX_TABLE_ROWS)
  if (!cols.length) return <div className="p-2 text-[11px] text-[var(--ink-40)]">This table has no columns yet.</div>

  return (
    <div className="p-1.5 overflow-hidden">
      <table className="w-full text-[11px] text-left">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.id} className="px-1.5 py-1 font-medium text-[var(--ink-50)] border-b border-[var(--edge-soft)] truncate">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              {cols.map((c) => (
                <td key={c.id} className="px-1.5 py-1 text-[var(--ink-70)] border-b border-[var(--edge-soft)] truncate">
                  {cellText(r.cells[c.id], c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="px-1.5 py-1.5 text-[11px] text-[var(--ink-40)]">No rows yet</div>}
      {rows.length > MAX_TABLE_ROWS && (
        <div className="px-1.5 pt-1 text-[10px] text-[var(--ink-40)]">
          Showing {MAX_TABLE_ROWS} of {rows.length} rows
        </div>
      )}
    </div>
  )
}

function TaskListBody({ items }: { items: TaskItem[] }): JSX.Element {
  return (
    <div className="p-2 space-y-1 overflow-hidden">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-1.5 text-[12px] text-[var(--ink-70)]">
          <Icon
            name={it.done ? 'check_box' : 'check_box_outline_blank'}
            size={14}
            className={it.done ? 'text-accent shrink-0 mt-px' : 'text-[var(--ink-40)] shrink-0 mt-px'}
          />
          <span className={it.done ? 'line-through text-[var(--ink-40)]' : ''}>{it.text}</span>
        </div>
      ))}
    </div>
  )
}

// The kinds this embed renders with real content. Text kinds and cards go
// through WidgetPreview (the same renderer the minimap magnifier trusts);
// tables get real rows; todo-style markdown gets a checklist. Anything else
// falls to an honest placeholder that names the kind.
const PREVIEWABLE = new Set<Widget['kind']>(['sticky', 'note', 'markdown', 'card', 'page', 'living-doc'])

function EmbedBody({ widget }: { widget: Widget }): JSX.Element {
  if (widget.kind === 'table') {
    if (!widget.content) return <div className="p-2 text-[11px] text-[var(--ink-40)]">This table work widget has no backing table yet.</div>
    return <TableBody tableId={widget.content} />
  }
  if (widget.kind === 'note' || widget.kind === 'markdown') {
    const items = parseTaskItems(widget.content ?? '')
    if (items.length) return <TaskListBody items={items} />
  }
  if (PREVIEWABLE.has(widget.kind)) {
    return <WidgetPreview widget={widget} />
  }
  const entry = WIDGET_CATALOG.find((e) => e.kind === widget.kind)
  return (
    <div className="p-2 text-[11px] text-[var(--ink-40)]">
      A {entry?.label ?? widget.kind} widget. This kind has no document preview yet; open its desk to see it.
    </div>
  )
}

interface Props {
  widgetId: string
}

export default function WidgetEmbed({ widgetId }: Props): JSX.Element {
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'missing' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; widget: Widget; deskTitle: string }
  >({ phase: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })
    resolveWidget(widgetId)
      .then((res) => {
        if (!alive) return
        setState(res ? { phase: 'ready', widget: res.widget, deskTitle: res.deskTitle } : { phase: 'missing' })
      })
      .catch((e) => {
        if (alive) setState({ phase: 'error', message: (e as Error).message })
      })
    return () => {
      alive = false
    }
  }, [widgetId])

  const shell =
    'fb-card h-full w-full flex flex-col overflow-hidden'

  if (state.phase === 'loading') {
    return (
      <div className={shell} data-testid="widget-embed-loading">
        <div className="flex-1 flex items-center justify-center gap-1.5 text-[11px] text-[var(--ink-40)] p-3">
          <Icon name="autorenew" size={13} className="animate-spin" />
          <span>Loading work widget…</span>
        </div>
      </div>
    )
  }
  if (state.phase === 'missing' || state.phase === 'error') {
    return (
      <div className={shell} data-testid="widget-embed-missing">
        <div className="flex-1 flex flex-col items-center justify-center gap-1 text-[11px] text-[var(--ink-40)] p-3 text-center">
          <Icon name="link_off" size={18} />
          <span>{state.phase === 'missing' ? 'This work widget no longer exists' : state.message}</span>
        </div>
      </div>
    )
  }

  const { widget, deskTitle } = state
  const entry = WIDGET_CATALOG.find((e) => e.kind === widget.kind)
  return (
    <div className={shell} data-testid="widget-embed">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)]">
        <Icon name={entry?.icon ?? 'widgets'} size={14} className="text-accent shrink-0" />
        <span className="text-[12px] font-medium text-[var(--ink-90)] truncate">
          {widget.title || entry?.label || widget.kind}
        </span>
        {deskTitle && (
          <span className="ml-auto text-[10px] text-[var(--ink-40)] truncate" title={`From the desk "${deskTitle}"`}>
            {deskTitle}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <EmbedBody widget={widget} />
      </div>
    </div>
  )
}
