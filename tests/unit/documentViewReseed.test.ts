// The Documents view has to REMOUNT its editor when the body is replaced from
// outside it — and the store is what tells it to, through bodyEpoch.
//
// This is the same bug OfficeDocWidget was given a bodyEpoch for, in the host
// that did not get one. Every office editor builds its content on mount and
// never re-seeds from a prop, so a catch-up that swaps `active` alone moves the
// store's base revision forward while the editor still shows its mount-time
// text. The next keystroke then saves STALE text against a CURRENT revision,
// the compare-and-set passes, and the other editor's work is destroyed — the
// guard defeated by its own catch-up, which is worse than never refreshing.
//
// So the assertion is on the epoch rather than on pixels: the view puts it in
// each editor's React key, and a key that does not change is a mount that does
// not happen.

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

/**
 * The window mock is HOISTED, because the store subscribes to documents:changed
 * once at module load and guards on `window.api` being there. A mock installed
 * in beforeEach arrives after the import has already run and skipped, so the
 * listener never exists and every assertion below would be vacuous — the first
 * test in this file exists to catch exactly that.
 */
const H = vi.hoisted(() => {
  const state: {
    fire?: (id: string, bodyRev: number) => void
    theirs: unknown
    theirRev: number
  } = { theirs: { text: 'theirs' }, theirRev: 9 }
  // AUGMENTED, not replaced. Assigning a bare object over jsdom's window
  // removed addEventListener, and the store registers a beforeunload flush at
  // module load — so the import threw and the whole file reported "no tests".
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = Object.assign(
    (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {},
    {
    api: {
      documents: {
        onChanged: (cb: (id: string, bodyRev: number) => void) => {
          state.fire = cb
          return () => {}
        },
        get: async (id: string) => ({
          id,
          docType: 'doc',
          title: id,
          body: state.theirs,
          bodyRev: state.theirRev,
          createdAt: 0,
          updatedAt: 0
        }),
        update: async () => null,
        updateBody: async () => ({ ok: false, reason: 'missing' }),
        create: async () => null
      }
    }
    }
  )
  return state
})

import { useDocumentsStore } from '@renderer/stores/documents'
import type { FbDocument } from '@shared/types'

const doc = (id: string, body: unknown, bodyRev = 0): FbDocument =>
  ({ id, docType: 'doc', title: id, body, bodyRev, createdAt: 0, updatedAt: 0 }) as unknown as FbDocument

describe('an external body change remounts the open editor', () => {
  beforeEach(() => {
    useDocumentsStore.setState({ active: null, conflict: null, bodyEpoch: 0 })
  })
  afterEach(() => {
    useDocumentsStore.setState({ active: null, conflict: null, bodyEpoch: 0 })
  })

  it('registers a listener at all, or nothing below means anything', () => {
    // The store subscribes once at module load, so this also proves the hoisted
    // window was in place early enough for the rest of the file to be real.
    expect(typeof H.fire).toBe('function')
  })

  it('bumps bodyEpoch when it takes a newer body, so the key changes', async () => {
    useDocumentsStore.setState({ active: doc('A', { text: 'mine' }, 3), bodyEpoch: 0 })
    H.fire!('A', 9)
    await new Promise((r) => setTimeout(r, 0))
    const s = useDocumentsStore.getState()
    expect((s.active!.body as { text: string }).text).toBe('theirs')
    expect(s.active!.bodyRev).toBe(9)
    // The whole point: the editor is rebuilt, so what it shows matches the
    // revision the store will now save against.
    expect(s.bodyEpoch).toBe(1)
  })

  it('does not bump for the echo of our own save', async () => {
    // A needless remount would throw away the undo stack and the cursor of
    // someone who just saved and is still typing.
    useDocumentsStore.setState({ active: doc('A', { text: 'mine' }, 9), bodyEpoch: 0 })
    H.fire!('A', 9)
    await new Promise((r) => setTimeout(r, 0))
    expect(useDocumentsStore.getState().bodyEpoch).toBe(0)
  })

  it('does not bump for a document that is not the one open', async () => {
    useDocumentsStore.setState({ active: doc('A', { text: 'mine' }, 3), bodyEpoch: 0 })
    H.fire!('SOMETHING-ELSE', 9)
    await new Promise((r) => setTimeout(r, 0))
    expect(useDocumentsStore.getState().bodyEpoch).toBe(0)
  })
})
