import { requote, type CommentAnchorInput } from './commentPositions'
import { readCommentAnchor, type CommentAnchor } from '@shared/commentAnchor'

// Whether a resolved thread's anchor should be WRITTEN BACK, and as what.
//
// One rule, in one place, because both hosts need it and getting it wrong in
// either is a silent, permanent data loss rather than a visual glitch.
//
// THE RULE THAT MATTERS: never write back anything but a LOCAL anchor. A live
// document's anchor is a pair of Yjs relative positions, which is the whole
// reason it survives other people typing — an offset goes stale the moment any
// peer inserts before it, and nothing tells the other peers it happened. A yjs
// anchor that resolved by its quote comes back `corrected` as a matter of
// course, not as an exception, so a host that wrote every corrected range back
// as a local anchor would quietly convert every live comment into a fragile one
// the first time anybody opened the document.
//
// The rest is restraint: a write for a range and quote that have not changed is
// a database write per thread per open, and on a live document it is also an
// HTTP request that most readers are not even permitted to make.

export interface WriteBack {
  /** The anchor JSON to store, verbatim. */
  json: string
  /**
   * Why, for the caller's logging and for a reader of this code:
   *   moved     the resolver re-found the text somewhere else
   *   requoted  same range, but the text under it was edited in place
   */
  reason: 'moved' | 'requoted'
}

/**
 * The anchor to persist for a thread the resolver placed at `range`, or null
 * when nothing should be written.
 *
 * `docText` is the string the ranges were resolved against — pass the same one,
 * since a quote taken from a different string is a quote of different text.
 */
export function anchorToPersist(
  thread: CommentAnchorInput,
  range: { from: number; to: number },
  docText: string
): WriteBack | null {
  const stored: CommentAnchor | null = readCommentAnchor(thread.anchor)
  // Nothing stored to correct. A thread anchored the old way, by a mark in the
  // body, is not broken and must not be given an anchor behind the user's back.
  if (!stored) return null
  // The guard this module exists for.
  if (stored.kind !== 'local') return null

  const fresh = requote(docText, { kind: 'local', from: range.from, to: range.to })
  // No text under the range any more. Keep what is stored: the comment will
  // orphan on the next open, which is the truth, and overwriting the anchor
  // with a quoteless one would destroy the only means of finding it again.
  if (!fresh) return null

  const sameRange = stored.from === fresh.from && stored.to === fresh.to
  const sameQuote = stored.quote?.text === fresh.quote?.text
  if (sameRange && sameQuote) return null

  return { json: JSON.stringify(fresh), reason: sameRange ? 'requoted' : 'moved' }
}
