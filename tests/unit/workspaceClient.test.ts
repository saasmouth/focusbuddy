import { describe, it, expect, vi } from 'vitest'
import {
  WorkspaceClient,
  applyDelta,
  liveItems,
  pruneTombstones,
  type WorkspaceItem
} from '../../src/shared/workspaceClient'

// The desktop already syncs its whole workspace to Signal -- nodes, widgets,
// tables, rows, time blocks -- with revisions, tombstones and delta cursors,
// across a personal scope and one per org. That substrate is live: the server
// holds this data today. What was missing is a client that can reach it from
// outside Electron, which is what a cloud Plexii needs before anything else.
//
// The interesting cases here are the ones that lose work silently: a cursor
// advanced past changes that were never applied, a tombstone treated as an
// absent item, and a stale response overwriting a newer local copy.

const item = (over: Partial<WorkspaceItem> = {}): WorkspaceItem => ({
  id: 'n1',
  itemType: 'node',
  body: { title: 'Desk' },
  rev: 1,
  deleted: false,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

function client(handler: (url: string, init?: RequestInit) => Response, token = 'sess') {
  const fetchImpl = vi.fn(async (u: string | URL | Request, i?: RequestInit) =>
    handler(String(u), i)
  ) as unknown as typeof fetch
  return {
    api: new WorkspaceClient({ apiBase: 'https://s.test', token, fetchImpl }),
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>
  }
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('pulling a delta', () => {
  it('returns the server cursor, not the one it was given', async () => {
    // Reusing the old cursor repeats work; inventing one loses it.
    const { api } = client(() => json({ ok: true, items: [item()], now: 500 }))
    const out = await api.pull({ kind: 'personal' }, 100)
    expect(out.cursor).toBe(500)
    expect(out.items).toHaveLength(1)
  })

  it('keeps the caller\'s cursor when the server sends none', async () => {
    const { api } = client(() => json({ ok: true, items: [] }))
    expect((await api.pull({ kind: 'personal' }, 42)).cursor).toBe(42)
  })

  it('addresses each scope separately', async () => {
    // A personal cursor advanced against an org's changes would skip everything
    // in between, permanently.
    const seen: string[] = []
    const { api } = client((u) => {
      seen.push(new URL(u).pathname)
      return json({ ok: true, items: [], now: 1 })
    })
    await api.pull({ kind: 'personal' }, 0)
    await api.pull({ kind: 'org', orgId: 'o1' }, 0)
    await api.pull({ kind: 'shared', token: 'tok' }, 0)
    expect(seen).toEqual(['/workspace/sync', '/workspace/org/sync', '/workspace/shared/sync'])
  })

  it('carries the share token on a shared pull', async () => {
    let url = ''
    const { api } = client((u) => { url = u; return json({ ok: true, items: [], now: 1 }) })
    await api.pull({ kind: 'shared', token: 'tok 1' }, 0)
    expect(url).toContain('token=tok%201')
  })

  it('refuses to treat a failure as an empty workspace', async () => {
    // Returning nothing here would look exactly like "everything was deleted".
    const { api } = client(() => json({ ok: false, error: 'nope' }, 200))
    await expect(api.pull({ kind: 'personal' }, 0)).rejects.toThrow(/nope/)
    const { api: api2 } = client(() => json({}, 500))
    await expect(api2.pull({ kind: 'personal' }, 0)).rejects.toThrow(/HTTP 500/)
  })
})

describe('writing an item', () => {
  it('sends the base revision it last saw', async () => {
    let sent: Record<string, unknown> = {}
    const { api } = client((_u, i) => {
      sent = JSON.parse(String(i?.body))
      return json({ ok: true, rev: 4 })
    })
    const out = await api.upsert({ kind: 'personal' }, { id: 'n1', itemType: 'node', body: { a: 1 }, baseRev: 3 })
    expect(sent.baseRev).toBe(3)
    expect(out).toEqual({ ok: true, rev: 4 })
  })

  it('reports a conflict as data, with the copy the server holds', async () => {
    // Two clients editing one workspace is the point of this feature, so a
    // conflict is a normal outcome and the caller needs the other copy to
    // resolve it -- not an exception with nothing in it.
    const current = item({ rev: 9, body: { title: 'Theirs' } })
    const { api } = client(() => json({ ok: false, current }, 409))
    const out = await api.upsert({ kind: 'personal' }, { id: 'n1', itemType: 'node', body: {}, baseRev: 3 })
    expect(out).toEqual({ ok: false, conflict: true, current })
  })

  it('does not mistake a transport failure for a conflict', async () => {
    const { api } = client(() => json({}, 503))
    const out = await api.upsert({ kind: 'personal' }, { id: 'n1', itemType: 'node', body: {}, baseRev: 1 })
    expect(out).toEqual({ ok: false, conflict: false, error: 'HTTP 503' })
  })

  it('authenticates, and names the org on org-scoped calls', async () => {
    let headers: Record<string, string> = {}
    const fetchImpl = vi.fn(async (_u: unknown, i?: RequestInit) => {
      headers = (i?.headers ?? {}) as Record<string, string>
      return json({ ok: true, rev: 1 })
    }) as unknown as typeof fetch
    const api = new WorkspaceClient({ apiBase: 'https://s.test', token: 't', orgId: 'o1', fetchImpl })
    await api.upsert({ kind: 'org', orgId: 'o1' }, { id: 'n1', itemType: 'node', body: {}, baseRev: 0 })
    expect(headers.Authorization).toBe('Bearer t')
    expect(headers['x-fb-org']).toBe('o1')
  })
})

describe('applying a delta', () => {
  it('stops showing what a tombstone names', async () => {
    // Treating a tombstone as an absent item leaves deleted work on screen for
    // ever, which is how a sync client quietly disagrees with itself.
    const into = new Map([['n1', item()]])
    applyDelta(into, [item({ deleted: true, rev: 2 })])
    expect(liveItems(into)).toEqual([])
  })

  it('ignores a copy older than the one in hand', () => {
    // A slow response arriving after a newer one must not resurrect old work.
    const into = new Map([['n1', item({ rev: 5, body: { title: 'New' } })]])
    applyDelta(into, [item({ rev: 2, body: { title: 'Old' } })])
    expect((into.get('n1')?.body as { title: string }).title).toBe('New')
  })

  it('never resurrects deleted work with an older copy', () => {
    // The deletion has already gone past the cursor and will never be sent
    // again, so if a stale copy could undo it the work would stay back for
    // good. This is why tombstones are kept rather than removed.
    const into = new Map<string, WorkspaceItem>()
    applyDelta(into, [item({ deleted: true, rev: 9 })])
    applyDelta(into, [item({ rev: 3, body: { title: 'Zombie' } })])
    expect(liveItems(into)).toEqual([])
  })

  it('accepts a genuine re-creation, which carries a newer revision', () => {
    const into = new Map<string, WorkspaceItem>()
    applyDelta(into, [item({ deleted: true, rev: 9 })])
    applyDelta(into, [item({ rev: 10, body: { title: 'Back on purpose' } })])
    expect(liveItems(into)).toHaveLength(1)
  })

  it('forgets old tombstones so the client does not grow for ever', () => {
    const into = new Map<string, WorkspaceItem>()
    applyDelta(into, [item({ id: 'old', deleted: true, rev: 2, updatedAt: 100 })])
    applyDelta(into, [item({ id: 'recent', deleted: true, rev: 2, updatedAt: 900 })])
    expect(pruneTombstones(into, 500)).toBe(1)
    expect([...into.keys()]).toEqual(['recent'])
  })

  it('applies a batch in order and returns the same map', () => {
    const into = new Map<string, WorkspaceItem>()
    const out = applyDelta(into, [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'a', rev: 2 })])
    expect(out).toBe(into)
    expect([...out.keys()].sort()).toEqual(['a', 'b'])
    expect(out.get('a')?.rev).toBe(2)
  })
})
