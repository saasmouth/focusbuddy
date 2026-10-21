// Groups on a v2 document: Group and Ungroup, the group-space maths every
// selection inside a group needs, Arrange within any container, and Lock /
// Hide, with Illustrator's semantics throughout.
//
// A node's coordinates are in its CONTAINER's space: a layer's nodes are in
// artboard space; a group's members are in the group's space, which its own
// `transform` (when it has one) maps into its container's. The product of the
// transforms of every group above a node is its "parent matrix". Moving,
// scaling or rotating a node that sits inside a transformed group goes through
// that matrix, so a drag moves it the way the pointer went on screen.
//
// Pure functions; unchanged branches keep their identity. Ids are preserved by
// Group and Ungroup, so group -> ungroup -> group gives back the same members.

import { drawId } from '../../draw'
import { applyMatrix, multiplyMatrix, transformPath, unionBox, type Box, type Matrix } from '../../drawGeometry'
import type { DrawDoc, DrawDocVectorLayer, DrawGroupNode, DrawNode } from '../model'
import { mapNodesDeep, vectorLayersOf } from '../tree'
import { clipShapeOf, isMeasurable, nodeBounds, nodePivot, rotateNode, scaleNode, translateNode } from './geometry'

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const EPS = 1e-9

// ── Matrices ─────────────────────────────────────────────────────────────────

export function isIdentityMatrix(m: Matrix): boolean {
  return Math.abs(m[0] - 1) < EPS && Math.abs(m[1]) < EPS && Math.abs(m[2]) < EPS && Math.abs(m[3] - 1) < EPS && Math.abs(m[4]) < EPS && Math.abs(m[5]) < EPS
}

export function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

/** The axis-aligned box around `b` mapped through `m`. */
export function transformBox(b: Box, m: Matrix): Box {
  const pts = [
    applyMatrix(m, { x: b.x, y: b.y }),
    applyMatrix(m, { x: b.x + b.w, y: b.y }),
    applyMatrix(m, { x: b.x + b.w, y: b.y + b.h }),
    applyMatrix(m, { x: b.x, y: b.y + b.h })
  ]
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

// ── Where a node sits ────────────────────────────────────────────────────────

/** A container of nodes: a vector layer (groupId null) or a group. */
export interface Container {
  layerId: string
  groupId: string | null
}

export interface NodePlace {
  node: DrawNode
  layerId: string
  /** The groups above the node, outermost first. */
  parents: DrawGroupNode[]
  /** Index within its container's list (0 = bottom). */
  index: number
  /** Position in the whole document's paint order (0 = painted first). */
  order: number
}

/** Every node with where it sits, in paint order (bottom layer first, depth first). */
export function allPlaces(doc: DrawDoc): NodePlace[] {
  const out: NodePlace[] = []
  const visit = (nodes: DrawNode[], layerId: string, parents: DrawGroupNode[]): void => {
    nodes.forEach((node, index) => {
      out.push({ node, layerId, parents, index, order: out.length })
      if (node.type === 'group') visit(node.children, layerId, [...parents, node])
    })
  }
  for (const l of vectorLayersOf(doc)) visit(l.objects, l.id, [])
  return out
}

export function placeOf(doc: DrawDoc, id: string): NodePlace | undefined {
  return allPlaces(doc).find((p) => p.node.id === id)
}

export function containerOf(place: NodePlace): Container {
  const g = place.parents[place.parents.length - 1]
  return { layerId: place.layerId, groupId: g ? g.id : null }
}

function sameContainer(a: Container, b: Container): boolean {
  return a.layerId === b.layerId && a.groupId === b.groupId
}

/** The nodes of a container, or undefined when it no longer exists. */
export function childrenOf(doc: DrawDoc, c: Container): DrawNode[] | undefined {
  const layer = vectorLayersOf(doc).find((l) => l.id === c.layerId)
  if (!layer) return undefined
  if (c.groupId === null) return layer.objects
  const p = allPlaces(doc).find((x) => x.node.id === c.groupId && x.layerId === c.layerId)
  return p && p.node.type === 'group' ? p.node.children : undefined
}

/** The document with one container's list replaced. */
export function withChildren(doc: DrawDoc, c: Container, fn: (children: DrawNode[]) => DrawNode[]): DrawDoc {
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector' || l.id !== c.layerId) return l
      if (c.groupId === null) {
        const objects = fn(l.objects)
        return objects === l.objects ? l : { ...l, objects }
      }
      let done = false
      const objects = mapNodesDeep(l.objects, (n) => {
        if (done || n.id !== c.groupId || n.type !== 'group') return n
        done = true
        const children = fn(n.children)
        return children === n.children ? n : { ...n, children }
      })
      return objects === l.objects ? l : ({ ...l, objects } as DrawDocVectorLayer)
    })
  }
}

/** Matrix from a node's own coordinates to the artboard: the transforms of every group above it. */
export function parentMatrix(parents: DrawGroupNode[]): Matrix {
  let m = IDENTITY
  for (const g of parents) if (g.transform) m = multiplyMatrix(m, g.transform)
  return m
}

export function parentMatrixOf(doc: DrawDoc, id: string): Matrix {
  const p = placeOf(doc, id)
  return p ? parentMatrix(p.parents) : IDENTITY
}

/** The space a group's MEMBERS live in, mapped to the artboard. */
export function innerMatrixOf(doc: DrawDoc, groupId: string): Matrix {
  const p = placeOf(doc, groupId)
  if (!p || p.node.type !== 'group') return IDENTITY
  const outer = parentMatrix(p.parents)
  return p.node.transform ? multiplyMatrix(outer, p.node.transform) : outer
}

/**
 * Drop every id whose ancestor is also in the list, keeping paint order. A
 * selected group already carries its members; acting on both would move a
 * member twice.
 */
export function outermostIds(doc: DrawDoc, ids: string[]): string[] {
  const wanted = new Set(ids)
  return allPlaces(doc)
    .filter((p) => wanted.has(p.node.id) && !p.parents.some((g) => wanted.has(g.id)))
    .map((p) => p.node.id)
}

/** The box a node visibly occupies on the ARTBOARD, wherever in the tree it is. */
export function worldBounds(doc: DrawDoc, id: string): Box | null {
  const p = placeOf(doc, id)
  if (!p || !isMeasurable(p.node)) return null
  const m = parentMatrix(p.parents)
  const b = nodeBounds(p.node)
  return isIdentityMatrix(m) ? b : transformBox(b, m)
}

/** The artboard box around several nodes at any depth, or null when none can be measured. */
export function nodesWorldBounds(doc: DrawDoc, ids: string[]): Box | null {
  const wanted = new Set(ids)
  const boxes: Box[] = []
  let any = false
  for (const p of allPlaces(doc)) {
    if (!wanted.has(p.node.id)) continue
    any = true
    if (!isMeasurable(p.node)) continue
    const m = parentMatrix(p.parents)
    const b = nodeBounds(p.node)
    boxes.push(isIdentityMatrix(m) ? b : transformBox(b, m))
  }
  return any ? unionBox(boxes) : null
}

// ── Transforming a node by a matrix ──────────────────────────────────────────

function isPureRotation(m: Matrix): boolean {
  return Math.abs(m[0] - m[3]) < 1e-9 && Math.abs(m[1] + m[2]) < 1e-9 && Math.abs(m[0] * m[0] + m[1] * m[1] - 1) < 1e-9
}

/**
 * The node with `m` (given in its container's space) applied. Paths are
 * re-baked. An axis-aligned scale goes through scaleNode, so a frame resizes
 * and type scales its point size exactly as the selection handles do. A pure
 * rotation turns a frame about its pivot and moves the pivot, so text stays
 * text you can click into. Anything else (shear, reflection, non-uniform
 * scale after a turn) becomes the frame's or group's own matrix.
 */
export function applyNodeMatrix(n: DrawNode, m: Matrix): DrawNode {
  if (n.type === 'opaque' || isIdentityMatrix(m)) return n
  if (Math.abs(m[1]) < EPS && Math.abs(m[2]) < EPS) {
    if (Math.abs(m[0] - 1) < EPS && Math.abs(m[3] - 1) < EPS) return translateNode(n, m[4], m[5])
    if (m[0] > 0 && m[3] > 0) return scaleNode(n, m[0], m[3], m[4], m[5])
  }
  if (n.type === 'path') return { ...n, path: transformPath(n.path, m) }
  if (n.type === 'group') return { ...n, transform: multiplyMatrix(m, n.transform ?? IDENTITY) }
  if (!n.transform && isPureRotation(m)) {
    const deg = (Math.atan2(m[1], m[0]) * 180) / Math.PI
    const pivot = nodePivot(n)
    const to = applyMatrix(m, pivot)
    return { ...n, rotation: (n.rotation ?? 0) + deg, x: n.x + (to.x - pivot.x), y: n.y + (to.y - pivot.y) }
  }
  return { ...n, transform: multiplyMatrix(m, n.transform ?? IDENTITY) }
}

/** Re-express a node that moves from one container space to another, so it stays where it is on screen. */
function reparent(n: DrawNode, from: Matrix, to: Matrix): DrawNode {
  if (isIdentityMatrix(from) && isIdentityMatrix(to)) return n
  const inv = invertMatrix(to)
  if (!inv) return n
  return applyNodeMatrix(n, multiplyMatrix(inv, from))
}

/** Change the nodes in `fns` (by id) anywhere in the tree. */
function mapById(doc: DrawDoc, fns: Map<string, (n: DrawNode) => DrawNode>): DrawDoc {
  if (fns.size === 0) return doc
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector') return l
      const objects = mapNodesDeep(l.objects, (n) => fns.get(n.id)?.(n) ?? n)
      return objects === l.objects ? l : { ...l, objects }
    })
  }
}

/** Move nodes by (dx, dy) on the ARTBOARD, wherever they sit in the tree. */
export function moveNodesWorld(doc: DrawDoc, ids: string[], dx: number, dy: number): DrawDoc {
  const fns = new Map<string, (n: DrawNode) => DrawNode>()
  const wanted = new Set(outermostIds(doc, ids))
  for (const p of allPlaces(doc)) {
    if (!wanted.has(p.node.id)) continue
    const m = parentMatrix(p.parents)
    if (isIdentityMatrix(m)) {
      fns.set(p.node.id, (n) => translateNode(n, dx, dy))
      continue
    }
    const inv = invertMatrix([m[0], m[1], m[2], m[3], 0, 0])
    const d = inv ? applyMatrix(inv, { x: dx, y: dy }) : { x: dx, y: dy }
    fns.set(p.node.id, (n) => translateNode(n, d.x, d.y))
  }
  return mapById(doc, fns)
}

/** Scale nodes so the artboard box `from` becomes `to`, wherever they sit in the tree. */
export function scaleNodesWorld(doc: DrawDoc, ids: string[], from: Box, to: Box): DrawDoc {
  const sx = from.w > 1e-6 ? to.w / from.w : 1
  const sy = from.h > 1e-6 ? to.h / from.h : 1
  const e = to.x - from.x * sx
  const f = to.y - from.y * sy
  const s: Matrix = [sx, 0, 0, sy, e, f]
  const fns = new Map<string, (n: DrawNode) => DrawNode>()
  const wanted = new Set(outermostIds(doc, ids))
  for (const p of allPlaces(doc)) {
    if (!wanted.has(p.node.id)) continue
    const m = parentMatrix(p.parents)
    const inv = invertMatrix(m)
    if (isIdentityMatrix(m) || !inv) {
      fns.set(p.node.id, (n) => scaleNode(n, sx, sy, e, f))
      continue
    }
    const local = multiplyMatrix(inv, multiplyMatrix(s, m))
    fns.set(p.node.id, (n) => applyNodeMatrix(n, local))
  }
  return mapById(doc, fns)
}

/** Turn nodes by the artboard-space rotation `m` (`degrees` about its centre), wherever they sit. */
export function rotateNodesWorld(doc: DrawDoc, ids: string[], m: Matrix, degrees: number): DrawDoc {
  const fns = new Map<string, (n: DrawNode) => DrawNode>()
  const wanted = new Set(outermostIds(doc, ids))
  for (const p of allPlaces(doc)) {
    if (!wanted.has(p.node.id)) continue
    const pm = parentMatrix(p.parents)
    const inv = invertMatrix(pm)
    if (isIdentityMatrix(pm) || !inv) {
      fns.set(p.node.id, (n) => rotateNode(n, m, degrees))
      continue
    }
    const local = multiplyMatrix(inv, multiplyMatrix(m, pm))
    // Inside a reflected group a turn runs the other way.
    const det = pm[0] * pm[3] - pm[1] * pm[2]
    fns.set(p.node.id, (n) => rotateNode(n, local, det < 0 ? -degrees : degrees))
  }
  return mapById(doc, fns)
}

// ── Group and Ungroup ────────────────────────────────────────────────────────

/** The ids a Group / Make Clipping Mask may act on: editable, not opaque, outermost, in paint order. */
export function pickForGrouping(doc: DrawDoc, ids: string[], editable: (doc: DrawDoc, ids: string[]) => string[]): NodePlace[] {
  const ok = new Set(outermostIds(doc, editable(doc, ids)))
  return allPlaces(doc).filter((p) => ok.has(p.node.id) && p.node.type !== 'opaque')
}

/** Is this place the clip path of the clipping group it is in? */
export function isClipPathPlace(p: NodePlace): boolean {
  const g = p.parents[p.parents.length - 1]
  return !!g && clipShapeOf(g)?.id === p.node.id
}

/**
 * Group nodes (Object › Group, ⌘G). The group goes where the TOPMOST picked
 * node was -- its layer, its group, its stacking position -- and the members
 * keep their paint order, ids and on-screen position (nodes coming from inside
 * transformed groups are re-expressed in the new group's space). Grouping one
 * object is allowed, as in Illustrator.
 */
export function groupNodes(doc: DrawDoc, places: NodePlace[], extra: Partial<DrawGroupNode> = {}): { doc: DrawDoc; groupId: string | null } {
  if (places.length === 0) return { doc, groupId: null }
  const sorted = [...places].sort((a, b) => a.order - b.order)
  const top = sorted[sorted.length - 1]
  const target = containerOf(top)
  const targetM = parentMatrix(top.parents)
  const members = sorted.map((p) => reparent(p.node, parentMatrix(p.parents), targetM))
  const picked = new Set(sorted.map((p) => p.node.id))
  const before = childrenOf(doc, target) ?? []
  const at = before.slice(0, top.index).filter((n) => !picked.has(n.id)).length
  const group: DrawGroupNode = { id: drawId('grp'), type: 'group', children: members, ...extra }
  let next = removeNodes(doc, picked)
  next = withChildren(next, target, (children) => [...children.slice(0, at), group, ...children.slice(at)])
  return { doc: next, groupId: group.id }
}

function removeNodes(doc: DrawDoc, ids: Set<string>): DrawDoc {
  const strip = (nodes: DrawNode[]): DrawNode[] => {
    let changed = false
    const out: DrawNode[] = []
    for (const n of nodes) {
      if (ids.has(n.id)) {
        changed = true
        continue
      }
      if (n.type === 'group') {
        const children = strip(n.children)
        if (children !== n.children) {
          changed = true
          out.push({ ...n, children })
          continue
        }
      }
      out.push(n)
    }
    return changed ? out : nodes
  }
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector') return l
      const objects = strip(l.objects)
      return objects === l.objects ? l : { ...l, objects }
    })
  }
}

/**
 * A group's member as it stands once the group is gone: the group's matrix
 * baked in, its opacity multiplied into the member's, and its blend mode
 * carried onto members that blend normally.
 */
function releaseMember(g: DrawGroupNode, c: DrawNode): DrawNode {
  let out = g.transform ? applyNodeMatrix(c, g.transform) : c
  if (out.type === 'opaque') return out
  if (typeof g.opacity === 'number' && g.opacity < 1) out = { ...out, opacity: (out.opacity ?? 1) * g.opacity }
  if (g.blend && g.blend !== 'normal' && (!out.blend || out.blend === 'normal')) out = { ...out, blend: g.blend }
  return out
}

/**
 * Ungroup (Object › Ungroup, ⇧⌘G): each picked group is replaced, in place,
 * by its members. A clipping group stops clipping and its clip path is left
 * as an ordinary path, as in Illustrator. Returns the members' ids (the new
 * selection) and whether a group's live effects had to be dropped.
 */
export function ungroupNodes(doc: DrawDoc, groupIds: string[]): { doc: DrawDoc; ids: string[]; droppedEffects: boolean } {
  const wanted = new Set(groupIds)
  // Innermost first, so an outer group that is also being ungrouped then sees
  // its already-released members.
  const targets = allPlaces(doc)
    .filter((p) => wanted.has(p.node.id) && p.node.type === 'group')
    .sort((a, b) => b.parents.length - a.parents.length)
  if (targets.length === 0) return { doc, ids: [], droppedEffects: false }
  let next = doc
  let droppedEffects = false
  const released = new Map<string, string[]>()
  for (const t of targets) {
    const now = placeOf(next, t.node.id)
    if (!now || now.node.type !== 'group') continue
    const g = now.node
    if (g.appearance && g.appearance.effects.length) droppedEffects = true
    const members = g.children.map((c) => releaseMember(g, c))
    released.set(g.id, members.map((m) => m.id))
    next = withChildren(next, containerOf(now), (children) => children.flatMap((n) => (n.id === g.id ? members : [n])))
  }
  // The new selection: released members, expanded where a member was itself released.
  const expand = (id: string): string[] => (released.has(id) ? released.get(id)!.flatMap(expand) : [id])
  const ids = outermostIds(next, targets.filter((t) => !t.parents.some((p) => wanted.has(p.id))).flatMap((t) => expand(t.node.id)))
  return { doc: next, ids, droppedEffects }
}

/**
 * Move nodes that sit directly on `layerId` into a group (keeping where they
 * are on screen), on top of its members -- how new artwork lands inside the
 * group being edited in isolation mode.
 */
export function adoptIntoGroup(doc: DrawDoc, ids: string[], groupId: string): DrawDoc {
  const g = placeOf(doc, groupId)
  if (!g || g.node.type !== 'group' || ids.length === 0) return doc
  const inv = invertMatrix(innerMatrixOf(doc, groupId))
  const wanted = new Set(ids)
  const moving = allPlaces(doc).filter((p) => wanted.has(p.node.id) && p.parents.length === 0)
  if (!moving.length || !inv) return doc
  const nodes = moving.map((p) => applyNodeMatrix(p.node, inv))
  let next = removeNodes(doc, new Set(moving.map((p) => p.node.id)))
  const clip = clipShapeOf(g.node)
  // In a clipping group new art goes under the clip path, which must stay on top.
  next = withChildren(next, { layerId: g.layerId, groupId }, (children) => (clip ? [...children.slice(0, -1), ...nodes, children[children.length - 1]] : [...children, ...nodes]))
  return next
}

// ── Arrange, inside any container ────────────────────────────────────────────

export type ArrangeDirection = 'front' | 'forward' | 'backward' | 'back'

function arrangeList(list: DrawNode[], wanted: Set<string>, dir: ArrangeDirection): DrawNode[] {
  if (!list.some((o) => wanted.has(o.id))) return list
  if (dir === 'front' || dir === 'back') {
    const picked = list.filter((o) => wanted.has(o.id))
    const rest = list.filter((o) => !wanted.has(o.id))
    const out = dir === 'front' ? [...rest, ...picked] : [...picked, ...rest]
    return out.every((n, i) => n === list[i]) ? list : out
  }
  const next = list.slice()
  if (dir === 'forward') {
    for (let i = next.length - 2; i >= 0; i--) if (wanted.has(next[i].id) && !wanted.has(next[i + 1].id)) [next[i], next[i + 1]] = [next[i + 1], next[i]]
  } else {
    for (let i = 1; i < next.length; i++) if (wanted.has(next[i].id) && !wanted.has(next[i - 1].id)) [next[i], next[i - 1]] = [next[i - 1], next[i]]
  }
  return next.every((n, i) => n === list[i]) ? list : next
}

/**
 * Bring to Front / Forward, Send Backward / to Back -- within each node's own
 * container, so it works on a layer's objects and equally inside a group. In
 * a clipping group the clip path stays on top: the contents rearrange beneath
 * it, and the clip path itself does not move.
 */
export function arrangeNodes(doc: DrawDoc, ids: string[], dir: ArrangeDirection): DrawDoc {
  const wanted = new Set(ids)
  const containers: Container[] = []
  for (const p of allPlaces(doc)) {
    if (!wanted.has(p.node.id)) continue
    const c = containerOf(p)
    if (!containers.some((x) => sameContainer(x, c))) containers.push(c)
  }
  let next = doc
  for (const c of containers) {
    const parent = c.groupId ? placeOf(next, c.groupId)?.node : undefined
    const clip = parent && parent.type === 'group' ? clipShapeOf(parent) : null
    next = withChildren(next, c, (children) => {
      if (!clip) return arrangeList(children, wanted, dir)
      const body = children.slice(0, -1)
      const moved = arrangeList(body, wanted, dir)
      return moved === body ? children : [...moved, children[children.length - 1]]
    })
  }
  return next
}

/** Would arrangeNodes change anything? (For enabling the Arrange items honestly.) */
export function canArrange(doc: DrawDoc, ids: string[], dir: ArrangeDirection): boolean {
  const next = arrangeNodes(doc, ids, dir)
  return next.layers.some((l, i) => l !== doc.layers[i])
}

// ── Lock and Hide ────────────────────────────────────────────────────────────

type Flag = 'locked' | 'hidden'

function setFlag(doc: DrawDoc, ids: Set<string>, flag: Flag, value: boolean): DrawDoc {
  return mapById(
    doc,
    new Map(
      [...ids].map((id): [string, (n: DrawNode) => DrawNode] => [
        id,
        (n) => {
          if (value) return n[flag] === true ? n : ({ ...n, [flag]: true } as DrawNode)
          if (n[flag] === undefined) return n
          const copy = { ...n } as Record<string, unknown>
          delete copy[flag]
          return copy as unknown as DrawNode
        }
      ])
    )
  )
}

/** Lock › Selection (⌘2) or Hide › Selection (⌘3). */
export function flagNodes(doc: DrawDoc, ids: string[], flag: Flag): DrawDoc {
  return setFlag(doc, new Set(ids), flag, true)
}

/** Every node (at any depth) that is locked / hidden, optionally only inside one group. */
export function flaggedIds(doc: DrawDoc, flag: Flag, withinGroupId?: string): string[] {
  return allPlaces(doc)
    .filter((p) => p.node[flag] === true && (!withinGroupId || p.parents.some((g) => g.id === withinGroupId)))
    .map((p) => p.node.id)
}

/**
 * Unlock All (⌥⌘2) / Show All (⌥⌘3): clear the flag on every node that has it
 * (inside one group in isolation mode). Layers are left as they are -- the
 * Layers panel owns those. Returns the ids that changed, which Illustrator
 * then selects.
 */
export function clearFlagAll(doc: DrawDoc, flag: Flag, withinGroupId?: string): { doc: DrawDoc; ids: string[] } {
  const ids = flaggedIds(doc, flag, withinGroupId)
  return { doc: setFlag(doc, new Set(ids), flag, false), ids }
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Lock / Hide › All Artwork Above: every unlocked, visible node that is above
 * a selected one IN THE SAME CONTAINER and overlaps it on the artboard.
 */
export function artworkAboveIds(doc: DrawDoc, ids: string[], flag: Flag): string[] {
  const out = new Set<string>()
  const places = allPlaces(doc)
  for (const id of ids) {
    const p = places.find((x) => x.node.id === id)
    if (!p) continue
    const box = worldBounds(doc, id)
    if (!box) continue
    const list = childrenOf(doc, containerOf(p)) ?? []
    const parent = p.parents[p.parents.length - 1]
    const clipId = parent ? clipShapeOf(parent)?.id : undefined
    for (const n of list.slice(p.index + 1)) {
      if (n.locked || n.hidden || n.type === 'opaque' || ids.includes(n.id) || n.id === clipId) continue
      if (flag === 'locked' && n.locked) continue
      const nb = worldBounds(doc, n.id)
      if (nb && overlaps(box, nb)) out.add(n.id)
    }
  }
  return [...out]
}

/** Lock / Hide › Other Layers: every vector or paint layer that holds none of `ids`. */
export function otherLayerIds(doc: DrawDoc, ids: string[], flag: Flag): string[] {
  const mine = new Set(allPlaces(doc).filter((p) => ids.includes(p.node.id)).map((p) => p.layerId))
  return doc.layers.filter((l) => !mine.has(l.id) && (flag === 'locked' ? !l.locked : l.visible)).map((l) => l.id)
}

export function flagLayers(doc: DrawDoc, layerIds: string[], flag: Flag): DrawDoc {
  if (!layerIds.length) return doc
  const set = new Set(layerIds)
  return { ...doc, layers: doc.layers.map((l) => (set.has(l.id) ? (flag === 'locked' ? { ...l, locked: true } : { ...l, visible: false }) : l)) }
}
