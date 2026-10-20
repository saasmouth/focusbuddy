// "Keep this device local: don't sync" (Settings > Data > Privacy, 4.3.34).
// While on, the PERSONAL workspace neither leaves nor arrives: no push, no pull,
// no file blobs, no documents mirror, no synced preferences. Desks shared with
// other people keep syncing (they exist to reach those people). Off is the
// default, and only a stored 'on' enables it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localOnlyMode, setLocalOnlyMode, LOCAL_ONLY_KEY } from '@renderer/lib/localOnlyMode'
import { syncWorkspaceOnce } from '@renderer/lib/workspaceSync'
import { cloudDocsEnabled } from '@renderer/lib/cloudDocsSync'
import { getAccountState, setAccountState } from '@renderer/lib/accountStateClient'
import { useAccountStore } from '@renderer/stores/account'
import { useSyncStatus } from '@renderer/stores/syncStatus'

let fetchSpy: ReturnType<typeof vi.fn>
const urls = (): string[] => fetchSpy.mock.calls.map((c) => String(c[0]))

beforeEach(() => {
  localStorage.clear()
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, items: [], now: 1, roots: [], owned: [] }), { status: 200 }))
  vi.stubGlobal('fetch', fetchSpy)
  const empty = async (): Promise<{ upserts: never[]; deletes: never[] }> => ({ upserts: [], deletes: [] })
  ;(window as unknown as { api: unknown }).api = {
    workspaceSync: {
      pending: vi.fn(async () => ({
        upserts: [{ id: 'n1', itemType: 'node', body: { title: 'private' }, baseRev: 0 }],
        deletes: []
      })),
      pendingShared: vi.fn(empty),
      pendingOrg: vi.fn(empty),
      getCursor: vi.fn(async () => 0),
      getCursorShared: vi.fn(async () => 0),
      setCursor: vi.fn(),
      setCursorShared: vi.fn(),
      markPushed: vi.fn(),
      applyRemote: vi.fn(async () => ({ applied: 0 })),
      applyRemoteShared: vi.fn(async () => ({ applied: 0 })),
      localSharedRoots: vi.fn(async () => []),
      pruneSharedDesk: vi.fn(async () => 0),
      adoptSharedDesk: vi.fn(),
      filesMissingBytes: vi.fn(async () => [])
    }
  }
  useAccountStore.setState({ sessionToken: 'tok' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ sessionToken: null })
})

describe('the switch', () => {
  it('is off unless a stored on says otherwise', () => {
    expect(localOnlyMode()).toBe(false)
    localStorage.setItem(LOCAL_ONLY_KEY, 'yes')
    expect(localOnlyMode()).toBe(false)
    setLocalOnlyMode(true)
    expect(localOnlyMode()).toBe(true)
    setLocalOnlyMode(false)
    expect(localOnlyMode()).toBe(false)
  })
})

describe('personal sync', () => {
  it('normally pushes and pulls the personal workspace', async () => {
    await syncWorkspaceOnce()
    expect(urls().some((u) => u.includes('/workspace/items/n1'))).toBe(true)
    expect(urls().some((u) => /\/workspace\/sync\?since=/.test(u))).toBe(true)
  })

  it('local: nothing personal leaves or arrives; shared desks still sync; status says saved locally', async () => {
    setLocalOnlyMode(true)
    await syncWorkspaceOnce()
    const u = urls()
    expect(u.some((x) => x.includes('/workspace/items/'))).toBe(false)
    expect(u.some((x) => /\/workspace\/sync\?/.test(x))).toBe(false)
    expect(u.some((x) => x.includes('/workspace/files/'))).toBe(false)
    expect(u.some((x) => x.includes('/workspace/shared/sync'))).toBe(true)
    expect((window.api as unknown as { workspaceSync: { pending: ReturnType<typeof vi.fn> } }).workspaceSync.pending).not.toHaveBeenCalled()
    expect(useSyncStatus.getState().state).toBe('disabled')
  })
})

describe('the rest of the personal scope', () => {
  it('the documents mirror is off while local', () => {
    expect(cloudDocsEnabled()).toBe(true)
    setLocalOnlyMode(true)
    expect(cloudDocsEnabled()).toBe(false)
  })

  it('synced preferences neither upload nor download while local', async () => {
    setLocalOnlyMode(true)
    expect(await getAccountState('tok', 'k')).toBeNull()
    expect(await setAccountState('tok', 'k', { a: 1 })).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
