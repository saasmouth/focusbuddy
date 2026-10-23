// ⌘V and Paste from one of our apps into another, through the same conversion
// matrix as inserting a saved snippet (shared/snippetConvert.ts convertForms).
//
// Each office app keeps its own same-app paste exactly as it was, its own
// format first. This is what it calls for everything else: the clipboard is
// read as forms (lib/clipboardForms.ts), converted to the app's kind, and
// handed to the SAME insert the app uses for a converted snippet, so a paste
// and an insert of one selection land identically. The one-line conversion
// notice is shown when something was converted; a refusal shows its reason
// verbatim; nothing is ever silently lossy.

import { conversionNotice, convertForms } from '@shared/snippetConvert'
import type { Snippet, SnippetBody, SnippetInsertResult, SnippetKind } from '@shared/snippets'
import { readClipboardForms, type ClipboardForms } from './clipboardForms'
import { snippetConvertDeps } from './snippetConvertDeps'
import { announceConverted, announceRefused } from './convertedNotice'

export type PasteOutcome = 'pasted' | 'refused' | 'nothing'

/** The converted body for a paste into `to`, with its notice; or why it cannot land; or null when there is nothing. */
export function convertClipboard(read: ClipboardForms, to: SnippetKind): { ok: true; body: SnippetBody; notice: string | null } | { ok: false; reason: string } | null {
  if (read.refused) return { ok: false, reason: read.refused }
  if (!read.forms.length) return null
  const out = convertForms(read.forms, to, snippetConvertDeps())
  if (!out.ok) return out
  return { ok: true, body: out.body, notice: conversionNotice(read.kind ?? null, to, out.lossy) }
}

/**
 * Paste the clipboard into an app of kind `to` through `insert` (the app's
 * converted-snippet insert). `read` is the clipboard already read, when the
 * caller had to look at it to decide that this is a cross-app paste.
 */
export async function pasteConverted(
  to: SnippetKind,
  insert: (body: SnippetBody) => SnippetInsertResult | Promise<SnippetInsertResult>,
  opts: { data?: DataTransfer | null; read?: ClipboardForms } = {}
): Promise<PasteOutcome> {
  const read = opts.read ?? (await readClipboardForms(opts.data ?? null))
  const conv = convertClipboard(read, to)
  if (!conv) return 'nothing'
  if (!conv.ok) {
    announceRefused(conv.reason)
    return 'refused'
  }
  const out = await insert(conv.body)
  if (out === true || (typeof out === 'object' && out.ok)) {
    announceConverted(conv.notice)
    return 'pasted'
  }
  if (typeof out === 'object' && !out.ok && out.reason) announceRefused(out.reason)
  return 'refused'
}

/** Is this clipboard content from one of our OTHER apps (so the app's own paste would not read it right)? */
export function fromAnotherApp(read: ClipboardForms, own: SnippetKind): boolean {
  return !!read.refused || (!!read.kind && read.kind !== own)
}

/**
 * A pasted body dressed as a snippet, for an app whose converted-insert path
 * takes one. It is never saved and never counted as a use: it only names the
 * content on the app's own status line ("Pasted").
 */
export function pastedSnippet(body: SnippetBody): Snippet {
  return { id: 'clipboard', kind: body.kind, name: 'Pasted', description: null, body, tags: [], scope: 'personal', orgId: 'personal', authorId: null, revision: 0, usageCount: 0, createdAt: 0, updatedAt: 0 } as unknown as Snippet
}
