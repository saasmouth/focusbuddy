// The six shape tools share one gesture: drag a box (Shift for a square or a
// circle), release to commit a LIVE shape that keeps its parameters (corner
// radius, sides, inset) for the inspector. Each tool is its own file built
// from this factory.

import { drawId, shapePath, solid, type DrawShapeKind } from '@shared/draw'
import { docPaintToCss } from '@shared/draw/svg'
import { fitPathToBox, pathToSvgD, type Pt } from '@shared/drawGeometry'
import type { DrawPathNode } from '@shared/draw/model'
import { addObject, targetLayerId } from '@shared/draw/ops'
import type { DrawTool } from '../editor/types'
import { normBox, squareOff } from './helpers'

interface ShapeGesture {
  shapeKind: DrawShapeKind
  from: Pt
  to: Pt
}

export function shapeTool(spec: { id: string; kind: DrawShapeKind; label: string; icon: string; key?: string; order: number; undoLabel: string }): DrawTool {
  const { id, kind } = spec
  return {
    id,
    label: spec.label,
    icon: spec.icon,
    group: 2,
    order: spec.order,
    key: spec.key,
    flyout: 'shapes',
    cursor: 'crosshair',
    overlayOrder: 20,

    onPointerDown(ctx, e) {
      ctx.set({ gesture: { toolId: id, data: { shapeKind: kind, from: e.p, to: e.p } satisfies ShapeGesture } })
    },

    onPointerMove(ctx, e) {
      const g = ctx.get().gesture
      if (!g || g.toolId !== id) return
      const d = g.data as ShapeGesture
      ctx.set({ gesture: { toolId: id, data: { ...d, to: e.shiftKey ? squareOff(d.from, e.p) : e.p } } })
    },

    onPointerUp(ctx) {
      const s = ctx.get()
      const g = s.gesture
      if (!g || g.toolId !== id) return
      const d = g.data as ShapeGesture
      const box = normBox(d.from, d.to)
      const isLine = d.shapeKind === 'line'
      if (!(box.w > 1 || box.h > 1)) return
      const path = isLine ? shapePath('line', { x: d.from.x, y: d.from.y, w: d.to.x - d.from.x, h: d.to.y - d.from.y }) : fitPathToBox(shapePath(d.shapeKind, box), box)
      const obj: DrawPathNode = {
        id: drawId('obj'),
        type: 'path',
        shapeKind: d.shapeKind,
        path,
        fill: isLine ? { type: 'none' } : s.fill,
        stroke: isLine ? (s.stroke ?? { paint: solid('#1c1917'), width: 2, cap: 'round' }) : s.stroke,
        ...(d.shapeKind === 'roundRect' ? { cornerRadius: Math.min(box.w, box.h) * 0.15 } : {}),
        ...(d.shapeKind === 'polygon' ? { sides: 6 } : {}),
        ...(d.shapeKind === 'star' ? { sides: 5, innerRatio: 0.5 } : {})
      }
      const doc = ctx.doc()
      ctx.history.commit(addObject(doc, obj, targetLayerId(doc)), spec.undoLabel)
      ctx.select([obj.id])
      // Back to Select after placing, unless a double-click locked the tool (SPEC §3.2).
      if (ctx.get().toolLocked !== id) ctx.setTool('select')
    },

    Overlay({ state, k }) {
      const g = state.gesture
      if (!g || g.toolId !== id) return null
      const d = g.data as ShapeGesture
      return (
        <path
          d={pathToSvgD(
            d.shapeKind === 'line'
              ? shapePath('line', { x: d.from.x, y: d.from.y, w: d.to.x - d.from.x, h: d.to.y - d.from.y })
              : fitPathToBox(shapePath(d.shapeKind, normBox(d.from, d.to)), normBox(d.from, d.to))
          )}
          fill={d.shapeKind === 'line' ? 'none' : docPaintToCss(state.doc, state.fill)}
          stroke="#6d5dfc"
          strokeWidth={k}
        />
      )
    }
  }
}
