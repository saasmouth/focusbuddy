import { useEffect, useRef } from 'react'
import type { SheetCellFormat, SheetMerge, SheetNumberFormat, SheetTab, SheetValidation, SheetValidationRule } from '@shared/types'
import type { SheetSnippetBody, Snippet, SnippetInsertResult, SnippetTarget } from '@shared/snippets'
import { rewriteFormulaRefs, remapFormulaRefs } from '../../../lib/sheetFormula'
import { colLabel, fmtKey, parseFmtKey } from '../../../lib/sheetBody'
import { parseA1Range } from '../../../lib/sheetCond'
import { writeMatrix, type CellRange } from './sheetOps'
import { registerSnippetTarget } from '../../../stores/snippets'
import { insertIntoOffice, officeAccepts } from '../../../lib/officeSnippets'

// PlexiiCells as a snippet surface: how a selected range becomes a saved
// snippet, and how a saved one gets back onto a sheet.
//
// A sheet snippet is copy and paste of a range with a name, and it runs Cells'
// own paste code. Cells' ⌘V for an in-app copy remembers where the copy came
// from and shifts every formula's RELATIVE references by (destination minus
// origin) through the engine's rewriteFormulaRefs, keeping absolute ($) parts
// pinned, then writes the block with writeMatrix at the active cell. A snippet
// stores the same two things (the cells' input and the origin) and does the
// same: =A1+A2 saved from A3 and inserted at C3 reads =C1+C2. References that
// point OUTSIDE the block shift too, because that is what pasting does (here
// and in Excel); a reference that would shift above row 1 or left of column A
// is declined with the cell named, not repointed (see insertSheetSnippet).
//
// What it does not carry is said at SAVE time, naming what the selection
// actually had (sheetSnippetNotKept), so a missing scale or width is a known
// limit rather than a quiet loss.
//
// It carries more than ⌘V does today, because ⌘V goes through the system
// clipboard as plain TSV and so drops everything but the values. A snippet is
// stored, so it carries what an Excel paste of the range carries: per-cell
// formats, merges inside the range, and data validation over it. It does NOT
// carry conditional formats (a scale or data-bar rule is computed over its
// whole range, so a clipped copy would change meaning), column widths or row
// heights (properties of whole columns and rows, which paste leaves alone),
// charts, pivots or widgets (objects over the sheet, not cells in it).
//
// DUPLICATE ONLY, on purpose. See "Why a spreadsheet offers Duplicate only" in
// docs/saved-snippets.md.

/** The largest sheet XLSX can hold (Excel's grid). A block past it could never be exported. */
export const SHEET_MAX_ROWS = 1_048_576
export const SHEET_MAX_COLS = 16_384

/** The link modes a spreadsheet honours. Exported so the unit test asserts the real list. */
export const CELLS_SNIPPET_LINKS: SnippetTarget['supports'] = ['duplicate']

/** The registry id for a spreadsheet surface. One place, so host and picker agree. */
export function cellsSnippetTargetId(instanceId: string): string {
  return `sheet:${instanceId}`
}

/** "B3", "B3:D7": how a range reads to a person. */
export function a1(r0: number, c0: number, r1 = r0, c1 = c0): string {
  const tl = `${colLabel(c0)}${r0 + 1}`
  return r0 === r1 && c0 === c1 ? tl : `${tl}:${colLabel(c1)}${r1 + 1}`
}

// ── Capture ──────────────────────────────────────────────────────────────────

/**
 * Widen a range until no merge crosses its edge, which is what Excel's own
 * selection does: a merged cell is selected whole or not at all. Without this
 * a block could carry half a merge, whose anchor value then lands unmerged.
 */
export function expandToMerges(tab: SheetTab, range: CellRange): CellRange {
  let r = { ...range }
  for (let grew = true; grew; ) {
    grew = false
    for (const m of tab.merges ?? []) {
      const meets = m.r1 <= r.r1 && m.r2 >= r.r0 && m.c1 <= r.c1 && m.c2 >= r.c0
      if (!meets) continue
      const next = { r0: Math.min(r.r0, m.r1), c0: Math.min(r.c0, m.c1), r1: Math.max(r.r1, m.r2), c1: Math.max(r.c1, m.c2) }
      if (next.r0 !== r.r0 || next.c0 !== r.c0 || next.r1 !== r.r1 || next.c1 !== r.c1) {
        r = next
        grew = true
      }
    }
  }
  return r
}

/**
 * Turn a selected range into a sheet snippet body.
 *
 * Pure. Returns null when there is no tab or range, or when the range holds
 * nothing at all (no text, no format, no merge, no validation), rather than an
 * empty body: the caller must tell "nothing to save" from "saved something".
 *
 * Cells hold their INPUT, so a formula is saved as written, with the range's
 * top-left as `origin` for the reference shift on insert. Formats, merges and
 * validation are made relative to that top-left. A merge crossing the range's
 * edge widens the range to take it whole, as Excel's selection does. Nothing
 * in the body shares an object with the tab.
 */
export function sheetBodyFromSelection(tab: SheetTab | null | undefined, selection: CellRange | null | undefined): SheetSnippetBody | null {
  if (!tab || !selection) return null
  const sel = normalise(selection)
  if (sel.r0 < 0 || sel.c0 < 0) return null
  const range = expandToMerges(tab, sel)
  const { r0, c0, r1, c1 } = range

  const rows: string[][] = []
  for (let r = r0; r <= r1; r++) {
    const row: string[] = []
    for (let c = c0; c <= c1; c++) row.push(tab.rows[r]?.[c] ?? '')
    rows.push(row)
  }

  const formats: Record<string, SheetCellFormat> = {}
  for (const [key, f] of Object.entries(tab.formats ?? {})) {
    const { r, c } = parseFmtKey(key)
    if (r < r0 || r > r1 || c < c0 || c > c1 || !f || !Object.keys(f).length) continue
    formats[fmtKey(r - r0, c - c0)] = clone(f)
  }

  const merges = (tab.merges ?? [])
    .filter((m) => m.r1 >= r0 && m.r2 <= r1 && m.c1 >= c0 && m.c2 <= c1)
    .map((m) => ({ r1: m.r1 - r0, c1: m.c1 - c0, r2: m.r2 - r0, c2: m.c2 - c0 }))

  // Validation is a rule over a range; the part of each range inside the block
  // travels, in the tab's order (the last rule covering a cell wins).
  const validations: NonNullable<SheetSnippetBody['validations']> = []
  for (const v of tab.validations ?? []) {
    const p = parseA1Range(v.range)
    if (!p) continue
    const cut = intersect({ r0: p.r1, c0: p.c1, r1: p.r2, c1: p.c2 }, range)
    if (!cut) continue
    validations.push({ r1: cut.r0 - r0, c1: cut.c0 - c0, r2: cut.r1 - r0, c2: cut.c1 - c0, rule: clone(v.rule), ...(v.strict ? { strict: true } : {}) })
  }

  const hasText = rows.some((row) => row.some((v) => v.trim() !== ''))
  if (!hasText && !Object.keys(formats).length && !merges.length && !validations.length) return null

  return {
    kind: 'sheet',
    rows,
    origin: { r: r0, c: c0 },
    ...(Object.keys(formats).length ? { formats } : {}),
    ...(merges.length ? { merges } : {}),
    ...(validations.length ? { validations } : {})
  }
}

/**
 * One line for the save dialog naming what this selection has that a snippet
 * will not keep, or null when it has none of it. Reads the same widened range
 * capture reads, so it describes exactly what is being saved.
 */
export function sheetSnippetNotKept(tab: SheetTab | null | undefined, selection: CellRange | null | undefined): string | null {
  if (!tab || !selection) return null
  const range = expandToMerges(tab, normalise(selection))
  const lost: string[] = []
  const cond = (tab.condRules ?? []).some((rule) => {
    const p = parseA1Range(rule.range)
    return !!p && !!intersect({ r0: p.r1, c0: p.c1, r1: p.r2, c1: p.c2 }, range)
  })
  if (cond) lost.push('Conditional formatting')
  const inRange = (map: Record<number, number> | undefined, lo: number, hi: number): boolean =>
    Object.keys(map ?? {}).some((k) => Number(k) >= lo && Number(k) <= hi)
  if (inRange(tab.colWidths, range.c0, range.c1)) lost.push('column widths')
  if (inRange(tab.rowHeights, range.r0, range.r1)) lost.push('row heights')
  if (!lost.length) return null
  const list = lost.length === 1 ? lost[0] : `${lost.slice(0, -1).join(', ')} and ${lost[lost.length - 1]}`
  const sentence = list.charAt(0).toUpperCase() + list.slice(1)
  return `${sentence} ${lost.length === 1 && !lost[0].endsWith('s') ? 'is' : 'are'} not saved with a snippet.`
}

/** A default name for the save dialog: the first words in the block, or its size. */
export function suggestedSheetSnippetName(body: SheetSnippetBody): string {
  for (const row of body.rows) {
    for (const v of row) {
      const t = typeof v === 'string' ? v.trim() : ''
      if (!t || t.startsWith('=')) continue
      const cut = t.length > 60 ? t.slice(0, 57).replace(/\s+\S*$/, '') : t
      return cut.replace(/[:.,;\s]+$/, '') || cut
    }
  }
  const h = body.rows.length
  const w = Math.max(0, ...body.rows.map((r) => r.length))
  return h === 1 && w === 1 ? 'Cell' : `${h} × ${w} cells`
}

// ── Insertion ────────────────────────────────────────────────────────────────

export interface SheetSnippetPlacement {
  /** Where the block's top-left lands: the selection's top-left, as a paste. Null when no cell is active. */
  at: { r: number; c: number } | null
  /** The sheet cannot be edited right now. */
  readOnly: boolean
  /** Mints a validation id the way the validation dialog does. */
  newId: () => string
}

export type SheetSnippetLanding = { tab: SheetTab; range: CellRange } | { declined: string }

/**
 * The tab with a sheet snippet pasted into it, and the range it now covers;
 * or the reason it was declined.
 *
 * Pure, and never mutates the snippet or the tab: the body is untrusted (it
 * has been through the database), so every part is read defensively and
 * cloned. What lands is what pasting the saved range at `at` would land:
 *
 *  - the block's cells overwrite the cells under it, blank ones included,
 *    without asking, as ⌘V does (writeMatrix, which also grows the tab);
 *  - formulas shift by (at minus origin) through rewriteFormulaRefs, relative
 *    parts only; a body with no origin is written literally;
 *  - the formats, merges and validation of the cells under the block are
 *    replaced by the block's own, as an Excel paste replaces them.
 *
 * Declines when the sheet is read-only, the snippet is not a sheet snippet or
 * holds no cells, the block would run past the sheet's limits, a merge
 * crosses the block's edge on the destination (Excel: "you can't change part
 * of a merged cell"), or a formula's reference would shift above row 1 or
 * left of column A. Cells' paste clamps such a reference to row 1 / column A,
 * which silently repoints it; a snippet names the cell instead.
 */
export function insertSheetSnippet(tab: SheetTab, snippet: Snippet, place: SheetSnippetPlacement): SheetSnippetLanding {
  if (place.readOnly) return { declined: 'This spreadsheet is read-only.' }
  if (snippet.kind !== 'sheet' || snippet.body?.kind !== 'sheet') return { declined: 'That snippet is not a block of cells.' }
  const body = snippet.body
  const raw = Array.isArray(body.rows) ? body.rows : []
  const h = raw.length
  const w = Math.max(0, ...raw.map((r) => (Array.isArray(r) ? r.length : 0)))
  if (!h || !w) return { declined: 'That snippet holds no cells.' }

  const at = place.at
  if (!at || !Number.isInteger(at.r) || !Number.isInteger(at.c) || at.r < 0 || at.c < 0) {
    return { declined: 'Select the cell the block should start at first.' }
  }
  const top = at.r
  const left = at.c
  const range: CellRange = { r0: top, c0: left, r1: top + h - 1, c1: left + w - 1 }
  if (range.r1 >= SHEET_MAX_ROWS || range.c1 >= SHEET_MAX_COLS) {
    return {
      declined: `The ${h} × ${w} block would run past the sheet's last ${range.r1 >= SHEET_MAX_ROWS ? `row (${SHEET_MAX_ROWS.toLocaleString('en-GB')})` : `column (${colLabel(SHEET_MAX_COLS - 1)})`} from ${a1(top, left)}.`
    }
  }

  // A merge on the destination that the block cuts through cannot be half
  // overwritten; one wholly under the block is replaced by the block's own.
  const kept: SheetMerge[] = []
  for (const m of tab.merges ?? []) {
    const inside = m.r1 >= range.r0 && m.r2 <= range.r1 && m.c1 >= range.c0 && m.c2 <= range.c1
    const meets = m.r1 <= range.r1 && m.r2 >= range.r0 && m.c1 <= range.c1 && m.c2 >= range.c0
    if (inside) continue
    if (meets) return { declined: `The block at ${a1(range.r0, range.c0, range.r1, range.c1)} would cut through the merged cells ${a1(m.r1, m.c1, m.r2, m.c2)}. Unmerge them or choose another cell.` }
    kept.push(m)
  }

  // The cells, padded to the block's width (ragged rows are padded on insert,
  // never on save), with formulas shifted the way paste shifts them.
  const origin = readOrigin(body.origin)
  const dr = origin ? top - origin.r : 0
  const dc = origin ? left - origin.c : 0
  const matrix: string[][] = []
  for (let i = 0; i < h; i++) {
    const src = Array.isArray(raw[i]) ? raw[i] : []
    const row: string[] = []
    for (let j = 0; j < w; j++) {
      const v = cellInput(src[j])
      if (origin && (dr || dc) && v.trim().startsWith('=')) {
        const shifted = rewriteFormulaRefs(v, dr, dc)
        if (wouldUnderflow(v, shifted, dr, dc)) {
          return {
            declined: `Placed at ${a1(top, left)}, the formula landing in ${a1(top + i, left + j)} would point above row 1 or left of column A. Insert the block lower down or further right.`
          }
        }
        row.push(shifted)
      } else row.push(v)
    }
    matrix.push(row)
  }

  let next = writeMatrix(tab, top, left, matrix)

  // Formats: the block's replace whatever the cells under it had.
  const formats: Record<string, SheetCellFormat> = {}
  for (const [key, f] of Object.entries(tab.formats ?? {})) {
    const { r, c } = parseFmtKey(key)
    if (r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1) continue
    formats[key] = f
  }
  for (const [key, f] of Object.entries(body.formats ?? {})) {
    const { r, c } = parseFmtKey(key)
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= h || c >= w) continue
    const fmt = readFormat(f)
    if (fmt) formats[fmtKey(top + r, left + c)] = fmt
  }

  // Merges: the block's own, where they are whole, inside it, and do not overlap.
  const merges = [...kept]
  const placed: SheetMerge[] = []
  for (const m of Array.isArray(body.merges) ? body.merges : []) {
    const rect = readRect(m, h, w)
    if (!rect || (rect.r0 === rect.r1 && rect.c0 === rect.c1)) continue
    const abs = { r1: top + rect.r0, c1: left + rect.c0, r2: top + rect.r1, c2: left + rect.c1 }
    if (placed.some((p) => p.r1 <= abs.r2 && p.r2 >= abs.r1 && p.c1 <= abs.c2 && p.c2 >= abs.c1)) continue
    placed.push(abs)
  }
  merges.push(...placed)

  // Validation: the destination's rules lose the cells under the block (a
  // rule split around it keeps its rule on what is left), then the block's
  // rules land over it with fresh ids.
  const validations: SheetValidation[] = []
  for (const v of tab.validations ?? []) {
    const p = parseA1Range(v.range)
    if (!p) {
      validations.push(v)
      continue
    }
    const pieces = subtract({ r0: p.r1, c0: p.c1, r1: p.r2, c1: p.c2 }, range)
    pieces.forEach((piece, k) => validations.push({ ...v, id: k === 0 ? v.id : place.newId(), range: a1(piece.r0, piece.c0, piece.r1, piece.c1) }))
  }
  for (const v of Array.isArray(body.validations) ? body.validations : []) {
    const rect = readRect(v, h, w)
    const rule = readRule((v as { rule?: unknown })?.rule)
    if (!rect || !rule) continue
    validations.push({
      id: place.newId(),
      range: a1(top + rect.r0, left + rect.c0, top + rect.r1, left + rect.c1),
      rule,
      ...((v as { strict?: unknown }).strict === true ? { strict: true } : {})
    })
  }

  next = { ...next, formats }
  if (merges.length || tab.merges) next = { ...next, merges }
  if (validations.length || tab.validations) next = { ...next, validations }
  return { tab: next, range }
}

/**
 * Register a mounted spreadsheet as a place sheet snippets can go.
 *
 * `instanceId` is the MOUNTED SURFACE (the editor's React `useId`), not the
 * document: the same workbook in the editor and in a desk widget is two
 * destinations, and a closed one is none.
 *
 * `insert` changes every render (it closes over the current tab and
 * selection), so it is read through a ref updated each render rather than
 * re-registering on every keystroke. The registry calls the ref, and the ref
 * is always this render's function, so it never runs a stale closure.
 */
export function useCellsSnippetTarget(instanceId: string, title: string, insert: (snippet: Snippet) => SnippetInsertResult): void {
  const ref = useRef(insert)
  ref.current = insert
  useEffect(() => registerSnippetTarget(cellsSnippetTarget(instanceId, title, (s) => ref.current(s))), [instanceId, title])
}

/**
 * The target a mounted spreadsheet registers. Pure, so its contract is
 * unit-testable. It takes every kind with a conversion into cells (rows of
 * values: a document's table, a text work widget), converted and then pasted
 * through the same insert as a sheet snippet; pictures are refused with the
 * builder's reason.
 */
export function cellsSnippetTarget(instanceId: string, title: string, insert: (snippet: Snippet) => SnippetInsertResult): SnippetTarget {
  return {
    id: cellsSnippetTargetId(instanceId),
    label: title?.trim() ? `“${title.trim()}”` : 'This spreadsheet',
    accepts: officeAccepts('sheet'),
    host: 'sheet',
    supports: CELLS_SNIPPET_LINKS,
    insert: (snippet, link) => insertIntoOffice(snippet, link, 'sheet', (s, l) => (l === 'duplicate' ? insert(s) : false))
  }
}

/** A validation id the way the validation dialog mints one, unique within a burst. */
let seq = 0
export function newValidationId(): string {
  seq = (seq + 1) % 1_000_000
  return `dv-${Date.now().toString(36)}-s${seq}`
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalise(r: CellRange): CellRange {
  return { r0: Math.min(r.r0, r.r1), c0: Math.min(r.c0, r.c1), r1: Math.max(r.r0, r.r1), c1: Math.max(r.c0, r.c1) }
}

function intersect(a: CellRange, b: CellRange): CellRange | null {
  const r0 = Math.max(a.r0, b.r0)
  const c0 = Math.max(a.c0, b.c0)
  const r1 = Math.min(a.r1, b.r1)
  const c1 = Math.min(a.c1, b.c1)
  return r0 <= r1 && c0 <= c1 ? { r0, c0, r1, c1 } : null
}

/** `a` minus `b`, as up to four rectangles (above, below, left, right). */
export function subtract(a: CellRange, b: CellRange): CellRange[] {
  const cut = intersect(a, b)
  if (!cut) return [a]
  const out: CellRange[] = []
  if (a.r0 < cut.r0) out.push({ r0: a.r0, c0: a.c0, r1: cut.r0 - 1, c1: a.c1 })
  if (cut.r1 < a.r1) out.push({ r0: cut.r1 + 1, c0: a.c0, r1: a.r1, c1: a.c1 })
  if (a.c0 < cut.c0) out.push({ r0: cut.r0, c0: a.c0, r1: cut.r1, c1: cut.c0 - 1 })
  if (cut.c1 < a.c1) out.push({ r0: cut.r0, c0: cut.c1 + 1, r1: cut.r1, c1: a.c1 })
  return out
}

/**
 * Did shifting this formula clamp a reference at row 1 or column A? The
 * engine clamps rather than failing, so shift the result back: a clean shift
 * returns to the original (as the engine prints it), a clamped one does not.
 */
function wouldUnderflow(original: string, shifted: string, dr: number, dc: number): boolean {
  const printed = remapFormulaRefs(original.trim(), (i) => i, (i) => i)
  return rewriteFormulaRefs(shifted.trim(), -dr, -dc) !== printed
}

function cellInput(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return ''
}

function readOrigin(o: unknown): { r: number; c: number } | null {
  if (!o || typeof o !== 'object') return null
  const { r, c } = o as { r?: unknown; c?: unknown }
  return Number.isInteger(r) && Number.isInteger(c) && (r as number) >= 0 && (c as number) >= 0 ? { r: r as number, c: c as number } : null
}

/** A relative, inclusive rectangle wholly inside an h × w block, or null. */
function readRect(raw: unknown, h: number, w: number): CellRange | null {
  if (!raw || typeof raw !== 'object') return null
  const { r1, c1, r2, c2 } = raw as Record<string, unknown>
  if (![r1, c1, r2, c2].every((n) => Number.isInteger(n))) return null
  const r = normalise({ r0: r1 as number, c0: c1 as number, r1: r2 as number, c1: c2 as number })
  if (r.r0 < 0 || r.c0 < 0 || r.r1 >= h || r.c1 >= w) return null
  return r
}

const ALIGN = new Set(['left', 'center', 'right'])

/** A SheetCellFormat from an untrusted value: known fields of the right type, nothing else. */
function readFormat(raw: unknown): SheetCellFormat | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  const out: SheetCellFormat = {}
  for (const k of ['bold', 'italic', 'underline'] as const) if (typeof f[k] === 'boolean') out[k] = f[k] as boolean
  for (const k of ['color', 'bg', 'fontFamily'] as const) if (typeof f[k] === 'string' && f[k]) out[k] = f[k] as string
  if (typeof f.align === 'string' && ALIGN.has(f.align)) out.align = f.align as SheetCellFormat['align']
  const nf = readNumFmt(f.numFmt)
  if (nf) out.numFmt = nf
  return Object.keys(out).length ? out : null
}

function readNumFmt(raw: unknown): SheetNumberFormat | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  const dec = typeof n.decimals === 'number' && Number.isFinite(n.decimals) ? n.decimals : null
  switch (n.kind) {
    case 'general':
      return { kind: 'general' }
    case 'number':
      return dec === null ? null : { kind: 'number', decimals: dec, ...(typeof n.thousands === 'boolean' ? { thousands: n.thousands } : {}) }
    case 'currency':
      return dec === null || typeof n.symbol !== 'string' ? null : { kind: 'currency', decimals: dec, symbol: n.symbol }
    case 'percent':
      return dec === null ? null : { kind: 'percent', decimals: dec }
    case 'date':
      return typeof n.pattern === 'string' ? { kind: 'date', pattern: n.pattern } : null
    default:
      return null
  }
}

const OPS = new Set(['gt', 'lt', 'ge', 'le', 'eq', 'between'])

function readRule(raw: unknown): SheetValidationRule | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'list' && Array.isArray(r.values)) return { kind: 'list', values: r.values.filter((v): v is string => typeof v === 'string') }
  if (r.kind === 'textNotEmpty') return { kind: 'textNotEmpty' }
  if (r.kind === 'number' && typeof r.op === 'string' && OPS.has(r.op) && typeof r.value === 'number' && Number.isFinite(r.value)) {
    return {
      kind: 'number',
      op: r.op as 'gt',
      value: r.value,
      ...(typeof r.value2 === 'number' && Number.isFinite(r.value2) ? { value2: r.value2 } : {})
    }
  }
  return null
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
