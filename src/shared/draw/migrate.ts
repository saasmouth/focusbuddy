// v1 <-> v2.
//
// v1ToV2 is total: every v1 body has a v2 form that renders byte-for-byte the
// same SVG (tests/unit/drawMigrate.test.ts holds the corpus that proves it).
// v2ToV1 is partial: it exists so that, until the guard release has been out
// long enough, a v2-capable app can keep WRITING v1 for every drawing that
// uses nothing v1 lacks -- and it refuses, rather than guesses, for one that
// does. Both are pure restructures: no validation (that is normalize's job),
// and an object that needs no change is passed through by reference, so the
// structural sharing undo relies on survives a round trip.

import type {
  DrawBody,
  DrawImageObject,
  DrawLayer,
  DrawObject,
  DrawPaint,
  DrawRasterLayer,
  DrawStroke,
  DrawVectorLayer
} from '../draw'
import { putAsset } from './assets'
import type {
  DrawArtboard,
  DrawAsset,
  DrawDoc,
  DrawDocLayer,
  DrawDocPaint,
  DrawDocStroke,
  DrawImageNode,
  DrawNode
} from './model'

/**
 * A copy of `o` with key `from` replaced IN PLACE by `to` (or dropped when
 * `value` is undefined). Key order is kept, so a round trip writes the same
 * JSON text, not merely an equal object.
 */
function swapKey<T extends object>(o: T, from: string, to: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === from) {
      if (value !== undefined) out[to] = value
    } else out[k] = v
  }
  if (!(from in o) && value !== undefined) out[to] = value
  return out
}

/** The id and name v1's single page gets as an artboard. Fixed, so migration is deterministic. */
export const V1_ARTBOARD_ID = 'artboard-1'
export const V1_ARTBOARD_NAME = 'Artboard 1'

// ── v1 -> v2 ─────────────────────────────────────────────────────────────────

/**
 * A v1 body as a v2 document.
 *
 *   width/height/background -> artboards[0] at (0, 0)
 *   image src, raster src    -> an asset id, bytes moved to doc.assets
 *   dpi                      -> settings.dpi
 *
 * Nothing else changes meaning. Objects that hold no inline bytes are the
 * SAME objects (by reference) in the result.
 */
export function v1ToV2(b: DrawBody): DrawDoc {
  let assets: Record<string, DrawAsset> = {}
  const layers: DrawDocLayer[] = b.layers.map((l: DrawLayer): DrawDocLayer => {
    if (l.kind === 'raster') {
      if (!l.src) return swapKey(l, 'src', 'assetId', undefined) as unknown as DrawDocLayer
      const put = putAsset(assets, l.src)
      assets = put.assets
      return swapKey(l, 'src', 'assetId', put.id) as unknown as DrawDocLayer
    }
    let changed = false
    const objects = l.objects.map((o): DrawNode => {
      if (o.type !== 'image') return o as DrawNode
      changed = true
      const put = putAsset(assets, o.src)
      assets = put.assets
      return swapKey(o, 'src', 'assetId', put.id) as unknown as DrawImageNode
    })
    return changed ? { ...l, objects } : (l as unknown as DrawDocLayer)
  })
  const board: DrawArtboard = { id: V1_ARTBOARD_ID, name: V1_ARTBOARD_NAME, x: 0, y: 0, w: b.width, h: b.height, background: b.background as DrawDocPaint }
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [board],
    activeArtboardId: V1_ARTBOARD_ID,
    layers,
    ...(b.activeLayerId !== undefined ? { activeLayerId: b.activeLayerId } : {}),
    assets,
    swatches: [],
    guides: [],
    settings: typeof b.dpi === 'number' ? { dpi: b.dpi } : {}
  }
}

// ── v2 -> v1 ─────────────────────────────────────────────────────────────────

/** The fields each kind of v1 object can hold; anything else on a v2 node cannot be written as v1. */
const V1_FIELDS: Record<string, readonly string[]> = {
  path: ['id', 'type', 'name', 'opacity', 'blend', 'locked', 'hidden', 'path', 'fill', 'stroke', 'shapeKind', 'cornerRadius', 'sides', 'innerRatio'],
  text: ['id', 'type', 'name', 'opacity', 'blend', 'locked', 'hidden', 'x', 'y', 'w', 'text', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'align', 'lineHeight', 'letterSpacing', 'fill', 'stroke', 'rotation', 'lines'],
  image: ['id', 'type', 'name', 'opacity', 'blend', 'locked', 'hidden', 'x', 'y', 'w', 'h', 'assetId', 'alt', 'rotation'],
  widget: ['id', 'type', 'name', 'opacity', 'blend', 'locked', 'hidden', 'x', 'y', 'w', 'h', 'widgetId', 'rotation'],
  opaque: ['id', 'type', 'originalType', 'raw', 'name', 'opacity', 'blend', 'locked', 'hidden']
}
const V1_LAYER_FIELDS = ['id', 'kind', 'name', 'visible', 'locked', 'opacity', 'blend', 'objects', 'assetId']
const V1_DOC_FIELDS = ['schemaVersion', 'minWriterVersion', 'artboards', 'activeArtboardId', 'layers', 'activeLayerId', 'assets', 'swatches', 'guides', 'settings']

function v1Paint(p: DrawDocPaint | undefined): boolean {
  if (!p) return true
  if (p.type === 'swatch') return false
  if (p.type === 'linear') return p.from === undefined && p.to === undefined
  if (p.type === 'radial') return p.center === undefined && p.radius === undefined && p.focal === undefined
  return true
}

function v1Stroke(s: DrawDocStroke | undefined): boolean {
  return !s || v1Paint(s.paint)
}

/** Why a v2 document cannot be written as v1, or null when it can. */
export function v1Obstacle(doc: DrawDoc): string | null {
  for (const k of Object.keys(doc)) if (!V1_DOC_FIELDS.includes(k)) return `document field "${k}"`
  if (doc.artboards.length !== 1) return `${doc.artboards.length} artboards`
  const a = doc.artboards[0]
  if (a.x !== 0 || a.y !== 0) return 'an artboard that is not at the origin'
  if (a.id !== V1_ARTBOARD_ID || a.name !== V1_ARTBOARD_NAME || a.presetId !== undefined) return 'a named artboard'
  if (!v1Paint(a.background)) return 'an artboard background v1 cannot draw'
  if (doc.activeArtboardId !== undefined && doc.activeArtboardId !== V1_ARTBOARD_ID) return 'an active artboard'
  if (doc.swatches.length) return 'swatches'
  if (doc.guides.length) return 'guides'
  for (const k of Object.keys(doc.settings)) if (k !== 'dpi') return `the "${k}" setting`
  if (doc.minWriterVersion > 2) return 'a newer writer requirement'
  for (const l of doc.layers) {
    for (const k of Object.keys(l)) if (!V1_LAYER_FIELDS.includes(k)) return `layer field "${k}"`
    if (l.kind === 'raster') {
      if (l.assetId !== undefined && !doc.assets[l.assetId]) return 'a paint layer whose pixels are missing'
      continue
    }
    for (const o of l.objects) {
      const allowed = V1_FIELDS[o.type]
      if (!allowed) return `a ${o.type}`
      for (const k of Object.keys(o)) if (!allowed.includes(k)) return `${o.type} field "${k}"`
      if (o.type === 'path' && (!v1Paint(o.fill) || !v1Stroke(o.stroke))) return 'a paint v1 cannot draw'
      if (o.type === 'text' && (!v1Paint(o.fill) || !v1Stroke(o.stroke))) return 'a paint v1 cannot draw'
      if (o.type === 'image' && !doc.assets[o.assetId]) return 'an image whose bytes are missing'
    }
  }
  return null
}

export function isV1Representable(doc: DrawDoc): boolean {
  return v1Obstacle(doc) === null
}

/**
 * A v2 document as a v1 body -- for writing while v2 writes are gated off.
 * Throws when the document uses anything v1 cannot hold (see v1Obstacle):
 * silently dropping it would be exactly the data loss the guard exists for.
 */
export function v2ToV1(doc: DrawDoc): DrawBody {
  const why = v1Obstacle(doc)
  if (why) throw new Error(`This drawing cannot be saved in the older format: it has ${why}.`)
  const a = doc.artboards[0]
  const layers: DrawLayer[] = doc.layers.map((l): DrawLayer => {
    if (l.kind === 'raster') {
      return swapKey(l, 'assetId', 'src', l.assetId ? doc.assets[l.assetId].dataUrl : '') as unknown as DrawRasterLayer
    }
    let changed = false
    const objects = l.objects.map((o): DrawObject => {
      if (o.type !== 'image') return o as unknown as DrawObject
      changed = true
      return swapKey(o, 'assetId', 'src', doc.assets[o.assetId].dataUrl) as unknown as DrawImageObject
    })
    return changed ? ({ ...l, objects } as DrawVectorLayer) : (l as unknown as DrawVectorLayer)
  })
  return {
    schemaVersion: 1,
    width: a.w,
    height: a.h,
    background: a.background as DrawPaint,
    layers,
    ...(doc.activeLayerId !== undefined ? { activeLayerId: doc.activeLayerId } : {}),
    ...(typeof doc.settings.dpi === 'number' ? { dpi: doc.settings.dpi } : {})
  }
}

/** The v1 stroke type is the v2 one minus swatch paints; exported for the barrels. */
export type V1Stroke = DrawStroke
