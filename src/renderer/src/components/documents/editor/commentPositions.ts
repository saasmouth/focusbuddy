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
import * as Y from 'yjs'
// @tiptap/y-tiptap, NOT y-prosemirror. TipTap 3's Collaboration extension
// binds through y-tiptap, and a PluginKey's identity is the object: the key
// exported by y-prosemirror is a DIFFERENT instance, so
// `ySyncPluginKey.getState(state)` through it returns null in every editor,
// forever, silently. Found by a test asserting the binding was there rather
// than by reading the import list.
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey
} from '@tiptap/y-tiptap'
import {
  quoteFor,
  readCommentAnchor,
  resolveThreads,
  type LocalCommentAnchor,
  type OrphanThread,
  type ResolvedRange,
  type ResolvedThread,
  type YjsCommentAnchor
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

// ── The live document's half ────────────────────────────────────────────────
// A co-edited document makes an offset stale the moment anyone inserts before
// it, and nothing tells the other peers that a comment moved. A Yjs
// RelativePosition references the ITEM rather than a count, so it survives
// concurrent edits by construction — which is the whole reason a live anchor
// is not just a range.
//
// This is also why the resolver works in document positions:
// relativePositionToAbsolutePosition accumulates nodeSize and so returns a
// PROSEMIRROR POSITION. It goes straight in as a candidate with nothing
// converted. (ec's point, and the one that decided between our two designs.)

/**
 * y-prosemirror's ProsemirrorMapping, which its entry point does not
 * re-export. Taken from the function's own signature rather than restated or
 * reached for down a dist/ path, so it cannot drift from the version installed.
 */
type ProsemirrorMapping = Parameters<typeof absolutePositionToRelativePosition>[2]

interface YState {
  doc: Y.Doc
  type: Y.XmlFragment
  mapping: ProsemirrorMapping
}

/** The ySync binding, or null in an editor that is not co-editing. */
function yStateOf(editor: Editor): YState | null {
  const st = ySyncPluginKey.getState(editor.state) as
    | { doc?: Y.Doc; type?: Y.XmlFragment; binding?: { mapping?: ProsemirrorMapping; isDestroyed?: boolean } }
    | undefined
  if (!st?.doc || !st.type || !st.binding || st.binding.isDestroyed) return null
  if (!st.binding.mapping) return null
  return { doc: st.doc, type: st.type, mapping: st.binding.mapping }
}

/** True when this editor is bound to a Y.Doc, so a live anchor can be made. */
export const isCollabEditor = (editor: Editor): boolean => yStateOf(editor) !== null

/**
 * The anchor to store for a new comment in a LIVE document.
 *
 * Null when the editor is not co-editing, which is the caller's signal to make
 * a local anchor instead — rather than writing a yjs anchor whose relative
 * positions came from nowhere.
 */
export function yjsAnchorFor(editor: Editor, from: number, to: number): YjsCommentAnchor | null {
  const y = yStateOf(editor)
  if (!y) return null
  const start = absolutePositionToRelativePosition(from, y.type, y.mapping)
  const end = absolutePositionToRelativePosition(to, y.type, y.mapping)
  if (!start || !end) return null
  const quote = quoteFor(positionText(editor.state.doc), from, to)
  return {
    kind: 'yjs',
    start: Y.relativePositionToJSON(start) as Record<string, unknown>,
    end: Y.relativePositionToJSON(end) as Record<string, unknown>,
    // The quote is stored for a live anchor TOO, and it is not redundant: a
    // relative position survives concurrent editing but not the deletion of
    // the item it references, and it cannot survive a body replaced wholesale
    // outside the CRDT. The quote is what distinguishes "moved" from "gone".
    ...(quote ? { quote } : {})
  }
}

/**
 * Where a live anchor's relative positions point in the document right now.
 *
 * Null when either end no longer resolves — the item it referenced is gone —
 * which hands the quote the job of deciding whether the passage moved or was
 * removed.
 */
export function yjsCandidate(editor: Editor, anchor: YjsCommentAnchor): ResolvedRange | null {
  const y = yStateOf(editor)
  if (!y) return null
  try {
    const from = relativePositionToAbsolutePosition(
      y.doc,
      y.type,
      Y.createRelativePositionFromJSON(anchor.start),
      y.mapping
    )
    const to = relativePositionToAbsolutePosition(y.doc, y.type, Y.createRelativePositionFromJSON(anchor.end), y.mapping)
    if (from === null || to === null || to <= from) return null
    return { from, to }
  } catch {
    // The relative positions have been through a database and an HTTP
    // boundary; a malformed one is absent, not a crash in the editor.
    return null
  }
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
 * A yjs anchor's candidate comes from its relative positions when this editor
 * is co-editing, and is null otherwise — in which case the resolver falls back
 * to finding its quote, exact and unique or nothing. Either way the caller must
 * NOT write a `corrected` range back as a LOCAL anchor for such a thread: that
 * would overwrite the relative positions with offsets, permanently. Branch on
 * `anchorOf(thread).kind`.
 */
export function resolveForEditor(
  editor: Editor,
  threads: readonly CommentAnchorInput[]
): { ranges: ResolvedThread[]; orphans: OrphanThread[] } {
  return resolveThreads(
    threads.map((t) => {
      const parsed = readCommentAnchor(t.anchor)
      const base = { id: t.id, anchor: t.anchor, state: t.state }
      return parsed?.kind === 'yjs' ? { ...base, candidate: yjsCandidate(editor, parsed) } : base
    }),
    positionText(editor.state.doc)
  )
}

/** The parsed anchor for a thread, or null when it has none to read. */
export const anchorOf = (t: CommentAnchorInput): ReturnType<typeof readCommentAnchor> => readCommentAnchor(t.anchor)
