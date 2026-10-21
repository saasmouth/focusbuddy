// Edit points (A): drag an anchor (its handles come with it) or a bezier handle
// (its partner mirrors; hold Alt to break the pair). Clicking elsewhere
// selects the path under the pointer. Editing a live shape's point detaches it
// into a plain path (see editAnchor).

import type { Pt } from '@shared/drawGeometry'
import { pathToSvgD } from '@shared/drawGeometry'
import { editAnchor, getObject } from '@shared/draw/ops'
import type { DrawTool, EditorCtx, Txn } from '../editor/types'
import { hitNodeAt } from './helpers'

interface NodeGesture {
  id: string
  si: number
  ni: number
  part: 'anchor' | 'in' | 'out'
  txn: Txn
}

function gesture(ctx: EditorCtx): NodeGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'node' ? (g.data as NodeGesture) : null
}

const node: DrawTool = {
  id: 'node',
  label: 'Edit points',
  icon: 'polyline',
  group: 0,
  order: 20,
  key: 'A',
  cursor: 'default',
  overlayOrder: 50,

  onPointerDown(ctx, e) {
    const s = ctx.get()
    const hit = hitNodeAt(s.doc, s.selection, e.p, s.zoom)
    if (hit) {
      // One undo step per point drag. (It used to open none, so its previews
      // joined the step before it and one undo took back both.)
      const txn = ctx.history.begin('Edit point')
      ctx.set({ gesture: { toolId: 'node', data: { ...hit, txn } satisfies NodeGesture } })
      return
    }
    const obj = ctx.hitTest(e.p)
    ctx.select(obj ? [obj.id] : [])
  },

  onPointerMove(ctx, e) {
    const d = gesture(ctx)
    if (!d) return
    const p: Pt = e.p
    // Alt breaks the handle pair. Editing a live shape's node detaches it
    // into a plain path, so a later Corner or Points change cannot regenerate
    // the outline and throw this edit away.
    d.txn.preview(editAnchor(ctx.doc(), d.id, d.si, d.ni, d.part, p, e.altKey))
  },

  onPointerUp(ctx) {
    gesture(ctx)?.txn.commit()
  },

  Overlay({ state, k }) {
    if (state.tool !== 'node') return null
    return (
      <>
        {state.selection.map((id) => {
          const o = getObject(state.doc, id)
          if (!o || o.type !== 'path') return null
          return (
            <g key={id}>
              <path d={pathToSvgD(o.path)} fill="none" stroke="#6d5dfc" strokeWidth={k} />
              {o.path.subpaths.flatMap((sp, si) =>
                sp.nodes.map((n, ni) => (
                  <g key={`${si}-${ni}`}>
                    {n.inX != null && (
                      <>
                        <line x1={n.x} y1={n.y} x2={n.inX} y2={n.inY} stroke="#6d5dfc" strokeWidth={k} opacity={0.6} />
                        <circle cx={n.inX} cy={n.inY} r={3 * k} fill="#6d5dfc" />
                      </>
                    )}
                    {n.outX != null && (
                      <>
                        <line x1={n.x} y1={n.y} x2={n.outX} y2={n.outY} stroke="#6d5dfc" strokeWidth={k} opacity={0.6} />
                        <circle cx={n.outX} cy={n.outY} r={3 * k} fill="#6d5dfc" />
                      </>
                    )}
                    <rect x={n.x - 3.5 * k} y={n.y - 3.5 * k} width={7 * k} height={7 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={1.5 * k} />
                  </g>
                ))
              )}
            </g>
          )
        })}
      </>
    )
  }
}

export default node
