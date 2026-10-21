// Isolation mode and hit-testing inside groups.
//
// Illustrator's isolation mode: double-click a group with the Selection tool
// and you edit INSIDE it -- clicks, marquees and Select All reach its members,
// new artwork lands in it, and everything else is dimmed behind it. A bar
// above the canvas shows where you are (layer > group > group); clicking a
// crumb, pressing Esc or double-clicking empty canvas leaves.
//
// State is one field, `isolation`: the ids of the isolated groups from the
// outermost down. It is never trusted as it stands -- an undo, a peer's edit
// or a delete can remove a group from under it -- so every reader goes through
// isolationChain(), which keeps only the part that still exists and can still
// be edited, and an empty chain simply means "not isolated".

import type { Box, Matrix, Pt } from '@shared/drawGeometry'
import { applyMatrix } from '@shared/drawGeometry'
import type { DrawDoc, DrawGroupNode, DrawNode } from '@shared/draw/model'
import {
  adoptIntoGroup,
  allPlaces,
  clipShapeOf,
  hitNode,
  innerMatrixOf,
  insideClip,
  invertMatrix,
  isIdentityMatrix,
  nodeBounds,
  parentMatrix,
  selectableObjectIds,
  transformBox
} from '@shared/draw/ops'
import { allIds, vectorLayersOf } from '@shared/draw/tree'
import type { EditorCtx, EditorState } from './types'

type Scope = Pick<EditorState, 'doc' | 'isolation'>

// ── The isolation chain ──────────────────────────────────────────────────────

/**
 * The isolated groups, outermost first, that still exist, still nest in that
 * order, and can be edited (on a visible, unlocked layer; neither the group
 * nor anything above it locked or hidden). Empty when not isolated.
 */
export function isolationChain(s: Scope): DrawGroupNode[] {
  const ids = s.isolation ?? []
  if (!ids.length) return []
  const places = allPlaces(s.doc)
  const out: DrawGroupNode[] = []
  for (const id of ids) {
    const p = places.find((x) => x.node.id === id)
    if (!p || p.node.type !== 'group' || p.node.locked || p.node.hidden) break
    // Must sit directly inside the previous isolated group (or at the top).
    const parent = p.parents[p.parents.length - 1]
    if ((out.length === 0 && p.parents.length !== 0) || (out.length > 0 && parent?.id !== out[out.length - 1].id)) break
    if (p.parents.some((g) => g.locked || g.hidden)) break
    const layer = s.doc.layers.find((l) => l.id === p.layerId)
    if (!layer || !layer.visible || layer.locked) break
    out.push(p.node)
  }
  return out
}

export function isolatedGroup(s: Scope): DrawGroupNode | null {
  const c = isolationChain(s)
  return c.length ? c[c.length - 1] : null
}

/** The layer the isolated group is on, for the breadcrumb. */
export function isolationLayerName(s: Scope): string | null {
  const g = isolatedGroup(s)
  if (!g) return null
  const p = allPlaces(s.doc).find((x) => x.node.id === g.id)
  const l = p ? s.doc.layers.find((x) => x.id === p.layerId) : undefined
  return l ? l.name : null
}

// ── Hit-testing ──────────────────────────────────────────────────────────────

/** The chain from `nodes`' level down to the leaf under `p` (in `nodes`' space), or null. */
function hitList(nodes: DrawNode[], p: Pt, slop: number): DrawNode[] | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    // Locked and hidden objects are passed through, as in Illustrator.
    if (n.hidden || n.locked || n.type === 'opaque') continue
    const c = hitOne(n, p, slop)
    if (c) return c
  }
  return null
}

function hitOne(n: DrawNode, p: Pt, slop: number): DrawNode[] | null {
  if (n.type !== 'group') return hitNode(n, p, slop) ? [n] : null
  let q: Pt = p
  if (n.transform) {
    const inv = invertMatrix(n.transform)
    if (!inv) return null
    q = applyMatrix(inv, p)
  }
  const clip = clipShapeOf(n)
  if (clip) {
    // Masked contents count only where the mask lets them show.
    if (insideClip(clip, q)) {
      const sub = hitList(n.children.slice(0, -1), q, slop)
      if (sub) return [n, ...sub]
    }
    // The clip path itself: its outline (it has no paint by default) or its own paint.
    if (!clip.hidden && !clip.locked && hitNode(clip, q, slop)) return [n, clip]
    return null
  }
  const sub = hitList(n.children, q, slop)
  return sub ? [n, ...sub] : null
}

/**
 * Everything under `p` at the CURRENT level: [the node at this level, ...,
 * the leaf]. At the top level that is the topmost layer's topmost hit; in
 * isolation mode it starts at a member of the isolated group.
 */
export function hitChainAt(s: Scope, p: Pt, slop: number): DrawNode[] | null {
  const chain = isolationChain(s)
  if (chain.length) {
    const g = chain[chain.length - 1]
    const outer = parentMatrix(chain.slice(0, -1))
    const inv = invertMatrix(outer)
    if (!inv) return null
    const hit = hitOne(g, isIdentityMatrix(outer) ? p : applyMatrix(inv, p), slop)
    return hit && hit.length > 1 ? hit.slice(1) : null
  }
  const layers = s.doc.layers
  for (let li = layers.length - 1; li >= 0; li--) {
    const l = layers[li]
    if (l.kind !== 'vector' || !l.visible || l.locked) continue
    const hit = hitList(l.objects, p, slop)
    if (hit) return hit
  }
  return null
}

/**
 * What a click with the Selection tool picks: the node at the current level,
 * unless a node deeper in the same chain is already selected (after Edit
 * Contents, Edit Mask or the Group Selection tool), which then stays the
 * target so it can be dragged.
 */
export function hitForSelection(s: Scope & Pick<EditorState, 'selection' | 'zoom'>, p: Pt): DrawNode | null {
  const chain = hitChainAt(s, p, 4 / s.zoom)
  if (!chain) return null
  for (let i = chain.length - 1; i > 0; i--) if (s.selection.includes(chain[i].id)) return chain[i]
  return chain[0]
}

/** The innermost object under `p` (a path, type, image... never a group), for tools that act on one object. */
export function hitLeaf(s: Scope & Pick<EditorState, 'zoom'>, p: Pt): DrawNode | null {
  const chain = hitChainAt(s, p, 4 / s.zoom)
  return chain ? chain[chain.length - 1] : null
}

// ── Selection at the current level ───────────────────────────────────────────

/** The nodes at the current level with their artboard-space boxes. */
export function scopeNodes(s: Scope): Array<{ node: DrawNode; box: Box | null }> {
  const g = isolatedGroup(s)
  if (g) {
    const m: Matrix = innerMatrixOf(s.doc, g.id)
    return g.children.map((node) => ({ node, box: node.type === 'opaque' ? null : isIdentityMatrix(m) ? nodeBounds(node) : transformBox(nodeBounds(node), m) }))
  }
  const out: Array<{ node: DrawNode; box: Box | null }> = []
  for (const l of vectorLayersOf(s.doc)) {
    if (!l.visible || l.locked) continue
    for (const node of l.objects) out.push({ node, box: node.type === 'opaque' ? null : nodeBounds(node) })
  }
  return out
}

/** Select All: everything at the current level that is neither hidden nor locked. */
export function selectableInScope(s: Scope): string[] {
  if (!isolatedGroup(s)) return selectableObjectIds(s.doc)
  return scopeNodes(s)
    .filter(({ node }) => !node.hidden && !node.locked && node.type !== 'opaque')
    .map(({ node }) => node.id)
}

/** The marquee: nodes at the current level whose visible box touches `box`. */
export function marqueeInScope(s: Scope, box: Box): string[] {
  return scopeNodes(s)
    .filter(({ node, box: b }) => !node.hidden && !node.locked && b && b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y)
    .map(({ node }) => node.id)
}

// ── Entering and leaving ─────────────────────────────────────────────────────

/** Isolate a group that is a member of the current level (or a top-level group). */
export function enterIsolation(ctx: EditorCtx, groupId: string): boolean {
  const s = ctx.get()
  const chain = isolationChain(s)
  const next = [...chain.map((g) => g.id), groupId]
  if (isolationChain({ doc: s.doc, isolation: next }).length !== next.length) return false
  ctx.set({ isolation: next, selection: [] })
  ctx.status(null)
  return true
}

/** Leave isolation mode entirely, or go up to `depth` isolated groups (0 = leave). */
export function exitIsolation(ctx: EditorCtx, depth = 0): void {
  const chain = isolationChain(ctx.get())
  if (!ctx.get().isolation.length) return
  const keep = chain.slice(0, Math.max(0, Math.min(depth, chain.length)))
  // The group just left is selected, as when Illustrator exits isolation.
  const left = chain[keep.length]
  ctx.set({ isolation: keep.map((g) => g.id), selection: left ? [left.id] : [] })
}

export function isIsolated(s: Scope): boolean {
  return isolationChain(s).length > 0
}

/**
 * A double-click on the canvas with the Selection tool: on a group at the
 * current level, isolate it; on empty canvas while isolated, go up one level.
 */
export function canvasDoubleClick(ctx: EditorCtx, p: Pt | null): void {
  const s = ctx.get()
  if (s.readOnly || s.tool !== 'select' || !p || s.pen) return
  const chain = hitChainAt(s, p, 4 / s.zoom)
  if (chain && chain[0].type === 'group') {
    enterIsolation(ctx, chain[0].id)
    return
  }
  if (!chain && isIsolated(s)) exitIsolation(ctx, isolationChain(s).length - 1)
}

/**
 * New artwork made while isolated goes INTO the isolated group, as in
 * Illustrator: any node that appears at the top level of a layer in `next`
 * and existed nowhere in `prev` is moved into it (on top of its members,
 * under a clip path), keeping its place on screen. Used as the history's
 * adjust hook, so every tool and paste gets it without knowing.
 */
export function adoptIntoIsolation(s: Pick<EditorState, 'isolation'>, prev: DrawDoc, next: DrawDoc): DrawDoc {
  if (!s.isolation?.length || next === prev) return next
  const g = isolatedGroup({ doc: next, isolation: s.isolation })
  if (!g) return next
  const before = allIds(prev)
  const fresh: string[] = []
  for (const l of vectorLayersOf(next)) for (const n of l.objects) if (!before.has(n.id)) fresh.push(n.id)
  return fresh.length ? adoptIntoGroup(next, fresh, g.id) : next
}
