// PlexiiCells on paper: the one render both Download ▸ PDF and Print… use.
//
// Cells had no PDF and no print until 4.3.41. The renderer turns the active tab
// into a SheetPrintModel (every cell as the grid SHOWS it: formulas computed,
// conditional and number formats applied, see lib/sheetPrintModel.ts), and this
// file lays that model out on paper. It is pure, so the paging is unit-tested
// without Electron; main loads sheetPrintHtml() in an offscreen window and
// either printToPDF()s it or print()s it, the same render either way.
//
// Paging is Excel's default "over, then down": the columns that do not fit on a
// page continue on the next page ACROSS, and only when every column band of a
// set of rows is out does the next page go DOWN. Headers are not repeated yet.
// The paper comes from the locale (A4, or Letter where Letter is the norm), with
// Excel's Normal margins.

/** One cell as the grid displays it. Keyed "r,c" in SheetPrintModel.cells. */
export interface SheetPrintCell {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  bg?: string
  align?: 'left' | 'center' | 'right'
  fontFamily?: string
}

/** The active tab, ready for paper: the rows and columns to print, in order, and what each cell shows. */
export interface SheetPrintModel {
  sheetName: string
  /** Printed columns, left to right (hidden ones already left out), with their widths in CSS px. */
  cols: Array<{ c: number; w: number }>
  /** Printed rows, top to bottom (hidden ones already left out), with their heights in CSS px. */
  rows: Array<{ r: number; h: number }>
  /** Sparse: a cell with nothing to show is absent. */
  cells: Record<string, SheetPrintCell>
  merges?: Array<{ r1: number; c1: number; r2: number; c2: number }>
  /** The sheet's own setting; absent on the tab means on. */
  showGridlines: boolean
}

export type Paper = 'a4' | 'letter'

export interface PaperGeometry {
  paper: Paper
  /** The CSS/printToPDF size name. */
  name: 'A4' | 'Letter'
  /** Page size in CSS px (96 per inch). */
  width: number
  height: number
  /** Excel's Normal margins, in inches. */
  margin: { top: number; right: number; bottom: number; left: number }
}

const PX_PER_IN = 96
const MM_PER_IN = 25.4
const NORMAL_MARGIN = { top: 0.75, right: 0.7, bottom: 0.75, left: 0.7 }

export function paperGeometry(paper: Paper): PaperGeometry {
  return paper === 'letter'
    ? { paper, name: 'Letter', width: 8.5 * PX_PER_IN, height: 11 * PX_PER_IN, margin: NORMAL_MARGIN }
    : { paper, name: 'A4', width: (210 / MM_PER_IN) * PX_PER_IN, height: (297 / MM_PER_IN) * PX_PER_IN, margin: NORMAL_MARGIN }
}

// Regions where Letter is the everyday paper size. Everywhere else is A4.
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'PR', 'GT', 'CR', 'PA', 'DO', 'SV', 'NI', 'HN', 'BO'])

/** The default paper for a BCP 47 locale ("en-AU" → A4, "en-US" → Letter). Unknown or region-less → A4. */
export function paperForLocale(locale: string | undefined | null): Paper {
  const region = String(locale ?? '')
    .replace(/_/g, '-')
    .split('-')
    .slice(1)
    .find((part) => /^[A-Za-z]{2}$/.test(part))
  return region && LETTER_REGIONS.has(region.toUpperCase()) ? 'letter' : 'a4'
}

/** The printable area of a page, in CSS px. */
export function printableSize(g: PaperGeometry): { width: number; height: number } {
  return {
    width: g.width - (g.margin.left + g.margin.right) * PX_PER_IN,
    height: g.height - (g.margin.top + g.margin.bottom) * PX_PER_IN
  }
}

/** Split sizes into consecutive bands that each fit `limit` (an item bigger than the page gets a band of its own). */
export function bands(sizes: number[], limit: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  let used = 0
  for (let i = 0; i < sizes.length; i++) {
    const s = Math.max(0, sizes[i])
    if (i > start && used + s > limit) {
      out.push({ start, end: i - 1 })
      start = i
      used = 0
    }
    used += s
  }
  if (sizes.length) out.push({ start, end: sizes.length - 1 })
  return out
}

export interface SheetPage {
  /** Indexes into model.cols / model.rows (inclusive). */
  cols: { start: number; end: number }
  rows: { start: number; end: number }
}

/** The pages, in print order: across first, then down. */
export function paginateSheet(model: SheetPrintModel, g: PaperGeometry): SheetPage[] {
  if (!model.cols.length || !model.rows.length) return []
  const area = printableSize(g)
  const colBands = bands(model.cols.map((c) => c.w), area.width)
  const rowBands = bands(model.rows.map((r) => r.h), area.height)
  const pages: SheetPage[] = []
  for (const rows of rowBands) for (const cols of colBands) pages.push({ cols, rows })
  return pages
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const safeColor = (v: string | undefined): string | null => (v && /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d\s.,%]+\)$/.test(v) ? v : null)
const safeFont = (v: string | undefined): string | null => (v && /^[\w\s,'"-]+$/.test(v) ? v : null)

function cellStyle(cell: SheetPrintCell | undefined, h: number): string {
  const s: string[] = [`height:${h}px`]
  if (!cell) return s.join(';')
  if (cell.bold) s.push('font-weight:700')
  if (cell.italic) s.push('font-style:italic')
  if (cell.underline) s.push('text-decoration:underline')
  const color = safeColor(cell.color)
  if (color) s.push(`color:${color}`)
  const bg = safeColor(cell.bg)
  if (bg) s.push(`background:${bg}`)
  if (cell.align) s.push(`text-align:${cell.align}`)
  const font = safeFont(cell.fontFamily)
  if (font) s.push(`font-family:${font}`)
  return s.join(';')
}

function pageHtml(model: SheetPrintModel, page: SheetPage, g: PaperGeometry): string {
  const cols = model.cols.slice(page.cols.start, page.cols.end + 1)
  const rows = model.rows.slice(page.rows.start, page.rows.end + 1)
  const colIdx = new Set(cols.map((c) => c.c))
  const rowIdx = new Set(rows.map((r) => r.r))
  // A merge draws from its anchor, spanning the merged cells that fall on THIS
  // page; the rest of a merge that crosses a page edge is left blank there.
  const covered = new Set<string>()
  const span = new Map<string, { rs: number; cs: number }>()
  for (const m of model.merges ?? []) {
    const anchorHere = rowIdx.has(m.r1) && colIdx.has(m.c1)
    const cs = cols.filter((c) => c.c >= m.c1 && c.c <= m.c2).length
    const rs = rows.filter((r) => r.r >= m.r1 && r.r <= m.r2).length
    for (const r of rows) for (const c of cols) if (r.r >= m.r1 && r.r <= m.r2 && c.c >= m.c1 && c.c <= m.c2 && !(r.r === m.r1 && c.c === m.c1)) covered.add(`${r.r},${c.c}`)
    if (anchorHere) span.set(`${m.r1},${m.c1}`, { rs, cs })
  }
  const colgroup = cols.map((c) => `<col style="width:${c.w}px">`).join('')
  const body = rows
    .map((r) => {
      const tds = cols
        .map((c) => {
          const key = `${r.r},${c.c}`
          if (covered.has(key)) return ''
          const cell = model.cells[key]
          const sp = span.get(key)
          const attrs = sp ? `${sp.rs > 1 ? ` rowspan="${sp.rs}"` : ''}${sp.cs > 1 ? ` colspan="${sp.cs}"` : ''}` : ''
          return `<td data-cell="${key}"${attrs} style="${cellStyle(cell, r.h)}">${cell ? esc(cell.text) : ''}</td>`
        })
        .join('')
      return `<tr style="height:${r.h}px">${tds}</tr>`
    })
    .join('')
  const m = g.margin
  return `<section class="page" style="width:${g.width}px;height:${g.height}px;padding:${m.top}in ${m.right}in ${m.bottom}in ${m.left}in"><table class="${model.showGridlines ? 'grid' : 'nogrid'}"><colgroup>${colgroup}</colgroup><tbody>${body}</tbody></table></section>`
}

/** The whole tab as paged HTML: one <section class="page"> per paper page, in print order. */
export function sheetPrintHtml(model: SheetPrintModel, g: PaperGeometry): string {
  const pages = paginateSheet(model, g)
  const sections = pages.length
    ? pages.map((p) => pageHtml(model, p, g)).join('')
    : `<section class="page" style="width:${g.width}px;height:${g.height}px"></section>`
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(model.sheetName)}</title><style>
  @page { size: ${g.name}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .page { position: relative; overflow: hidden; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  table { border-collapse: collapse; table-layout: fixed; font-family: Calibri, Arial, Helvetica, sans-serif; font-size: 11pt; color: #111; }
  td { padding: 0 4px; overflow: hidden; white-space: nowrap; text-overflow: clip; vertical-align: bottom; border: 1px solid transparent; }
  table.grid td { border-color: #d4d4d4; }
</style></head><body>${sections}</body></html>`
}
