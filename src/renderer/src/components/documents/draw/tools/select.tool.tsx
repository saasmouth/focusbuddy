// Select (V): click to select, Shift-click to add or remove, drag to move
// (Shift constrains to an axis; edges snap; Alt held at the drop makes it a
// COPY and leaves the original exactly where it was), drag a handle to
// scale (Shift keeps the aspect, Alt scales from the centre; Scale Strokes &
// Effects and Scale Corners apply), drag the knob above the box to rotate
// (Shift snaps to 15°), drag on empty canvas for a marquee. Double-click a text
// object to type into it. Enter, or a double-click on the tool, opens Move….
// Moves, scales and turns are remembered for Transform Again (⌘D). With the
// Align panel set to "key object", clicking one of the selected objects makes
// it the key object.
//
// On a read-only drawing it only selects (click or marquee): nothing moves.

import type { Box, Matrix, Pt } from '@shared/drawGeometry'
import { rotateAbout } from '@shared/drawGeometry'
import { boxToBox, translation, type RefPoint } from '@shared/draw/geometry/transform'
import type { DrawDoc } from '@shared/draw/model'
import { editableIds, moveObjects, nodesWorldBounds } from '@shared/draw/ops'
import { marqueeInScope } from '../editor/isolation'
import type { DrawTool, EditorCtx, Txn } from '../editor/types'
import { activeKey, alignState } from '../commands/align.commands'
import { altDragDuplicate, relabelLastStep } from '../editor/clipboard'
import { openTransformDialog } from '../commands/transform.commands'
import { planMatrix, recordTransform } from '../transform/apply'
import { angleTo, handleAt, normBox, resizeBox, selectionBox, snapDelta, type HandleId } from './helpers'

/** The handle opposite the one dragged: the point a handle scale is anchored at. */
const OPPOSITE: Record<HandleId, RefPoint> = { nw: 'br', n: 'b', ne: 'bl', e: 'l', se: 'tl', s: 't', sw: 'tr', w: 'r' }

type SelectGesture =
  | { kind: 'marquee'; from: Pt; to: Pt; additive: boolean }
  | { kind: 'move'; start: Pt; last: Pt; ids: string[]; moved: boolean; txn: Txn }
  | { kind: 'scale'; handle: HandleId; startBox: Box; ids: string[]; txn: Txn; before: DrawDoc; m: Matrix | null; ref: RefPoint }
  | { kind: 'rotate'; center: Pt; start: number; total: number; ids: string[]; txn: Txn; before: DrawDoc }

function gesture(ctx: EditorCtx): SelectGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'select' ? (g.data as SelectGesture) : null
}

function setGesture(ctx: EditorCtx, data: SelectGesture): void {
  ctx.set({ gesture: { toolId: 'select', data } })
}

/** The marquee: everything at the current level (the isolated group's members in isolation mode) whose visible bounds touch the box. */
function marqueeHits(ctx: EditorCtx, box: Box): string[] {
  return marqueeInScope(ctx.get(), box)
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
      setGesture(ctx, { kind: 'rotate', center, start: angleTo(center, p), total: 0, ids: [...s.selection], txn, before: s.doc })
      return
    }
    if (handle && selBox) {
      const txn = ctx.history.begin('Scale')
      setGesture(ctx, { kind: 'scale', handle: handle as HandleId, startBox: selBox, ids: [...s.selection], txn, before: s.doc, m: null, ref: OPPOSITE[handle as HandleId] })
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
      // Alt (Option) held when the drag ends duplicates instead (see onPointerUp).
      const txn = ctx.history.begin(e.altKey ? 'Duplicate' : 'Move')
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
      const box = selectionBox(ctx.doc(), d.ids)
      if (!box) return
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
      // Always from the drawing as it was, so a long drag never accumulates error.
      const next = resizeBox(d.startBox, d.handle, p, e.shiftKey, e.altKey)
      const ref: RefPoint = e.altKey ? 'c' : OPPOSITE[d.handle]
      const m = boxToBox(d.startBox, next, ref)
      // Scale Strokes & Effects and Scale Corners apply, as in Illustrator.
      const plan = planMatrix(ctx, m, false, d.before)
      d.txn.preview(plan.doc)
      setGesture(ctx, { ...d, m, ref })
      return
    }
    // rotate
    let total = angleTo(d.center, p) - d.start
    if (e.shiftKey) total = Math.round(total / 15) * 15
    const m = rotateAbout(d.center.x, d.center.y, total)
    d.txn.preview(planMatrix(ctx, m, false, d.before).doc)
    setGesture(ctx, { ...d, total })
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
      const hit = ctx.hitTest(e.p)
      // Aligning to a key object: clicking one of the selected objects makes it the key.
      if (hit && !e.shiftKey && s.selection.length > 1 && s.selection.includes(hit.id) && alignState(s).to === 'key') {
        ctx.run('object.alignKey', hit.id)
        return
      }
      // A click with no movement collapses a multi-selection to the item clicked.
      if (hit && !e.shiftKey && s.selection.length > 1) ctx.select([hit.id])
      if (hit && hit.type === 'text' && e.detail >= 2 && !s.readOnly) ctx.set({ editingText: hit.id })
      return
    }
    if (d.kind === 'move' && e.altKey) {
      // Alt-drag duplicate (Illustrator): the originals stay put and copies land
      // where the drag ended, each directly above its original. The step's
      // "before" (recorded at pointer-down) restores the originals exactly.
      const dx = d.last.x - d.start.x
      const dy = d.last.y - d.start.y
      const before = ctx.get().past.at(-1)?.doc
      const dup = altDragDuplicate(ctx.doc(), d.ids, dx, dy, before)
      d.txn.preview(dup.doc)
      d.txn.commit()
      relabelLastStep(ctx, 'Duplicate')
      ctx.select(dup.newIds)
      // Transform Again (⌘D) repeats it: another copy, moved as far again.
      recordTransform(ctx, { kind: 'matrix', label: 'Move', m: translation(dx, dy), origin: { kind: 'absolute' }, copy: true })
      return
    }
    d.txn.commit()
    // Remember it for Transform Again.
    if (d.kind === 'move') {
      // Alt was let go mid-drag: a plain move after all.
      relabelLastStep(ctx, 'Move')
      const dx = d.last.x - d.start.x
      const dy = d.last.y - d.start.y
      if (dx || dy) recordTransform(ctx, { kind: 'matrix', label: 'Move', m: translation(dx, dy), origin: { kind: 'absolute' }, copy: false })
    } else if (d.kind === 'scale' && d.m) {
      recordTransform(ctx, { kind: 'matrix', label: 'Scale', m: [d.m[0], 0, 0, d.m[3], 0, 0], origin: { kind: 'ref', ref: d.ref }, copy: false })
    } else if (d.kind === 'rotate' && d.total) {
      const r = rotateAbout(0, 0, d.total)
      recordTransform(ctx, { kind: 'matrix', label: 'Rotate', m: r, origin: { kind: 'ref', ref: 'c' }, copy: false })
    }
  },

  onOptions(ctx) {
    openTransformDialog(ctx, 'move')
  },

  Overlay({ state, k }) {
    // The Align panel's key object, outlined in bold (whatever tool is active).
    const key = activeKey(state)
    const keyBox = key ? nodesWorldBounds(state.doc, [key]) : null
    const keyMark = keyBox ? (
      <rect x={keyBox.x} y={keyBox.y} width={keyBox.w} height={keyBox.h} fill="none" stroke="#6d5dfc" strokeWidth={3 * k} data-testid="draw-align-key" />
    ) : null
    const g = state.gesture
    if (!g || g.toolId !== 'select') return keyMark
    const d = g.data as SelectGesture
    if (d.kind !== 'marquee') return keyMark
    const b = normBox(d.from, d.to)
    return (
      <>
        {keyMark}
        <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(109,93,252,0.12)" stroke="#6d5dfc" strokeWidth={k} strokeDasharray={`${3 * k} ${3 * k}`} />
      </>
    )
  }
}

export default select
