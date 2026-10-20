// Tabular file reader shared by two flows: the existing drop-or-pick that turns
// a spreadsheet into a brand new table, and the new "import into THIS table"
// wizard that maps columns and upserts rows. It reads CSV, JSON (array of
// objects), XLS, and XLSX into a normalised { headers, rows } grid where every
// cell is a string keyed by its header label.

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import * as XLSX from 'xlsx'
import * as nodeFs from 'fs'

// SheetJS 0.20 stopped auto-requiring node's fs so bundlers do not pull it in,
// so readFile needs it handed over explicitly.
//
// The failure mode is silence, not an exception: writeFile writes nothing and
// readFile then reports it cannot access the file. It depends on module
// format. Under CommonJS, which is what this app's main process is built as,
// SheetJS still finds fs on its own, so the 0.18 to 0.20 bump did not break
// the shipped import — the vitest (ESM) run is where it surfaced.
//
// Binding it anyway, because "works only because the bundle happens to be
// CommonJS" is a trap set for whoever changes the build format, and the
// symptom they would get is a file import that fails with no error to explain
// it.
XLSX.set_fs(nodeFs)
import type { TableSchema, FieldDefinition } from '@shared/fields'
import { inferColumnType } from '@shared/gridInfer'
import { parseCsv, type ImportTableDraft } from './fileImport'

export { inferColumnType }

export interface ParsedGrid {
  headers: string[]
  rows: Record<string, string>[]
}

export type ParseGridResult =
  | { ok: true; grid: ParsedGrid }
  | { ok: false; error: string }

export const GRID_EXTENSIONS = ['csv', 'json', 'xls', 'xlsx'] as const

export async function parseGridFromFile(path: string): Promise<ParseGridResult> {
  const ext = extname(path).toLowerCase().replace(/^\./, '')
  try {
    if (ext === 'csv') {
      const raw = await readFile(path, 'utf-8')
      return { ok: true, grid: gridFromMatrix(parseCsv(raw)) }
    }
    if (ext === 'json') {
      const raw = await readFile(path, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        return { ok: false, error: 'To import as table rows the JSON must be an array of objects.' }
      }
      const objs = parsed.filter(
        (x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
      )
      if (objs.length === 0) {
        return { ok: false, error: 'No objects found in the JSON array.' }
      }
      return { ok: true, grid: gridFromObjects(objs) }
    }
    if (ext === 'xls' || ext === 'xlsx') {
      const wb = XLSX.readFile(path, { cellDates: false })
      const first = wb.SheetNames[0]
      const sheet = first ? wb.Sheets[first] : undefined
      if (!sheet) return { ok: false, error: 'The spreadsheet has no sheets.' }
      const matrix = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: ''
      }) as unknown[][]
      const stringMatrix = matrix.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))))
      return { ok: true, grid: gridFromMatrix(stringMatrix) }
    }
    return { ok: false, error: `Unsupported file type ".${ext}". Use CSV, JSON, XLS, or XLSX.` }
  } catch (err) {
    return { ok: false, error: `Could not read file: ${(err as Error).message}` }
  }
}

function gridFromMatrix(matrix: string[][]): ParsedGrid {
  const nonEmpty = matrix.filter((r) => r.some((c) => (c ?? '').toString().trim() !== ''))
  if (nonEmpty.length === 0) return { headers: [], rows: [] }
  const headers = nonEmpty[0].map((h, i) => (String(h ?? '').trim() || `Column ${i + 1}`))
  const rows = nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => {
      obj[h] = (r[i] ?? '').toString()
    })
    return obj
  })
  return { headers, rows }
}

function gridFromObjects(objs: Record<string, unknown>[]): ParsedGrid {
  const headers: string[] = []
  const seen = new Set<string>()
  for (const o of objs) {
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) {
        seen.add(k)
        headers.push(k)
      }
    }
  }
  const rows = objs.map((o) => {
    const obj: Record<string, string> = {}
    for (const h of headers) {
      const v = o[h]
      obj[h] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    }
    return obj
  })
  return { headers, rows }
}

// Turn a parsed grid into a brand-new-table draft (the drop / pick flow). The
// wizard does NOT use this; it maps onto an existing schema instead.
export function gridToTableDraft(
  grid: ParsedGrid,
  title: string,
  sourcePath: string
): ImportTableDraft {
  const schema: TableSchema = {
    columns: grid.headers.map((label, i) => {
      const sample = grid.rows.slice(0, 20).map((r) => (r[label] ?? '').trim()).filter((v) => v !== '')
      return {
        id: `c-${Date.now().toString(36)}-${i}`,
        type: inferColumnType(sample),
        label,
        config: {} as FieldDefinition['config']
      } as FieldDefinition
    })
  }
  const rows = grid.rows.filter((r) => Object.values(r).some((v) => (v ?? '').trim() !== ''))
  return { kind: 'table', title, schema, rows, sourcePath }
}
