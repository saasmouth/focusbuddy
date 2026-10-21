// Automated connection tidying for PlexiDiagrams. One pass that makes a messy
// diagram read cleanly without re-laying it out:
//
//   1. resolveOverlaps — push overlapping shapes apart by the smallest move
//   2. alignNodes      — snap nearly-straight connectors perfectly straight
//   3. ports           — every connector leaves / enters on the facing sides,
//                        and several connectors on one side are spread across
//                        it in an order that does not cross
//   4. waypoints       — stale bend points cleared, routing defaulted
//
// Locked shapes never move; locked connectors are left exactly as they are.
// Pure: inputs are never mutated; the counts reported are what actually changed.

import type { MapEdge, MapNode } from '../types'
import { type Pt, type Side, nodeSize, portId } from './geom'
import { routeAll, segmentCrossing } from './routing'
import { getShape } from './shapes'

export interface TidyOptions {
  straightenThreshold?: number // px; centres closer than this get aligned (default 12)
  spreadPorts?: boolean // spread several connectors across one side (default true)
  clearWaypoints?: boolean // drop user bend points (default true)
  alignNodes?: boolean // straighten nearly-straight connectors (default true)
  resolveOverlaps?: boolean // push overlapping shapes apart (default true)
  gridSize?: number // snap pushed shapes to this grid
}

export interface TidyResult {
  nodes: MapNode[]
  edges: MapEdge[]
  changes: { edgesRerouted: number; portsReassigned: number; nodesNudged: number; overlapsResolved: number }
}

interface B {
  x: number
  y: number
  w: number
  h: number
}

const isContainer = (n: MapNode): boolean => !!getShape(n.shape).container

function boxOf(n: MapNode): B {
  const { w, h } = nodeSize(n)
  return { x: n.x, y: n.y, w, h }
}

const centreOf = (b: B): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

const overlaps = (a: B, b: B): boolean => a.x < b.x + b.w - 1e-6 && a.x + a.w > b.x + 1e-6 && a.y < b.y + b.h - 1e-6 && a.y + a.h > b.y + 1e-6

export function tidyConnections(nodes: MapNode[], edges: MapEdge[], opts?: TidyOptions): TidyResult {
  const threshold = Math.max(0, opts?.straightenThreshold ?? 12)
  const spread = opts?.spreadPorts ?? true
  const clearWaypoints = opts?.clearWaypoints ?? true
  const alignNodes = opts?.alignNodes ?? true
  const resolveOverlaps = opts?.resolveOverlaps ?? true
  const grid = typeof opts?.gridSize === 'number' && opts.gridSize > 0 ? opts.gridSize : 0
  const gap = grid || 16

  const outNodes: MapNode[] = nodes.map((n) => ({ ...n }))
  const outEdges: MapEdge[] = edges.map((e) => (e.waypoints ? { ...e, waypoints: e.waypoints.map((p) => ({ ...p })) } : { ...e }))
  const byId = new Map<string, MapNode>()
  for (const n of outNodes) byId.set(n.id, n)

  const degree = new Map<string, number>()
  for (const e of outEdges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    if (e.target !== e.source) degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  const deg = (id: string): number => degree.get(id) ?? 0

  // Shapes that take part in nudging: visible, not containers.
  const solid = outNodes.filter((n) => !n.hidden && !isContainer(n))
  const related = (a: MapNode, b: MapNode): boolean =>
    (!!a.groupId && a.groupId === b.groupId) || a.parentId === b.id || b.parentId === a.id

  // ── 1. overlaps ──
  const initialOverlaps: [MapNode, MapNode][] = []
  for (let i = 0; i < solid.length; i++)
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i]!
      const b = solid[j]!
      if (!related(a, b) && overlaps(boxOf(a), boxOf(b))) initialOverlaps.push([a, b])
    }

  if (resolveOverlaps && initialOverlaps.length) {
    const snapDown = (v: number): number => (grid ? Math.floor(v / grid + 1e-9) * grid : v)
    const snapUp = (v: number): number => (grid ? Math.ceil(v / grid - 1e-9) * grid : v)
    for (let pass = 0; pass < 60; pass++) {
      let moved = false
      for (let i = 0; i < solid.length; i++)
        for (let j = i + 1; j < solid.length; j++) {
          const a = solid[i]!
          const b = solid[j]!
          if (related(a, b)) continue
          const ba = boxOf(a)
          const bb = boxOf(b)
          if (!overlaps(ba, bb)) continue
          let mover: MapNode
          let fixed: MapNode
          if (a.locked && b.locked) continue
          if (a.locked) [mover, fixed] = [b, a]
          else if (b.locked) [mover, fixed] = [a, b]
          else if (deg(a.id) < deg(b.id)) [mover, fixed] = [a, b]
          else [mover, fixed] = [b, a]
          const m = boxOf(mover)
          const f = boxOf(fixed)
          // Candidate positions on each side of the fixed shape; take the nearest.
          const options = [
            { x: snapUp(f.x + f.w + gap), y: m.y },
            { x: snapDown(f.x - gap - m.w), y: m.y },
            { x: m.x, y: snapUp(f.y + f.h + gap) },
            { x: m.x, y: snapDown(f.y - gap - m.h) }
          ]
          options.sort((p, q) => Math.hypot(p.x - m.x, p.y - m.y) - Math.hypot(q.x - m.x, q.y - m.y))
          const pick = options[0]!
          mover.x = pick.x
          mover.y = pick.y
          moved = true
        }
      if (!moved) break
    }
  }

  // ── 2. straighten nearly-aligned connectors ──
  if (alignNodes && threshold > 0) {
    const pinnedX = new Set<string>()
    const pinnedY = new Set<string>()
    const solidIds = new Set(solid.map((n) => n.id))
    const collides = (n: MapNode): boolean => {
      const b = boxOf(n)
      return solid.some((o) => o.id !== n.id && !related(o, n) && overlaps(b, boxOf(o)))
    }
    for (const e of outEdges) {
      if (e.source === e.target) continue
      const a = byId.get(e.source)
      const b = byId.get(e.target)
      if (!a || !b || !solidIds.has(a.id) || !solidIds.has(b.id)) continue
      const ca = centreOf(boxOf(a))
      const cb = centreOf(boxOf(b))
      const dx = cb.x - ca.x
      const dy = cb.y - ca.y
      let axis: 'x' | 'y' | null = null
      if (Math.abs(dx) > 1e-6 && Math.abs(dx) <= threshold && Math.abs(dy) > Math.abs(dx)) axis = 'x'
      else if (Math.abs(dy) > 1e-6 && Math.abs(dy) <= threshold && Math.abs(dx) > Math.abs(dy)) axis = 'y'
      if (!axis) continue
      const pinned = axis === 'x' ? pinnedX : pinnedY
      // Fewer connections moves first; ties move the target.
      const order = deg(a.id) < deg(b.id) ? [a, b] : [b, a]
      for (const mover of order) {
        if (mover.locked || pinned.has(mover.id)) continue
        const other = mover === a ? b : a
        const delta = axis === 'x' ? centreOf(boxOf(other)).x - centreOf(boxOf(mover)).x : centreOf(boxOf(other)).y - centreOf(boxOf(mover)).y
        const before = { x: mover.x, y: mover.y }
        const wasColliding = collides(mover)
        if (axis === 'x') mover.x += delta
        else mover.y += delta
        if (!wasColliding && collides(mover)) {
          mover.x = before.x
          mover.y = before.y
          continue
        }
        pinned.add(mover.id)
        pinned.add(other.id)
        break
      }
    }
  }

  // ── 3. facing sides, spread along each side ──
  interface Usage {
    edge: MapEdge
    end: 'source' | 'target'
    other: Pt
  }
  const usage = new Map<string, Usage[]>()
  const sidesOf = new Map<string, { s: Side; t: Side }>()
  for (const e of outEdges) {
    if (e.locked || e.source === e.target) continue
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b || a.hidden || b.hidden) continue
    const ba = boxOf(a)
    const bb = boxOf(b)
    const ca = centreOf(ba)
    const cb = centreOf(bb)
    const gapX = Math.max(bb.x - (ba.x + ba.w), ba.x - (bb.x + bb.w))
    const gapY = Math.max(bb.y - (ba.y + ba.h), ba.y - (bb.y + bb.h))
    let s: Side
    let t: Side
    if (gapX >= gapY) {
      s = cb.x >= ca.x ? 'right' : 'left'
      t = s === 'right' ? 'left' : 'right'
    } else {
      s = cb.y >= ca.y ? 'bottom' : 'top'
      t = s === 'bottom' ? 'top' : 'bottom'
    }
    sidesOf.set(e.id, { s, t })
    const add = (key: string, u: Usage): void => {
      const l = usage.get(key)
      if (l) l.push(u)
      else usage.set(key, [u])
    }
    add(`${a.id}\u0000${s}`, { edge: e, end: 'source', other: cb })
    add(`${b.id}\u0000${t}`, { edge: e, end: 'target', other: ca })
  }
  const newHandle = new Map<string, { source?: string; target?: string }>()
  for (const [key, list] of usage) {
    const side = key.split('\u0000')[1] as Side
    const vertical = side === 'left' || side === 'right'
    const sorted = [...list].sort((p, q) => {
      const pa = vertical ? p.other.y : p.other.x
      const qa = vertical ? q.other.y : q.other.x
      if (Math.abs(pa - qa) > 1e-6) return pa - qa
      const pb = vertical ? p.other.x : p.other.y
      const qb = vertical ? q.other.x : q.other.y
      if (Math.abs(pb - qb) > 1e-6) return pb - qb
      return p.edge.id < q.edge.id ? -1 : p.edge.id > q.edge.id ? 1 : 0
    })
    const n = sorted.length
    sorted.forEach((u, k) => {
      const f = spread && n > 1 ? (k + 1) / (n + 1) : 0.5
      const id =
        side === 'right' ? portId(1, f) : side === 'left' ? portId(0, f) : side === 'top' ? portId(f, 0) : portId(f, 1)
      const h = newHandle.get(u.edge.id) ?? {}
      h[u.end] = id
      newHandle.set(u.edge.id, h)
    })
  }

  // ── 4. apply to connectors ──
  let edgesRerouted = 0
  let portsReassigned = 0
  for (const e of outEdges) {
    if (e.locked) continue
    let changed = false
    const h = newHandle.get(e.id)
    if (h?.source !== undefined && (e.sourceHandle ?? null) !== h.source) {
      e.sourceHandle = h.source
      portsReassigned++
      changed = true
    }
    if (h?.target !== undefined && (e.targetHandle ?? null) !== h.target) {
      e.targetHandle = h.target
      portsReassigned++
      changed = true
    }
    if (clearWaypoints && e.waypoints) {
      if (e.waypoints.length) changed = true
      delete e.waypoints
    }
    if (!e.routing) {
      e.routing = 'orthogonal'
      changed = true
    }
    if (changed) edgesRerouted++
  }

  // ── honest counts ──
  let nodesNudged = 0
  nodes.forEach((n, i) => {
    const o = outNodes[i]!
    if (o.x !== n.x || o.y !== n.y) nodesNudged++
  })
  const finalBox = (n: MapNode): B => boxOf(byId.get(n.id)!)
  const overlapsResolved = initialOverlaps.filter(([a, b]) => !overlaps(finalBox(a), finalBox(b))).length

  return { nodes: outNodes, edges: outEdges, changes: { edgesRerouted, portsReassigned, nodesNudged, overlapsResolved } }
}

// Number of proper crossings between the routed polylines of different edges.
export function edgeCrossings(nodes: MapNode[], edges: MapEdge[]): number {
  const routes = [...routeAll(nodes, edges).values()].map((r) => r.points)
  let count = 0
  for (let i = 0; i < routes.length; i++)
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]!
      const b = routes[j]!
      for (let p = 1; p < a.length; p++) for (let q = 1; q < b.length; q++) if (segmentCrossing(a[p - 1]!, a[p]!, b[q - 1]!, b[q]!)) count++
    }
  return count
}
