// Document menu: artboard size (with an anchor), background, meeting.

import { solid } from '@shared/draw'
import type { DrawDocPaint } from '@shared/draw/model'
import { applyPaintFollow, artboardResizeOffset, planPaintFollow, primaryArtboard, resizeArtboard, setArtboardBackground, type ArtboardAnchor } from '@shared/draw/ops'
import { relayPaint } from '../editor/artboards'
import { launchMeeting } from '../../../../lib/startMeeting'
import { useDocumentsStore } from '../../../../stores/documents'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly

export const menus: MenuSpec[] = [
  { path: 'document', label: 'Document', order: 50 },
  { path: 'document/Background', label: 'Background', icon: 'format_color_fill', order: 110 }
]

/**
 * Resize the artboard, pinned at `anchor`. With one artboard the vector art
 * moves by the anchor offset; with several the artboard moves instead and
 * the art stays. The artboard's page-sized paint layers (ops/artboards.ts
 * planPaintFollow) are re-laid onto a canvas of the new size at 1:1, moving
 * with the art, so nothing is stretched. One undo step.
 */
export async function resizeArtboardTo(ctx: EditorCtx, w: number, h: number, anchor: ArtboardAnchor): Promise<void> {
  const doc = ctx.doc()
  const board = primaryArtboard(doc)
  if (ctx.get().readOnly || (w === board.w && h === board.h)) return
  const { dx, dy } = artboardResizeOffset({ w: board.w, h: board.h }, { w, h }, anchor)
  // With several artboards the page moves rather than the art, so the pixels stay put.
  const shift = doc.artboards.length > 1 ? { dx: 0, dy: 0 } : { dx, dy }
  const sized = resizeArtboard(doc, w, h, anchor)
  const after = sized.artboards.find((a) => a.id === board.id)!
  const plans = planPaintFollow(doc, board, after, shift)
  if (plans.length) ctx.busy('Resizing…')
  try {
    const { ids, assets } = await relayPaint(ctx, plans)
    // Built from the CURRENT document: anything committed while the pixels
    // were being re-laid is kept.
    const now = resizeArtboard(ctx.doc(), w, h, anchor)
    ctx.history.commit(applyPaintFollow({ ...now, assets: { ...now.assets, ...assets } }, plans, ids), 'Artboard size')
  } finally {
    if (plans.length) ctx.busy(null)
  }
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
