// Lasso (Q): draw around anchors to select them (on any path). Shift adds to
// the selection, Alt takes away from it.

import type { Pt } from '@shared/drawGeometry'
import { pointInRings } from '@shared/drawGeometry'
import { anchorPoint, type AnchorRef } from '@shared/draw/ops'
import type { DrawTool, EditorCtx } from '../editor/types'
import { editablePaths, selectAnchors, toggleAnchors } from '../editor/anchorSelection'
import { AnchorOverlay } from './anchorOverlay'

interface LassoGesture {
  points: Pt[]
  mode: 'replace' | 'add' | 'remove'
}

function gesture(ctx: EditorCtx): LassoGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'lasso' ? (g.data as LassoGesture) : null
}

const lasso: DrawTool = {
  id: 'lasso',
  label: 'Lasso',
  icon: 'lasso_select',
  group: 0,
  order: 22,
  key: 'Q',
  cursor: 'crosshair',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown(ctx, e) {
    ctx.set({ gesture: { toolId: 'lasso', data: { points: [e.p], mode: e.shiftKey ? 'add' : e.altKey ? 'remove' : 'replace' } satisfies LassoGesture } })
  },
  onPointerMove(ctx, e) {
    const d = gesture(ctx)
    if (d) ctx.set({ gesture: { toolId: 'lasso', data: { ...d, points: [...d.points, e.p] } } })
  },
  onPointerUp(ctx) {
    const d = gesture(ctx)
    if (!d) return
    const s = ctx.get()
    if (d.points.length < 3) {
      if (d.mode === 'replace') ctx.select([])
      return
    }
    const inside: AnchorRef[] = []
    for (const o of editablePaths(s.doc)) {
      o.path.subpaths.forEach((sp, si) =>
        sp.nodes.forEach((_, ni) => {
          const a = anchorPoint(s.doc, { id: o.id, si, ni })
          if (a && pointInRings([d.points], a, 'evenodd')) inside.push({ id: o.id, si, ni })
        })
      )
    }
    if (d.mode === 'replace') selectAnchors(ctx, inside)
    else toggleAnchors(ctx, inside, d.mode)
  },
  Overlay({ state, k }) {
    if (state.tool !== 'lasso') return null
    const g = state.gesture
    const d = g && g.toolId === 'lasso' ? (g.data as LassoGesture) : null
    return (
      <>
        <AnchorOverlay state={state} k={k} />
        {d && <polygon points={d.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(109,93,252,0.10)" stroke="#6d5dfc" strokeWidth={k} strokeDasharray={`${3 * k} ${3 * k}`} />}
      </>
    )
  }
}

export default lasso
