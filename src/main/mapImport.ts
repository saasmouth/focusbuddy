// Visio (.vsdx) import for PlexiDiagrams. A .vsdx is an OOXML zip whose pages live
// in visio/pages/pageN.xml as ShapeSheet XML. We extract each page's 2-D shapes
// (position, size, text) as MapNodes and its connectors (the <Connect> rows that
// wire connector shapes to endpoints) as MapEdges, mapping shape masters to our
// nearest stencil where the master name makes that unambiguous.
//
// This is an honest best-effort geometry+text+connection import, not a
// pixel-perfect Visio renderer. What can't be determined (an unknown master, a
// group's internal geometry) falls back to a plain process box rather than being
// invented. A file we cannot read returns an error, never a fabricated diagram.

import { dialog } from 'electron'
import { readFile } from 'fs/promises'
import { basename } from 'path'
import type { MapBody, MapEdge, MapNode, MapShape } from '@shared/types'

export interface MapImportResult {
  ok: boolean
  title?: string
  body?: MapBody
  error?: string
}

const PX_PER_INCH = 96

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? m[1] : null
}

// Split the immediate <Shape>…</Shape> children of an XML fragment, honouring
// nesting so a group's inner shapes stay inside their parent block.
function topLevelShapeBlocks(xml: string): string[] {
  const blocks: string[] = []
  const tagRe = /<(\/?)Shape\b([^>]*?)(\/?)>/g
  let depth = 0
  let start = -1
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml)) !== null) {
    const isClose = m[1] === '/'
    const selfClose = m[3] === '/'
    if (!isClose) {
      if (depth === 0) {
        start = m.index
        if (selfClose) {
          blocks.push(m[0])
          start = -1
          continue
        }
      }
      if (!selfClose) depth++
    } else {
      if (depth > 0) depth--
      if (depth === 0 && start >= 0) {
        blocks.push(xml.slice(start, m.index + m[0].length))
        start = -1
      }
    }
  }
  return blocks
}

// Strip a group shape's nested <Shapes>…</Shapes> so we only read the shape's own
// geometry cells and text, not its children's.
function withoutNestedShapes(block: string): string {
  const i = block.indexOf('<Shapes')
  if (i < 0) return block
  const j = block.lastIndexOf('</Shapes>')
  if (j < 0 || j < i) return block
  return block.slice(0, i) + block.slice(j + '</Shapes>'.length)
}

function readCells(block: string): Map<string, string> {
  const cells = new Map<string, string>()
  const re = /<Cell\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    const n = attr(m[1], 'N')
    const v = attr(m[1], 'V')
    if (n != null && v != null) cells.set(n, v)
  }
  return cells
}

function readText(block: string): string {
  const m = /<Text\b[^>]*>([\s\S]*?)<\/Text>/.exec(block)
  if (!m) return ''
  // Drop formatting child tags (<cp/>, <pp/>, <tp/>, <fld/>), keep the runs.
  return decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

// Map a Visio master name to our nearest stencil. Unknown → process (a plain
// box), never a guessed non-rectangular shape.
function shapeFromMaster(name: string | undefined): MapShape {
  const n = (name ?? '').toLowerCase()
  if (!n) return 'process'
  if (/decision|diamond/.test(n)) return 'decision'
  if (/terminator|start\/end|start|\bend\b|begin/.test(n)) return 'terminator'
  if (/parallelogram|input|output|\bdata\b/.test(n)) return 'data'
  if (/database|data store|\bstore\b|cylinder/.test(n)) return 'database'
  if (/circle|ellipse|\bstate\b|connector node|on-page reference|off-page/.test(n)) return 'circle'
  if (/hexagon|preparation|prepare/.test(n)) return 'hexagon'
  if (/process|rectangle|action|subprocess|predefined/.test(n)) return 'process'
  return 'process'
}

interface RawShape {
  id: string
  masterId: string | null
  cells: Map<string, string>
  text: string
  isConnector: boolean
}

function num(cells: Map<string, string>, key: string): number | null {
  const v = cells.get(key)
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Parse one page's shapes and connects into partial nodes (pre-normalisation) and
// edges. Node coordinates are in screen px with Visio's bottom-up Y already
// flipped; the caller normalises the origin.
function parsePage(
  xml: string,
  masters: Map<string, string>,
  pageIndex: number
): { nodes: MapNode[]; edges: MapEdge[] } {
  const shapesStart = xml.indexOf('<Shapes')
  const inner = shapesStart >= 0 ? xml.slice(shapesStart) : ''
  const raw: RawShape[] = topLevelShapeBlocks(inner).map((full) => {
    const openTag = /<Shape\b[^>]*>/.exec(full)?.[0] ?? full
    const clean = withoutNestedShapes(full)
    const cells = readCells(clean)
    const isConnector = cells.has('BeginX') || cells.has('EndX')
    return {
      id: attr(openTag, 'ID') ?? '',
      masterId: attr(openTag, 'Master'),
      cells,
      text: readText(clean),
      isConnector
    }
  })

  const byId = new Map(raw.map((s) => [s.id, s]))
  const pfx = (id: string): string => `p${pageIndex}_${id}`

  // Nodes: 2-D shapes with a centre position.
  const nodes: MapNode[] = []
  for (const s of raw) {
    if (!s.id || s.isConnector) continue
    const pinx = num(s.cells, 'PinX')
    const piny = num(s.cells, 'PinY')
    if (pinx == null || piny == null) continue
    const wIn = num(s.cells, 'Width') ?? 1
    const hIn = num(s.cells, 'Height') ?? 0.5
    const w = Math.max(24, Math.round(wIn * PX_PER_INCH))
    const h = Math.max(18, Math.round(hIn * PX_PER_INCH))
    const cx = pinx * PX_PER_INCH
    const cy = -piny * PX_PER_INCH // flip Visio's bottom-up Y to screen top-down
    nodes.push({
      id: pfx(s.id),
      x: Math.round(cx - w / 2),
      y: Math.round(cy - h / 2),
      label: s.text,
      shape: shapeFromMaster(s.masterId ? masters.get(s.masterId) : undefined),
      color: '#2563eb',
      width: w,
      height: h
    })
  }

  // Edges: each connector shape links a Begin endpoint to an End endpoint via two
  // <Connect> rows (FromSheet = connector id, FromCell = BeginX/EndX).
  const ends = new Map<string, { begin?: string; end?: string }>()
  const connectRe = /<Connect\b([^>]*?)\/?>/g
  let cm: RegExpExecArray | null
  while ((cm = connectRe.exec(xml)) !== null) {
    const from = attr(cm[1], 'FromSheet')
    const fromCell = attr(cm[1], 'FromCell') ?? ''
    const to = attr(cm[1], 'ToSheet')
    if (!from || !to) continue
    const slot = ends.get(from) ?? {}
    if (/begin/i.test(fromCell)) slot.begin = to
    else if (/end/i.test(fromCell)) slot.end = to
    ends.set(from, slot)
  }

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges: MapEdge[] = []
  let ei = 0
  for (const [connId, { begin, end }] of ends) {
    if (!begin || !end) continue
    const source = pfx(begin)
    const target = pfx(end)
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue
    edges.push({
      id: `${pfx(connId)}_e${ei++}`,
      source,
      target,
      label: byId.get(connId)?.text || undefined,
      style: 'solid'
    })
  }

  return { nodes, edges }
}

// Parse a .vsdx buffer into a MapBody. Pure (no dialog/fs), so it is unit-tested
// directly against constructed fixtures.
export async function parseVsdx(data: Uint8Array): Promise<MapImportResult> {
  try {
    const { unzipSync, strFromU8 } = await import('fflate')
    const files = unzipSync(data)

    // Master id → name (NameU/Name), for shape-type mapping.
    const masters = new Map<string, string>()
    const mastersXmlKey = Object.keys(files).find((n) => /visio\/masters\/masters\.xml$/i.test(n))
    if (mastersXmlKey) {
      const mx = strFromU8(files[mastersXmlKey])
      const re = /<Master\b[^>]*>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(mx)) !== null) {
        const id = attr(m[0], 'ID')
        const name = attr(m[0], 'NameU') ?? attr(m[0], 'Name')
        if (id && name) masters.set(id, decodeEntities(name))
      }
    }

    const pageNames = Object.keys(files)
      .filter((n) => /visio\/pages\/page\d+\.xml$/i.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/i)![1], 10) - parseInt(b.match(/(\d+)\.xml$/i)![1], 10))
    if (!pageNames.length) return { ok: false, error: 'No Visio pages found in that file.' }

    // Page titles from pages.xml (best-effort).
    let firstPageName = 'Imported Visio diagram'
    const pagesXmlKey = Object.keys(files).find((n) => /visio\/pages\/pages\.xml$/i.test(n))
    if (pagesXmlKey) {
      const px = strFromU8(files[pagesXmlKey])
      const pm = /<Page\b[^>]*>/.exec(px)
      const name = pm ? attr(pm[0], 'Name') ?? attr(pm[0], 'NameU') : null
      if (name) firstPageName = decodeEntities(name)
    }

    const allNodes: MapNode[] = []
    const allEdges: MapEdge[] = []
    let yOffset = 0
    for (let pi = 0; pi < pageNames.length; pi++) {
      const xml = strFromU8(files[pageNames[pi]])
      const { nodes, edges } = parsePage(xml, masters, pi)
      if (!nodes.length) continue
      // Normalise this page's origin to a small padding, then stack pages down the
      // canvas so a multi-page Visio file imports without overlap or loss.
      const minX = Math.min(...nodes.map((n) => n.x))
      const minY = Math.min(...nodes.map((n) => n.y))
      const dx = 40 - minX
      const dy = 40 - minY + yOffset
      for (const n of nodes) {
        n.x += dx
        n.y += dy
      }
      const maxY = Math.max(...nodes.map((n) => n.y + (n.height ?? 48)))
      yOffset = maxY + 80 - 40
      allNodes.push(...nodes)
      allEdges.push(...edges)
    }

    if (!allNodes.length) return { ok: false, error: 'That Visio file has no shapes we can import.' }

    const body: MapBody = { version: 1, nodes: allNodes, edges: allEdges, viewport: { x: 0, y: 0, zoom: 1 } }
    return { ok: true, title: firstPageName, body }
  } catch (e) {
    return { ok: false, error: `Could not read that Visio file: ${(e as Error).message}` }
  }
}

// Dialog wrapper used by IPC: pick a .vsdx, read it, parse it.
export async function importVsdx(): Promise<MapImportResult> {
  const { BrowserWindow } = await import('electron')
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showOpenDialog(parent!, {
    title: 'Import Visio diagram',
    properties: ['openFile'],
    filters: [{ name: 'Visio', extensions: ['vsdx'] }]
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false }
  const path = res.filePaths[0]
  const buf = await readFile(path)
  const parsed = await parseVsdx(new Uint8Array(buf))
  if (parsed.ok && !parsed.title) parsed.title = basename(path).replace(/\.vsdx$/i, '')
  return parsed
}
