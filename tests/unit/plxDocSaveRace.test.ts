import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The documents store debounces body saves. It used to keep a single module-global
// timer, so editing document A then switching to document B within the debounce
// window cancelled A's pending save and the flush's "still the same doc?" guard
// then skipped it entirely — A's last edit was silently lost. This proves the
// per-document timers fix: BOTH documents' edits reach disk.

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

import { useDocumentsStore } from '@renderer/stores/documents'
import type { FbDocument } from '@shared/types'

const doc = (id: string, body: unknown, bodyRev = 0): FbDocument =>
  ({ id, docType: 'doc', title: id, body, rev: 1, bodyRev, createdAt: 0, updatedAt: 0 }) as unknown as FbDocument

describe('documents.saveBody — per-document debounce', () => {
  let updates: Array<{ id: string; body: unknown }>
  /** The stored body version per document, as the main process keeps it. */
  let revs: Record<string, number>

  beforeEach(() => {
    vi.useFakeTimers()
    updates = []
    revs = {}
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        documents: {
          // The editor's save is CONDITIONAL now (documents.body_rev): it
          // replaces the stored body only if that body is still the one the
          // editor was handed, so two editors on one document cannot overwrite
          // each other. The debounce and the per-document queue — what this
          // file is about — are unchanged, so the assertions below are the
          // original ones; only the channel they travel on moved.
          updateBody: vi.fn(async (id: string, body: unknown, expectedBodyRev: number) => {
            const have = revs[id] ?? 0
            if (have !== expectedBodyRev) {
              return { ok: false, reason: 'stale', current: doc(id, { stored: true }, have) }
            }
            revs[id] = have + 1
            updates.push({ id, body })
            return { ok: true, doc: doc(id, body, revs[id]) }
          }),
          // Still here because the close/flush path falls back to it when no
          // base revision was ever recorded for a document.
          update: vi.fn(async (id: string, patch: { body: unknown }) => {
            updates.push({ id, body: patch.body })
            return doc(id, patch.body)
          }),
          create: vi.fn(async () => doc('copy', {}))
        }
      }
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    useDocumentsStore.setState({ active: null })
  })

  // Each case uses its own ids. The store remembers the base revision of a
  // pending edit in module state keyed by document id, cleared by a successful
  // save or by open() — neither of which a test that assigns `active` directly
  // goes through. Sharing one id let a case inherit the previous case's base and
  // have its save refused for a reason that had nothing to do with the test.
  it('does NOT drop document A when you switch to B within the debounce window', async () => {
    const s = useDocumentsStore.getState()

    useDocumentsStore.setState({ active: doc('A', { v: 0 }) })
    s.saveBody({ v: 'a-edit' })

    // Switch to B and edit it, all within A's 600ms debounce.
    useDocumentsStore.setState({ active: doc('B', { v: 0 }) })
    s.saveBody({ v: 'b-edit' })

    await vi.advanceTimersByTimeAsync(700)

    const ids = updates.map((u) => u.id).sort()
    expect(ids).toEqual(['A', 'B']) // both flushed; A not dropped
    expect(updates.find((u) => u.id === 'A')?.body).toEqual({ v: 'a-edit' })
    expect(updates.find((u) => u.id === 'B')?.body).toEqual({ v: 'b-edit' })
  })

  it('a coalesced burst saves against the version the FIRST edit was based on', async () => {
    // Not the version at the moment the timer fires. All three keystrokes
    // replace the same stored body, so re-reading the base per keystroke would
    // walk it forward past a change this editor never saw — and the write would
    // then pass a guard it should have failed.
    const s = useDocumentsStore.getState()
    useDocumentsStore.setState({ active: doc('BASE', { v: 0 }, 7) })
    revs.BASE = 7
    s.saveBody({ v: 1 })
    s.saveBody({ v: 2 })
    await vi.advanceTimersByTimeAsync(700)
    const call = (window.api.documents.updateBody as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call?.[2]).toBe(7)
    expect(updates).toEqual([{ id: 'BASE', body: { v: 2 } }])
  })

  it('coalesces rapid edits to the same document into one write of the latest body', async () => {
    const s = useDocumentsStore.getState()
    useDocumentsStore.setState({ active: doc('COALESCE', { v: 0 }) })
    s.saveBody({ v: 1 })
    s.saveBody({ v: 2 })
    s.saveBody({ v: 3 })
    await vi.advanceTimersByTimeAsync(700)
    const forA = updates.filter((u) => u.id === 'COALESCE')
    expect(forA).toHaveLength(1)
    expect(forA[0].body).toEqual({ v: 3 })
  })
})
