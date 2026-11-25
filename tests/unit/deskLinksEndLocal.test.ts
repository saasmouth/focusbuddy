// Deleting a desk on a device that keeps its workspace local ends its links
// (4.3.56).
//
// The owner, 24 Nov 2026: deleting a desk or room ends its links at once. The
// signal does it when the desk's delete arrives. On a device set to "Keep this
// device local" the personal workspace never syncs, so for a personal desk no
// delete ever arrives and its links would go on working. The app made those
// links, so it ends them itself: copy/read links (the shares store's revoke),
// "use" links (the ephemeral revoke) and a live desk (liveDesk.stop). Org
// workspaces and desks shared by name still sync there, and the server ends
// theirs; nor does a device that syncs need to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/signalConfig', async (orig) => {
  const real = await orig<{ signalConfig: Record<string, unknown> }>()
  return { ...real, signalConfig: { ...real.signalConfig, useRemote: true, httpUrl: 'https://signal.test' } }
})

type Row = { id: string; token: string; revoked: boolean; kind: string; entityId: string; expiresAt: number | null; createdBy: string | null }
const row = (id: string, kind: string, entityId: string): Row => ({ id, token: `tok_${id}`, revoked: false, kind, entityId, expiresAt: null, createdBy: null })

let rows: Row[]
let deleted: string[]
let ephemeral: Array<{ token: string; rootId: string }>
let refuse: Set<string>
let stopped: string[]

beforeEach(async () => {
  rows = []
  deleted = []
  stopped = []
  refuse = new Set()
  ephemeral = []
  try {
    localStorage.clear()
    localStorage.setItem('plexii.sync.localOnly', 'on')
  } catch {
    /* none */
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(String(url))
      const method = String(init.method ?? 'GET')
      if (method === 'DELETE') {
        const t = decodeURIComponent(u.pathname.split('/').pop() ?? '')
        deleted.push(u.pathname)
        return new Response('{}', { status: refuse.has(t) ? 401 : 200 })
      }
      if (u.pathname === '/shares/ephemeral') {
        return new Response(
          JSON.stringify({ ok: true, shares: ephemeral.map((e) => ({ ...e, title: 'x', sizeBytes: 1, createdAt: 1, expiresAt: null, updatedAt: 1, opens: 0, lastOpenedAt: null })) }),
          { status: 200 }
        )
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
      })
    },
    widgets: { get: vi.fn(async (id: string) => (id === 'w_on_desk' ? { id, taskId: 'desk_1' } : id === 'w_elsewhere' ? { id, taskId: 'desk_other' } : null)) },
    liveDesk: {
      stop: vi.fn(async (id: string) => {
        stopped.push(id)
        return { ok: true }
      })
    }
  }
  const { useAccountStore } = await import('@renderer/stores/account')
  useAccountStore.setState({ sessionToken: 'sess', account: { id: 'acc_me', handle: 'me' } } as never)
  const { useOrgStore, PERSONAL_ORG_ID } = await import('@renderer/stores/org')
  useOrgStore.setState({ activeOrgId: PERSONAL_ORG_ID } as never)
  const { useSharesStore } = await import('@renderer/stores/shares')
  useSharesStore.setState({ outgoing: [], loaded: false })
  const { useNoticeStore } = await import('@renderer/stores/notice')
  useNoticeStore.getState().clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const room = { id: 'room_1', title: 'Clients', sharedRootId: null }

describe('a personal desk deleted on a device that keeps its workspace local', () => {
  it('ends the links the app made for it and everything under it, and no others', async () => {
    rows = [
      row('room', 'folder', 'room_1'),
      row('desk', 'task', 'desk_1'),
      row('widget', 'widget', 'w_on_desk'),
      row('other', 'task', 'desk_other'),
      row('otherWidget', 'widget', 'w_elsewhere'),
      row('doc', 'document', 'desk_1') // a document's id is not a desk's, whatever it is
    ]
    ephemeral = [
      { token: 'use_1', rootId: 'desk_1' },
      { token: 'use_other', rootId: 'desk_other' }
    ]
    const { endLinksOfDeletedDesks } = await import('@renderer/lib/deskLinksEnd')
    const res = await endLinksOfDeletedDesks(room, ['room_1', 'desk_1'])
    expect(res).toEqual({ copies: 3, useLinks: 1, failed: [] })
    expect(deleted.sort()).toEqual(['/share/tok_desk', '/share/tok_room', '/share/tok_widget', '/shares/ephemeral/use_1'])
    expect(rows.filter((r) => r.revoked).map((r) => r.id).sort()).toEqual(['desk', 'room', 'widget'])
    expect(stopped.sort(), 'a live desk of any of them stops').toEqual(['desk_1', 'room_1'])
  })

  it('a link the server will not end: said plainly, and it stays listed as live', async () => {
    rows = [row('desk', 'task', 'desk_1')]
    refuse.add('tok_desk')
    const { endLinksOfDeletedDesks } = await import('@renderer/lib/deskLinksEnd')
    const res = await endLinksOfDeletedDesks({ id: 'desk_1', title: 'Plan', sharedRootId: null }, ['desk_1'])
    expect(res?.failed).toHaveLength(1)
    expect(rows[0].revoked).toBe(false)
    const { useNoticeStore } = await import('@renderer/stores/notice')
    expect(useNoticeStore.getState().notice?.text).toMatch(/A link to “Plan” still works/)
  })
})

describe('where the server ends them itself, the app sends nothing', () => {
  it('a device that syncs', async () => {
    localStorage.setItem('plexii.sync.localOnly', 'off')
    rows = [row('desk', 'task', 'desk_1')]
    const { endLinksOfDeletedDesks } = await import('@renderer/lib/deskLinksEnd')
    expect(await endLinksOfDeletedDesks({ id: 'desk_1', title: 'P', sharedRootId: null }, ['desk_1'])).toBeNull()
    expect(deleted).toEqual([])
    expect(stopped).toEqual([])
  })

  it('an organisation\'s workspace (it still syncs on a local device)', async () => {
    const { useOrgStore } = await import('@renderer/stores/org')
    useOrgStore.setState({ activeOrgId: 'org_acme' } as never)
    rows = [row('desk', 'task', 'desk_1')]
    const { endLinksOfDeletedDesks } = await import('@renderer/lib/deskLinksEnd')
    expect(await endLinksOfDeletedDesks({ id: 'desk_1', title: 'P', sharedRootId: null }, ['desk_1'])).toBeNull()
    expect(deleted).toEqual([])
  })

  it('a desk shared by name (it still syncs on a local device)', async () => {
    rows = [row('desk', 'task', 'desk_1')]
    const { endLinksOfDeletedDesks } = await import('@renderer/lib/deskLinksEnd')
    expect(await endLinksOfDeletedDesks({ id: 'desk_1', title: 'P', sharedRootId: 'desk_1' }, ['desk_1'])).toBeNull()
    expect(deleted).toEqual([])
  })
})

describe('the delete itself calls it', () => {
  it('nodes.remove and nodes.removeMany hand over every id they trashed', async () => {
    const src = (await import('node:fs')).readFileSync('src/renderer/src/stores/nodes.ts', 'utf8')
    const remove = src.slice(src.indexOf('  remove: async (id) => {'), src.indexOf('  removeMany: async (rootIds) => {'))
    const removeMany = src.slice(src.indexOf('  removeMany: async (rootIds) => {'), src.indexOf('  moveToOrg: async'))
    expect(remove).toContain('endLinksOfDeletedDesks(target, ids)')
    expect(removeMany).toContain('endLinksOfDeletedDesks(t, ')
  })
})
