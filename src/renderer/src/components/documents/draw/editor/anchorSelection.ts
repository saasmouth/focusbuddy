// The anchor-level selection (Direct Selection, Lasso, the anchor tools) and
// the hit-testing every anchor tool shares, so they all agree on what is under
// the pointer and what is selected.
//
// Model (EditorState.anchors): `selection` still lists the selected OBJECTS;
// `anchors[id]` refines a selected path to some of its anchors. No entry means
// the whole path (every anchor) -- which is what the Selection tool selects --
// and an empty list means the path is selected with none of its anchors.

import type { Pt } from '@shared/drawGeometry'
import type { DrawDoc, DrawPathNode } from '@shared/draw/model'
import { nearestOnPath, segmentCount } from '@shared/draw/geometry/bezier'
import { handleOf, type HandleSide } from '@shared/draw/geometry/pathEdit'
import { allAnchorsOf, editableIds, getObject, toDoc, toLocal, type AnchorRef } from '@shared/draw/ops'
import { allNodes } from '@shared/draw/tree'
import type { EditorCtx, EditorState } from './types'

/** Anchors selected on one path, or null when the path is wholly selected / not selected. */
function explicitFor(s: EditorState, id: string): Array<[number, number]> | null {
  return Object.prototype.hasOwnProperty.call(s.anchors, id) ? s.anchors[id] : null
}

function validRef(doc: DrawDoc, r: AnchorRef): boolean {
  const o = getObject(doc, r.id)
  return !!o && o.type === 'path' && !!o.path.subpaths[r.si]?.nodes[r.ni]
}

/** Every selected anchor: explicit ones, plus all anchors of wholly selected paths. */
export function selectedAnchors(s: EditorState): AnchorRef[] {
  const out: AnchorRef[] = []
  for (const id of s.selection) {
    const o = getObject(s.doc, id)
    if (!o || o.type !== 'path') continue
    const ex = explicitFor(s, id)
    if (ex) for (const [si, ni] of ex) out.push({ id, si, ni })
    else out.push(...allAnchorsOf(s.doc, id))
  }
  return out.filter((r) => validRef(s.doc, r))
}

/** Only the anchors of PARTLY selected paths (the ones an anchor command acts on instead of the object). */
export function partialAnchors(s: EditorState): AnchorRef[] {
  const out: AnchorRef[] = []
  for (const id of s.selection) {
    const ex = explicitFor(s, id)
    if (ex) for (const [si, ni] of ex) out.push({ id, si, ni })
  }
  return out.filter((r) => validRef(s.doc, r))
}

/** Selected objects that are selected as a whole (not refined to anchors). */
export function wholeSelection(s: EditorState): string[] {
  return s.selection.filter((id) => !explicitFor(s, id))
}

export function isAnchorSelected(s: EditorState, r: AnchorRef): boolean {
  if (!s.selection.includes(r.id)) return false
  const ex = explicitFor(s, r.id)
  if (!ex) return true
  return ex.some(([si, ni]) => si === r.si && ni === r.ni)
}

/**
 * Select exactly these anchors (and `whole` paths entirely). A path whose every
 * anchor is listed collapses to "wholly selected". `keepEmpty` paths stay
 * selected with no anchors.
 */
export function selectAnchors(ctx: EditorCtx, refs: AnchorRef[], opts: { whole?: string[]; keepEmpty?: string[] } = {}): void {
  const doc = ctx.doc()
  const by = new Map<string, Array<[number, number]>>()
  for (const r of refs) {
    if (!validRef(doc, r)) continue
    const list = by.get(r.id) ?? []
    if (!list.some(([si, ni]) => si === r.si && ni === r.ni)) list.push([r.si, r.ni])
    by.set(r.id, list)
  }
  const selection: string[] = []
  const anchors: Record<string, Array<[number, number]>> = {}
  for (const id of opts.whole ?? []) if (!selection.includes(id)) selection.push(id)
  for (const [id, list] of by) {
    if (selection.includes(id)) continue
    selection.push(id)
    const total = allAnchorsOf(doc, id).length
    if (list.length < total) anchors[id] = list
  }
  for (const id of opts.keepEmpty ?? []) {
    if (selection.includes(id)) continue
    selection.push(id)
    anchors[id] = []
  }
  ctx.set({ selection, anchors })
}

/** Add or remove anchors from the current anchor selection (Shift). */
export function toggleAnchors(ctx: EditorCtx, refs: AnchorRef[], mode: 'toggle' | 'add' | 'remove'): void {
  const s = ctx.get()
  const current = selectedAnchors(s)
  const key = (r: AnchorRef): string => `${r.id}:${r.si}:${r.ni}`
  const set = new Map(current.map((r) => [key(r), r]))
  for (const r of refs) {
    const k = key(r)
    if (mode === 'add' || (mode === 'toggle' && !set.has(k))) set.set(k, r)
    else set.delete(k)
  }
  const nonPaths = s.selection.filter((id) => getObject(s.doc, id)?.type !== 'path')
  selectAnchors(ctx, [...set.values()], { whole: nonPaths })
}

// ── What is under the pointer ────────────────────────────────────────────────

export type AnchorHit =
  | { kind: 'handle'; ref: AnchorRef; side: HandleSide; at: Pt }
  | { kind: 'anchor'; ref: AnchorRef; at: Pt }
  | { kind: 'segment'; id: string; si: number; seg: number; t: number; at: Pt }

/** Editable, visible path nodes, topmost first. */
export function editablePaths(doc: DrawDoc): DrawPathNode[] {
  const all = allNodes(doc)
    .map((x) => x.node)
    .filter((n): n is DrawPathNode => n.type === 'path')
  const ok = new Set(editableIds(doc, all.map((n) => n.id)))
  return all.filter((n) => ok.has(n.id)).reverse()
}

/**
 * A fast lookup over the current anchor selection, for code that asks about
 * many anchors at once (the overlay, hit-testing): built once, O(1) a query.
 */
export interface AnchorIndex {
  count: number
  has(r: AnchorRef): boolean
}

const indexCache = new WeakMap<EditorState, AnchorIndex>()

export function anchorIndex(s: EditorState): AnchorIndex {
  const cached = indexCache.get(s)
  if (cached) return cached
  const whole = new Set<string>()
  const keys = new Set<string>()
  let count = 0
  for (const id of s.selection) {
    const o = getObject(s.doc, id)
    if (!o || o.type !== 'path') continue
    const ex = explicitFor(s, id)
    if (ex) {
      for (const [si, ni] of ex) if (o.path.subpaths[si]?.nodes[ni]) keys.add(`${id}:${si}:${ni}`)
      count += ex.length
    } else {
      whole.add(id)
      for (const sp of o.path.subpaths) count += sp.nodes.length
    }
  }
  const idx: AnchorIndex = { count, has: (r) => whole.has(r.id) || keys.has(`${r.id}:${r.si}:${r.ni}`) }
  indexCache.set(s, idx)
  return idx
}

/** Whether a handle of this anchor is shown (and so can be grabbed). */
export function handlesShown(s: EditorState, r: AnchorRef): boolean {
  if (!s.selection.includes(r.id)) return false
  const idx = anchorIndex(s)
  if (!s.pathPrefs.showHandles && idx.count > 1) return false
  if (idx.has(r)) return true
  // A neighbour of a selected anchor shows the handle that shapes the shared segment.
  const o = getObject(s.doc, r.id)
  if (!o || o.type !== 'path') return false
  const sp = o.path.subpaths[r.si]
  const n = sp.nodes.length
  const prev = r.ni > 0 ? r.ni - 1 : sp.closed ? n - 1 : -1
  const next = r.ni < n - 1 ? r.ni + 1 : sp.closed ? 0 : -1
  return (prev >= 0 && idx.has({ ...r, ni: prev })) || (next >= 0 && idx.has({ ...r, ni: next }))
}

/**
 * The anchor, handle or segment under `p` (document space), with handles of
 * selected paths first, then anchors of selected paths, then any editable
 * path's anchors, then segments -- topmost path first.
 */
export function anchorHitAt(s: EditorState, p: Pt, opts: { handles?: boolean; anchors?: boolean; segments?: boolean; onlySelected?: boolean } = {}): AnchorHit | null {
  const r = 6 / s.zoom
  const doc = s.doc
  const paths = editablePaths(doc)
  const selected = paths.filter((o) => s.selection.includes(o.id))
  const pool = opts.onlySelected ? selected : [...selected, ...paths.filter((o) => !s.selection.includes(o.id))]
  if (opts.handles !== false) {
    for (const o of selected) {
      for (let si = 0; si < o.path.subpaths.length; si++) {
        const sp = o.path.subpaths[si]
        for (let ni = 0; ni < sp.nodes.length; ni++) {
          const ref = { id: o.id, si, ni }
          if (!handlesShown(s, ref)) continue
          for (const side of ['out', 'in'] as HandleSide[]) {
            const h = handleOf(sp.nodes[ni], side)
            if (!h) continue
            const at = toDoc(doc, o.id, h)
            if (Math.hypot(at.x - p.x, at.y - p.y) <= r) return { kind: 'handle', ref, side, at }
          }
        }
      }
    }
  }
  if (opts.anchors !== false) {
    for (const o of pool) {
      for (let si = 0; si < o.path.subpaths.length; si++) {
        const sp = o.path.subpaths[si]
        for (let ni = 0; ni < sp.nodes.length; ni++) {
          const at = toDoc(doc, o.id, sp.nodes[ni])
          if (Math.hypot(at.x - p.x, at.y - p.y) <= r) return { kind: 'anchor', ref: { id: o.id, si, ni }, at }
        }
      }
    }
  }
  if (opts.segments !== false) {
    for (const o of pool) {
      const local = toLocal(doc, o.id, p)
      // Cheap reject: outside the control hull's box (plus the pick radius) cannot be on the outline.
      if (!nearHull(o, local, r * 4 + 1)) continue
      const h = nearestOnPath(o.path, local)
      if (!h) continue
      const at = toDoc(doc, o.id, h.point)
      if (Math.hypot(at.x - p.x, at.y - p.y) <= r) {
        if (segmentCount(o.path.subpaths[h.si]) > 0) return { kind: 'segment', id: o.id, si: h.si, seg: h.seg, t: h.t, at }
      }
    }
  }
  return null
}

function nearHull(o: DrawPathNode, p: Pt, pad: number): boolean {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const sp of o.path.subpaths)
    for (const n of sp.nodes) {
      for (const [x, y] of [
        [n.x, n.y],
        [n.inX ?? n.x, n.inY ?? n.y],
        [n.outX ?? n.x, n.outY ?? n.y]
      ]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  return p.x >= minX - pad && p.x <= maxX + pad && p.y >= minY - pad && p.y <= maxY + pad
}

/** Is `ref` an end of an open subpath? */
export function isOpenEnd(doc: DrawDoc, ref: AnchorRef): 'start' | 'end' | null {
  const o = getObject(doc, ref.id)
  const sp = o && o.type === 'path' ? o.path.subpaths[ref.si] : undefined
  if (!sp || sp.closed || sp.nodes.length < 1) return null
  if (ref.ni === 0) return 'start'
  if (ref.ni === sp.nodes.length - 1) return 'end'
  return null
}
