// The pure planner behind the "import into this table" wizard. Given an
// existing table schema, its current rows, a parsed grid from a file, the
// user's column mapping, and an optional primary-key column, it produces a
// plan: which columns to create, and an ordered list of insert/update row
// operations. Upsert works by matching each incoming row's primary-key value
// against the existing rows; a match updates that row, everything else inserts.
//
// Kept pure (no store, no IPC) so the matching and coercion are unit-testable.

import type { FieldType, TableSchema } from '@shared/fields'
import { inferColumnType } from '@shared/gridInfer'
import { coerceCellValue } from './actionExecutor'

export type ColumnTarget =
  | { kind: 'skip' }
  | { kind: 'existing'; columnId: string }
  | { kind: 'new'; columnId: string; label: string; type: FieldType }

export interface ColumnMapping {
  sourceHeader: string
  target: ColumnTarget
}

export interface ImportRow {
  id: string
  cells: Record<string, unknown>
}

export interface ParsedGrid {
  headers: string[]
  rows: Array<Record<string, string>>
}

export interface ImportPlanInput {
  schema: TableSchema
  existingRows: ImportRow[]
  grid: ParsedGrid
  mappings: ColumnMapping[]
  // The column to match on for upsert. Must be the id of a mapped column
  // (existing or new). null appends every row as new.
  primaryKeyColumnId: string | null
}

export interface NewColumn {
  id: string
  label: string
  type: FieldType
}

export type RowOp =
  | { op: 'insert'; cells: Record<string, unknown> }
  | { op: 'update'; rowId: string; cells: Record<string, unknown> }

export interface ImportPlan {
  newColumns: NewColumn[]
  ops: RowOp[]
  summary: { inserted: number; updated: number; columnsAdded: number; rowsSkipped: number }
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase()

// Propose a starting mapping: match each source header to an existing column by
// case-insensitive label, otherwise propose a new column with an inferred type.
export function suggestMappings(
  schema: TableSchema,
  grid: ParsedGrid,
  newColumnId: (header: string, index: number) => string
): ColumnMapping[] {
  return grid.headers.map((h, i) => {
    const existing = schema.columns.find((c) => c.label.trim().toLowerCase() === h.trim().toLowerCase())
    if (existing) {
      return { sourceHeader: h, target: { kind: 'existing', columnId: existing.id } }
    }
    const sample = grid.rows.slice(0, 20).map((r) => r[h] ?? '')
    return {
      sourceHeader: h,
      target: { kind: 'new', columnId: newColumnId(h, i), label: h, type: inferColumnType(sample) }
    }
  })
}

export function buildImportPlan(input: ImportPlanInput): ImportPlan {
  const { schema, existingRows, grid, mappings, primaryKeyColumnId } = input

  // Resolve each non-skipped mapping to the concrete column it writes, with the
  // type + config needed to coerce incoming string cells.
  const active = mappings
    .filter((m) => m.target.kind !== 'skip')
    .map((m) => {
      const t = m.target as Exclude<ColumnTarget, { kind: 'skip' }>
      if (t.kind === 'existing') {
        const col = schema.columns.find((c) => c.id === t.columnId)
        return {
          sourceHeader: m.sourceHeader,
          columnId: t.columnId,
          type: (col?.type ?? 'text-short') as FieldType,
          config: (col?.config ?? {}) as unknown
        }
      }
      return { sourceHeader: m.sourceHeader, columnId: t.columnId, type: t.type, config: {} as unknown }
    })

  const newColumns: NewColumn[] = mappings
    .filter(
      (m): m is ColumnMapping & { target: Extract<ColumnTarget, { kind: 'new' }> } =>
        m.target.kind === 'new'
    )
    .map((m) => ({ id: m.target.columnId, label: m.target.label, type: m.target.type }))

  const pkActive = primaryKeyColumnId
    ? active.find((a) => a.columnId === primaryKeyColumnId) ?? null
    : null
  const pkIsExisting = primaryKeyColumnId
    ? schema.columns.some((c) => c.id === primaryKeyColumnId)
    : false

  // Index existing rows by their primary-key value, but only when the key is an
  // existing column (a brand-new key column has no values to match against).
  const existingByKey = new Map<string, string>()
  if (pkActive && pkIsExisting) {
    for (const r of existingRows) {
      const k = norm(r.cells[primaryKeyColumnId as string])
      if (k !== '' && !existingByKey.has(k)) existingByKey.set(k, r.id)
    }
  }

  // Build coerced cells per grid row, dropping wholly empty rows.
  let rowsSkipped = 0
  const built: Array<{ key: string | null; cells: Record<string, unknown> }> = []
  for (const row of grid.rows) {
    const hasAny = active.some((a) => (row[a.sourceHeader] ?? '').trim() !== '')
    if (!hasAny) {
      rowsSkipped++
      continue
    }
    const cells: Record<string, unknown> = {}
    for (const a of active) {
      cells[a.columnId] = coerceCellValue(a.type, row[a.sourceHeader] ?? '', a.config)
    }
    const key = pkActive ? norm(row[pkActive.sourceHeader]) : null
    built.push({ key: key === '' ? null : key, cells })
  }

  const ops: RowOp[] = []
  let inserted = 0
  let updated = 0

  if (pkActive) {
    // Collapse duplicate incoming keys (last occurrence wins, merging cells) so
    // one source key maps to exactly one row operation.
    const byKey = new Map<string, Record<string, unknown>>()
    const noKey: Array<Record<string, unknown>> = []
    for (const b of built) {
      if (b.key === null) {
        noKey.push(b.cells)
        continue
      }
      byKey.set(b.key, { ...(byKey.get(b.key) ?? {}), ...b.cells })
    }
    for (const [key, cells] of byKey) {
      const rowId = existingByKey.get(key)
      if (rowId) {
        ops.push({ op: 'update', rowId, cells })
        updated++
      } else {
        ops.push({ op: 'insert', cells })
        inserted++
      }
    }
    for (const cells of noKey) {
      ops.push({ op: 'insert', cells })
      inserted++
    }
  } else {
    for (const b of built) {
      ops.push({ op: 'insert', cells: b.cells })
      inserted++
    }
  }

  return {
    newColumns,
    ops,
    summary: { inserted, updated, columnsAdded: newColumns.length, rowsSkipped }
  }
}

/**
 * Turn the rows of a brand-new-table import draft into cells a table can read.
 *
 * The main-process importer (src/main/fileImport.ts, gridImport.ts) hands back
 * rows keyed by the column's human LABEL, because that keeps the draft readable
 * in logs and lets the e2e spec assert on it. A table, though, stores and reads
 * each cell under the column's ID. Writing the label-keyed object straight into
 * createRow produced a table with the right columns and the right number of
 * rows and every cell blank (help audit item 14c). This maps each label to its
 * column id and coerces the string to the column's type, the same coercion the
 * import-into-existing-table wizard uses, so "80" in a number column is 80 and
 * "yes" in a checkbox column is true.
 *
 * A key that names no column is dropped rather than written under a key the
 * table will never read.
 */
export function draftRowToCells(
  schema: TableSchema,
  row: Record<string, string>
): Record<string, unknown> {
  const cells: Record<string, unknown> = {}
  for (const col of schema.columns) {
    if (!(col.label in row)) continue
    cells[col.id] = coerceCellValue(col.type, row[col.label] ?? '', col.config ?? {})
  }
  return cells
}
