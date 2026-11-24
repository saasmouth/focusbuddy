// The views for "Stop sharing and delete the shared copy" (4.3.56): the owner's
// button in Collaborations, and what a member's open editor shows once the owner
// has deleted it. The decisions themselves are in liveDocDelete.test.ts.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const confirmDialog = vi.fn(async () => true)
vi.mock('../../src/renderer/src/components/plexi/PromptDialog', () => ({
  confirmDialog: (...a: unknown[]) => confirmDialog(...(a as [])),
  promptText: vi.fn(async () => null)
}))

const doc = (id: string, owner: string, title: string): Record<string, unknown> => ({
  id, ownerAccountId: owner, docType: 'doc', title, version: 1, updatedBy: null, createdAt: 1, updatedAt: 2
})
let deletes: string[]
let listed: Array<Record<string, unknown>>

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  deletes = []
  listed = [doc('ldoc_mine', 'acc_me', 'My brief'), doc('ldoc_theirs', 'acc_other', 'Their plan')]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(String(url)).pathname
      if ((init.method ?? 'GET') === 'DELETE') {
        deletes.push(path)
        listed = listed.filter((d) => `/livedocs/${d.id}` !== path)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (path === '/livedocs') return new Response(JSON.stringify({ ok: true, docs: listed }), { status: 200 })
      return new Response(JSON.stringify({ ok: false }), { status: 404 })
    })
  )
  const { useAccountStore } = await import('../../src/renderer/src/stores/account')
  useAccountStore.setState({ sessionToken: 'tok', account: { id: 'acc_me' } } as never)
  confirmDialog.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe('Collaborations: the owner may stop sharing and delete the shared copy', () => {
  it('only on what this account owns; after a confirm it is deleted and the list is read again', async () => {
    const { default: CollaborationsView } = await import('../../src/renderer/src/components/views/CollaborationsView')
    act(() => root.render(<CollaborationsView />))
    await settle()
    expect(host.querySelector('[data-testid="collaboration-delete-ldoc_mine"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="collaboration-delete-ldoc_theirs"]')).toBeNull()
    await act(async () => {
      ;(host.querySelector('[data-testid="collaboration-delete-ldoc_mine"]') as HTMLButtonElement).click()
    })
    await settle()
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stop sharing “My brief” and delete the shared copy?', danger: true }))
    expect(deletes).toEqual(['/livedocs/ldoc_mine'])
    expect(host.textContent).not.toContain('My brief')
    expect(host.textContent).toContain('Their plan')
  })

  it('cancelled: nothing is deleted', async () => {
    confirmDialog.mockResolvedValueOnce(false)
    const { default: CollaborationsView } = await import('../../src/renderer/src/components/views/CollaborationsView')
    act(() => root.render(<CollaborationsView />))
    await settle()
    await act(async () => {
      ;(host.querySelector('[data-testid="collaboration-delete-ldoc_mine"]') as HTMLButtonElement).click()
    })
    await settle()
    expect(deletes).toEqual([])
  })
})

describe('a member\'s open editor, once the owner has deleted it', () => {
  it('says so, instead of an empty editor', async () => {
    const { useDocCollabStore } = await import('../../src/renderer/src/stores/docCollab')
    const { default: LiveDocEditorView } = await import('../../src/renderer/src/components/views/LiveDocEditorView')
    act(() => root.render(<LiveDocEditorView liveDocId="ldoc_theirs" />))
    await settle()
    act(() => useDocCollabStore.setState({ openId: null, meta: null, goneId: 'ldoc_theirs' } as never))
    await settle()
    expect(host.querySelector('[data-testid="livedoc-gone"]')?.textContent).toContain('The owner stopped sharing this document and deleted the shared copy.')
  })
})
