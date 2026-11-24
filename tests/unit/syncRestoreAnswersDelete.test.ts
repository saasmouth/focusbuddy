// A Restore of something deleted elsewhere wins over the delete it answers (4.3.55).
//
// The Trash lists what was deleted on another device (syncTrash.ts). A delete
// often reaches this device over the CRDT channel before the poll has pulled the
// tombstone's rev, so a Restore here goes up at the old rev and the server says
// 409, with the tombstone. Server-wins would then trash it again, silently: the
// Restore button would not work. The restore is flagged (afterRemoteDelete) and
// was made in answer to that very delete, so the push goes again, once, at the
// tombstone's rev. Anything else in conflict is the server's, as before: an
// unflagged edit, and a flagged restore that meets a live copy (someone else
// restored or edited it first).
//
// Also here, the org half of "a restored Drive file keeps its bytes": a device
// that deletes an org file no longer deletes the server's copy of its bytes at
// once. The signal sweeps them 30 days after the tombstone, so a device restoring
// it from its Trash meanwhile has bytes to come back to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncWorkspaceOnce } from '@renderer/lib/workspaceSync'
import { useAccountStore } from '@renderer/stores/account'
import { useOrgStore } from '@renderer/stores/org'

type Json = Record<string, unknown>
let fetchSpy: ReturnType<typeof vi.fn>
let replies: Array<{ match: (url: string, init: RequestInit) => boolean; reply: (init: RequestInit) => Response }>
const json = (body: Json, status = 200): Response => new Response(JSON.stringify(body), { status })
const sent = (init: RequestInit): Json => JSON.parse(String(init.body ?? '{}')) as Json
const calls = (): Array<{ url: string; method: string; body: Json }> =>
  fetchSpy.mock.calls.map((c) => {
    const init = (c[1] ?? {}) as RequestInit
    return { url: String(c[0]), method: String(init.method ?? 'GET'), body: init.body ? sent(init) : {} }
  })

let api: Record<string, ReturnType<typeof vi.fn>>
const none = async (): Promise<{ upserts: never[]; deletes: never[] }> => ({ upserts: [], deletes: [] })
const restored = (extra: Json = {}): Json => ({
  id: 'w1',
  itemType: 'widget',
  body: { id: 'w1', task_id: 'd1', trashed_at: null },
  baseRev: 3,
  afterRemoteDelete: true,
  ...extra
})
const tombstone = (rev = 9, extra: Json = {}): Json => ({ id: 'w1', itemType: 'widget', rev, deleted: true, body: { id: 'w1' }, ...extra })

// The first PUT meets `first`; a PUT at the tombstone's rev (9) is accepted at rev 10.
function putRoute(path: string, first: Response): void {
  let n = 0
  replies.push({
    match: (u, init) => u.includes(path) && init.method === 'PUT',
    reply: (init) => (n++ === 0 ? first : sent(init).baseRev === 9 ? json({ ok: true, item: { rev: 10 } }) : json({ error: 'stale' }, 409))
  })
}
const puts = (path: string): Json[] => calls().filter((c) => c.method === 'PUT' && c.url.includes(path)).map((c) => c.body)

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('fb.sync.repull.4351', '1')
  replies = []
  fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    for (const r of replies) if (r.match(String(url), init)) return r.reply(init)
    return json({ ok: true, items: [], now: 1, roots: [], owned: [] })
  })
  vi.stubGlobal('fetch', fetchSpy)
  api = {
    pending: vi.fn(none),
    pendingShared: vi.fn(none),
    pendingOrg: vi.fn(none),
    getCursor: vi.fn(async () => 0),
    getCursorShared: vi.fn(async () => 0),
    getCursorOrg: vi.fn(async () => 0),
    setCursor: vi.fn(async () => undefined),
    setCursorShared: vi.fn(async () => undefined),
    setCursorOrg: vi.fn(async () => undefined),
    markPushed: vi.fn(async () => undefined),
    advanceBaseRev: vi.fn(async () => undefined),
    applyRemote: vi.fn(async () => ({ applied: 0, failed: 0 })),
    applyRemoteShared: vi.fn(async () => ({ applied: 0 })),
    applyRemoteOrg: vi.fn(async () => ({ applied: 0 })),
    localSharedRoots: vi.fn(async () => []),
    pruneSharedDesk: vi.fn(async () => 0),
    adoptSharedDesk: vi.fn(),
    filesMissingBytes: vi.fn(async () => []),
    hasLocalFileBytes: vi.fn(async () => true),
    fileBytesForPush: vi.fn(async () => null)
  }
  ;(window as unknown as { api: unknown }).api = { workspaceSync: api }
  useAccountStore.setState({ sessionToken: 'tok' })
  useOrgStore.setState({ activeOrgId: null, orgs: [] } as never)
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ sessionToken: null })
  useOrgStore.setState({ activeOrgId: null, orgs: [] } as never)
})

describe('personal: a restore answering a delete goes again at the tombstone\'s rev', () => {
  it('409 with the tombstone, then a PUT at rev 9, accepted; the tombstone is never applied', async () => {
    api.pending.mockResolvedValue({ upserts: [restored()], deletes: [] })
    putRoute('/workspace/items/w1', json({ item: tombstone() }, 409))
    await syncWorkspaceOnce()
    expect(puts('/workspace/items/w1').map((b) => b.baseRev)).toEqual([3, 9])
    expect(api.markPushed).toHaveBeenCalledWith('widget', 'w1', 10)
    expect(api.applyRemote.mock.calls.flatMap((c) => c[0] as Json[]).some((i) => i.id === 'w1' && i.deleted)).toBe(false)
  })

  it('control: an ordinary edit in conflict takes the server\'s copy, once', async () => {
    api.pending.mockResolvedValue({ upserts: [restored({ afterRemoteDelete: undefined })], deletes: [] })
    putRoute('/workspace/items/w1', json({ item: tombstone() }, 409))
    await syncWorkspaceOnce()
    expect(puts('/workspace/items/w1')).toHaveLength(1)
    expect(api.applyRemote).toHaveBeenCalledWith([expect.objectContaining({ id: 'w1', deleted: true, rev: 9 })])
  })

  it('a flagged restore that meets a LIVE copy (restored or edited elsewhere first) takes it, once', async () => {
    api.pending.mockResolvedValue({ upserts: [restored()], deletes: [] })
    putRoute('/workspace/items/w1', json({ item: tombstone(9, { deleted: false, body: { id: 'w1', title: 'theirs' } }) }, 409))
    await syncWorkspaceOnce()
    expect(puts('/workspace/items/w1')).toHaveLength(1)
    expect(api.applyRemote).toHaveBeenCalledWith([expect.objectContaining({ id: 'w1', deleted: false })])
  })
})

describe('the shared and org loops do the same', () => {
  it('shared desk', async () => {
    api.pendingShared.mockResolvedValue({ upserts: [restored({ rootId: 'd1' })], deletes: [] })
    putRoute('/workspace/shared/items/w1', json({ item: tombstone(9, { rootId: 'd1' }) }, 409))
    await syncWorkspaceOnce()
    expect(puts('/workspace/shared/items/w1').map((b) => b.baseRev)).toEqual([3, 9])
    expect(api.markPushed).toHaveBeenCalledWith('widget', 'w1', 10)
    expect(api.applyRemoteShared).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'w1', deleted: true })]))
  })

  it('org', async () => {
    useOrgStore.setState({ activeOrgId: 'org_1', orgs: [{ id: 'org_1', name: 'Team' }] } as never)
    api.pendingOrg.mockResolvedValue({ upserts: [restored()], deletes: [] })
    putRoute('/workspace/org/items/w1', json({ item: tombstone() }, 409))
    await syncWorkspaceOnce()
    expect(puts('/workspace/org/items/w1').map((b) => b.baseRev)).toEqual([3, 9])
    expect(api.markPushed).toHaveBeenCalledWith('widget', 'w1', 10)
    expect(api.applyRemoteOrg).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'w1', deleted: true })]), 'org_1')
  })
})

describe('an org file delete keeps the server\'s copy of its bytes (the signal sweeps them at 30 days)', () => {
  it('DELETE of the item, and no DELETE of its bytes', async () => {
    useOrgStore.setState({ activeOrgId: 'org_1', orgs: [{ id: 'org_1', name: 'Team' }] } as never)
    api.pendingOrg.mockResolvedValue({ upserts: [], deletes: [{ id: 'f1', itemType: 'file', baseRev: 4 }] })
    replies.push({
      match: (u, init) => u.includes('/workspace/org/items/f1') && init.method === 'DELETE',
      reply: () => json({ ok: true, rev: 5 })
    })
    await syncWorkspaceOnce()
    const deletes = calls().filter((c) => c.method === 'DELETE').map((c) => c.url)
    expect(deletes.some((u) => u.includes('/workspace/org/items/f1'))).toBe(true)
    expect(deletes.some((u) => u.includes('/workspace/org/files/f1'))).toBe(false)
  })
})
