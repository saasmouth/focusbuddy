// Layers on a v2 document.

import { drawId } from '../../draw'
import type { DrawBlend, DrawDoc, DrawDocLayer, DrawDocRasterLayer, DrawDocVectorLayer, DrawNode } from '../model'

export function vectorLayerV2(name: string): DrawDocVectorLayer {
  return { id: drawId('lyr'), kind: 'vector', name, visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] }
}

export function rasterLayerV2(name: string): DrawDocRasterLayer {
  return { id: drawId('lyr'), kind: 'raster', name, visible: true, locked: false, opacity: 1, blend: 'normal' }
}

export function findLayer(doc: DrawDoc, id: string | undefined): DrawDocLayer | undefined {
  return id ? doc.layers.find((l) => l.id === id) : undefined
}

export function activeLayer(doc: DrawDoc): DrawDocLayer | undefined {
  return findLayer(doc, doc.activeLayerId) ?? doc.layers[doc.layers.length - 1]
}

/** The layer new work should land on, guaranteed to exist. */
export function targetLayerId(doc: DrawDoc): string {
  return activeLayer(doc)?.id ?? doc.layers[doc.layers.length - 1].id
}

export function addLayer(doc: DrawDoc, layer: DrawDocLayer, aboveLayerId?: string): DrawDoc {
  const at = aboveLayerId ? doc.layers.findIndex((l) => l.id === aboveLayerId) : doc.layers.length - 1
  const layers = doc.layers.slice()
  layers.splice(at + 1, 0, layer)
  return { ...doc, layers, activeLayerId: layer.id }
}

/** Remove a layer. The last remaining layer is never removed -- there must always be somewhere to draw. */
export function removeLayer(doc: DrawDoc, id: string): DrawDoc {
  if (doc.layers.length <= 1) return doc
  const layers = doc.layers.filter((l) => l.id !== id)
  const activeLayerId = doc.activeLayerId === id ? layers[layers.length - 1].id : doc.activeLayerId
  return { ...doc, layers, activeLayerId }
}

export function moveLayer(doc: DrawDoc, id: string, delta: number): DrawDoc {
  const i = doc.layers.findIndex((l) => l.id === id)
  if (i < 0) return doc
  const j = Math.max(0, Math.min(doc.layers.length - 1, i + delta))
  if (i === j) return doc
  const layers = doc.layers.slice()
  const [moved] = layers.splice(i, 1)
  layers.splice(j, 0, moved)
  return { ...doc, layers }
}

export interface LayerPatch {
  name?: string
  visible?: boolean
  locked?: boolean
  opacity?: number
  blend?: DrawBlend
  assetId?: string
}

export function patchLayer(doc: DrawDoc, id: string, patch: LayerPatch): DrawDoc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as DrawDocLayer) : l)) }
}

function renumber(n: DrawNode): DrawNode {
  if (n.type === 'group') return { ...n, id: drawId('obj'), children: n.children.map(renumber) }
  return { ...n, id: drawId('obj') }
}

export function duplicateLayer(doc: DrawDoc, id: string): DrawDoc {
  const l = doc.layers.find((x) => x.id === id)
  if (!l) return doc
  const copy: DrawDocLayer =
    l.kind === 'vector'
      ? { ...l, id: drawId('lyr'), name: `${l.name} copy`, objects: l.objects.map(renumber) }
      : { ...l, id: drawId('lyr'), name: `${l.name} copy` }
  return addLayer(doc, copy, id)
}

/**
 * Merge a vector layer into the vector layer below it. Raster merges need real
 * pixels and therefore a canvas, so they are done in the editor and are not
 * attempted here -- this returns the document unchanged rather than pretending.
 */
export function mergeVectorLayerDown(doc: DrawDoc, id: string): DrawDoc {
  const i = doc.layers.findIndex((l) => l.id === id)
  if (i <= 0) return doc
  const upper = doc.layers[i]
  const lower = doc.layers[i - 1]
  if (upper.kind !== 'vector' || lower.kind !== 'vector') return doc
  const merged: DrawDocVectorLayer = { ...lower, objects: [...lower.objects, ...upper.objects] }
  const layers = doc.layers.filter((l) => l.id !== id).map((l) => (l.id === lower.id ? merged : l))
  return { ...doc, layers, activeLayerId: lower.id }
}
