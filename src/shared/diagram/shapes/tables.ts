// Table shapes. The geometry is the outer frame plus the grid lines; the
// editor fills the cells from node.cells (special: 'table'). Column / row counts
// here are the defaults a new table starts with. Ids are saved in documents —
// never rename.

import { type ShapeDef, line, rect } from './types'
import { PORTS_THIRDS, box, fill, shade, stroke } from './kit'

const T = 'Tables' as const

export function gridLines(w: number, h: number, cols: number, rows: number): string {
  const out: string[] = []
  for (let c = 1; c < cols; c++) out.push(line((w * c) / cols, 0, (w * c) / cols, h))
  for (let r = 1; r < rows; r++) out.push(line(0, (h * r) / rows, w, (h * r) / rows))
  return out.join(' ')
}

function table(
  id: string,
  label: string,
  cols: number,
  rows: number,
  opts: { headerRow?: boolean; headerCol?: boolean; keywords?: string[]; w?: number; h?: number } = {}
): ShapeDef {
  return {
    id,
    label,
    category: T,
    keywords: ['table', 'grid', 'cells', 'spreadsheet', 'matrix', `${cols}x${rows}`, ...(opts.keywords ?? [])],
    w: opts.w ?? cols * 80,
    h: opts.h ?? rows * 32,
    minW: cols * 8,
    minH: rows * 8,
    special: 'table',
    ports: PORTS_THIRDS,
    draw: (w, h, node) => {
      // The grid follows the table's own cells once it has any (Table size, a
      // converted sheet block); the id's counts are only a new table's default.
      // Drawing the default grid over a resized table left stale lines.
      const r = node?.cells?.length ? node.cells.length : rows
      const c = node?.cells?.length ? Math.max(1, ...node.cells.map((x) => x.length)) : cols
      const parts = [fill(rect(0, 0, w, h))]
      if (opts.headerRow) parts.push(shade(rect(0, 0, w, h / r)))
      if (opts.headerCol) parts.push(shade(rect(0, 0, w / c, h)))
      parts.push(stroke(gridLines(w, h, c, r)))
      return { parts, text: box(w, h, 0, 0, w, h) }
    }
  }
}

export const TABLE_SHAPES: ShapeDef[] = [
  table('table-2x2', 'Table 2×2', 2, 2),
  table('table-3x3', 'Table 3×3', 3, 3),
  table('table-4x3', 'Table 4×3', 4, 3),
  table('table-header', 'Table with header', 3, 4, { headerRow: true, keywords: ['header', 'heading row', 'data table'] }),
  table('table-header-column', 'Table with header column', 3, 4, { headerCol: true, keywords: ['row headers', 'side header'] }),
  table('table-key-value', 'Key / value table', 2, 4, {
    headerCol: true,
    keywords: ['key value', 'properties', 'attributes', 'details', 'definition'],
    w: 220
  }),
  table('table-5x4', 'Table 5×4', 5, 4, { headerRow: true, keywords: ['large', 'data table', 'header'] }),
  table('table-1x4', 'List table', 1, 4, { headerRow: true, keywords: ['list', 'column', 'single column'], w: 160 })
]
