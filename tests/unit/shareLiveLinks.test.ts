// Every share link opens the full web app; only what the visitor may do
// changes (owner, 2026-11-07: "they all should be the same, just the
// interactivity that changes. Should be full web version of the local app").
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  classicViewerUrl, fetchLiveShareBundle, liveOffer, liveTokenFromUrl, previewLiveShare
} from '../../src/web/api/liveShare'
import { openRefusal, readMode, copyRefusal } from '../../src/web/api/readShare'
import { readInstead, refusalLine } from '../../src/web/api/share'
import { decideCall } from '../../src/web/api/readOnly'
import type { CallContext } from '../../src/web/api/shareGate'

const LIVE = 'dsk_80375edef54b39e65855eb11f6d882cb7aacfcad'

describe('a live web view link', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is read from /l/<token>, on the site or at the root', () => {
    expect(liveTokenFromUrl(`https://plexiidesk.com/share/l/${LIVE}`)).toBe(LIVE)
    expect(liveTokenFromUrl(`http://localhost:5180/l/${LIVE}.`)).toBe(LIVE)
    expect(liveTokenFromUrl(`https://plexiidesk.com/share/s/${LIVE}`)).toBeNull()
    expect(liveTokenFromUrl('https://plexiidesk.com/share/l/notalivetoken')).toBeNull()
  })

  it('opens as a desk to look at once its desk has been sent', () => {
    expect(liveOffer({ kind: 'desk', title: 'Lesson Planning', bundleUpdatedAt: 5, expiresAt: null })).toEqual({
      ok: true,
      offer: { title: 'Lesson Planning', expiresAt: null, updatedAt: 5, sizeBytes: 0, rootId: '', mode: 'view' }
    })
  })

  it('says it is not ready -- and where it can be watched -- before its desk has been sent', () => {
    expect(liveOffer({ kind: 'desk', bundleUpdatedAt: null })).toEqual({ ok: false, reason: 'not-ready' })
    expect(readInstead('not-ready')).toBe(true)
    expect(refusalLine('not-ready')).toMatch(/not ready to open in the full app yet/)
    expect(classicViewerUrl(LIVE)).toBe(`https://view.plexiidesk.com/share/${LIVE}?classic=1`)
  })

  it('is gone when revoked, and not a desk when it is something else', () => {
    expect(liveOffer({ kind: 'desk', revoked: true, bundleUpdatedAt: 5 })).toEqual({ ok: false, reason: 'gone' })
    expect(liveOffer({ kind: 'task', bundleUpdatedAt: 5 })).toEqual({ ok: false, reason: 'not-a-desk' })
  })

  it('asks the server without counting a view, and maps its answers', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      seen.push(u)
      return new Response(JSON.stringify({ ok: true, record: { kind: 'desk', title: 'x', bundleUpdatedAt: 9 } }))
    }))
    expect(await previewLiveShare(LIVE)).toMatchObject({ ok: true, offer: { updatedAt: 9, mode: 'view' } })
    expect(seen[0]).toMatch(new RegExp(`/share/${LIVE}\\?meta=1$`))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Share not found or revoked.' }), { status: 404 })))
    expect(await previewLiveShare(LIVE)).toEqual({ ok: false, reason: 'gone' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    expect(await previewLiveShare(LIVE)).toEqual({ ok: false, reason: 'offline' })
  })

  it('fetches the desk, and tells "not sent yet" from "gone"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"format":"plexii.desk"}', { status: 200 })))
    expect(await fetchLiveShareBundle(LIVE)).toEqual({ ok: true, text: '{"format":"plexii.desk"}' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'no_bundle' }), { status: 404 })))
    expect(await fetchLiveShareBundle(LIVE)).toEqual({ ok: false, reason: 'not-ready' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Share not found or revoked.' }), { status: 404 })))
    expect(await fetchLiveShareBundle(LIVE)).toEqual({ ok: false, reason: 'gone' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    expect(await fetchLiveShareBundle(LIVE)).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('a read link opens whatever its scope; the scope decides what the visitor may do', () => {
  it('a desk opens, copyable or not', () => {
    expect(openRefusal({ kind: 'task', scope: 'copy' })).toBeNull()
    expect(openRefusal({ kind: 'task', scope: 'view' })).toBeNull()
    expect(readMode({ scope: 'copy' })).toBe('use')
    expect(readMode({ scope: 'view' })).toBe('view')
    expect(readMode({})).toBe('view') // no scope is not permission to add
  })

  it('a room opens too; what is neither a desk nor a room, or is gone, does not', () => {
    expect(openRefusal({ kind: 'folder', scope: 'view' })).toBeNull()
    expect(openRefusal({ kind: 'document', scope: 'copy' })).toBe('not-a-desk')
    expect(openRefusal({ kind: 'task', scope: 'copy', revoked: true })).toBe('gone')
  })

  it('copying is still the sender\'s choice (what carrying the desk into Plexii asks)', () => {
    expect(copyRefusal({ kind: 'task', scope: 'view' })).toBe('view-only')
    expect(copyRefusal({ kind: 'task', scope: 'copy' })).toBeNull()
  })
})

describe('a link to look at: adding no', () => {
  const VIEW_ACTED: CallContext = { userActed: true, adding: false, ownWidget: () => false, mode: 'view' }
  const VIEW_DROP: CallContext = { userActed: true, adding: true, ownWidget: () => false, mode: 'view' }
  const USE_DROP: CallContext = { userActed: true, adding: true, ownWidget: () => false, mode: 'use' }

  it('the app\'s own layout saves pass (the visitor\'s moves are refused at the gesture, renderer lib/shareGate.ts)', () => {
    expect(decideCall('widgets:update', ['w', { x: 1, y: 2 }], VIEW_ACTED).allowed).toBe(true)
    expect(decideCall('deskLayout:saveWorkcentre', ['u', 'd', 'desktop', {}], VIEW_ACTED).allowed).toBe(true)
  })

  it('a drop is the gate, where on a link to use it would land', () => {
    expect(decideCall('widgets:create', [{}], VIEW_DROP)).toMatchObject({ allowed: false, gate: 'Adding things to this desk' })
    expect(decideCall('files:ingestBuffer', [{}], VIEW_DROP)).toMatchObject({ allowed: false, gate: 'Adding things to this desk' })
    expect(decideCall('widgets:create', [{}], USE_DROP)).toMatchObject({ allowed: true, edits: true })
  })

  it('everything else is the gate, as on any link -- and the refusal says what the gate says', () => {
    // The same words on every link (owner, 2026-11-07).
    expect(decideCall('nodes:create', [{ kind: 'task' }], VIEW_ACTED)).toMatchObject({ gate: 'Creating a desk', why: 'Download this desk on Plexii to do that.' })
    expect(decideCall('nodes:create', [{ kind: 'task' }], { ...VIEW_ACTED, mode: 'use' }).why).toBe('Download this desk on Plexii to do that.')
    expect(decideCall('chat:sendStream', [{}], VIEW_ACTED).gate).toBe('AI')
  })

  it('the app on its own is never the gate, on any link', () => {
    expect(decideCall('widgets:create', [{}], { ...VIEW_DROP, userActed: false }).gate).toBeUndefined()
  })
})
