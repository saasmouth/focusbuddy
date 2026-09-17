import type { MapBody, MapEdge, MapNode, MapShape } from './types'

// Pure graph helpers for PlexiDiagrams (the 'map' document type). Kept free of React
// Flow and Electron so they can run in the renderer editor AND in the main
// process AI generator, and be unit-tested directly.

export const MAP_SHAPES: MapShape[] = [
  'process',
  'decision',
  'terminator',
  'data',
  'database',
  'circle',
  'note',
  // Extra stencil shapes (polygon outlines).
  'hexagon',
  'trapezoid',
  'chevron',
  // A swimlane / container band; groups the shapes placed on top of it.
  'lane',
  // A live desk-widget embed; carries widgetId on the node. Inserted from the
  // editor's Insert menu, never proposed by the AI generator.
  'widget'
]

const VALID_SHAPES = new Set<string>(MAP_SHAPES)

export function emptyMapBody(): MapBody {
  return { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
}

// A small starter so a blank map is not an empty void — one start node the user
// builds out from. Mirrors how a fresh sheet/deck opens with something usable.
export function starterMapBody(): MapBody {
  return {
    version: 1,
    nodes: [
      { id: 'n1', x: 240, y: 60, label: 'Start', shape: 'terminator', color: '#2563eb' }
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

// Defensive normaliser: accepts anything parsed from disk / the cloud / an AI
// reply and returns a valid MapBody, dropping malformed entries and edges that
// point at missing nodes (so the editor never throws on a bad body).
export function normalizeMapBody(raw: unknown): MapBody {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<MapBody>
  const nodesIn = Array.isArray(o.nodes) ? o.nodes : []
  const nodes: MapNode[] = []
  const seen = new Set<string>()
  for (const n of nodesIn) {
    if (!n || typeof n !== 'object') continue
    const c = n as Partial<MapNode>
    if (typeof c.id !== 'string' || seen.has(c.id)) continue
    seen.add(c.id)
    nodes.push({
      id: c.id,
      x: Number.isFinite(c.x) ? (c.x as number) : 0,
      y: Number.isFinite(c.y) ? (c.y as number) : 0,
      label: typeof c.label === 'string' ? c.label : '',
      shape: VALID_SHAPES.has(c.shape as string) ? (c.shape as MapShape) : 'process',
      color: typeof c.color === 'string' && c.color ? c.color : '#2563eb',
      ...(Number.isFinite(c.width) ? { width: c.width as number } : {}),
      ...(Number.isFinite(c.height) ? { height: c.height as number } : {}),
      // Preserve widget references. Dropping this would silently unlink every
      // widget node on load, so it is part of the normaliser's whitelist.
      ...(typeof c.widgetId === 'string' && c.widgetId ? { widgetId: c.widgetId } : {})
    })
  }
  const ids = new Set(nodes.map((n) => n.id))
  const edgesIn = Array.isArray(o.edges) ? o.edges : []
  const edges: MapEdge[] = []
  const seenE = new Set<string>()
  for (const e of edgesIn) {
    if (!e || typeof e !== 'object') continue
    const c = e as Partial<MapEdge>
    if (typeof c.source !== 'string' || typeof c.target !== 'string') continue
    if (!ids.has(c.source) || !ids.has(c.target)) continue
    const id = typeof c.id === 'string' && c.id ? c.id : `e-${c.source}-${c.target}`
    if (seenE.has(id)) continue
    seenE.add(id)
    edges.push({
      id,
      source: c.source,
      target: c.target,
      ...(typeof c.label === 'string' && c.label ? { label: c.label } : {}),
      ...(c.sourceHandle != null ? { sourceHandle: c.sourceHandle } : {}),
      ...(c.targetHandle != null ? { targetHandle: c.targetHandle } : {}),
      style: c.style === 'dashed' ? 'dashed' : 'solid',
      ...(c.animated ? { animated: true } : {})
    })
  }
  const vp =
    o.viewport && typeof o.viewport === 'object'
      ? {
          x: Number.isFinite(o.viewport.x) ? o.viewport.x : 0,
          y: Number.isFinite(o.viewport.y) ? o.viewport.y : 0,
          zoom: Number.isFinite(o.viewport.zoom) && o.viewport.zoom! > 0 ? o.viewport.zoom! : 1
        }
      : { x: 0, y: 0, zoom: 1 }
  return { version: 1, nodes, edges, viewport: vp }
}

// Top-down layered layout used for AI-generated graphs (the model returns nodes
// + edges but not coordinates). Each node's layer is the longest path from any
// root; nodes in a layer are spread horizontally and centred. Cycles are handled
// by only advancing a node's layer when not already visited on the current path.
export function autoLayout(
  nodes: MapNode[],
  edges: MapEdge[],
  opts: { colGap?: number; rowGap?: number; originX?: number; originY?: number } = {}
): MapNode[] {
  const colGap = opts.colGap ?? 220
  const rowGap = opts.rowGap ?? 130
  const originX = opts.originX ?? 80
  const originY = opts.originY ?? 60
  if (nodes.length === 0) return nodes

  const ids = nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const outgoing = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const id of ids) {
    outgoing.set(id, [])
    indeg.set(id, 0)
  }
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue
    outgoing.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }

  // Longest-path layering via BFS from roots; nodes with no in-edges start at 0.
  const layer = new Map<string, number>()
  const roots = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  const queue: string[] = roots.length ? [...roots] : [ids[0]]
  for (const r of queue) layer.set(r, 0)
  const guard = nodes.length * nodes.length + nodes.length
  let steps = 0
  while (queue.length && steps++ < guard) {
    const id = queue.shift()!
    const base = layer.get(id) ?? 0
    for (const next of outgoing.get(id) ?? []) {
      const cand = base + 1
      if (cand > (layer.get(next) ?? -1)) {
        layer.set(next, cand)
        queue.push(next)
      }
    }
  }
  // Any node never reached (disconnected island) lands on layer 0.
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0)

  const byLayer = new Map<number, string[]>()
  for (const id of ids) {
    const l = layer.get(id)!
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(id)
  }
  const widest = Math.max(...[...byLayer.values()].map((a) => a.length))
  const pos = new Map<string, { x: number; y: number }>()
  for (const [l, layerIds] of byLayer) {
    const offset = ((widest - layerIds.length) * colGap) / 2
    layerIds.forEach((id, i) => {
      pos.set(id, { x: originX + offset + i * colGap, y: originY + l * rowGap })
    })
  }
  return nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? { x: n.x, y: n.y }) }))
}
