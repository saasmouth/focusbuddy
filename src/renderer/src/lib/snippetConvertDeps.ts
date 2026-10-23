// The renderer's half of snippet conversion: the capabilities the pure core
// (shared/snippetConvert.ts) is handed through ConvertDeps, wired to the apps'
// own engines so a converted snippet reads exactly as the app would show it.
//
//   evaluateSheet  PlexiiCells' formula engine (lib/sheetFormula.ts)
//   drawToSvg      PlexiiDraw's clipboard picture (buildClipboard → drawDocToSvg)
//   svgToDraw      PlexiiDraw's SVG importer (shared/draw/import/svg importSvgText)
//
// Every one is deterministic, because a converted LIVE instance is converted
// again on every render: ids come from a counter local to one call, asset ids
// from the bytes (putAsset hashes them), and nothing reads a clock.

import type { ConvertDeps, DrawImport, DrawPicture, SheetEvaluation } from '@shared/snippetConvert'
import type { DrawSnippetBody, SheetSnippetBody } from '@shared/snippets'
import type { DrawImageNode, DrawNode } from '@shared/draw/model'
import { normalizeDrawDoc } from '@shared/draw/normalize'
import { putAsset } from '@shared/draw/assets'
import { importSvgText, importedNodes, type XmlDocument } from '@shared/draw/import/svg'
import { svgDataUrl } from '@shared/snippetForms/picture'
import { buildSpillMap, displayCell, remapFormulaRefs, type Grid, type Workbook } from './sheetFormula'
import { colLabel } from './sheetBody'
import { buildClipboard } from '../components/documents/draw/editor/clipboard'

// ── Sheet values ─────────────────────────────────────────────────────────────

/**
 * A workbook that knows no sheets and records being asked. The engine reads a
 * cross-sheet reference (=Sheet2!A1) from the formula's OWN grid when it cannot
 * resolve the sheet, which would compute a plausible wrong number; asking this
 * workbook is how such a reference is caught and shown as #REF! instead.
 */
function spyWorkbook(): { wb: Workbook; asked: () => boolean; reset: () => void } {
  let asked = false
  const byName = new Map<string, Grid>()
  byName.get = () => {
    asked = true
    return undefined
  }
  return { wb: { byName }, asked: () => asked, reset: () => (asked = false) }
}

/**
 * What every cell of a sheet block displays, computed by Cells' own engine
 * over the block alone.
 *
 * Formulas are stored as they read at the block's origin, so each is moved
 * onto the block (remapFormulaRefs, absolute parts included: the data really
 * is at the new place). A formula that reads a cell OUTSIDE the block, or
 * another sheet, cannot be computed from what was saved: it shows #REF! and
 * is counted, never a value computed from blanks. A formula depending on it
 * shows the error too, because the error is a formula (=#REF!), not text that
 * arithmetic would read as 0.
 */
export function evaluateSheetBlock(body: SheetSnippetBody): SheetEvaluation {
  const input = (body.rows ?? []).map((r) => (Array.isArray(r) ? r.map((c) => (typeof c === 'string' ? c : '')) : []))
  const nC = input.reduce((m, r) => Math.max(m, r.length), 0)
  const rows = input.map((r) => [...r, ...Array<string>(nC - r.length).fill('')])
  const nR = rows.length
  const o = body.origin && Number.isInteger(body.origin.r) && Number.isInteger(body.origin.c) ? body.origin : { r: 0, c: 0 }
  const inRows = (r: number): boolean => r >= o.r && r < o.r + nR
  const inCols = (c: number): boolean => c >= o.c && c < o.c + nC

  let formulas = 0
  const broken = new Set<string>()
  const grid: Grid = { columns: Array.from({ length: nC }, (_, c) => colLabel(c)), rows: rows.map((r) => [...r]) }
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const raw = rows[r][c]
      if (!raw.trim().startsWith('=')) continue
      formulas++
      let outside = false
      remapFormulaRefs(
        raw.trim(),
        (rr) => {
          if (!inRows(rr)) outside = true
          return rr
        },
        (cc) => {
          if (!inCols(cc)) outside = true
          return cc
        }
      )
      if (outside) {
        broken.add(`${r},${c}`)
        grid.rows[r][c] = '=#REF!'
      } else grid.rows[r][c] = remapFormulaRefs(raw.trim(), (rr) => rr - o.r, (cc) => cc - o.c)
    }
  }

  const spy = spyWorkbook()
  const spill = buildSpillMap(grid, spy.wb)
  const values = grid.rows.map((row, r) =>
    row.map((_, c) => {
      if (broken.has(`${r},${c}`)) return '#REF!'
      if (!rows[r][c].trim().startsWith('=') && !spill.has(`${r},${c}`)) return rows[r][c]
      spy.reset()
      const v = displayCell(grid, r, c, spy.wb, spill)
      if (spy.asked()) {
        broken.add(`${r},${c}`)
        return '#REF!'
      }
      return v
    })
  )
  return { values, formulas, outside: broken.size }
}

// ── Drawings as pictures ─────────────────────────────────────────────────────

/** Draw objects as the SVG Draw's own Copy writes for them, cropped to the art. */
export function drawBodyToSvg(body: DrawSnippetBody): DrawPicture | null {
  const doc = normalizeDrawDoc({
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'snippet', name: 'Snippet', x: 0, y: 0, w: 1, h: 1, background: { type: 'none' } }],
    layers: [{ id: 'snippet', kind: 'vector', name: 'Snippet', visible: true, locked: false, opacity: 1, blend: 'normal', objects: Array.isArray(body.objects) ? body.objects : [] }],
    assets: body.assets && typeof body.assets === 'object' ? body.assets : {},
    swatches: Array.isArray(body.swatches) ? body.swatches : [],
    guides: [],
    settings: {}
  })
  const layer = doc.layers.find((l) => l.kind === 'vector') as { objects?: DrawNode[] } | undefined
  const ids = (layer?.objects ?? []).map((n) => (n as { id?: string }).id).filter((id): id is string => typeof id === 'string')
  if (!ids.length) return null
  const built = buildClipboard(doc, ids)
  return built ? { svg: built.svg, width: built.size.w, height: built.size.h } : null
}

// ── SVG as editable Draw objects ─────────────────────────────────────────────

function parseXmlInDom(text: string): XmlDocument {
  return new DOMParser().parseFromString(text, 'image/svg+xml') as unknown as XmlDocument
}

function eachNode(nodes: DrawNode[], fn: (n: DrawNode) => void): void {
  for (const n of nodes) {
    fn(n)
    if (n.type === 'group') eachNode(n.children, fn)
  }
}

/**
 * SVG markup as PlexiiDraw objects, through Draw's own importer. An element
 * the importer cannot keep as vectors (a filter, a mask) comes back as a
 * picture of itself; Draw's file import rasterises those asynchronously, and
 * here they are kept as the element's own SVG bytes instead, which Draw's
 * asset store holds and draws the same, so the result is ready at once.
 */
export function importSvgAsDraw(svg: string, parseXml: (s: string) => XmlDocument = parseXmlInDom): DrawImport | null {
  let seq = 0
  const newId = (prefix: string): string => `${prefix}-${seq++}`
  try {
    const out = importSvgText(svg, parseXml, { mode: 'import', structure: 'v2', newId })
    const byId = new Map<string, DrawNode>()
    for (const l of out.layers) eachNode(l.nodes, (n) => byId.set(n.id, n))
    let assets = out.assets as Record<string, unknown>
    let pictured = 0
    for (const f of out.fallbacks) {
      const node = byId.get(f.nodeId)
      if (!node || node.type !== 'image') continue
      const put = putAsset(assets as never, svgDataUrl(f.markup), { w: Math.round(f.box.w), h: Math.round(f.box.h) })
      assets = put.assets
      ;(node as DrawImageNode).assetId = put.id
      pictured++
    }
    const objects = importedNodes(out)
    if (!objects.length) return null
    return { objects, assets, swatches: [], pictured }
  } catch {
    return null
  }
}

/** The real capabilities, for every conversion the renderer runs. */
export function snippetConvertDeps(): ConvertDeps {
  return { evaluateSheet: evaluateSheetBlock, drawToSvg: drawBodyToSvg, svgToDraw: (svg) => importSvgAsDraw(svg) }
}
