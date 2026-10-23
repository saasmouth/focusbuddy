// Reading an .xlsx with SheetJS, without Electron: the half of the importer that
// both PlexiiCells' Import (sheetIo.ts) and a workbook dropped out of Files use,
// so a dropped workbook reads exactly as importing it would.
//
// worksheetToTab is the importer's worksheet → tab step (moved here from
// sheetIo.ts unchanged but for numbers under a format, below).
//
// readXlsxSheetForDrop is `files:readSheet`: a Files item's bytes, read HERE
// (the renderer passes an id, never a path or bytes), checked, and answered as
// the first sheet's used range in PlexiiCells' own snippet body, with a note for
// each thing the workbook has that the body does not keep. Every such note is
// DETECTED in the package (charts, pictures, shapes, pivot tables, comments,
// conditional formatting, data validation, macros): a line is said only for
// what is there, and nothing is claimed absent that was not looked for.
//
// Electron-free on purpose: the web build's worker runs this same module
// (src/web/worker/handlers.ts), over its own file store.

import * as XLSX from 'xlsx'
import { unzipSync, strFromU8 } from 'fflate'
import type { SheetTab, SheetNumberFormat, SheetCellFormat } from '@shared/types'
import type { SheetSnippetBody } from '@shared/snippets'
import { mapNumFmt } from '@shared/sheetNumFmt'
import { L, firstSheetOf } from '@shared/snippetForms/lossy'
import {
  XLSX_DROP_MAX_BYTES,
  XLSX_DROP_MAX_CELLS,
  XLSX_DROP_MAX_UNPACKED_BYTES,
  XLSX_EXT,
  XLSX_REASON,
  sheetTooManyCells,
  workbookTooLarge,
  type XlsxSheetRead
} from '@shared/xlsxSheet'
import { getFile, readFileBytes } from './db/files'

let seq = 0
function tabId(): string {
  seq += 1
  return `imp-${seq}`
}

/** One worksheet as a Cells tab: values or formulas, number formats, column widths, merges, row heights. */
export function worksheetToTab(ws: XLSX.WorkSheet, name: string): SheetTab {
  const ref = ws['!ref']
  if (!ref) return { id: tabId(), name, columns: ['A'], rows: [['']] }
  const range = XLSX.utils.decode_range(ref)
  const nCols = range.e.c - range.s.c + 1
  const nRows = range.e.r - range.s.r + 1
  const columns = Array.from({ length: nCols }, (_, i) => XLSX.utils.encode_col(range.s.c + i))
  const rows: string[][] = []
  const formats: Record<string, SheetNumberFormat> = {}

  for (let r = 0; r < nRows; r++) {
    const row: string[] = []
    for (let c = 0; c < nCols; c++) {
      const addr = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })
      const cell = ws[addr] as XLSX.CellObject | undefined
      if (!cell) {
        row.push('')
        continue
      }
      const nf = mapNumFmt(cell.z as string | undefined)
      // Prefer the formula (so it stays live in our engine); else the value.
      // A number under a format we model keeps its TRUE value and the format
      // shows it: Excel's formatted text ("$1,234.50", "25%") is text to our
      // engine, which counts it as 0 in arithmetic, and a percent format would
      // show "25%" as 2500%. Dates keep Excel's text (our date format reads a
      // date string, not Excel's day serial).
      if (cell.f) row.push(`=${cell.f}`)
      else if (cell.t === 'n' && typeof cell.v === 'number' && nf && nf.kind !== 'date') row.push(String(cell.v))
      else if (cell.w != null) row.push(String(cell.w))
      else if (cell.v != null) row.push(String(cell.v))
      else row.push('')
      if (nf) formats[`${r},${c}`] = nf
    }
    rows.push(row)
  }

  const tab: SheetTab = { id: tabId(), name, columns, rows }
  if (Object.keys(formats).length) {
    tab.formats = Object.fromEntries(Object.entries(formats).map(([k, numFmt]) => [k, { numFmt }]))
  }

  // Column widths (Excel gives char units or px; we store px). Indexed relative
  // to the tab's first column so it lines up with our columns[] array.
  const cols = ws['!cols'] as XLSX.ColInfo[] | undefined
  if (cols) {
    const colWidths: Record<number, number> = {}
    for (let i = 0; i < nCols; i++) {
      const ci = cols[range.s.c + i]
      if (!ci) continue
      // Prefer char width (wch) * 7 to invert our writer's px→char (px/7); wpx is
      // SheetJS's own conversion at a different metric, so it drifts.
      const px =
        ci.wch != null ? Math.round(ci.wch * 7) : ci.width != null ? Math.round(ci.width * 7) : ci.wpx != null ? ci.wpx : null
      if (px != null && px > 0) colWidths[i] = px
    }
    if (Object.keys(colWidths).length) tab.colWidths = colWidths
  }

  // Merged cell ranges. SheetJS exposes these as absolute-coordinate ranges; we
  // store them relative to the tab's own origin.
  const merges = ws['!merges'] as XLSX.Range[] | undefined
  if (merges?.length) {
    const rel = merges
      .map((m) => ({ r1: m.s.r - range.s.r, c1: m.s.c - range.s.c, r2: m.e.r - range.s.r, c2: m.e.c - range.s.c }))
      .filter((m) => m.r1 >= 0 && m.c1 >= 0 && (m.r2 > m.r1 || m.c2 > m.c1))
    if (rel.length) tab.merges = rel
  }

  // Row heights (Excel gives px or points; we store px).
  const rowInfos = ws['!rows'] as XLSX.RowInfo[] | undefined
  if (rowInfos) {
    const rowHeights: Record<number, number> = {}
    for (let r = 0; r < nRows; r++) {
      const ri = rowInfos[range.s.r + r]
      if (!ri) continue
      // Prefer points (hpt) converted to px to invert our writer's px→pt; SheetJS's
      // hpx echoes the point value rather than a true 96dpi px.
      const px = ri.hpt != null ? Math.round((ri.hpt * 96) / 72) : ri.hpx != null ? ri.hpx : null
      if (px != null && px > 0) rowHeights[r] = px
    }
    if (Object.keys(rowHeights).length) tab.rowHeights = rowHeights
  }

  return tab
}

// ── A workbook dropped out of Files ──────────────────────────────────────────

/** `files:readSheet`: the Files item `id`, read and checked here, as a sheet snippet body. */
export async function readXlsxSheetForDrop(id: unknown): Promise<XlsxSheetRead> {
  // An id, never a path: the row names the bytes, and the row is looked up here.
  if (typeof id !== 'string' || !id || id.length > 256) return { ok: false, code: 'missing', reason: XLSX_REASON.missing }
  const file = getFile(id)
  if (!file) return { ok: false, code: 'missing', reason: XLSX_REASON.missing }
  // The row's own type decides, not what the renderer said it was.
  const ext = (file.ext ?? '').replace(/^\./, '').toLowerCase()
  if (!XLSX_EXT.has(ext)) return { ok: false, code: 'unreadable', reason: XLSX_REASON.unreadable }
  // The cap before the read, from the row; again after, from the bytes.
  if (file.sizeBytes > XLSX_DROP_MAX_BYTES) return { ok: false, code: 'too-large', reason: workbookTooLarge(file.sizeBytes) }
  const read = await readFileBytes(file.id)
  if (!read) return { ok: false, code: 'bytes', reason: XLSX_REASON.bytes }
  return sheetFromXlsxBytes(read.bytes)
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b)
}

/** "EncryptedPackage" as a compound file's directory stores it (UTF-16LE). */
function holdsEncryptedPackage(bytes: Uint8Array): boolean {
  const name = 'EncryptedPackage'
  const needle = new Uint8Array(name.length * 2)
  for (let i = 0; i < name.length; i++) needle[i * 2] = name.charCodeAt(i)
  // The directory sits in the first sectors of any real encrypted workbook; a
  // bounded scan keeps a large file from being walked byte by byte.
  const end = Math.min(bytes.length - needle.length, 1024 * 1024)
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

type Files = Record<string, Uint8Array>

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
}

/** A part's path from a relationship target, relative to the part that holds the rels. */
function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromPart.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** The relationships of `part`: [type suffix, resolved target]. */
function relsOf(files: Files, part: string): Array<{ type: string; target: string }> {
  const dir = part.split('/').slice(0, -1).join('/')
  const base = part.split('/').pop()
  const key = findKey(files, `${dir ? dir + '/' : ''}_rels/${base}.rels`)
  if (!key) return []
  const out: Array<{ type: string; target: string }> = []
  for (const rel of strFromU8(files[key]).match(/<Relationship\b[^>]*>/g) ?? []) {
    const type = (attr(rel, 'Type') ?? '').split('/').pop() ?? ''
    const target = attr(rel, 'Target')
    if (!target || attr(rel, 'TargetMode') === 'External') continue
    out.push({ type, target: resolvePart(part, target) })
  }
  return out
}

/** Part names are case-insensitive in a package. */
function findKey(files: Files, path: string): string | undefined {
  if (files[path]) return path
  const lc = path.toLowerCase()
  return Object.keys(files).find((k) => k.toLowerCase() === lc)
}

/** The first sheet's part path (workbook order, which is SheetJS's SheetNames order). */
function firstSheetPart(files: Files): string | null {
  const wbKey = findKey(files, 'xl/workbook.xml')
  if (!wbKey) return null
  const first = /<sheet\b[^>]*>/.exec(strFromU8(files[wbKey]))?.[0]
  const rid = first ? attr(first, 'r:id') : undefined
  if (!rid) return null
  for (const rel of strFromU8(files[findKey(files, 'xl/_rels/workbook.xml.rels') ?? ''] ?? new Uint8Array()).match(/<Relationship\b[^>]*>/g) ?? []) {
    if (attr(rel, 'Id') === rid) {
      const t = attr(rel, 'Target')
      return t ? findKey(files, resolvePart(wbKey, t)) ?? null : null
    }
  }
  return null
}

/** What the first sheet (and the workbook, for macros) has that a sheet body does not keep. */
function detectDropped(files: Files, sheetPart: string | null, sheetXml: string): string[] {
  const notes: string[] = []
  let charts = false
  let pictures = false
  let shapes = false
  let pivots = false
  let comments = false
  if (sheetPart) {
    for (const rel of relsOf(files, sheetPart)) {
      if (rel.type === 'pivotTable') pivots = true
      else if (rel.type === 'comments' || rel.type === 'threadedComment') comments = true
      else if (rel.type === 'drawing') {
        for (const d of relsOf(files, rel.target)) {
          if (d.type === 'chart' || d.type === 'chartEx') charts = true
          else if (d.type === 'image') pictures = true
        }
        const key = findKey(files, rel.target)
        if (key && /<(?:\w+:)?sp\b/.test(strFromU8(files[key]))) shapes = true
      }
    }
  }
  if (charts) notes.push(L.charts)
  if (pictures) notes.push(L.pictures)
  if (shapes) notes.push(L.shapes)
  if (pivots) notes.push(L.pivotTables)
  if (comments) notes.push(L.comments)
  if (/<(?:\w+:)?conditionalFormatting\b/.test(sheetXml)) notes.push(L.conditionalFormatting)
  if (/<(?:\w+:)?dataValidation\b/.test(sheetXml)) notes.push(L.validation)
  if (Object.keys(files).some((k) => /^xl\/vbaProject\.bin$/i.test(k))) notes.push(L.macros)
  return notes
}

/** An 8-digit ARGB (as Excel stores colours) to #rrggbb, dropping alpha. */
function argbHex(argb: string | undefined): string | undefined {
  if (!argb) return undefined
  const h = argb.length === 8 ? argb.slice(2) : argb
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toLowerCase()}` : undefined
}

/** Is a font flag on? `<b/>` and `<b val="1"/>` are; `<b val="0"/>` is not. */
function flag(font: string, tag: 'b' | 'i' | 'u'): boolean {
  const m = new RegExp(`<${tag}\\b([^>]*)\\/?>`).exec(font)
  if (!m) return false
  const val = attr(m[1] ?? '', 'val')
  return val === undefined || (tag === 'u' ? val !== 'none' : val === '1' || val === 'true')
}

/**
 * The cell styles a sheet body can hold (bold, italic, underline, alignment,
 * text and fill colours given as RGB) by cellXfs index, from styles.xml.
 * SheetJS's community build does not read fonts or alignment, so this reads the
 * few attributes it needs straight from the package. Theme colours are left
 * out rather than guessed.
 */
function cellStyles(files: Files): Array<Partial<SheetCellFormat>> {
  const key = findKey(files, 'xl/styles.xml')
  if (!key) return []
  const xml = strFromU8(files[key])
  const block = (name: string): string => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(xml)?.[1] ?? ''
  const fonts = block('fonts').match(/<font\b[^>]*\/>|<font\b[^>]*>[\s\S]*?<\/font>/g) ?? []
  const fills = block('fills').match(/<fill\b[^>]*\/>|<fill\b[^>]*>[\s\S]*?<\/fill>/g) ?? []
  const xfs = block('cellXfs').match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) ?? []
  return xfs.map((xf) => {
    const out: Partial<SheetCellFormat> = {}
    const font = fonts[Number(attr(xf, 'fontId') ?? -1)]
    if (font) {
      if (flag(font, 'b')) out.bold = true
      if (flag(font, 'i')) out.italic = true
      if (flag(font, 'u')) out.underline = true
      const color = argbHex(/<color\b[^>]*\brgb="([0-9a-fA-F]+)"/.exec(font)?.[1])
      if (color && color !== '#000000') out.color = color
    }
    const fill = fills[Number(attr(xf, 'fillId') ?? -1)]
    if (fill && /patternType="solid"/.test(fill)) {
      const bg = argbHex(/<fgColor\b[^>]*\brgb="([0-9a-fA-F]+)"/.exec(fill)?.[1])
      if (bg && bg !== '#ffffff') out.bg = bg
    }
    const h = /<alignment\b[^>]*\bhorizontal="([^"]+)"/.exec(xf)?.[1]
    if (h === 'left' || h === 'right') out.align = h
    else if (h === 'center' || h === 'centerContinuous') out.align = 'center'
    return out
  })
}

/** Cell address → its cellXfs index, for the cells that name one. */
function cellStyleIndex(sheetXml: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of sheetXml.matchAll(/<c\b([^>]*?)\/?>/g)) {
    const r = attr(m[1] ?? '', 'r')
    const s = attr(m[1] ?? '', 's')
    if (r && s && s !== '0') out.set(r, Number(s))
  }
  return out
}

/**
 * The used range: the cells that hold a value or a formula, and the merges
 * over them. A worksheet's own dimension can run to the last FORMATTED cell
 * (often row 1,048,576), which is not data.
 */
function usedRange(ws: XLSX.WorkSheet): XLSX.Range | null {
  let r0 = Infinity
  let c0 = Infinity
  let r1 = -1
  let c1 = -1
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith('!')) continue
    const cell = ws[addr] as XLSX.CellObject
    if (!cell || (cell.f == null && (cell.v == null || String(cell.v).trim() === ''))) continue
    const { r, c } = XLSX.utils.decode_cell(addr)
    if (r < r0) r0 = r
    if (c < c0) c0 = c
    if (r > r1) r1 = r
    if (c > c1) c1 = c
  }
  if (r1 < 0) return null
  for (const m of (ws['!merges'] as XLSX.Range[] | undefined) ?? []) {
    // A merge that starts inside the data widens the range to its far edge.
    if (m.s.r >= r0 && m.s.r <= r1 && m.s.c >= c0 && m.s.c <= c1) {
      r1 = Math.max(r1, m.e.r)
      c1 = Math.max(c1, m.e.c)
    }
  }
  return { s: { r: r0, c: c0 }, e: { r: r1, c: c1 } }
}

/** A formula that reads another sheet or another workbook ("Sheet2!A1", "[1]Sheet1!A1"). */
function readsOtherSheet(f: string): boolean {
  // Outside string literals only: ="Total!" is not a reference.
  return /!/.test(f.replace(/"(?:[^"]|"")*"/g, ''))
}

/**
 * The bytes of an .xlsx or .xlsm as the first sheet's snippet body. Pure but
 * for SheetJS and fflate (no disk, no clock): every check that does not need
 * the database is here, so the tests drive it with real workbooks.
 */
export function sheetFromXlsxBytes(bytes: Uint8Array): XlsxSheetRead {
  if (bytes.byteLength > XLSX_DROP_MAX_BYTES) return { ok: false, code: 'too-large', reason: workbookTooLarge(bytes.byteLength) }
  // An encrypted workbook is not a zip at all but a compound file holding an
  // EncryptedPackage stream. Anything else that is not a zip is not a workbook
  // this reads (SheetJS would read random bytes as one cell of CSV).
  if (startsWith(bytes, CFB_MAGIC)) {
    return holdsEncryptedPackage(bytes)
      ? { ok: false, code: 'protected', reason: XLSX_REASON.protected }
      : { ok: false, code: 'unreadable', reason: XLSX_REASON.unreadable }
  }
  if (!startsWith(bytes, ZIP_MAGIC)) return { ok: false, code: 'unreadable', reason: XLSX_REASON.unreadable }

  let files: Files
  try {
    // Sized before anything is inflated: a small package can unpack to gigabytes.
    let unpacked = 0
    let tooBig = false
    files = unzipSync(bytes, {
      filter: (f) => {
        unpacked += f.originalSize
        if (unpacked > XLSX_DROP_MAX_UNPACKED_BYTES) tooBig = true
        return !tooBig
      }
    }) as Files
    if (tooBig) return { ok: false, code: 'too-large', reason: workbookTooLarge(bytes.byteLength) }
  } catch {
    return { ok: false, code: 'unreadable', reason: XLSX_REASON.unreadable }
  }
  if (!findKey(files, 'xl/workbook.xml')) return { ok: false, code: 'unreadable', reason: XLSX_REASON.unreadable }

  let wb: XLSX.WorkBook
  try {
    // Only the first sheet is parsed (sheets: 0). cellStyles reads column widths.
    wb = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellText: true, cellStyles: true, sheets: 0 })
  } catch (e) {
    if (/password|encrypt/i.test((e as Error)?.message ?? '')) return { ok: false, code: 'protected', reason: XLSX_REASON.protected }
    return { ok: false, code: 'unreadable', reason: XLSX_REASON.unreadable }
  }
  const sheetName = wb.SheetNames[0]
  const ws = sheetName ? wb.Sheets[sheetName] : undefined
  if (!sheetName || !ws) return { ok: false, code: 'unreadable', reason: XLSX_REASON.unreadable }

  const range = usedRange(ws)
  if (!range) return { ok: false, code: 'empty', reason: XLSX_REASON.empty }
  const cells = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1)
  if (cells > XLSX_DROP_MAX_CELLS) return { ok: false, code: 'too-large', reason: sheetTooManyCells(cells) }

  // A formula that reads another sheet cannot stay live: only the first sheet
  // comes in, and in PlexiiCells the same name would read a different tab. It
  // keeps the value Excel saved for it, and the note says so.
  let otherSheet = 0
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith('!')) continue
    const cell = ws[addr] as XLSX.CellObject
    if (cell?.f && readsOtherSheet(cell.f)) {
      delete cell.f
      otherSheet++
    }
  }

  const sheetPart = firstSheetPart(files)
  const sheetXml = sheetPart ? strFromU8(files[sheetPart]) : ''
  ws['!ref'] = XLSX.utils.encode_range(range)
  const tab = worksheetToTab(ws, sheetName)

  // Bold, italic, underline, alignment and RGB colours, merged onto the
  // number formats the importer read, keyed as the tab's formats are.
  const styles = cellStyles(files)
  const formats: Record<string, SheetCellFormat> = { ...(tab.formats ?? {}) }
  for (const [addr, xf] of cellStyleIndex(sheetXml)) {
    const style = styles[xf]
    if (!style || !Object.keys(style).length) continue
    const { r, c } = XLSX.utils.decode_cell(addr)
    if (r < range.s.r || r > range.e.r || c < range.s.c || c > range.e.c) continue
    const key = `${r - range.s.r},${c - range.s.c}`
    formats[key] = { ...style, ...(formats[key] ?? {}) }
  }

  const hasText = tab.rows.some((row) => row.some((v) => v.trim() !== ''))
  if (!hasText) return { ok: false, code: 'empty', reason: XLSX_REASON.empty }

  const body: SheetSnippetBody = {
    kind: 'sheet',
    rows: tab.rows,
    origin: { r: range.s.r, c: range.s.c },
    ...(Object.keys(formats).length ? { formats } : {}),
    ...(tab.merges?.length ? { merges: tab.merges } : {}),
    ...(tab.colWidths && Object.keys(tab.colWidths).length ? { colWidths: tab.colWidths } : {})
  }

  const notes: string[] = []
  if (wb.SheetNames.length > 1) notes.push(firstSheetOf(wb.SheetNames.length))
  if (otherSheet) notes.push(L.otherSheetFormulas)
  notes.push(...detectDropped(files, sheetPart, sheetXml))
  return { ok: true, body, sheetName, notes }
}
