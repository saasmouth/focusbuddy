// "Stop sharing and delete the shared copy" (4.3.56).
//
// A document shared live keeps a copy on our server: its text, its edit log,
// comments, files, members. Deleting your own document on your computer never
// touched that copy. The signal now has an owner-only DELETE /livedocs/:id
// (a0, signal-livedoc-delete a85129a3) that erases it at once:
//   200 {ok:true}  deleted (also when already gone, so a retry is safe)
//   403            not the owner: the document stays whole
//   409            an organisation document's live room: it follows the org
//                  document's own delete, so the button is never offered there
//   401            no session
// Members are told by a docLockChanged push (holder null): their list drops it,
// and an editor that has it open closes with a word, since it no longer exists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAccountStore } from '@renderer/stores/account'
import { useNoticeStore } from '@renderer/stores/notice'
import { deleteLiveDoc, canDeleteSharedCopy } from '@renderer/lib/docCollabClient'

// The socket forwards live-document events to ONE registered handler; capture it.
let docHandler: ((e: unknown) => void) | null = null
vi.mock('@renderer/lib/messagingSocket', async (orig) => ({
  ...(await orig<object>()),
  setDocSocketHandler: (cb: ((e: unknown) => void) | null) => {
    docHandler = cb
  }
}))

let replies: Record<string, { status: number; body: unknown }>
let calls: Array<{ method: string; url: string }>
const respond = (status: number, body: unknown): { status: number; body: unknown } => ({ status, body })

beforeEach(() => {
  replies = {}
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = String(init.method ?? 'GET')
      calls.push({ method, url: String(url) })
      const key = `${method} ${new URL(String(url)).pathname}`
      const r = replies[key] ?? respond(404, { ok: false, error: 'Not found.' })
      return new Response(JSON.stringify(r.body), { status: r.status })
    })
  )
  useAccountStore.setState({ sessionToken: 'tok', account: { id: 'acc_me' } } as never)
  useNoticeStore.getState().clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ sessionToken: null })
})

describe('the client call', () => {
  it('maps the server\'s answers', async () => {
    replies['DELETE /livedocs/ldoc_1'] = respond(200, { ok: true })
    expect(await deleteLiveDoc('tok', 'ldoc_1')).toEqual({ ok: true })
    replies['DELETE /livedocs/ldoc_1'] = respond(403, { ok: false, error: 'Only the owner can delete this document.' })
    expect(await deleteLiveDoc('tok', 'ldoc_1')).toEqual({ ok: false, status: 403, error: 'Only the owner can delete this document.' })
    replies['DELETE /livedocs/doc_org'] = respond(409, { ok: false, error: "This is a document in your organisation's workspace. Delete it there; its live copy is erased 30 days later." })
    expect(await deleteLiveDoc('tok', 'doc_org')).toMatchObject({ ok: false, status: 409 })
  })
})

describe('who is offered the button', () => {
  const item = (over: Record<string, unknown>) => ({ id: 'ldoc_1', ownerAccountId: 'acc_me', docType: 'doc', title: 'Brief', version: 1, updatedBy: null, createdAt: 1, updatedAt: 1, ...over }) as never
  it('the owner of a personal live document (ldoc_ id)', () => {
    expect(canDeleteSharedCopy(item({}), 'acc_me')).toBe(true)
  })
  it('not a member, and not an organisation document\'s live room', () => {
    expect(canDeleteSharedCopy(item({ ownerAccountId: 'acc_other' }), 'acc_me')).toBe(false)
    expect(canDeleteSharedCopy(item({ id: 'doc_org_123' }), 'acc_me')).toBe(false)
    expect(canDeleteSharedCopy(item({}), null)).toBe(false)
  })
})

describe('the store', () => {
  it('the owner deletes it: the open copy closes and the list is read again', async () => {
    const { useDocCollabStore } = await import('@renderer/stores/docCollab')
    useDocCollabStore.setState({ openId: 'ldoc_1', meta: { id: 'ldoc_1' } as never, listVersion: 3 } as never)
    replies['DELETE /livedocs/ldoc_1'] = respond(200, { ok: true })
    expect(await useDocCollabStore.getState().deleteShared('ldoc_1')).toEqual({ ok: true })
    expect(useDocCollabStore.getState()).toMatchObject({ openId: null, meta: null, listVersion: 4 })
  })

  it('refused: nothing changes, and the reason comes back to show', async () => {
    const { useDocCollabStore } = await import('@renderer/stores/docCollab')
    useDocCollabStore.setState({ openId: 'ldoc_1', meta: { id: 'ldoc_1' } as never, listVersion: 3 } as never)
    replies['DELETE /livedocs/ldoc_1'] = respond(403, { ok: false, error: 'Only the owner can delete this document.' })
    expect(await useDocCollabStore.getState().deleteShared('ldoc_1')).toMatchObject({ ok: false, error: 'Only the owner can delete this document.' })
    expect(useDocCollabStore.getState()).toMatchObject({ openId: 'ldoc_1', listVersion: 3 })
  })
})

describe('a member, when the owner deletes it', () => {
  async function push(docId: string): Promise<void> {
    await import('@renderer/stores/docCollab') // registers its handler on import
    expect(docHandler, 'the doc-collab store listens to live-document pushes').toBeTypeOf('function')
    docHandler!({ type: 'docLockChanged', docId, holder: null, expiresAt: null })
  }

  it('the open editor closes with a word, and the list is read again', async () => {
    const { useDocCollabStore } = await import('@renderer/stores/docCollab')
    useDocCollabStore.setState({ openId: 'ldoc_1', meta: { id: 'ldoc_1', title: 'Brief' } as never, listVersion: 1, goneId: null } as never)
    // GET /livedocs/ldoc_1 answers 404: it no longer exists.
    await push('ldoc_1')
    await vi.waitFor(() => expect(useDocCollabStore.getState()).toMatchObject({ openId: null, goneId: 'ldoc_1', listVersion: 2 }))
    expect(useNoticeStore.getState().notice?.text).toBe('“Brief” was deleted by its owner.')
  })

  it('a push for a document that still exists leaves the editor open (only the list is read again)', async () => {
    const { useDocCollabStore } = await import('@renderer/stores/docCollab')
    useDocCollabStore.setState({ openId: 'ldoc_1', meta: { id: 'ldoc_1', title: 'Brief' } as never, listVersion: 1, goneId: null } as never)
    replies['GET /livedocs/ldoc_1'] = respond(200, { ok: true, doc: { id: 'ldoc_1', title: 'Brief', body: '', members: [] } })
    await push('ldoc_1')
    await vi.waitFor(() => expect(useDocCollabStore.getState().listVersion).toBe(2))
    expect(useDocCollabStore.getState()).toMatchObject({ openId: 'ldoc_1', goneId: null })
  })

  it('a push for another document only refreshes the list', async () => {
    const { useDocCollabStore } = await import('@renderer/stores/docCollab')
    useDocCollabStore.setState({ openId: 'ldoc_1', meta: { id: 'ldoc_1', title: 'Brief' } as never, listVersion: 1, goneId: null } as never)
    await push('ldoc_2')
    await vi.waitFor(() => expect(useDocCollabStore.getState().listVersion).toBe(2))
    expect(calls.some((c) => c.url.includes('/livedocs/ldoc_1'))).toBe(false)
    expect(useDocCollabStore.getState().openId).toBe('ldoc_1')
  })
})
