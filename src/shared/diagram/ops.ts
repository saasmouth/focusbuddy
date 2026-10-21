// Editing operations for PlexiDiagrams, as pure functions over one page's graph.
// The editor wires these to menus, shortcuts and the inspector; keeping them
// here means every behaviour (z-order, grouping, paste remapping, containment)
// is unit-tested without a canvas.

import type { MapEdge, MapLayer, MapNode, MapNodeStyle } from '../types'
import { boundsOf, contains, nodeBox, type Box } from './geom'
import { getShape } from './shapes'

export interface Graph {
  nodes: MapNode[]
  edges: MapEdge[]
  layers?: MapLayer[]
}

export interface Sel {
  nodes: Set<string>
  edges: Set<string>
}

export const emptySel = (): Sel => ({ nodes: new Set(), edges: new Set() })

let counter = 0
export function uid(prefix: string): string {
  counter = (counter + 1) % 1_000_000
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

// ── selection helpers ───────────────────────────────────────────────────────

// Selecting one member of a group selects the whole group.
export function expandGroups(g: Graph, ids: Iterable<string>): Set<string> {
  const out = new Set(ids)
  const groups = new Set<string>()
  for (const n of g.nodes) if (out.has(n.id) && n.groupId) groups.add(n.groupId)
  if (groups.size) for (const n of g.nodes) if (n.groupId && groups.has(n.groupId)) out.add(n.id)
  return out
}

// Every descendant of the given containers (children of children too).
export function descendants(g: Graph, ids: Iterable<string>): Set<string> {
  const out = new Set<string>()
  const frontier = [...ids]
  while (frontier.length) {
    const id = frontier.pop()!
    for (const n of g.nodes) if (n.parentId === id && !out.has(n.id)) {
      out.add(n.id)
      frontier.push(n.id)
    }
  }
  return out
}

export function selectAll(g: Graph): Sel {
  const hidden = hiddenLayerIds(g)
  return {
    nodes: new Set(g.nodes.filter((n) => !n.hidden && !hidden.has(layerOf(n))).map((n) => n.id)),
    edges: new Set(g.edges.map((e) => e.id))
  }
}

// Shapes and lines without a layerId belong to the Base layer.
export const BASE_LAYER = 'layer-base'
export const layerOf = (x: { layerId?: string }): string => x.layerId ?? BASE_LAYER

export function hiddenLayerIds(g: Graph): Set<string> {
  return new Set((g.layers ?? []).filter((l) => !l.visible).map((l) => l.id))
}

export function lockedLayerIds(g: Graph): Set<string> {
  return new Set((g.layers ?? []).filter((l) => l.locked).map((l) => l.id))
}

// ── structural edits ────────────────────────────────────────────────────────

// Delete selected nodes (and their contained children) plus selected and
// orphaned edges. Locked items survive.
export function deleteSelection(g: Graph, sel: Sel): Graph {
  const lockedLayers = lockedLayerIds(g)
  const isLocked = (n: MapNode): boolean => !!n.locked || lockedLayers.has(layerOf(n))
  const doomed = new Set([...sel.nodes].filter((id) => {
    const n = g.nodes.find((x) => x.id === id)
    return n && !isLocked(n)
  }))
  for (const d of descendants(g, doomed)) {
    const n = g.nodes.find((x) => x.id === d)
    if (n && !isLocked(n)) doomed.add(d)
  }
  const nodes = g.nodes
    .filter((n) => !doomed.has(n.id))
    .map((n) => (n.parentId && doomed.has(n.parentId) ? { ...n, parentId: undefined } : n))
  const edges = g.edges.filter((e) => !(sel.edges.has(e.id) && !e.locked) && !doomed.has(e.source) && !doomed.has(e.target))
  return { ...g, nodes: nodes.map(stripUndef), edges }
}

function stripUndef<T extends object>(o: T): T {
  const r = o as Record<string, unknown>
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]
  return o
}

export interface Clip {
  marker: 'plexii-diagram/v1'
  nodes: MapNode[]
  edges: MapEdge[]
}

// What a copy puts on the clipboard: selected nodes (with their contained
// children) and every edge whose both ends are inside.
export function copySelection(g: Graph, sel: Sel): Clip {
  const ids = new Set(sel.nodes)
  for (const d of descendants(g, ids)) ids.add(d)
  return {
    marker: 'plexii-diagram/v1',
    nodes: g.nodes.filter((n) => ids.has(n.id)),
    edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  }
}

export function isClip(v: unknown): v is Clip {
  return !!v && typeof v === 'object' && (v as Clip).marker === 'plexii-diagram/v1' && Array.isArray((v as Clip).nodes)
}

// Paste with fresh ids, remapped edges, parents and groups, offset in place.
export function pasteClip(g: Graph, clip: Clip, offset: { x: number; y: number }): { graph: Graph; sel: Sel } {
  const idMap = new Map<string, string>()
  for (const n of clip.nodes) idMap.set(n.id, uid('n'))
  const groupMap = new Map<string, string>()
  const nodes = clip.nodes.map((n) => {
    const out: MapNode = { ...n, id: idMap.get(n.id)!, x: Math.round(n.x + offset.x), y: Math.round(n.y + offset.y), locked: undefined }
    if (n.parentId) out.parentId = idMap.get(n.parentId)
    if (n.groupId) {
      if (!groupMap.has(n.groupId)) groupMap.set(n.groupId, uid('g'))
      out.groupId = groupMap.get(n.groupId)
    }
    return stripUndef(out)
  })
  const edges = clip.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      ...e,
      id: uid('e'),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      ...(e.waypoints ? { waypoints: e.waypoints.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })) } : {})
    }))
  return {
    graph: { ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] },
    sel: { nodes: new Set(nodes.map((n) => n.id)), edges: new Set(edges.map((e) => e.id)) }
  }
}

export function duplicate(g: Graph, sel: Sel, offset = 20): { graph: Graph; sel: Sel } {
  return pasteClip(g, copySelection(g, sel), { x: offset, y: offset })
}

// ── arrange ─────────────────────────────────────────────────────────────────

// Array order is z-order (first = back). Moves keep the relative order of the
// moved items.
export function reorder(g: Graph, ids: Set<string>, how: 'front' | 'back' | 'forward' | 'backward'): Graph {
  const nodes = [...g.nodes]
  if (how === 'front') return { ...g, nodes: [...nodes.filter((n) => !ids.has(n.id)), ...nodes.filter((n) => ids.has(n.id))] }
  if (how === 'back') return { ...g, nodes: [...nodes.filter((n) => ids.has(n.id)), ...nodes.filter((n) => !ids.has(n.id))] }
  if (how === 'forward') {
    for (let i = nodes.length - 2; i >= 0; i--) {
      if (ids.has(nodes[i]!.id) && !ids.has(nodes[i + 1]!.id)) [nodes[i], nodes[i + 1]] = [nodes[i + 1]!, nodes[i]!]
    }
  } else {
    for (let i = 1; i < nodes.length; i++) {
      if (ids.has(nodes[i]!.id) && !ids.has(nodes[i - 1]!.id)) [nodes[i], nodes[i - 1]] = [nodes[i - 1]!, nodes[i]!]
    }
  }
  return { ...g, nodes }
}

export function group(g: Graph, ids: Set<string>): { graph: Graph; groupId: string | null } {
  if (ids.size < 2) return { graph: g, groupId: null }
  const gid = uid('g')
  return { graph: { ...g, nodes: g.nodes.map((n) => (ids.has(n.id) ? { ...n, groupId: gid } : n)) }, groupId: gid }
}

export function ungroup(g: Graph, ids: Set<string>): Graph {
  const groups = new Set(g.nodes.filter((n) => ids.has(n.id) && n.groupId).map((n) => n.groupId!))
  return { ...g, nodes: g.nodes.map((n) => (n.groupId && groups.has(n.groupId) ? stripUndef({ ...n, groupId: undefined }) : n)) }
}

export function setLocked(g: Graph, sel: Sel, locked: boolean): Graph {
  return {
    ...g,
    nodes: g.nodes.map((n) => (sel.nodes.has(n.id) ? stripUndef({ ...n, locked: locked || undefined }) : n)),
    edges: g.edges.map((e) => (sel.edges.has(e.id) ? stripUndef({ ...e, locked: locked || undefined }) : e))
  }
}

export function patchNodes(g: Graph, ids: Set<string>, patch: (n: MapNode) => Partial<MapNode>): Graph {
  return { ...g, nodes: g.nodes.map((n) => (ids.has(n.id) ? stripUndef({ ...n, ...patch(n) }) : n)) }
}

export function patchEdges(g: Graph, ids: Set<string>, patch: (e: MapEdge) => Partial<MapEdge>): Graph {
  return { ...g, edges: g.edges.map((e) => (ids.has(e.id) ? stripUndef({ ...e, ...patch(e) }) : e)) }
}

export function patchStyle(g: Graph, ids: Set<string>, style: Partial<MapNodeStyle>): Graph {
  return patchNodes(g, ids, (n) => {
    const merged: MapNodeStyle = { ...(n.style ?? {}), ...style }
    for (const k of Object.keys(merged) as (keyof MapNodeStyle)[]) if (merged[k] === undefined) delete merged[k]
    return { style: Object.keys(merged).length ? merged : undefined }
  })
}

// Move unlocked nodes by a delta (arrow-key nudge), carrying contained children.
export function nudge(g: Graph, ids: Set<string>, dx: number, dy: number): Graph {
  const moving = new Set(ids)
  for (const d of descendants(g, ids)) moving.add(d)
  const lockedLayers = lockedLayerIds(g)
  return {
    ...g,
    nodes: g.nodes.map((n) => (moving.has(n.id) && !n.locked && !lockedLayers.has(layerOf(n)) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
    edges: g.edges.map((e) =>
      e.waypoints && moving.has(e.source) && moving.has(e.target) ? { ...e, waypoints: e.waypoints.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : e
    )
  }
}

export function flip(g: Graph, ids: Set<string>, axis: 'x' | 'y'): Graph {
  return patchNodes(g, ids, (n) => (axis === 'x' ? { flipX: n.flipX ? undefined : true } : { flipY: n.flipY ? undefined : true }))
}

export function rotateBy(g: Graph, ids: Set<string>, deg: number): Graph {
  return patchNodes(g, ids, (n) => {
    const r = ((((n.rotation ?? 0) + deg) % 360) + 360) % 360
    return { rotation: r || undefined }
  })
}

// Make every selected node the size of the first selected (or a given box).
export function matchSize(g: Graph, ids: string[], which: 'width' | 'height' | 'both'): Graph {
  const first = g.nodes.find((n) => n.id === ids[0])
  if (!first) return g
  const b = nodeBox(first)
  const set = new Set(ids.slice(1))
  return patchNodes(g, set, () => ({ ...(which !== 'height' ? { width: b.w } : {}), ...(which !== 'width' ? { height: b.h } : {}) }))
}

// ── containers ──────────────────────────────────────────────────────────────

// After a move, (re)assign parentId: a node belongs to the smallest container
// that fully contains it; dropping it outside clears membership.
export function assignContainers(g: Graph, movedIds: Iterable<string>): Graph {
  const containers = g.nodes.filter((n) => getShape(n.shape).container && !n.hidden)
  if (!containers.length) {
    let changed = false
    const nodes = g.nodes.map((n) => {
      if (n.parentId) {
        changed = true
        return stripUndef({ ...n, parentId: undefined })
      }
      return n
    })
    return changed ? { ...g, nodes } : g
  }
  const moved = new Set(movedIds)
  const boxes = new Map(g.nodes.map((n) => [n.id, nodeBox(n)]))
  let changed = false
  const nodes = g.nodes.map((n) => {
    if (!moved.has(n.id)) return n
    const nb = boxes.get(n.id)!
    let best: { id: string; area: number } | null = null
    for (const c of containers) {
      if (c.id === n.id || isAncestor(g, n.id, c.id)) continue
      const cb = boxes.get(c.id)!
      if (contains(cb, nb)) {
        const area = cb.w * cb.h
        if (!best || area < best.area) best = { id: c.id, area }
      }
    }
    const parentId = best?.id
    if (parentId === n.parentId) return n
    changed = true
    return stripUndef({ ...n, parentId })
  })
  return changed ? { ...g, nodes } : g
}

// Is `maybeAncestor` above `id` in the containment chain? (prevents cycles)
function isAncestor(g: Graph, maybeDescendant: string, maybeAncestor: string): boolean {
  let cur = g.nodes.find((n) => n.id === maybeAncestor)
  const seen = new Set<string>()
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.parentId === maybeDescendant) return true
    cur = g.nodes.find((n) => n.id === cur!.parentId)
  }
  return false
}

export function selectionBounds(g: Graph, ids: Set<string>): ReturnType<typeof boundsOf> {
  return boundsOf(g.nodes.filter((n) => ids.has(n.id)).map(nodeBox))
}

// Shift a batch of new shapes (laid out from 0,0) into clear space below what
// is already on the page, left-aligned with it, so inserts never land on top.
export function placeBelow(existing: MapNode[], batch: MapNode[], gap = 60): MapNode[] {
  if (!existing.length || !batch.length) return batch
  const have = boundsOf(existing.map(nodeBox))
  const mine = boundsOf(batch.map(nodeBox))
  const dx = have.x - mine.x
  const dy = have.y + have.h + gap - mine.y
  return batch.map((n) => ({ ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) }))
}

// Place a new shape next to `from` in a direction without landing on another.
export function slotBeside(g: Graph, from: MapNode, dir: 'up' | 'right' | 'down' | 'left', size: { w: number; h: number }, gap = 70): { x: number; y: number } {
  const b = nodeBox(from)
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  let x = dir === 'right' ? b.x + b.w + gap : dir === 'left' ? b.x - gap - size.w : cx - size.w / 2
  let y = dir === 'down' ? b.y + b.h + gap : dir === 'up' ? b.y - gap - size.h : cy - size.h / 2
  const others: Box[] = g.nodes.filter((n) => n.id !== from.id && !getShape(n.shape).container).map(nodeBox)
  for (let i = 0; i < 20; i++) {
    const probe: Box = { id: '_', x, y, w: size.w, h: size.h }
    const hit = others.find((o) => o.x < probe.x + probe.w + 10 && o.x + o.w + 10 > probe.x && o.y < probe.y + probe.h + 10 && o.y + o.h + 10 > probe.y)
    if (!hit) break
    // Slide sideways along the row/column until free.
    if (dir === 'right' || dir === 'left') y = hit.y + hit.h + 30
    else x = hit.x + hit.w + 30
  }
  return { x: Math.round(x), y: Math.round(y) }
}
