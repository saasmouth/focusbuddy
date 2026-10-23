import { useEffect } from 'react'
import type { Editor } from '@tiptap/react'
import type { DocSnippetBody, Snippet, SnippetInsertResult, SnippetKind, SnippetLink, SnippetTarget } from '@shared/snippets'
import { insertIntoOffice, officeAccepts } from '../../../lib/officeSnippets'
import { readClipboardForms, type ClipboardForms } from '../../../lib/clipboardForms'
import { fromAnotherApp, pasteConverted, type PasteOutcome } from '../../../lib/clipboardPaste'
import { registerSnippetTarget } from '../../../stores/snippets'

// The document editor as a snippet surface: how a selection becomes a saved
// snippet, and how a saved snippet gets back into a document.
//
// Documents support BOTH link modes, which is why they are the surface the
// feature is built against first. A duplicate is inserted as ordinary blocks;
// a live instance is inserted as a snippetEmbed node holding only the id, which
// SnippetEmbed resolves on every render. A host that could not resolve a
// reference would register 'duplicate' only.

/**
 * Turn the current selection into a doc snippet body.
 *
 * Returns null when there is nothing selected, rather than an empty body: the
 * caller needs to tell "nothing to save" from "saved something empty", and the
 * save path refuses the latter anyway.
 */
export function docBodyFromSelection(editor: Editor): DocSnippetBody | null {
  const { from, to, empty } = editor.state.selection
  if (empty || to <= from) return null
  const slice = editor.state.doc.slice(from, to)
  const json = slice.content.toJSON() as unknown[] | null
  const content = Array.isArray(json) ? json : []
  if (content.length === 0) return null
  // Text is stored alongside the nodes so the library can search inside a
  // snippet and show an honest preview without rendering anything.
  const text = editor.state.doc.textBetween(from, to, '\n', ' ')
  return { kind: 'doc', content, text }
}

/** The whole document as a snippet body — for "save this document as a snippet". */
export function docBodyFromDocument(editor: Editor): DocSnippetBody | null {
  const json = editor.getJSON()
  const content = Array.isArray(json.content) ? (json.content as unknown[]) : []
  if (content.length === 0) return null
  return { kind: 'doc', content, text: editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', ' ') }
}

/**
 * A short default name from the selection's first line, so the save dialog
 * opens with something useful rather than empty. Trimmed to a name-like length;
 * punctuation at the end reads oddly as a name, so it goes.
 */
export function suggestedSnippetName(body: DocSnippetBody): string {
  const first = body.text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const cut = first.length > 60 ? first.slice(0, 57).replace(/\s+\S*$/, '') : first
  return cut.replace(/[:.,;\s]+$/, '')
}

/**
 * Insert a snippet into a document.
 *
 * Returns false when it declined, which the store reports rather than counting
 * a use. A document declines when it is not editable, when the snippet is not a
 * doc snippet, or when a duplicate has no content to place.
 */
export function insertSnippetIntoDoc(editor: Editor, snippet: Snippet, link: SnippetLink): boolean {
  if (!editor.isEditable) return false
  if (snippet.body.kind !== 'doc') return false
  if (link === 'live') return editor.chain().focus().insertSnippetLive(snippet.id).run()
  return editor.chain().focus().insertSnippetDuplicate(snippet.body.content).run()
}

/**
 * Whether a LIVE instance of a kind a document must convert is offered.
 *
 * SnippetEmbed renders such an instance read-only, re-converted from the
 * master on every resolve, with "Open original" to edit the master where it
 * lives. Offered because that whole path is proven in the app
 * (tests/e2e/snippetsWriteConverted.spec.ts: a sheet as a read-only table that
 * follows its master and shows the missing state when it is deleted; a drawing
 * as a sized data:image/svg+xml picture). Set false and a converted kind is
 * duplicate-only here, with no Live button offered for it.
 */
export const DOC_LIVE_CONVERTED = true

/**
 * Any snippet into a document: a doc snippet as before (duplicate or live);
 * any other kind converted to doc nodes and inserted as a duplicate through
 * the same insertSnippetDuplicate, with the conversion's line returned for
 * the store to show, or the builder's reason when the pair is refused.
 */
export function insertAnySnippetIntoDoc(editor: Editor, snippet: Snippet, link: SnippetLink): Promise<SnippetInsertResult> | SnippetInsertResult {
  if (snippet.body.kind !== 'doc' && link === 'live') {
    if (!DOC_LIVE_CONVERTED) return { ok: false, reason: 'This kind of snippet can only be inserted into a document as a copy for now.' }
    if (!editor.isEditable) return false
    return editor.chain().focus().insertSnippetLive(snippet.id).run()
  }
  return insertIntoOffice(snippet, link, 'doc', (s, l) => insertSnippetIntoDoc(editor, s, l))
}

/** The target a mounted document registers. Pure, so its contract is unit-testable. */
export function docSnippetTarget(editor: Editor, instanceId: string, title: string): SnippetTarget {
  return {
    id: docSnippetTargetId(instanceId),
    label: title?.trim() ? `“${title.trim()}”` : 'This document',
    // Every kind with a conversion into a document, from the builders.
    accepts: officeAccepts('doc'),
    host: 'doc',
    // A document can resolve a reference at render time, so it honours both
    // for its own kind; a converted kind is live only once that is proven.
    supports: ['duplicate', 'live'],
    ...(DOC_LIVE_CONVERTED ? {} : { liveKinds: ['doc'] as SnippetKind[] }),
    insert: (snippet, link) => insertAnySnippetIntoDoc(editor, snippet, link)
  }
}

/**
 * Register the open document as an insertion target for as long as it is
 * mounted and editable.
 *
 * `instanceId` identifies the MOUNTED SURFACE rather than the document, which
 * is what the registry actually tracks: the same document open twice is two
 * destinations, and a closed one is none. DocEditor passes its React `useId`
 * scope, which is exactly that. The effect depends on everything `insert`
 * closes over, so the registry can never hold a closure writing into an editor
 * that has since been replaced.
 */
export function useDocSnippetTarget(editor: Editor | null, instanceId: string, title: string): void {
  useEffect(() => {
    if (!editor) return
    return registerSnippetTarget(docSnippetTarget(editor, instanceId, title))
  }, [editor, instanceId, title])
}

/** The registry id for a document surface. One place, so host and picker agree. */
export function docSnippetTargetId(instanceId: string): string {
  return `doc:${instanceId}`
}

/**
 * Paste another of our apps' content into a document: read the clipboard as
 * forms, convert to doc nodes, and insert them exactly as a converted snippet
 * is inserted (insertSnippetDuplicate at the selection), showing the
 * conversion's line. Write's own paste (HTML, text) is untouched: this runs
 * only when pasteNeedsConversion says the browser's paste would get it wrong.
 */
export function pasteIntoDoc(editor: Editor, opts: { data?: DataTransfer | null; read?: ClipboardForms } = {}): Promise<PasteOutcome> {
  return pasteConverted(
    'doc',
    (body) => {
      if (!editor.isEditable || body.kind !== 'doc') return false
      return editor.chain().focus().insertSnippetDuplicate(body.content).run()
    },
    opts
  )
}

/** Edit › Paste: another app's content converted; anything else is not handled here (null), so the menu's own paste runs. */
export async function menuPasteIntoDoc(editor: Editor): Promise<PasteOutcome | null> {
  const read = await readClipboardForms()
  const pictureOnly = !read.kind && read.forms.length > 0 && read.forms.every((f) => f.kind === 'svg' || f.kind === 'image')
  if (!fromAnotherApp(read, 'doc') && !pictureOnly) return null
  return pasteIntoDoc(editor, { read })
}
