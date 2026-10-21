// Scissors (C): click a segment or an anchor of any path to cut it there. An
// open path falls into two; a closed path opens at the cut. The two new ends
// are left selected, ready to drag apart.

import { anchorPoint, cutPathAt, getObject, type AnchorRef } from '@shared/draw/ops'
import type { DrawTool } from '../editor/types'
import { anchorHitAt, selectAnchors } from '../editor/anchorSelection'
import { AnchorOverlay } from './anchorOverlay'

const scissors: DrawTool = {
  id: 'scissors',
  label: 'Scissors',
  icon: 'content_cut',
  group: 1,
  order: 36,
  key: 'C',
  cursor: 'crosshair',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown(ctx, e) {
    const s = ctx.get()
    const hit = anchorHitAt(s, e.p, { handles: false })
    if (!hit || hit.kind === 'handle') return
    const cut = hit.kind === 'anchor' ? { id: hit.ref.id, si: hit.ref.si, seg: hit.ref.ni, t: 0 } : { id: hit.id, si: hit.si, seg: hit.seg, t: hit.t }
    const { doc, ids } = cutPathAt(s.doc, cut.id, [{ si: cut.si, seg: cut.seg, t: cut.t }])
    if (doc === s.doc) {
      ctx.status('Nothing to cut there: that is already the end of an open path.')
      return
    }
    ctx.history.commit(doc, 'Scissors')
    // Select the new ends at the cut.
    const ends: AnchorRef[] = []
    for (const id of ids) {
      const o = getObject(doc, id)
      if (!o || o.type !== 'path') continue
      o.path.subpaths.forEach((sp, si) => {
        for (const ni of [0, sp.nodes.length - 1]) {
          const a = anchorPoint(doc, { id, si, ni })
          if (a && Math.hypot(a.x - hit.at.x, a.y - hit.at.y) < 0.5) ends.push({ id, si, ni })
        }
      })
    }
    selectAnchors(ctx, ends, { keepEmpty: ids })
  },
  Overlay({ state, k }) {
    return state.tool === 'scissors' ? <AnchorOverlay state={state} k={k} /> : null
  }
}

export default scissors
