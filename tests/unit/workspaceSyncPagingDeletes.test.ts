import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncWorkspaceOnce } from '@renderer/lib/workspaceSync'
import { useAccountStore } from '@renderer/stores/account'

// The poll's side of the 4.3.51 sync fix (2026-11-19), against the real renderer
// client with the network and the main process stubbed.
//
// 1. A pull walks EVERY page (limit + cursor until `more` is false) and applies the
//    whole delta as one batch. Up to 4.3.50 it applied one 5,000-row legacy page at
//    a time: a child whose parent sorted into a later page failed, the stall rule
//    moved the cursor past it after three cycles, and that row never reached the
//    device. Reproduced live: four widgets of a renamed desk, gone for good.
// 2. A DELETE carries ?baseRev=<the rev this device last saw>, so the server can
//    refuse one made against an older copy (a desk restored since); a 409 applies
//    the server's copy and settles the rev instead of retrying forever.
// 3. Each cursor starts over once on the first 4.3.51 sync, to recover rows the old
//    stall rule skipped.

type Json = Record<string, unknown>
let routes: Array<{ match: (url: string, init?: RequestInit) => boolean; reply: (url: string) => Response }>
let fetchSpy: ReturnType<typeof vi.fn>
const calls = (): Array<{ url: string; method: string }> =>
  fetchSpy.mock.calls.map((c) => ({ url: String(c[0]), method: String((c[1] as RequestInit | undefined)?.method ?? 'GET') }))
const json = (body: Json, status = 200): Response => new Response(JSON.stringify(body), { status })
const item = (id: string, rev = 1, extra: Json = {}): Json => ({ id, itemType: 'node', rev, deleted: false, body: { id, title: id }, ...extra })

let api: Record<string, ReturnType<typeof vi.fn>>
let pendingDeletes: Array<{ id: string; itemType: string; baseRev: number }>

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('fb.sync.repull.4351', '1') // most tests are about one cycle, not the upgrade
  pendingDeletes = []
  routes = []
  fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    for (const r of routes) if (r.match(String(url), init)) return r.reply(String(url))
    return json({ ok: true, items: [], now: 1, roots: [], owned: [] })
  })
  vi.stubGlobal('fetch', fetchSpy)
  const empty = async (): Promise<{ upserts: never[]; deletes: never[] }> => ({ upserts: [], deletes: [] })
  api = {
    pending: vi.fn(async () => ({ upserts: [], deletes: pendingDeletes })),
    pendingShared: vi.fn(empty),
    pendingOrg: vi.fn(empty),
    getCursor: vi.fn(async () => 0),
    getCursorShared: vi.fn(async () => 0),
    setCursor: vi.fn(async () => undefined),
    setCursorShared: vi.fn(async () => undefined),
    setCursorOrg: vi.fn(async () => undefined),
    markPushed: vi.fn(async () => undefined),
    advanceBaseRev: vi.fn(async () => undefined),
    applyRemote: vi.fn(async () => ({ applied: 0, failed: 0 })),
    applyRemoteShared: vi.fn(async () => ({ applied: 0 })),
    localSharedRoots: vi.fn(async () => []),
    pruneSharedDesk: vi.fn(async () => 0),
    adoptSharedDesk: vi.fn(),
    filesMissingBytes: vi.fn(async () => [])
  }
  ;(window as unknown as { api: unknown }).api = { workspaceSync: api }
  useAccountStore.setState({ sessionToken: 'tok' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ sessionToken: null })
})

describe('a pull walks every page and applies them as one batch', () => {
  it('two pages arrive as ONE apply, and the cursor is the final page\'s now', async () => {
    routes.push({
      match: (u) => u.includes('/workspace/sync?') && !u.includes('cursor='),
      reply: () => json({ ok: true, items: [item('widget-early'), item('child')], now: 5, more: true, nextCursor: '5:child' })
    })
    routes.push({
      match: (u) => u.includes('/workspace/sync?') && u.includes('cursor=5%3Achild'),
      reply: () => json({ ok: true, items: [item('parent-later')], now: 9, more: false, nextCursor: null })
    })
    await syncWorkspaceOnce()
    const pulls = calls().filter((c) => c.url.includes('/workspace/sync?'))
    expect(pulls).toHaveLength(2)
    expect(pulls[0].url).toMatch(/limit=\d+/) // asked for pages
    expect(api.applyRemote).toHaveBeenCalledTimes(1)
    expect((api.applyRemote.mock.calls[0][0] as Json[]).map((i) => i.id)).toEqual(['widget-early', 'child', 'parent-later'])
    expect(api.setCursor).toHaveBeenCalledWith(9)
  })

  it('a server that does not page (no `more`) is one request, as before', async () => {
    routes.push({ match: (u) => u.includes('/workspace/sync?'), reply: () => json({ ok: true, items: [item('a')], now: 4 }) })
    await syncWorkspaceOnce()
    expect(calls().filter((c) => c.url.includes('/workspace/sync?'))).toHaveLength(1)
    expect(api.setCursor).toHaveBeenCalledWith(4)
  })

  it('a page that fails mid-walk applies nothing and leaves the cursor', async () => {
    routes.push({
      match: (u) => u.includes('/workspace/sync?') && !u.includes('cursor='),
      reply: () => json({ ok: true, items: [item('a')], now: 5, more: true, nextCursor: '5:a' })
    })
    routes.push({ match: (u) => u.includes('cursor='), reply: () => json({ ok: false }, 500) })
    await syncWorkspaceOnce()
    expect(api.applyRemote).not.toHaveBeenCalled()
    expect(api.setCursor).not.toHaveBeenCalled()
  })
})

describe('a DELETE names the rev it last saw', () => {
  it('sends ?baseRev=<sync_rev>, and none for a row the server never confirmed', async () => {
    pendingDeletes = [
      { id: 'seen', itemType: 'node', baseRev: 4 },
      { id: 'never-pushed', itemType: 'node', baseRev: 0 }
    ]
    routes.push({ match: (u, i) => i?.method === 'DELETE', reply: () => json({ ok: true, item: { rev: 5 } }) })
    await syncWorkspaceOnce()
    const deletes = calls().filter((c) => c.method === 'DELETE').map((c) => c.url.replace(/^.*\/workspace/, '/workspace'))
    expect(deletes).toEqual(['/workspace/items/seen?baseRev=4', '/workspace/items/never-pushed'])
    expect(api.markPushed).toHaveBeenCalledWith('node', 'seen', 5)
  })

  it('a 409 (restored since) applies the server copy and settles the rev, instead of retrying forever', async () => {
    pendingDeletes = [{ id: 'restored', itemType: 'node', baseRev: 4 }]
    const live = item('restored', 6)
    routes.push({ match: (u, i) => i?.method === 'DELETE', reply: () => json({ ok: false, conflict: true, item: live }, 409) })
    await syncWorkspaceOnce()
    expect(api.applyRemote).toHaveBeenCalledWith([
      { id: 'restored', itemType: 'node', body: live.body, rev: 6, deleted: false }
    ])
    expect(api.advanceBaseRev).toHaveBeenCalledWith('node', 'restored', 6)
    expect(api.markPushed).not.toHaveBeenCalledWith('node', 'restored', expect.anything())
  })
})

describe('the first 4.3.51 sync starts every cursor over once', () => {
  it('resets the personal and shared cursors on the first cycle only', async () => {
    localStorage.removeItem('fb.sync.repull.4351')
    await syncWorkspaceOnce()
    expect(api.setCursor.mock.calls[0]).toEqual([0])
    expect(api.setCursorShared.mock.calls[0]).toEqual([0])
    api.setCursor.mockClear()
    api.setCursorShared.mockClear()
    await syncWorkspaceOnce()
    expect(api.setCursor.mock.calls.some((c) => c[0] === 0)).toBe(false)
    expect(api.setCursorShared.mock.calls.some((c) => c[0] === 0)).toBe(false)
  })
})
