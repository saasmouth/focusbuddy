// Layer menu and the layer edits the Layers panel runs. Rasterize and the
// raster half of Merge down need real pixels, so they render on a canvas.

import { putAsset, assetSrc } from '@shared/draw/assets'
import type { DrawDoc, DrawDocLayer } from '@shared/draw/model'
import {
  addLayer,
  duplicateLayer,
  mergeVectorLayerDown,
  moveLayer,
  patchLayer,
  rasterArtboard,
  rasterFrame,
  rasterLayerV2,
  removeLayer,
  vectorLayerV2,
  type LayerPatch
} from '@shared/draw/ops'
import { drawDocToSvg } from '@shared/draw/svg'
import * as raster from '../raster'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly

export const menus: MenuSpec[] = [{ path: 'layer', label: 'Layer', order: 40 }]

/** Add an empty layer of a kind above the active one. */
export function addLayerOfKind(ctx: EditorCtx, kind: 'vector' | 'raster'): void {
  const doc = ctx.doc()
  const layer = kind === 'vector' ? vectorLayerV2(`Layer ${doc.layers.length + 1}`) : rasterLayerV2(`Paint ${doc.layers.filter((l) => l.kind === 'raster').length + 1}`)
  ctx.history.commit(addLayer(doc, layer, doc.activeLayerId), kind === 'vector' ? 'New layer' : 'New paint layer')
}

/** The document with only `layer`, at full strength, on a transparent page -- for flattening it. */
function isolated(doc: DrawDoc, layer: DrawDocLayer): DrawDoc {
  // Framed on the paint layers' own frame (the first page, at the origin).
  const board = { ...rasterArtboard(doc), ...rasterFrame(doc) }
  return {
    ...doc,
    artboards: [{ ...board, background: { type: 'none' } }],
    activeArtboardId: board.id,
    layers: [{ ...layer, opacity: 1, blend: 'normal' }]
  }
}

/** Turn a vector layer's shapes into pixels, so paint tools can work on them. */
export async function rasterizeLayer(ctx: EditorCtx, layerId: string): Promise<void> {
  const doc = ctx.doc()
  const layer = doc.layers.find((l) => l.id === layerId)
  if (!layer || layer.kind !== 'vector') return
  const board = rasterFrame(doc)
  ctx.busy('Rasterizing…')
  try {
    const canvas = await raster.svgToCanvas(drawDocToSvg(isolated(doc, layer)), board.w, board.h)
    const put = putAsset(ctx.doc().assets, raster.canvasToDataUrl(canvas))
    const next = { ...rasterLayerV2(layer.name), assetId: put.id, opacity: layer.opacity, blend: layer.blend, visible: layer.visible }
    const withNew = addLayer({ ...ctx.doc(), assets: put.assets }, next, layerId)
    ctx.history.commit(removeLayer(withNew, layerId), 'Rasterize layer')
  } finally {
    ctx.busy(null)
  }
}

/** Merge down: vectors fold directly; a raster pair is composited on a canvas. */
export async function mergeDown(ctx: EditorCtx, layerId: string): Promise<void> {
  const doc = ctx.doc()
  const i = doc.layers.findIndex((l) => l.id === layerId)
  if (i <= 0) {
    ctx.status('The bottom layer has nothing below it to merge into.')
    return
  }
  const upper = doc.layers[i]
  const lower = doc.layers[i - 1]
  if (upper.kind === 'vector' && lower.kind === 'vector') {
    ctx.history.commit(mergeVectorLayerDown(doc, layerId), 'Merge down')
    return
  }
  const board = rasterFrame(doc)
  ctx.busy('Merging…')
  try {
    const render = async (layer: DrawDocLayer): Promise<HTMLCanvasElement> => {
      if (layer.kind === 'raster') {
        const c = raster.createCanvas(board.w, board.h)
        await raster.loadIntoCanvas(c, assetSrc(doc.assets, layer.assetId) ?? '')
        return c
      }
      return raster.svgToCanvas(drawDocToSvg(isolated(doc, layer)), board.w, board.h)
    }
    const lowerCanvas = await render(lower)
    const upperCanvas = await render(upper)
    // The lower layer's own opacity/blend stay with the merged layer, so the
    // picture is unchanged; only the upper layer is baked in.
    raster.compositeOnto(lowerCanvas, upperCanvas, upper.opacity, upper.blend)
    const put = putAsset(ctx.doc().assets, raster.canvasToDataUrl(lowerCanvas))
    const merged = { ...rasterLayerV2(lower.name), assetId: put.id, opacity: lower.opacity, blend: lower.blend }
    let next = addLayer({ ...ctx.doc(), assets: put.assets }, merged, lower.id)
    next = removeLayer(next, upper.id)
    next = removeLayer(next, lower.id)
    ctx.history.commit(next, 'Merge down')
  } finally {
    ctx.busy(null)
  }
}

export const commands: Command[] = [
  { id: 'layer.newVector', label: 'New vector layer', icon: 'shapes', menu: { path: 'layer', order: 100 }, enabled: writable, run: (ctx) => addLayerOfKind(ctx, 'vector') },
  { id: 'layer.newRaster', label: 'New paint layer', icon: 'brush', menu: { path: 'layer', order: 110 }, enabled: writable, run: (ctx) => addLayerOfKind(ctx, 'raster') },
  {
    id: 'layer.activate',
    label: 'Make layer active',
    // Choosing a layer is not an edit anyone undoes.
    run: (ctx, id) => ctx.history.replace({ ...ctx.doc(), activeLayerId: id as string })
  },
  {
    id: 'layer.patch',
    label: 'Layer settings',
    run: (ctx, args) => {
      const { id, patch } = args as { id: string; patch: LayerPatch }
      ctx.history.commit(patchLayer(ctx.doc(), id, patch), 'Layer settings')
    }
  },
  { id: 'layer.duplicate', label: 'Duplicate layer', run: (ctx, id) => ctx.history.commit(duplicateLayer(ctx.doc(), id as string), 'Duplicate layer') },
  { id: 'layer.delete', label: 'Delete layer', run: (ctx, id) => ctx.history.commit(removeLayer(ctx.doc(), id as string), 'Delete layer') },
  {
    id: 'layer.move',
    label: 'Move layer',
    run: (ctx, args) => {
      const { id, delta } = args as { id: string; delta: number }
      ctx.history.commit(moveLayer(ctx.doc(), id, delta), 'Move layer')
    }
  },
  { id: 'layer.mergeDown', label: 'Merge down', run: (ctx, id) => void mergeDown(ctx, id as string) },
  { id: 'layer.rasterize', label: 'Rasterize layer', run: (ctx, id) => void rasterizeLayer(ctx, id as string) }
]
