// A "use" link is a standing marketing link, not a 48-hour one.
//
// The founder sends the same link to many prospects over weeks and months. Two
// things broke that, and this file holds both fixes:
//
//   1. "Never" did not mean never. The share sheet passed null for it, the
//      client dropped null exactly like undefined, and the server applied its
//      48-hour default -- so every never-expiring link died after two days.
//   2. A link could not be updated. Fixing a typo in a demo desk meant a new
//      link, which breaks a link that is already in fifty inboxes.
//
// And the recipient's side has to cope with both: no countdown for a link with
// no end, and a returning visitor whose copy is older than what the link now
// shows -- replaced quietly if they never touched it, asked about if they did.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../src/renderer/src/stores/account', () => ({
  useAccountStore: { getState: () => ({ sessionToken: 'acct-session' }) }
}))
vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { httpUrl: 'https://signal.test/', wsUrl: 'wss://signal.test/ws', useRemote: true },
  cloudAppUrl: () => 'https://plexiidesk.com/share'
}))

import { NEVER_EXPIRES_AT, expiresNever, normaliseExpiresAt } from '../../src/shared/shareExpiry'
import {
  expiryFields, mintEphemeralShare, updateEphemeralShare, listEphemeralShares, normaliseShare,
  timeLeft, updateRefusal
} from '../../src/renderer/src/lib/ephemeralShareClient'
import {
  countdown, msLeft, linkExpires, previewShare, markImported, alreadyImported, wipeLocalCopy,
  type ShareOffer
} from '../../src/web/api/share'
import {
  decideShareUpdate, linkRecord, readLinkRecords, noteCopyEdited, noteVersionDeclined, requestNewVersion,
  takeNewVersionRequest, type LinkRecord
} from '../../src/web/api/shareVersion'
import { noteShareEdit, resetShareEditNotice } from '../../src/web/api/shareEdits'
import { markShareRecipient } from '../../src/renderer/src/lib/shareMode'
import { EXPIRY_CHOICES } from '../../src/renderer/src/components/share/shareAudience'

const DAY = 86_400_000
const t0 = 1_760_000_000_000

// ── The sentinel ─────────────────────────────────────────────────────────────

describe('never, as both clients read it', () => {
  it('is null, by contract', () => {
    expect(expiresNever(null)).toBe(true)
    expect(normaliseExpiresAt(null)).toBeNull()
  })

  it('is also the sentinel, if a response ever slips through unmapped', () => {
    // 9999-12-31T23:59:59.999Z: rendering it as a countdown or a date is the
    // bug this guards.
    expect(new Date(NEVER_EXPIRES_AT).toISOString()).toBe('9999-12-31T23:59:59.999Z')
    expect(expiresNever(NEVER_EXPIRES_AT)).toBe(true)
    expect(normaliseExpiresAt(NEVER_EXPIRES_AT)).toBeNull()
  })

  it('is not a real expiry, however far off', () => {
    expect(expiresNever(t0 + 90 * DAY)).toBe(false)
    expect(normaliseExpiresAt(t0 + 90 * DAY)).toBe(t0 + 90 * DAY)
  })
})

// ── The desktop client ───────────────────────────────────────────────────────

describe('what a mint asks the server for', () => {
  it('sends expires: never for the share sheet’s "Never" (null)', () => {
    expect(expiryFields(null)).toEqual({ expires: 'never' })
  })

  it('sends nothing for undefined, so the 48-hour callers keep 48 hours', () => {
    expect(expiryFields(undefined)).toEqual({})
  })

  it('sends ttlMs for a real window', () => {
    expect(expiryFields(7 * DAY)).toEqual({ ttlMs: 7 * DAY })
  })

  it('never turns a malformed number into "never"', () => {
    expect(expiryFields(0)).toEqual({})
    expect(expiryFields(-5)).toEqual({})
    expect(expiryFields(Number.NaN)).toEqual({})
    expect(expiryFields(Number.POSITIVE_INFINITY)).toEqual({})
  })

  it('keeps "Never" as the sheet’s first choice, and keeps it null', () => {
    expect(EXPIRY_CHOICES[0]).toEqual({ label: 'Never', ms: null })
  })
})

type FetchCall = { url: string; init: RequestInit }

function serverShare(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'tok_abcdefgh1234', rootId: 'desk-1', title: 'Demo desk', sizeBytes: 1200,
    createdAt: t0, updatedAt: t0, expiresAt: null, opens: 3, lastOpenedAt: t0 + 1000, ...over
  }
}

describe('minting through the real client', () => {
  let calls: FetchCall[]
  const reply = (status: number, body: unknown): void => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  }

  beforeEach(() => {
    calls = []
    ;(window as unknown as { api: unknown }).api = {
      shares: {
        buildDeskBundle: vi.fn(async () => ({
          ok: true, json: '{"format":"plexii.desk"}', title: 'Demo desk', counts: {},
          filesOmitted: [{ id: 'f1', name: 'huge.mov', sizeBytes: 9e8, why: 'too large' }]
        }))
      }
    }
  })

  const sentBody = (): Record<string, unknown> => JSON.parse(String(calls[0].init.body)) as Record<string, unknown>

  it('null → { expires: "never" } and no ttlMs, and the reply reads as never', async () => {
    reply(200, { ok: true, share: serverShare({ expiresAt: null }) })
    const res = await mintEphemeralShare('desk-1', null)
    expect(calls[0].url).toBe('https://signal.test/shares/ephemeral')
    expect(calls[0].init.method).toBe('POST')
    expect(sentBody().expires).toBe('never')
    expect(sentBody()).not.toHaveProperty('ttlMs')
    expect(res.ok).toBe(true)
    expect(res.share?.expiresAt).toBeNull()
    expect(res.url).toBe('https://plexiidesk.com/share/s/tok_abcdefgh1234')
  })

  it('undefined → neither field (the server’s 48-hour default)', async () => {
    reply(200, { ok: true, share: serverShare({ expiresAt: t0 + 2 * DAY }) })
    await mintEphemeralShare('desk-1')
    expect(sentBody()).not.toHaveProperty('expires')
    expect(sentBody()).not.toHaveProperty('ttlMs')
  })

  it('a number → ttlMs only', async () => {
    reply(200, { ok: true, share: serverShare({ expiresAt: t0 + 30 * DAY }) })
    await mintEphemeralShare('desk-1', 30 * DAY)
    expect(sentBody().ttlMs).toBe(30 * DAY)
    expect(sentBody()).not.toHaveProperty('expires')
  })

  it('passes the cap refusal through in the server’s own words', async () => {
    const error = 'You already have 100 links that never expire. Revoke one in Sharing to make another.'
    reply(409, { ok: false, error })
    const res = await mintEphemeralShare('desk-1', null)
    expect(res).toEqual({ ok: false, error })
  })

  it('maps the sentinel and a missing updatedAt in a listing', async () => {
    reply(200, {
      ok: true,
      shares: [
        serverShare({ expiresAt: NEVER_EXPIRES_AT, updatedAt: undefined }),
        serverShare({ token: 'tok_second12345', expiresAt: t0 + DAY, updatedAt: t0 + 500 })
      ]
    })
    const list = await listEphemeralShares()
    expect(list[0].expiresAt).toBeNull()
    expect(list[0].updatedAt).toBe(t0) // falls back to createdAt
    expect(list[1].expiresAt).toBe(t0 + DAY)
    expect(list[1].updatedAt).toBe(t0 + 500)
  })
})

describe('updating a link in place', () => {
  let calls: FetchCall[]
  const reply = (status: number, body: unknown): void => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  }
  let build: ReturnType<typeof vi.fn>

  beforeEach(() => {
    calls = []
    build = vi.fn(async () => ({
      ok: true, json: '{"format":"plexii.desk","v":2}', title: 'Demo desk (fixed typo)', counts: {}, filesOmitted: []
    }))
    ;(window as unknown as { api: unknown }).api = { shares: { buildDeskBundle: build } }
  })

  it('rebuilds the desk the way a mint does and PUTs it to the same token', async () => {
    reply(200, { ok: true, share: serverShare({ updatedAt: t0 + DAY }) })
    const res = await updateEphemeralShare('tok_abcdefgh1234', 'desk-1')
    expect(build).toHaveBeenCalledWith('desk-1')
    expect(calls[0].url).toBe('https://signal.test/shares/ephemeral/tok_abcdefgh1234')
    expect(calls[0].init.method).toBe('PUT')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer acct-session')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      bundle: '{"format":"plexii.desk","v":2}', title: 'Demo desk (fixed typo)'
    })
    expect(res.ok).toBe(true)
    expect(res.share?.updatedAt).toBe(t0 + DAY)
    expect(res.share?.expiresAt).toBeNull()
  })

  it('says why when the link is gone', async () => {
    reply(410, { ok: false, error: 'That link has expired.' })
    expect(await updateEphemeralShare('tok_abcdefgh1234', 'desk-1')).toEqual({ ok: false, error: 'That link has expired.' })
  })

  it('does not show a framework "Not Found" as if it were an explanation', async () => {
    // What an older Signal, with no PUT route, answers.
    reply(404, { message: 'Route PUT:/shares/ephemeral/x not found', error: 'Not Found', statusCode: 404 })
    const res = await updateEphemeralShare('tok_abcdefgh1234', 'desk-1')
    expect(res.ok).toBe(false)
    expect(res.error).toBe(updateRefusal(404))
    expect(res.error).not.toBe('Not Found')
  })

  it('does not call the server when the desk could not be packed', async () => {
    build.mockResolvedValueOnce({ ok: false, error: 'desk not found' })
    reply(200, { ok: true, share: serverShare() })
    expect(await updateEphemeralShare('tok_abcdefgh1234', 'desk-1')).toEqual({ ok: false, error: 'desk not found' })
    expect(calls).toHaveLength(0)
  })
})

describe('the sender’s countdown', () => {
  it('says "Never expires" for null and for the sentinel, never a countdown to 9999', () => {
    expect(timeLeft(null, t0)).toBe('Never expires')
    expect(timeLeft(NEVER_EXPIRES_AT, t0)).toBe('Never expires')
  })

  it('is unchanged for links that do expire', () => {
    expect(timeLeft(t0 + 47 * 3600_000, t0)).toBe('1d 23h left')
    expect(timeLeft(t0 + 30 * 60_000, t0)).toBe('30m left')
    expect(timeLeft(t0 - 1, t0)).toBe('expired')
  })

  it('normalises a share with no fields at all without throwing', () => {
    const s = normaliseShare({})
    expect(s.expiresAt).toBeNull()
    expect(s.updatedAt).toBe(0)
    expect(s.lastOpenedAt).toBeNull()
  })
})

// ── The recipient's page ─────────────────────────────────────────────────────

describe('the recipient’s countdown', () => {
  it('is empty for a link that never expires, and never runs out', () => {
    expect(countdown(null, t0)).toBe('')
    expect(countdown(NEVER_EXPIRES_AT, t0)).toBe('')
    expect(msLeft(null, t0)).toBe(Number.POSITIVE_INFINITY)
    expect(linkExpires({ expiresAt: null })).toBe(false)
  })

  it('is unchanged for a link that does', () => {
    expect(countdown(t0 + 5 * 3600_000, t0)).toBe('5h 0m left')
    expect(msLeft(t0 - 1, t0)).toBe(0)
    expect(linkExpires({ expiresAt: t0 + DAY })).toBe(true)
  })

  it('maps the sentinel in an offer to null', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true, share: { title: 'Demo', expiresAt: NEVER_EXPIRES_AT, updatedAt: t0, sizeBytes: 10, rootId: 'desk-1' }
    }), { status: 200 })) as typeof fetch
    const res = await previewShare('tok_abcdefgh1234')
    expect(res.ok && res.offer.expiresAt).toBeNull()
    expect(res.ok && res.offer.updatedAt).toBe(t0)
  })
})

describe('what a returning visitor’s copy does when the link has a newer version', () => {
  const copy = (over: Partial<LinkRecord> = {}): LinkRecord =>
    ({ version: t0, declined: null, edited: false, rootId: 'desk-1', offer: null, ...over })

  it('keeps going when nothing is newer', () => {
    expect(decideShareUpdate(copy(), t0)).toBe('current')
    expect(decideShareUpdate(copy({ edited: true }), t0 - 1)).toBe('current')
  })

  it('keeps going when the server does not say (an older Signal)', () => {
    expect(decideShareUpdate(copy(), undefined)).toBe('current')
    expect(decideShareUpdate(copy(), null)).toBe('current')
  })

  it('loads the new version without asking when the copy was never changed', () => {
    expect(decideShareUpdate(copy({ edited: false }), t0 + 1)).toBe('load')
  })

  it('asks when the visitor changed their copy', () => {
    expect(decideShareUpdate(copy({ edited: true }), t0 + 1)).toBe('ask')
  })

  it('asks rather than replaces when it cannot tell whether they changed it', () => {
    expect(decideShareUpdate(copy({ edited: null }), t0 + 1)).toBe('ask')
  })

  it('does not claim an update it cannot know about for a copy made before versions were kept', () => {
    expect(decideShareUpdate(copy({ version: null, edited: null }), t0)).toBe('ask-unsure')
    expect(decideShareUpdate(copy({ version: null, edited: true }), t0)).toBe('ask-unsure')
    // Untouched is untouched: replacing it loses nothing.
    expect(decideShareUpdate(copy({ version: null, edited: false }), t0)).toBe('load')
  })

  it('remembers "keep my copy" until something newer still arrives', () => {
    const kept = copy({ edited: true, declined: t0 + 10 })
    expect(decideShareUpdate(kept, t0 + 10)).toBe('current')
    expect(decideShareUpdate(kept, t0 + 11)).toBe('ask')
  })
})

describe('the record behind that decision', () => {
  const T = 'tok_abcdefgh1234'
  const offer = (over: Partial<ShareOffer> = {}): ShareOffer =>
    ({ title: 'Demo desk', expiresAt: null, updatedAt: t0, sizeBytes: 1200, rootId: 'desk-1', ...over })
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    resetShareEditNotice()
  })
  afterEach(() => resetShareEditNotice())

  it('starts unchanged, at the version the offer named, and remembers the desk and the offer', () => {
    markImported(T, t0, offer())
    expect(alreadyImported(T)).toBe(true)
    expect(linkRecord(T)).toEqual({ version: t0, declined: null, edited: false, rootId: 'desk-1', offer: offer() })
  })

  it('is marked changed by the first real edit, through the same gate as the warning', () => {
    markShareRecipient(T) // the link this tab is showing
    markImported(T, t0, offer())
    noteShareEdit()
    expect(linkRecord(T)?.edited).toBe(true)
    expect(decideShareUpdate(linkRecord(T)!, t0 + 1)).toBe('ask')
  })

  it('records a decline without forgetting the edit', () => {
    markImported(T, t0, offer())
    noteCopyEdited(T)
    noteVersionDeclined(T, t0 + 5)
    expect(linkRecord(T)).toMatchObject({ version: t0, declined: t0 + 5, edited: true })
  })

  it('keeps the token only as the key of its own record', () => {
    // A record per link has to be keyed by something that identifies the link;
    // the token is already in this browser's history, and this origin already
    // holds the desk it opens. It is not copied anywhere else.
    markImported(T, t0, offer())
    noteCopyEdited(T)
    noteVersionDeclined(T, t0 + 5)
    requestNewVersion()
    expect(Object.keys(readLinkRecords())).toEqual([T])
    const everything: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      const v = localStorage.getItem(k) ?? ''
      everything.push(k, k === 'fb.share.links' ? JSON.stringify(Object.values(JSON.parse(v))) : v)
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!
      everything.push(k, sessionStorage.getItem(k) ?? '')
    }
    expect(everything.join('|')).not.toContain(T)
  })

  it('is gone when the copy is wiped', async () => {
    markImported(T, t0, offer())
    await wipeLocalCopy()
    expect(alreadyImported(T)).toBe(false)
    expect(readLinkRecords()).toEqual({})
  })

  it('carries "load the new version" across exactly one reload', () => {
    requestNewVersion()
    expect(takeNewVersionRequest()).toBe(true)
    expect(takeNewVersionRequest()).toBe(false)
  })
})

// ── Invariants that live in source ───────────────────────────────────────────

describe('kept in step across files', () => {
  const read = async (rel: string): Promise<string> => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    return readFileSync(resolve(__dirname, '../../', rel), 'utf8')
  }

  it('the bar runs no expiry timer for a link that never expires', async () => {
    const boot = await read('src/web/boot.tsx')
    const from = boot.indexOf('function ExpiryBar(')
    const body = boot.slice(from, boot.indexOf('\ntype State', from))
    const effect = body.slice(body.indexOf('setInterval') - 200, body.indexOf('setInterval'))
    expect(effect).toContain('if (!expires) return')
  })

  it('records the version a copy was made from when it is unpacked or replaced', async () => {
    const desk = await read('src/web/api/shareDesk.ts')
    // ...and the offer itself, so the copy can still be opened when the server
    // cannot be asked (shareLinkRound2.test.ts). Once for a first unpack, once
    // for a replacement.
    expect(desk.split('markImported(token, offer.updatedAt ?? null, offer)').length - 1).toBe(2)
  })
})
