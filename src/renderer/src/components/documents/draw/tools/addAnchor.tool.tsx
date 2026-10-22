// Add Anchor Point (+): click a segment of any path to add an anchor there.
// The shape does not change (the segment is split exactly). Alt switches to
// Delete Anchor Point for the click.

import { addAnchor, getObject, removeAnchorsJoined } from '@shared/draw/ops'
import type { DrawTool, EditorCtx, ToolPointer } from '../editor/types'
import { anchorHitAt, selectAnchors } from '../editor/anchorSelection'
import { AnchorOverlay } from './anchorOverlay'

export function addAnchorAt(ctx: EditorCtx, e: ToolPointer): boolean {
  const s = ctx.get()
  const hit = anchorHitAt(s, e.p, { handles: false, anchors: false })
  if (hit?.kind !== 'segment') return false
  const r = addAnchor(s.doc, hit.id, hit.si, hit.seg, hit.t)
  if (!r.ref) return false
  ctx.history.commit(r.doc, 'Add anchor point')
  selectAnchors(ctx, [r.ref])
  return true
}

export function deleteAnchorAt(ctx: EditorCtx, e: ToolPointer): boolean {
  const s = ctx.get()
  const hit = anchorHitAt(s, e.p, { handles: false, segments: false })
  if (hit?.kind !== 'anchor') return false
  ctx.history.commit(removeAnchorsJoined(s.doc, [hit.ref]), 'Delete anchor point')
  if (getObject(ctx.doc(), hit.ref.id)) selectAnchors(ctx, [], { keepEmpty: [hit.ref.id] })
  else ctx.select([])
  return true
}

const addAnchorTool: DrawTool = {
  id: 'addAnchor',
  label: 'Add Anchor Point',
  icon: 'add_circle',
  group: 1,
  order: 32,
  flyout: 'pen',
  key: '+',
  cursor: 'copy',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown(ctx, e) {
    if (e.altKey) deleteAnchorAt(ctx, e)
    else addAnchorAt(ctx, e)
  },
  Overlay({ state, k }) {
    return state.tool === 'addAnchor' ? <AnchorOverlay state={state} k={k} /> : null
  }
}

export default addAnchorTool
