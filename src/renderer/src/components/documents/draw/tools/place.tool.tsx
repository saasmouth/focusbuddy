// The Place cursor (File › Place, ⇧⌘P): not a toolbox tool -- the "loaded
// graphics" cursor Illustrator switches to after you choose files. Click to
// place the next file at its actual size, drag to place it into a box at its
// own proportions. See editor/place.ts.

import { drawId } from '@shared/draw'
import type { Pt } from '@shared/drawGeometry'
import { placeNext, placeRect } from '../editor/place'
import type { DrawTool } from '../editor/types'

interface PlaceGesture {
  from: Pt
  to: Pt
}

const place: DrawTool = {
  id: 'place',
  label: 'Place',
  icon: 'add_photo_alternate',
  group: 9,
  order: 900,
  hidden: true,
  cursor: 'copy',
  overlayOrder: 30,

  onPointerDown(ctx, e) {
    if (!ctx.get().placing?.items.length) {
      ctx.setTool('select')
      return
    }
    ctx.set({ gesture: { toolId: 'place', data: { from: e.p, to: e.p } satisfies PlaceGesture } })
  },

  onPointerMove(ctx, e) {
    const g = ctx.get().gesture
    if (!g || g.toolId !== 'place') return
    ctx.set({ gesture: { toolId: 'place', data: { ...(g.data as PlaceGesture), to: e.p } } })
  },

  onPointerUp(ctx, e) {
    const s = ctx.get()
    const g = s.gesture
    const item = s.placing?.items[0]
    if (!g || g.toolId !== 'place' || !item) return
    const d = g.data as PlaceGesture
    placeNext(ctx, placeRect(item, d.from, e.p), drawId)
  },

  Overlay({ state, k }) {
    if (state.tool !== 'place') return null
    const item = state.placing?.items[0]
    if (!item) return null
    const g = state.gesture?.toolId === 'place' ? (state.gesture.data as PlaceGesture) : null
    const at = g ? g.from : state.cursorPt
    if (!at) return null
    const r = placeRect(item, at, g ? g.to : null)
    const n = state.placing!.items.length
    return (
      <g data-testid="draw-place-preview" pointerEvents="none">
        {item.preview && <image href={item.preview} x={r.x} y={r.y} width={r.w} height={r.h} preserveAspectRatio="none" opacity={0.6} />}
        <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="#6d5dfc" strokeWidth={k} strokeDasharray={`${4 * k} ${3 * k}`} />
        {n > 1 && (
          <g transform={`translate(${at.x + 10 * k} ${at.y - 10 * k}) scale(${k})`}>
            <rect x={0} y={-12} width={22} height={16} rx={4} fill="#6d5dfc" />
            <text x={11} y={0} fontSize={11} textAnchor="middle" fill="#ffffff">
              {n}
            </text>
          </g>
        )}
      </g>
    )
  }
}

export default place
