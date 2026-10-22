// Pencil (N): draw freehand; on release the stroke is simplified (RDP) and
// smoothed into a bezier path (Catmull-Rom handles).

import { drawId, solid } from '@shared/draw'
import { docPaintToCss } from '@shared/draw/svg'
import { simplifyPolyline, smoothPathFromPoints, type Pt } from '@shared/drawGeometry'
import type { DrawPathNode } from '@shared/draw/model'
import { addObject, targetLayerId } from '@shared/draw/ops'
import type { DrawTool } from '../editor/types'
import { currentSolidColor } from './helpers'

interface PencilGesture {
  points: Pt[]
}

const pencil: DrawTool = {
  id: 'pencil',
  label: 'Pencil',
  icon: 'gesture',
  group: 1,
  order: 40,
  flyout: 'pencil',
  key: 'N',
  cursor: 'crosshair',
  overlayOrder: 30,

  onPointerDown(ctx, e) {
    ctx.set({ gesture: { toolId: 'pencil', data: { points: [e.p] } satisfies PencilGesture } })
  },

  onPointerMove(ctx, e) {
    const g = ctx.get().gesture
    if (!g || g.toolId !== 'pencil') return
    const d = g.data as PencilGesture
    ctx.set({ gesture: { toolId: 'pencil', data: { points: [...d.points, e.p] } } })
  },

  onPointerUp(ctx) {
    const s = ctx.get()
    const g = s.gesture
    if (!g || g.toolId !== 'pencil') return
    const pts = simplifyPolyline((g.data as PencilGesture).points, 1.6 / s.zoom)
    if (pts.length < 2) return
    const obj: DrawPathNode = {
      id: drawId('obj'),
      type: 'path',
      shapeKind: 'pencil',
      path: smoothPathFromPoints(pts, false),
      fill: { type: 'none' },
      stroke: s.stroke ?? { paint: solid(currentSolidColor(ctx)), width: 2, cap: 'round', join: 'round' }
    }
    const doc = ctx.doc()
    ctx.history.commit(addObject(doc, obj, targetLayerId(doc)), 'Pencil')
    ctx.select([obj.id])
  },

  Overlay({ state }) {
    const g = state.gesture
    if (!g || g.toolId !== 'pencil') return null
    const d = g.data as PencilGesture
    return (
      <polyline
        points={d.points.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke={state.stroke ? docPaintToCss(state.doc, state.stroke.paint) : '#1c1917'}
        strokeWidth={state.stroke?.width ?? 2}
      />
    )
  }
}

export default pencil
