// Copying a local document's comments onto the live copy, when the person
// sharing asks for it.
//
// OFF BY DEFAULT, and that is a decision rather than a default: a comment on a
// document only you can see is a private note. "Fix this before Sarah reads it"
// is exactly the kind of thing people write to themselves, and publishing it to
// Sarah as a side effect of sharing the file would be the sort of surprise you
// only get to cause once. So the share dialog asks, unticked, and this runs
// only when it is ticked.
//
// WHAT IS TRUE AND WHAT IS NOT, since the copies are shown to other people as
// fact:
//   - the AUTHOR becomes the sharer. True for a local document, which has one
//     user; the owner's ruling, and there is no other account to attribute to.
//   - the TIME is the comment's REAL creation time, carried through the
//     server's `createdAt` (owner-only, see comments.ts). Showing a month-old
//     note as written now would be a false timestamp on somebody's screen.
//   - the RESOLVED state travels, because a resolved thread arriving open is
//     the same kind of small lie.
//   - the ANCHOR is converted local -> live with its quote VERIFIED first
//     (commentShareConvert.ts). A comment whose text cannot be found travels
//     with NO anchor rather than a guessed one: it keeps its words and loses
//     its highlight, which is the truth about a passage that has gone.
//
// Dependency-injected so the decisions above are testable without a network or
// a dialog: what gets posted, in what order, with which anchor and which time.

import type { Schema } from 'prosemirror-model'
import type { addComment as addCommentFn, resolveComment as resolveCommentFn } from './docCollabClient'
import { convertAnchorsForShare } from './commentShareConvert'

/** A local comment row, as `documents.listComments` returns it. */
export interface LocalCommentRow {
  id: string
  parentId: string | null
  anchor: string | null
  body: string
  resolved: boolean
  createdAt: number
}

export interface ShareCopyResult {
  /** Threads copied. */
  threads: number
  /** Replies copied. */
  replies: number
  /** Of those threads, how many travelled with no anchor — no highlight. */
  unanchored: number
  /** Threads the server refused. Their replies are skipped with them. */
  failedThreads: number
  /** Replies the server refused, or whose thread never landed. */
  failedReplies: number
  /** Copied threads whose resolved state could not be set. */
  notResolved: number
  /**
   * Copies the server timed ITSELF rather than keeping the comment's real time.
   *
   * Detected from the row it hands back, not guessed from a version: a server
   * without the `createdAt` field ignores it and returns `now`. That is the
   * honest trigger for saying "added when shared" instead of showing a date
   * the comment was not written on — and it stops being true, with no client
   * change, the moment the server honours the field.
   */
  timeNotKept: number
}

export const EMPTY_COPY: ShareCopyResult = {
  threads: 0,
  replies: 0,
  unanchored: 0,
  failedThreads: 0,
  failedReplies: 0,
  notResolved: 0,
  timeNotKept: 0
}

/**
 * Did the server keep the time we asked for?
 *
 * A second of slack, because the server rounds and clamps to its own clock; a
 * server that ignored the field answers with its own `now`, which is minutes to
 * months away from a comment's real creation.
 */
const keptTime = (asked: number, got: number | undefined): boolean =>
  typeof got === 'number' && Math.abs(got - asked) <= 1000

/**
 * Post every local comment onto the live document, oldest first.
 *
 * Ids are NOT reused. A local id is a UUID and would pass the server's
 * client-minted id check, but `doc_comments.id` is a primary key across the
 * whole table, so sharing the same local document twice would collide on the
 * second share and fail. The server mints, and the returned ids are mapped so
 * replies find their thread.
 */
export async function copyCommentsToLiveDoc(
  args: {
    token: string
    liveDocId: string
    /** The ProseMirror document the live copy will be seeded from. */
    pmJSON: object
    schema: Schema
    comments: readonly LocalCommentRow[]
  },
  api: { addComment: typeof addCommentFn; resolveComment: typeof resolveCommentFn }
): Promise<ShareCopyResult> {
  const out: ShareCopyResult = { ...EMPTY_COPY }
  const byAge = (a: LocalCommentRow, b: LocalCommentRow): number => a.createdAt - b.createdAt
  const roots = args.comments.filter((c) => !c.parentId).sort(byAge)
  if (!roots.length) return out

  const { converted } = convertAnchorsForShare(
    args.pmJSON,
    args.schema,
    roots.map((r) => ({ id: r.id, anchor: r.anchor }))
  )

  // Local thread id -> the id the server gave its copy.
  const landed = new Map<string, string>()
  for (const root of roots) {
    const live = converted.get(root.id)
    const created = await api
      .addComment(args.token, args.liveDocId, root.body, {
        anchor: live ? JSON.stringify(live) : null,
        createdAt: root.createdAt
      })
      .catch(() => null)
    if (!created) {
      out.failedThreads += 1
      continue
    }
    landed.set(root.id, created.id)
    out.threads += 1
    if (!live) out.unanchored += 1
    if (!keptTime(root.createdAt, created.createdAt)) out.timeNotKept += 1
    if (root.resolved) {
      const ok = await api
        .resolveComment(args.token, created.id, true)
        .then(() => true)
        .catch(() => false)
      if (!ok) out.notResolved += 1
    }
  }

  for (const reply of args.comments.filter((c) => c.parentId).sort(byAge)) {
    const parent = landed.get(reply.parentId!)
    if (!parent) {
      // Its thread never landed, so there is nothing to attach it to. Posting
      // it as a new thread would turn a reply into a comment of its own.
      out.failedReplies += 1
      continue
    }
    const created = await api
      .addComment(args.token, args.liveDocId, reply.body, { parentId: parent, createdAt: reply.createdAt })
      .catch(() => null)
    if (created) {
      out.replies += 1
      if (!keptTime(reply.createdAt, created.createdAt)) out.timeNotKept += 1
    } else out.failedReplies += 1
  }
  return out
}

/** One line for the share dialog: what travelled, and what did not. */
export function describeCopy(r: ShareCopyResult): string | null {
  if (!r.threads && !r.failedThreads) return null
  const bits: string[] = []
  const all = r.threads + r.replies
  if (all) bits.push(`${all} comment${all === 1 ? '' : 's'} shared`)
  if (r.unanchored) bits.push(`${r.unanchored} without a highlight (the text had changed)`)
  // Said plainly rather than shown as a date the comment was not written on.
  if (r.timeNotKept) bits.push(`${r.timeNotKept} shown as added when shared`)
  const failed = r.failedThreads + r.failedReplies
  if (failed) bits.push(`${failed} could not be copied`)
  if (r.notResolved) bits.push(`${r.notResolved} arrived unresolved`)
  return bits.join(' · ')
}
