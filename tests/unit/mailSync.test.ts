// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureMailStoreSchema,
  upsertMailHeaders,
  getMailSyncState,
  listStoredMail,
  mailStoreStats,
  type MailDb
} from '../../src/main/db/mailStore'

// The sweep is what makes "Plexii can answer about a message you never opened"
// true rather than aspirational. Before it, the store held the newest page plus
// whatever the user scrolled past, so a levy notice from six months ago was
// outside every window.
//
// What is tested here is the STATE MACHINE, against a fake server that counts
// round trips: that it reaches the bottom of a mailbox, that it then stops asking,
// and that a restart does not begin again. A sweep that silently re-walks a
// mailbox every launch looks identical from the outside to one that works, until
// somebody notices the network traffic or their provider rate-limits them.

const ACC = 'me@example.test'
const CONFIG = { host: 'h', port: 993, secure: true, user: ACC, password: 'p' }

interface FakeMsg {
  uid: number
  subject: string
  date: number
  text: string
}
let db: MailDb
let server: FakeMsg[] = []
let listCalls: Array<{ limit?: number; beforeUid?: number }> = []
let fetchedUids: number[] = []

vi.mock('../../src/main/db/database', () => ({ getDb: () => db }))
vi.mock('../../src/main/mail/mailAccount', () => ({
  getFull: () => CONFIG,
  getAccountKey: () => ACC
}))
vi.mock('../../src/main/fileText', () => ({ extractTextFromBuffer: async () => null }))
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
      fromName: 'S',
      fromAddress: 's@e.test',
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

const { sweepOnce, mailSyncProgress } = await import('../../src/main/mail/mailSync')

/** A mailbox of `n` messages, uid n down to 1, one per day descending. */
const mailbox = (n: number): FakeMsg[] =>
  Array.from({ length: n }, (_, i) => ({
    uid: n - i,
    subject: `Message ${n - i}`,
    date: Date.UTC(2026, 0, 1) - i * 86_400_000,
    text: `body of ${n - i}`
  }))

beforeEach(() => {
  db = new DatabaseSync(':memory:') as unknown as MailDb
  ensureMailStoreSchema(db)
  server = []
  listCalls = []
  fetchedUids = []
})

describe('the sweep reaches the bottom of a mailbox', () => {
  it('walks headers back across ticks until nothing older is left', async () => {
    server = mailbox(150)
    // Simulate the newest page already being stored by an ordinary listing.
    upsertMailHeaders(
      db,
      server.slice(0, 40).map((m) => ({ uid: m.uid, subject: m.subject, date: m.date })),
      { accountKey: ACC }
    )

    let guard = 0
    while (!getMailSyncState(db, { accountKey: ACC }).headersComplete && guard++ < 20) {
      await sweepOnce(CONFIG)
    }
    expect(getMailSyncState(db, { accountKey: ACC }).headersComplete).toBe(true)
    // Every message in the mailbox is now at least searchable by subject.
    expect(mailStoreStats(db, { accountKey: ACC }).messages).toBe(150)
    // Including the very oldest, which no listing would ever have shown.
    expect(listStoredMail(db, { accountKey: ACC, limit: 200 }).some((m) => m.uid === 1)).toBe(true)
  })

  it('stops asking for older pages once the bottom is recorded', async () => {
    server = mailbox(20)
    let guard = 0
    while (!getMailSyncState(db, { accountKey: ACC }).headersComplete && guard++ < 20) {
      await sweepOnce(CONFIG)
    }
    const callsAtCompletion = listCalls.length
    await sweepOnce(CONFIG)
    await sweepOnce(CONFIG)
    // Two more ticks, no more listing. Phase 1 is genuinely finished.
    expect(listCalls.length).toBe(callsAtCompletion)
  })

  it('a restart does not re-walk a mailbox already read to the bottom', async () => {
    // The one fact that cannot be re-derived from the store. Getting this wrong
    // costs a round trip on every launch, forever, and looks like nothing.
    server = mailbox(20)
    let guard = 0
    while (!getMailSyncState(db, { accountKey: ACC }).headersComplete && guard++ < 20) {
      await sweepOnce(CONFIG)
    }
    // Bodies are done too, so the next tick has nothing at all to do.
    guard = 0
    while (!(await sweepOnce(CONFIG)).idle && guard++ < 30) {
      /* drain */
    }
    listCalls = []
    fetchedUids = []
    const tick = await sweepOnce(CONFIG) // "after a restart"
    expect(tick.idle).toBe(true)
    expect(listCalls).toEqual([])
    expect(fetchedUids).toEqual([])
  })
})

describe('bodies are filled newest-first, in throttled batches', () => {
  it('fetches the newest bodies first, so an interrupted sweep covers what matters', async () => {
    server = mailbox(30)
    upsertMailHeaders(
      db,
      server.map((m) => ({ uid: m.uid, subject: m.subject, date: m.date })),
      { accountKey: ACC }
    )
    await sweepOnce(CONFIG)
    // Newest uid is 30. A batch, not the whole mailbox.
    expect(fetchedUids[0]).toBe(30)
    expect(fetchedUids.length).toBeLessThan(30)
  })

  it('covers every body if left to run', async () => {
    server = mailbox(25)
    let guard = 0
    while (!(await sweepOnce(CONFIG)).idle && guard++ < 40) {
      /* keep sweeping */
    }
    const s = mailStoreStats(db, { accountKey: ACC })
    expect(s.messages).toBe(25)
    expect(s.withBodies).toBe(25)
  })
})

describe('progress is reportable, so coverage is never implied', () => {
  it('reports what has actually been read rather than claiming the whole mailbox', async () => {
    // So an answer can say "I have read 40 of your messages back to March"
    // instead of implying it searched everything.
    server = mailbox(100)
    upsertMailHeaders(
      db,
      server.slice(0, 40).map((m) => ({ uid: m.uid, subject: m.subject, date: m.date })),
      { accountKey: ACC }
    )
    const p = mailSyncProgress()
    expect(p.connected).toBe(true)
    expect(p.messages).toBe(40)
    expect(p.withBodies).toBe(0)
    expect(p.headersComplete).toBe(false)
    expect(p.oldestDate).toBeTruthy()
  })

  it('says so plainly when the sweep has finished', async () => {
    server = mailbox(12)
    let guard = 0
    while (!(await sweepOnce(CONFIG)).idle && guard++ < 30) {
      /* drain */
    }
    const p = mailSyncProgress()
    expect(p.headersComplete).toBe(true)
    expect(p.withBodies).toBe(12)
  })
})

describe('an empty mailbox is finished, not stuck', () => {
  it('records completion without a single message', async () => {
    server = []
    const tick = await sweepOnce(CONFIG)
    expect(tick.headersComplete).toBe(true)
    expect(tick.idle).toBe(true)
  })
})
