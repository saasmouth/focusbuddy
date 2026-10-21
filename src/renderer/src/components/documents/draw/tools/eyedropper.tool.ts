// Eyedropper (I): pick the solid fill of the object under the pointer, or --
// where there is none -- the colour of the painted pixels there. It sets both
// the fill for the next shape and the brush colour.

import { solid } from '@shared/draw'
import type { DrawTool } from '../editor/types'

const eyedropper: DrawTool = {
  id: 'eyedropper',
  label: 'Eyedropper',
  icon: 'colorize',
  group: 4,
  order: 150,
  key: 'I',
  cursor: 'crosshair',
  paint: true,

  onPointerDown(ctx, e) {
    const p = e.p
    // Prefer a vector object under the cursor; fall back to the painted pixels.
    // The object itself, inside any group or mask (a group has no paint of its own).
    const obj = ctx.hitTestDeep(p)
    if (obj && (obj.type === 'path' || obj.type === 'text') && obj.fill.type === 'solid') {
      const color = obj.fill.color
      ctx.set((s) => ({ fill: solid(color), brush: { ...s.brush, color } }))
      ctx.status(`Picked ${color}`)
      return
    }
    const layers = ctx.doc().layers
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]
      if (l.kind !== 'raster' || !l.visible) continue
      if (!ctx.raster.hasSurface(l.id)) continue
      const hex = ctx.raster.sample(l.id, p)
      if (hex) {
        ctx.set((s) => ({ fill: solid(hex), brush: { ...s.brush, color: hex } }))
        ctx.status(`Picked ${hex}`)
        return
      }
    }
    ctx.status('Nothing to pick there — that spot is empty.')
  }
}

export default eyedropper
