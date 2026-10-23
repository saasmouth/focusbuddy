// The documents list learns of a document it was never told about.
//
// rails-tabs-41 shots, Diagrams-home.png and Draw-home.png: the open-document
// tray named a just-created diagram and a seeded artwork "Document", struck
// through, as if they had been deleted. The tray reads the store's list, and a
// document created outside the store's own createBlank (in the main process:
// an AI tool, a widget file, the API) never entered that list: the change
// broadcast was only ever checked against the ACTIVE document. Now a broadcast
// for a document the list lacks refreshes the list (coalesced).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@renderer/lib/cloudDocsSync', () => ({
  pushCloudDoc: vi.fn(async () => ({ conflictedTo: undefined })),
  pullCloudDocs: vi.fn(async () => []),
  pushCloudDelete: vi.fn(async () => undefined)
}))
vi.mock('@renderer/lib/syncNudge', () => ({ nudgeSync: vi.fn() }))
vi.mock('@renderer/stores/actionHistory', () => ({
  recordActionWithToast: vi.fn(),
  useActionHistory: { getState: () => ({}) }
}))
vi.mock('@renderer/stores/messaging', () => ({
  useMessagingStore: { getState: () => ({ refreshConversations: vi.fn() }) }
}))
vi.mock('@renderer/stores/notice', () => ({
  useNoticeStore: { getState: () => ({ show: vi.fn() }) }
}))

/** The window must exist before the store module loads: it subscribes once, at import. */
const H = vi.hoisted(() => {
  const meta = (id: string, docType: string): unknown => ({ id, docType, title: id, archived: false, createdAt: 0, updatedAt: 0 })
  const state: { fire?: (id: string, bodyRev: number) => void; rows: unknown[]; lists: number } = { rows: [], lists: 0 }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = Object.assign(
    (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {},
    {
      api: {
        documents: {
          onChanged: (cb: (id: string, bodyRev: number) => void) => {
            state.fire = cb
            return () => {}
          },
          list: async () => {
            state.lists += 1
            return state.rows
          },
          get: async () => null
        }
      }
    }
  )
  return { state, meta }
})

const { useDocumentsStore } = await import('@renderer/stores/documents')

beforeEach(() => {
  vi.useFakeTimers()
  H.state.lists = 0
  H.state.rows = [H.meta('known', 'doc')]
  useDocumentsStore.setState({ list: H.state.rows as never, active: null })
})
afterEach(() => vi.useRealTimers())

describe('a broadcast for a document the list lacks', () => {
  it('refreshes the list, so the new document is known by its title', async () => {
    H.state.rows = [H.meta('known', 'doc'), H.meta('diagram-1', 'map')]
    H.state.fire!('diagram-1', 0)
    await vi.advanceTimersByTimeAsync(200)
    expect(H.state.lists).toBe(1)
    expect(useDocumentsStore.getState().list.map((d) => d.id)).toContain('diagram-1')
  })

  it('a burst of creates is one read', async () => {
    for (const id of ['a', 'b', 'c', 'd']) H.state.fire!(id, 0)
    await vi.advanceTimersByTimeAsync(200)
    expect(H.state.lists).toBe(1)
  })

  it('a document the list already has does not reread it', async () => {
    H.state.fire!('known', 4)
    await vi.advanceTimersByTimeAsync(200)
    expect(H.state.lists).toBe(0)
  })
})
