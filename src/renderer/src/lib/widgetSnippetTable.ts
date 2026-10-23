// Rows (a sheet block, a pasted grid) written into a table work widget's
// fb_table, through the SAME planner the "Import into this table" wizard uses
// (lib/tableImport.ts), so a snippet, a paste and a file import of the same
// rows land identically: matched to columns by name when the rows have a
// heading row, by position when they do not, new columns typed from their
// values, and every cell coerced to its column's type.

import type { FieldDefinition, TableSchema } from '@shared/fields'
import { buildImportPlan, suggestMappings, type ImportPlan, type ParsedGrid } from './tableImport'

/** Headings made unique and never empty, so a grid row can be keyed by them. */
export function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>()
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`
    const key = base.toLowerCase()
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return n === 1 ? base : `${base} ${n}`
  })
}

/**
 * Rows as the import planner's grid. With a heading row, its cells name the
 * columns; without one, column i is the table's i-th column (or a new
 * "Column i" past the end), which is what pasting a block into a table means.
 */
export function rowsToGrid(schema: TableSchema, rows: string[][], header: boolean): ParsedGrid {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const names = header
    ? uniqueHeaders(Array.from({ length: width }, (_, i) => rows[0]?.[i] ?? ''))
    : uniqueHeaders(Array.from({ length: width }, (_, i) => schema.columns[i]?.label ?? ''))
  const data = header ? rows.slice(1) : rows
  return {
    headers: names,
    rows: data.map((r) => Object.fromEntries(names.map((h, i) => [h, String(r[i] ?? '')])))
  }
}

/** The plan for appending these rows to a table with this schema. */
export function planRowsIntoTable(
  schema: TableSchema,
  rows: string[][],
  header: boolean,
  newColumnId: (header: string, index: number) => string
): ImportPlan {
  const grid = rowsToGrid(schema, rows, header)
  const mappings = suggestMappings(schema, grid, newColumnId)
  return buildImportPlan({ schema, existingRows: [], grid, mappings, primaryKeyColumnId: null })
}

/** A fresh column id, the shape the table widget mints. */
export function freshColumnId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** The schema after the plan's new columns are added. */
export function schemaWithPlan(schema: TableSchema, plan: ImportPlan, defaultConfig: (t: FieldDefinition['type']) => unknown): TableSchema {
  if (!plan.newColumns.length) return schema
  const added = plan.newColumns.map((c) => ({ id: c.id, type: c.type, label: c.label, config: defaultConfig(c.type) }) as FieldDefinition)
  return { ...schema, columns: [...schema.columns, ...added] }
}
