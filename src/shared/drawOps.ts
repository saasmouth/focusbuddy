// PlexiDraw operations on a v1 body -- a compatibility barrel.
//
// Every edit with real logic in it is implemented ONCE, on the v2 document
// model, in src/shared/draw/ops/*. The functions here keep the v1 signatures
// (DrawBody in, DrawBody out) by migrating to v2, running the v2 operation and
// writing the result back as v1. That keeps every existing caller and test
// working unchanged -- and makes each of those tests a test of the v2
// operation AND of a lossless v1 -> v2 -> v1 round trip.
//
// Queries, and the generic helpers whose whole point is handing a caller v1
// objects or v1 layers (getObject, mapObjects, addObject, addLayer,
// patchLayer), stay native.

import { activeLayer, drawId, type DrawBody, type DrawLayer, type DrawObject, type DrawVectorLayer } from './draw'
import type { BooleanOp, Box, Pt } from './drawGeometry'
import { putAsset } from './draw/assets'
import { v1ToV2, v2ToV1 } from './draw/migrate'
import type { DrawDoc } from './draw/model'
import * as ops from './draw/ops'

export type { AlignEdge, ArrangeDir, ArtboardAnchor, NodePart } from './draw/ops'
export { ARTBOARD_ANCHORS, artboardResizeOffset } from './draw/ops'

/** Run a v2 operation on a v1 body. An operation that changed nothing returns the SAME body. */
function viaV2(body: DrawBody, fn: (doc: DrawDoc) => DrawDoc): DrawBody {
  const doc = v1ToV2(body)
  const out = fn(doc)
  return out === doc ? body : v2ToV1(out)
}

function vectorLayers(body: DrawBody): DrawVectorLayer[] {
  return body.layers.filter((l): l is DrawVectorLayer => l.kind === 'vector')
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** The layer an object lives on, or undefined when the id is unknown. */
export function layerOf(body: DrawBody, objectId: string): DrawVectorLayer | undefined {
  return vectorLayers(body).find((l) => l.objects.some((o) => o.id === objectId))
}

export function getObject(body: DrawBody, objectId: string): DrawObject | undefined {
  for (const l of vectorLayers(body)) {
    const o = l.objects.find((x) => x.id === objectId)
    if (o) return o
  }
  return undefined
}

export function getObjects(body: DrawBody, ids: string[]): DrawObject[] {
  const wanted = new Set(ids)
  const out: DrawObject[] = []
  for (const l of vectorLayers(body)) for (const o of l.objects) if (wanted.has(o.id)) out.push(o)
  return out
}

/**
 * Objects the user may actually act on: not hidden, not locked, on an editable
 * layer -- and not an opaque object a newer app made.
 */
export function editableIds(body: DrawBody, ids: string[]): string[] {
  return ops.editableIds(v1ToV2(body), ids)
}

/** The layer new work should land on, guaranteed to exist. */
export function targetLayerId(body: DrawBody): string {
  return activeLayer(body)?.id ?? body.layers[body.layers.length - 1].id
}

// ── Object lifecycle ─────────────────────────────────────────────────────────

/**
 * Add an object to a layer. A raster (or missing, or locked) target falls back
 * to the topmost editable vector layer, and if there is none a fresh layer is
 * made -- so a draw gesture can never silently go nowhere.
 */
export function addObject(body: DrawBody, obj: DrawObject, layerId?: string): DrawBody {
  const target =
    body.layers.find((l): l is DrawVectorLayer => l.id === layerId && l.kind === 'vector' && !l.locked) ??
    [...vectorLayers(body)].reverse().find((l) => !l.locked)
  if (!target) {
    const fresh: DrawVectorLayer = {
      id: drawId('lyr'),
      kind: 'vector',
      name: `Layer ${body.layers.length + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      blend: 'normal',
      objects: [obj]
    }
    return { ...body, layers: [...body.layers, fresh], activeLayerId: fresh.id }
  }
  return {
    ...body,
    activeLayerId: target.id,
    layers: body.layers.map((l) => (l.id === target.id ? { ...target, objects: [...target.objects, obj] } : l))
  }
}

export function mapObject(body: DrawBody, id: string, fn: (o: DrawObject) => DrawObject): DrawBody {
  return {
    ...body,
    layers: body.layers.map((l) =>
      l.kind === 'vector' && l.objects.some((o) => o.id === id) ? { ...l, objects: l.objects.map((o) => (o.id === id ? fn(o) : o)) } : l
    )
  }
}

export function mapObjects(body: DrawBody, ids: string[], fn: (o: DrawObject) => DrawObject): DrawBody {
  const wanted = new Set(ids)
  return {
    ...body,
    layers: body.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: l.objects.map((o) => (wanted.has(o.id) ? fn(o) : o)) } : l))
  }
}

export function deleteObjects(body: DrawBody, ids: string[]): DrawBody {
  return viaV2(body, (d) => ops.deleteObjects(d, ids))
}

export function duplicateObjects(body: DrawBody, ids: string[], dx = 12, dy = 12): { body: DrawBody; newIds: string[] } {
  let newIds: string[] = []
  const out = viaV2(body, (d) => {
    const r = ops.duplicateObjects(d, ids, dx, dy)
    newIds = r.newIds
    return r.doc
  })
  return { body: out, newIds }
}

export function moveObjects(body: DrawBody, ids: string[], dx: number, dy: number): DrawBody {
  return viaV2(body, (d) => ops.moveObjects(d, ids, dx, dy))
}

/**
 * Scale a set of objects so the box they occupy becomes `to`. Used by the
 * selection handles, so a multi-object selection resizes as one unit exactly
 * the way a single object does.
 */
export function scaleObjects(body: DrawBody, ids: string[], from: Box, to: Box): DrawBody {
  return viaV2(body, (d) => ops.scaleObjects(d, ids, from, to))
}

// ── Z-order, align, distribute ───────────────────────────────────────────────

export function arrange(body: DrawBody, ids: string[], dir: ops.ArrangeDir): DrawBody {
  return viaV2(body, (d) => ops.arrange(d, ids, dir))
}

/**
 * Align to the selection's own bounding box -- or, with a single object
 * selected, to the artboard. Locked and hidden objects never move.
 */
export function alignObjects(body: DrawBody, ids: string[], edge: ops.AlignEdge): DrawBody {
  return viaV2(body, (d) => ops.alignObjects(d, ids, edge))
}

/** Even gaps between three or more objects along one axis. */
export function distributeObjects(body: DrawBody, ids: string[], axis: 'h' | 'v'): DrawBody {
  return viaV2(body, (d) => ops.distributeObjects(d, ids, axis))
}

// ── Booleans & path ops ──────────────────────────────────────────────────────

/** Combine two or more selected paths; the result takes the bottom-most operand's look. */
export function booleanObjects(body: DrawBody, ids: string[], op: BooleanOp): { body: DrawBody; newId: string | null } {
  let newId: string | null = null
  const out = viaV2(body, (d) => {
    const r = ops.booleanObjects(d, ids, op)
    newId = r.newId
    return r.doc
  })
  return { body: out, newId }
}

/** Reverse every subpath's direction -- flips which side a hole cuts from. */
export function reversePath(body: DrawBody, id: string): DrawBody {
  return viaV2(body, (d) => ops.reversePath(d, id))
}

export function setPathClosed(body: DrawBody, id: string, closed: boolean): DrawBody {
  return viaV2(body, (d) => ops.setPathClosed(d, id, closed))
}

/** Merge several paths into one multi-subpath object, without a boolean. */
export function joinPaths(body: DrawBody, ids: string[]): { body: DrawBody; newId: string | null } {
  let newId: string | null = null
  const out = viaV2(body, (d) => {
    const r = ops.joinPaths(d, ids)
    newId = r.newId
    return r.doc
  })
  return { body: out, newId }
}

/** Resize one live shape's geometry from its parameters (radius, points...). */
export function reshape(body: DrawBody, id: string, patch: { cornerRadius?: number; sides?: number; innerRatio?: number }): DrawBody {
  return viaV2(body, (d) => ops.reshape(d, id, patch))
}

/**
 * Drag one anchor or handle of a path; editing a live shape's anchor detaches
 * it into a plain path (see editAnchor in draw/ops/path.ts).
 */
export function moveNode(body: DrawBody, id: string, si: number, ni: number, part: ops.NodePart, p: Pt, breakPair = false): DrawBody {
  return viaV2(body, (d) => ops.editAnchor(d, id, si, ni, part, p, breakPair))
}

// ── Artboard ─────────────────────────────────────────────────────────────────

/**
 * Resize the artboard pinned at `anchor`; vector art moves by the anchor
 * offset and paint layers take the re-laid pixels in `rasterSrc` (see
 * raster.reframeRaster).
 */
export function resizeArtboard(body: DrawBody, w: number, h: number, anchor: ops.ArtboardAnchor = 'nw', rasterSrc: Record<string, string> = {}): DrawBody {
  return viaV2(body, (d) => {
    let assets = d.assets
    const ids: Record<string, string | undefined> = {}
    for (const [layerId, src] of Object.entries(rasterSrc)) {
      if (!src) {
        ids[layerId] = undefined
        continue
      }
      const put = putAsset(assets, src)
      assets = put.assets
      ids[layerId] = put.id
    }
    return ops.resizeArtboard(d, w, h, anchor, ids, assets)
  })
}

// ── Layers ───────────────────────────────────────────────────────────────────

export function addLayer(body: DrawBody, layer: DrawLayer, aboveLayerId?: string): DrawBody {
  const at = aboveLayerId ? body.layers.findIndex((l) => l.id === aboveLayerId) : body.layers.length - 1
  const layers = body.layers.slice()
  layers.splice(at + 1, 0, layer)
  return { ...body, layers, activeLayerId: layer.id }
}

/** Remove a layer. The last remaining layer is never removed -- there must always be somewhere to draw. */
export function removeLayer(body: DrawBody, id: string): DrawBody {
  return viaV2(body, (d) => ops.removeLayer(d, id))
}

export function moveLayer(body: DrawBody, id: string, delta: number): DrawBody {
  return viaV2(body, (d) => ops.moveLayer(d, id, delta))
}

export function patchLayer(body: DrawBody, id: string, patch: Partial<Omit<DrawLayer, 'kind' | 'id'>>): DrawBody {
  return { ...body, layers: body.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as DrawLayer) : l)) }
}

export function duplicateLayer(body: DrawBody, id: string): DrawBody {
  return viaV2(body, (d) => ops.duplicateLayer(d, id))
}

/**
 * Merge a vector layer into the vector layer below it. Raster merges need real
 * pixels and therefore a canvas, so they are done in the editor and are not
 * attempted here -- this returns the body unchanged rather than pretending.
 */
export function mergeVectorLayerDown(body: DrawBody, id: string): DrawBody {
  return viaV2(body, (d) => ops.mergeVectorLayerDown(d, id))
}
