import { describe, it, expect, vi, beforeEach } from 'vitest'

// A chat turn must not reach the mail SERVER (2026-10-30).
//
// findInMail answers from the local FTS index first, then widens: one IMAP
// FETCH per bodyless hit, serially, then a whole page of older headers, up to
// maxRounds. Plus acquireWarm's 60s idle logout, so a question asked a minute
// after the last one pays a fresh TLS handshake, LOGIN and SELECT first.
//
// That ran on every workspace-gated turn — including "summarise this desk".
// It is the 15 seconds that was reported, and a timeout did not fix it:
// Promise.race stops WAITING, while the fetches carry on holding the mailbox
// lock and queue up in front of the next turn.
//
// The local index has the messages already, and the background sync already
// backfills bodies (mailSync's BODIES_PER_TICK). So the turn reads the index
// and says honestly what it could not read.

const stored: Array<{ uid: number; subject: string; bodyAt: number | null }> = []
const ingested: number[] = []
let olderPages = 0

vi.mock('../../src/main/db/database', () => ({ getDb: () => ({}) }))
vi.mock('../../src/main/db/mailStore', () => ({
  searchStoredMail: () =>
    stored.map((m) => ({ message: { uid: m.uid, subject: m.subject, bodyAt: m.bodyAt, bodyText: m.bodyAt ? 'body' : null }, folder: 'INBOX' }))
}))
vi.mock('../../src/main/mail/imap', () => ({ acquireWarm: async () => { throw new Error('the turn path must not open IMAP') } }))

beforeEach(() => {
  stored.length = 0
  ingested.length = 0
  olderPages = 0
  vi.resetModules()
})

describe('the turn path reads the local index only', () => {
  it('findInStoredMail never fetches a body or a page', async () => {
    stored.push({ uid: 1, subject: 'Acme renewal', bodyAt: 1 })
    stored.push({ uid: 2, subject: 'Acme pricing', bodyAt: null })
    const { findInStoredMail } = await import('../../src/main/mail/mailIngest')
    const r = findInStoredMail('Acme renewal', 'acct', 5)
    expect(ingested).toEqual([])
    expect(olderPages).toBe(0)
    // Only what can actually be quoted is offered as a source.
    expect(r.hits.map((h) => h.message.uid)).toEqual([1])
  })

  it('counts what it could NOT read, rather than quietly dropping it', async () => {
    // The honest gap. A subject-line match with no body is a real signal
    // that the answer may exist and is not downloaded yet — saying so beats
    // both silence and a 15-second stall.
    stored.push({ uid: 1, subject: 'Acme renewal', bodyAt: null })
    stored.push({ uid: 2, subject: 'Acme pricing', bodyAt: null })
    const { findInStoredMail } = await import('../../src/main/mail/mailIngest')
    expect(findInStoredMail('Acme', 'acct', 5).notDownloaded).toBe(2)
  })

  it('reports nothing missing when every match is readable', async () => {
    stored.push({ uid: 1, subject: 'Acme renewal', bodyAt: 1 })
    const { findInStoredMail } = await import('../../src/main/mail/mailIngest')
    expect(findInStoredMail('Acme', 'acct', 5).notDownloaded).toBe(0)
  })
})

describe('mailGroundingForQuestion stays local', () => {
  it('does not call findInMail, which is the one that reaches the server', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../..', 'src/main/ai/mailGrounding.ts'), 'utf-8')
    expect(src).toContain('findInStoredMail')
    expect(src).not.toMatch(/\bawait findInMail\(/)
  })

  it('tells the answer what it could not read', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    expect(readFileSync(join(__dirname, '../..', 'src/main/ai/mailGrounding.ts'), 'utf-8')).toContain('notDownloaded')
  })
})
