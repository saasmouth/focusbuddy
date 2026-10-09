// The share page itself (src/web/boot.tsx), mounted for real against a fake
// Signal and a fake Worker, for the paths three rounds of review found:
//
//   round 2  - 503 "unavailable" keeps and opens a returning visitor's copy;
//              an untouched copy is not emptied for a version it cannot fetch
//   round 3  - M2: nothing erases a copy except its OWN link being gone -- not
//              a bare visit, an unknown token, someone else's revoked link, or
//              the visitor's own link with a "." or ")" stuck to it; and a gone
//              link takes only its own desk when other links' desks are here
//            - M3: each link has its own record, so A -> B -> A still finds
//              A's newer version, and replacing a desk replaces that desk only
//            - L2: a returning visitor whose copy is current never downloads
//              the bundle (Signal counts each download as an open)
//
// What is faked: the network (fetch), the Worker behind dbClient (a map of
// desks that imports with INSERT OR IGNORE, as the real one does), and the
// renderer's entry module. What is real: boot.tsx, share.ts, shareDesk.ts,
// shareVersion.ts and the localStorage records they keep. The real Worker side
// is tested against real SQLite in shareCopyRows.test.ts.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { useRemote: true, httpUrl: 'https://signal.test', wsUrl: 'wss://signal.test/ws' },
  cloudAppUrl: () => 'https://plexiidesk.com/share'
}))

interface FakeDesk { title: string; note: string }
const worker = vi.hoisted(() => ({
  desks: new Map<string, FakeDesk>(),
  calls: [] as Array<{ channel: string; args: unknown[] }>
}))
vi.mock('../../src/web/api/dbClient', () => ({
  startCoordinator: () => undefined,
  dbCall: async (channel: string, args: unknown[]) => {
    worker.calls.push({ channel, args })
    type B = { format?: string; desk?: { id: string }; tables?: { widgets?: Array<{ content: string; title: string }> } }
    const deskOf = (b: B): FakeDesk => ({ title: b.tables?.widgets?.[0]?.title ?? '', note: b.tables?.widgets?.[0]?.content ?? '' })
    switch (channel) {
      case 'shareCopy:deskPresent':
        return worker.desks.has(args[0] as string)
      case 'shareCopy:rootDesks':
        return [...worker.desks.keys()]
      case 'shareCopy:removeDesk':
        worker.desks.delete(args[0] as string)
        return { rootId: args[0], nodes: 1, widgets: 1, documents: 0, files: [] }
      case 'shareCopy:replaceDesk': {
        const [roots, b] = args as [string[], B]
        if (b?.format !== 'plexii.desk') return { ok: false, removed: null, reason: 'not a Plexii desk bundle' }
        for (const r of roots) worker.desks.delete(r)
        worker.desks.set(b.desk!.id, deskOf(b))
        return { ok: true, removed: roots.map((rootId) => ({ rootId })), imported: { ok: true } }
      }
      case 'shares:importBundle': {
        const b = args[0] as B
        // INSERT OR IGNORE: rows already here are kept as they are.
        if (!worker.desks.has(b.desk!.id)) worker.desks.set(b.desk!.id, deskOf(b))
        return { ok: true }
      }
      default:
        throw new Error(`unexpected channel ${channel}`)
    }
  }
}))
vi.mock('../../src/web/api/bridge', () => ({
  installBrowserApi: () => undefined,
  installFileServer: async () => undefined
}))
vi.mock('../../src/renderer/src/main', () => ({}))

// Tokens as Signal mints them: 32 characters of base64url.
const A = 'linkA_abcdefghijklmnopqrstuvwxyz'
const B = 'linkB_abcdefghijklmnopqrstuvwxyz'
const C = 'linkC_abcdefghijklmnopqrstuvwxyz'
const UNKNOWN = 'nope0_abcdefghijklmnopqrstuvwxyz'
const t0 = 1_760_000_000_000

type Route = { status: number; body: unknown }
let routes: Record<string, Route>
let requested: string[]

const offerFor = (rootId: string, updatedAt: number, title = `Desk ${rootId}`) =>
  ({ title, expiresAt: null, updatedAt, sizeBytes: 100, rootId })
const offerBody = (rootId: string, updatedAt: number): Route =>
  ({ status: 200, body: { ok: true, share: offerFor(rootId, updatedAt) } })
const bundleBody = (rootId: string, label: string): Route => ({
  status: 200,
  body: {
    format: 'plexii.desk', formatVersion: 1, desk: { id: rootId, title: rootId },
    tables: { widgets: [{ title: `Welcome ${label}`, content: `Hello from ${label}` }] }, files: [], filesOmitted: []
  }
})
const gone = (reason: 'revoked' | 'expired' | 'unknown'): Route =>
  ({ status: reason === 'unknown' ? 404 : 410, body: { ok: false, reason } })

/** A copy of `token`'s desk already in this browser, as an earlier visit left it. */
function seedLink(token: string, rootId: string, rec: { version: number | null; edited: boolean | null; declined?: number | null }, note = 'Hello from v1'): void {
  const all = JSON.parse(localStorage.getItem('fb.share.links') ?? '{}')
  all[token] = { version: rec.version, declined: rec.declined ?? null, edited: rec.edited, rootId, offer: offerFor(rootId, rec.version ?? t0) }
  localStorage.setItem('fb.share.links', JSON.stringify(all))
  worker.desks.set(rootId, { title: 'Welcome v1', note })
}
const records = (): Record<string, { version: number | null; edited: boolean | null; declined: number | null; rootId: string | null }> =>
  JSON.parse(localStorage.getItem('fb.share.links') ?? '{}')

async function boot(path: string): Promise<void> {
  window.history.pushState({}, '', path)
  document.body.innerHTML = '<div id="boot"></div><div id="root"></div>'
  vi.resetModules()
  await act(async () => {
    await import('../../src/web/boot')
  })
}

const text = (): string => document.getElementById('boot')?.textContent ?? ''
const byTestId = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label)
const bundleFetches = (token: string): number => requested.filter((p) => p === `/public/shares/${token}/bundle`).length

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
  throw new Error(`timed out waiting for ${what}; page says: ${text()}`)
}
const ready = (): Promise<void> => until(() => text().includes('Get Plexii — free'), 'the desk to open')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  worker.desks.clear()
  worker.calls.length = 0
  routes = {}
  requested = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname
    requested.push(path)
    const r = routes[path]
    if (!r) throw new TypeError('Failed to fetch')
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('a desk that is temporarily unavailable', () => {
  it('opens the returning visitor’s copy as it was, and says so (metadata route 503)', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: true }, 'my notes')
    routes[`/public/shares/${A}`] = { status: 503, body: { ok: false, reason: 'unavailable' } }
    routes[`/public/shares/${A}/bundle`] = { status: 503, body: { ok: false, reason: 'unavailable' } }
    await boot(`/s/${A}`)
    await until(() => byTestId('share-unavailable') !== null, 'the unavailable notice')
    expect(byTestId('share-unavailable')!.textContent).toContain('The shared desk is temporarily unavailable.')
    expect(text()).toContain('Desk desk-A') // the bar, i.e. the copy is open
    expect(text()).not.toMatch(/expired/i)
    expect(records()[A]).toMatchObject({ version: t0, edited: true })
    expect(worker.desks.get('desk-A')?.note).toBe('my notes')
    expect(sessionStorage.getItem('fb.share.desk')).toBe('desk-A')
  })

  it('says so, and removes nothing, when there is no copy of this link here', async () => {
    seedLink(B, 'desk-B', { version: t0, edited: true }) // another link's copy
    routes[`/public/shares/${A}`] = { status: 503, body: { ok: false, reason: 'unavailable' } }
    await boot(`/s/${A}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal page')
    expect(byTestId('share-refusal')!.textContent).toBe('That shared desk is temporarily unavailable. Try the link again in a few minutes.')
    expect(text()).toContain('Try again')
    expect(text()).not.toMatch(/expired|ask whoever sent it/i)
    expect(Object.keys(records())).toEqual([B])
    expect(worker.desks.has('desk-B')).toBe(true)
  })

  it('a first visit whose bundle answers 503 is not told the link expired, and nothing is removed', async () => {
    seedLink(B, 'desk-B', { version: t0, edited: true })
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0)
    routes[`/public/shares/${A}/bundle`] = { status: 503, body: { ok: false, reason: 'unavailable' } }
    await boot(`/s/${A}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await until(() => byTestId('share-refusal') !== null, 'the refusal page')
    expect(byTestId('share-refusal')!.textContent).toMatch(/temporarily unavailable/)
    expect(text()).not.toMatch(/expired/i)
    expect(Object.keys(records())).toEqual([B])
    expect([...worker.desks.keys()]).toEqual(['desk-B'])
  })

  it('does not touch an untouched copy for a new version it then cannot fetch', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: false })
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0 + 1000) // newer: 'load'
    routes[`/public/shares/${A}/bundle`] = { status: 503, body: { ok: false, reason: 'unavailable' } }
    await boot(`/s/${A}`)
    await until(() => byTestId('share-unavailable') !== null, 'the unavailable notice')
    expect(records()[A].version).toBe(t0)
    expect(worker.desks.get('desk-A')?.note).toBe('Hello from v1')
    expect(worker.calls.filter((c) => c.channel === 'shareCopy:replaceDesk')).toHaveLength(0)
  })

  it('an untouched copy with a newer version that CAN be fetched is replaced, fetched once', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: false })
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0 + 1000)
    routes[`/public/shares/${A}/bundle`] = bundleBody('desk-A', 'v2')
    await boot(`/s/${A}`)
    await ready()
    expect(worker.desks.get('desk-A')?.title).toBe('Welcome v2')
    expect(records()[A]).toMatchObject({ version: t0 + 1000, edited: false })
    expect(bundleFetches(A)).toBe(1)
    expect(byTestId('share-update-banner')).toBeNull()
  })
})

describe('nothing erases a copy but its own link being gone (M2)', () => {
  // The visitor opened live link A and wrote on it. Then they land on...
  const withEditedA = (): void => seedLink(A, 'desk-A', { version: t0, edited: true }, 'prospect notes: call Tuesday re pricing')
  const keptA = (): void => {
    expect(records()[A]).toMatchObject({ version: t0, edited: true, rootId: 'desk-A' })
    expect(worker.desks.get('desk-A')?.note).toBe('prospect notes: call Tuesday re pricing')
    expect(worker.calls.filter((c) => c.channel === 'shareCopy:removeDesk' || c.channel === 'shareCopy:replaceDesk')).toEqual([])
  }

  it('...a link Signal does not know (mistyped, truncated): explained, A untouched', async () => {
    withEditedA()
    routes[`/public/shares/${UNKNOWN}`] = gone('unknown')
    await boot(`/s/${UNKNOWN}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal page')
    expect(byTestId('share-refusal')!.textContent).toMatch(/not a share we recognise/)
    keptA()
  })

  it('...someone else’s link that was turned off, never opened here: explained, A untouched', async () => {
    withEditedA()
    routes[`/public/shares/${B}`] = gone('revoked')
    await boot(`/s/${B}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal page')
    expect(byTestId('share-refusal')!.textContent).toMatch(/turned off/)
    keptA()
  })

  it('...an expired link that was never opened here: explained, A untouched', async () => {
    withEditedA()
    routes[`/public/shares/${B}`] = gone('expired')
    await boot(`/s/${B}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal page')
    keptA()
  })

  it('...the share app with no link at all: the download page, A untouched', async () => {
    withEditedA()
    await boot('/')
    await until(() => byTestId('share-refusal') !== null, 'the download page')
    expect(requested).toEqual([]) // not even asked about
    keptA()
  })

  it('...a link too mangled to read: the download page, A untouched', async () => {
    withEditedA()
    await boot(`/s/${A}x`) // 33 characters: not a token Signal could have minted
    await until(() => byTestId('share-refusal') !== null, 'the download page')
    keptA()
  })

  it.each([['.'], [')'], ['),']])('...A itself, with "%s" stuck to the end by a mail client: A opens, as it was', async (tail) => {
    withEditedA()
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0)
    await boot(`/s/${A}${tail}`)
    await ready()
    expect(text()).toContain('Desk desk-A')
    keptA()
    expect(bundleFetches(A)).toBe(0)
  })
})

describe('a link that is gone takes its own copy, and only its own', () => {
  it('the only link here: the whole store goes', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: true })
    routes[`/public/shares/${A}`] = gone('revoked')
    await boot(`/s/${A}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal page')
    expect(byTestId('share-refusal')!.textContent).toContain('turned off')
    expect(localStorage.getItem('fb.share.links')).toBeNull()
    // Emptied as a whole store (OPFS), without opening the database here.
    expect(worker.calls).toEqual([])
  })

  it('with another link’s desk here: only this link’s desk goes, the other stays exactly as it was', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: true })
    seedLink(B, 'desk-B', { version: t0, edited: true }, 'notes on B')
    routes[`/public/shares/${A}`] = gone('revoked')
    await boot(`/s/${A}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal page')
    await until(() => !worker.desks.has('desk-A'), 'desk A to be removed')
    expect(worker.calls.map((c) => [c.channel, c.args[0]])).toEqual([['shareCopy:removeDesk', 'desk-A']])
    expect(Object.keys(records())).toEqual([B])
    expect(worker.desks.get('desk-B')?.note).toBe('notes on B')
  })

  it('a desk another live link also shows is not removed when one of the two links goes', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: false })
    seedLink(C, 'desk-A', { version: t0, edited: false }) // a second link to the same desk
    routes[`/public/shares/${A}`] = gone('expired')
    await boot(`/s/${A}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal page')
    expect(Object.keys(records())).toEqual([C])
    expect(worker.desks.has('desk-A')).toBe(true)
  })
})

describe('one record per link (M3)', () => {
  it('A -> B -> back to A after A was updated: A’s new version replaces A’s desk only', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: false })
    seedLink(B, 'desk-B', { version: t0, edited: false }) // B opened after A
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0 + 5000)
    routes[`/public/shares/${A}/bundle`] = bundleBody('desk-A', 'v2')
    await boot(`/s/${A}`)
    await ready()
    expect(worker.desks.get('desk-A')?.title).toBe('Welcome v2')
    expect(worker.desks.get('desk-B')?.title).toBe('Welcome v1')
    const replace = worker.calls.find((c) => c.channel === 'shareCopy:replaceDesk')!
    expect(replace.args[0]).toEqual(['desk-A'])
    expect(records()[A]).toMatchObject({ version: t0 + 5000, edited: false })
    expect(records()[B]).toMatchObject({ version: t0, edited: false })
    // ...and the next visit is current: nothing fetched, nothing replaced.
    worker.calls.length = 0
    await boot(`/s/${A}`)
    await ready()
    expect(bundleFetches(A)).toBe(1)
    expect(worker.calls.map((c) => c.channel)).toEqual(['shareCopy:deskPresent'])
  })

  it('A edited, B opened, B updated: B’s new version loads without asking, and A’s edits are untouched', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: true }, 'prospect notes on A')
    seedLink(B, 'desk-B', { version: t0, edited: false })
    routes[`/public/shares/${B}`] = offerBody('desk-B', t0 + 5000)
    routes[`/public/shares/${B}/bundle`] = bundleBody('desk-B', 'v2')
    await boot(`/s/${B}`)
    await ready()
    expect(byTestId('share-update-banner')).toBeNull()
    expect(worker.desks.get('desk-B')?.title).toBe('Welcome v2')
    expect(worker.desks.get('desk-A')?.note).toBe('prospect notes on A')
    expect(records()[A]).toMatchObject({ version: t0, edited: true })
  })

  it('an edited link’s update asks, and the confirmation does not claim other desks go', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: false })
    seedLink(B, 'desk-B', { version: t0, edited: true }, 'notes on B')
    routes[`/public/shares/${B}`] = offerBody('desk-B', t0 + 5000)
    routes[`/public/shares/${B}/bundle`] = bundleBody('desk-B', 'v2')
    await boot(`/s/${B}`)
    await until(() => byTestId('share-update-banner') !== null, 'the update banner')
    expect(bundleFetches(B)).toBe(0) // asking costs no download
    expect(worker.desks.get('desk-B')?.note).toBe('notes on B')
    await act(async () => button('Load the new version')!.click())
    const words = byTestId('share-update-confirm-text')!.textContent!
    expect(words).toMatch(/Desks from other links in this browser are not touched\./)
    expect(words).not.toMatch(/removed with it/)
  })

  it('“Keep my copy” is remembered for that link only', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: true })
    seedLink(B, 'desk-B', { version: t0, edited: true })
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0 + 5000)
    await boot(`/s/${A}`)
    await until(() => byTestId('share-update-banner') !== null, 'the update banner')
    await act(async () => button('Keep my copy')!.click())
    expect(records()[A].declined).toBe(t0 + 5000)
    expect(records()[B].declined).toBeNull()
  })

  it('a new link to a desk already here with changes: kept and asked about, nothing fetched', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: true }, 'notes on A')
    routes[`/public/shares/${C}`] = offerBody('desk-A', t0 + 9000)
    routes[`/public/shares/${C}/bundle`] = bundleBody('desk-A', 'v9')
    await boot(`/s/${C}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await until(() => byTestId('share-update-banner') !== null, 'the update banner')
    expect(byTestId('share-update-banner')!.textContent).toMatch(/You already have a copy of this desk in this browser/)
    expect(bundleFetches(C)).toBe(0)
    expect(worker.desks.get('desk-A')?.note).toBe('notes on A')
    expect(records()[C]).toMatchObject({ version: null, edited: true, rootId: 'desk-A' })
    await act(async () => button('Load the latest version')!.click())
    expect(byTestId('share-update-confirm-text')!.textContent).toMatch(/Another link you opened in this browser shows this same desk/)
  })

  it('a new link to a desk already here, untouched: replaced with this link’s version (not kept stale)', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: false })
    routes[`/public/shares/${C}`] = offerBody('desk-A', t0 + 9000)
    routes[`/public/shares/${C}/bundle`] = bundleBody('desk-A', 'v9')
    await boot(`/s/${C}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await ready()
    expect(worker.desks.get('desk-A')?.title).toBe('Welcome v9')
    expect(records()[C]).toMatchObject({ version: t0 + 9000, edited: false })
    // A's record now points at rows that came from C: version unknown, untouched.
    expect(records()[A]).toMatchObject({ version: null, edited: false })
  })

  it('a copy left by an older build (one marker for the whole browser) becomes that link’s record', async () => {
    localStorage.setItem('fb.share.imported', A)
    worker.desks.set('desk-A', { title: 'Welcome v1', note: 'old notes' })
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0)
    await boot(`/s/${A}`)
    await until(() => byTestId('share-update-banner') !== null, 'the update banner')
    // Its version and edits are unknown: asked, never replaced unasked.
    expect(byTestId('share-update-banner')!.textContent).toMatch(/may have changed since you first opened it/)
    expect(worker.desks.get('desk-A')?.note).toBe('old notes')
    expect(records()[A]).toMatchObject({ version: null, edited: null, rootId: 'desk-A' })
    expect(localStorage.getItem('fb.share.imported')).toBeNull()
    // The database showed only this link's desk: nothing untracked is left.
    expect(localStorage.getItem('fb.share.untracked')).toBeNull()
  })
})

describe('a returning visitor does not download the desk again (L2)', () => {
  it('three reloads of a current copy: metadata only, no bundle', async () => {
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0)
    routes[`/public/shares/${A}/bundle`] = bundleBody('desk-A', 'v1')
    await boot(`/s/${A}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await ready()
    expect(bundleFetches(A)).toBe(1) // the first open, which unpacks it
    for (let i = 0; i < 3; i++) {
      await boot(`/s/${A}`)
      await ready()
    }
    expect(bundleFetches(A)).toBe(1)
    expect(requested.filter((p) => p === `/public/shares/${A}`)).toHaveLength(4)
  })

  it('“Save desk file” fetches it then, when it is actually asked for', async () => {
    seedLink(A, 'desk-A', { version: t0, edited: false })
    routes[`/public/shares/${A}`] = offerBody('desk-A', t0)
    routes[`/public/shares/${A}/bundle`] = bundleBody('desk-A', 'v1')
    const created = vi.fn(() => 'blob:desk')
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() })
    await boot(`/s/${A}`)
    await ready()
    expect(bundleFetches(A)).toBe(0)
    await act(async () => button('Save desk file')!.click())
    await until(() => created.mock.calls.length === 1, 'the file to be handed over')
    expect(bundleFetches(A)).toBe(1)
  })
})
