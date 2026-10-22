import { useEffect, useMemo, useState } from 'react'
import type { MapArrowHead, MapConditionalRule, MapNode, MapStrokeDash } from '@shared/types'
import type { FbTable } from '@shared/fields'
import { arrowHeadPath } from '@shared/diagram/arrowheads'
import { useTablesStore } from '../../../stores/tables'
import { cellText, primaryColumn } from '@shared/diagram/data'
import Icon from '../../Icon'
import type { Commands } from './commands'
import { Row } from './ui'
import { ICON_NAMES } from './iconNames'

// Pieces shared by the diagram's ribbon tabs and overlay panels (office shell,
// SPEC §6.1). This was the right-hand Inspector; owner ruling D1 moved every
// setting into the top bar, so what remains here are the reusable parts: font
// and dash lists, arrowhead names and drawings, the icon search, custom data
// and the Plexii-table binding form (the last three open as ShellPanels).

export const FONTS = [
  { value: 'Inter, -apple-system, "Segoe UI", system-ui, sans-serif', label: 'Inter (system)' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: '"Helvetica Neue", Helvetica, sans-serif', label: 'Helvetica' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: '"Trebuchet MS", sans-serif', label: 'Trebuchet' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: '"Times New Roman", Times, serif', label: 'Times' },
  { value: '"SF Mono", Menlo, Consolas, monospace', label: 'Monospace' },
  { value: '"Comic Sans MS", "Comic Neue", cursive', label: 'Handwritten' }
]

export const DASHES: { value: MapStrokeDash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'dashdot', label: 'Dash-dot' },
  { value: 'none', label: 'None' }
]

export const ARROW_LABEL: Record<MapArrowHead, string> = {
  none: 'None',
  arrow: 'Arrow',
  open: 'Open arrow',
  triangle: 'Hollow triangle',
  diamond: 'Filled diamond',
  diamondOpen: 'Hollow diamond',
  circle: 'Filled circle',
  circleOpen: 'Hollow circle',
  bar: 'Bar',
  crowOne: 'One (ERD)',
  crowMany: 'Many (ERD)',
  crowOneOrMany: 'One or many (ERD)',
  crowZeroOrOne: 'Zero or one (ERD)',
  crowZeroOrMany: 'Zero or many (ERD)'
}

// Value shared by every item, or undefined when mixed.
export function common<T, V>(items: T[], f: (t: T) => V): V | undefined {
  if (!items.length) return undefined
  const v = f(items[0]!)
  return items.every((i) => JSON.stringify(f(i)) === JSON.stringify(v)) ? v : undefined
}

// ── shapes ──────────────────────────────────────────────────────────────────

export function IconInput({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }): JSX.Element {
  const [q, setQ] = useState(value ?? '')
  useEffect(() => setQ(value ?? ''), [value])
  const suggestions = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/\s+/g, '_')
    return s && s !== value ? ICON_NAMES.filter((n) => n.includes(s)).slice(0, 12) : []
  }, [q, value])
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1">
        {value && (
          <span className="material-symbols-outlined text-[var(--ink-70)]" style={{ fontSize: 18 }}>
            {value}
          </span>
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onChange(q.trim().replace(/\s+/g, '_'))
          }}
          placeholder="search icons"
          className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0"
          data-testid="diagram-icon-input"
        />
        {value && (
          <button type="button" onClick={() => onChange('')} className="text-[var(--ink-50)] hover:text-[var(--ink-90)]" title="Remove icon">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="grid grid-cols-6 gap-0.5 mt-1">
          {suggestions.map((n) => (
            <button key={n} type="button" title={n} onClick={() => onChange(n)} className="h-7 rounded hover:bg-[var(--surface-sunken)] flex items-center justify-center">
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                {n}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── data ────────────────────────────────────────────────────────────────────

export function CustomData({ cmd, node }: { cmd: Commands; node: MapNode }): JSX.Element {
  const entries = Object.entries(node.data ?? {})
  const [k, setK] = useState('')
  const [v, setV] = useState('')
  const set = (data: Record<string, string>): void => cmd.setNode(node.id, { data: Object.keys(data).length ? data : undefined }, `data:${node.id}`)
  return (
    <div className="space-y-1">
      {entries.map(([key, val]) => (
        <div key={key} className="flex items-center gap-1">
          <span className="w-[80px] truncate text-[11px] text-[var(--ink-60)]" title={key}>
            {key}
          </span>
          <input
            value={val}
            onChange={(e) => set({ ...node.data, [key]: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0"
          />
          <button
            type="button"
            title="Remove"
            onClick={() => {
              const d = { ...node.data }
              delete d[key]
              set(d)
            }}
            className="text-[var(--ink-40)] hover:text-red-600"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <input value={k} onChange={(e) => setK(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Field" className="fb-field h-6 px-1.5 text-[11px] w-[80px]" data-testid="diagram-data-key" />
        <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Value" className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0" data-testid="diagram-data-value" />
        <button
          type="button"
          disabled={!k.trim()}
          onClick={() => {
            set({ ...(node.data ?? {}), [k.trim()]: v })
            setK('')
            setV('')
          }}
          className="text-[11px] px-2 h-6 rounded bg-[var(--surface-sunken)] disabled:opacity-40"
          data-testid="diagram-data-add"
        >
          Add
        </button>
      </div>
    </div>
  )
}

// Link a shape to a Plexii table row (live label, fields and colour rules).
export function Binding({ cmd, node }: { cmd: Commands; node: MapNode }): JSX.Element {
  const [tableList, setTableList] = useState<FbTable[] | null>(null)
  const tables = useTablesStore((s) => s.tables)
  const rows = useTablesStore((s) => s.rows)
  const b = node.binding
  const tableId = b?.source.kind === 'table' ? b.source.tableId : undefined
  const table = tableId ? tables[tableId] : undefined
  const tableRows = tableId ? rows[tableId] : undefined
  useEffect(() => {
    let alive = true
    window.api.tables
      .list()
      .then((l) => alive && setTableList(l))
      .catch(() => alive && setTableList([]))
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (!tableId) return
    void useTablesStore.getState().ensureTableLoaded(tableId)
    void useTablesStore.getState().ensureRowsLoaded(tableId)
  }, [tableId])

  if (b && b.source.kind !== 'table') {
    return (
      <div className="text-[11px] text-[var(--ink-60)] space-y-1">
        <div>
          Linked to {b.source.kind === 'widget' ? 'a work widget' : b.source.kind === 'app' ? `the ${b.source.appId.split(':')[1]} app` : `the ${b.source.toolId} tool`}.
        </div>
        <button type="button" className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]" onClick={() => cmd.setNode(node.id, { binding: undefined })}>
          Unlink
        </button>
      </div>
    )
  }

  const setB = (patch: Partial<NonNullable<MapNode['binding']>>): void => {
    if (!b) return
    cmd.setNode(node.id, { binding: { ...b, ...patch } })
  }
  const primary = table ? primaryColumn(table) : undefined

  return (
    <div className="space-y-2">
      <Row label="Table">
        <select
          value={tableId ?? ''}
          onChange={(e) => {
            const id = e.target.value
            cmd.setNode(node.id, { binding: id ? { source: { kind: 'table', tableId: id } } : undefined })
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="fb-field h-6 px-1 text-[11px] flex-1 min-w-0"
          data-testid="diagram-bind-table"
        >
          <option value="">{tableList === null ? 'Loading tables…' : tableList.length ? 'Not linked' : 'No Plexii tables yet'}</option>
          {(tableList ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.title || 'Untitled table'}
            </option>
          ))}
        </select>
      </Row>
      {b && table && (
        <>
          <Row label="Row">
            <select
              value={b.source.kind === 'table' ? b.source.rowId ?? '' : ''}
              onChange={(e) => setB({ source: { kind: 'table', tableId: table.id, ...(e.target.value ? { rowId: e.target.value } : {}) } })}
              onKeyDown={(e) => e.stopPropagation()}
              className="fb-field h-6 px-1 text-[11px] flex-1 min-w-0"
              data-testid="diagram-bind-row"
            >
              <option value="">Pick a row…</option>
              {(tableRows ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {primary ? cellText(r.cells[primary.id], primary) || '(blank)' : r.id}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Label">
            <input
              defaultValue={b.labelTemplate ?? ''}
              placeholder={primary ? `{${primary.label}}` : '{Column}'}
              onBlur={(e) => setB({ labelTemplate: e.target.value || undefined })}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="fb-field h-6 px-1.5 text-[11px] flex-1 min-w-0"
              data-testid="diagram-bind-template"
            />
          </Row>
          <p className="text-[10px] text-[var(--ink-40)] -mt-1">Use column names in braces, e.g. {'{Name} · {Status}'}.</p>
          <div>
            <div className="text-[10px] text-[var(--ink-50)] mb-0.5">Show fields</div>
            <div className="flex flex-wrap gap-1">
              {table.schema.columns.map((c) => {
                const on = b.fields?.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setB({ fields: on ? (b.fields ?? []).filter((x) => x !== c.id) : [...(b.fields ?? []), c.id] })}
                    className={`text-[10px] px-1.5 py-0.5 rounded-full border ${on ? 'border-[#2563eb] text-[#1d4ed8] bg-[#2563eb]/10' : 'border-[var(--edge-firm)] text-[var(--ink-60)]'}`}
                  >
                    {c.label}
                  </button>
                )
              })}
            </div>
          </div>
          <Rules table={table} rules={b.rules ?? []} onChange={(rules) => setB({ rules: rules.length ? rules : undefined })} />
          <button type="button" className="text-[11px] px-2 py-1 rounded hover:bg-[var(--surface-sunken)] text-[var(--ink-60)]" onClick={() => cmd.setNode(node.id, { binding: undefined })}>
            Unlink from table
          </button>
        </>
      )}
      {b && !table && tableId && <div className="text-[11px] text-amber-600">The linked table is loading or no longer exists.</div>}
    </div>
  )
}

function Rules({ table, rules, onChange }: { table: FbTable; rules: MapConditionalRule[]; onChange: (r: MapConditionalRule[]) => void }): JSX.Element {
  const ops: { value: MapConditionalRule['op']; label: string }[] = [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'gt', label: '>' },
    { value: 'lt', label: '<' },
    { value: 'gte', label: '≥' },
    { value: 'lte', label: '≤' },
    { value: 'empty', label: 'is empty' },
    { value: 'notEmpty', label: 'has a value' }
  ]
  const set = (i: number, patch: Partial<MapConditionalRule>): void => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div>
      <div className="text-[10px] text-[var(--ink-50)] mb-0.5">Conditional formatting (first match wins)</div>
      {rules.map((r, i) => (
        <div key={r.id} className="flex items-center gap-1 mb-1">
          <select value={r.columnId} onChange={(e) => set(i, { columnId: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-6 px-0.5 text-[10px] w-[70px]">
            {table.schema.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={r.op} onChange={(e) => set(i, { op: e.target.value as MapConditionalRule['op'] })} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-6 px-0.5 text-[10px] w-[58px]">
            {ops.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {r.op !== 'empty' && r.op !== 'notEmpty' && (
            <input defaultValue={r.value ?? ''} onBlur={(e) => set(i, { value: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-6 px-1 text-[10px] w-[52px]" />
          )}
          <input type="color" value={r.fill ?? '#dc2626'} onChange={(e) => set(i, { fill: e.target.value })} className="h-6 w-6 p-0 border-0 bg-transparent" title="Fill when matched" />
          <button type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))} className="text-[var(--ink-40)] hover:text-red-600" title="Remove rule">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rules, { id: `r${Date.now().toString(36)}`, columnId: table.schema.columns[0]?.id ?? '', op: 'eq', value: '', fill: '#dc2626' }])}
        className="text-[11px] px-2 py-1 rounded bg-[var(--surface-sunken)]"
        data-testid="diagram-add-rule"
      >
        Add rule
      </button>
    </div>
  )
}

// ── lines ───────────────────────────────────────────────────────────────────

export function ArrowPreview({ kind }: { kind: MapArrowHead }): JSX.Element {
  const parts = kind === 'none' ? [] : arrowHeadPath(kind, { x: 34, y: 8 }, 0, 8)
  return (
    <svg width={40} height={16} aria-hidden>
      <line x1={2} y1={8} x2={34} y2={8} stroke="currentColor" strokeWidth={1.5} />
      {parts.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill === 'stroke' ? 'currentColor' : p.fill === 'background' ? 'var(--surface-raised)' : 'none'} stroke="currentColor" strokeWidth={1.2} />
      ))}
    </svg>
  )
}
