// Defensive normaliser for PlexiDiagrams bodies. Accepts anything parsed from
// disk, the cloud, an import or an AI reply and returns a valid MapBody: v1
// bodies come through unchanged in meaning, v2 fields are kept when well-formed
// and dropped when not, unknown shape ids fall back to 'process', and edges that
// point at missing nodes are removed. Runs on every load, so it must never throw.

import type {
  MapArrowHead,
  MapBody,
  MapConditionalRule,
  MapDataSource,
  MapEdge,
  MapLayer,
  MapNode,
  MapNodeBinding,
  MapNodeStyle,
  MapPage,
  MapRouting,
  MapSettings,
  MapStrokeDash
} from '../types'
import { isShapeId } from './shapes'

const ARROWS = new Set<MapArrowHead>([
  'none',
  'arrow',
  'open',
  'triangle',
  'diamond',
  'diamondOpen',
  'circle',
  'circleOpen',
  'bar',
  'crowOne',
  'crowMany',
  'crowOneOrMany',
  'crowZeroOrOne',
  'crowZeroOrMany'
])
const ROUTINGS = new Set<MapRouting>(['orthogonal', 'curved', 'straight'])
const DASHES = new Set<MapStrokeDash>(['solid', 'dashed', 'dotted', 'dashdot', 'none'])
const RULE_OPS = new Set<MapConditionalRule['op']>(['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte', 'empty', 'notEmpty'])

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 20000): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined)
const num = (v: unknown, lo = -1e7, hi = 1e7): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

// Drop undefined keys so saved JSON stays minimal and stable.
function clean<T extends object>(o: T): T {
  const rec = o as Record<string, unknown>
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k]
  return o
}

function normStyle(raw: unknown): MapNodeStyle | undefined {
  if (!isObj(raw)) return undefined
  const s = clean<MapNodeStyle>({
    fill: str(raw.fill, 64),
    fillOpacity: num(raw.fillOpacity, 0, 1),
    stroke: str(raw.stroke, 64),
    strokeWidth: num(raw.strokeWidth, 0, 40),
    strokeDash: DASHES.has(raw.strokeDash as MapStrokeDash) ? (raw.strokeDash as MapStrokeDash) : undefined,
    radius: num(raw.radius, 0, 500),
    opacity: num(raw.opacity, 0, 1),
    shadow: bool(raw.shadow),
    fontFamily: str(raw.fontFamily, 120),
    fontSize: num(raw.fontSize, 4, 400),
    bold: bool(raw.bold),
    italic: bool(raw.italic),
    underline: bool(raw.underline),
    strike: bool(raw.strike),
    textColor: str(raw.textColor, 64),
    textAlign: raw.textAlign === 'left' || raw.textAlign === 'center' || raw.textAlign === 'right' ? raw.textAlign : undefined,
    vAlign: raw.vAlign === 'top' || raw.vAlign === 'middle' || raw.vAlign === 'bottom' ? raw.vAlign : undefined
  })
  return Object.keys(s).length ? s : undefined
}

function normSource(raw: unknown): MapDataSource | undefined {
  if (!isObj(raw)) return undefined
  switch (raw.kind) {
    case 'table':
      return typeof raw.tableId === 'string' && raw.tableId
        ? clean({ kind: 'table' as const, tableId: raw.tableId, rowId: str(raw.rowId, 200) })
        : undefined
    case 'widget':
      return typeof raw.widgetId === 'string' && raw.widgetId ? { kind: 'widget', widgetId: raw.widgetId } : undefined
    case 'app':
      return typeof raw.appId === 'string' && raw.appId ? { kind: 'app', appId: raw.appId } : undefined
    case 'tool':
      return typeof raw.toolId === 'string' && raw.toolId ? { kind: 'tool', toolId: raw.toolId } : undefined
  }
  return undefined
}

function normBinding(raw: unknown): MapNodeBinding | undefined {
  if (!isObj(raw)) return undefined
  const source = normSource(raw.source)
  if (!source) return undefined
  const rules: MapConditionalRule[] = []
  if (Array.isArray(raw.rules)) {
    for (const r of raw.rules.slice(0, 50)) {
      if (!isObj(r) || typeof r.columnId !== 'string' || !RULE_OPS.has(r.op as MapConditionalRule['op'])) continue
      rules.push(
        clean({
          id: typeof r.id === 'string' && r.id ? r.id : `r${rules.length + 1}`,
          columnId: r.columnId,
          op: r.op as MapConditionalRule['op'],
          value: str(r.value, 500),
          fill: str(r.fill, 64),
          stroke: str(r.stroke, 64),
          textColor: str(r.textColor, 64),
          icon: str(r.icon, 80)
        })
      )
    }
  }
  const fields = Array.isArray(raw.fields) ? raw.fields.filter((f): f is string => typeof f === 'string').slice(0, 20) : []
  return clean<MapNodeBinding>({
    source,
    labelTemplate: str(raw.labelTemplate, 1000),
    rules: rules.length ? rules : undefined,
    fields: fields.length ? fields : undefined
  })
}

function normData(raw: unknown): Record<string, string> | undefined {
  if (!isObj(raw)) return undefined
  const out: Record<string, string> = {}
  let n = 0
  for (const [k, v] of Object.entries(raw)) {
    if (n >= 100 || k.length > 120) break
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v).slice(0, 2000)
      n++
    }
  }
  return n ? out : undefined
}

function normCells(raw: unknown): string[][] | undefined {
  if (!Array.isArray(raw)) return undefined
  const rows = raw
    .slice(0, 100)
    .filter(Array.isArray)
    .map((row) => (row as unknown[]).slice(0, 50).map((c) => (typeof c === 'string' ? c.slice(0, 2000) : c == null ? '' : String(c))))
  return rows.length ? rows : undefined
}

export function normalizeNode(raw: unknown): MapNode | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const shape = isShapeId(raw.shape) ? raw.shape : 'process'
  const node: MapNode = {
    id: raw.id,
    x: num(raw.x) ?? 0,
    y: num(raw.y) ?? 0,
    label: typeof raw.label === 'string' ? raw.label : '',
    shape,
    color: typeof raw.color === 'string' && raw.color ? raw.color : '#2563eb',
    ...(num(raw.width, 1, 100000) !== undefined ? { width: raw.width as number } : {}),
    ...(num(raw.height, 1, 100000) !== undefined ? { height: raw.height as number } : {}),
    // Preserve widget references. Dropping this would silently unlink every
    // widget node on load, so it is part of the normaliser's whitelist.
    ...(typeof raw.widgetId === 'string' && raw.widgetId ? { widgetId: raw.widgetId } : {})
  }
  const rotation = num(raw.rotation, -36000, 36000)
  return clean<MapNode>({
    ...node,
    rotation: rotation ? ((rotation % 360) + 360) % 360 || undefined : undefined,
    flipX: raw.flipX === true ? true : undefined,
    flipY: raw.flipY === true ? true : undefined,
    parentId: str(raw.parentId, 200) || undefined,
    groupId: str(raw.groupId, 200) || undefined,
    locked: raw.locked === true ? true : undefined,
    hidden: raw.hidden === true ? true : undefined,
    layerId: str(raw.layerId, 200) || undefined,
    style: normStyle(raw.style),
    icon: str(raw.icon, 80) || undefined,
    image: str(raw.image, 3_000_000) || undefined,
    link: str(raw.link, 4000) || undefined,
    description: str(raw.description, 20000) || undefined,
    data: normData(raw.data),
    binding: normBinding(raw.binding),
    cells: normCells(raw.cells)
  })
}

function normPoints(raw: unknown): { x: number; y: number }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const pts = raw
    .slice(0, 200)
    .filter(isObj)
    .map((p) => ({ x: num(p.x), y: num(p.y) }))
    .filter((p): p is { x: number; y: number } => p.x !== undefined && p.y !== undefined)
  return pts.length ? pts : undefined
}

export function normalizeEdge(raw: unknown, ids: Set<string>, seen: Set<string>): MapEdge | null {
  if (!isObj(raw)) return null
  if (typeof raw.source !== 'string' || typeof raw.target !== 'string') return null
  if (!ids.has(raw.source) || !ids.has(raw.target)) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `e-${raw.source}-${raw.target}`
  if (seen.has(id)) return null
  seen.add(id)
  return clean<MapEdge>({
    id,
    source: raw.source,
    target: raw.target,
    label: typeof raw.label === 'string' && raw.label ? raw.label : undefined,
    sourceHandle: typeof raw.sourceHandle === 'string' ? raw.sourceHandle : undefined,
    targetHandle: typeof raw.targetHandle === 'string' ? raw.targetHandle : undefined,
    style: raw.style === 'dashed' ? 'dashed' : 'solid',
    animated: raw.animated ? true : undefined,
    routing: ROUTINGS.has(raw.routing as MapRouting) ? (raw.routing as MapRouting) : undefined,
    waypoints: normPoints(raw.waypoints),
    // `arrow` is the older both/none/end switch; explicit heads win over it.
    startArrow: ARROWS.has(raw.startArrow as MapArrowHead) ? (raw.startArrow as MapArrowHead) : raw.arrow === 'both' ? 'arrow' : undefined,
    endArrow: ARROWS.has(raw.endArrow as MapArrowHead) ? (raw.endArrow as MapArrowHead) : raw.arrow === 'none' ? 'none' : undefined,
    cornerRadius: num(raw.cornerRadius, 0, 200),
    stroke: str(raw.stroke, 64),
    strokeWidth: num(raw.strokeWidth, 0.5, 40),
    dash: DASHES.has(raw.dash as MapStrokeDash) ? (raw.dash as MapStrokeDash) : undefined,
    labelPos: num(raw.labelPos, 0, 1),
    fontSize: num(raw.fontSize, 4, 400),
    textColor: str(raw.textColor, 64),
    locked: raw.locked === true ? true : undefined,
    layerId: str(raw.layerId, 200) || undefined,
    description: str(raw.description, 20000) || undefined
  })
}

function normLayers(raw: unknown): MapLayer[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: MapLayer[] = []
  for (const l of raw.slice(0, 50)) {
    if (!isObj(l) || typeof l.id !== 'string' || !l.id || seen.has(l.id)) continue
    seen.add(l.id)
    out.push({ id: l.id, name: str(l.name, 120) || 'Layer', visible: l.visible !== false, locked: l.locked === true })
  }
  return out.length ? out : undefined
}

function normViewport(raw: unknown): { x: number; y: number; zoom: number } {
  if (!isObj(raw)) return { x: 0, y: 0, zoom: 1 }
  const zoom = num(raw.zoom, 0.01, 64)
  return { x: num(raw.x) ?? 0, y: num(raw.y) ?? 0, zoom: zoom ?? 1 }
}

function normSettings(raw: unknown): MapSettings | undefined {
  if (!isObj(raw)) return undefined
  const s = clean<MapSettings>({
    grid: bool(raw.grid),
    gridSize: num(raw.gridSize, 2, 200),
    snap: bool(raw.snap),
    guides: bool(raw.guides),
    lineJumps: bool(raw.lineJumps),
    background: str(raw.background, 64),
    theme: str(raw.theme, 64),
    defaultRouting: ROUTINGS.has(raw.defaultRouting as MapRouting) ? (raw.defaultRouting as MapRouting) : undefined,
    defaultEndArrow: ARROWS.has(raw.defaultEndArrow as MapArrowHead) ? (raw.defaultEndArrow as MapArrowHead) : undefined,
    minimap: bool(raw.minimap)
  })
  return Object.keys(s).length ? s : undefined
}

// One page's graph: nodes first (so edges can be checked against them), then a
// pass that clears dangling parent/group references.
function normGraph(rawNodes: unknown, rawEdges: unknown): { nodes: MapNode[]; edges: MapEdge[] } {
  const nodes: MapNode[] = []
  const seen = new Set<string>()
  for (const n of Array.isArray(rawNodes) ? rawNodes : []) {
    const node = normalizeNode(n)
    if (!node || seen.has(node.id)) continue
    seen.add(node.id)
    nodes.push(node)
  }
  for (const n of nodes) if (n.parentId && (!seen.has(n.parentId) || n.parentId === n.id)) delete n.parentId
  const edges: MapEdge[] = []
  const seenE = new Set<string>()
  for (const e of Array.isArray(rawEdges) ? rawEdges : []) {
    const edge = normalizeEdge(e, seen, seenE)
    if (edge) edges.push(edge)
  }
  return { nodes, edges }
}

export function normalizeBody(raw: unknown): MapBody {
  const o = isObj(raw) ? raw : {}
  const { nodes, edges } = normGraph(o.nodes, o.edges)
  const pages: MapPage[] = []
  if (Array.isArray(o.pages)) {
    const seenP = new Set<string>()
    for (const p of o.pages.slice(0, 100)) {
      if (!isObj(p) || typeof p.id !== 'string' || !p.id || seenP.has(p.id)) continue
      seenP.add(p.id)
      const g = normGraph(p.nodes, p.edges)
      pages.push(
        clean<MapPage>({
          id: p.id,
          name: str(p.name, 120) || `Page ${pages.length + 2}`,
          nodes: g.nodes,
          edges: g.edges,
          layers: normLayers(p.layers),
          viewport: isObj(p.viewport) ? normViewport(p.viewport) : undefined
        })
      )
    }
  }
  return clean<MapBody>({
    version: 1,
    nodes,
    edges,
    viewport: normViewport(o.viewport),
    layers: normLayers(o.layers),
    pageName: str(o.pageName, 120) || undefined,
    pages: pages.length ? pages : undefined,
    settings: normSettings(o.settings)
  })
}
