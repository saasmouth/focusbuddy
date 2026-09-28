// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ensureMailStoreSchema, upsertMailHeaders, upsertMailBody, type MailDb } from '../../src/main/db/mailStore'

// "Keep searching from latest to oldest until it finds the answer."
//
// The widening loop is the whole feature, so it is tested against a fake mail
// server that counts what it was asked for. What matters is not only that the
// right message comes back, but that getting it cost the right number of round
// trips: a loop that fetches every body on every question is a different bug from
// one that never widens at all, and both would pass a test that only checked the
// result.

let db: MailDb
const ACC = 'me@example.test'
const CONFIG = { host: 'h', port: 993, secure: true, user: ACC, password: 'p' }

/** The fake mailbox: uid → message. Older uids are lower, as IMAP guarantees. */
interface FakeMsg {
  uid: number
  subject: string
  date: number
  text: string
}
let server: FakeMsg[] = []
let listCalls: Array<{ limit?: number; beforeUid?: number }> = []
let fetchedUids: number[] = []

vi.mock('../../src/main/db/database', () => ({ getDb: () => db }))

vi.mock('../../src/main/mail/imap', () => ({
  listInbox: async (_c: unknown, opts: { limit?: number; beforeUid?: number } = {}) => {
    listCalls.push(opts)
    const limit = opts.limit ?? 40
    const pool = opts.beforeUid ? server.filter((m) => m.uid < opts.beforeUid!) : server
    const items = [...pool].sort((a, b) => b.uid - a.uid).slice(0, limit)
    return { items, hasMore: pool.length > items.length, nextCursor: null, total: server.length }
  },
  getMessageForIngest: async (_c: unknown, uid: number) => {
    fetchedUids.push(uid)
    const m = server.find((x) => x.uid === uid)
    if (!m) return null
    return {
      uid,
      fromName: 'Sender',
      fromAddress: 's@example.test',
      toText: 'me',
      subject: m.subject,
      date: m.date,
      text: m.text,
      messageId: `<${uid}@t>`,
      inReplyTo: null,
      references: [],
      attachments: []
    }
  }
}))

vi.mock('../../src/main/fileText', () => ({ extractTextFromBuffer: async () => null }))

const { findInMail, ingestOlderPage, backfillBodies } = await import('../../src/main/mail/mailIngest')

const day = (n: number): number => Date.UTC(2026, 0, n)

beforeEach(() => {
  db = new DatabaseSync(':memory:') as unknown as MailDb
  ensureMailStoreSchema(db)
  server = []
  listCalls = []
  fetchedUids = []
})

/** Put headers in the store without a body, as a listing would. */
const storeHeaders = (msgs: FakeMsg[]): void => {
  upsertMailHeaders(
    db,
    msgs.map((m) => ({ uid: m.uid, subject: m.subject, date: m.date })),
    { accountKey: ACC }
  )
}

describe('a question answered from what is already stored', () => {
  it('costs no round trips at all', async () => {
    storeHeaders([{ uid: 10, subject: 'Deposit', date: day(20), text: '' }])
    upsertMailBody(db, 10, { accountKey: ACC, text: 'The deposit is £1,450.' })
    const r = await findInMail('deposit', CONFIG, { want: 1 })
    expect(r.hits.map((h) => h.message.uid)).toEqual([10])
    expect(r.rounds).toBe(0)
    expect(r.fetched).toBe(0)
    expect(listCalls).toHaveLength(0)
  })
})

describe('a subject-line match gets its body fetched before being judged', () => {
  it('fetches the body, because a subject rarely contains the answer', async () => {
    server = [{ uid: 10, subject: 'Deposit return', date: day(20), text: 'We will return £1,450.' }]
    storeHeaders(server) // headers only — body_at is NULL
    const r = await findInMail('deposit', CONFIG, { want: 1 })
    expect(fetchedUids).toEqual([10])
    expect(r.fetched).toBe(1)
    expect(r.hits[0].message.bodyText).toContain('£1,450')
  })

  it('does not fetch the same body twice on a later question', async () => {
    server = [{ uid: 10, subject: 'Deposit return', date: day(20), text: 'We will return £1,450.' }]
    storeHeaders(server)
    await findInMail('deposit', CONFIG, { want: 1 })
    fetchedUids = []
    const r = await findInMail('deposit', CONFIG, { want: 1 })
    expect(fetchedUids).toEqual([])
    expect(r.fetched).toBe(0)
  })
})

describe('when the store does not have it, the search reaches further back', () => {
  it('walks back through history until the answer is found', async () => {
    // The answer is old and nothing about it is stored yet. Only the newest page
    // has been seen, and it is all irrelevant.
    server = [
      { uid: 100, subject: 'Lunch', date: day(28), text: 'Thursday?' },
      { uid: 99, subject: 'Standup', date: day(27), text: 'Notes.' },
      { uid: 40, subject: 'Dilapidations schedule', date: day(3), text: 'The dilapidations total £8,200.' }
    ]
    storeHeaders([server[0], server[1]])

    const r = await findInMail('dilapidations', CONFIG, { want: 1 })
    expect(r.hits.map((h) => h.message.uid)).toEqual([40])
    expect(r.rounds).toBeGreaterThan(0)
    // It widened using a cursor, rather than re-listing the same newest page.
    expect(listCalls.some((c) => typeof c.beforeUid === 'number')).toBe(true)
  })

  it('reaches back from the OLDEST thing it knows, not the newest', async () => {
    // Paging from the newest uid would hand back the same page forever.
    storeHeaders([
      { uid: 100, subject: 'a', date: day(28), text: '' },
      { uid: 50, subject: 'b', date: day(10), text: '' }
    ])
    server = [{ uid: 9, subject: 'Deposit', date: day(1), text: 'the deposit' }]
    await findInMail('deposit', CONFIG, { want: 1 })
    expect(listCalls[0].beforeUid).toBe(50)
  })
})

describe('the newest match wins even when an older one is a denser match', () => {
  it('answers with the most recent thing said about the topic', async () => {
    storeHeaders([
      { uid: 5, subject: 'Deposit', date: Date.UTC(2023, 0, 1), text: '' },
      { uid: 90, subject: 'Re: deposit', date: Date.UTC(2026, 0, 20), text: '' }
    ])
    upsertMailBody(db, 5, { accountKey: ACC, text: 'deposit deposit deposit deposit deposit' })
    upsertMailBody(db, 90, { accountKey: ACC, text: 'The deposit lands on the 3rd.' })
    const r = await findInMail('deposit', CONFIG, { want: 2 })
    expect(r.hits.map((h) => h.message.uid)).toEqual([90, 5])
  })
})

describe('running out of history is reported, not disguised', () => {
  it('says it is exhausted rather than implying there is more to find', async () => {
    // "I looked through everything and this is all there is" is a different answer
    // from "here are the first few", and the caller has to be able to tell.
    storeHeaders([{ uid: 3, subject: 'Only mail', date: day(2), text: '' }])
    server = [{ uid: 3, subject: 'Only mail', date: day(2), text: 'nothing relevant' }]
    const r = await findInMail('dilapidations', CONFIG, { want: 5 })
    expect(r.exhausted).toBe(true)
    expect(r.hits).toEqual([])
  })
})

describe('one vague question cannot walk a decade of mail', () => {
  it('stops at maxRounds even when history continues', async () => {
    // A big mailbox where nothing matches: without a ceiling this would page to
    // the beginning of time, one round trip at a time, on every such question.
    server = Array.from({ length: 600 }, (_, i) => ({
      uid: 600 - i,
      subject: `Message ${600 - i}`,
      date: day(1) - i * 86_400_000,
      text: 'nothing relevant here'
    }))
    storeHeaders(server.slice(0, 60))
    const r = await findInMail('dilapidations', CONFIG, { want: 5, maxRounds: 2 })
    expect(r.rounds).toBeLessThanOrEqual(2)
    // Widened at most maxRounds times, not once per page in the mailbox.
    expect(listCalls.length).toBeLessThanOrEqual(3)
  })

  it('a question with no searchable words does not trigger any fetching', async () => {
    // "what about the" reduces to nothing; matching everything would be worse than
    // matching nothing, and paging the whole mailbox for it would be worse still.
    storeHeaders([{ uid: 1, subject: 'x', date: day(1), text: '' }])
    server = [{ uid: 1, subject: 'x', date: day(1), text: 'y' }]
    const r = await findInMail('what about the', CONFIG, { want: 3 })
    expect(r.hits).toEqual([])
    expect(fetchedUids).toEqual([])
  })
})

describe('the background backfill', () => {
  it('fetches bodies newest first and stays inside its budget', async () => {
    server = Array.from({ length: 10 }, (_, i) => ({
      uid: 10 - i,
      subject: `M${10 - i}`,
      date: day(20) - i * 86_400_000,
      text: `body ${10 - i}`
    }))
    storeHeaders(server)
    const r = await backfillBodies(CONFIG, { budget: 3 })
    expect(r.stored).toBe(3)
    // Newest first, so an interrupted pass has done the most useful part.
    expect(fetchedUids).toEqual([10, 9, 8])
    expect(r.remaining).toBe(1) // the probe asks for 1; 7 are still missing
  })

  it('one unreadable message does not end the pass', async () => {
    storeHeaders([
      { uid: 3, subject: 'a', date: day(3), text: '' },
      { uid: 2, subject: 'b', date: day(2), text: '' }
    ])
    // uid 3 is absent from the server (deleted between listing and fetch).
    server = [{ uid: 2, subject: 'b', date: day(2), text: 'body b' }]
    const r = await backfillBodies(CONFIG, { budget: 5 })
    expect(r.attempted).toBe(2)
    expect(r.stored).toBe(1)
  })
})

describe('widening returns how much it added, so a caller can stop', () => {
  it('reports zero when there is nothing older', async () => {
    storeHeaders([{ uid: 1, subject: 'oldest', date: day(1), text: '' }])
    server = [{ uid: 1, subject: 'oldest', date: day(1), text: '' }]
    expect(await ingestOlderPage(CONFIG)).toBe(0)
  })
})
