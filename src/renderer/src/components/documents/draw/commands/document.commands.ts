// Document menu: artboard size (with an anchor), background, meeting.

import { solid } from '@shared/draw'
import { assetSrc, putAsset } from '@shared/draw/assets'
import type { DrawDocPaint } from '@shared/draw/model'
import { artboardResizeOffset, primaryArtboard, rasterArtboard, resizeArtboard, setArtboardBackground, type ArtboardAnchor } from '@shared/draw/ops'
import { launchMeeting } from '../../../../lib/startMeeting'
import { useDocumentsStore } from '../../../../stores/documents'
import * as raster from '../raster'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly

export const menus: MenuSpec[] = [
  { path: 'document', label: 'Document', order: 50 },
  { path: 'document/Background', label: 'Background', icon: 'format_color_fill', order: 110 }
]

/**
 * Resize the artboard, pinned at `anchor`. Vector art moves by the anchor
 * offset; each paint layer's pixels are re-laid onto a canvas of the new size
 * at 1:1 first, so nothing is stretched. One undo step.
 */
export async function resizeArtboardTo(ctx: EditorCtx, w: number, h: number, anchor: ArtboardAnchor): Promise<void> {
  const doc = ctx.doc()
  const board = primaryArtboard(doc)
  if (ctx.get().readOnly || (w === board.w && h === board.h)) return
  const { dx, dy } = artboardResizeOffset({ w: board.w, h: board.h }, { w, h }, anchor)
  const relaid: Record<string, string> = {}
  // Paint layers are pictures of the first page: only resizing THAT artboard
  // re-lays them. With several artboards the page moves rather than the art,
  // so the pixels stay where they are (offset 0).
  const paintsHere = rasterArtboard(doc).id === board.id
  const multi = doc.artboards.length > 1
  const painted = paintsHere ? doc.layers.filter((l) => l.kind === 'raster' && assetSrc(doc.assets, l.assetId)) : []
  if (painted.length) ctx.busy('Resizing…')
  try {
    for (const l of painted) {
      if (l.kind !== 'raster') continue
      relaid[l.id] = await raster.reframeRaster(assetSrc(doc.assets, l.assetId) ?? '', { w: board.w, h: board.h }, { w, h }, multi ? 0 : dx, multi ? 0 : dy)
    }
  } finally {
    if (painted.length) ctx.busy(null)
  }
  // Built from the CURRENT document: anything committed while the pixels were
  // being re-laid is kept.
  let assets = ctx.doc().assets
  const ids: Record<string, string | undefined> = {}
  for (const [layerId, src] of Object.entries(relaid)) {
    const put = putAsset(assets, src)
    assets = put.assets
    ids[layerId] = put.id
  }
  ctx.history.commit(resizeArtboard(ctx.doc(), w, h, anchor, ids, assets), 'Artboard size')
}

const BACKGROUNDS: Array<{ id: string; label: string; paint: DrawDocPaint }> = [
  { id: 'transparent', label: 'Transparent', paint: { type: 'none' } },
  { id: 'white', label: 'White', paint: solid('#ffffff') },
  { id: 'black', label: 'Black', paint: solid('#000000') },
  { id: 'paper', label: 'Paper', paint: solid('#faf7f2') }
]

export const commands: Command[] = [
  {
    id: 'document.artboardSize',
    label: 'Artboard size…',
    icon: 'aspect_ratio',
    menu: { path: 'document', order: 100 },
    enabled: writable,
    run: (ctx) => ctx.set({ dialog: { id: 'artboard-size' } })
  },
  {
    id: 'document.resize',
    label: 'Resize artboard',
    enabled: writable,
    run: (ctx, args) => {
      const { w, h, anchor } = args as { w: number; h: number; anchor?: ArtboardAnchor }
      return resizeArtboardTo(ctx, w, h, anchor ?? 'nw')
    }
  },
  ...BACKGROUNDS.map(
    (b, i): Command => ({
      id: `document.background.${b.id}`,
      label: b.label,
      menu: { path: 'document/Background', order: i },
      enabled: writable,
      run: (ctx) => ctx.history.commit(setArtboardBackground(ctx.doc(), b.paint), 'Background')
    })
  ),
  {
    id: 'document.meeting',
    label: 'Meeting',
    icon: 'videocam',
    menu: { path: 'document', order: 200 },
    run: () => {
      const active = useDocumentsStore.getState().active
      const title = active?.title ?? 'Untitled artwork'
      void launchMeeting({ kind: 'draw', id: active?.id ?? '', title: title || 'Artwork review' })
    }
  }
]
