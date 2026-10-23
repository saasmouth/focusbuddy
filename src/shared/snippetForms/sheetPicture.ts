// A sheet as a PICTURE of its table: standalone SVG of what the cells display.
//
// Everything that can only hold a picture (PlexiiDraw, an image work widget)
// takes a sheet through this. The values are what Cells SHOWS: formulas
// already computed by the caller (formsOfSheet runs deps.evaluateSheet), then
// each cell's number format applied here with Cells' own formatter, so 0.25
// under a percent format reads 25%, exactly as the grid draws it.
//
// The table is drawn as a light card (white cells, grey rules, a tinted
// heading row) so it reads the same on a light or a dark canvas, like a page
// of a spreadsheet laid on it. Bold, italic, underline, alignment, text and
// fill colours from the cells' formats are kept; fonts are not (an SVG held as
// a picture cannot load a web font). Merged ranges are drawn merged.
//
// Bounded: at most MAX_ROWS × MAX_COLS cells are drawn, and the lossy list
// says how many of how many ("Showing the first 60 rows of 250."). Long cells
// are cut short with an ellipsis, measured with an estimate of the system
// font's widths, and clipped to their cell so an underestimate cannot spill.
//
// Pure and deterministic: no DOM, no clock, no randomness, no minted ids (the
// clip paths are named by column, which is unique inside one picture, and a
// picture is always held as its own data: URL). Never mutates its input. A
// sheet with no text in it has no picture: null, so the destination refuses
// honestly instead of placing a blank card.

import type { SnippetAppName, SvgValue } from '../snippetForms'
import type { SheetNumberFormat } from '../types'
import { formatValue } from '../sheetFormat'
import { L, columnsShown, rowsShown } from './lossy'
import { NUMERIC, looksLikeHeader } from './rows'

/** The most rows and columns a picture draws. Past them, the lossy list says so. */
export const SHEET_PICTURE_MAX_ROWS = 60
export const SHEET_PICTURE_MAX_COLS = 16

const FONT_SIZE = 13
const ROW_H = 24
const PAD_X = 8
/** An auto-sized column is never narrower or wider than this (px). */
const MIN_COL_W = 40
const MAX_AUTO_COL_W = 240
/** A width the sheet set is honoured, inside these bounds (px). */
const MIN_SET_COL_W = 16
const MAX_SET_COL_W = 600
/** Characters measured per cell: past this the cell is cut short anyway. */
const MEASURE_CAP = 400
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/** Neutral colours, legible on light and dark canvases (the card carries its own white). */
export const SHEET_PICTURE_COLOURS = {
  page: '#ffffff',
  rule: '#d1d5db',
  border: '#9ca3af',
  text: '#111827',
  headingFill: '#f3f4f6',
  labelFill: '#f9fafb',
  error: '#dc2626'
} as const

const ERROR_VALUE = /^#(ERR|DIV\/0!|N\/A|VALUE!|NAME\?|NUM!|REF!|SPILL!)$/
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export interface SheetPictureInput {
  /** What each cell displays (formulas already computed), row-major. Ragged rows are fine. */
  rows: string[][]
  /** Per-cell formats keyed "r,c" over `rows` (SheetCellFormat). Untrusted: read defensively. */
  formats?: Record<string, unknown>
  /** Merged ranges over `rows`, inclusive. Untrusted. */
  merges?: Array<{ r1: number; c1: number; r2: number; c2: number }>
  /** Column widths in px by column of `rows`, where the sheet set one. Untrusted. */
  colWidths?: Record<number, number>
  /** Where the editable original lives. */
  app: SnippetAppName
}

export interface SheetPicture {
  value: SvgValue
  /** What the picture leaves out, beyond being a picture (rows past the bound, cut cells, fonts). */
  lossy: string[]
}

interface CellStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  color?: string
  bg?: string
  align?: 'left' | 'center' | 'right'
  numFmt?: SheetNumberFormat
  font: boolean
}

function styleOf(raw: unknown): CellStyle {
  const f = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const colour = (v: unknown): string | undefined => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : undefined)
  const align = f.align === 'left' || f.align === 'center' || f.align === 'right' ? f.align : undefined
  const nf = f.numFmt && typeof f.numFmt === 'object' && typeof (f.numFmt as { kind?: unknown }).kind === 'string' ? (f.numFmt as SheetNumberFormat) : undefined
  return {
    bold: f.bold === true,
    italic: f.italic === true,
    underline: f.underline === true,
    color: colour(f.color),
    bg: colour(f.bg),
    align,
    numFmt: nf,
    font: typeof f.fontFamily === 'string' && f.fontFamily.trim() !== ''
  }
}

/**
 * Text as XML character data or an attribute value: & < > " ' escaped, and
 * every character XML 1.0 forbids (C0 controls but tab, newline and return;
 * U+FFFE, U+FFFF; a lone surrogate) left out, so no cell can break the markup.
 */
export function xmlEscape(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    const allowed = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || cp >= 0x10000
    if (!allowed) continue
    if (ch === '&') out += '&amp;'
    else if (ch === '<') out += '&lt;'
    else if (ch === '>') out += '&gt;'
    else if (ch === '"') out += '&quot;'
    else if (ch === "'") out += '&apos;'
    else out += ch
  }
  return out
}

/** An estimate of one character's advance in the system UI font, in em. */
function charEm(ch: string): number {
  const cp = ch.codePointAt(0) as number
  if (cp >= 0x2e80) return 1 // CJK, kana, hangul, emoji: full width
  if (ch === ' ') return 0.28
  if ('ijlI.,;:!|\'`()[]{}'.includes(ch)) return 0.3
  if ('ft/\\-'.includes(ch)) return 0.36
  if ('mwMW@%&'.includes(ch)) return 0.86
  if (ch >= '0' && ch <= '9') return 0.58
  if (ch >= 'A' && ch <= 'Z') return 0.68
  return 0.55
}

/** The estimated width of `s` in px at the picture's font size, bold a little wider. */
export function textWidth(s: string, bold = false): number {
  let em = 0
  for (const ch of s) em += charEm(ch)
  return em * FONT_SIZE * (bold ? 1.06 : 1)
}

/**
 * One cell's text as it fits `room` px: its first line, cut short with an
 * ellipsis when it is wider (or has more lines). `cut` says whether anything
 * was left out.
 */
export function fitText(text: string, room: number, bold = false): { text: string; cut: boolean } {
  const lines = text.split(/\r\n?|\n/)
  let line = lines[0].replace(/\t/g, ' ')
  let cut = lines.length > 1 && lines.slice(1).some((l) => l.trim() !== '')
  if (line.length > MEASURE_CAP) {
    line = line.slice(0, MEASURE_CAP)
    cut = true
  }
  if (!cut && textWidth(line, bold) <= room) return { text: line, cut: false }
  const ell = '…'
  const ellW = textWidth(ell, bold)
  if (ellW > room) return { text: '', cut: true }
  const chars = Array.from(line)
  let w = 0
  let n = 0
  for (; n < chars.length; n++) {
    const next = w + charEm(chars[n]) * FONT_SIZE * (bold ? 1.06 : 1)
    if (next + ellW > room) break
    w = next
  }
  return { text: chars.slice(0, n).join('').trimEnd() + ell, cut: true }
}

const isBlank = (v: string | undefined): boolean => !v || v.trim() === ''

/** The block's rows and columns that hold text, as [first, last] of each (null when none). */
function textBounds(rows: string[][]): { r0: number; r1: number; c0: number; c1: number } | null {
  let r0 = Infinity
  let r1 = -1
  let c0 = Infinity
  let c1 = -1
  rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (typeof v !== 'string' || isBlank(v)) return
      r0 = Math.min(r0, r)
      r1 = Math.max(r1, r)
      c0 = Math.min(c0, c)
      c1 = Math.max(c1, c)
    })
  )
  return r1 < 0 ? null : { r0, r1, c0, c1 }
}

const num = (n: number): string => String(Math.round(n * 100) / 100)

/**
 * The picture of a sheet's table, or null when no cell holds text.
 *
 * Leading and trailing rows and columns with no text are left off (the table
 * is what is IN the block, not the empty margin a capture may carry); the
 * blank rows and columns between filled ones stay. The heading row is the
 * first row when it reads as headings (looksLikeHeader, the same test every
 * other form uses); the first column is drawn as row labels when it is all
 * words beside columns that hold numbers.
 */
export function sheetPicture(input: SheetPictureInput): SheetPicture | null {
  const src = Array.isArray(input.rows) ? input.rows.map((r) => (Array.isArray(r) ? r.map((c) => (typeof c === 'string' ? c : '')) : [])) : []
  const bounds = textBounds(src)
  if (!bounds) return null

  const totalRows = bounds.r1 - bounds.r0 + 1
  const totalCols = bounds.c1 - bounds.c0 + 1
  const nR = Math.min(totalRows, SHEET_PICTURE_MAX_ROWS)
  const nC = Math.min(totalCols, SHEET_PICTURE_MAX_COLS)
  const lossy: string[] = []
  if (nR < totalRows) lossy.push(rowsShown(nR, totalRows))
  if (nC < totalCols) lossy.push(columnsShown(nC, totalCols))

  // The drawn grid, in picture coordinates (0,0 is the first drawn cell).
  const at = (r: number, c: number): { r: number; c: number } => ({ r: r + bounds.r0, c: c + bounds.c0 })
  const formats = input.formats && typeof input.formats === 'object' ? input.formats : {}
  const styles: CellStyle[][] = []
  const shown: string[][] = []
  for (let r = 0; r < nR; r++) {
    styles.push([])
    shown.push([])
    for (let c = 0; c < nC; c++) {
      const o = at(r, c)
      const st = styleOf(formats[`${o.r},${o.c}`])
      styles[r].push(st)
      const raw = src[o.r]?.[o.c] ?? ''
      shown[r].push(st.numFmt ? formatValue(raw, st.numFmt) : raw)
    }
  }
  if (styles.some((row) => row.some((s) => s.font))) lossy.push(L.cellFonts)

  // Merges, clipped to what is drawn. A merge overlapping one already placed is ignored.
  const span = new Map<string, { rs: number; cs: number }>()
  const covered = new Set<string>()
  // Which merge each merged cell (anchor or covered) belongs to, so no rule is drawn inside one.
  const owner = new Map<string, number>()
  for (const m of Array.isArray(input.merges) ? input.merges : []) {
    if (!m || ![m.r1, m.c1, m.r2, m.c2].every((v) => Number.isInteger(v))) continue
    const r1 = Math.max(Math.min(m.r1, m.r2) - bounds.r0, 0)
    const r2 = Math.min(Math.max(m.r1, m.r2) - bounds.r0, nR - 1)
    const c1 = Math.max(Math.min(m.c1, m.c2) - bounds.c0, 0)
    const c2 = Math.min(Math.max(m.c1, m.c2) - bounds.c0, nC - 1)
    // The anchor must be the merge's own top-left, still drawn.
    if (r1 !== Math.min(m.r1, m.r2) - bounds.r0 || c1 !== Math.min(m.c1, m.c2) - bounds.c0) continue
    if (r2 < r1 || c2 < c1 || (r1 === r2 && c1 === c2)) continue
    let clash = false
    for (let r = r1; r <= r2 && !clash; r++) for (let c = c1; c <= c2; c++) if (covered.has(`${r},${c}`) || span.has(`${r},${c}`)) clash = true
    if (clash) continue
    span.set(`${r1},${c1}`, { rs: r2 - r1 + 1, cs: c2 - c1 + 1 })
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        owner.set(`${r},${c}`, span.size)
        if (r !== r1 || c !== c1) covered.add(`${r},${c}`)
      }
    }
  }

  const heading = looksLikeHeader(shown)
  const body0 = heading ? 1 : 0
  const isNumber = (v: string): boolean => NUMERIC.test(v.trim())
  const labels = (() => {
    if (nC < 2 || nR - body0 < 1) return false
    let words = 0
    for (let r = body0; r < nR; r++) {
      const v = shown[r][0]
      if (isBlank(v)) continue
      if (isNumber(v) || ERROR_VALUE.test(v.trim())) return false
      words++
    }
    if (!words) return false
    for (let r = body0; r < nR; r++) for (let c = 1; c < nC; c++) if (isNumber(shown[r][c])) return true
    return false
  })()
  const boldAt = (r: number, c: number): boolean => styles[r][c].bold || (heading && r === 0)

  // Column widths: the sheet's own where it set one, else sized to the text.
  const widths: number[] = []
  const setWidths = input.colWidths && typeof input.colWidths === 'object' ? input.colWidths : {}
  for (let c = 0; c < nC; c++) {
    const set = (setWidths as Record<number, unknown>)[c + bounds.c0]
    if (typeof set === 'number' && Number.isFinite(set) && set > 0) {
      widths.push(Math.round(Math.min(MAX_SET_COL_W, Math.max(MIN_SET_COL_W, set))))
      continue
    }
    let w = MIN_COL_W
    for (let r = 0; r < nR; r++) {
      if (covered.has(`${r},${c}`) || (span.get(`${r},${c}`)?.cs ?? 1) > 1) continue
      const line = shown[r][c].split(/\r\n?|\n/)[0].slice(0, MEASURE_CAP)
      w = Math.max(w, Math.ceil(textWidth(line, boldAt(r, c)) + PAD_X * 2 + 2))
    }
    widths.push(Math.min(MAX_AUTO_COL_W, w))
  }
  const xs: number[] = [0]
  for (const w of widths) xs.push(xs[xs.length - 1] + w)
  const tableW = xs[nC]
  const tableH = nR * ROW_H
  const width = tableW + 1
  const height = tableH + 1

  const C = SHEET_PICTURE_COLOURS
  const rects: string[] = []
  const texts: string[] = []
  const clips = new Map<string, string>()
  let anyCut = false
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      if (covered.has(`${r},${c}`)) continue
      const sp = span.get(`${r},${c}`) ?? { rs: 1, cs: 1 }
      const x = xs[c]
      const y = r * ROW_H
      const w = xs[c + sp.cs] - x
      const h = sp.rs * ROW_H
      const st = styles[r][c]
      const isHeading = heading && r === 0
      const isLabel = labels && c === 0 && r >= body0
      const fill = st.bg ?? (isHeading ? C.headingFill : isLabel ? C.labelFill : C.page)
      rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`)

      const value = shown[r][c]
      if (isBlank(value)) continue
      const bold = boldAt(r, c)
      const fit = fitText(value.trim(), w - PAD_X * 2, bold)
      if (fit.cut) anyCut = true
      if (!fit.text) continue
      const err = ERROR_VALUE.test(value.trim())
      const align = st.align ?? (err ? 'center' : !isHeading && isNumber(value) ? 'right' : 'left')
      const tx = align === 'right' ? x + w - PAD_X : align === 'center' ? x + w / 2 : x + PAD_X
      const anchor = align === 'right' ? 'end' : align === 'center' ? 'middle' : 'start'
      const ty = y + h / 2 + FONT_SIZE * 0.35
      const clipId = `k${c}-${c + sp.cs - 1}`
      if (!clips.has(clipId)) clips.set(clipId, `<clipPath id="${clipId}"><rect x="${x + 1}" y="0" width="${Math.max(0, w - 2)}" height="${tableH}"/></clipPath>`)
      const attrs = [
        `x="${num(tx)}"`,
        `y="${num(ty)}"`,
        anchor !== 'start' ? `text-anchor="${anchor}"` : '',
        bold ? `font-weight="${isLabel && !st.bold ? 600 : 700}"` : isLabel ? 'font-weight="600"' : '',
        st.italic ? 'font-style="italic"' : '',
        st.underline ? 'text-decoration="underline"' : '',
        `fill="${err ? C.error : (st.color ?? C.text)}"`,
        `clip-path="url(#${clipId})"`
      ].filter(Boolean)
      texts.push(`<text ${attrs.join(' ')}>${xmlEscape(fit.text)}</text>`)
    }
  }
  if (anyCut) lossy.push(L.cellsCut)

  // Rules: one segment per cell edge between two cells, none inside a merge.
  const sameMerge = (a: string, b: string): boolean => owner.has(a) && owner.get(a) === owner.get(b)
  const rules: string[] = []
  for (let r = 1; r < nR; r++) {
    for (let c = 0; c < nC; c++) if (!sameMerge(`${r - 1},${c}`, `${r},${c}`)) rules.push(`M${xs[c]} ${r * ROW_H}H${xs[c + 1]}`)
  }
  for (let c = 1; c < nC; c++) {
    for (let r = 0; r < nR; r++) if (!sameMerge(`${r},${c - 1}`, `${r},${c}`)) rules.push(`M${xs[c]} ${r * ROW_H}V${(r + 1) * ROW_H}`)
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (clips.size ? `<defs>${[...clips.values()].join('')}</defs>` : '') +
    `<g transform="translate(0.5 0.5)">` +
    `<g shape-rendering="crispEdges">${rects.join('')}</g>` +
    (rules.length ? `<path d="${rules.join('')}" fill="none" stroke="${C.rule}" stroke-width="1" shape-rendering="crispEdges"/>` : '') +
    `<g font-family="${xmlEscape(FONT)}" font-size="${FONT_SIZE}">${texts.join('')}</g>` +
    `<rect x="0" y="0" width="${tableW}" height="${tableH}" fill="none" stroke="${C.border}" stroke-width="1" shape-rendering="crispEdges"/>` +
    `</g></svg>`

  return { value: { svg, width, height, vector: false, app: input.app }, lossy }
}
