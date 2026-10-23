// Typing must not destroy its own undo history.
//
// Reported at the 647bb600 tip: PlexiiWrite loses its ENTIRE undo stack about a
// second after any edit. A second is the debounced save, and the mechanism is
// the echo of our own write being mistaken for somebody else's:
//
//   1. saveBody queues the body and arms the 600ms timer.
//   2. The timer fires. It takes the queued body and DELETES it from the
//      pending map, then awaits documents.updateBody.
//   3. The main process emits documents:changed from inside updateDocument, so
//      the broadcast reaches the renderer BEFORE that await resolves.
//   4. The listener looks for reasons to ignore it. `active.bodyRev` is still
//      the OLD revision, because the store is told the new one after the await.
//      `pendingBodies` is already empty, because step 2 cleared it.
//   5. So both guards pass, the store treats its own save as an external
//      change, refetches and bumps bodyEpoch — and bodyEpoch is in the
//      editor's React key, so the editor REMOUNTS and its undo stack is gone.
//
// The remount is correct for a genuine external change: office editors seed
// their content on mount, and a body swapped without one leaves stale text at a
// current revision. It is catastrophic for our own echo.

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
 * The window has to exist BEFORE the store module is imported: it subscribes to
 * documents:changed once at load and skips if window.api is not there yet.
 */
const H = vi.hoisted(() => {
  const state: {
    fire?: (id: string, bodyRev: number) => void
    rev: number
    /** Emit the broadcast from INSIDE the write, as the main process does. */
    echoDuringWrite: boolean
    gets: number
  } = { rev: 3, echoDuringWrite: true, gets: 0 }
  const doc = (id: string, rev: number): unknown => ({
    id,
    docType: 'doc',
    title: id,
    body: { text: 'stored' },
    bodyRev: rev,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    orgId: 'personal'
  })
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = Object.assign(
    (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {},
    {
      api: {
        documents: {
          onChanged: (cb: (id: string, bodyRev: number) => void) => {
            state.fire = cb
            return () => {}
          },
          get: async (id: string) => {
            state.gets += 1
            return doc(id, state.rev)
          },
          update: async () => null,
          create: async () => null,
          updateBody: async (id: string, _body: unknown, expected: number) => {
            if (state.rev !== expected) {
              return { ok: false as const, reason: 'stale' as const, current: doc(id, state.rev) }
            }
            state.rev += 1
            // THE ORDERING THAT CAUSES THE BUG: main emits the broadcast inside
            // the write, so it lands before this promise resolves.
            if (state.echoDuringWrite) state.fire?.(id, state.rev)
            return { ok: true as const, doc: doc(id, state.rev) }
          }
        }
      }
    }
  )
  return state
})

import { useDocumentsStore } from '@renderer/stores/documents'
import type { FbDocument } from '@shared/types'

const active = (id: string, rev: number): FbDocument =>
  ({ id, docType: 'doc', title: id, body: { text: 'stored' }, bodyRev: rev, createdAt: 0, updatedAt: 0 }) as unknown as FbDocument

// A FRESH ID PER CASE. The store keys pendingBodies and pendingBaseRev by
// document id in module state, and nothing resets them between tests — so a
// save refused in one case leaves a queued body that makes the listener skip in
// the next, and the failure looks like the thing under test. Same trap as
// plxDocSaveRace.
let n = 0
const freshId = (): string => `doc-${++n}`

describe('a document does not treat its own save as somebody else\'s edit', () => {
  let id: string
  beforeEach(() => {
    id = freshId()
    vi.useFakeTimers()
    H.rev = 3
    H.gets = 0
    H.echoDuringWrite = true
    useDocumentsStore.setState({ active: active(id, 3), conflict: null, bodyEpoch: 0 })
  })
  afterEach(() => {
    vi.useRealTimers()
    useDocumentsStore.setState({ active: null, conflict: null, bodyEpoch: 0 })
  })

  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(700)
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('is subscribed at all, or nothing below means anything', () => {
    expect(typeof H.fire).toBe('function')
  })

  it('does NOT bump bodyEpoch when its own save echoes back', async () => {
    // bodyEpoch is in the editor's React key, so a bump is a remount and a
    // remount is the undo stack gone. This is the whole bug.
    useDocumentsStore.getState().saveBody({ text: 'typed' })
    await settle()
    expect(useDocumentsStore.getState().bodyEpoch).toBe(0)
  })

  it('still ends up at the revision it wrote', async () => {
    // Ignoring the echo must not cost us the new revision, or the NEXT save
    // would be refused against a revision we superseded ourselves.
    useDocumentsStore.getState().saveBody({ text: 'typed' })
    await settle()
    expect(useDocumentsStore.getState().active!.bodyRev).toBe(4)
  })

  it('does not refetch the document it just wrote', async () => {
    // A refetch is the symptom; the remount is the damage. Asserting both says
    // which half is broken when this fails.
    useDocumentsStore.getState().saveBody({ text: 'typed' })
    await settle()
    expect(H.gets).toBe(0)
  })

  it('refreshes again AFTER its own write has finished', async () => {
    // The flag has to be RELEASED, and nothing else here proves it: the
    // external-change case below uses a document that was never written, so a
    // flag left set for ever changed no test at all. A document stuck in that
    // set would simply stop catching up — silently, and for the rest of the
    // session — which is the failure the broadcast exists to prevent.
    //
    // So: write it, let the write finish, then have somebody else change it.
    useDocumentsStore.getState().saveBody({ text: 'typed' })
    await settle()
    expect(useDocumentsStore.getState().bodyEpoch).toBe(0)

    H.rev = 50 // somebody else, well past anything we wrote
    H.fire!(id, 50)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(useDocumentsStore.getState().bodyEpoch).toBe(1)
  })

  it('keeps the text the user typed, rather than the stored body', async () => {
    // If the echo is mistaken for an external change, the refetch replaces the
    // body with what the fake server has — which here is the pre-edit text.
    useDocumentsStore.getState().saveBody({ text: 'typed' })
    await settle()
    expect((useDocumentsStore.getState().active!.body as { text: string }).text).toBe('typed')
  })
})

describe('a genuine external change is still taken', () => {
  let id: string
  beforeEach(() => {
    id = freshId()
    vi.useFakeTimers()
    H.rev = 9
    H.gets = 0
    H.echoDuringWrite = false
    useDocumentsStore.setState({ active: active(id, 3), conflict: null, bodyEpoch: 0 })
  })
  afterEach(() => {
    vi.useRealTimers()
    useDocumentsStore.setState({ active: null, conflict: null, bodyEpoch: 0 })
  })

  it('bumps bodyEpoch for a change that is not ours, so the editor re-seeds', async () => {
    // The other half of the fix: ignoring our own echo must not make us ignore
    // everyone else's. Without the remount the editor would show stale text at
    // a current revision, and the next keystroke would overwrite their work.
    H.fire!(id, 9)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(useDocumentsStore.getState().bodyEpoch).toBe(1)
    expect(H.gets).toBe(1)
  })
})
