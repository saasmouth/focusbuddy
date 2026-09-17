// Which UIDs make up one page of the inbox.
//
// Split out of imap.ts and kept pure so the paging arithmetic can be tested
// without a mail server. Everything here is about one question: given every
// UID the mailbox holds, which ones belong to the page the user just asked for?
//
// Paging is by UID VALUE, never by position. Sequence numbers and array indexes
// both shift when mail arrives or is deleted mid-session, so "give me items
// 40-79" silently skips or repeats messages the moment the mailbox changes
// under you. A UID is stable for the life of the mailbox, so "the newest 40
// below UID 1234" means the same thing on the second call as it did on the
// first, however much has landed in between.

export interface UidPage {
  /** The UIDs to fetch, ascending — the order an IMAP fetch wants them in. */
  uids: number[]
  /** True when older messages remain below this page. */
  hasMore: boolean
  /** Feed this back as `beforeUid` to get the next page. */
  nextCursor: number | null
}

/**
 * The newest `limit` UIDs strictly older than `beforeUid`.
 *
 * `beforeUid` undefined means the first page: the newest `limit` overall.
 */
export function pageOfUids(
  allUids: readonly number[],
  limit: number,
  beforeUid?: number
): UidPage {
  const safeLimit = Math.max(1, Math.floor(limit) || 1)
  // The server is not required to return these in any particular order, and
  // "newest" is only meaningful once they are sorted.
  const sorted = [...allUids].filter((u) => Number.isFinite(u)).sort((a, b) => a - b)
  const older =
    beforeUid === undefined ? sorted : sorted.filter((u) => u < beforeUid)
  const uids = older.slice(-safeLimit)
  return {
    uids,
    hasMore: older.length > uids.length,
    // The cursor is the OLDEST uid on this page: the next page is everything
    // below it. Null when the page is empty, because there is nothing to
    // count back from.
    nextCursor: uids.length > 0 ? uids[0] : null
  }
}

/**
 * An IMAP fetch range for a set of UIDs, collapsed into runs.
 *
 * A mailbox with gaps (archived, deleted) would otherwise produce a very long
 * comma list; `4,5,6,9` becomes `4:6,9`. Empty in means empty out, and the
 * caller must skip the fetch entirely rather than send an empty range — an
 * empty range string is a protocol error, not an empty result.
 */
export function uidRange(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const parts: string[] = []
  let runStart = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i <= sorted.length; i++) {
    const u = sorted[i]
    if (i < sorted.length && u === prev + 1) {
      prev = u
      continue
    }
    parts.push(runStart === prev ? String(runStart) : `${runStart}:${prev}`)
    if (i < sorted.length) {
      runStart = u
      prev = u
    }
  }
  return parts.join(',')
}
