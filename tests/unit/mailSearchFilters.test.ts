// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureMailStoreSchema,
  upsertMailHeaders,
  upsertMailBody,
  searchStoredMail,
  type MailDb
} from '../../src/main/db/mailStore'

// There was no way to find an email by any means: no text search, no filters. The
// store already held an fts5 index over subject, sender, body and attachment text,
// so this is about the query surface rather than the data.
//
// Filters deliberately speak InboxRules — the same vocabulary a saved tag and a
// desk's inbox widget already use — so a search can become a tag and a tag can be
// previewed as a search, instead of two languages that drift apart.

const ACC = 'me@example.test'
let db: MailDb

const day = (n: number): number => Date.UTC(2026, 0, n)
const daysAgo = (n: number): number => Date.now() - n * 86_400_000

beforeEach(() => {
  db = new DatabaseSync(':memory:') as unknown as MailDb
  ensureMailStoreSchema(db)
})

interface Seed {
  uid: number
  subject: string
  date: number
  body?: string
  fromName?: string
  fromAddress?: string
  seen?: boolean
  flagged?: boolean
  hasAttachments?: boolean
}
const seed = (m: Seed): void => {
  upsertMailHeaders(
    db,
    [
      {
        uid: m.uid,
        subject: m.subject,
        date: m.date,
        fromName: m.fromName ?? 'Sender',
        fromAddress: m.fromAddress ?? 's@example.test',
        seen: m.seen ?? true,
        flagged: m.flagged ?? false,
        hasAttachments: m.hasAttachments ?? false
      }
    ],
    { accountKey: ACC }
  )
  if (m.body !== undefined) upsertMailBody(db, m.uid, { accountKey: ACC, text: m.body })
}
const find = (q: string, filter = {}, limit = 50): number[] =>
  searchStoredMail(db, q, { accountKey: ACC, limit, filter }).map((h) => h.message.uid)

describe('finding an email by string', () => {
  beforeEach(() => {
    seed({ uid: 1, subject: 'Strata levy notice', date: day(10), body: '12 Campbell Street, Northmead. $1,240 due.' })
    seed({ uid: 2, subject: 'Lunch', date: day(11), body: 'Thursday?' })
    seed({ uid: 3, subject: 'Invoice 88', date: day(12), body: 'Payment terms 30 days.', fromName: 'Aisha Kelani' })
  })

  it('matches the subject', () => expect(find('levy')).toContain(1))

  it('matches the body, which is the case a subject search misses', () => {
    // "Campbell Street" appears nowhere in any subject line.
    expect(find('Campbell Street')).toEqual([1])
  })

  it('matches the sender', () => expect(find('Kelani')).toEqual([3]))

  it('returns newest first', () => expect(find('a')).toEqual(find('a').slice().sort((x, y) => y - x)))

  it('finds nothing for a term nobody used, rather than everything', () => {
    expect(find('dilapidations')).toEqual([])
  })

  it('is not confused by punctuation a user would naturally type', () => {
    expect(() => find('"levy" -- (notice)?')).not.toThrow()
    expect(find('levy?')).toContain(1)
  })

  it('refuses to match everything when the words carry no signal', () => {
    // "what about the" reduces to nothing. Returning the whole mailbox would bury
    // whatever was meant.
    expect(find('what about the')).toEqual([])
  })
})

describe('filters, with or without text', () => {
  beforeEach(() => {
    seed({ uid: 1, subject: 'Unread with file', date: daysAgo(2), seen: false, hasAttachments: true, body: 'levy' })
    seed({ uid: 2, subject: 'Read, flagged', date: daysAgo(3), seen: true, flagged: true, body: 'levy' })
    seed({ uid: 3, subject: 'Old one', date: daysAgo(400), seen: false, body: 'levy' })
    seed({ uid: 4, subject: 'From the agent', date: daysAgo(1), fromName: 'Dana Reed', fromAddress: 'dana@agency.test', body: 'levy' })
  })

  it('filters with NO text at all, which is a real search', () => {
    // "unread, with an attachment" has no words in it and must still work.
    expect(find('', { unreadOnly: true, withAttachments: true })).toEqual([1])
  })

  it('unread only', () => expect(find('', { unreadOnly: true }).sort()).toEqual([1, 3]))
  it('flagged only', () => expect(find('', { flaggedOnly: true })).toEqual([2]))
  it('with attachments', () => expect(find('', { withAttachments: true })).toEqual([1]))

  it('last N days', () => {
    expect(find('', { sinceDays: 7 }).sort()).toEqual([1, 2, 4])
    expect(find('', { sinceDays: 7 })).not.toContain(3)
  })

  it('an absolute date window', () => {
    // Fixed dates, not now-relative ones. `daysAgo` is evaluated once when seeding
    // and again when asserting, so a message seeded "2 days ago" falls just inside
    // a bound computed milliseconds later — a flake, not a finding.
    seed({ uid: 10, subject: 'in window', date: day(10) })
    seed({ uid: 11, subject: 'before window', date: day(4) })
    seed({ uid: 12, subject: 'after window', date: day(20) })
    expect(find('', { after: day(8), before: day(14) })).toEqual([10])
  })

  it('treats `after` as inclusive and `before` as exclusive', () => {
    // Stated, because a half-open range is the only kind that tiles without gaps
    // or overlaps when a UI offers adjacent windows.
    seed({ uid: 20, subject: 'on the lower bound', date: day(8) })
    seed({ uid: 21, subject: 'on the upper bound', date: day(14) })
    expect(find('', { after: day(8), before: day(14) })).toContain(20)
    expect(find('', { after: day(8), before: day(14) })).not.toContain(21)
  })

  it('by sender, matching name or address', () => {
    expect(find('', { from: ['Dana'] })).toEqual([4])
    expect(find('', { from: ['agency.test'] })).toEqual([4])
    expect(find('', { from: ['dana'] })).toEqual([4]) // case-insensitive
  })

  it('by subject substring', () => expect(find('', { subject: ['flagged'] })).toEqual([2]))

  it('any-of within a field', () => {
    expect(find('', { from: ['nobody', 'Dana'] })).toEqual([4])
  })

  it('and-of across fields, so filters narrow rather than widen', () => {
    // From Dana AND unread — Dana's message is read, so nothing.
    expect(find('', { from: ['Dana'], unreadOnly: true })).toEqual([])
  })

  it('text and filters together', () => {
    // Everything says "levy"; only one is unread with a file.
    expect(find('levy', { unreadOnly: true, withAttachments: true })).toEqual([1])
  })

  it('an empty query with no filters is a no-op, not the whole mailbox', () => {
    expect(find('')).toEqual([])
    expect(find('   ')).toEqual([])
  })

  it('ignores blank entries in a filter list rather than matching everything', () => {
    // A UI that splits "a, ,b" on commas will hand over an empty string.
    expect(find('', { from: ['', '  '] })).toEqual([])
  })
})

describe('paging back through results', () => {
  it('pages with beforeDate so a long result set can be walked', () => {
    seed({ uid: 1, subject: 'levy one', date: day(5), body: 'levy' })
    seed({ uid: 2, subject: 'levy two', date: day(9), body: 'levy' })
    const first = searchStoredMail(db, 'levy', { accountKey: ACC, limit: 1 })
    expect(first[0].message.uid).toBe(2)
    const next = searchStoredMail(db, 'levy', {
      accountKey: ACC,
      limit: 1,
      beforeDate: first[0].message.date
    })
    expect(next[0].message.uid).toBe(1)
  })
})

describe('one account cannot see another', () => {
  it('scopes both text and filters to the account', () => {
    seed({ uid: 1, subject: 'mine levy', date: day(5), seen: false })
    upsertMailHeaders(db, [{ uid: 2, subject: 'theirs levy', date: day(9), seen: false }], {
      accountKey: 'other@example.test'
    })
    expect(find('levy')).toEqual([1])
    expect(find('', { unreadOnly: true })).toEqual([1])
  })
})
