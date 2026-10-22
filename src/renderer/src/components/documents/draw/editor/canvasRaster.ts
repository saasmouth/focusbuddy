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
  /** A paint layer's frame in document space (its pixels' size and where they lie); the default frame without an id. */
  frame(layerId?: string): { x: number; y: number; w: number; h: number }
}

export function createCanvasRaster(refs: CanvasRasterRefs): RasterService {
  /** The frame of the stroke in progress: scratch pixels are in that layer's own coordinates. */
  let strokeOrigin = { x: 0, y: 0 }

  /** The scratch surface, sized to the layer being painted. Created once, reused per stroke. */
  function ensureScratch(layerId?: string): HTMLCanvasElement {
    const f = refs.frame(layerId)
    strokeOrigin = { x: f.x, y: f.y }
    let c = refs.scratch.current
    if (!c || c.width !== f.w || c.height !== f.h) {
      c = raster.createCanvas(f.w, f.h)
      refs.scratch.current = c
    }
    return c
  }

  /** A document point in a layer's own pixel coordinates. */
  const local = <P extends Pt>(layerId: string, p: P): P => {
    const f = refs.frame(layerId)
    return { ...p, x: p.x - f.x, y: p.y - f.y }
  }
  const inStroke = <P extends Pt>(p: P): P => ({ ...p, x: p.x - strokeOrigin.x, y: p.y - strokeOrigin.y })

  return {
    hasSurface: (layerId) => refs.canvases.has(layerId),
    floodFill(layerId, p: Pt, color, tolerance) {
      const canvas = refs.canvases.get(layerId)
      const q = local(layerId, p)
      return canvas ? raster.floodFill(canvas, q.x, q.y, color, tolerance) : false
    },
    beginStroke(p: StrokePoint, brush: BrushSettings, layerId?: string) {
      const scratch = ensureScratch(layerId)
      raster.clearCanvas(scratch)
      raster.paintDot(raster.context(scratch), inStroke(p), brush)
    },
    strokeTo(from, to, brush) {
      const scratch = refs.scratch.current
      if (!scratch) return
      raster.paintSegment(raster.context(scratch), inStroke(from), inStroke(to), brush)
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
      const q = local(layerId, p)
      return canvas ? raster.samplePixel(canvas, q.x, q.y) : null
    },
    snapshot(layerId) {
      const canvas = refs.canvases.get(layerId)
      if (!canvas) return ''
      const src = raster.canvasToDataUrl(canvas)
      refs.loaded.set(layerId, src)
      // What the studio's loader compares against: these pixels, at this size, are on screen.
      canvas.dataset.loadedSize = `${canvas.width}x${canvas.height}`
      return src
    },
    invalidate() {
      // The canvases must be repainted from the restored document, or the
      // pixels on screen would still show an undone stroke.
      refs.loaded.clear()
    },
    reframe: (src, from, to, dx, dy) => raster.reframeRaster(src, from, to, dx, dy)
  }
}
