// Edit › Cut, Copy, Paste, Paste in Front, Paste in Back, Paste in Place and
// Paste on All Artboards, with Illustrator's default keys. The work is in
// editor/clipboard.ts; this file is only placement, enabling and keys.

import { deleteObjects } from '@shared/draw/ops'
import type { Command, EditorCtx, KeyInput } from '../editor/types'
import { copySelection, copyableIds, cutSelection, pasteFromClipboard } from '../editor/clipboard'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly
const canCopy = (ctx: EditorCtx): boolean => copyableIds(ctx).length > 0
/** Paste on All Artboards needs more than one artboard; with one it would only repeat Paste in Place. */
const severalArtboards = (ctx: EditorCtx): boolean => ctx.get().doc.artboards.length > 1

export const commands: Command[] = [
  {
    id: 'edit.cut',
    label: 'Cut',
    icon: 'content_cut',
    shortcut: '⌘X',
    menu: { path: 'edit', order: 200 },
    enabled: (ctx) => writable(ctx) && canCopy(ctx),
    // With nothing selected the key is left alone (no step, no status).
    keyWhen: (ctx) => writable(ctx) && canCopy(ctx),
    run: (ctx) => cutSelection(ctx, deleteObjects).then(() => undefined)
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    icon: 'content_copy',
    shortcut: '⌘C',
    menu: { path: 'edit', order: 201 },
    // Copying never edits, so it works on a read-only drawing too (from the menu).
    enabled: canCopy,
    keyWhen: canCopy,
    run: (ctx) => copySelection(ctx).then(() => undefined)
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    icon: 'content_paste',
    shortcut: '⌘V',
    menu: { path: 'edit', order: 202 },
    enabled: writable,
    run: (ctx) => pasteFromClipboard(ctx, 'paste').then(() => undefined)
  },
  {
    id: 'edit.pasteInFront',
    label: 'Paste in Front',
    icon: 'flip_to_front',
    shortcut: '⌘F',
    menu: { path: 'edit', order: 203 },
    enabled: writable,
    run: (ctx) => pasteFromClipboard(ctx, 'front').then(() => undefined)
  },
  {
    id: 'edit.pasteInBack',
    label: 'Paste in Back',
    icon: 'flip_to_back',
    shortcut: '⌘B',
    menu: { path: 'edit', order: 204 },
    enabled: writable,
    run: (ctx) => pasteFromClipboard(ctx, 'back').then(() => undefined)
  },
  {
    id: 'edit.pasteInPlace',
    label: 'Paste in Place',
    icon: 'place_item',
    shortcut: '⇧⌘V',
    menu: { path: 'edit', order: 205 },
    enabled: writable,
    // ⌥⇧⌘V reaches here too: the keymap ignores Alt, so the Alt variant is
    // told apart by the key event itself. With one artboard Illustrator's
    // Paste on All Artboards is Paste in Place, so that is what it does.
    run: (ctx, args) => {
      const alt = (args as KeyInput | undefined)?.altKey === true
      return pasteFromClipboard(ctx, alt && severalArtboards(ctx) ? 'allArtboards' : 'inPlace').then(() => undefined)
    }
  },
  {
    id: 'edit.pasteOnAllArtboards',
    label: 'Paste on All Artboards',
    icon: 'dashboard',
    shortcut: '⌥⇧⌘V',
    menu: { path: 'edit', order: 206 },
    enabled: (ctx) => writable(ctx) && severalArtboards(ctx),
    run: (ctx) => pasteFromClipboard(ctx, 'allArtboards').then(() => undefined)
  }
]
