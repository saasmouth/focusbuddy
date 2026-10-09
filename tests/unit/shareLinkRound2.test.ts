// Standing links, second round: the four things a review of the first round
// found -- with the first one as round 3 left it.
//
//   1. One browser, several links. Opening link B after editing link A put both
//      desks in the one database and started B's record as "unchanged", so the
//      next update of B replaced the copy without asking -- and A's edits went
//      with it. Round 2 carried A's edited state into B's record; round 3 found
//      that still lost A's newer versions (A -> B -> A kept A's stale rows) and
//      still emptied every desk to replace one. Now each link has its own
//      record, and replacing a link's desk removes that desk's rows only
//      (shareCopyRows.test.ts proves the rows; this file the records).
//   2. Emptying the copy took the file bytes and the database in whatever order
//      OPFS listed them; failing halfway kept a database whose pictures were
//      gone. The database goes first now, and a failure there touches nothing.
//   3. "Temporarily unavailable" (503) was treated as "gone": the copy was
//      wiped and the page said the link had expired. It is now kept and
//      opened, and the page says what is true.
//   4. A link carries at most 8 MiB of request body. The desk is packed to fit
//      (see shareLinkBudget.test.ts), the client checks before sending, and a
//      413 is said in words.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../src/renderer/src/stores/account', () => ({
  useAccountStore: { getState: () => ({ sessionToken: 'acct-session' }) }
}))
vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { httpUrl: 'https://signal.test/', wsUrl: 'wss://signal.test/ws', useRemote: true },
  cloudAppUrl: () => 'https://plexiidesk.com/share'
}))

import {
  LINK_SHARE_MAX_BODY_BYTES, LINK_SHARE_BUNDLE_BUDGET, LINK_SHARE_LIMIT_WORDS, utf8Bytes, linkMegabytes
} from '../../src/shared/shareExpiry'
import {
  mintEphemeralShare, updateEphemeralShare, linkRefusal, linkRequestBody, describeOmitted, updateRefusal
} from '../../src/renderer/src/lib/ephemeralShareClient'
import {
  markImported, alreadyImported, cachedOffer, refreshCachedOffer, wipeLocalCopy, emptyOpfs,
  refusalFrom, linkIsGone, whenRefused, refusalLine, previewShare, fetchShareBundle, type ShareOffer
} from '../../src/web/api/share'
import {
  linkRecord, readLinkRecords, noteCopyEdited, noteVersionDeclined, decideShareUpdate, replaceConfirmation,
  editedStateOfDesk, forgetLinkRecord, linksSharingDesk, othersPresent, migrateLegacyRecords,
  untrackedDesksPossible, recordAdopted
} from '../../src/web/api/shareVersion'

const DAY = 86_400_000
const t0 = 1_760_000_000_000
const A = 'tok_linkA_abcdefghijklmnopqrstuv'
const B = 'tok_linkB_abcdefghijklmnopqrstuv'
const C = 'tok_linkC_abcdefghijklmnopqrstuv'
const offer = (over: Partial<ShareOffer> = {}): ShareOffer => ({
  title: 'Demo desk', expiresAt: null, updatedAt: t0, sizeBytes: 1200, rootId: 'desk-A', ...over
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

// ── 1. One browser, several links ───────────────────────────────────────────

describe('one record per link', () => {
  it('opening B after A leaves A’s record -- and A’s edits -- exactly as they were', () => {
    markImported(A, t0, offer())
    noteCopyEdited(A)
    noteVersionDeclined(A, t0 + 3)
    markImported(B, t0 + 10, offer({ rootId: 'desk-B', updatedAt: t0 + 10 }))
    expect(alreadyImported(A)).toBe(true)
    expect(alreadyImported(B)).toBe(true)
    expect(linkRecord(A)).toMatchObject({ version: t0, declined: t0 + 3, edited: true, rootId: 'desk-A' })
    expect(linkRecord(B)).toMatchObject({ version: t0 + 10, declined: null, edited: false, rootId: 'desk-B' })
  })

  it('each link’s update is decided by its own record', () => {
    markImported(A, t0, offer())
    noteCopyEdited(A)
    markImported(B, t0 + 10, offer({ rootId: 'desk-B' }))
    // B is untouched, so its new version simply loads -- its desk only, so A's
    // edits are not at stake. A was changed, so A's update asks.
    expect(decideShareUpdate(linkRecord(B)!, t0 + 20)).toBe('load')
    expect(decideShareUpdate(linkRecord(A)!, t0 + 20)).toBe('ask')
  })

  it('A -> B -> A: A’s newer version is still found after B was opened (there used to be no record for A)', () => {
    markImported(A, t0, offer())
    markImported(B, t0 + 10, offer({ rootId: 'desk-B' }))
    expect(alreadyImported(A)).toBe(true)
    expect(decideShareUpdate(linkRecord(A)!, t0 + 30)).toBe('load')
    expect(decideShareUpdate(linkRecord(A)!, t0)).toBe('current')
  })

  it('an edit marks the link this tab shows, and every link to the same desk, and no other', () => {
    markImported(A, t0, offer())
    markImported(B, t0, offer({ rootId: 'desk-B' }))
    markImported(C, t0, offer()) // a second link to A's desk
    noteCopyEdited(A)
    expect(linkRecord(A)?.edited).toBe(true)
    expect(linkRecord(C)?.edited).toBe(true)
    expect(linkRecord(B)?.edited).toBe(false)
    expect(linksSharingDesk(A)).toEqual([C])
    expect(linksSharingDesk(B)).toEqual([])
  })

  it('unpacking a desk another link also names leaves that link "version unknown, untouched"', () => {
    markImported(A, t0, offer())
    noteCopyEdited(A)
    markImported(C, t0 + 50, offer({ updatedAt: t0 + 50 })) // replaced desk-A with C's version
    expect(linkRecord(C)).toMatchObject({ version: t0 + 50, edited: false })
    // A's rows are C's now: A's next visit puts A's own version back.
    expect(linkRecord(A)).toMatchObject({ version: null, declined: null, edited: false })
    expect(decideShareUpdate(linkRecord(A)!, t0)).toBe('load')
  })

  it('knows how changed a desk is from every record that names it', () => {
    expect(editedStateOfDesk('desk-A')).toBeNull() // nothing records it: unknown
    markImported(A, t0, offer())
    markImported(C, t0, offer())
    expect(editedStateOfDesk('desk-A')).toBe(false)
    expect(editedStateOfDesk('desk-A', A)).toBe(false)
    recordAdopted(B, offer({ rootId: 'desk-A' }), null)
    expect(editedStateOfDesk('desk-A')).toBeNull()
    noteCopyEdited(A)
    expect(editedStateOfDesk('desk-A')).toBe(true)
  })

  it('a link opened onto a copy that was already here is recorded without a version', () => {
    recordAdopted(B, offer({ rootId: 'desk-A' }), true)
    expect(linkRecord(B)).toMatchObject({ version: null, edited: true, rootId: 'desk-A' })
    expect(decideShareUpdate(linkRecord(B)!, t0)).toBe('ask-unsure')
  })

  it('forgetting one link keeps every other', () => {
    markImported(A, t0, offer())
    markImported(B, t0, offer({ rootId: 'desk-B' }))
    forgetLinkRecord(A)
    expect(Object.keys(readLinkRecords())).toEqual([B])
  })

  it('says whether anything besides this link is here', () => {
    markImported(A, t0, offer())
    expect(othersPresent(A)).toBe(false)
    markImported(B, t0, offer({ rootId: 'desk-B' }))
    expect(othersPresent(A)).toBe(true)
    forgetLinkRecord(B)
    localStorage.setItem('fb.share.untracked', '1') // an older build's desks may be here
    expect(othersPresent(A)).toBe(true)
  })

  it('starts fresh again after the store is wiped', async () => {
    markImported(A, t0, offer())
    noteCopyEdited(A)
    await wipeLocalCopy()
    expect(readLinkRecords()).toEqual({})
    markImported(B, t0, offer())
    expect(linkRecord(B)).toMatchObject({ version: t0, declined: null, edited: false })
  })
})

describe('records kept by older builds', () => {
  it('a HEAD browser (only the last link opened) gets a record for that link, with nothing known', () => {
    localStorage.setItem('fb.share.imported', A)
    migrateLegacyRecords()
    expect(linkRecord(A)).toEqual({ version: null, declined: null, edited: null, rootId: null, offer: null })
    // HEAD unpacked every link into one database and remembered only the last.
    expect(untrackedDesksPossible()).toBe(true)
    expect(localStorage.getItem('fb.share.imported')).toBeNull()
    // Nothing is known, so nothing is replaced without asking.
    expect(decideShareUpdate(linkRecord(A)!, t0)).toBe('ask-unsure')
  })

  it('a round-2 browser keeps its version, its edits, its decline and its desk', () => {
    localStorage.setItem('fb.share.imported', A)
    localStorage.setItem('fb.share.copy', JSON.stringify({ version: t0, declined: t0 + 1, edited: true, others: false }))
    localStorage.setItem('fb.share.offer', JSON.stringify(offer({ title: 'Kept' })))
    migrateLegacyRecords()
    expect(linkRecord(A)).toEqual({ version: t0, declined: t0 + 1, edited: true, rootId: 'desk-A', offer: offer({ title: 'Kept' }) })
    expect(untrackedDesksPossible()).toBe(false)
    for (const k of ['fb.share.imported', 'fb.share.copy', 'fb.share.offer']) expect(localStorage.getItem(k)).toBeNull()
  })

  it('a round-2 browser that held other links’ desks says so', () => {
    localStorage.setItem('fb.share.imported', B)
    localStorage.setItem('fb.share.copy', JSON.stringify({ version: t0, declined: null, edited: false, others: true }))
    migrateLegacyRecords()
    expect(untrackedDesksPossible()).toBe(true)
    expect(othersPresent(B)).toBe(true)
  })

  it('runs once, and never overwrites a record the link already has', () => {
    markImported(A, t0 + 9, offer())
    localStorage.setItem('fb.share.imported', A)
    migrateLegacyRecords()
    migrateLegacyRecords()
    expect(linkRecord(A)).toMatchObject({ version: t0 + 9, edited: false })
  })
})

describe('the confirmation before replacing', () => {
  it('says this desk is replaced and other links’ desks are not touched', () => {
    for (const unsure of [false, true]) {
      const words = replaceConfirmation(unsure, false)
      expect(words).toMatch(/your copy of this desk/)
      expect(words).toMatch(/Desks from other links in this browser are not touched\./)
      expect(words).toMatch(/cannot be undone/)
      // The round-2 words, which are no longer true, are gone.
      expect(words).not.toMatch(/removed with it/)
    }
  })

  it('says so when another link in this browser shows the same desk', () => {
    for (const unsure of [false, true]) {
      expect(replaceConfirmation(unsure, true)).toMatch(/Another link you opened in this browser shows this same desk/)
    }
  })
})

// ── 2. Emptying the copy, database first ────────────────────────────────────

interface FakeRoot {
  entries: Set<string>
  removed: string[]
  handle: FileSystemDirectoryHandle
}

/** OPFS root whose listing order is the given order; `stuck` entries refuse removal. */
function fakeOpfs(names: string[], stuck: string[] = []): FakeRoot {
  const entries = new Set(names)
  const removed: string[] = []
  const handle = {
    keys: async function* () {
      for (const n of [...entries]) yield n
    },
    removeEntry: async (name: string) => {
      if (stuck.includes(name)) throw new DOMException('in use', 'NoModificationAllowedError')
      entries.delete(name)
      removed.push(name)
    }
  } as unknown as FileSystemDirectoryHandle
  return { entries, removed, handle }
}

function install(prop: 'storage' | 'locks', value: unknown): void {
  Object.defineProperty(navigator, prop, { value, configurable: true, writable: true })
}

describe('emptying OPFS', () => {
  it('removes the database before anything else, whatever order OPFS lists them in', async () => {
    const root = fakeOpfs(['plexii-files', 'stray', '.plexii'])
    expect(await emptyOpfs(root.handle, 1)).toEqual({ ok: true, leftover: [] })
    expect(root.removed[0]).toBe('.plexii')
    expect(root.entries.size).toBe(0)
  })

  it('touches nothing else when the database will not go', async () => {
    const root = fakeOpfs(['plexii-files', '.plexii'], ['.plexii'])
    expect(await emptyOpfs(root.handle, 1)).toEqual({ ok: false })
    // The bytes the database points at are still there: the old copy opens whole.
    expect([...root.entries].sort()).toEqual(['.plexii', 'plexii-files'])
    expect(root.removed).toEqual([])
  })

  it('reports bytes that would not go once the database is gone', async () => {
    const root = fakeOpfs(['plexii-files', '.plexii'], ['plexii-files'])
    expect(await emptyOpfs(root.handle, 1)).toEqual({ ok: true, leftover: ['plexii-files'] })
    expect(root.entries.has('.plexii')).toBe(false)
  })
})

// ── 3. Unavailable is not gone ──────────────────────────────────────────────

describe('what an answer from a public share route means', () => {
  it('is gone only when Signal says so in its own words', () => {
    expect(refusalFrom(404, { ok: false, reason: 'unknown' })).toBe('unknown')
    expect(refusalFrom(410, { ok: false, reason: 'revoked' })).toBe('revoked')
    expect(refusalFrom(410, { ok: false, reason: 'expired' })).toBe('expired')
  })

  it('is unavailable for Signal’s 503, and for everything it cannot attribute', () => {
    expect(refusalFrom(503, { ok: false, reason: 'unavailable' })).toBe('unavailable')
    expect(refusalFrom(503, null)).toBe('unavailable') // proxy page
    expect(refusalFrom(502, null)).toBe('unavailable') // machine restarting
    expect(refusalFrom(500, { ok: false, error: 'boom' })).toBe('unavailable')
    expect(refusalFrom(429, { statusCode: 429, error: 'Too Many Requests' })).toBe('unavailable')
    expect(refusalFrom(404, { statusCode: 404, error: 'Not Found', message: 'Route GET:/x not found' })).toBe('unavailable')
    expect(refusalFrom(200, null)).toBe('unavailable') // an HTML fallback page
  })

  it('never wipes for unavailable or offline', () => {
    expect(linkIsGone('unavailable')).toBe(false)
    expect(linkIsGone('offline')).toBe(false)
    expect(linkIsGone('revoked')).toBe(true)
  })
})

describe('the routes, through the real client', () => {
  const reply = (status: number, body: unknown): void => {
    globalThis.fetch = vi.fn(async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    ) as typeof fetch
  }

  it('a 503 from the metadata route is "unavailable", not "unknown"', async () => {
    reply(503, { ok: false, reason: 'unavailable' })
    expect(await previewShare(A)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('a 503 from the bundle route is "unavailable", not a missing bundle', async () => {
    reply(503, { ok: false, reason: 'unavailable' })
    expect(await fetchShareBundle(A)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('the bundle route still reports a revoked link as revoked', async () => {
    reply(410, { ok: false, reason: 'revoked' })
    expect(await fetchShareBundle(A)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('a bundle comes back as text', async () => {
    reply(200, '{"format":"plexii.desk"}')
    expect(await fetchShareBundle(A)).toEqual({ ok: true, text: '{"format":"plexii.desk"}' })
  })

  it('a dropped connection is "offline"', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    expect(await fetchShareBundle(A)).toEqual({ ok: false, reason: 'offline' })
  })
})

describe('what happens to the copy when the offer cannot be read', () => {
  const mine = { offer: offer() }
  const gone = ['unknown', 'revoked', 'expired'] as const

  it('a link this browser never unpacked takes nothing, gone or not', () => {
    // A mistyped link, someone else's revoked link, a link mangled past
    // recognition: none of them is this browser's copy.
    for (const reason of gone) {
      expect(whenRefused(reason, null, true)).toEqual({ action: 'explain', reason })
      expect(whenRefused(reason, null, false)).toEqual({ action: 'explain', reason })
    }
  })

  it('gone, and it was the only link here: the whole store goes', () => {
    for (const reason of gone) expect(whenRefused(reason, mine, false)).toEqual({ action: 'wipe', reason })
  })

  it('gone, with other links’ desks here too: only its own desk goes', () => {
    for (const reason of gone) expect(whenRefused(reason, mine, true)).toEqual({ action: 'forget', reason })
  })

  it('unavailable, and this browser holds the link’s copy: opened as it was', () => {
    expect(whenRefused('unavailable', mine, false)).toEqual({ action: 'open-copy', offer: offer() })
    expect(whenRefused('offline', mine, true)).toEqual({ action: 'open-copy', offer: offer() })
  })

  it('unavailable, nothing here to open: explained, nothing removed', () => {
    expect(whenRefused('unavailable', null, false)).toEqual({ action: 'explain', reason: 'unavailable' })
    expect(whenRefused('unavailable', { offer: null }, false)).toEqual({ action: 'explain', reason: 'unavailable' })
  })

  it('a timed link whose clock has run out goes, reachable or not -- its own desk only, when others are here', () => {
    const timed = { offer: offer({ expiresAt: t0 + DAY }) }
    expect(whenRefused('unavailable', timed, false, t0 + DAY + 1)).toEqual({ action: 'wipe', reason: 'expired' })
    expect(whenRefused('unavailable', timed, true, t0 + DAY + 1)).toEqual({ action: 'forget', reason: 'expired' })
    expect(whenRefused('unavailable', timed, false, t0)).toEqual({ action: 'open-copy', offer: timed.offer })
  })

  it('never says "expired" for unavailable', () => {
    expect(refusalLine('unavailable')).toMatch(/temporarily unavailable/)
    expect(refusalLine('unavailable')).not.toMatch(/expired|deleted/i)
  })
})

describe('the offer remembered with each link', () => {
  it('is what the copy was unpacked from, and enough to open it', () => {
    markImported(A, t0, offer({ title: 'Pipeline demo', expiresAt: t0 + 7 * DAY }))
    expect(cachedOffer(A)).toEqual({
      title: 'Pipeline demo', expiresAt: t0 + 7 * DAY, updatedAt: t0, sizeBytes: 1200, rootId: 'desk-A'
    })
  })

  it('keeps "never" as null', () => {
    markImported(A, t0, offer({ expiresAt: null }))
    expect(cachedOffer(A)?.expiresAt).toBeNull()
  })

  it('is per link', () => {
    markImported(A, t0, offer())
    markImported(B, t0, offer({ rootId: 'desk-B', title: 'B' }))
    expect(cachedOffer(A)?.rootId).toBe('desk-A')
    expect(cachedOffer(B)).toMatchObject({ rootId: 'desk-B', title: 'B' })
    expect(cachedOffer(C)).toBeNull()
  })

  it('goes with the copy', async () => {
    markImported(A, t0, offer())
    await wipeLocalCopy()
    expect(cachedOffer(A)).toBeNull()
  })

  it('is filled in on a normal visit for a copy unpacked without one, and only for that link', () => {
    // A copy from an older build: a marker, no remembered offer, no desk.
    localStorage.setItem('fb.share.imported', A)
    migrateLegacyRecords()
    expect(cachedOffer(A)).toBeNull()
    refreshCachedOffer(B, offer({ rootId: 'desk-B' }))
    expect(cachedOffer(A)).toBeNull()
    expect(linkRecord(B)).toBeNull()
    refreshCachedOffer(A, offer({ title: 'Renamed' }))
    expect(cachedOffer(A)).toMatchObject({ rootId: 'desk-A', title: 'Renamed' })
    expect(linkRecord(A)?.rootId).toBe('desk-A')
    expect(whenRefused('unavailable', linkRecord(A), othersPresent(A)).action).toBe('open-copy')
  })
})

// ── 4. What a link can carry ────────────────────────────────────────────────

describe('the link budget', () => {
  it('is 8 MiB of body, packed to 7.5 MiB, and quoted as Signal quotes it', () => {
    expect(LINK_SHARE_MAX_BODY_BYTES).toBe(8 * 1024 * 1024)
    expect(LINK_SHARE_BUNDLE_BUDGET).toBe(7.5 * 1024 * 1024)
    // Signal's TOO_LARGE_MESSAGE says "(8 MB maximum)": MiB, called MB.
    expect(LINK_SHARE_LIMIT_WORDS).toBe('8 MB')
    expect(linkMegabytes(LINK_SHARE_BUNDLE_BUDGET)).toBe('7.5 MB')
    expect(linkMegabytes(40 * 1024 * 1024)).toBe('40 MB')
    expect(linkMegabytes(1.25 * 1024 * 1024)).toBe('1.3 MB')
  })

  it('counts UTF-8 bytes the way the server does', () => {
    for (const s of ['plain', 'naïve café', '日本語', 'emoji 😀 pair', '\ud800 lone']) {
      expect(utf8Bytes(s)).toBe(new TextEncoder().encode(s).byteLength)
    }
  })
})

describe('a request too large to send', () => {
  it('is refused before anything is uploaded, with the size in words', () => {
    const big = 'x'.repeat(9.5 * 1024 * 1024)
    const r = linkRequestBody({ bundle: big })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/too large to send as a link \(9\.5 MB; a link can carry at most 8 MB\)/)
    // Just over the line is still over it.
    expect(linkRequestBody({ bundle: 'x'.repeat(LINK_SHARE_MAX_BODY_BYTES) }).ok).toBe(false)
    expect(linkRequestBody({ bundle: 'x'.repeat(LINK_SHARE_MAX_BODY_BYTES - 20) }).ok).toBe(true)
  })

  it('is measured as sent, escapes included', () => {
    // 3 MiB of quotes is 6 MiB once escaped inside the body, and more again as
    // a JSON string inside a JSON string.
    const quotes = JSON.stringify({ text: '"'.repeat(3 * 1024 * 1024) })
    expect(linkRequestBody({ bundle: quotes }).ok).toBe(false)
    expect(linkRequestBody({ bundle: '{"format":"plexii.desk"}' }).ok).toBe(true)
  })

  it('stops a mint and an update before fetch is called', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    ;(window as unknown as { api: unknown }).api = {
      shares: {
        buildDeskBundle: vi.fn(async () => ({
          ok: true, json: JSON.stringify({ blob: 'y'.repeat(LINK_SHARE_MAX_BODY_BYTES) }), title: 'Big', counts: {}, filesOmitted: []
        }))
      }
    }
    expect((await mintEphemeralShare('desk-1', null)).error).toMatch(/too large to send as a link/)
    expect((await updateEphemeralShare(A, 'desk-1')).error).toMatch(/too large to send as a link/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('a 413 from the server', () => {
  const fastify413 = { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE', error: 'Payload Too Large', message: 'Request body is too large' }

  it('is never shown as a bare "Payload Too Large"', () => {
    for (const action of ['share', 'update'] as const) {
      const words = linkRefusal(413, fastify413, action)
      expect(words).not.toBe('Payload Too Large')
      expect(words).toMatch(/too large to send as a link: a link can carry at most 8 MB\./)
      expect(linkRefusal(413, null, action)).toBe(words) // a proxy page, or nothing
    }
  })

  it('uses Signal’s own words when it gives them', () => {
    // Signal's TOO_LARGE_MESSAGE, as the 8 MiB body limit answers it.
    const own = { ok: false, error: 'This desk is too large to share as a link (8 MB maximum). Remove or shrink some images and try again.' }
    expect(linkRefusal(413, own, 'share')).toBe(own.error)
    expect(linkRefusal(413, own, 'update')).toBe(own.error)
  })

  it('reaches the sender through a real mint and a real update', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(fastify413), { status: 413 })) as typeof fetch
    ;(window as unknown as { api: unknown }).api = {
      shares: {
        buildDeskBundle: vi.fn(async () => ({ ok: true, json: '{"format":"plexii.desk"}', title: 'D', counts: {}, filesOmitted: [] }))
      }
    }
    const mint = await mintEphemeralShare('desk-1', null)
    const upd = await updateEphemeralShare(A, 'desk-1')
    for (const r of [mint, upd]) {
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/a link can carry at most 8 MB\./)
    }
  })

  it('leaves the other refusals as they were', () => {
    expect(updateRefusal(404)).toMatch(/no longer exists/)
    expect(linkRefusal(409, { ok: false, error: 'You already have 100 links that never expire.' }, 'share'))
      .toBe('You already have 100 links that never expire.')
    expect(linkRefusal(502, null, 'share')).toMatch(/could not take this just now/)
  })
})

describe('the files a link went out without', () => {
  it('is empty when nothing was left out', () => {
    expect(describeOmitted([])).toBe('')
    expect(describeOmitted(undefined)).toBe('')
  })

  it('names each file, grouped by why', () => {
    const words = describeOmitted([
      { id: 'f1', name: 'demo.mov', sizeBytes: 40 * 1024 * 1024, why: 'a link can carry at most 8 MB' },
      { id: 'f2', name: 'deck.pdf', sizeBytes: 3 * 1024 * 1024, why: 'the bundle is already at its size limit' },
      { id: 'f3', name: 'scan.png', sizeBytes: 0, why: 'the bytes are not on this device' },
      { id: 'f4', name: 'logo.svg', sizeBytes: 3000, why: 'the bytes are not on this device' }
    ])
    expect(words).toBe(
      'Left out because a link can carry at most 8 MB: demo.mov (40 MB), deck.pdf (3 MB). ' +
        'Left out because the file is not on this computer: scan.png, logo.svg (3 KB).'
    )
  })
})

// ── Kept in step across files ───────────────────────────────────────────────

describe('kept in step across files (round 2)', () => {
  const read = async (rel: string): Promise<string> => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    return readFileSync(resolve(__dirname, '../../', rel), 'utf8')
  }

  it('the directory emptyOpfs removes first is the one the SQLite pool VFS uses', async () => {
    const sqlite = await read('src/web/worker/sqlite.ts')
    const share = await read('src/web/api/share.ts')
    const vfs = /installOpfsSAHPoolVfs\?\.\(\{ name: '([^']+)' \}\)/.exec(sqlite)?.[1]
    const first = /const DB_POOL_ENTRY = '([^']+)'/.exec(share)?.[1]
    expect(vfs).toBeTruthy()
    expect(first).toBe(`.${vfs}`)
  })

  it('the share page fetches a new version before anything of the old desk is removed', async () => {
    const boot = await read('src/web/boot.tsx')
    const branch = boot.slice(boot.indexOf("if (decision === 'load') {"))
    const fetched = branch.indexOf('await fetchShareBundle(token)')
    expect(fetched).toBeGreaterThan(-1)
    // The fetched text is what open() puts in place; nothing is removed here.
    expect(branch.indexOf('planRef.current = { text: next.text, asked }')).toBeGreaterThan(fetched)
    // The page never removes rows or empties the store itself: that goes
    // through shareDesk (dropLinkCopy / openLinkDesk), which the boot flow
    // and shareDeskRules.test.ts hold to "this link's copy only".
    for (const direct of ['wipeLocalCopy(', 'removeDesk(', 'replaceDesk(', 'emptyOpfs(']) expect(boot).not.toContain(direct)
  })

  it('every removal the share page asks for is behind a refusal that says the link is gone, or its clock', async () => {
    const boot = await read('src/web/boot.tsx')
    const lines = boot.split('\n')
    const drops = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes('await dropLinkCopy('))
    expect(drops.length).toBe(3)
    for (const { i } of drops) {
      const context = lines.slice(Math.max(0, i - 5), i + 1).join('\n')
      expect(context).toMatch(/whenRefused|next\.action === 'wipe'|linkIsGone|const expire = useCallback/)
    }
  })
})
