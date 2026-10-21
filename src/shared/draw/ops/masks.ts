// Clipping masks (Object › Clipping Mask), Illustrator's model: a clipping
// group is a group with `clip: true` whose TOPMOST member is the clip path.
// The clip path is not painted as a shape -- it defines what of the other
// members shows -- unless it is given a fill (drawn under the contents) or a
// stroke (drawn over them, unclipped), which is what Illustrator does too.
//
// The geometric facts (which member clips, what is inside it) live in
// geometry.ts beside bounds and hit-testing; this file builds the commands and
// the one description of a clipping group that the canvas and the exporter
// both draw from.

import type { DrawDoc, DrawGroupNode, DrawNode, DrawPathNode, DrawTextNode } from '../model'
import { clipHasFill, clipHasStroke, clipShapeOf, canClip } from './geometry'
import { allPlaces, groupNodes, isClipPathPlace, pickForGrouping, withChildren, containerOf, type NodePlace } from './groups'
import { editableIds } from './objects'

export type ClipShape = DrawPathNode | DrawTextNode

/** How to draw a group: the clip shape (if it clips), the members that show, and the clip path's own paint. */
export interface ClipGroupParts {
  clip: ClipShape | null
  /** Members painted (clipped when `clip` is set), bottom first. */
  contents: DrawNode[]
  /** The clip path's fill, drawn beneath the contents; null when it has none. */
  under: ClipShape | null
  /** The clip path's stroke, drawn above the contents and not clipped; null when it has none. */
  over: ClipShape | null
}

export function clipGroupParts(g: DrawGroupNode): ClipGroupParts {
  const clip = clipShapeOf(g)
  if (!clip) return { clip: null, contents: g.children, under: null, over: null }
  const contents = g.children.slice(0, -1)
  if (clip.hidden) return { clip, contents, under: null, over: null }
  let under: ClipShape | null = null
  let over: ClipShape | null = null
  if (clipHasFill(clip)) {
    under = clip.appearance
      ? ({ ...clip, appearance: { ...clip.appearance, strokes: [] } } as ClipShape)
      : ({ ...clip, stroke: undefined } as ClipShape)
  }
  if (clipHasStroke(clip)) {
    over = clip.appearance
      ? ({ ...clip, appearance: { ...clip.appearance, fills: [] } } as ClipShape)
      : ({ ...clip, fill: { type: 'none' } } as ClipShape)
  }
  return { clip, contents, under, over }
}

/** The clip shape as a plain silhouette, for inside an SVG <clipPath> (paint there is ignored; keep it simple). */
export function clipSilhouette(clip: ClipShape): ClipShape {
  const { appearance: _a, opacity: _o, blend: _b, hidden: _h, ...rest } = clip
  void _a
  void _o
  void _b
  void _h
  return { ...rest, fill: { type: 'solid', color: '#000000' }, stroke: undefined } as ClipShape
}

/** A shape about to become a clip path: no fill and no stroke, as Make Clipping Mask leaves it. */
function asClipPath(n: ClipShape): ClipShape {
  const { appearance: _a, ...rest } = n
  void _a
  return { ...rest, fill: { type: 'none' }, stroke: undefined } as ClipShape
}

export type MakeClipProblem = 'nothing' | 'one-object' | 'top-not-a-shape' | 'clip-path-picked' | null

/**
 * Why Make Clipping Mask cannot run on `ids`, or null when it can.
 *   - two or more objects, the topmost a path, compound path or type; or
 *   - one ordinary group whose own topmost member is such a shape.
 */
export function makeClipProblem(doc: DrawDoc, ids: string[]): MakeClipProblem {
  const picked = pickForGrouping(doc, ids, editableIds)
  if (picked.length === 0) return 'nothing'
  if (picked.some(isClipPathPlace)) return 'clip-path-picked'
  if (picked.length === 1) {
    const g = picked[0].node
    if (g.type !== 'group' || g.clip || g.children.length < 2) return 'one-object'
    return canClip(g.children[g.children.length - 1]) ? null : 'top-not-a-shape'
  }
  return canClip(picked[picked.length - 1].node) ? null : 'top-not-a-shape'
}

/**
 * Object › Clipping Mask › Make (⌘7). The selection is grouped where its
 * topmost object was, the topmost object becomes the clip path (its fill and
 * stroke set to none) and everything else is masked by it. A single selected
 * group is turned into a clipping group in place. Returns the clipping
 * group's id, or null (document unchanged) when makeClipProblem says no.
 */
export function makeClipMask(doc: DrawDoc, ids: string[]): { doc: DrawDoc; groupId: string | null } {
  if (makeClipProblem(doc, ids) !== null) return { doc, groupId: null }
  const picked = pickForGrouping(doc, ids, editableIds)
  if (picked.length === 1) {
    const place = picked[0] as NodePlace & { node: DrawGroupNode }
    const g = place.node
    const top = g.children[g.children.length - 1] as ClipShape
    const next = withChildren(doc, containerOf(place), (children) =>
      children.map((n) => (n.id === g.id ? { ...g, clip: true, children: [...g.children.slice(0, -1), asClipPath(top)] } : n))
    )
    return { doc: next, groupId: g.id }
  }
  const { doc: grouped, groupId } = groupNodes(doc, picked, { clip: true })
  if (!groupId) return { doc, groupId: null }
  const next = withChildrenOfGroup(grouped, groupId, (children) => [...children.slice(0, -1), asClipPath(children[children.length - 1] as ClipShape)])
  return { doc: next, groupId }
}

function withChildrenOfGroup(doc: DrawDoc, groupId: string, fn: (c: DrawNode[]) => DrawNode[]): DrawDoc {
  const p = allPlaces(doc).find((x) => x.node.id === groupId)
  return p ? withChildren(doc, { layerId: p.layerId, groupId }, fn) : doc
}

/**
 * The clipping groups a command about masks acts on: each selected node that
 * is a clipping group, else the nearest clipping group above it (so Release
 * and Edit Mask work after Edit Contents, as in Illustrator). Editable only.
 */
export function clipGroupsFor(doc: DrawDoc, ids: string[]): DrawGroupNode[] {
  const wanted = new Set(ids)
  const out: DrawGroupNode[] = []
  const ok = new Set(editableIds(doc, allPlaces(doc).map((p) => p.node.id)))
  for (const p of allPlaces(doc)) {
    if (!wanted.has(p.node.id)) continue
    const chain = [...p.parents, p.node].reverse()
    const g = chain.find((n): n is DrawGroupNode => n.type === 'group' && !!clipShapeOf(n))
    if (g && ok.has(g.id) && !out.some((x) => x.id === g.id)) out.push(g)
  }
  return out
}

/**
 * Object › Clipping Mask › Release (⌥⌘7). The group stops clipping and stays a
 * group; the former clip path stays in it with the no-fill, no-stroke it was
 * given, exactly as Illustrator leaves it. Returns the released groups' ids.
 */
export function releaseClipMask(doc: DrawDoc, ids: string[]): { doc: DrawDoc; groupIds: string[] } {
  const groups = clipGroupsFor(doc, ids)
  let next = doc
  for (const g of groups) {
    next = withChildrenOfGroupParent(next, g.id, (n) => {
      const { clip: _c, ...rest } = n
      void _c
      return rest as DrawGroupNode
    })
  }
  return { doc: next, groupIds: groups.map((g) => g.id) }
}

function withChildrenOfGroupParent(doc: DrawDoc, groupId: string, fn: (g: DrawGroupNode) => DrawGroupNode): DrawDoc {
  const p = allPlaces(doc).find((x) => x.node.id === groupId)
  if (!p || p.node.type !== 'group') return doc
  const g = p.node
  return withChildren(doc, containerOf(p), (children) => children.map((n) => (n.id === groupId ? fn(g) : n)))
}

/** Edit Mask: the clip path of the (single) clipping group the selection is in, or null. */
export function editMaskTarget(doc: DrawDoc, ids: string[]): string | null {
  const gs = clipGroupsFor(doc, ids)
  return gs.length === 1 ? (clipShapeOf(gs[0])?.id ?? null) : null
}

/** Edit Contents: the masked members of the (single) clipping group the selection is in. */
export function editContentsTargets(doc: DrawDoc, ids: string[]): string[] {
  const gs = clipGroupsFor(doc, ids)
  if (gs.length !== 1) return []
  return gs[0].children.slice(0, -1).filter((n) => !n.locked && !n.hidden && n.type !== 'opaque').map((n) => n.id)
}
