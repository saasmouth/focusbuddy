// The studio editing something that is not a document: a saved snippet's edit
// session ("Open original", components/snippets/SnippetEditSessionView.tsx).
//
// The host passes DrawStudio `session={{ kind: 'snippet' }}`. Every command
// that acts on a DOCUMENT -- the documents store's active document, or a new
// one it creates and opens in place of this studio -- is then disabled with a
// reason, in its menu, on its key and through ctx.run alike:
//
//   - Make a copy (⌥⌘S): it copied the documents store's ACTIVE document,
//     which is not the snippet (whatever document was open last, or nothing),
//     and opened the copy over the session.
//   - Rename, Version history, Move to trash: the active document again; Move
//     to trash would bin a document the person is not even looking at.
//   - Meeting: a meeting about the active document.
//   - New artwork (⌘N, ⌥⌘N), New from preset, Open SVG… (⌘O): create a
//     document and open it in place of the session, dropping unsaved edits.
//
// Editing commands, Save (the host's Save, file.save) and Export stay on:
// Export writes a file the person picks, from what is on the canvas, and
// touches no document.
//
// A command joins by wrapping itself in `documentCommand` (one line in its
// *.commands.ts). tests/unit/drawSnippetSession.test.tsx holds the list and
// fails if a command reaches the documents store without being wrapped.

import type { Command, EditorCtx } from './types'

/** The default reason, used when the host gives none. */
export const SNIPPET_SESSION_REASON =
  'Not available while editing a snippet: this edits the snippet, not a document.'

/** Why a document command is off right now, or null outside a session. */
export function documentBlockedReason(ctx: EditorCtx): string | null {
  const s = ctx.host.session?.()
  if (!s) return null
  return s.reason?.trim() || SNIPPET_SESSION_REASON
}

/**
 * A command that acts on a document, made session-aware: disabled with the
 * session's reason (menu and key), and its run refuses too, so a direct
 * ctx.run or a bar button cannot reach the documents store either. Outside a
 * session it is exactly the command it wraps.
 */
export function documentCommand(c: Command): Command {
  return {
    ...c,
    enabled: (ctx) => documentBlockedReason(ctx) === null && (c.enabled ? c.enabled(ctx) : true),
    disabledReason: (ctx) => documentBlockedReason(ctx) ?? c.disabledReason?.(ctx) ?? null,
    // The key runs it while disabled only to say why; the run below refuses.
    explainsWhenDisabled: true,
    run: (ctx, args) => {
      const why = documentBlockedReason(ctx)
      if (why) {
        ctx.status(why)
        return
      }
      if (c.enabled && !c.enabled(ctx) && !c.explainsWhenDisabled) return
      return c.run(ctx, args)
    }
  }
}
