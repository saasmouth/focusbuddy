// PlexiiCells' clipboard FORMAT: the names and the envelope every reader and
// writer of a Cells copy agrees on, on PlexiiDraw's pattern
// (shared/draw/clipboardFormat.ts): a kind, a version, and a refusal for a
// version this build does not understand, never a guess.
//
// What a Cells ⌘C / ⌘X (or Edit › Copy / Cut) writes, in ONE copy event, so
// the two flavours are one clipboard entry and can never disagree:
//   - text/plain: the range as TSV, the cells' input exactly as before
//     (sheetOps.rangeToTsv). Every other app, every text field and Cells' own
//     plain paste read this, unchanged;
//   - CELLS_CLIP_MIME: this envelope, as JSON. Chromium keeps it as web custom
//     data, which the main process hands to a paste in any of our apps
//     (main/appClipboard.ts, application/x-plexii-* only), and a paste event's
//     DataTransfer carries in the browser build.
//
// The envelope holds the range as a saved Cells snippet of it holds it
// (sheet/cellsSnippets.ts sheetBodyFromSelection: input with formulas as
// written, the origin, formats, merges, validation), plus the copied columns'
// widths, plus what each cell DISPLAYED on the sheet it was copied from. A
// saved snippet has only itself to compute from, so a formula reading a cell
// outside the block shows #REF!; a copy was made with the whole sheet there,
// so another app gets the value the person saw.
//
// Everything read back is UNTRUSTED: it has been through the system
// clipboard. parseCellsClipboard checks the shape and keeps only what is
// well-formed; the destination validates the body again on insert, as it
// does a saved snippet's.

import type { SheetSnippetBody } from './snippets'

/** The private clipboard type, set on the copy event's DataTransfer beside text/plain. */
export const CELLS_CLIP_MIME = 'application/x-plexii-cells'

export const CELLS_CLIPBOARD_KIND = 'plexiicells/clipboard'
export const CELLS_CLIPBOARD_VERSION = 1

/** What a PlexiiCells copy writes as JSON under CELLS_CLIP_MIME. */
export interface CellsClipboardPayload {
  kind: typeof CELLS_CLIPBOARD_KIND
  version: number
  /** The range as a saved sheet snippet of it, with `colWidths` for the copied columns. */
  body: SheetSnippetBody
  /**
   * What every cell of `body.rows` displayed on the source sheet, same shape.
   * Present only when the block holds a formula (otherwise the input IS what
   * it displays).
   */
  values?: string[][]
}

/** The envelope for a copy. */
export function buildCellsClipboard(body: SheetSnippetBody, values?: string[][] | null): CellsClipboardPayload {
  return {
    kind: CELLS_CLIPBOARD_KIND,
    version: CELLS_CLIPBOARD_VERSION,
    body,
    ...(values ? { values } : {})
  }
}

export function serializeCellsClipboard(p: CellsClipboardPayload): string {
  return JSON.stringify(p)
}

/** The sentence a paste shows when a newer PlexiiCells wrote the clipboard. */
export const CELLS_NEWER_REFUSAL = 'This was copied from a newer PlexiiCells, which this version cannot read. Update PlexiiCells to paste it here.'

export type CellsClipboardRead = { body: SheetSnippetBody; values: string[][] | null } | { refused: string }

/**
 * Read a Cells envelope. Null when the text is not one (not JSON, another
 * kind, no cells); `refused` when it is one of a version this build does not
 * know. The body comes back as a fresh object: rows as strings, and the
 * optional parts only when they have the right type. `values` only when it
 * matches the rows cell for cell, so a value can never land in another cell.
 */
export function parseCellsClipboard(text: string | null | undefined): CellsClipboardRead | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || (raw as { kind?: unknown }).kind !== CELLS_CLIPBOARD_KIND) return null
  if ((raw as { version?: unknown }).version !== CELLS_CLIPBOARD_VERSION) return { refused: CELLS_NEWER_REFUSAL }
  const b = (raw as { body?: unknown }).body as Record<string, unknown> | undefined
  if (!b || typeof b !== 'object' || b.kind !== 'sheet' || !Array.isArray(b.rows)) return null
  if (!b.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string'))) return null
  const rows = (b.rows as string[][]).map((r) => [...r])
  if (!rows.length || !rows.some((r) => r.length)) return null

  const body: SheetSnippetBody = { kind: 'sheet', rows }
  const o = b.origin as { r?: unknown; c?: unknown } | undefined
  if (o && typeof o === 'object' && Number.isInteger(o.r) && Number.isInteger(o.c) && (o.r as number) >= 0 && (o.c as number) >= 0) {
    body.origin = { r: o.r as number, c: o.c as number }
  }
  if (isRecord(b.formats)) body.formats = clone(b.formats)
  if (Array.isArray(b.merges)) body.merges = clone(b.merges) as SheetSnippetBody['merges']
  if (Array.isArray(b.validations)) body.validations = clone(b.validations) as SheetSnippetBody['validations']
  if (isRecord(b.colWidths)) {
    const widths: Record<number, number> = {}
    for (const [k, w] of Object.entries(b.colWidths)) {
      const c = Number(k)
      if (Number.isInteger(c) && c >= 0 && typeof w === 'number' && Number.isFinite(w) && w > 0) widths[c] = w
    }
    if (Object.keys(widths).length) body.colWidths = widths
  }

  const v = (raw as { values?: unknown }).values
  const values =
    Array.isArray(v) &&
    v.length === rows.length &&
    v.every((r, i) => Array.isArray(r) && r.length === rows[i].length && r.every((c) => typeof c === 'string'))
      ? (v as string[][]).map((r) => [...r])
      : null
  return { body, values }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
