// Landing generated work in a drawing: the vector scene onto its own new
// layer, a generated picture onto a paint layer.
//
// Both go through PlexiiDraw's own ops (addLayer, vectorLayerV2,
// rasterLayerV2, putAsset) rather than building layers by hand, so a change to
// how layers work reaches generated art too. Pure: a document in, a document
// out, every id from the caller's minter, so the editor commits the result as
// ONE history entry and ⌘Z takes the whole generation back.
//
// ITS OWN LAYER, always. Generated art dropped among someone's existing
// objects is work to undo by hand even when the art is good; on its own layer
// it can be hidden, renamed, reordered or deleted as one thing.

import { putAsset } from '../assets'
import { compose, scaling, translation } from '../geometry/transform'
import type { Box, DrawArtboard, DrawDoc, DrawNode } from '../model'
import { applyNodeMatrix } from '../ops/groups'
import { addLayer, rasterLayerV2, vectorLayerV2 } from '../ops/layers'

/** The artboard generated work belongs to: the active one, else the first. */
export function targetArtboard(doc: DrawDoc): DrawArtboard | undefined {
  return doc.artboards.find((a) => a.id === doc.activeArtboardId) ?? doc.artboards[0]
}

/**
 * Centre a scene's nodes on an artboard, shrinking them if they overflow it.
 *
 * The model is told the artboard's size and writes its own coordinate system
 * anyway — often starting at the origin, sometimes drawing at ten times the
 * scale. Rather than refuse good art for sitting in the wrong place, it is
 * moved to the middle of the page, and SHRUNK to fit if it overflows; never
 * enlarged, because blowing up a small drawing to fill a page is a decision
 * the person should make, not a correction.
 *
 * The geometry is Draw's own applyNodeMatrix, so a generated group transforms
 * exactly as a hand-drawn one does.
 */
export function fitNodesToArtboard(nodes: DrawNode[], bounds: Box | null, board: DrawArtboard): DrawNode[] {
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return nodes
  const margin = 0.92
  const factor = Math.min(1, (board.w * margin) / bounds.w, (board.h * margin) / bounds.h)
  const w = bounds.w * factor
  const h = bounds.h * factor
  const dx = board.x + (board.w - w) / 2 - bounds.x * factor
  const dy = board.y + (board.h - h) / 2 - bounds.y * factor
  const m = compose(translation(dx, dy), scaling(factor))
  return nodes.map((n) => applyNodeMatrix(n, m))
}

/** Add generated vector nodes as a new layer above the active one. */
export function addGeneratedVectorLayer(doc: DrawDoc, nodes: DrawNode[], name: string): DrawDoc {
  const layer = { ...vectorLayerV2(name), objects: nodes }
  return addLayer(doc, layer, doc.activeLayerId)
}

/**
 * Add a generated picture as a paint layer over the artboard it was made for.
 *
 * The frame is the artboard's box, because a paint layer FOLLOWS its artboard
 * through that field (4.3.41): without it the pixels would sit at the origin
 * and stay there when the artboard moved.
 */
export function addGeneratedPaintLayer(
  doc: DrawDoc,
  dataUrl: string,
  name: string,
  board: DrawArtboard,
  size?: { w: number; h: number }
): DrawDoc {
  const { assets, id } = putAsset(doc.assets, dataUrl, size)
  const layer = {
    ...rasterLayerV2(name),
    assetId: id,
    frame: { x: board.x, y: board.y, w: board.w, h: board.h }
  }
  return addLayer({ ...doc, assets }, layer, doc.activeLayerId)
}

/**
 * Replace the selected objects with the regenerated ones, in place.
 *
 * The new nodes take the position of the old selection's box, so "make these
 * rounder" does not also move the art across the page, and they land in the
 * same layer at the first replaced object's depth rather than on top of
 * everything.
 */
export function replaceObjects(doc: DrawDoc, replacedIds: string[], nodes: DrawNode[]): DrawDoc {
  const ids = new Set(replacedIds)
  if (!ids.size) return doc
  let done = false
  const layers = doc.layers.map((layer) => {
    if (layer.kind !== 'vector') return layer
    if (!layer.objects.some((o) => ids.has(o.id))) return layer
    const objects: DrawNode[] = []
    for (const o of layer.objects) {
      if (!ids.has(o.id)) {
        objects.push(o)
        continue
      }
      if (!done) {
        objects.push(...nodes)
        done = true
      }
    }
    return { ...layer, objects }
  })
  return { ...doc, layers }
}
