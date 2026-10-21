// Data linking for PlexiDiagrams: turning Plexii table rows into shape labels,
// conditional styling, and whole generated diagrams (org charts, flows, card
// grids, grouped mind maps). Pure: the editor passes in the table and rows it
// loaded, so this is unit-tested without a database. No fabrication — a missing
// column or empty cell renders empty, never a placeholder value.

import type { FbRow, FbTable, FieldDefinition } from '../fields'
import type { MapConditionalRule, MapEdge, MapNode, MapNodeBinding } from '../types'

// Display text for one cell, matching the table widget: select ids become their
// option labels, checkboxes Yes/No, dates a local date, relations a count.
export function cellText(value: unknown, col: FieldDefinition | undefined): string {
  if (value == null || value === '') return ''
  if (!col) return typeof value === 'object' ? '' : String(value)
  switch (col.type) {
    case 'single-select':
    case 'multi-select': {
      const options = col.config.options ?? []
      const ids = Array.isArray(value) ? value : [value]
      return ids.map((id) => options.find((o) => o.id === id)?.label ?? String(id)).join(', ')
    }
    case 'checkbox':
      return value ? 'Yes' : 'No'
    case 'date':
      return typeof value === 'number' ? new Date(value).toLocaleDateString() : String(value)
    case 'number':
      return typeof value === 'number' ? `${col.config.prefix ?? ''}${value}${col.config.suffix ?? ''}` : String(value)
    case 'relation':
    case 'attachment':
    case 'doc-ref':
      return Array.isArray(value) ? `${value.length} linked` : ''
    case 'text-rich':
      return richToText(value)
    default:
      return Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'object' ? '' : String(value)
  }
}

function richToText(value: unknown): string {
  let doc: unknown = value
  if (typeof value === 'string') {
    try {
      doc = JSON.parse(value)
    } catch {
      return value
    }
  }
  const out: string[] = []
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const o = n as { text?: unknown; content?: unknown[] }
    if (typeof o.text === 'string') out.push(o.text)
    if (Array.isArray(o.content)) o.content.forEach(walk)
  }
  walk(doc)
  return out.join(' ').trim()
}

export function columnByName(table: FbTable, name: string): FieldDefinition | undefined {
  const n = name.trim().toLowerCase()
  return table.schema.columns.find((c) => c.label.trim().toLowerCase() === n) ?? table.schema.columns.find((c) => c.id === name)
}

// The column most likely to name a row: the first short-text column.
export function primaryColumn(table: FbTable): FieldDefinition | undefined {
  return table.schema.columns.find((c) => c.type === 'text-short') ?? table.schema.columns[0]
}

// "{Name} · {Status}" with column names (or ids) in braces. Unknown names are
// left visible so the user sees the typo instead of a silent blank.
export function renderTemplate(template: string, table: FbTable, row: FbRow): string {
  return template.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const col = columnByName(table, name)
    return col ? cellText(row.cells[col.id], col) : whole
  })
}

export function ruleMatches(rule: MapConditionalRule, table: FbTable, row: FbRow): boolean {
  const col = table.schema.columns.find((c) => c.id === rule.columnId)
  if (!col) return false
  const raw = row.cells[col.id]
  const text = cellText(raw, col)
  const want = rule.value ?? ''
  const numL = typeof raw === 'number' ? raw : Number(text)
  const numR = Number(want)
  switch (rule.op) {
    case 'empty':
      return text === ''
    case 'notEmpty':
      return text !== ''
    case 'eq':
      return text.toLowerCase() === want.toLowerCase()
    case 'neq':
      return text.toLowerCase() !== want.toLowerCase()
    case 'contains':
      return text.toLowerCase().includes(want.toLowerCase())
    case 'gt':
      return Number.isFinite(numL) && Number.isFinite(numR) && numL > numR
    case 'lt':
      return Number.isFinite(numL) && Number.isFinite(numR) && numL < numR
    case 'gte':
      return Number.isFinite(numL) && Number.isFinite(numR) && numL >= numR
    case 'lte':
      return Number.isFinite(numL) && Number.isFinite(numR) && numL <= numR
  }
}

export interface BoundView {
  label: string
  fields: { name: string; value: string }[]
  rule?: MapConditionalRule // first matching rule
  missing?: 'table' | 'row'
}

// What a table-bound shape shows right now.
export function boundView(binding: MapNodeBinding, table: FbTable | null | undefined, rows: FbRow[] | null | undefined, fallbackLabel: string): BoundView {
  if (binding.source.kind !== 'table') return { label: fallbackLabel, fields: [] }
  if (!table) return { label: fallbackLabel, fields: [], missing: 'table' }
  const rowId = binding.source.rowId
  const row = rowId ? rows?.find((r) => r.id === rowId) : undefined
  if (!row) return { label: fallbackLabel, fields: [], missing: rowId ? 'row' : undefined }
  const primary = primaryColumn(table)
  const label = binding.labelTemplate
    ? renderTemplate(binding.labelTemplate, table, row)
    : primary
      ? cellText(row.cells[primary.id], primary)
      : fallbackLabel
  const fields = (binding.fields ?? [])
    .map((id) => table.schema.columns.find((c) => c.id === id))
    .filter((c): c is FieldDefinition => !!c)
    .map((c) => ({ name: c.label, value: cellText(row.cells[c.id], c) }))
  const rule = (binding.rules ?? []).find((r) => ruleMatches(r, table, row))
  return { label, fields, ...(rule ? { rule } : {}) }
}

// ── generators ──────────────────────────────────────────────────────────────

export type GenerateKind = 'orgchart' | 'flow' | 'cards' | 'mindmap'

export interface GenerateOptions {
  kind: GenerateKind
  labelColumnId?: string // defaults to the primary column
  // orgchart: a relation column (to the same table) or a text column naming the
  // parent row's label. flow: a relation column or text column naming the next
  // step(s), comma-separated. mindmap: a column whose values become branches.
  linkColumnId?: string
  fieldColumnIds?: string[] // extra lines on each card
  colorColumnId?: string // single-select whose option colours tint shapes
  shape?: string
  idPrefix?: string
}

export interface Generated {
  nodes: MapNode[]
  edges: MapEdge[]
  warnings: string[]
}

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#475569', '#db2777']

// Tailwind-ish option colour names to hex; unknown names fall back to the palette.
const NAMED: Record<string, string> = {
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#d97706',
  yellow: '#ca8a04',
  orange: '#ea580c',
  red: '#dc2626',
  purple: '#7c3aed',
  violet: '#7c3aed',
  pink: '#db2777',
  cyan: '#0891b2',
  teal: '#0d9488',
  gray: '#475569',
  grey: '#475569',
  slate: '#475569',
  stone: '#57534e'
}

function optionColor(col: FieldDefinition | undefined, value: unknown, fallbackIndex: number): string | undefined {
  if (!col || (col.type !== 'single-select' && col.type !== 'multi-select')) return undefined
  const id = Array.isArray(value) ? value[0] : value
  const opts = col.config.options ?? []
  const idx = opts.findIndex((o) => o.id === id)
  if (idx < 0) return undefined
  const c = opts[idx]!.color
  if (c && /^#[0-9a-f]{6}$/i.test(c)) return c
  if (c && NAMED[c.toLowerCase()]) return NAMED[c.toLowerCase()]
  return PALETTE[(idx + fallbackIndex) % PALETTE.length]
}

// Rows → shapes (unpositioned: the caller runs a layout). Each shape is bound to
// its row so it stays live: edits in the table flow into the diagram.
export function generateFromTable(table: FbTable, rows: FbRow[], opts: GenerateOptions): Generated {
  const warnings: string[] = []
  const prefix = opts.idPrefix ?? `t${table.id.slice(0, 6)}-`
  const labelCol = (opts.labelColumnId && table.schema.columns.find((c) => c.id === opts.labelColumnId)) || primaryColumn(table)
  if (!labelCol) return { nodes: [], edges: [], warnings: ['This table has no columns.'] }
  const linkCol = opts.linkColumnId ? table.schema.columns.find((c) => c.id === opts.linkColumnId) : undefined
  const colorCol = opts.colorColumnId ? table.schema.columns.find((c) => c.id === opts.colorColumnId) : undefined
  const fieldIds = (opts.fieldColumnIds ?? []).filter((id) => table.schema.columns.some((c) => c.id === id))
  const shape =
    opts.shape ?? (opts.kind === 'orgchart' ? 'process' : opts.kind === 'mindmap' ? 'terminator' : opts.kind === 'cards' ? 'process' : 'process')

  const nodeId = (rowId: string): string => `${prefix}${rowId}`
  const labelOf = (r: FbRow): string => cellText(r.cells[labelCol.id], labelCol)
  const nodes: MapNode[] = rows.map((r, i) => ({
    id: nodeId(r.id),
    x: 0,
    y: 0,
    label: labelOf(r),
    shape,
    color: optionColor(colorCol, colorCol ? r.cells[colorCol.id] : undefined, 0) ?? PALETTE[i % PALETTE.length]!,
    ...(fieldIds.length ? { height: 48 + fieldIds.length * 16, width: 170 } : {}),
    binding: {
      source: { kind: 'table', tableId: table.id, rowId: r.id },
      ...(fieldIds.length ? { fields: fieldIds } : {})
    }
  }))
  const edges: MapEdge[] = []
  const byLabel = new Map<string, FbRow>()
  for (const r of rows) {
    const l = labelOf(r).trim().toLowerCase()
    if (l && !byLabel.has(l)) byLabel.set(l, r)
  }
  const rowIds = new Set(rows.map((r) => r.id))
  // Targets named by a link cell: relation ids, or comma-separated labels.
  const linked = (r: FbRow): string[] => {
    if (!linkCol) return []
    const v = r.cells[linkCol.id]
    if (linkCol.type === 'relation') return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && rowIds.has(x)) : []
    const text = cellText(v, linkCol)
    if (!text) return []
    const out: string[] = []
    for (const part of text.split(',')) {
      const hit = byLabel.get(part.trim().toLowerCase())
      if (hit) out.push(hit.id)
      else if (part.trim()) warnings.push(`"${part.trim()}" (in ${linkCol.label}) does not match any row's ${labelCol.label}.`)
    }
    return out
  }

  if (opts.kind === 'orgchart') {
    if (!linkCol) warnings.push('Pick the column that names each person’s manager to draw the reporting lines.')
    for (const r of rows) {
      for (const parent of linked(r)) {
        if (parent === r.id) continue
        edges.push({ id: `${prefix}e-${parent}-${r.id}`, source: nodeId(parent), target: nodeId(r.id), routing: 'orthogonal', endArrow: 'none' })
      }
    }
  } else if (opts.kind === 'flow') {
    if (!linkCol) {
      // No link column: connect rows in their table order, a simple sequence.
      for (let i = 0; i + 1 < rows.length; i++) {
        edges.push({ id: `${prefix}e-${rows[i]!.id}-${rows[i + 1]!.id}`, source: nodeId(rows[i]!.id), target: nodeId(rows[i + 1]!.id), routing: 'orthogonal' })
      }
    } else {
      for (const r of rows) {
        for (const next of linked(r)) {
          if (next === r.id) continue
          edges.push({ id: `${prefix}e-${r.id}-${next}`, source: nodeId(r.id), target: nodeId(next), routing: 'orthogonal' })
        }
      }
    }
  } else if (opts.kind === 'mindmap') {
    const rootId = `${prefix}root`
    nodes.unshift({ id: rootId, x: 0, y: 0, label: table.title || 'Table', shape: 'circle', color: '#2563eb', width: 150, height: 150 })
    if (linkCol) {
      const groups = new Map<string, string>()
      for (const r of rows) {
        const key = cellText(r.cells[linkCol.id], linkCol) || '(blank)'
        if (!groups.has(key)) {
          const gid = `${prefix}g-${groups.size}`
          groups.set(key, gid)
          nodes.push({ id: gid, x: 0, y: 0, label: key, shape: 'terminator', color: PALETTE[groups.size % PALETTE.length]! })
          edges.push({ id: `${prefix}e-root-${gid}`, source: rootId, target: gid, routing: 'curved', endArrow: 'none' })
        }
        edges.push({ id: `${prefix}e-${groups.get(key)}-${r.id}`, source: groups.get(key)!, target: nodeId(r.id), routing: 'curved', endArrow: 'none' })
      }
    } else {
      for (const r of rows) edges.push({ id: `${prefix}e-root-${r.id}`, source: rootId, target: nodeId(r.id), routing: 'curved', endArrow: 'none' })
    }
  }
  // Dedupe edges (a relation can list the same row twice).
  const seen = new Set<string>()
  return { nodes, edges: edges.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))), warnings: [...new Set(warnings)].slice(0, 20) }
}
