// Select (V): click to select, Shift-click to add or remove, drag to move
// (Shift constrains to an axis; edges snap), drag a handle to scale (Shift
// keeps the aspect, Alt scales from the centre), drag the knob above the box to
// rotate (Shift snaps to 15°), drag on empty canvas for a marquee. Double-click
// a text object to type into it.
//
// On a read-only drawing it only selects (click or marquee): nothing moves.

import type { Box, Pt } from '@shared/drawGeometry'
import { rotateAbout } from '@shared/drawGeometry'
import { editableIds, getObjects, mapObjects, moveObjects, nodeBounds, nodesBounds, rotateNode, scaleObjects } from '@shared/draw/ops'
import type { DrawTool, EditorCtx, Txn } from '../editor/types'
import { angleTo, handleAt, normBox, resizeBox, selectionBox, snapDelta, type HandleId } from './helpers'

type SelectGesture =
  | { kind: 'marquee'; from: Pt; to: Pt; additive: boolean }
  | { kind: 'move'; start: Pt; last: Pt; ids: string[]; moved: boolean; txn: Txn }
  | { kind: 'scale'; handle: HandleId; startBox: Box; curBox: Box; ids: string[]; txn: Txn }
  | { kind: 'rotate'; center: Pt; last: number; ids: string[]; txn: Txn }

function gesture(ctx: EditorCtx): SelectGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'select' ? (g.data as SelectGesture) : null
}

function setGesture(ctx: EditorCtx, data: SelectGesture): void {
  ctx.set({ gesture: { toolId: 'select', data } })
}

/** The marquee: everything on a visible, unlocked layer whose visible bounds touch the box. */
function marqueeHits(ctx: EditorCtx, box: Box): string[] {
  const hits: string[] = []
  for (const l of ctx.doc().layers) {
    if (l.kind !== 'vector' || !l.visible || l.locked) continue
    for (const o of l.objects) {
      if (o.hidden || o.locked || o.type === 'opaque') continue
      const ob = nodeBounds(o)
      if (ob.x < box.x + box.w && ob.x + ob.w > box.x && ob.y < box.y + box.h && ob.y + ob.h > box.y) hits.push(o.id)
    }
  }
  return hits
}

const select: DrawTool = {
  id: 'select',
  label: 'Select',
  icon: 'arrow_selector_tool',
  group: 0,
  order: 10,
  key: 'V',
  cursor: 'default',
  readOnlySafe: true,
  overlayOrder: 10,

  onPointerDown(ctx, e) {
    const s = ctx.get()
    const p = e.p
    if (s.readOnly) {
      // Read-only: look and select -- nothing that changes the artwork.
      const hit = ctx.hitTest(p)
      if (hit) {
        ctx.select(e.shiftKey ? [...new Set([...s.selection, hit.id])] : [hit.id])
        return
      }
      if (!e.shiftKey) ctx.select([])
      setGesture(ctx, { kind: 'marquee', from: p, to: p, additive: e.shiftKey })
      return
    }
    const selBox = selectionBox(s.doc, s.selection)
    const handle = selBox ? handleAt(p, selBox, s.zoom) : null
    if (handle === 'rot' && selBox) {
      const center = { x: selBox.x + selBox.w / 2, y: selBox.y + selBox.h / 2 }
      const txn = ctx.history.begin('Rotate')
      setGesture(ctx, { kind: 'rotate', center, last: angleTo(center, p), ids: [...s.selection], txn })
      return
    }
    if (handle && selBox) {
      const txn = ctx.history.begin('Scale')
      setGesture(ctx, { kind: 'scale', handle: handle as HandleId, startBox: selBox, curBox: selBox, ids: [...s.selection], txn })
      return
    }

    const hit = ctx.hitTest(p)
    if (hit) {
      const additive = e.shiftKey
      const ids = additive
        ? s.selection.includes(hit.id)
          ? s.selection.filter((i) => i !== hit.id)
          : [...s.selection, hit.id]
        : s.selection.includes(hit.id)
          ? s.selection
          : [hit.id]
      ctx.select(ids)
      const txn = ctx.history.begin('Move')
      setGesture(ctx, { kind: 'move', start: p, last: p, ids: editableIds(ctx.doc(), ids), moved: false, txn })
      return
    }

    if (!e.shiftKey) ctx.select([])
    setGesture(ctx, { kind: 'marquee', from: p, to: p, additive: e.shiftKey })
  },

  onPointerMove(ctx, e) {
    const d = gesture(ctx)
    if (!d) return
    const p = e.p
    if (d.kind === 'marquee') {
      setGesture(ctx, { ...d, to: p })
      return
    }
    if (d.kind === 'move') {
      const objs = getObjects(ctx.doc(), d.ids)
      if (!objs.length) return
      const box = nodesBounds(objs)
      let dx = p.x - d.last.x
      let dy = p.y - d.last.y
      if (e.shiftKey) {
        // Constrain to the dominant axis, measured from the gesture's origin.
        if (Math.abs(p.x - d.start.x) > Math.abs(p.y - d.start.y)) dy = d.start.y - d.last.y
        else dx = d.start.x - d.last.x
      }
      const snapped = snapDelta(ctx, box, dx, dy, d.ids)
      ctx.set({ guides: snapped.guides })
      d.txn.preview(moveObjects(ctx.doc(), d.ids, snapped.dx, snapped.dy))
      setGesture(ctx, { ...d, last: { x: d.last.x + snapped.dx, y: d.last.y + snapped.dy }, moved: true })
      return
    }
    if (d.kind === 'scale') {
      const next = resizeBox(d.startBox, d.handle, p, e.shiftKey, e.altKey)
      d.txn.preview(scaleObjects(ctx.doc(), d.ids, d.curBox, next))
      setGesture(ctx, { ...d, curBox: next })
      return
    }
    // rotate
    const a = angleTo(d.center, p)
    let delta = a - d.last
    if (e.shiftKey) delta = Math.round(delta / 15) * 15
    if (Math.abs(delta) < 0.01) return
    const m = rotateAbout(d.center.x, d.center.y, delta)
    d.txn.preview(mapObjects(ctx.doc(), d.ids, (o) => rotateNode(o, m, delta)))
    setGesture(ctx, { ...d, last: d.last + delta })
  },

  onPointerUp(ctx, e) {
    const d = gesture(ctx)
    if (!d) return
    const s = ctx.get()
    if (d.kind === 'marquee') {
      const box = normBox(d.from, d.to)
      if (box.w > 2 / s.zoom || box.h > 2 / s.zoom) {
        const hits = marqueeHits(ctx, box)
        ctx.select(d.additive ? [...new Set([...s.selection, ...hits])] : hits)
      }
      return
    }
    if (d.kind === 'move' && !d.moved) {
      // The gesture recorded an undo point on pointer-down but changed nothing,
      // so drop it rather than leaving a no-op step in the history.
      d.txn.cancel()
      // A click with no movement collapses a multi-selection to the item clicked.
      const hit = ctx.hitTest(e.p)
      if (hit && !e.shiftKey && s.selection.length > 1) ctx.select([hit.id])
      if (hit && hit.type === 'text' && e.detail >= 2 && !s.readOnly) ctx.set({ editingText: hit.id })
      return
    }
    d.txn.commit()
  },

  Overlay({ state, k }) {
    const g = state.gesture
    if (!g || g.toolId !== 'select') return null
    const d = g.data as SelectGesture
    if (d.kind !== 'marquee') return null
    const b = normBox(d.from, d.to)
    return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(109,93,252,0.12)" stroke="#6d5dfc" strokeWidth={k} strokeDasharray={`${3 * k} ${3 * k}`} />
  }
}

export default select
