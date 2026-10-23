// Comment highlights drawn from STORED RANGES rather than from a mark in the
// document — the half of viewer comments that lives in the editor.
//
// WHY IT IS NOT A MARK. CommentMark anchors a thread by applying a mark, and
// applying a mark is a DOCUMENT WRITE: DocumentEditorView and LiveDocEditorView
// both do `editor.chain().setTextSelection(...).setComment(id).run()`. In a
// live document that mutates the shared Y.Doc and propagates to every peer, so
// a viewer commenting would be writing to a document they may not write to —
// which the signal server now refuses outright. `readOnly` does not save it
// either: `editable: false` gates USER INPUT, not `dispatch`, so a programmatic
// chain still applies. Locally the write is swallowed by DocEditor's readOnly
// guard before onChange, so the highlight survives until reload and then
// vanishes. Resolving and deleting a thread are writes today too, through
// unsetComment, for the same reason.
//
// A decoration is a view-level overlay. Setting one carries no document change,
// so nothing is written, nothing propagates and nothing is refused.
//
// NOTHING IS REMEMBERED ACROSS A REMOUNT, and the host must re-push. A remount
// is a new EditorView with a new plugin state, so the decoration set is gone —
// and that is not a rare path: an external body change (another editor on the
// same document, a body from sync) deliberately remounts the editor, because
// office editors seed their content on mount and a swap without a remount left
// stale text against a current revision. See documents.body_rev and bodyEpoch.
// A remount also has no transaction history, so there is nothing to map through
// even in principle; re-resolving from the stored anchors is the only thing that
// can work. Hence the contract: the host pushes ranges whenever it has them,
// and this file remembers nothing.
//
// SETTING RANGES DOES NOT LOOK LIKE AN EDIT, and that is load-bearing rather
// than incidental. setCommentRanges dispatches a transaction with meta and no
// steps, and TipTap only emits `update` when a transaction actually changed the
// document (Editor.dispatchTransaction: `!transactions.some(tr => tr.docChanged)
// || prevState.doc.eq(state.doc)` returns early — verified in 3.23.6). So the
// host's onChange never fires, the document is not marked dirty and no save is
// triggered by showing a highlight.
//
// THE SEAM. Callers hand over ranges ALREADY RESOLVED to absolute positions in
// the current document; converting from wherever a thread's anchor is stored —
// local offsets, or a Yjs RelativePosition — belongs to the comments layer, not
// here. So there is no Yjs in this file and no anchor model in it either.

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * A thread's highlight, in positions valid for the document AS IT STANDS NOW.
 *
 * Structurally what `resolveThreads` in shared/commentAnchor.ts returns, and
 * deliberately DECLARED here rather than imported from it. The comments layer
 * owns anchors — local offsets, Yjs relative positions, the stored quote, the
 * re-find when text has moved — and none of that belongs in a ProseMirror
 * plugin. Declaring the shape keeps the dependency one-way: this file compiles
 * and is testable without the anchor model, and a `ResolvedThread[]` from it
 * drops straight in.
 *
 * `corrected` is deliberately absent. When a range was re-found rather than
 * believed, the HOST is the one that has to write the corrected anchor back; a
 * decoration cannot persist anything, and a plugin that quietly knew about it
 * would invite the belief that it had.
 */
export interface CommentRange {
  /** The thread's root id — what onCommentClick is called with. */
  id: string
  from: number
  to: number
  /**
   * Resolved threads are not drawn, which is what happens today: resolving a
   * thread calls unsetComment and the highlight disappears. A caller may just
   * leave them out instead; both are honest.
   */
  state?: 'open' | 'resolved'
}

export const commentDecorationsKey = new PluginKey<DecorationSet>('fbCommentDecorations')

const META = 'fbSetCommentRanges'

/** The class the mark already renders, so old marks and new ranges look alike. */
const COMMENT_CLASS = 'fb-comment'

function build(doc: PMNode, ranges: readonly CommentRange[]): DecorationSet {
  const max = doc.content.size
  const decos: Decoration[] = []
  for (const r of ranges) {
    if (r.state === 'resolved') continue
    // CLAMPED, because a stored range can outlive the text it described: the
    // document may have been shortened by an edit this editor never saw (the
    // same document can be open in a desk widget at the same time). An
    // out-of-range position throws inside Decoration.inline, which would take
    // the whole editor down over a stale comment.
    const from = Math.max(0, Math.min(r.from, max))
    const to = Math.max(0, Math.min(r.to, max))
    // An empty range cannot be drawn as an inline decoration, and silently
    // drawing nothing is right: there is no text left to point at.
    if (to <= from) continue
    decos.push(
      Decoration.inline(
        from,
        to,
        { class: COMMENT_CLASS, 'data-comment-id': r.id },
        // Matching CommentMark's `inclusive: false`: typing at either edge of a
        // highlight must not extend the comment over the new text.
        { commentId: r.id, inclusiveStart: false, inclusiveEnd: false }
      )
    )
  }
  return DecorationSet.create(doc, decos)
}

/**
 * The thread whose highlight covers `pos`, or null.
 *
 * For the click target, replacing the mark lookup in DocEditor's handleClick.
 * Overlapping threads resolve to the NARROWEST, which is the most specific
 * thing the user can have meant by clicking there — the mark version took
 * whichever mark came first, which with overlaps was effectively arbitrary.
 */
export function commentIdAt(state: EditorState, pos: number): string | null {
  const set = commentDecorationsKey.getState(state)
  if (!set) return null
  let best: { id: string; width: number } | null = null
  for (const d of set.find(pos, pos)) {
    const id = (d.spec as { commentId?: unknown }).commentId
    if (typeof id !== 'string') continue
    const width = d.to - d.from
    if (!best || width < best.width) best = { id, width }
  }
  return best?.id ?? null
}

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    commentDecorations: {
      /** Replace every comment highlight. Carries no document change. */
      setCommentRanges: (ranges: readonly CommentRange[]) => ReturnType
    }
  }
}

export const CommentDecorations = Extension.create({
  name: 'commentDecorations',

  addCommands() {
    return {
      setCommentRanges:
        (ranges: readonly CommentRange[]) =>
        ({ tr, dispatch }) => {
          // setMeta only: no steps, so tr.docChanged stays false and this is
          // not an edit by any measure the host can see.
          tr.setMeta(META, ranges)
          if (dispatch) dispatch(tr)
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: commentDecorationsKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const next = tr.getMeta(META) as readonly CommentRange[] | undefined
            // A fresh set of ranges is always resolved against THIS doc, so it
            // is built rather than mapped.
            if (next) return build(tr.doc, next)
            // Otherwise follow the text. Mapping is what makes a highlight
            // behave like the mark did while someone types around it — and it
            // is per-editor: an edit made in another view of the same document
            // does not reach this mapping, which is why the ranges a caller
            // stores need their own staleness check.
            return old.map(tr.mapping, tr.doc)
          }
        },
        props: {
          decorations: (state) => commentDecorationsKey.getState(state) ?? DecorationSet.empty
        }
      })
    ]
  }
})
