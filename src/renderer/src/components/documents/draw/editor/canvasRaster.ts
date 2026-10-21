// The real RasterService: paint layers are <canvas> elements the studio
// mounts, and an in-progress brush stroke lives on one scratch canvas until
// pointer-up (see raster.ts for why strokes are composited once).

import * as raster from '../raster'
import type { BrushSettings, StrokePoint } from '../brushes'
import type { Pt } from '@shared/drawGeometry'
import type { RasterService } from './types'

export interface CanvasRasterRefs {
  /** Mounted paint-layer canvases by layer id. */
  canvases: Map<string, HTMLCanvasElement>
  /** What each canvas currently shows (its source data URL), so a re-render never reloads mid-stroke. */
  loaded: Map<string, string>
  /** The scratch surface for the stroke in progress. */
  scratch: { current: HTMLCanvasElement | null }
  /** The artboard's pixel size. */
  size(): { w: number; h: number }
}

export function createCanvasRaster(refs: CanvasRasterRefs): RasterService {
  /** The scratch surface, sized to the artboard. Created once, reused per stroke. */
  function ensureScratch(): HTMLCanvasElement {
    const { w, h } = refs.size()
    let c = refs.scratch.current
    if (!c || c.width !== w || c.height !== h) {
      c = raster.createCanvas(w, h)
      refs.scratch.current = c
    }
    return c
  }

  return {
    hasSurface: (layerId) => refs.canvases.has(layerId),
    floodFill(layerId, p: Pt, color, tolerance) {
      const canvas = refs.canvases.get(layerId)
      return canvas ? raster.floodFill(canvas, p.x, p.y, color, tolerance) : false
    },
    beginStroke(p: StrokePoint, brush: BrushSettings) {
      const scratch = ensureScratch()
      raster.clearCanvas(scratch)
      raster.paintDot(raster.context(scratch), p, brush)
    },
    strokeTo(from, to, brush) {
      const scratch = refs.scratch.current
      if (!scratch) return
      raster.paintSegment(raster.context(scratch), from, to, brush)
    },
    endStroke(layerId, brush, erase) {
      const scratch = refs.scratch.current
      const canvas = refs.canvases.get(layerId)
      if (!scratch || !canvas) return false
      raster.compositeStroke(canvas, scratch, brush.opacity, brush.blend, erase)
      raster.clearCanvas(scratch)
      return true
    },
    sample(layerId, p) {
      const canvas = refs.canvases.get(layerId)
      return canvas ? raster.samplePixel(canvas, p.x, p.y) : null
    },
    snapshot(layerId) {
      const canvas = refs.canvases.get(layerId)
      if (!canvas) return ''
      const src = raster.canvasToDataUrl(canvas)
      refs.loaded.set(layerId, src)
      return src
    },
    invalidate() {
      // The canvases must be repainted from the restored document, or the
      // pixels on screen would still show an undone stroke.
      refs.loaded.clear()
    }
  }
}
