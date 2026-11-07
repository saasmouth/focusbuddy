// The share page (src/web/boot.tsx) opening a copyable READ link as a desk:
// <share app>/c/<16-character token>, from view.plexiidesk.com's "Open this
// desk in your browser".
//
// The same harness as shareBootFlow.test.tsx. Faked: the network (Signal's
// GET /share/<token> and ?meta=1, as server.ts answers them), the Worker behind
// dbClient (a map of desks, imported INSERT OR IGNORE as the real one does),
// and the renderer's entry module. Real: boot.tsx, share.ts, readShare.ts,
// snapshotDesk.ts, shareDesk.ts, shareVersion.ts and the localStorage records.
// The real Worker import of a converted snapshot is in shareReadCopy.test.ts.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { useRemote: true, httpUrl: 'https://signal.test', wsUrl: 'wss://signal.test/ws' },
  cloudAppUrl: () => 'https://plexiidesk.com/share'
}))

interface FakeDesk { title: string; widgets: number }
const worker = vi.hoisted(() => ({
  desks: new Map<string, FakeDesk>(),
  calls: [] as Array<{ channel: string; args: unknown[] }>
}))
vi.mock('../../src/web/api/dbClient', () => ({
  startCoordinator: () => undefined,
  dbCall: async (channel: string, args: unknown[]) => {
    worker.calls.push({ channel, args })
    type B = { format?: string; desk?: { id: string; title: string }; tables?: { widgets?: unknown[] } }
    const deskOf = (b: B): FakeDesk => ({ title: b.desk?.title ?? '', widgets: b.tables?.widgets?.length ?? 0 })
    switch (channel) {
      case 'shareCopy:deskPresent':
        return worker.desks.has(args[0] as string)
      case 'shareCopy:rootDesks':
        return [...worker.desks.keys()]
      case 'shareCopy:removeDesk':
        worker.desks.delete(args[0] as string)
        return { rootId: args[0], nodes: 1, widgets: 1, documents: 0, files: [], pictures: [] }
      case 'shareCopy:replaceDesk': {
        const [roots, b] = args as [string[], B]
        if (b?.format !== 'plexii.desk') return { ok: false, removed: null, reason: 'not a Plexii desk bundle' }
        for (const r of roots) worker.desks.delete(r)
        worker.desks.set(b.desk!.id, deskOf(b))
        return { ok: true, removed: roots.map((rootId) => ({ rootId })), imported: { ok: true } }
      }
      case 'shareCopy:importDesk': {
        const b = args[0] as B
        if (b?.format !== 'plexii.desk') return { ok: false, reason: 'not a Plexii desk bundle' }
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

// Read tokens as the desktop mints them: 16 of its 31 letters.
const R = 'wq7k2m9xhbz3cdfa'
const R2 = 'hj4k5m6n7p8q9rst'
const VIEW = 'abcdefghjkmnpqrs'
const USE = 'linkA_abcdefghijklmnopqrstuvwxyz'

type Route = { status: number; body: unknown }
let routes: Record<string, Route>
let requested: string[]

const snapshot = (deskId: string, title: string) => ({
  _version: 1, kind: 'task', fromHandle: 'velvet-badger', capturedAt: 1_793_687_619_562,
  task: {
    id: deskId, kind: 'task', title, description: '', status: 'open', priority: 3, importance: 3, interest: 3,
    createdAt: 1, updatedAt: 1, completedAt: null, dueDate: null, estimateMinutes: null,
    widgets: [
      { id: `${deskId}-plan`, kind: 'page', title: 'Daily game plan', content: '', x: 80, y: 80, width: 480, height: 400, color: null },
      { id: `${deskId}-rules`, kind: 'sticky', title: 'Hard rules', content: 'No revenge trades.', x: 600, y: 80, width: 240, height: 200, color: null }
    ]
  }
})
const record = (token: string, over: Record<string, unknown> = {}, withSnapshot = true) => ({
  token, kind: 'task', title: 'Day Trading Workcentre', revoked: false, fromHandle: 'velvet-badger',
  scope: 'copy', createdAt: 1, expiresAt: null, viewCount: 3,
  ...(withSnapshot ? { snapshot: snapshot('desk-day', 'Day Trading Workcentre') } : {}),
  ...over
})
/** Signal's two answers for a read link: the metadata (?meta=1, uncounted) and the snapshot. */
function serve(token: string, over: Record<string, unknown> = {}): void {
  routes[`/share/${token}?meta=1`] = { status: 200, body: { ok: true, record: record(token, over, false) } }
  routes[`/share/${token}`] = { status: 200, body: { ok: true, record: record(token, over) } }
}
const gone = (token: string): void => {
  const body = { ok: false, error: 'Share not found or revoked.' }
  routes[`/share/${token}?meta=1`] = { status: 404, body }
  routes[`/share/${token}`] = { status: 404, body }
}
const records = (): Record<string, { rootId: string | null; offer: { rootId: string; sizeBytes: number } | null }> =>
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
const snapshotFetches = (token: string): number => requested.filter((p) => p === `/share/${token}`).length
const imports = (): number => worker.calls.filter((c) => c.channel === 'shareCopy:importDesk').length

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
  throw new Error(`timed out waiting for ${what}; page says: ${text()}`)
}
// The bar's call to action is "Download this desk" since the download gate (2026-11-07).
const ready = (): Promise<void> => until(() => text().includes('Download this desk'), 'the desk to open')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  worker.desks.clear()
  worker.calls.length = 0
  routes = {}
  requested = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url))
    const key = u.pathname + u.search
    requested.push(key)
    const r = routes[key]
    if (!r) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('a copyable read link, opened as a desk', () => {
  it('a brand-new visitor: one button, and the desk is theirs -- with no desk of their own first', async () => {
    serve(R)
    await boot(`/share/c/${R}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    expect(text()).toContain('Day Trading Workcentre')
    expect(text()).not.toContain('0.0 MB') // size unknown until fetched: left out
    // Reading the offer moved no view counter.
    expect(requested.filter((p) => p !== '/app-release.json')).toEqual([`/share/${R}?meta=1`])
    expect(worker.desks.size).toBe(0)

    await act(async () => button('Open the desk')!.click())
    await ready()
    expect(worker.desks.get('desk-day')).toEqual({ title: 'Day Trading Workcentre', widgets: 2 })
    expect(snapshotFetches(R)).toBe(1) // fetched once, though it was needed twice
    expect(imports()).toBe(1)
    expect(sessionStorage.getItem('fb.share.desk')).toBe('desk-day')
    expect(sessionStorage.getItem('fb.share.recipient')).toBe(R)
    expect(records()[R]).toMatchObject({ rootId: 'desk-day', offer: { rootId: 'desk-day' } })
    expect(records()[R].offer!.sizeBytes).toBeGreaterThan(0)
  })

  it('reopening the link goes straight back to the same desk: no second copy, no second download', async () => {
    serve(R)
    await boot(`/share/c/${R}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await ready()
    requested.length = 0
    worker.calls.length = 0

    await boot(`/share/c/${R}`)
    await ready()
    expect(worker.desks.size).toBe(1)
    expect(imports()).toBe(0)
    expect(snapshotFetches(R)).toBe(0)
    expect(requested.filter((p) => p !== '/app-release.json')).toEqual([`/share/${R}?meta=1`])
    expect(sessionStorage.getItem('fb.share.desk')).toBe('desk-day')
  })

  it('a second read link to the same desk does not duplicate it either', async () => {
    serve(R)
    serve(R2)
    await boot(`/share/c/${R}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await ready()

    await boot(`/share/c/${R2}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await ready()
    expect([...worker.desks.keys()]).toEqual(['desk-day'])
    expect(imports()).toBe(1)
  })
})

describe('what a read link does not allow', () => {
  it('a view-only link opens too -- as a desk to look at (owner, 2026-11-07: every link opens the full app)', async () => {
    serve(VIEW, { scope: 'view' })
    await boot(`/share/c/${VIEW}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    expect(text()).toContain('A desk has been shared with you to look at')
    await act(async () => button('Open the desk')!.click())
    await until(() => text().includes('shared to look at'), 'the desk to open')
    // Looking at it, not taking it: no desk file. The bar says what every
    // link's bar says (owner, 2026-11-07: "Download this desk on Plexii" on
    // every link); the gate, not the bar, says this one stays here.
    expect(text()).not.toContain('Save desk file')
    expect(byTestId('share-take-desk')?.textContent).toBe('Download this desk')
    expect(text()).not.toContain('Get Plexii')
    expect(imports()).toBe(1)
    expect(records()[VIEW]).toBeTruthy()
  })

  it('a room link opens too: the room and its desks are unpacked, and the room is what the link names', async () => {
    const ROOM = 'z7k6g7wn5xq32uqw'
    const desk = snapshot('desk-math', 'Math').task
    serve(ROOM, {
      kind: 'folder', scope: 'view', title: 'Year 6',
      snapshot: { _version: 1, kind: 'folder', fromHandle: 'silent-tortoise', capturedAt: 1_793_687_619_562,
        folder: { id: 'room-6', kind: 'folder', title: 'Year 6', description: '', status: 'open' },
        tasks: [desk, { ...snapshot('desk-ela', 'ELA').task }] }
    })
    await boot(`/share/c/${ROOM}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    // A room says it is a room (it said "A desk" until 2026-11-07).
    expect(text()).toContain('A room has been shared with you to look at')
    await act(async () => button('Open the desk')!.click())
    await until(() => byTestId('share-take-desk') !== null, 'the room to open')
    expect(imports()).toBe(1)
    expect(records()[ROOM]?.rootId).toBe('room-6')
  })

  it('the viewer link it points at for what it cannot open asks the viewer to keep it (?classic=1)', async () => {
    serve(R, { kind: 'document' })
    await boot(`/share/c/${R}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal')
    expect((byTestId('share-read-instead') as HTMLAnchorElement).getAttribute('href')).toBe(`https://view.plexiidesk.com/share/${R}?classic=1`)
  })

  it('a link that is not a desk is refused the same way', async () => {
    serve(R, { kind: 'document' })
    await boot(`/share/c/${R}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal')
    expect(byTestId('share-refusal')!.textContent).toMatch(/something other than a desk/)
    expect(byTestId('share-read-instead')).not.toBeNull()
    expect(imports()).toBe(0)
  })

  it('a gone link a visitor never opened: explained, and another link’s desk is untouched', async () => {
    serve(R)
    await boot(`/share/c/${R}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await ready()

    gone(R2)
    await boot(`/share/c/${R2}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal')
    expect(byTestId('share-refusal')!.textContent).toMatch(/no longer working/)
    expect(byTestId('share-read-instead')).toBeNull()
    expect(worker.desks.has('desk-day')).toBe(true)
    expect(records()[R]).toBeDefined()
  })

  it('a link this browser opened and the sender turned off takes its own copy with it', async () => {
    serve(R)
    await boot(`/share/c/${R}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    await act(async () => button('Open the desk')!.click())
    await ready()

    gone(R)
    await boot(`/share/c/${R}`)
    await until(() => byTestId('share-refusal') !== null, 'the refusal')
    expect(records()[R]).toBeUndefined()
  })

  it('an unreachable server is not called a dead link', async () => {
    await boot(`/share/c/${R}`) // no routes: every fetch fails
    await until(() => byTestId('share-refusal') !== null, 'the refusal')
    expect(byTestId('share-refusal')!.textContent).toMatch(/could not be reached/)
    expect(text()).toContain('Try again')
  })
})

describe('the use link is still the use link', () => {
  it('/share/s/<token> asks the use routes, never the read ones', async () => {
    routes[`/public/shares/${USE}`] = { status: 200, body: { ok: true, share: { title: 'Use desk', expiresAt: null, updatedAt: 5, sizeBytes: 2_000_000, rootId: 'desk-use' } } }
    await boot(`/share/s/${USE}`)
    await until(() => text().includes('Open the desk'), 'the offer card')
    expect(text()).toContain('2.0 MB')
    expect(requested).toEqual([`/public/shares/${USE}`])
  })
})
