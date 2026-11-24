// Turning a link off really turns it off (4.3.55).
//
// Since signal v123 (8 Sept 2026) DELETE /share/:token is owner-only: it needs
// the owner's session, and answers 401 without one. The app's revoke sent no
// session, so the server refused every revoke; the store caught that as a
// console warning and marked the link revoked anyway. People saw "revoked"
// while everyone who had the link could still open it. Removing a link from the
// list was worse: it deleted the row without ending the link at all.
//
// Now the revoke carries the session, and the link is listed as off only when
// the server has ended it: 200, or 404 when a view-free read (?meta=1) agrees it
// is gone. 404 is also what the server tells an account that does not own the
// link (so nobody learns it exists), hence the read. A refused or failed revoke
// keeps the link listed as live and says so plainly. A one-time repair at
// launch re-sends, signed in, the revokes the old app never delivered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/signalConfig', async (orig) => {
  const real = await orig<{ signalConfig: Record<string, unknown> }>()
  return { ...real, signalConfig: { ...real.signalConfig, useRemote: true, httpUrl: 'https://signal.test' } }
})

type Row = { id: string; token: string; revoked: boolean; kind: string; entityId: string; expiresAt: number | null; createdBy: string | null }
let rows: Row[]
let calls: Array<{ method: string; path: string; auth: string | null; query: string }>
// What the server says, per token: to the DELETE, and to the ?meta=1 read.
let del: Record<string, number | 'offline'>
let meta: Record<string, number>

const link = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  token: `tok_${id}`,
  revoked: false,
  kind: 'task',
  entityId: `desk_${id}`,
  expiresAt: null,
  createdBy: null,
  ...over
})

beforeEach(async () => {
  rows = []
  calls = []
  del = {}
  meta = {}
  try {
    localStorage.clear()
  } catch {
    /* none */
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(String(url))
      const method = String(init.method ?? 'GET')
      const auth = new Headers(init.headers).get('authorization')
      calls.push({ method, path: u.pathname, auth, query: u.search })
      const token = decodeURIComponent(u.pathname.replace(/^\/share\//, ''))
      if (method === 'DELETE') {
        const s = del[token] ?? 200
        if (s === 'offline') throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify(s === 200 ? { ok: true } : { error: 'Not found.' }), { status: s })
      }
      if (method === 'GET' && u.searchParams.get('meta') === '1') {
        const s = meta[token] ?? 404
        return new Response(JSON.stringify({ ok: s === 200 }), { status: s })
      }
      return new Response('{}', { status: 404 })
    })
  )
  ;(globalThis as unknown as { window: unknown }).window ??= globalThis
  ;(window as unknown as { api: unknown }).api = {
    shares: {
      listAll: vi.fn(async () => rows.map((r) => ({ ...r }))),
      inbox: vi.fn(async () => []),
      revoke: vi.fn(async (id: string) => {
        const r = rows.find((x) => x.id === id)
        if (r) r.revoked = true
        return true
      }),
      delete: vi.fn(async (id: string) => {
        rows = rows.filter((x) => x.id !== id)
        return true
      })
    }
  }
  const { useAccountStore } = await import('@renderer/stores/account')
  useAccountStore.setState({ sessionToken: 'sess_owner', account: { id: 'acc_me', handle: 'me' } } as never)
  const { useSharesStore } = await import('@renderer/stores/shares')
  useSharesStore.setState({ outgoing: [], loaded: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function store() {
  const { useSharesStore } = await import('@renderer/stores/shares')
  await useSharesStore.getState().refresh()
  return useSharesStore
}
const deletes = (): typeof calls => calls.filter((c) => c.method === 'DELETE')

describe('turning a link off', () => {
  it('sends the owner\'s session, and the link is off once the server ends it', async () => {
    rows = [link('a')]
    const s = await store()
    expect(await s.getState().revoke('a')).toEqual({ ok: true })
    expect(deletes()).toEqual([expect.objectContaining({ path: '/share/tok_a', auth: 'Bearer sess_owner' })])
    expect(window.api.shares.revoke).toHaveBeenCalledWith('a')
    expect(s.getState().outgoing.find((r) => r.id === 'a')?.revoked).toBe(true)
  })

  it('refused by the server: the link stays listed as live, and says so', async () => {
    rows = [link('a')]
    del.tok_a = 401
    const s = await store()
    const res = await s.getState().revoke('a')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toMatch(/still works/i)
    expect(window.api.shares.revoke).not.toHaveBeenCalled()
    expect(s.getState().outgoing.find((r) => r.id === 'a')?.revoked).toBe(false)
  })

  it('the server cannot be reached: the link stays live, and says so', async () => {
    rows = [link('a')]
    del.tok_a = 'offline'
    const s = await store()
    const res = await s.getState().revoke('a')
    expect(res.ok === false && res.error).toMatch(/still works/i)
    expect(window.api.shares.revoke).not.toHaveBeenCalled()
  })

  it('404 and the link is gone (a view-free read agrees): it is off', async () => {
    rows = [link('a')]
    del.tok_a = 404
    meta.tok_a = 404
    const s = await store()
    expect(await s.getState().revoke('a')).toEqual({ ok: true })
    expect(calls.some((c) => c.method === 'GET' && c.query === '?meta=1')).toBe(true)
    expect(window.api.shares.revoke).toHaveBeenCalledWith('a')
  })

  it('404 but the link still opens (not this account\'s to end): it stays live, and says so', async () => {
    rows = [link('a')]
    del.tok_a = 404
    meta.tok_a = 200
    const s = await store()
    const res = await s.getState().revoke('a')
    expect(res.ok === false && res.error).toMatch(/can.t be turned off from this account/i)
    expect(window.api.shares.revoke).not.toHaveBeenCalled()
  })

  it('401 (it needs its account\'s session): the link stays live, and it says to sign in', async () => {
    rows = [link('a')]
    del.tok_a = 401
    const s = await store()
    const res = await s.getState().revoke('a')
    expect(res.ok === false && res.error).toMatch(/sign in to stop sharing this link/i)
    expect(window.api.shares.revoke).not.toHaveBeenCalled()
  })

  it('signed out: it is still sent, without a session (a link made signed out needs none)', async () => {
    rows = [link('a')]
    const { useAccountStore } = await import('@renderer/stores/account')
    useAccountStore.setState({ sessionToken: null, account: null } as never)
    const s = await store()
    expect(await s.getState().revoke('a')).toEqual({ ok: true })
    expect(deletes()).toEqual([expect.objectContaining({ path: '/share/tok_a', auth: null })])
  })

  it('signed out, and the link needs its account: it stays live, and it says to sign in', async () => {
    rows = [link('a')]
    del.tok_a = 401
    const { useAccountStore } = await import('@renderer/stores/account')
    useAccountStore.setState({ sessionToken: null, account: null } as never)
    const s = await store()
    const res = await s.getState().revoke('a')
    expect(res.ok === false && res.error).toMatch(/sign in to stop sharing this link/i)
    expect(window.api.shares.revoke).not.toHaveBeenCalled()
  })

  it('made by another account on this computer: nothing is sent; it waits for that account', async () => {
    rows = [link('a', { createdBy: 'someone_else' })]
    const s = await store()
    const res = await s.getState().revoke('a')
    expect(res.ok === false && res.error).toMatch(/another account/i)
    expect(deletes()).toEqual([])
    expect(window.api.shares.revoke).not.toHaveBeenCalled()
  })
})

describe('removing a link from the list', () => {
  it('a live link is turned off first, then removed', async () => {
    rows = [link('a')]
    const s = await store()
    expect(await s.getState().remove('a')).toEqual({ ok: true })
    expect(deletes().map((c) => c.path)).toEqual(['/share/tok_a'])
    expect(window.api.shares.delete).toHaveBeenCalledWith('a')
  })

  it('a live link the server will not end is NOT removed (it would still work, out of sight)', async () => {
    rows = [link('a')]
    del.tok_a = 401
    const s = await store()
    const res = await s.getState().remove('a')
    expect(res.ok).toBe(false)
    expect(window.api.shares.delete).not.toHaveBeenCalled()
    expect(s.getState().outgoing.map((r) => r.id)).toEqual(['a'])
  })

  it('a link that is already off is removed without asking the server again', async () => {
    rows = [link('a', { revoked: true })]
    localStorage.setItem('plexii.shares.revokeRepaired', JSON.stringify(['tok_a']))
    const s = await store()
    expect(await s.getState().remove('a')).toEqual({ ok: true })
    expect(deletes()).toEqual([])
    expect(window.api.shares.delete).toHaveBeenCalledWith('a')
  })
})

describe('the launch repair: revokes the old app never delivered', () => {
  it('re-sends each, signed in, once; 404 (gone) counts as done; any other answer is tried again next launch', async () => {
    rows = [
      link('ok', { revoked: true }),
      link('gone', { revoked: true }),
      link('err', { revoked: true }),
      link('live', { revoked: false })
    ]
    del.tok_gone = 404
    meta.tok_gone = 404
    del.tok_err = 500
    const { repairRevokedLinks } = await import('@renderer/stores/shares')
    await repairRevokedLinks()
    expect(deletes().map((c) => [c.path, c.auth])).toEqual([
      ['/share/tok_ok', 'Bearer sess_owner'],
      ['/share/tok_gone', 'Bearer sess_owner'],
      ['/share/tok_err', 'Bearer sess_owner']
    ])
    calls = []
    del.tok_err = 200
    await repairRevokedLinks()
    expect(deletes().map((c) => c.path), 'only the one that failed is sent again').toEqual(['/share/tok_err'])
    calls = []
    await repairRevokedLinks()
    expect(deletes(), 'all done: nothing more is sent').toEqual([])
  })

  it('a link that still opens after a 404 is never marked done: said once, and tried again next launch', async () => {
    rows = [link('theirs', { revoked: true })]
    del.tok_theirs = 404
    meta.tok_theirs = 200
    const { repairRevokedLinks } = await import('@renderer/stores/shares')
    const { useNoticeStore } = await import('@renderer/stores/notice')
    useNoticeStore.getState().clear()
    await repairRevokedLinks()
    expect(useNoticeStore.getState().notice?.text).toMatch(/1 link you turned off still works/i)
    calls = []
    useNoticeStore.getState().clear()
    await repairRevokedLinks()
    expect(deletes().map((c) => c.path), 'tried again').toEqual(['/share/tok_theirs'])
    expect(useNoticeStore.getState().notice, 'but said only once').toBeNull()
    // Once the server can end it (a0's rescue), the next launch does.
    del.tok_theirs = 200
    calls = []
    await repairRevokedLinks()
    calls = []
    await repairRevokedLinks()
    expect(deletes()).toEqual([])
  })

  it('another account\'s link is held until that account signs in here', async () => {
    rows = [link('other', { revoked: true, createdBy: 'someone_else' })]
    const { repairRevokedLinks } = await import('@renderer/stores/shares')
    await repairRevokedLinks()
    expect(deletes()).toEqual([])
    const { useAccountStore } = await import('@renderer/stores/account')
    useAccountStore.setState({ sessionToken: 'sess_other', account: { id: 'acc_other', handle: 'someone_else' } } as never)
    await repairRevokedLinks()
    expect(deletes()).toEqual([expect.objectContaining({ path: '/share/tok_other', auth: 'Bearer sess_other' })])
  })

  it('signed out: nothing is sent', async () => {
    rows = [link('ok', { revoked: true })]
    const { useAccountStore } = await import('@renderer/stores/account')
    useAccountStore.setState({ sessionToken: null } as never)
    const { repairRevokedLinks } = await import('@renderer/stores/shares')
    await repairRevokedLinks()
    expect(deletes()).toEqual([])
  })
})
