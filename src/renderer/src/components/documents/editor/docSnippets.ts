import { useEffect } from 'react'
import type { Editor } from '@tiptap/react'
import type { DocSnippetBody, Snippet, SnippetLink, SnippetTarget } from '@shared/snippets'
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
    const target: SnippetTarget = {
      id: docSnippetTargetId(instanceId),
      label: title?.trim() ? `“${title.trim()}”` : 'This document',
      accepts: ['doc'],
      // A document can resolve a reference at render time, so it honours both.
      supports: ['duplicate', 'live'],
      insert: (snippet, link) => insertSnippetIntoDoc(editor, snippet, link)
    }
    return registerSnippetTarget(target)
  }, [editor, instanceId, title])
}

/** The registry id for a document surface. One place, so host and picker agree. */
export function docSnippetTargetId(instanceId: string): string {
  return `doc:${instanceId}`
}
