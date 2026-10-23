// The conversion ProseMirror needs and shared/commentAnchor.ts refuses to do.
//
// The anchor model is pure: it takes a string and two indices and decides what
// is true. ec's decoration plugin takes ranges already resolved. Neither knows
// what a ProseMirror position is. This is the one file that does, and it exists
// for a single non-obvious reason:
//
//   A PROSEMIRROR POSITION IS NOT A TEXT OFFSET. Every node boundary occupies
//   one position, so in "<p>ab</p><p>cd</p>" the letters sit at 1,2 and 5,6 —
//   while `doc.textBetween(0, size)` yields "abcd", where they sit at 0,1 and
//   2,3. Hand that string to the resolver with a position-based range and it
//   slices the wrong characters: the quote check compares the wrong text, and a
//   re-found range comes back in text-offset space and is drawn, as a position
//   range, somewhere else entirely. Silently, and further out the longer the
//   document. That is the confidently-wrong highlight the quote exists to
//   prevent, reintroduced by the units.
//
// So `positionText` builds a string INDEXED BY POSITION: text characters at
// their own positions, one filler character for every node boundary. Its length
// is doc.content.size, which is also the bound ec's plugin clamps to, so one
// coordinate space runs from the editor through the resolver to the decoration.

import type { Editor } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import {
  quoteFor,
  readCommentAnchor,
  resolveThreads,
  type LocalCommentAnchor,
  type OrphanThread,
  type ResolvedThread
} from '@shared/commentAnchor'

/**
 * What stands in for a node boundary.
 *
 * A newline, so that a comment spanning two paragraphs stores a quote that
 * reads like the text it came from and still matches after the resolver
 * normalises whitespace. A code block's own newlines are real text and become
 * indistinguishable from boundaries, which costs nothing: the string is only
 * ever compared with itself.
 */
const FILL = '\n'

/** The document's text, indexed by ProseMirror position. Length = content.size. */
export function positionText(doc: PMNode): string {
  const out = new Array<string>(doc.content.size).fill(FILL)
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    const t = node.text
    for (let i = 0; i < t.length && pos + i < out.length; i++) out[pos + i] = t[i]!
    return false
  })
  return out.join('')
}

/** The anchor to store for a new comment on this selection. */
export function localAnchorFor(editor: Editor, from: number, to: number): LocalCommentAnchor {
  const quote = quoteFor(positionText(editor.state.doc), from, to)
  return { kind: 'local', from, to, ...(quote ? { quote } : {}) }
}

/**
 * Re-read the quote under an anchor's range.
 *
 * Called when the text under a comment has itself been edited, so the stored
 * quote still describes what the comment is on. `docText` is passed in because
 * a pass over several anchors needs only one.
 *
 * Returns null when there is no longer any text there to quote — the caller
 * keeps the anchor it had, and the comment orphans on the next open, which is
 * the truth: the passage is gone.
 */
export function requote(docText: string, anchor: LocalCommentAnchor): LocalCommentAnchor | null {
  const quote = quoteFor(docText, anchor.from, anchor.to)
  return quote ? { ...anchor, quote } : null
}

export interface CommentAnchorInput {
  id: string
  /** The stored anchor: the JSON string SQLite holds, or the object HTTP returns. */
  anchor: unknown
  state?: 'open' | 'resolved'
}

/**
 * Where every thread belongs in the document as it now stands.
 *
 * `ranges` go straight to `editor.commands.setCommentRanges`. `orphans` are
 * threads whose text is gone or ambiguous, which are NOT drawn at a guess.
 *
 * A live document's anchor (kind 'yjs') arrives here with no candidate, since
 * converting its relative positions needs the Y.Doc and that half is not wired
 * yet. It is not dropped: the resolver finds its quote instead, which is a real
 * path rather than a stand-in — exact and unique or nothing. What the caller
 * must NOT do is write such a range back as a local anchor; see DocEditor.
 */
export function resolveForEditor(
  editor: Editor,
  threads: readonly CommentAnchorInput[]
): { ranges: ResolvedThread[]; orphans: OrphanThread[] } {
  return resolveThreads(
    threads.map((t) => ({ id: t.id, anchor: t.anchor, state: t.state })),
    positionText(editor.state.doc)
  )
}

/** The parsed anchor for a thread, or null when it has none to read. */
export const anchorOf = (t: CommentAnchorInput): ReturnType<typeof readCommentAnchor> => readCommentAnchor(t.anchor)
