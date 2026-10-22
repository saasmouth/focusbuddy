// Edit › Save selection as snippet… and Edit › Insert snippet…: PlexiiDraw as a
// saved-snippet surface (docs/saved-snippets.md). The work is in
// editor/drawSnippets.ts; this file is only placement and enabling. Both items
// also sit in the canvas context menu (render/CanvasContextMenu.tsx), beside
// Copy and Paste, where Draw's other "do something with this selection"
// actions live.

import type { Command, EditorCtx } from '../editor/types'
import { copyableIds } from '../editor/clipboard'
import { drawBodyFromSelection, drawSnippetTargetId, emptyDrawBody, suggestedDrawSnippetName } from '../editor/drawSnippets'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly
const canSave = (ctx: EditorCtx): boolean => copyableIds(ctx).length > 0

export const commands: Command[] = [
  {
    id: 'edit.saveAsSnippet',
    label: 'Save selection as snippet…',
    icon: 'bookmark_add',
    menu: { path: 'edit', order: 400 },
    // Saving never edits, so it works on a read-only drawing too, like Copy.
    enabled: canSave,
    disabledReason: (ctx) => (canSave(ctx) ? null : 'Select something to save as a snippet.'),
    run: (ctx) => {
      const s = ctx.get()
      // Run with nothing selected (from code, not the disabled item), the
      // dialog opens on an empty body and says there is nothing to save,
      // rather than the command appearing to do nothing.
      const body = drawBodyFromSelection(s.doc, copyableIds(ctx)) ?? emptyDrawBody()
      ctx.set({ dialog: { id: 'save-snippet', props: { body, suggestedName: suggestedDrawSnippetName(body) } } })
    }
  },
  {
    id: 'edit.insertSnippet',
    label: 'Insert snippet…',
    icon: 'bookmarks',
    menu: { path: 'edit', order: 401 },
    enabled: writable,
    disabledReason: (ctx) => (writable(ctx) ? null : 'This drawing is read-only.'),
    run: (ctx) => ctx.set({ dialog: { id: 'snippet-library', props: { targetId: drawSnippetTargetId(ctx) } } })
  }
]
