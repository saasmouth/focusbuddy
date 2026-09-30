// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureMailStoreSchema,
  upsertMailHeaders,
  upsertMailBody,
  storedThread,
  type MailDb
} from '../../src/main/db/mailStore'

// What a pinned email widget reads. Two modes, and the difference between them is
// the point: pinning one quote must not silently become the twelve replies that
// followed, while pinning a conversation must pick up tomorrow's reply without
// anyone re-adding the widget.

const ACC = 'me@example.test'
let db: MailDb
const day = (n: number): number => Date.UTC(2026, 0, n)

beforeEach(() => {
  db = new DatabaseSync(':memory:') as unknown as MailDb
  ensureMailStoreSchema(db)
})

function seed(
  uid: number,
  subject: string,
  date: number,
  headers: { messageId?: string | null; inReplyTo?: string | null; references?: string[] } = {},
  body = 'body'
): void {
  upsertMailHeaders(db, [{ uid, subject, date, messageId: headers.messageId ?? null }], { accountKey: ACC })
  upsertMailBody(db, uid, {
    accountKey: ACC,
    text: body,
    inReplyTo: headers.inReplyTo ?? null,
    references: headers.references ?? []
  })
}

/** A three-message conversation, plus an unrelated message. */
function conversation(): void {
  seed(1, 'Lease renewal', day(1), { messageId: '<root@x>' })
  seed(2, 'Re: Lease renewal', day(2), { messageId: '<r1@x>', inReplyTo: '<root@x>', references: ['<root@x>'] })
  seed(3, 'Re: Lease renewal', day(3), { messageId: '<r2@x>', inReplyTo: '<r1@x>', references: ['<root@x>', '<r1@x>'] })
  seed(9, 'Re: Lease renewal', day(4), { messageId: '<other@x>' }) // same SUBJECT, different conversation
}

describe("mode 'one' pins exactly what was pinned", () => {
  it('returns only the named message', () => {
    conversation()
    const got = storedThread(db, { accountKey: ACC, mode: 'one', uids: [2] })
    expect(got.map((m) => m.uid)).toEqual([2])
  })

  it('does not grow when replies arrive', () => {
    conversation()
    seed(4, 'Re: Lease renewal', day(5), { messageId: '<r3@x>', references: ['<root@x>'] })
    expect(storedThread(db, { accountKey: ACC, mode: 'one', uids: [1] }).map((m) => m.uid)).toEqual([1])
  })

  it('can pin several specific messages', () => {
    conversation()
    expect(storedThread(db, { accountKey: ACC, mode: 'one', uids: [3, 1] }).map((m) => m.uid)).toEqual([1, 3])
  })
})

describe("mode 'thread' regathers the conversation", () => {
  it('collects the root and every reply', () => {
    conversation()
    const got = storedThread(db, { accountKey: ACC, mode: 'thread', uids: [1], rootMessageId: '<root@x>' })
    expect(got.map((m) => m.uid)).toEqual([1, 2, 3])
  })

  it('reads oldest first, because a conversation reads downwards', () => {
    conversation()
    const got = storedThread(db, { accountKey: ACC, mode: 'thread', uids: [1], rootMessageId: '<root@x>' })
    expect(got.map((m) => m.date)).toEqual([day(1), day(2), day(3)])
  })

  it('picks up a reply that arrives later, with no change to the widget', () => {
    conversation()
    const before = storedThread(db, { accountKey: ACC, mode: 'thread', uids: [1], rootMessageId: '<root@x>' })
    expect(before).toHaveLength(3)
    seed(4, 'Re: Lease renewal', day(6), { messageId: '<r3@x>', references: ['<root@x>'] })
    const after = storedThread(db, { accountKey: ACC, mode: 'thread', uids: [1], rootMessageId: '<root@x>' })
    expect(after.map((m) => m.uid)).toEqual([1, 2, 3, 4])
  })

  it('does NOT merge a different conversation that shares the subject', () => {
    // "Re: invoice" is not evidence. Two unrelated invoices must not become one
    // thread just because somebody reused a subject line.
    conversation()
    const got = storedThread(db, { accountKey: ACC, mode: 'thread', uids: [1], rootMessageId: '<root@x>' })
    expect(got.map((m) => m.uid)).not.toContain(9)
  })

  it('falls back to the anchor message when it has no Message-ID at all', () => {
    // Rare but real. Showing the one message beats showing an empty card.
    seed(5, 'No headers here', day(2), {})
    const got = storedThread(db, { accountKey: ACC, mode: 'thread', uids: [5] })
    expect(got.map((m) => m.uid)).toEqual([5])
  })

  it('infers the root from the anchor when the widget did not record one', () => {
    conversation()
    const got = storedThread(db, { accountKey: ACC, mode: 'thread', uids: [1] })
    expect(got.map((m) => m.uid)).toEqual([1, 2, 3])
  })
})

describe('honest edges', () => {
  it('returns nothing when the message is no longer in the store', () => {
    // The widget renders an explicit "no longer available", which is why an empty
    // result has to be distinguishable rather than throwing.
    expect(storedThread(db, { accountKey: ACC, mode: 'one', uids: [404] })).toEqual([])
  })

  it('returns nothing when asked for nothing, rather than everything', () => {
    conversation()
    expect(storedThread(db, { accountKey: ACC, mode: 'thread', uids: [] })).toEqual([])
  })

  it('cannot read another account mail', () => {
    conversation()
    expect(storedThread(db, { accountKey: 'other@example.test', mode: 'one', uids: [1] })).toEqual([])
  })
})
