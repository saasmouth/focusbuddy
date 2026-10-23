// Commands that act on a DOCUMENT, and the one place they get it from.
//
// Every such command -- New artwork (⌘N, ⌥⌘N), New from preset, Open SVG…
// (⌘O), Make a copy (⌥⌘S), Rename, Version history, Move to trash and
// Document › Meeting -- is written with `documentCommand`, and its run is
// handed the DocumentOps the HOST bound to the drawing on screen
// (HostService.docOps, DrawStudio's `documentOps`). It has no other way to
// reach a document: no Draw command imports the documents store or reads its
// `active` (tests/unit/drawDocumentOps.test.tsx is the tripwire).
//
// That is the fix for 4.3.33–4.3.40, where these commands read the documents
// store's `active` document: in a Draw desk widget, which holds its drawing in
// local state, Move to trash binned whatever Documents last had open, Make a
// copy copied it, and Meeting invited people to it (or to id '').
//
// A command is disabled, with a reason, in its menu, on its key and through
// ctx.run alike, when:
//
//   - the studio is editing something that is not a document: a saved
//     snippet's edit session ("Open original",
//     components/snippets/SnippetEditSessionView.tsx), which passes DrawStudio
//     `session={{ kind: 'snippet' }}`. The session's reason wins: it says what
//     is going on. New/Open would also open a document in place of the
//     session, dropping unsaved edits.
//   - no host supplied a document: a live drawing (LiveDocEditorView: it has
//     no local row for these to act on), or a headless run. NEVER a fallback
//     to the store's `active` document.
//
// Editing commands, Save (the host's Save, file.save) and Export stay on:
// Export writes a file the person picks, from what is on the canvas, and
// touches no document.
//
// tests/unit/drawSnippetSession.test.tsx holds the list and fails if a
// command reaches a document without being wrapped.

import type { DocumentOps } from '../../editor/documentOps'
import type { Command, EditorCtx } from './types'

/** The default reason in a snippet session, used when the host gives none. */
export const SNIPPET_SESSION_REASON =
  'Not available while editing a snippet: this edits the snippet, not a document.'

/** Why a document command is off when no host bound a document to the studio. */
export const NO_DOCUMENT_REASON = 'Not available here: this drawing is not stored in Documents.'

/** Why a document command is off right now, or null when it can act. */
export function documentBlockedReason(ctx: EditorCtx): string | null {
  const s = ctx.host.session?.()
  if (s) return s.reason?.trim() || SNIPPET_SESSION_REASON
  if (!ctx.host.docOps?.()) return NO_DOCUMENT_REASON
  return null
}

/** A command that acts on a document: its run is given the host's ops for it. */
export interface DocumentCommandSpec extends Omit<Command, 'run'> {
  run(ctx: EditorCtx, ops: DocumentOps, args?: unknown): void | Promise<void>
}

/**
 * A command that acts on a document. Disabled with the reason above (menu and
 * key) when there is no document to act on, and its run refuses too, so a
 * direct ctx.run or a bar button cannot act either. Otherwise its run is
 * called with the ops the host bound -- the only document it can touch.
 */
export function documentCommand(c: DocumentCommandSpec): Command {
  return {
    ...c,
    enabled: (ctx) => documentBlockedReason(ctx) === null && (c.enabled ? c.enabled(ctx) : true),
    disabledReason: (ctx) => documentBlockedReason(ctx) ?? c.disabledReason?.(ctx) ?? null,
    // The key runs it while disabled only to say why; the run below refuses.
    explainsWhenDisabled: true,
    run: (ctx, args) => {
      const why = documentBlockedReason(ctx)
      const ops = ctx.host.docOps?.()
      if (why || !ops) {
        ctx.status(why ?? NO_DOCUMENT_REASON)
        return
      }
      if (c.enabled && !c.enabled(ctx) && !c.explainsWhenDisabled) return
      return c.run(ctx, ops, args)
    }
  }
}
