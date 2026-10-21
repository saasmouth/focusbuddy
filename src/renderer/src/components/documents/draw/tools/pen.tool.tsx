// Pen (P): click for a corner, drag for a smooth point (the drag pulls out a
// mirrored pair of handles), click the first point to close the path. Enter,
// Escape or a double-click finishes an open path. The path in progress is not
// in the document (and not on the undo stack) until it is finished.

import { solid } from '@shared/draw'
import { pathToSvgD } from '@shared/drawGeometry'
import { drawId } from '@shared/draw'
import type { DrawPathNode } from '@shared/draw/model'
import { addObject, targetLayerId } from '@shared/draw/ops'
import type { DrawTool, EditorCtx } from '../editor/types'

/** Turn the pen draft into a path object (one undo step), or drop it when it has fewer than two points. */
export function finishPen(ctx: EditorCtx, close: boolean): void {
  const s = ctx.get()
  const nodes = s.pen
  ctx.set({ pen: null })
  if (!nodes || nodes.length < 2) return
  const obj: DrawPathNode = {
    id: drawId('obj'),
    type: 'path',
    shapeKind: 'pen',
    path: { subpaths: [{ closed: close, nodes }] },
    fill: close ? s.fill : { type: 'none' },
    stroke: s.stroke ?? { paint: solid('#1c1917'), width: 2, cap: 'round', join: 'round' }
  }
  const doc = ctx.doc()
  ctx.history.commit(addObject(doc, obj, targetLayerId(doc)), 'Pen')
  ctx.select([obj.id])
}

const pen: DrawTool = {
  id: 'pen',
  label: 'Pen',
  icon: 'draw',
  group: 1,
  order: 30,
  key: 'P',
  cursor: 'crosshair',
  overlayOrder: 40,

  onPointerDown(ctx, e) {
    const s = ctx.get()
    const p = e.p
    const nodes = s.pen ?? []
    // Clicking the first node closes the path.
    if (nodes.length >= 2 && Math.hypot(nodes[0].x - p.x, nodes[0].y - p.y) < 8 / s.zoom) {
      finishPen(ctx, true)
      return
    }
    const next = [...nodes, { x: p.x, y: p.y }]
    ctx.set({ pen: next, gesture: { toolId: 'pen', data: { index: next.length - 1 } } })
  },

  onPointerMove(ctx, e) {
    const s = ctx.get()
    const nodes = s.pen
    const g = s.gesture
    if (!nodes || !g || g.toolId !== 'pen') return
    const { index } = g.data as { index: number }
    const n = nodes[index]
    const p = e.p
    // Dragging after placing a node pulls a symmetric pair of handles out of
    // it, which is exactly how a bezier pen behaves everywhere.
    const next = nodes.slice()
    next[index] = { ...n, outX: p.x, outY: p.y, inX: 2 * n.x - p.x, inY: 2 * n.y - p.y }
    ctx.set({ pen: next })
  },

  // Nothing to commit on pointer-up: the point is already in the draft.

  Overlay({ state, k }) {
    const penNodes = state.pen
    if (!penNodes || penNodes.length === 0) return null
    const cursorPt = state.cursorPt
    return (
      <g>
        <path d={pathToSvgD({ subpaths: [{ closed: false, nodes: penNodes }] })} fill="none" stroke="#6d5dfc" strokeWidth={1.5 * k} />
        {cursorPt && (
          <line
            x1={penNodes[penNodes.length - 1].x}
            y1={penNodes[penNodes.length - 1].y}
            x2={cursorPt.x}
            y2={cursorPt.y}
            stroke="#6d5dfc"
            strokeWidth={k}
            strokeDasharray={`${3 * k} ${3 * k}`}
          />
        )}
        {penNodes.map((n, i) => (
          <rect key={i} x={n.x - 3 * k} y={n.y - 3 * k} width={6 * k} height={6 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={k} />
        ))}
      </g>
    )
  }
}

export default pen
