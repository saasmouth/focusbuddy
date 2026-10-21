// Paint bucket (G): flood-fill an area of a paint layer with the current colour.

import type { DrawTool } from '../editor/types'
import { currentSolidColor } from './helpers'
import { paintTarget } from './paintTool'

const bucket: DrawTool = {
  id: 'bucket',
  label: 'Paint bucket',
  icon: 'format_color_fill',
  group: 4,
  order: 140,
  key: 'G',
  cursor: 'crosshair',
  paint: true,

  onPointerDown(ctx, e) {
    const layerId = paintTarget(ctx)
    if (!layerId) return
    if (ctx.raster.floodFill(layerId, e.p, currentSolidColor(ctx), 0.12)) ctx.commitRaster(layerId)
    else ctx.status('That area is already this colour.')
  }
}

export default bucket
