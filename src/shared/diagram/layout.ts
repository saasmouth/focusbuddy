// Auto-layout for PlexiDiagrams. Pure functions over MapNode/MapEdge — no React,
// no DOM — so the editor, the AI generator (main process) and importers share it.
//
// Six algorithms, all size-aware (they read each node's real box via nodeSize):
//   layered  Sugiyama: cycle breaking, longest-path layering, dummy nodes for
//            long edges, barycenter crossing reduction + transpose, and
//            iterative coordinate assignment that centres parents over children
//   tree     tidy tree (Reingold–Tilford contours), forest side by side
//   radial   root at the centre, one ring per depth, wedge ∝ subtree size
//   grid     near-square grid in current reading order
//   organic  seeded Fruchterman–Reingold with size-aware repulsion
//   mindmap  central root, children balanced left/right, subtrees stacked
//
// Invariants every algorithm upholds (tests assert them):
//   • locked and hidden nodes never move; locked nodes are obstacles
//   • containers stay where they are unless named in onlyIds (a container in
//     onlyIds moves as one block and carries its children with it), or a
//     sibling container beside or above them grew and pushed them aside
//   • what is INSIDE a container is laid out inside it, with the same
//     algorithm, below its header or beside its label band; the container
//     grows to fit and never shrinks. Membership is parentId, or else the
//     smallest container that fully contains the node (the app's own rule
//     after a drag), so a template's or an AI diagram's lane contents count
//   • no two visible non-container nodes overlap afterwards
//   • output is deterministic and every moved coordinate is an integer

import type { MapEdge, MapNode } from '../types'
import { nodeSize } from './geom'
import { getShape } from './shapes'

export type LayoutAlgorithm = 'layered' | 'tree' | 'radial' | 'grid' | 'organic' | 'mindmap'
export type LayoutDirection = 'TB' | 'LR' | 'BT' | 'RL'

export interface LayoutOptions {
  algorithm: LayoutAlgorithm
  direction?: LayoutDirection
  nodeGap?: number // space between neighbours in a layer / siblings
  layerGap?: number // space between layers / depths
  onlyIds?: string[] // lay out just this subset; everything else is fixed
  origin?: { x: number; y: number } // top-left of the laid-out block
}

interface Sz {
  w: number
  h: number
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type PosMap = Map<string, { x: number; y: number }>

const DEFAULT_NODE_GAP = 40
const DEFAULT_LAYER_GAP = 70

// ── entry point ─────────────────────────────────────────────────────────────

export function layoutDiagram(nodes: MapNode[], edges: MapEdge[], opts: LayoutOptions): MapNode[] {
  if (!nodes.length) return nodes
  // Containers first: lay out what is INSIDE each lane, pool or frame, inside
  // it (innermost first, growing it to fit and pushing neighbours aside), then
  // the free-standing nodes around them.
  const { nodes: inner, placed } = layoutInsideContainers(nodes, edges, opts)
  // Shapes already laid out inside their container are not laid out again by
  // the free pass (with a selection they are in onlyIds too, and the free pass
  // would carry them straight back out of the lane).
  if (!placed.size) return layoutFree(inner, edges, opts)
  if (opts.onlyIds) {
    const rest = opts.onlyIds.filter((id) => !placed.has(id))
    return rest.length ? layoutFree(inner, edges, { ...opts, onlyIds: rest }) : inner
  }
  return layoutFree(inner, edges, opts)
}

/** Membership is geometric in this app (assignContainers, after a drag): a node
 *  without a parentId belongs to the smallest visible container that fully
 *  contains it. A node never dragged (a template's lane contents, an AI or an
 *  imported diagram) sits visibly in a lane with no parentId; treating it as
 *  free carried it out of its lane, or with a selection onto another one. */
function membership(nodes: MapNode[]): Map<string, MapNode> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const isC = (n: MapNode): boolean => !!getShape(n.shape).container
  const containers = nodes.filter((n) => isC(n) && !n.hidden)
  const out = new Map<string, MapNode>()
  for (const n of nodes) {
    if (n.parentId) {
      const p = byId.get(n.parentId)
      if (p && p !== n && isC(p)) out.set(n.id, p)
      continue
    }
    const b = boxOfNode(n)
    let best: { c: MapNode; area: number } | null = null
    for (const c of containers) {
      if (c === n) continue
      const cb = boxOfNode(c)
      const holds = b.x >= cb.x && b.y >= cb.y && b.x + b.w <= cb.x + cb.w && b.y + b.h <= cb.y + cb.h
      const area = cb.w * cb.h
      if (holds && area > b.w * b.h && (!best || area < best.area)) best = { c, area }
    }
    if (best) out.set(n.id, best.c)
  }
  // Break any cycle (a container geometrically inside its own descendant).
  for (const [id] of out) {
    const seen = new Set<string>([id])
    let c = out.get(id)
    while (c) {
      if (seen.has(c.id)) {
        out.delete(id)
        break
      }
      seen.add(c.id)
      c = out.get(c.id)
    }
  }
  return out
}

function boxOfNode(n: MapNode): Rect {
  const s = nodeSize(n)
  return { x: n.x, y: n.y, w: s.w, h: s.h }
}

/** A container's free interior: inside its label band or header, with a margin. */
function interiorInsets(c: MapNode): { left: number; top: number; right: number; bottom: number } {
  const { w, h } = nodeSize(c)
  const m = 16
  const ins = { left: m, top: m, right: m, bottom: m }
  let t: Rect | undefined
  try {
    t = getShape(c.shape).draw(w, h).text
  } catch {
    t = undefined
  }
  if (!t) return ins
  if (t.x <= 1 && t.h >= h * 0.8 && t.w < w * 0.5) ins.left = Math.ceil(t.w + 12) // a label band down the left (lane)
  else if (t.y <= 1 && t.w >= w * 0.8 && t.h < h * 0.5) ins.top = Math.ceil(t.h + 8) // a header across the top (pool, frame)
  else if (t.y + t.h >= h - 1 && t.w >= w * 0.8 && t.h < h * 0.5) ins.bottom = Math.ceil(t.h + 8) // a caption along the bottom
  else if (t.x + t.w >= w - 1 && t.h >= h * 0.8 && t.w < w * 0.5) ins.right = Math.ceil(t.w + 12) // a band down the right
  else ins.top = Math.max(ins.top, Math.ceil(Math.min(t.y + t.h, h * 0.25) + 8)) // a centred title: keep it clear
  return ins
}

function runAlgorithm(
  algorithm: LayoutAlgorithm,
  ids: string[],
  nodesFor: MapNode[],
  sizes: Map<string, Sz>,
  graphEdges: [string, string][],
  dir: LayoutDirection,
  nodeGap: number,
  layerGap: number
): PosMap {
  switch (algorithm) {
    case 'tree':
      return treeLayout(ids, sizes, graphEdges, dir, nodeGap, layerGap)
    case 'radial':
      return radialLayout(ids, sizes, graphEdges, nodeGap, layerGap)
    case 'grid':
      return gridLayout(nodesFor, sizes, nodeGap)
    case 'organic':
      return organicLayout(ids, sizes, graphEdges, nodeGap)
    case 'mindmap':
      return mindmapLayout(ids, sizes, graphEdges, nodeGap, layerGap)
    case 'layered':
    default:
      return layeredLayout(ids, sizes, graphEdges, dir, nodeGap, layerGap)
  }
}

/**
 * Lay out each container's direct children inside it, innermost container
 * first, with the chosen algorithm. The container grows to fit (it never
 * shrinks) and containers that sat beside or below it move aside by the growth,
 * so stacked swimlanes stay stacked. Without onlyIds every unlocked container
 * with two or more unlocked visible children is laid out; with onlyIds, only a
 * container whose children are ALL among the selection (or that is selected).
 */
function layoutInsideContainers(nodes: MapNode[], edges: MapEdge[], opts: LayoutOptions): { nodes: MapNode[]; placed: Set<string> } {
  const isC = (n: MapNode): boolean => !!getShape(n.shape).container
  const placedIds = new Set<string>()
  if (!nodes.some((n) => isC(n) && !n.hidden)) return { nodes, placed: placedIds }
  const dir: LayoutDirection = opts.direction ?? 'TB'
  const nodeGap = finiteOr(opts.nodeGap, DEFAULT_NODE_GAP, 0)
  const layerGap = finiteOr(opts.layerGap, DEFAULT_LAYER_GAP, 0)
  const only = opts.onlyIds ? new Set(opts.onlyIds) : null
  let cur = nodes.map((n) => ({ ...n }))
  const byId = (): Map<string, MapNode> => new Map(cur.map((n) => [n.id, n]))
  const parentOf = membership(cur)
  const depth = (n: MapNode): number => {
    let d = 0
    for (let c = parentOf.get(n.id); c && d < 50; c = parentOf.get(c.id)) d++
    return d
  }
  const childrenOf = (cid: string): MapNode[] => cur.filter((n) => parentOf.get(n.id)?.id === cid)
  const descendantsOf = (cid: string): string[] => {
    const out: string[] = []
    const walk = (id: string): void => {
      for (const k of cur) if (parentOf.get(k.id)?.id === id) {
        out.push(k.id)
        walk(k.id)
      }
    }
    walk(cid)
    return out
  }
  const containers = cur.filter((n) => isC(n) && !n.hidden && !n.locked).sort((a, b) => depth(b) - depth(a) || cmpStr(a.id, b.id))
  for (const c0 of containers) {
    const c = byId().get(c0.id)!
    const kids = childrenOf(c.id).filter((k) => !k.hidden)
    if (kids.length < 2 || kids.some((k) => k.locked)) continue
    if (only && !only.has(c.id) && !kids.every((k) => only.has(k.id))) continue
    const ids = kids.map((k) => k.id)
    const sizes = new Map<string, Sz>(kids.map((k) => [k.id, nodeSize(k)]))
    // Edges among this container's subtree, attached to its direct children.
    const top = new Map<string, string>()
    for (const k of kids) {
      top.set(k.id, k.id)
      for (const dId of descendantsOf(k.id)) top.set(dId, k.id)
    }
    const ge: [string, string][] = []
    const seen = new Set<string>()
    for (const e of edges) {
      const s = top.get(e.source)
      const t = top.get(e.target)
      if (!s || !t || s === t) continue
      const key = `${s}\u0000${t}`
      if (seen.has(key)) continue
      seen.add(key)
      ge.push([s, t])
    }
    const pos = runAlgorithm(opts.algorithm, ids, kids, sizes, ge, dir, nodeGap, layerGap)
    const bb = boundsOfPos(pos, sizes)
    const ins = interiorInsets(c)
    const placed: Rect[] = []
    const moves = new Map<string, { dx: number; dy: number }>()
    for (const k of [...kids].sort((a, b) => {
      const pa = pos.get(a.id)!
      const pb = pos.get(b.id)!
      return pa.y - pb.y || pa.x - pb.x || cmpStr(a.id, b.id)
    })) {
      const p = pos.get(k.id)!
      const s = sizes.get(k.id)!
      const r = { x: Math.round(c.x + ins.left + (p.x - bb.x)), y: Math.round(c.y + ins.top + (p.y - bb.y)), w: s.w, h: s.h }
      resolveOverlap(r, placed, nodeGap)
      placed.push(r)
      moves.set(k.id, { dx: r.x - k.x, dy: r.y - k.y })
      placedIds.add(k.id)
    }
    // Grow the container to hold the block (never shrink).
    const cs = nodeSize(c)
    const needW = Math.max(...placed.map((r) => r.x + r.w)) - c.x + ins.right
    const needH = Math.max(...placed.map((r) => r.y + r.h)) - c.y + ins.bottom
    const dw = Math.max(0, Math.ceil(needW - cs.w))
    const dh = Math.max(0, Math.ceil(needH - cs.h))
    // Apply: children and their descendants move; the container may grow.
    const shift = new Map<string, { dx: number; dy: number }>()
    for (const [kid, d] of moves) {
      shift.set(kid, d)
      for (const dId of descendantsOf(kid)) shift.set(dId, d)
    }
    const oldBox = { x: c.x, y: c.y, w: cs.w, h: cs.h }
    cur = cur.map((n) => {
      const d = shift.get(n.id)
      if (d) return { ...n, x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) }
      if (n.id === c.id && (dw || dh)) return { ...n, width: cs.w + dw, height: cs.h + dh }
      return n
    })
    if (dw || dh) cur = pushNeighbours(cur, c.id, oldBox, dw, dh, parentOf, descendantsOf)
  }
  return { nodes: cur, placed: placedIds }
}

/** A container grew by (dw, dh): siblings that sat wholly below it (overlapping
 *  its columns) move down by dh, those wholly to its right (overlapping its
 *  rows) move right by dw, each with everything inside them. */
function pushNeighbours(
  nodes: MapNode[],
  grownId: string,
  old: Rect,
  dw: number,
  dh: number,
  parentOf: Map<string, MapNode>,
  descendantsOf: (id: string) => string[]
): MapNode[] {
  const parent = parentOf.get(grownId)?.id
  const shift = new Map<string, { dx: number; dy: number }>()
  for (const n of nodes) {
    if (n.id === grownId || parentOf.get(n.id)?.id !== parent) continue
    const b = boxOfNode(n)
    const below = dh > 0 && b.y >= old.y + old.h - 1 && b.x < old.x + old.w && b.x + b.w > old.x
    const right = dw > 0 && b.x >= old.x + old.w - 1 && b.y < old.y + old.h && b.y + b.h > old.y
    if (!below && !right) continue
    const d = { dx: right ? dw : 0, dy: below ? dh : 0 }
    shift.set(n.id, d)
    for (const dId of descendantsOf(n.id)) shift.set(dId, d)
  }
  if (!shift.size) return nodes
  return nodes.map((n) => {
    const d = shift.get(n.id)
    return d ? { ...n, x: n.x + d.dx, y: n.y + d.dy } : n
  })
}

function layoutFree(nodes: MapNode[], edges: MapEdge[], opts: LayoutOptions): MapNode[] {
  if (!nodes.length) return nodes
  const dir: LayoutDirection = opts.direction ?? 'TB'
  const nodeGap = finiteOr(opts.nodeGap, DEFAULT_NODE_GAP, 0)
  const layerGap = finiteOr(opts.layerGap, DEFAULT_LAYER_GAP, 0)
  const only = opts.onlyIds ? new Set(opts.onlyIds) : null

  const isContainer = (n: MapNode): boolean => !!getShape(n.shape).container
  const parentOf = membership(nodes)
  // The container a node sits in (nearest ancestor that exists and is a container).
  const containerOf = (n: MapNode): MapNode | undefined => {
    const p = parentOf.get(n.id)
    return p && p !== n && isContainer(p) ? p : undefined
  }
  // Every ancestor container, nearest first (guards against parent cycles).
  const ancestors = (n: MapNode): MapNode[] => {
    const out: MapNode[] = []
    const seen = new Set<string>([n.id])
    let c = containerOf(n)
    while (c && !seen.has(c.id)) {
      out.push(c)
      seen.add(c.id)
      c = containerOf(c)
    }
    return out
  }

  // Decide who moves. A node moves when it is visible, unlocked, and either it is
  // in onlyIds or (no onlyIds) it is a free-standing non-container node.
  const movable: MapNode[] = []
  const movableIds = new Set<string>()
  for (const n of nodes) {
    if (n.hidden || n.locked) continue
    const anc = ancestors(n)
    if (only) {
      if (!only.has(n.id)) continue
      // A child whose container also moves rides along with the container.
      if (anc.some((a) => only.has(a.id) && !a.locked && !a.hidden)) continue
    } else {
      if (isContainer(n) || anc.length) continue
    }
    movable.push(n)
    movableIds.add(n.id)
  }
  if (!movable.length) return nodes

  // Children that ride with a moving container (all descendants, any depth).
  const riders = new Map<string, string>() // child id → moving container id
  for (const n of nodes) {
    for (const a of ancestors(n)) {
      if (movableIds.has(a.id)) {
        riders.set(n.id, a.id)
        break
      }
    }
  }

  // Edge endpoints: a rider's edges attach to its moving container.
  const endpoint = (id: string): string | undefined => {
    if (movableIds.has(id)) return id
    const r = riders.get(id)
    return r && movableIds.has(r) ? r : undefined
  }
  const graphEdges: [string, string][] = []
  const seenE = new Set<string>()
  for (const e of edges) {
    const s = endpoint(e.source)
    const t = endpoint(e.target)
    if (!s || !t || s === t) continue
    const k = `${s}\u0000${t}`
    if (seenE.has(k)) continue
    seenE.add(k)
    graphEdges.push([s, t])
  }

  const ids = movable.map((n) => n.id)
  const sizes = new Map<string, Sz>(movable.map((n) => [n.id, nodeSize(n)]))

  const pos: PosMap = runAlgorithm(opts.algorithm, ids, movable, sizes, graphEdges, dir, nodeGap, layerGap)

  // Translate the block so its top-left lands on the origin (default: where the
  // moving nodes currently start, so a re-layout stays in place).
  const bb = boundsOfPos(pos, sizes)
  const origin = opts.origin ?? {
    x: Math.min(...movable.map((n) => n.x)),
    y: Math.min(...movable.map((n) => n.y))
  }
  const dx = origin.x - bb.x
  const dy = origin.y - bb.y
  const placed = new Map<string, Rect>()
  for (const id of ids) {
    const p = pos.get(id)!
    const s = sizes.get(id)!
    placed.set(id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy), w: s.w, h: s.h })
  }

  // Fixed obstacles: every visible node that does not move and is not riding.
  const fixed: { n: MapNode; r: Rect; container: boolean }[] = []
  for (const n of nodes) {
    if (n.hidden || movableIds.has(n.id) || riders.has(n.id)) continue
    const s = nodeSize(n)
    fixed.push({ n, r: { x: n.x, y: n.y, w: s.w, h: s.h }, container: isContainer(n) })
  }

  // Block-level avoidance. With onlyIds the whole subset steps to the right of
  // existing content when it would land on it. Without onlyIds the same happens
  // only for containers and their (fixed) children — locked loose nodes are
  // handled per node below so one locked shape does not shove the whole map.
  const blockObstacles = only
    ? fixed
    : fixed.filter((f) => f.container || ancestors(f.n).length > 0)
  if (blockObstacles.length) {
    const rects = [...placed.values()]
    const hit = rects.some((r) => blockObstacles.some((o) => overlaps(r, o.r)))
    if (hit) {
      const right = Math.max(...blockObstacles.map((o) => o.r.x + o.r.w))
      const blockLeft = Math.min(...rects.map((r) => r.x))
      const shift = Math.ceil(right + nodeGap - blockLeft)
      for (const r of placed.values()) r.x += shift
    }
  }

  // Per-node resolution: fixed non-container nodes are already "placed"; each
  // moving node, in reading order, steps to the nearest free spot if it overlaps
  // anything placed before it. This is also the safety net that turns any
  // residual overlap (organic, rounding) into a guaranteed-clean result.
  const solid: Rect[] = fixed.filter((f) => !f.container).map((f) => f.r)
  const order = [...ids].sort((a, b) => {
    const ra = placed.get(a)!
    const rb = placed.get(b)!
    return ra.y - rb.y || ra.x - rb.x || cmpStr(a, b)
  })
  for (const id of order) {
    // A moving container (onlyIds) is resolved like any other box so it does not
    // land on loose nodes either.
    const r = placed.get(id)!
    resolveOverlap(r, solid, nodeGap)
    solid.push(r)
  }

  // Write back. Riders shift by their container's delta.
  const delta = new Map<string, { dx: number; dy: number }>()
  for (const n of movable) {
    const r = placed.get(n.id)!
    delta.set(n.id, { dx: r.x - n.x, dy: r.y - n.y })
  }
  return nodes.map((n) => {
    const r = placed.get(n.id)
    if (r) return { ...n, x: r.x, y: r.y }
    const c = riders.get(n.id)
    if (c) {
      const d = delta.get(c)!
      return { ...n, x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) }
    }
    return n
  })
}

// ── shared helpers ──────────────────────────────────────────────────────────

function finiteOr(v: number | undefined, d: number, min: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : d
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function boundsOfPos(pos: PosMap, sizes: Map<string, Sz>): Rect {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const [id, p] of pos) {
    const s = sizes.get(id)!
    x1 = Math.min(x1, p.x)
    y1 = Math.min(y1, p.y)
    x2 = Math.max(x2, p.x + s.w)
    y2 = Math.max(y2, p.y + s.h)
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

// Move r (integer x/y) to the nearest position that overlaps nothing in `placed`.
// Candidates are the four "touching" positions around each blocker; blocked
// candidates spawn candidates around their own blockers (bounded BFS). The final
// fallback — right of everything — always succeeds, so this never fails.
function resolveOverlap(r: Rect, placed: Rect[], gap: number): void {
  const blockersOf = (c: Rect): Rect[] => placed.filter((p) => overlaps(c, p))
  let blockers = blockersOf(r)
  if (!blockers.length) return
  const ox = r.x
  const oy = r.y
  const seen = new Set<string>()
  const cands: { x: number; y: number; d: number }[] = []
  const push = (x: number, y: number): void => {
    const k = `${x},${y}`
    if (seen.has(k)) return
    seen.add(k)
    cands.push({ x, y, d: (x - ox) * (x - ox) + (y - oy) * (y - oy) })
  }
  const around = (from: Rect, bs: Rect[]): void => {
    for (const b of bs) {
      push(Math.ceil(b.x + b.w + gap), from.y)
      push(Math.floor(b.x - r.w - gap), from.y)
      push(from.x, Math.ceil(b.y + b.h + gap))
      push(from.x, Math.floor(b.y - r.h - gap))
    }
  }
  around(r, blockers)
  let budget = 400
  while (cands.length && budget-- > 0) {
    cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x)
    const c = cands.shift()!
    const test = { x: c.x, y: c.y, w: r.w, h: r.h }
    blockers = blockersOf(test)
    if (!blockers.length) {
      r.x = c.x
      r.y = c.y
      return
    }
    around(test, blockers)
  }
  r.x = Math.ceil(Math.max(...placed.map((p) => p.x + p.w)) + gap)
}

// Undirected adjacency + connected components, in input order.
function components(ids: string[], edges: [string, string][]): string[][] {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [s, t] of edges) {
    adj.get(s)!.push(t)
    adj.get(t)!.push(s)
  }
  const seen = new Set<string>()
  const out: string[][] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const comp: string[] = []
    const stack = [id]
    seen.add(id)
    while (stack.length) {
      const v = stack.pop()!
      comp.push(v)
      for (const w of adj.get(v)!) {
        if (!seen.has(w)) {
          seen.add(w)
          stack.push(w)
        }
      }
    }
    const idx = new Map(ids.map((x, i) => [x, i]))
    comp.sort((a, b) => idx.get(a)! - idx.get(b)!)
    out.push(comp)
  }
  return out
}

// Place blocks (each a PosMap in its own frame) side by side along x (or y),
// aligned on the other axis' start. Returns one merged PosMap.
function packBlocks(blocks: PosMap[], sizes: Map<string, Sz>, gap: number, axis: 'x' | 'y'): PosMap {
  const out: PosMap = new Map()
  let cursor = 0
  for (const b of blocks) {
    if (!b.size) continue
    const bb = boundsOfPos(b, sizes)
    for (const [id, p] of b) {
      out.set(
        id,
        axis === 'x' ? { x: p.x - bb.x + cursor, y: p.y - bb.y } : { x: p.x - bb.x, y: p.y - bb.y + cursor }
      )
    }
    cursor += (axis === 'x' ? bb.w : bb.h) + gap
  }
  return out
}

// Abstract frame: "cross" runs along a layer, "main" runs from layer to layer.
// TB: cross=x, main=y. LR: cross=y, main=x. BT/RL mirror the main axis.
function isHorizontal(dir: LayoutDirection): boolean {
  return dir === 'LR' || dir === 'RL'
}
function crossOf(s: Sz, dir: LayoutDirection): number {
  return isHorizontal(dir) ? s.h : s.w
}
function mainOf(s: Sz, dir: LayoutDirection): number {
  return isHorizontal(dir) ? s.w : s.h
}
// Convert abstract top-left (c, m) into real top-left for the direction.
function toReal(c: number, m: number, s: Sz, dir: LayoutDirection): { x: number; y: number } {
  switch (dir) {
    case 'LR':
      return { x: m, y: c }
    case 'RL':
      return { x: -m - s.w, y: c }
    case 'BT':
      return { x: c, y: -m - s.h }
    case 'TB':
    default:
      return { x: c, y: m }
  }
}

// A spanning forest over the directed graph: roots are in-degree-0 nodes (input
// order); each node hangs under the first node to reach it in BFS. Nodes only on
// cycles get promoted to roots so every node appears exactly once.
function spanningForest(ids: string[], edges: [string, string][]): { roots: string[]; children: Map<string, string[]> } {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const [s, t] of edges) {
    out.get(s)!.push(t)
    indeg.set(t, indeg.get(t)! + 1)
  }
  const children = new Map<string, string[]>(ids.map((id) => [id, []]))
  const seen = new Set<string>()
  const roots: string[] = []
  const grow = (root: string): void => {
    roots.push(root)
    seen.add(root)
    const q = [root]
    for (let i = 0; i < q.length; i++) {
      const v = q[i]!
      for (const w of out.get(v)!) {
        if (seen.has(w)) continue
        seen.add(w)
        children.get(v)!.push(w)
        q.push(w)
      }
    }
  }
  for (const id of ids) if (indeg.get(id) === 0 && !seen.has(id)) grow(id)
  for (const id of ids) if (!seen.has(id)) grow(id)
  return { roots, children }
}

// ── layered (Sugiyama) ──────────────────────────────────────────────────────

const DUMMY = '\u0000d'

function layeredLayout(
  ids: string[],
  sizes: Map<string, Sz>,
  edges: [string, string][],
  dir: LayoutDirection,
  nodeGap: number,
  layerGap: number
): PosMap {
  // Each connected component is laid out on its own and packed along the cross
  // axis, so islands do not widen each other's layers.
  const comps = components(ids, edges)
  const blocks: PosMap[] = []
  const abstractSizes = new Map<string, Sz>()
  for (const id of ids) {
    const s = sizes.get(id)!
    abstractSizes.set(id, { w: crossOf(s, dir), h: mainOf(s, dir) })
  }
  for (const comp of comps) {
    const set = new Set(comp)
    const cEdges = edges.filter(([s]) => set.has(s))
    blocks.push(layeredComponent(comp, abstractSizes, cEdges, nodeGap, layerGap))
  }
  // Pack in the abstract frame (x = cross, y = main), then map to the direction.
  const packed = packBlocks(blocks, abstractSizes, nodeGap * 1.5, 'x')
  const out: PosMap = new Map()
  for (const [id, p] of packed) out.set(id, toReal(p.x, p.y, sizes.get(id)!, dir))
  return out
}

// Lays out one component in the abstract frame: x = cross, y = main (both top-left).
function layeredComponent(
  ids: string[],
  sz: Map<string, Sz>,
  edges: [string, string][],
  nodeGap: number,
  layerGap: number
): PosMap {
  // 1. Cycle breaking: DFS, reverse every edge into a node still on the stack.
  const outAdj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [s, t] of edges) outAdj.get(s)!.push(t)
  const state = new Map<string, number>() // 1 = on stack, 2 = done
  const reversed = new Set<string>()
  const indeg0 = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const [, t] of edges) indeg0.set(t, indeg0.get(t)! + 1)
  const starts = [...ids.filter((id) => indeg0.get(id) === 0), ...ids]
  for (const start of starts) {
    if (state.has(start)) continue
    // Iterative DFS keeps deep chains from overflowing the stack.
    const stack: { v: string; i: number }[] = [{ v: start, i: 0 }]
    state.set(start, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]!
      const nbrs = outAdj.get(top.v)!
      if (top.i < nbrs.length) {
        const w = nbrs[top.i++]!
        const st = state.get(w)
        if (st === 1) reversed.add(`${top.v}\u0000${w}`)
        else if (st === undefined) {
          state.set(w, 1)
          stack.push({ v: w, i: 0 })
        }
      } else {
        state.set(top.v, 2)
        stack.pop()
      }
    }
  }
  const dag: [string, string][] = []
  const dagSeen = new Set<string>()
  for (const [s, t] of edges) {
    const [a, b] = reversed.has(`${s}\u0000${t}`) ? [t, s] : [s, t]
    const k = `${a}\u0000${b}`
    if (a === b || dagSeen.has(k)) continue
    dagSeen.add(k)
    dag.push([a, b])
  }

  // 2. Longest-path layering (Kahn order).
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]))
  const pred = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [s, t] of dag) {
    succ.get(s)!.push(t)
    pred.get(t)!.push(s)
  }
  const indeg = new Map<string, number>(ids.map((id) => [id, pred.get(id)!.length]))
  const layer = new Map<string, number>()
  const queue = ids.filter((id) => indeg.get(id) === 0)
  for (const id of queue) layer.set(id, 0)
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]!
    for (const w of succ.get(v)!) {
      layer.set(w, Math.max(layer.get(w) ?? 0, layer.get(v)! + 1))
      indeg.set(w, indeg.get(w)! - 1)
      if (indeg.get(w) === 0) queue.push(w)
    }
  }
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0) // unreachable safety

  // Pull sources down next to their first child (tighter long-range edges).
  for (const id of ids) {
    if (pred.get(id)!.length || !succ.get(id)!.length) continue
    const minChild = Math.min(...succ.get(id)!.map((c) => layer.get(c)!))
    if (minChild - 1 > layer.get(id)!) layer.set(id, minChild - 1)
  }

  // 3. Dummy nodes for edges spanning more than one layer.
  const lsz = new Map<string, Sz>(sz)
  const up = new Map<string, string[]>() // node → neighbours in layer above
  const down = new Map<string, string[]>() // node → neighbours in layer below
  const all: string[] = [...ids]
  for (const id of ids) {
    up.set(id, [])
    down.set(id, [])
  }
  let dummyN = 0
  const dummyW = Math.max(4, Math.min(16, nodeGap / 2))
  for (const [s, t] of dag) {
    let prev = s
    const ls = layer.get(s)!
    const lt = layer.get(t)!
    for (let l = ls + 1; l < lt; l++) {
      const d = `${DUMMY}${dummyN++}`
      layer.set(d, l)
      lsz.set(d, { w: dummyW, h: 0 })
      up.set(d, [])
      down.set(d, [])
      all.push(d)
      down.get(prev)!.push(d)
      up.get(d)!.push(prev)
      prev = d
    }
    down.get(prev)!.push(t)
    up.get(t)!.push(prev)
  }
  const isDummy = (id: string): boolean => id.startsWith(DUMMY)

  // 4. Initial order: DFS preorder from sources, so subtrees start contiguous.
  const L = Math.max(0, ...all.map((id) => layer.get(id)!)) + 1
  const layers: string[][] = Array.from({ length: L }, () => [])
  const placedOrder = new Set<string>()
  const visit = (root: string): void => {
    const stack = [root]
    while (stack.length) {
      const v = stack.pop()!
      if (placedOrder.has(v)) continue
      placedOrder.add(v)
      layers[layer.get(v)!]!.push(v)
      const ch = down.get(v)!
      for (let i = ch.length - 1; i >= 0; i--) if (!placedOrder.has(ch[i]!)) stack.push(ch[i]!)
    }
  }
  for (const id of ids) if (!up.get(id)!.length) visit(id)
  for (const id of all) if (!placedOrder.has(id)) visit(id)

  // 5. Crossing reduction: barycenter sweeps + adjacent transposition, keeping
  // the best ordering seen.
  const posIn = new Map<string, number>()
  const reindex = (): void => {
    for (const lay of layers) lay.forEach((id, i) => posIn.set(id, i))
  }
  reindex()
  const countBetween = (upper: string[], lower: string[]): number => {
    const pairs: [number, number][] = []
    for (const u of upper) for (const w of down.get(u)!) pairs.push([posIn.get(u)!, posIn.get(w)!])
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    // Count inversions in the lower positions with a Fenwick tree.
    const n = lower.length
    const bit = new Array<number>(n + 1).fill(0)
    let inv = 0
    let seenCount = 0
    for (const [, q] of pairs) {
      // number already seen with lower pos > q
      let s = 0
      for (let i = q + 1; i > 0; i -= i & -i) s += bit[i]!
      inv += seenCount - s
      for (let i = q + 1; i <= n; i += i & -i) bit[i]!++
      seenCount++
    }
    return inv
  }
  const totalCrossings = (): number => {
    let c = 0
    for (let l = 0; l + 1 < L; l++) c += countBetween(layers[l]!, layers[l + 1]!)
    return c
  }
  let best = layers.map((l) => [...l])
  let bestC = totalCrossings()
  const sweeps = all.length > 600 ? 8 : 24
  for (let it = 0; it < sweeps && bestC > 0; it++) {
    const downward = it % 2 === 0
    const range = downward ? [...Array(L).keys()].slice(1) : [...Array(L).keys()].slice(0, -1).reverse()
    for (const l of range) {
      const lay = layers[l]!
      const bary = new Map<string, number>()
      for (const v of lay) {
        const nb = downward ? up.get(v)! : down.get(v)!
        bary.set(v, nb.length ? nb.reduce((s, w) => s + posIn.get(w)!, 0) / nb.length : posIn.get(v)!)
      }
      lay.sort((a, b) => bary.get(a)! - bary.get(b)! || posIn.get(a)! - posIn.get(b)!)
      lay.forEach((id, i) => posIn.set(id, i))
    }
    transpose(layers, posIn, up, down)
    const c = totalCrossings()
    if (c < bestC) {
      bestC = c
      best = layers.map((l) => [...l])
    }
  }
  for (let l = 0; l < L; l++) layers[l] = best[l]!
  reindex()

  // 6. Coordinate assignment (cross axis, centres). Pack each layer, then
  // alternate passes pulling each node toward its neighbours in the adjacent
  // layer (the midpoint of their extent, so a parent sits centred over its
  // children) while an order-preserving solver keeps the minimum separation.
  const cx = new Map<string, number>()
  const sep = (a: string, b: string): number => {
    const gap = isDummy(a) || isDummy(b) ? nodeGap / 2 : nodeGap
    return lsz.get(a)!.w / 2 + lsz.get(b)!.w / 2 + gap
  }
  for (const lay of layers) {
    let x = 0
    lay.forEach((id, i) => {
      if (i > 0) x += sep(lay[i - 1]!, id)
      cx.set(id, x)
    })
    const mid = x / 2
    for (const id of lay) cx.set(id, cx.get(id)! - mid)
  }
  const passes = 10
  for (let p = 0; p < passes; p++) {
    // Even passes look up (align to parents), odd passes look down (centre
    // parents over children). The last pass is a downward-looking one.
    const lookUp = (passes - 1 - p) % 2 === 1
    const range = lookUp ? [...Array(L).keys()].slice(1) : [...Array(L).keys()].slice(0, -1).reverse()
    for (const l of range) {
      const lay = layers[l]!
      const desired = lay.map((v) => {
        const nb = lookUp ? up.get(v)! : down.get(v)!
        if (!nb.length) return cx.get(v)!
        let lo = Infinity
        let hi = -Infinity
        for (const w of nb) {
          lo = Math.min(lo, cx.get(w)!)
          hi = Math.max(hi, cx.get(w)!)
        }
        return (lo + hi) / 2
      })
      const seps = lay.slice(1).map((v, i) => sep(lay[i]!, v))
      const solved = placeOrdered(desired, seps)
      lay.forEach((v, i) => cx.set(v, solved[i]!))
    }
  }

  // 7. Main axis: each layer is a band as deep as its deepest node.
  const out: PosMap = new Map()
  let m = 0
  for (const lay of layers) {
    const depth = Math.max(0, ...lay.map((id) => lsz.get(id)!.h))
    for (const id of lay) {
      if (isDummy(id)) continue
      const s = lsz.get(id)!
      out.set(id, { x: cx.get(id)! - s.w / 2, y: m + (depth - s.h) / 2 })
    }
    m += depth + layerGap
  }
  return out
}

// One round of adjacent swaps that strictly reduce crossings with both
// neighbouring layers.
function transpose(
  layers: string[][],
  posIn: Map<string, number>,
  up: Map<string, string[]>,
  down: Map<string, string[]>
): void {
  const pairCross = (u: string, v: string): number => {
    // crossings if u is left of v
    let c = 0
    for (const nbm of [up, down]) {
      const nu = nbm.get(u)!
      const nv = nbm.get(v)!
      for (const a of nu) for (const b of nv) if (posIn.get(a)! > posIn.get(b)!) c++
    }
    return c
  }
  for (let round = 0; round < 2; round++) {
    let improved = false
    for (const lay of layers) {
      for (let i = 0; i + 1 < lay.length; i++) {
        const u = lay[i]!
        const v = lay[i + 1]!
        if (pairCross(v, u) < pairCross(u, v)) {
          lay[i] = v
          lay[i + 1] = u
          posIn.set(v, i)
          posIn.set(u, i + 1)
          improved = true
        }
      }
    }
    if (!improved) break
  }
}

// Given desired centres for an ordered row and the minimum distance between
// consecutive centres, return centres that keep the order and separations while
// minimising squared deviation from the desired values (pool-adjacent blocks).
function placeOrdered(desired: number[], seps: number[]): number[] {
  const n = desired.length
  if (!n) return []
  const off: number[] = [0]
  for (let i = 1; i < n; i++) off.push(off[i - 1]! + seps[i - 1]!)
  // Each block: [start, end], position p = mean(desired_i - off_i) for i in block.
  const blocks: { s: number; e: number; sum: number; cnt: number }[] = []
  for (let i = 0; i < n; i++) {
    blocks.push({ s: i, e: i, sum: desired[i]! - off[i]!, cnt: 1 })
    // Merge while the previous block would push into this one. Within a merged
    // block nodes sit at exact offsets, so the condition compares base positions.
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!
      const a = blocks[blocks.length - 2]!
      if (a.sum / a.cnt >= b.sum / b.cnt) {
        a.e = b.e
        a.sum += b.sum
        a.cnt += b.cnt
        blocks.pop()
      } else break
    }
  }
  const out = new Array<number>(n)
  for (const b of blocks) {
    const base = b.sum / b.cnt
    for (let i = b.s; i <= b.e; i++) out[i] = base + off[i]!
  }
  return out
}

// ── tree (tidy, Reingold–Tilford contours) ──────────────────────────────────

function treeLayout(
  ids: string[],
  sizes: Map<string, Sz>,
  edges: [string, string][],
  dir: LayoutDirection,
  nodeGap: number,
  layerGap: number
): PosMap {
  const { roots, children } = spanningForest(ids, edges)
  const asz = new Map<string, Sz>()
  for (const id of ids) {
    const s = sizes.get(id)!
    asz.set(id, { w: crossOf(s, dir), h: mainOf(s, dir) })
  }
  const blocks: PosMap[] = []
  for (const root of roots) blocks.push(tidyTree(root, children, asz, nodeGap, layerGap))
  const packed = packBlocks(blocks, asz, nodeGap * 1.5, 'x')
  const out: PosMap = new Map()
  for (const [id, p] of packed) out.set(id, toReal(p.x, p.y, sizes.get(id)!, dir))
  return out
}

interface Contour {
  l: number[] // per relative depth: leftmost edge relative to subtree root centre
  r: number[]
}

// Abstract frame: x = cross (top-left), y = main (top-left).
function tidyTree(
  root: string,
  children: Map<string, string[]>,
  sz: Map<string, Sz>,
  nodeGap: number,
  layerGap: number
): PosMap {
  const rel = new Map<string, number>() // child centre relative to parent centre
  const depthOf = new Map<string, number>()
  // Post-order without recursion.
  const order: string[] = []
  const stack = [root]
  depthOf.set(root, 0)
  while (stack.length) {
    const v = stack.pop()!
    order.push(v)
    for (const c of children.get(v)!) {
      depthOf.set(c, depthOf.get(v)! + 1)
      stack.push(c)
    }
  }
  const contour = new Map<string, Contour>()
  for (let i = order.length - 1; i >= 0; i--) {
    const v = order[i]!
    const w = sz.get(v)!.w
    const ch = children.get(v)!
    if (!ch.length) {
      contour.set(v, { l: [-w / 2], r: [w / 2] })
      continue
    }
    // Place children left to right as close as their contours allow.
    const offs: number[] = [0]
    const acc: Contour = { l: [...contour.get(ch[0]!)!.l], r: [...contour.get(ch[0]!)!.r] }
    for (let k = 1; k < ch.length; k++) {
      const c = contour.get(ch[k]!)!
      let shift = -Infinity
      const shared = Math.min(acc.r.length, c.l.length)
      for (let d = 0; d < shared; d++) shift = Math.max(shift, acc.r[d]! - c.l[d]! + nodeGap)
      offs.push(shift)
      for (let d = 0; d < c.l.length; d++) {
        const L = c.l[d]! + shift
        const R = c.r[d]! + shift
        if (d < acc.l.length) {
          acc.l[d] = Math.min(acc.l[d]!, L)
          acc.r[d] = Math.max(acc.r[d]!, R)
        } else {
          acc.l.push(L)
          acc.r.push(R)
        }
      }
    }
    const mid = (offs[0]! + offs[offs.length - 1]!) / 2
    ch.forEach((c, k) => rel.set(c, offs[k]! - mid))
    contour.set(v, {
      l: [-w / 2, ...acc.l.map((x) => x - mid)],
      r: [w / 2, ...acc.r.map((x) => x - mid)]
    })
    for (const c of ch) contour.delete(c) // free memory as we go
  }
  // Depth bands.
  const depthMain: number[] = []
  for (const v of order) {
    const d = depthOf.get(v)!
    depthMain[d] = Math.max(depthMain[d] ?? 0, sz.get(v)!.h)
  }
  const depthTop: number[] = []
  let m = 0
  for (let d = 0; d < depthMain.length; d++) {
    depthTop[d] = m
    m += depthMain[d]! + layerGap
  }
  const out: PosMap = new Map()
  const centre = new Map<string, number>([[root, 0]])
  for (const v of order) {
    const c = centre.get(v)!
    const s = sz.get(v)!
    const d = depthOf.get(v)!
    out.set(v, { x: c - s.w / 2, y: depthTop[d]! + (depthMain[d]! - s.h) / 2 })
    for (const ch of children.get(v)!) centre.set(ch, c + rel.get(ch)!)
  }
  return out
}

// ── radial ──────────────────────────────────────────────────────────────────

function radialLayout(
  ids: string[],
  sizes: Map<string, Sz>,
  edges: [string, string][],
  nodeGap: number,
  layerGap: number
): PosMap {
  const { roots, children } = spanningForest(ids, edges)
  const blocks: PosMap[] = []
  for (const root of roots) blocks.push(radialTree(root, children, sizes, nodeGap, layerGap))
  return packRows(blocks, sizes, nodeGap * 2)
}

function radialTree(
  root: string,
  children: Map<string, string[]>,
  sizes: Map<string, Sz>,
  nodeGap: number,
  layerGap: number
): PosMap {
  // BFS order, depths and subtree sizes.
  const order = [root]
  const depth = new Map<string, number>([[root, 0]])
  for (let i = 0; i < order.length; i++) {
    const v = order[i]!
    for (const c of children.get(v)!) {
      depth.set(c, depth.get(v)! + 1)
      order.push(c)
    }
  }
  const weight = new Map<string, number>()
  for (let i = order.length - 1; i >= 0; i--) {
    const v = order[i]!
    weight.set(v, 1 + children.get(v)!.reduce((s, c) => s + weight.get(c)!, 0))
  }
  // Wedges: each child gets a share of its parent's wedge ∝ its subtree size.
  const wedge = new Map<string, [number, number]>([[root, [-Math.PI / 2, (3 * Math.PI) / 2]]])
  for (const v of order) {
    const [a0, a1] = wedge.get(v)!
    const ch = children.get(v)!
    const total = ch.reduce((s, c) => s + weight.get(c)!, 0)
    let a = a0
    for (const c of ch) {
      const span = ((a1 - a0) * weight.get(c)!) / total
      wedge.set(c, [a, a + span])
      a += span
    }
  }
  const diag = (id: string): number => {
    const s = sizes.get(id)!
    return Math.sqrt(s.w * s.w + s.h * s.h)
  }
  const maxD = Math.max(...order.map((v) => depth.get(v)!))
  const maxDiag: number[] = new Array(maxD + 1).fill(0)
  const count: number[] = new Array(maxD + 1).fill(0)
  const angles: number[][] = Array.from({ length: maxD + 1 }, () => [])
  for (const v of order) {
    const d = depth.get(v)!
    maxDiag[d] = Math.max(maxDiag[d]!, diag(v))
    const [a0, a1] = wedge.get(v)!
    angles[d]!.push((a0 + a1) / 2)
    count[d]!++
  }
  // Ring radii: far enough from the previous ring that circumscribed circles
  // cannot touch, and large enough that the smallest angular gap between
  // neighbours on the ring gives a chord that clears the largest node. Any two
  // nodes on a ring are at least one neighbour gap apart, so this is safe.
  const radius: number[] = [0]
  for (let d = 1; d <= maxD; d++) {
    let r = radius[d - 1]! + (maxDiag[d - 1]! + maxDiag[d]!) / 2 + layerGap
    if (count[d]! > 1) {
      const as = angles[d]!.slice().sort((a, b) => a - b)
      let gap = 2 * Math.PI - (as[as.length - 1]! - as[0]!)
      for (let i = 1; i < as.length; i++) gap = Math.min(gap, as[i]! - as[i - 1]!)
      const theta = Math.min(Math.max(gap, 1e-6), Math.PI)
      r = Math.max(r, (maxDiag[d]! + nodeGap) / (2 * Math.sin(theta / 2)))
    }
    radius.push(r)
  }
  const out: PosMap = new Map()
  for (const v of order) {
    const d = depth.get(v)!
    const [a0, a1] = wedge.get(v)!
    const a = (a0 + a1) / 2
    const s = sizes.get(v)!
    const cx = d === 0 ? 0 : radius[d]! * Math.cos(a)
    const cy = d === 0 ? 0 : radius[d]! * Math.sin(a)
    out.set(v, { x: cx - s.w / 2, y: cy - s.h / 2 })
  }
  return out
}

// Shelf-pack blocks into rows no wider than ~ the square root of total area.
function packRows(blocks: PosMap[], sizes: Map<string, Sz>, gap: number): PosMap {
  const boxes = blocks.filter((b) => b.size).map((b) => ({ b, bb: boundsOfPos(b, sizes) }))
  if (boxes.length === 1) return boxes[0]!.b
  const area = boxes.reduce((s, x) => s + (x.bb.w + gap) * (x.bb.h + gap), 0)
  const maxRow = Math.max(Math.sqrt(area) * 1.3, ...boxes.map((x) => x.bb.w))
  const out: PosMap = new Map()
  let x = 0
  let y = 0
  let rowH = 0
  for (const { b, bb } of boxes) {
    if (x > 0 && x + bb.w > maxRow) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    for (const [id, p] of b) out.set(id, { x: p.x - bb.x + x, y: p.y - bb.y + y })
    x += bb.w + gap
    rowH = Math.max(rowH, bb.h)
  }
  return out
}

// ── grid ────────────────────────────────────────────────────────────────────

function gridLayout(movable: MapNode[], sizes: Map<string, Sz>, gap: number): PosMap {
  const sorted = [...movable].sort((a, b) => a.y - b.y || a.x - b.x || cmpStr(a.id, b.id))
  const n = sorted.length
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const colW = new Array<number>(cols).fill(0)
  const rowH = new Array<number>(rows).fill(0)
  sorted.forEach((nd, i) => {
    const s = sizes.get(nd.id)!
    colW[i % cols] = Math.max(colW[i % cols]!, s.w)
    rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)]!, s.h)
  })
  const colX: number[] = []
  let x = 0
  for (const w of colW) {
    colX.push(x)
    x += w + gap
  }
  const rowY: number[] = []
  let y = 0
  for (const h of rowH) {
    rowY.push(y)
    y += h + gap
  }
  const out: PosMap = new Map()
  sorted.forEach((nd, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    const s = sizes.get(nd.id)!
    out.set(nd.id, { x: colX[c]! + (colW[c]! - s.w) / 2, y: rowY[r]! + (rowH[r]! - s.h) / 2 })
  })
  return out
}

// ── organic (Fruchterman–Reingold) ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function organicLayout(ids: string[], sizes: Map<string, Sz>, edges: [string, string][], nodeGap: number): PosMap {
  const n = ids.length
  const out: PosMap = new Map()
  if (n === 1) {
    out.set(ids[0]!, { x: 0, y: 0 })
    return out
  }
  const idx = new Map(ids.map((id, i) => [id, i]))
  const rad = ids.map((id) => {
    const s = sizes.get(id)!
    return Math.sqrt(s.w * s.w + s.h * s.h) / 2
  })
  const avgR = rad.reduce((a, b) => a + b, 0) / n
  const k = Math.max(nodeGap, 30) * 1.5 // ideal clearance between linked shapes
  const rand = mulberry32(hashStr(ids.join('|')) ^ n)
  const side = Math.sqrt(n) * (2 * avgR + k)
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    px[i] = (rand() - 0.5) * side
    py[i] = (rand() - 0.5) * side
  }
  const E = edges.map(([s, t]) => [idx.get(s)!, idx.get(t)!] as const)
  const iterations = n <= 400 ? 300 : 120
  let temp = side / 4
  const cool = temp / (iterations + 1)
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  for (let it = 0; it < iterations; it++) {
    dx.fill(0)
    dy.fill(0)
    // Repulsion on the gap between circumscribed circles (size-aware).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = px[i]! - px[j]!
        let ddy = py[i]! - py[j]!
        let dist = Math.sqrt(ddx * ddx + ddy * ddy)
        if (dist < 1e-6) {
          // Coincident: nudge apart along a deterministic direction.
          const a = ((i * 7919 + j * 104729) % 360) * (Math.PI / 180)
          ddx = Math.cos(a)
          ddy = Math.sin(a)
          dist = 1
        }
        const eff = Math.max(1, dist - rad[i]! - rad[j]!)
        const f = (k * k) / eff
        const ux = ddx / dist
        const uy = ddy / dist
        dx[i] += ux * f
        dy[i] += uy * f
        dx[j] -= ux * f
        dy[j] -= uy * f
      }
    }
    // Attraction along edges, also measured on the clearance.
    for (const [a, b] of E) {
      const ddx = px[a]! - px[b]!
      const ddy = py[a]! - py[b]!
      const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1
      const eff = Math.max(0, dist - rad[a]! - rad[b]!)
      const f = (eff * eff) / k
      const ux = ddx / dist
      const uy = ddy / dist
      dx[a] -= ux * f
      dy[a] -= uy * f
      dx[b] += ux * f
      dy[b] += uy * f
    }
    // Gentle gravity keeps disconnected pieces from drifting off.
    for (let i = 0; i < n; i++) {
      dx[i] -= px[i]! * 0.02 * (k / 10)
      dy[i] -= py[i]! * 0.02 * (k / 10)
    }
    for (let i = 0; i < n; i++) {
      const len = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!)
      if (len > 0) {
        const step = Math.min(len, temp)
        px[i] += (dx[i]! / len) * step
        py[i] += (dy[i]! / len) * step
      }
    }
    temp = Math.max(temp - cool, 0.5)
  }
  // Overlap removal: push intersecting boxes apart along the axis of least
  // penetration (a few relaxation rounds); the caller's resolver guarantees the
  // final result.
  const half = ids.map((id) => sizes.get(id)!)
  for (let round = 0; round < 50; round++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ox = (half[i]!.w + half[j]!.w) / 2 + nodeGap / 2 - Math.abs(px[i]! - px[j]!)
        const oy = (half[i]!.h + half[j]!.h) / 2 + nodeGap / 2 - Math.abs(py[i]! - py[j]!)
        if (ox > 0 && oy > 0) {
          moved = true
          if (ox < oy) {
            const s = (px[i]! < px[j]! || (px[i] === px[j] && i < j) ? -1 : 1) * (ox / 2)
            px[i] += s
            px[j] -= s
          } else {
            const s = (py[i]! < py[j]! || (py[i] === py[j] && i < j) ? -1 : 1) * (oy / 2)
            py[i] += s
            py[j] -= s
          }
        }
      }
    }
    if (!moved) break
  }
  ids.forEach((id, i) => {
    const s = sizes.get(id)!
    out.set(id, { x: px[i]! - s.w / 2, y: py[i]! - s.h / 2 })
  })
  return out
}

// ── mind map ────────────────────────────────────────────────────────────────

function mindmapLayout(
  ids: string[],
  sizes: Map<string, Sz>,
  edges: [string, string][],
  nodeGap: number,
  layerGap: number
): PosMap {
  const { roots, children } = spanningForest(ids, edges)
  const vGap = Math.max(8, nodeGap / 2)
  const hGap = Math.max(24, layerGap * 0.7)
  // Height of the band a subtree occupies (children stacked).
  const bandH = new Map<string, number>()
  const band = (v: string): number => {
    const cached = bandH.get(v)
    if (cached !== undefined) return cached
    // Iterative post-order to stay safe on deep chains.
    const stack: { v: string; done: boolean }[] = [{ v, done: false }]
    while (stack.length) {
      const top = stack.pop()!
      if (bandH.has(top.v)) continue
      const ch = children.get(top.v)!
      if (!top.done) {
        stack.push({ v: top.v, done: true })
        for (const c of ch) if (!bandH.has(c)) stack.push({ v: c, done: false })
        continue
      }
      const sum = ch.reduce((s, c) => s + bandH.get(c)!, 0) + Math.max(0, ch.length - 1) * vGap
      bandH.set(top.v, Math.max(sizes.get(top.v)!.h, sum))
    }
    return bandH.get(v)!
  }
  const out: PosMap = new Map()
  // Place a list of sibling subtrees stacked in [top, …], growing to one side.
  const placeStack = (list: string[], edgeX: number, top: number, side: 1 | -1): void => {
    // Explicit work stack of (node, edgeX, top).
    const work: { v: string; edgeX: number; top: number }[] = []
    let t = top
    for (const c of list) {
      work.push({ v: c, edgeX, top: t })
      t += band(c) + vGap
    }
    while (work.length) {
      const { v, edgeX: ex, top: tp } = work.pop()!
      const s = sizes.get(v)!
      const h = band(v)
      const x = side === 1 ? ex : ex - s.w
      out.set(v, { x, y: tp + (h - s.h) / 2 })
      const ch = children.get(v)!
      if (!ch.length) continue
      const chH = ch.reduce((acc, c) => acc + band(c), 0) + (ch.length - 1) * vGap
      let ct = tp + (h - chH) / 2
      const childEdge = side === 1 ? x + s.w + hGap : x - hGap
      for (const c of ch) {
        work.push({ v: c, edgeX: childEdge, top: ct })
        ct += band(c) + vGap
      }
    }
  }
  const blocks: PosMap[] = []
  for (const root of roots) {
    out.clear()
    const rs = sizes.get(root)!
    out.set(root, { x: -rs.w / 2, y: -rs.h / 2 })
    // Balance the children between right and left by band height, keeping order.
    const right: string[] = []
    const left: string[] = []
    let rh = 0
    let lh = 0
    for (const c of children.get(root)!) {
      const h = band(c)
      if (rh <= lh) {
        right.push(c)
        rh += h + vGap
      } else {
        left.push(c)
        lh += h + vGap
      }
    }
    const stackH = (list: string[]): number =>
      list.reduce((s, c) => s + band(c), 0) + Math.max(0, list.length - 1) * vGap
    placeStack(right, rs.w / 2 + hGap * 1.3, -stackH(right) / 2, 1)
    placeStack(left, -rs.w / 2 - hGap * 1.3, -stackH(left) / 2, -1)
    blocks.push(new Map(out))
  }
  return packBlocks(blocks, sizes, nodeGap * 2, 'y')
}
