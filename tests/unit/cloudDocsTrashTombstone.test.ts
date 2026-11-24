// A personal document moved to Trash is deleted on the server at once (4.3.55).
//
// The owner's rule (24 Nov 2026): what you delete is erased from our server 30
// days after you delete it. The signal erases 30 days after its tombstone, so a
// delete has to reach it when it is made. Personal documents (the cloud documents
// mirror, lib/cloudDocsSync.ts) only told the cloud on "Delete forever", and
// documents never age out of a device's Trash, so a trashed document stayed a live
// cloud copy with no limit at all. Now:
//
//   - moving a personal document to Trash sends the cloud delete;
//   - if that cannot go now (offline, or "Keep this device local"), the id waits
//     in a small per-device list (ids only) and goes with the next pull, once sync
//     is on; a document that never reached the cloud has nothing to delete;
//   - Restore, and Undo of the move, put the cloud copy back;
//   - org documents are untouched here: they sync, and are deleted, through the
//     org workspace loop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAccountStore } from '@renderer/stores/account'
import { useOrgStore } from '@renderer/stores/org'
import { useDocumentsStore } from '@renderer/stores/documents'
import { setCloudDocsEnabled, pullCloudDocs } from '@renderer/lib/cloudDocsSync'

type Call = { url: string; method: string }
let calls: Call[]
let offline = false
const doc = { id: 'doc1', docType: 'doc', title: 'Brief', body: { type: 'doc' }, archived: false, createdAt: 1, updatedAt: 2 }
const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 })
const cloudCalls = (method: string): string[] => calls.filter((c) => c.method === method && c.url.includes('/documents/')).map((c) => c.url)

beforeEach(() => {
  localStorage.clear()
  calls = []
  offline = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: String(init.method ?? 'GET') })
      if (offline) throw new TypeError('Failed to fetch')
      if (String(url).includes('/documents/sync')) return json({ ok: true, documents: [], now: 5 })
      if (init.method === 'PUT') return json({ ok: true, document: { ...doc, rev: 7, deleted: false } })
      return json({ ok: true })
    })
  )
  ;(window as unknown as { api: unknown }).api = {
    documents: {
      delete: vi.fn(async () => true),
      restore: vi.fn(async () => true),
      get: vi.fn(async () => doc),
      list: vi.fn(async () => [doc]),
      listTrashed: vi.fn(async () => [])
    },
    messaging: {}
  }
  useAccountStore.setState({ sessionToken: 'tok' })
  useOrgStore.setState({ activeOrgId: null, orgs: [] } as never)
  setCloudDocsEnabled(true)
  // This device has had the document in the cloud, at rev 3.
  localStorage.setItem('fb.clouddocs.revs', JSON.stringify({ doc1: 3 }))
  useDocumentsStore.setState({ list: [doc], active: null } as never)
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ sessionToken: null })
})

describe('a personal document moved to Trash', () => {
  it('is deleted on the server at once', async () => {
    await useDocumentsStore.getState().remove('doc1')
    await vi.waitFor(() => expect(cloudCalls('DELETE')).toEqual([expect.stringContaining('/documents/doc1')]))
  })

  it('offline: the delete waits (id only) and goes with the next pull', async () => {
    offline = true
    await useDocumentsStore.getState().remove('doc1')
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(localStorage.getItem('fb.clouddocs.pendingDeletes') ?? '[]')).toEqual(['doc1'])
    offline = false
    calls = []
    await pullCloudDocs()
    expect(cloudCalls('DELETE')).toEqual([expect.stringContaining('/documents/doc1')])
    expect(JSON.parse(localStorage.getItem('fb.clouddocs.pendingDeletes') ?? '[]')).toEqual([])
  })

  it('a document that never reached the cloud has nothing to delete there', async () => {
    localStorage.setItem('fb.clouddocs.revs', JSON.stringify({}))
    offline = true
    await useDocumentsStore.getState().remove('doc1')
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(localStorage.getItem('fb.clouddocs.pendingDeletes') ?? '[]')).toEqual([])
  })

  it('Restore puts the cloud copy back, and a delete still waiting is dropped', async () => {
    offline = true
    await useDocumentsStore.getState().remove('doc1')
    await new Promise((r) => setTimeout(r, 0))
    offline = false
    calls = []
    await useDocumentsStore.getState().restore('doc1')
    await vi.waitFor(() => expect(cloudCalls('PUT')).toEqual([expect.stringContaining('/documents/doc1')]))
    expect(JSON.parse(localStorage.getItem('fb.clouddocs.pendingDeletes') ?? '[]')).toEqual([])
    calls = []
    await pullCloudDocs()
    expect(cloudCalls('DELETE')).toEqual([])
  })

  it('Undo of the move puts it back too', async () => {
    const { useActionHistory } = await import('@renderer/stores/actionHistory')
    await useDocumentsStore.getState().remove('doc1')
    await vi.waitFor(() => expect(cloudCalls('DELETE')).toHaveLength(1))
    calls = []
    await useActionHistory.getState().undo()
    await vi.waitFor(() => expect(cloudCalls('PUT')).toEqual([expect.stringContaining('/documents/doc1')]))
  })

  it('in an org workspace nothing goes this way (the org loop deletes org documents)', async () => {
    useOrgStore.setState({ activeOrgId: 'org_team', orgs: [{ id: 'org_team', name: 'Team' }] } as never)
    await useDocumentsStore.getState().remove('doc1')
    await new Promise((r) => setTimeout(r, 10))
    expect(cloudCalls('DELETE')).toEqual([])
    useOrgStore.setState({ activeOrgId: null, orgs: [] } as never)
  })
})

describe('a cloud delete pulled from another device', () => {
  it('is applied as a delete from elsewhere (origin sync), so it is in the Trash under "Deleted elsewhere"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/documents/sync')
          ? json({ ok: true, documents: [{ ...doc, rev: 4, deleted: true }], now: 9 })
          : json({ ok: true })
      )
    )
    await pullCloudDocs()
    const api = (window as unknown as { api: { documents: { delete: ReturnType<typeof vi.fn> } } }).api
    expect(api.documents.delete).toHaveBeenCalledWith('doc1', 'sync')
  })
})
