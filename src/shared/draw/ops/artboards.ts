// Artboards on a v2 document. Phase 0 edits the first artboard only (the v1
// page); WP-ARTBOARD adds the tool, the panel and multi-artboard operations
// here.

import type { DrawArtboard, DrawDoc, DrawDocLayer } from '../model'
import { translateNode } from './geometry'

/** The artboard the editor treats as "the page": the active one, else the first. */
export function primaryArtboard(doc: DrawDoc): DrawArtboard {
  return (doc.activeArtboardId ? doc.artboards.find((a) => a.id === doc.activeArtboardId) : undefined) ?? doc.artboards[0]
}

/** Where the existing artwork stays pinned when the artboard changes size. */
export type ArtboardAnchor = 'nw' | 'n' | 'ne' | 'w' | 'c' | 'e' | 'sw' | 's' | 'se'

export const ARTBOARD_ANCHORS: ArtboardAnchor[] = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se']

/** How far the artwork moves when the artboard goes from `from` to `to` pinned at `anchor`. */
export function artboardResizeOffset(from: { w: number; h: number }, to: { w: number; h: number }, anchor: ArtboardAnchor): { dx: number; dy: number } {
  const fx = anchor.includes('w') ? 0 : anchor.includes('e') ? 1 : 0.5
  const fy = anchor.startsWith('n') ? 0 : anchor.startsWith('s') ? 1 : 0.5
  return { dx: Math.round((to.w - from.w) * fx), dy: Math.round((to.h - from.h) * fy) }
}

/**
 * Resize the primary artboard, moving every vector node by the anchor offset
 * (locked and hidden ones too: the page moves under the art). Paint layers
 * take the re-laid pixels the editor hands in as asset ids in `rasterAssets`
 * (re-laying them needs a canvas, so the editor does it -- see
 * raster.reframeRaster); the new bytes must already be in `assets`.
 */
export function resizeArtboard(
  doc: DrawDoc,
  w: number,
  h: number,
  anchor: ArtboardAnchor = 'nw',
  rasterAssets: Record<string, string | undefined> = {},
  assets: DrawDoc['assets'] = doc.assets
): DrawDoc {
  const board = primaryArtboard(doc)
  const { dx, dy } = artboardResizeOffset({ w: board.w, h: board.h }, { w, h }, anchor)
  const layers = doc.layers.map((l): DrawDocLayer => {
    if (l.kind === 'raster') {
      if (!Object.prototype.hasOwnProperty.call(rasterAssets, l.id)) return l
      const assetId = rasterAssets[l.id]
      const { assetId: _old, ...rest } = l
      void _old
      return assetId ? { ...rest, assetId } : rest
    }
    if (!dx && !dy) return l
    return { ...l, objects: l.objects.map((o) => translateNode(o, dx, dy)) }
  })
  return { ...doc, assets, artboards: doc.artboards.map((a) => (a.id === board.id ? { ...a, w, h } : a)), layers }
}

/** Set the primary artboard's background paint. */
export function setArtboardBackground(doc: DrawDoc, background: DrawArtboard['background']): DrawDoc {
  const board = primaryArtboard(doc)
  return { ...doc, artboards: doc.artboards.map((a) => (a.id === board.id ? { ...a, background } : a)) }
}
