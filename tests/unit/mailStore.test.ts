// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureMailStoreSchema,
  upsertMailHeaders,
  upsertMailBody,
  upsertMailAttachments,
  listStoredMail,
  getStoredMail,
  getStoredAttachments,
  mailMissingBodies,
  mailStoreStats,
  searchStoredMail,
  toMailFtsQuery,
  clearStoredMail,
  type MailDb
} from '../../src/main/db/mailStore'

// Mail had nowhere to live: mail:list hit IMAP, handed the page to the renderer
// and kept a few fields in a module-level array. So the assistant knew only about
// messages the user had already opened in this session, and could not answer
// "what did the landlord say about the deposit?" about anything from March.
//
// These run REAL fts5 through node:sqlite for the same reason chunkIndex.test.ts
// does: the value of this module is its search ORDER and its match expression,
// and a mocked database cannot vouch for either.

const ACC = 'me@example.test'

function freshDb(): MailDb {
  const db = new DatabaseSync(':memory:') as unknown as MailDb
  ensureMailStoreSchema(db)
  return db
}

const day = (n: number): number => Date.UTC(2026, 0, n)

let db: MailDb
beforeEach(() => {
  db = freshDb()
})

function seed(
  uid: number,
  subject: string,
  date: number,
  body?: string,
  extra: Partial<{ fromName: string; fromAddress: string; seen: boolean; hasAttachments: boolean }> = {}
): void {
  upsertMailHeaders(db, [{ uid, subject, date, fromName: 'Sender', ...extra }], { accountKey: ACC })
  if (body !== undefined) upsertMailBody(db, uid, { accountKey: ACC, text: body })
}

describe('storing headers, then bodies, then attachments', () => {
  it('a message is readable from the store without ever being opened', () => {
    seed(1, 'Deposit return', day(10), 'We will return the deposit of £1,450 by Friday.')
    const m = getStoredMail(db, 1, { accountKey: ACC })
    expect(m?.subject).toBe('Deposit return')
    expect(m?.bodyText).toContain('£1,450')
  })

  it('re-listing refreshes read state without wiping a body already fetched', () => {
    // A listing page carries no body. Letting it overwrite one is how a store
    // quietly empties itself on the next refresh.
    seed(1, 'Deposit return', day(10), 'Full body text here.', { seen: false })
    upsertMailHeaders(db, [{ uid: 1, subject: 'Deposit return', date: day(10), seen: true }], {
      accountKey: ACC
    })
    const m = getStoredMail(db, 1, { accountKey: ACC })
    expect(m?.seen).toBe(true)
    expect(m?.bodyText).toBe('Full body text here.')
  })

  it('tracks which messages still need a body, newest first', () => {
    seed(1, 'Old one', day(1))
    seed(2, 'Newer one', day(20))
    seed(3, 'Has a body', day(10), 'body')
    const missing = mailMissingBodies(db, { accountKey: ACC })
    expect(missing.map((m) => m.uid)).toEqual([2, 1])
  })

  it('stores attachment text, not attachment bytes', () => {
    seed(1, 'Lease', day(10), 'See attached.', { hasAttachments: true })
    upsertMailAttachments(
      db,
      1,
      [{ filename: 'lease.pdf', contentType: 'application/pdf', sizeBytes: 90_000, textContent: 'Break clause at 18 months.' }],
      { accountKey: ACC }
    )
    const atts = getStoredAttachments(db, 1, { accountKey: ACC })
    expect(atts).toHaveLength(1)
    expect(atts[0].textContent).toContain('Break clause')
    expect(atts[0].sizeBytes).toBe(90_000)
  })

  it('reports what it holds, so a caller can tell a cold store from an empty mailbox', () => {
    seed(1, 'One', day(5), 'body')
    seed(2, 'Two', day(9))
    const s = mailStoreStats(db, { accountKey: ACC })
    expect(s.messages).toBe(2)
    expect(s.withBodies).toBe(1)
    expect(s.newestDate).toBe(day(9))
    expect(s.oldestDate).toBe(day(5))
  })
})

describe('reading is newest first', () => {
  it('lists most recent first and pages backwards through history', () => {
    seed(1, 'Jan 2', day(2))
    seed(2, 'Jan 20', day(20))
    seed(3, 'Jan 11', day(11))
    expect(listStoredMail(db, { accountKey: ACC }).map((m) => m.uid)).toEqual([2, 3, 1])
    // beforeDate is how a caller keeps walking back.
    expect(
      listStoredMail(db, { accountKey: ACC, beforeDate: day(11) }).map((m) => m.uid)
    ).toEqual([1])
  })
})

describe('the question becomes a usable fts query', () => {
  it('keeps the distinctive words and drops the ones that match everything', () => {
    const q = toMailFtsQuery('What did the landlord say about the deposit?')
    expect(q).toContain('landlord')
    expect(q).toContain('deposit')
    // "what", "did", "the", "say", "about" match nearly every message, which turns
    // a search into a scan and buries the one that matters.
    expect(q).not.toContain('"what"')
    expect(q).not.toContain('"about"')
  })

  it('ORs the terms, so one missing word cannot hide the answer', () => {
    expect(toMailFtsQuery('landlord deposit')).toContain(' OR ')
  })

  it('returns null when nothing usable survives, rather than matching everything', () => {
    // A caller must be able to tell "no query" from "query that matches all mail".
    expect(toMailFtsQuery('what about the')).toBeNull()
    expect(toMailFtsQuery('   ')).toBeNull()
    expect(toMailFtsQuery('?!')).toBeNull()
  })

  it('survives punctuation that fts5 would otherwise read as syntax', () => {
    expect(() => searchStoredMail(db, 'the "deposit" -- (refund)?', { accountKey: ACC })).not.toThrow()
  })
})

describe('search walks newest to oldest', () => {
  beforeEach(() => {
    // The same topic, three years apart. The old one repeats the word more often,
    // which is exactly the case where relevance ranking picks the wrong message.
    seed(1, 'Deposit terms', Date.UTC(2023, 0, 5), 'deposit deposit deposit deposit terms of the deposit')
    seed(2, 'Re: deposit', Date.UTC(2026, 0, 20), 'The deposit will be returned on the 3rd.')
    seed(3, 'Unrelated', Date.UTC(2026, 0, 25), 'Lunch on Thursday?')
  })

  it('returns the most RECENT match first, not the most keyword-dense', () => {
    const hits = searchStoredMail(db, 'deposit', { accountKey: ACC })
    expect(hits.map((h) => h.message.uid)).toEqual([2, 1])
  })

  it('does not return messages that do not match at all', () => {
    const hits = searchStoredMail(db, 'deposit', { accountKey: ACC })
    expect(hits.map((h) => h.message.uid)).not.toContain(3)
  })

  it('pages further back with beforeDate, which is how a caller keeps looking', () => {
    const first = searchStoredMail(db, 'deposit', { accountKey: ACC, limit: 1 })
    expect(first[0].message.uid).toBe(2)
    const next = searchStoredMail(db, 'deposit', {
      accountKey: ACC,
      limit: 1,
      beforeDate: first[0].message.date
    })
    expect(next[0].message.uid).toBe(1)
  })

  it('finds a message by its subject, its sender or its body', () => {
    seed(9, 'Invoice 4021', day(15), 'Payment is due in 30 days.', {
      fromName: 'Aisha Kelani',
      fromAddress: 'aisha@vendor.test'
    })
    expect(searchStoredMail(db, 'Invoice 4021', { accountKey: ACC }).map((h) => h.message.uid)).toContain(9)
    expect(searchStoredMail(db, 'Kelani', { accountKey: ACC }).map((h) => h.message.uid)).toContain(9)
    expect(searchStoredMail(db, 'payment due', { accountKey: ACC }).map((h) => h.message.uid)).toContain(9)
  })

  it('finds a message by the text inside its attachment', () => {
    // The point of storing attachment text: "what was the break clause?" is
    // answered by a PDF, not by anything in the message body.
    seed(7, 'Lease pack', day(12), 'See attached.', { hasAttachments: true })
    upsertMailAttachments(
      db,
      7,
      [{ filename: 'lease.pdf', contentType: 'application/pdf', sizeBytes: 1, textContent: 'Break clause at 18 months.' }],
      { accountKey: ACC }
    )
    const hits = searchStoredMail(db, 'break clause', { accountKey: ACC })
    expect(hits.map((h) => h.message.uid)).toContain(7)
    expect(hits[0].attachments[0].filename).toBe('lease.pdf')
  })

  it('a body arriving later becomes searchable', () => {
    // Headers land from the listing; the body is backfilled minutes later. The
    // index has to pick that up or the store is only ever as good as its subjects.
    seed(5, 'Quarterly', day(18))
    expect(searchStoredMail(db, 'dilapidations', { accountKey: ACC })).toHaveLength(0)
    upsertMailBody(db, 5, { accountKey: ACC, text: 'A note on dilapidations.' })
    expect(searchStoredMail(db, 'dilapidations', { accountKey: ACC }).map((h) => h.message.uid)).toEqual([5])
  })

  it('matches across singular and plural in both directions', () => {
    // Prefix matching only works one way — "receipt"* finds "receipts", and the
    // reverse finds nothing — so asking with the plural must not miss the message.
    seed(6, 'Receipt', day(19), 'Your receipt is attached.')
    seed(8, 'Invoices', day(17), 'Two invoices attached.')
    expect(searchStoredMail(db, 'receipt', { accountKey: ACC }).map((h) => h.message.uid)).toContain(6)
    expect(searchStoredMail(db, 'receipts', { accountKey: ACC }).map((h) => h.message.uid)).toContain(6)
    expect(searchStoredMail(db, 'invoice', { accountKey: ACC }).map((h) => h.message.uid)).toContain(8)
    expect(searchStoredMail(db, 'invoices', { accountKey: ACC }).map((h) => h.message.uid)).toContain(8)
  })

  it('does not butcher a word that legitimately ends in ss', () => {
    seed(10, 'Address change', day(16), 'My new address is on the form.')
    expect(searchStoredMail(db, 'address', { accountKey: ACC }).map((h) => h.message.uid)).toContain(10)
  })
})

describe('accounts and mailboxes stay separate', () => {
  it('a uid means nothing without its mailbox, so the two never collide', () => {
    upsertMailHeaders(db, [{ uid: 1, subject: 'Mine', date: day(5) }], { accountKey: ACC })
    upsertMailHeaders(db, [{ uid: 1, subject: 'Theirs', date: day(6) }], { accountKey: 'other@example.test' })
    expect(getStoredMail(db, 1, { accountKey: ACC })?.subject).toBe('Mine')
    expect(getStoredMail(db, 1, { accountKey: 'other@example.test' })?.subject).toBe('Theirs')
  })

  it('search is scoped to one account', () => {
    upsertMailHeaders(db, [{ uid: 1, subject: 'deposit mine', date: day(5) }], { accountKey: ACC })
    upsertMailHeaders(db, [{ uid: 2, subject: 'deposit theirs', date: day(9) }], {
      accountKey: 'other@example.test'
    })
    const hits = searchStoredMail(db, 'deposit', { accountKey: ACC })
    expect(hits.map((h) => h.message.uid)).toEqual([1])
  })

  it('the account key is case-insensitive, since logins are', () => {
    upsertMailHeaders(db, [{ uid: 1, subject: 'Mine', date: day(5) }], { accountKey: 'Me@Example.Test' })
    expect(getStoredMail(db, 1, { accountKey: 'me@example.test' })?.subject).toBe('Mine')
  })

  it('disconnecting an account clears its mail and leaves the other alone', () => {
    upsertMailHeaders(db, [{ uid: 1, subject: 'deposit mine', date: day(5) }], { accountKey: ACC })
    upsertMailHeaders(db, [{ uid: 2, subject: 'deposit theirs', date: day(9) }], {
      accountKey: 'other@example.test'
    })
    clearStoredMail(db, { accountKey: ACC })
    expect(listStoredMail(db, { accountKey: ACC })).toHaveLength(0)
    expect(listStoredMail(db, { accountKey: 'other@example.test' })).toHaveLength(1)
    // And the index went with it, rather than leaving orphaned rows that match.
    expect(searchStoredMail(db, 'deposit', { accountKey: ACC })).toHaveLength(0)
  })
})
