// Direct Selection (A), as in Illustrator:
//  - click an anchor of ANY path to select it (Shift-click adds or removes);
//    the path does not have to be selected first;
//  - click a segment to select it (its two end anchors);
//  - click inside a filled path to select all of its anchors;
//  - drag on empty canvas for a marquee over anchors (Shift adds);
//  - drag a selected anchor (or segment) to move every selected anchor; Shift
//    constrains the move to 45°. A curved segment dragged on its own reshapes
//    through the pointer; a straight one moves with its anchors;
//  - drag a handle: a smooth point keeps its handles in line (the other keeps
//    its length); Alt breaks the pair;
//  - drag a corner widget (the dot inside a selected corner) to round it;
//  - arrow keys nudge the selected anchors (Shift ×10), Delete removes them
//    with their segments (see edit.commands.ts).
// Editing a live shape's anchors turns it into a plain path.

import type { Pt } from '@shared/drawGeometry'
import { hitPath } from '@shared/drawGeometry'
import { cornerInfo, isSmoothNode, type HandleSide } from '@shared/draw/geometry/pathEdit'
import type { DrawDoc } from '@shared/draw/model'
import {
  anchorPoint,
  dragSegment,
  editableIds,
  getObject,
  moveAnchors,
  moveHandle,
  moveObjects,
  roundAnchorCorners,
  toLocal,
  type AnchorRef
} from '@shared/draw/ops'
import type { DrawTool, EditorCtx, ToolPointer, Txn } from '../editor/types'
import {
  anchorHitAt,
  editablePaths,
  isAnchorSelected,
  partialAnchors,
  selectAnchors,
  selectedAnchors,
  toggleAnchors,
  wholeSelection
} from '../editor/anchorSelection'
import { normBox } from './helpers'
import { AnchorOverlay, cornerWidgetAt } from './anchorOverlay'

type DirectGesture =
  | { kind: 'marquee'; from: Pt; to: Pt; additive: boolean }
  | { kind: 'move'; start: Pt; applied: Pt; refs: AnchorRef[]; objects: string[]; txn: Txn; moved: boolean; clicked: AnchorRef | null }
  | { kind: 'handle'; ref: AnchorRef; side: HandleSide; smooth: boolean; txn: Txn; moved: boolean }
  | { kind: 'segment'; id: string; si: number; seg: number; t: number; start: Pt; base: DrawDoc; txn: Txn; moved: boolean }
  | { kind: 'corner'; refs: AnchorRef[]; base: DrawDoc; corner: Pt; bisector: Pt; factor: number; txn: Txn; moved: boolean; result: AnchorRef[] }

function gesture(ctx: EditorCtx): DirectGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'direct' ? (g.data as DirectGesture) : null
}

function setGesture(ctx: EditorCtx, data: DirectGesture): void {
  ctx.set({ gesture: { toolId: 'direct', data } })
}

/** Shift: snap a displacement to the nearest multiple of 45°. */
export function constrain45(d: Pt): Pt {
  const len = Math.hypot(d.x, d.y)
  if (len < 1e-9) return d
  const a = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4)
  // Project onto the snapped direction so the pointer stays under the move.
  const ux = Math.cos(a)
  const uy = Math.sin(a)
  const s = d.x * ux + d.y * uy
  return { x: Math.abs(ux) < 1e-12 ? 0 : ux * s, y: Math.abs(uy) < 1e-12 ? 0 : uy * s }
}

/** The editable path whose FILL is under p (direct selection selects inside groups too). */
function pathUnder(ctx: EditorCtx, p: Pt): string | null {
  const s = ctx.get()
  for (const o of editablePaths(s.doc)) {
    const q = toLocal(s.doc, o.id, p)
    const filled = o.fill.type !== 'none' && o.path.subpaths.some((sp) => sp.closed)
    if (hitPath(o.path, q, { filled, strokeWidth: o.stroke?.width ?? 0, slop: 3 / s.zoom })) return o.id
  }
  return null
}

/** Start dragging the current selection (anchors and wholly selected objects). */
function startMove(ctx: EditorCtx, p: Pt, clicked: AnchorRef | null): void {
  const s = ctx.get()
  const refs = partialAnchors(s)
  const objects = editableIds(s.doc, wholeSelection(s))
  const txn = ctx.history.begin('Move anchor points')
  setGesture(ctx, { kind: 'move', start: p, applied: { x: 0, y: 0 }, refs, objects, txn, moved: false, clicked })
}

export function directPointerDown(ctx: EditorCtx, e: ToolPointer): void {
  const s = ctx.get()
  const p = e.p

  // A corner widget of a selected corner.
  const w = cornerWidgetAt(s, p)
  if (w) {
    const refs = selectedAnchors(s).filter((r) => {
      const o = getObject(s.doc, r.id)
      return o?.type === 'path' && cornerInfo(o.path.subpaths[r.si], r.ni)
    })
    const o = getObject(s.doc, w.ref.id)
    const info = o && o.type === 'path' ? cornerInfo(o.path.subpaths[w.ref.si], w.ref.ni) : null
    if (info && refs.length) {
      const factor = 1 / Math.sin(info.angle / 2) - 1
      const txn = ctx.history.begin('Round corners')
      setGesture(ctx, { kind: 'corner', refs, base: s.doc, corner: w.corner, bisector: w.bisector, factor, txn, moved: false, result: refs })
      return
    }
  }

  const hit = anchorHitAt(s, p)
  if (hit?.kind === 'handle') {
    const o = getObject(s.doc, hit.ref.id)
    const node = o && o.type === 'path' ? o.path.subpaths[hit.ref.si].nodes[hit.ref.ni] : null
    const txn = ctx.history.begin('Move handle')
    setGesture(ctx, { kind: 'handle', ref: hit.ref, side: hit.side, smooth: !!node && isSmoothNode(node), txn, moved: false })
    return
  }
  if (hit?.kind === 'anchor') {
    if (e.shiftKey) {
      toggleAnchors(ctx, [hit.ref], 'toggle')
      if (!isAnchorSelected(ctx.get(), hit.ref)) return
    } else if (!isAnchorSelected(s, hit.ref)) selectAnchors(ctx, [hit.ref])
    startMove(ctx, p, e.shiftKey ? null : hit.ref)
    return
  }
  if (hit?.kind === 'segment') {
    const o = getObject(s.doc, hit.id)
    const n = o && o.type === 'path' ? o.path.subpaths[hit.si].nodes.length : 0
    const ends: AnchorRef[] = [
      { id: hit.id, si: hit.si, ni: hit.seg },
      { id: hit.id, si: hit.si, ni: (hit.seg + 1) % n }
    ]
    const both = ends.every((r) => isAnchorSelected(s, r))
    if (e.shiftKey) toggleAnchors(ctx, ends, both ? 'remove' : 'add')
    else if (!both) selectAnchors(ctx, ends)
    if (!ends.every((r) => isAnchorSelected(ctx.get(), r))) return
    if (selectedAnchors(ctx.get()).length === 2 && wholeSelection(ctx.get()).every((id) => id === hit.id)) {
      const txn = ctx.history.begin('Move segment')
      setGesture(ctx, { kind: 'segment', id: hit.id, si: hit.si, seg: hit.seg, t: hit.t, start: p, base: ctx.doc(), txn, moved: false })
    } else startMove(ctx, p, null)
    return
  }

  // Inside a path: the whole path (all its anchors); any other object: itself.
  const inside = pathUnder(ctx, p) ?? ctx.hitTest(p)?.id ?? null
  if (inside) {
    if (e.shiftKey) {
      const sel = s.selection.includes(inside) ? s.selection.filter((id) => id !== inside) : [...s.selection, inside]
      const anchors = { ...s.anchors }
      delete anchors[inside]
      ctx.set({ selection: sel, anchors })
      if (!sel.includes(inside)) return
    } else if (!s.selection.includes(inside) || Object.prototype.hasOwnProperty.call(s.anchors, inside)) {
      ctx.select([inside])
    }
    startMove(ctx, p, null)
    return
  }

  if (!e.shiftKey) ctx.select([])
  setGesture(ctx, { kind: 'marquee', from: p, to: p, additive: e.shiftKey })
}

export function directPointerMove(ctx: EditorCtx, e: ToolPointer): void {
  const d = gesture(ctx)
  if (!d) return
  const p = e.p
  if (d.kind === 'marquee') {
    setGesture(ctx, { ...d, to: p })
    return
  }
  if (d.kind === 'move') {
    let total = { x: p.x - d.start.x, y: p.y - d.start.y }
    if (e.shiftKey) total = constrain45(total)
    const dx = total.x - d.applied.x
    const dy = total.y - d.applied.y
    if (!dx && !dy) return
    let next = moveAnchors(ctx.doc(), d.refs, dx, dy)
    if (d.objects.length) next = moveObjects(next, d.objects, dx, dy)
    d.txn.preview(next)
    setGesture(ctx, { ...d, applied: total, moved: true })
    return
  }
  if (d.kind === 'handle') {
    const anchor = anchorPoint(ctx.doc(), d.ref)
    let q = p
    if (e.shiftKey && anchor) {
      const c = constrain45({ x: p.x - anchor.x, y: p.y - anchor.y })
      q = { x: anchor.x + c.x, y: anchor.y + c.y }
    }
    d.txn.preview(moveHandle(ctx.doc(), d.ref, d.side, q, e.altKey || !d.smooth ? 'free' : 'smooth'))
    setGesture(ctx, { ...d, moved: true })
    return
  }
  if (d.kind === 'segment') {
    let target = p
    if (e.shiftKey) {
      const c = constrain45({ x: p.x - d.start.x, y: p.y - d.start.y })
      target = { x: d.start.x + c.x, y: d.start.y + c.y }
    }
    // Always from the document as it was at pointer-down, so the reshape is exact.
    d.txn.preview(dragSegment(d.base, d.id, d.si, d.seg, d.t, target, d.start))
    setGesture(ctx, { ...d, moved: true })
    return
  }
  // corner widget
  const along = (p.x - d.corner.x) * d.bisector.x + (p.y - d.corner.y) * d.bisector.y
  const r = Math.max(0, along / Math.max(1e-6, d.factor))
  const res = roundAnchorCorners(d.base, d.refs, r)
  d.txn.preview(res.doc)
  setGesture(ctx, { ...d, moved: r > 0, result: res.refs })
  ctx.status(r > 0 ? `Corner radius ${Math.round(r * 10) / 10} px` : null)
}

export function directPointerUp(ctx: EditorCtx, e: ToolPointer): void {
  const d = gesture(ctx)
  if (!d) return
  const s = ctx.get()
  if (d.kind === 'marquee') {
    const box = normBox(d.from, d.to)
    if (box.w <= 2 / s.zoom && box.h <= 2 / s.zoom) return
    const inside: AnchorRef[] = []
    for (const o of editablePaths(s.doc)) {
      o.path.subpaths.forEach((sp, si) =>
        sp.nodes.forEach((_, ni) => {
          const a = anchorPoint(s.doc, { id: o.id, si, ni })!
          if (a.x >= box.x && a.x <= box.x + box.w && a.y >= box.y && a.y <= box.y + box.h) inside.push({ id: o.id, si, ni })
        })
      )
    }
    if (d.additive) toggleAnchors(ctx, inside, 'add')
    else selectAnchors(ctx, inside)
    return
  }
  if (!d.moved) {
    d.txn.cancel()
    // A plain click on one of several selected anchors selects just that one.
    if (d.kind === 'move' && d.clicked && !e.shiftKey && selectedAnchors(s).length > 1) selectAnchors(ctx, [d.clicked])
    if (d.kind === 'corner') ctx.status(null)
    return
  }
  d.txn.commit()
  if (d.kind === 'corner') {
    selectAnchors(ctx, d.result)
    ctx.status(null)
  }
}

const direct: DrawTool = {
  id: 'direct',
  label: 'Direct Selection',
  icon: 'near_me',
  group: 0,
  order: 20,
  key: 'A',
  cursor: 'default',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown: directPointerDown,
  onPointerMove: directPointerMove,
  onPointerUp: directPointerUp,

  Overlay({ state, k }) {
    const g = state.gesture
    const marquee = g && g.toolId === 'direct' && (g.data as DirectGesture).kind === 'marquee' ? (g.data as Extract<DirectGesture, { kind: 'marquee' }>) : null
    // Shown for the Direct Selection tool, and for the pen while ⌘ borrows it.
    if (state.tool !== 'direct' && !marquee) return null
    const b = marquee ? normBox(marquee.from, marquee.to) : null
    return (
      <>
        {state.tool === 'direct' && <AnchorOverlay state={state} k={k} widgets />}
        {b && <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(109,93,252,0.12)" stroke="#6d5dfc" strokeWidth={k} strokeDasharray={`${3 * k} ${3 * k}`} />}
      </>
    )
  }
}

export default direct
