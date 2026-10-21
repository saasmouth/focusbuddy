// Knife: drag a freehand line through filled shapes to cut them into pieces
// along it. Alt draws a straight cut (Alt+Shift at 45° steps). With objects
// selected only they are cut; with nothing selected every editable shape the
// line crosses is. A line that does not go all the way through cuts nothing.

import type { Pt } from '@shared/drawGeometry'
import { knifeCut } from '@shared/draw/ops'
import type { DrawTool, EditorCtx } from '../editor/types'
import { editablePaths } from '../editor/anchorSelection'
import { constrain45 } from './direct.tool'

interface KnifeGesture {
  points: Pt[]
  straight: boolean
}

function gesture(ctx: EditorCtx): KnifeGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'knife' ? (g.data as KnifeGesture) : null
}

const knife: DrawTool = {
  id: 'knife',
  label: 'Knife',
  icon: 'carpenter',
  group: 1,
  order: 37,
  cursor: 'crosshair',
  overlayOrder: 45,
  onPointerDown(ctx, e) {
    ctx.set({ gesture: { toolId: 'knife', data: { points: [e.p], straight: e.altKey } satisfies KnifeGesture } })
  },
  onPointerMove(ctx, e) {
    const d = gesture(ctx)
    if (!d) return
    if (d.straight || e.altKey) {
      const a = d.points[0]
      const v = e.shiftKey ? constrain45({ x: e.p.x - a.x, y: e.p.y - a.y }) : { x: e.p.x - a.x, y: e.p.y - a.y }
      ctx.set({ gesture: { toolId: 'knife', data: { points: [a, { x: a.x + v.x, y: a.y + v.y }], straight: true } } })
      return
    }
    ctx.set({ gesture: { toolId: 'knife', data: { ...d, points: [...d.points, e.p] } } })
  },
  onPointerUp(ctx) {
    const d = gesture(ctx)
    if (!d || d.points.length < 2) return
    const s = ctx.get()
    const ids = s.selection.length ? s.selection : editablePaths(s.doc).map((o) => o.id)
    const { doc, ids: pieces } = knifeCut(s.doc, ids, d.points)
    if (doc === s.doc || !pieces.length) {
      ctx.status('Nothing was cut: the knife has to pass right through a filled, closed shape.')
      return
    }
    ctx.history.commit(doc, 'Knife')
    ctx.select(pieces)
  },
  Overlay({ state, k }) {
    const g = state.gesture
    const d = g && g.toolId === 'knife' ? (g.data as KnifeGesture) : null
    if (!d) return null
    return <polyline points={d.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#ef4444" strokeWidth={1.5 * k} data-testid="draw-knife-line" />
  }
}

export default knife
