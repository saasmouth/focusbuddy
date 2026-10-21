// The brush and the eraser share one stroke: built at full strength on a
// scratch surface and laid onto the paint layer once, on release, at the
// stroke's opacity -- so a half-opacity stroke is even rather than blotchy
// where its own stamps overlap. One undo step per stroke.

import type { DrawTool, EditorCtx, ToolPointer } from '../editor/types'
import { activeRasterLayerId, ensurePaintLayer } from './helpers'

interface PaintGesture {
  layerId: string
  last: { x: number; y: number; pressure: number }
  erase: boolean
}

/**
 * The layer a paint gesture works on. A paint tool with nowhere to paint used
 * to do nothing but flash a status line that was easy to miss -- which read,
 * correctly, as "the brush is broken". It now creates (or switches to) the
 * paint layer it needs and says so; the stroke starts on the next gesture,
 * because a layer made this instant has no mounted surface yet.
 */
export function paintTarget(ctx: EditorCtx): string | null {
  let layerId = activeRasterLayerId(ctx)
  if (!layerId) {
    layerId = ensurePaintLayer(ctx)
    if (!layerId) return null
    ctx.status('Added a paint layer for you — draw away.')
    return null
  }
  if (!ctx.raster.hasSurface(layerId)) {
    ctx.status('That paint layer is not ready yet — try the stroke again.')
    return null
  }
  return layerId
}

export function strokeTool(spec: { id: string; label: string; icon: string; key: string; order: number; erase: boolean }): DrawTool {
  const { id, erase } = spec
  return {
    id,
    label: spec.label,
    icon: spec.icon,
    group: 4,
    order: spec.order,
    key: spec.key,
    cursor: 'crosshair',
    paint: true,

    onPointerDown(ctx, e: ToolPointer) {
      const layerId = paintTarget(ctx)
      if (!layerId) return
      const pressure = e.pressure > 0 ? e.pressure : 0.5
      ctx.raster.beginStroke({ x: e.p.x, y: e.p.y, pressure }, ctx.get().brush)
      ctx.set({ scratchVisible: true, gesture: { toolId: id, data: { layerId, last: { x: e.p.x, y: e.p.y, pressure }, erase } satisfies PaintGesture } })
    },

    onPointerMove(ctx, e) {
      const g = ctx.get().gesture
      if (!g || g.toolId !== id) return
      const d = g.data as PaintGesture
      const pressure = e.pressure > 0 ? e.pressure : 0.5
      const next = { x: e.p.x, y: e.p.y, pressure }
      ctx.raster.strokeTo(d.last, next, ctx.get().brush)
      // Mutated in place, as the stroke always was: a pointer move must not
      // re-render the whole editor just to remember where the brush is.
      d.last = next
    },

    onPointerUp(ctx) {
      const g = ctx.get().gesture
      if (!g || g.toolId !== id) return
      const d = g.data as PaintGesture
      if (ctx.raster.endStroke(d.layerId, ctx.get().brush, d.erase)) ctx.commitRaster(d.layerId)
      ctx.set({ scratchVisible: false })
    }
  }
}
