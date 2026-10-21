// Compound paths (Object › Compound Path), Illustrator's model: ONE path node
// with several subpaths and a fill rule. No new node type is needed -- a
// DrawPath already holds subpaths and `fillRule` -- so a compound path is
// still a v1-representable object.
//
// Make (⌘8) joins the selected paths (and the paths inside selected groups)
// into one node that takes the paint of the BACKMOST object and sits where the
// FRONTMOST one was. It uses the non-zero winding rule, Illustrator's default,
// and orients the subpaths so the shapes in front cut holes through the one at
// the back -- two concentric circles become a ring, as they do in Illustrator.
// Release (⌥⇧⌘8) splits a compound path back into one path per subpath, each
// keeping the compound's paint.

import { drawId } from '../../draw'
import { flattenSubpath, multiplyMatrix, polygonArea, type DrawPath, type DrawSubpath } from '../../drawGeometry'
import type { DrawDoc, DrawNode, DrawPathNode } from '../model'
import { allPlaces, containerOf, isClipPathPlace, outermostIds, parentMatrix, applyNodeMatrix, withChildren, invertMatrix, type NodePlace } from './groups'
import { editableIds } from './objects'

export type FillRule = 'nonzero' | 'evenodd'

/** Every path a selection stands for: selected paths, and the paths inside selected groups. Null if anything else is in it. */
function pathsOf(doc: DrawDoc, ids: string[]): { top: NodePlace; parts: NodePlace[]; paths: Array<{ node: DrawPathNode; place: NodePlace }> } | null {
  const picked = new Set(outermostIds(doc, editableIds(doc, ids)))
  const places = allPlaces(doc)
  const tops = places.filter((p) => picked.has(p.node.id))
  if (tops.length === 0 || tops.some(isClipPathPlace)) return null
  const paths: Array<{ node: DrawPathNode; place: NodePlace }> = []
  for (const t of tops) {
    if (t.node.type === 'path') {
      paths.push({ node: t.node, place: t })
      continue
    }
    if (t.node.type !== 'group') return null
    // A group counts only if everything in it is a path (a clipping group never does).
    const inner = places.filter((p) => p.parents.some((g) => g.id === t.node.id))
    if (t.node.clip || inner.some((p) => p.node.type !== 'path' && p.node.type !== 'group')) return null
    for (const p of inner) if (p.node.type === 'path') paths.push({ node: p.node, place: p })
  }
  return { top: tops[tops.length - 1], parts: tops, paths }
}

/** Can Make Compound Path run: two or more paths in all, nothing else selected. */
export function canMakeCompound(doc: DrawDoc, ids: string[]): boolean {
  const r = pathsOf(doc, ids)
  return !!r && r.paths.length >= 2
}

function orientation(sp: DrawSubpath): number {
  return Math.sign(polygonArea(flattenSubpath(sp, 1)))
}

function reverseSubpath(sp: DrawSubpath): DrawSubpath {
  return {
    closed: sp.closed,
    nodes: sp.nodes
      .slice()
      .reverse()
      .map((n) => ({ x: n.x, y: n.y, ...(n.outX != null ? { inX: n.outX, inY: n.outY } : {}), ...(n.inX != null ? { outX: n.inX, outY: n.inY } : {}) }))
  }
}

/**
 * Make Compound Path. Returns the new node's id, or null (document unchanged)
 * when canMakeCompound says no.
 */
export function makeCompoundPath(doc: DrawDoc, ids: string[]): { doc: DrawDoc; newId: string | null } {
  const r = pathsOf(doc, ids)
  if (!r || r.paths.length < 2) return { doc, newId: null }
  const targetM = parentMatrix(r.top.parents)
  const inv = invertMatrix(targetM)
  if (!inv) return { doc, newId: null }
  // Every path re-expressed in the space of the place the result goes.
  const inTarget = r.paths.map(({ node, place }) => {
    const m = multiplyMatrix(inv, parentMatrix(place.parents))
    return applyNodeMatrix(node, m) as DrawPathNode
  })
  const base = inTarget[0]
  const ref = orientation(base.path.subpaths.find((sp) => sp.closed && sp.nodes.length > 2) ?? base.path.subpaths[0])
  const subpaths: DrawSubpath[] = [...base.path.subpaths]
  for (const p of inTarget.slice(1)) {
    const first = p.path.subpaths.find((sp) => sp.closed && sp.nodes.length > 2) ?? p.path.subpaths[0]
    // Opposite to the backmost shape, so it cuts a hole under non-zero; a path
    // that is itself compound keeps its own inner relationships.
    const flip = ref !== 0 && orientation(first) === ref
    for (const sp of p.path.subpaths) subpaths.push(flip ? reverseSubpath(sp) : sp)
  }
  // Non-zero is the default rule, so it is written by leaving fillRule out.
  const { fillRule: _rule, ...basePath } = base.path
  void _rule
  const path: DrawPath = { ...basePath, subpaths }
  const { cornerRadius: _r, sides: _s, innerRatio: _i, ...rest } = base
  void _r
  void _s
  void _i
  const compound: DrawPathNode = { ...rest, id: drawId('obj'), shapeKind: 'path', path }
  const removed = new Set(r.parts.map((p) => p.node.id))
  const target = containerOf(r.top)
  const before = allPlaces(doc).filter((p) => p.layerId === target.layerId && (p.parents[p.parents.length - 1]?.id ?? null) === target.groupId)
  const at = before.filter((p) => p.index < r.top.index && !removed.has(p.node.id)).length
  let next = removeIds(doc, removed)
  next = withChildren(next, target, (children) => [...children.slice(0, at), compound, ...children.slice(at)])
  return { doc: next, newId: compound.id }
}

function removeIds(doc: DrawDoc, ids: Set<string>): DrawDoc {
  const strip = (nodes: DrawNode[]): DrawNode[] =>
    nodes.filter((n) => !ids.has(n.id)).map((n) => (n.type === 'group' ? { ...n, children: strip(n.children) } : n))
  return { ...doc, layers: doc.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: strip(l.objects) } : l)) }
}

/** The editable compound paths (two or more subpaths) among `ids`. */
export function compoundPathIds(doc: DrawDoc, ids: string[]): string[] {
  const ok = new Set(editableIds(doc, ids))
  return allPlaces(doc)
    .filter((p) => ok.has(p.node.id) && p.node.type === 'path' && p.node.path.subpaths.length > 1 && !isClipPathPlace(p))
    .map((p) => p.node.id)
}

/**
 * Release Compound Path: each subpath becomes its own path, in place and in
 * order, with the compound's paint. The first keeps the compound's id.
 */
export function releaseCompoundPath(doc: DrawDoc, ids: string[]): { doc: DrawDoc; ids: string[] } {
  const targets = new Set(compoundPathIds(doc, ids))
  if (targets.size === 0) return { doc, ids: [] }
  const out: string[] = []
  const places = allPlaces(doc).filter((p) => targets.has(p.node.id))
  let next = doc
  for (const p of places) {
    const node = p.node as DrawPathNode
    const pieces: DrawPathNode[] = node.path.subpaths.map((sp, i) => {
      const { fillRule: _f, ...pathRest } = node.path
      void _f
      // Each piece owns its paint (a deep copy): two shapes never share one object.
      const own = i === 0 ? node : structuredClone(node)
      return { ...own, id: i === 0 ? node.id : drawId('obj'), shapeKind: 'path', path: { ...pathRest, subpaths: [structuredClone(sp)] } }
    })
    out.push(...pieces.map((x) => x.id))
    next = withChildren(next, containerOf(p), (children) => children.flatMap((n) => (n.id === node.id ? pieces : [n])))
  }
  return { doc: next, ids: out }
}

/** The editable paths a fill-rule change applies to: selected paths and the paths inside selected groups. */
export function fillRuleTargets(doc: DrawDoc, ids: string[]): DrawPathNode[] {
  const ok = new Set(editableIds(doc, allPlaces(doc).map((p) => p.node.id)))
  const wanted = new Set(ids)
  return allPlaces(doc)
    .filter((p) => ok.has(p.node.id) && p.node.type === 'path' && (wanted.has(p.node.id) || p.parents.some((g) => wanted.has(g.id))))
    .map((p) => p.node as DrawPathNode)
}

/** The fill rule the targets share, 'mixed', or null when there are none. */
export function fillRuleOf(doc: DrawDoc, ids: string[]): FillRule | 'mixed' | null {
  const t = fillRuleTargets(doc, ids)
  if (!t.length) return null
  const rules = new Set(t.map((p) => p.path.fillRule ?? 'nonzero'))
  return rules.size === 1 ? [...rules][0] : 'mixed'
}

/** Use Non-Zero Winding / Even-Odd Fill Rule (the Attributes panel's two buttons). */
export function setFillRule(doc: DrawDoc, ids: string[], rule: FillRule): DrawDoc {
  const targets = new Set(fillRuleTargets(doc, ids).filter((p) => (p.path.fillRule ?? 'nonzero') !== rule).map((p) => p.id))
  if (!targets.size) return doc
  const map = (nodes: DrawNode[]): DrawNode[] => {
    let changed = false
    const out = nodes.map((n) => {
      if (n.type === 'path' && targets.has(n.id)) {
        changed = true
        if (rule === 'evenodd') return { ...n, path: { ...n.path, fillRule: 'evenodd' as const } }
        const { fillRule: _f, ...rest } = n.path
        void _f
        return { ...n, path: rest }
      }
      if (n.type === 'group') {
        const children = map(n.children)
        if (children !== n.children) {
          changed = true
          return { ...n, children }
        }
      }
      return n
    })
    return changed ? out : nodes
  }
  return { ...doc, layers: doc.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: map(l.objects) } : l)) }
}
