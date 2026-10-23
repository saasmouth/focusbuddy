// Edit › Cut, Copy, Paste, Paste in Front, Paste in Back, Paste in Place and
// Paste on All Artboards, with Illustrator's default keys. The work is in
// editor/clipboard.ts; this file is only placement, enabling and keys.

import { deleteObjects } from '@shared/draw/ops'
import type { Command, EditorCtx } from '../editor/types'
import { copySelection, copyableIds, cutSelection, pasteFromClipboard } from '../editor/clipboard'
import { firstOf, gate, notReadOnly, unless, writableGate } from './gate'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly
const canCopy = (ctx: EditorCtx): boolean => copyableIds(ctx).length > 0
/** Paste on All Artboards with one artboard is Paste in Place on it. */
const severalArtboards = (ctx: EditorCtx): boolean => ctx.get().doc.artboards.length > 1

export const commands: Command[] = [
  {
    id: 'edit.cut',
    label: 'Cut',
    icon: 'content_cut',
    menu: { path: 'edit', order: 200 },
    ...gate(firstOf(notReadOnly, unless(canCopy, 'Select something to cut.'))),
    // With nothing selected the key is left alone (no step, no status).
    keyWhen: (ctx) => writable(ctx) && canCopy(ctx),
    run: (ctx) => cutSelection(ctx, deleteObjects).then(() => undefined)
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    icon: 'content_copy',
    menu: { path: 'edit', order: 201 },
    // Copying never edits, so it works on a read-only drawing too (menu, ⌘C and F3).
    ...gate(unless(canCopy, 'Select something to copy.')),
    keyWhen: canCopy,
    run: (ctx) => copySelection(ctx).then(() => undefined)
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    icon: 'content_paste',
    menu: { path: 'edit', order: 202 },
    ...writableGate,
    run: (ctx) => pasteFromClipboard(ctx, 'paste').then(() => undefined)
  },
  {
    id: 'edit.pasteInFront',
    label: 'Paste in Front',
    icon: 'flip_to_front',
    menu: { path: 'edit', order: 203 },
    ...writableGate,
    run: (ctx) => pasteFromClipboard(ctx, 'front').then(() => undefined)
  },
  {
    id: 'edit.pasteInBack',
    label: 'Paste in Back',
    icon: 'flip_to_back',
    menu: { path: 'edit', order: 204 },
    ...writableGate,
    run: (ctx) => pasteFromClipboard(ctx, 'back').then(() => undefined)
  },
  {
    id: 'edit.pasteInPlace',
    label: 'Paste in Place',
    icon: 'place_item',
    menu: { path: 'edit', order: 205 },
    ...writableGate,
    run: (ctx) => pasteFromClipboard(ctx, 'inPlace').then(() => undefined)
  },
  {
    id: 'edit.pasteOnAllArtboards',
    label: 'Paste on All Artboards',
    icon: 'dashboard',
    menu: { path: 'edit', order: 206 },
    // ⌥⇧⌘V (its own key now that the keymap reads Alt). With one artboard,
    // as in Illustrator, it pastes in place on that artboard.
    ...writableGate,
    run: (ctx) => pasteFromClipboard(ctx, severalArtboards(ctx) ? 'allArtboards' : 'inPlace').then(() => undefined)
  }
]
