// The pasteboard: the grey canvas around the artboards (4.3.41).
//
// Illustrator's canvas is a fixed 227 × 227 inch square (16383 pt) with the
// artboards in it; art may sit anywhere on it. PlexiiDraw's pasteboard is a
// square of the same size, centred on the artboards, and it always grows to
// take in every artboard, every object and every paint layer, wherever they
// are -- so scrolling and panning reach everything, and nothing in a drawing
// can be stranded off the canvas. Art outside every artboard stays in the
// drawing and is left out of export, as in Illustrator.

import type { Box } from '../../drawGeometry'
import type { DrawDoc } from '../model'
import { artboardsBounds, rasterLayerFrame } from './artboards'
import { isMeasurable, nodeBounds } from './geometry'

/** Illustrator's canvas side: 16383 pt, about 227.5 inches at 72 ppi. */
export const PASTEBOARD_SIDE = 16383

/**
 * The pasteboard's centre is snapped to this grid, so moving an artboard a
 * little does not shift the whole canvas (the studio keeps the view still
 * when it does shift).
 */
export const PASTEBOARD_SNAP = 512

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

const finite = (b: Box): boolean => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w >= 0 && b.h >= 0

/** Everything the drawing holds, in document space: every object (hidden and locked too) and every paint layer. Null when there is nothing. */
export function contentBounds(doc: DrawDoc): Box | null {
  let b: Box | null = null
  for (const l of doc.layers) {
    if (l.kind === 'raster') {
      if (!l.assetId) continue
      const f = rasterLayerFrame(doc, l)
      b = b ? union(b, f) : f
      continue
    }
    for (const o of l.objects) {
      if (!isMeasurable(o)) continue
      const ob = nodeBounds(o)
      if (!finite(ob)) continue
      b = b ? union(b, ob) : ob
    }
  }
  return b
}

/**
 * The pasteboard in document space: a PASTEBOARD_SIDE square centred (on the
 * snap grid) on the artboards, grown to take in all artboards and content.
 * Whole units, so the stage sits on whole screen pixels at 100%.
 */
export function pasteboardBounds(doc: DrawDoc): Box {
  const boards = artboardsBounds(doc)
  const cx = Math.round((boards.x + boards.w / 2) / PASTEBOARD_SNAP) * PASTEBOARD_SNAP
  const cy = Math.round((boards.y + boards.h / 2) / PASTEBOARD_SNAP) * PASTEBOARD_SNAP
  const half = Math.ceil(PASTEBOARD_SIDE / 2)
  let b: Box = { x: cx - half, y: cy - half, w: 2 * half, h: 2 * half }
  b = union(b, boards)
  const c = contentBounds(doc)
  if (c) b = union(b, c)
  const x = Math.floor(b.x)
  const y = Math.floor(b.y)
  return { x, y, w: Math.ceil(b.x + b.w) - x, h: Math.ceil(b.y + b.h) - y }
}
