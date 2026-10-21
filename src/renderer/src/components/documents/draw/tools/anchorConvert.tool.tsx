// Anchor Point (⇧C), as in Illustrator: click a smooth anchor to make it a
// corner (its handles retract); drag from an anchor to pull out a fresh,
// mirrored pair of handles (a smooth point); drag a handle to move it on its
// own (the pair breaks); drag a segment to bend it. The Pen does the same
// while Alt is held over an anchor of a selected path.

import type { Pt } from '@shared/drawGeometry'
import type { HandleSide } from '@shared/draw/geometry/pathEdit'
import type { DrawDoc } from '@shared/draw/model'
import { convertAnchors, dragSegment, getObject, moveHandle, setPathNode, type AnchorRef } from '@shared/draw/ops'
import type { DrawTool, EditorCtx, ToolPointer, Txn } from '../editor/types'
import { anchorHitAt, selectAnchors } from '../editor/anchorSelection'
import { AnchorOverlay } from './anchorOverlay'

type ConvertGesture =
  | { kind: 'pull'; ref: AnchorRef; base: DrawDoc; txn: Txn; moved: boolean; hadHandles: boolean }
  | { kind: 'handle'; ref: AnchorRef; side: HandleSide; txn: Txn; moved: boolean }
  | { kind: 'segment'; id: string; si: number; seg: number; t: number; start: Pt; base: DrawDoc; txn: Txn; moved: boolean }

function gesture(ctx: EditorCtx): ConvertGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'anchorConvert' ? (g.data as ConvertGesture) : null
}

export function convertPointerDown(ctx: EditorCtx, e: ToolPointer): void {
  const s = ctx.get()
  const hit = anchorHitAt(s, e.p)
  if (!hit) return
  if (hit.kind === 'handle') {
    const txn = ctx.history.begin('Move handle')
    ctx.set({ gesture: { toolId: 'anchorConvert', data: { kind: 'handle', ref: hit.ref, side: hit.side, txn, moved: false } satisfies ConvertGesture } })
    return
  }
  if (hit.kind === 'anchor') {
    const o = getObject(s.doc, hit.ref.id)
    const n = o && o.type === 'path' ? o.path.subpaths[hit.ref.si].nodes[hit.ref.ni] : null
    if (!n) return
    if (!s.selection.includes(hit.ref.id)) selectAnchors(ctx, [hit.ref])
    // The drag starts from a bare corner: the new handles replace any old ones.
    const base = setPathNode(ctx.doc(), hit.ref, { x: n.x, y: n.y })
    const txn = ctx.history.begin('Convert anchor point')
    ctx.set({ gesture: { toolId: 'anchorConvert', data: { kind: 'pull', ref: hit.ref, base, txn, moved: false, hadHandles: n.inX != null || n.outX != null } satisfies ConvertGesture } })
    return
  }
  const txn = ctx.history.begin('Bend segment')
  ctx.set({ gesture: { toolId: 'anchorConvert', data: { kind: 'segment', id: hit.id, si: hit.si, seg: hit.seg, t: hit.t, start: e.p, base: ctx.doc(), txn, moved: false } satisfies ConvertGesture } })
}

function onMove(ctx: EditorCtx, e: ToolPointer): void {
  const d = gesture(ctx)
  if (!d) return
  if (d.kind === 'pull') {
    d.txn.preview(moveHandle(d.base, d.ref, 'out', e.p, 'mirror'))
  } else if (d.kind === 'handle') {
    d.txn.preview(moveHandle(ctx.doc(), d.ref, d.side, e.p, 'free'))
  } else {
    d.txn.preview(dragSegment(d.base, d.id, d.si, d.seg, d.t, e.p, d.start, true))
  }
  ctx.set({ gesture: { toolId: 'anchorConvert', data: { ...d, moved: true } } })
}

function onUp(ctx: EditorCtx): void {
  const d = gesture(ctx)
  if (!d) return
  if (d.moved) {
    d.txn.commit()
    return
  }
  d.txn.cancel()
  // A click on an anchor with handles: smooth -> corner.
  if (d.kind === 'pull' && d.hadHandles) ctx.history.commit(convertAnchors(ctx.doc(), [d.ref], 'corner'), 'Convert anchor point')
}

const anchorConvert: DrawTool = {
  id: 'anchorConvert',
  label: 'Anchor Point',
  icon: 'conversion_path',
  group: 1,
  order: 34,
  shortcutLabel: '⇧C',
  cursor: 'default',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown: convertPointerDown,
  onPointerMove: onMove,
  onPointerUp: onUp,
  Overlay({ state, k }) {
    return state.tool === 'anchorConvert' ? <AnchorOverlay state={state} k={k} /> : null
  }
}

export default anchorConvert
