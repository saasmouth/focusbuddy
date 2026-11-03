// "Changed elsewhere" for an edit nobody made (owner, 2026-11-03: "fix").
//
// Two editors on one document — the canvas widget and the Workcentre tile, or a
// linked duplicate — each tidy the body the same way on load and save it. The
// first save lands; the second is refused as stale although it carries exactly
// what is now stored, and the person was asked to choose between two identical
// texts. A refused save whose content equals what is stored is not a conflict:
// take the stored revision and carry on. (tests/e2e/docSameEditRace reproduces
// the race in the real app; the desk-widget half is in twoEditorsOneDocument.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sameDocBody } from '../../src/renderer/src/lib/docBodyEqual'

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

describe('sameDocBody — content, not spelling', () => {
  it('key order is not content', () => {
    expect(sameDocBody({ type: 'doc', content: [{ type: 'paragraph', attrs: { a: 1, b: 2 } }] }, { content: [{ attrs: { b: 2, a: 1 }, type: 'paragraph' }], type: 'doc' })).toBe(true)
  })
  it('array order, text and structure are', () => {
    expect(sameDocBody({ c: [1, 2] }, { c: [2, 1] })).toBe(false)
    expect(sameDocBody({ t: 'Plan' }, { t: 'Plan.' })).toBe(false)
    expect(sameDocBody({ t: 'x', extra: { y: 1 } }, { t: 'x' })).toBe(false)
  })
  it('an absent field and an undefined one read the same, as they do once stored', () => {
    expect(sameDocBody({ t: 'x', u: undefined }, { t: 'x' })).toBe(true)
  })
  it('nothing equals something', () => {
    expect(sameDocBody(null, {})).toBe(false)
    expect(sameDocBody(undefined, undefined)).toBe(true)
  })
})

const doc = (id: string, body: unknown, bodyRev = 0): FbDocument =>
  ({ id, docType: 'doc', title: id, body, rev: 1, bodyRev, createdAt: 0, updatedAt: 0 }) as unknown as FbDocument

describe('the Documents view: a refused save that matches what is stored', () => {
  let stored: { body: unknown; rev: number }
  beforeEach(() => {
    vi.useFakeTimers()
    stored = { body: null, rev: 0 }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        documents: {
          updateBody: vi.fn(async (id: string, body: unknown, expected: number) => {
            if (stored.rev !== expected) return { ok: false, reason: 'stale', current: doc(id, JSON.parse(JSON.stringify(stored.body)), stored.rev) }
            stored = { body, rev: stored.rev + 1 }
            return { ok: true, doc: doc(id, body, stored.rev) }
          }),
          update: vi.fn(async (id: string, patch: { body: unknown }) => doc(id, patch.body)),
          create: vi.fn(async () => doc('copy', {}))
        }
      }
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    useDocumentsStore.setState({ active: null, conflict: null })
  })

  it('raises no conflict, and the next edit saves on the stored revision', async () => {
    // Another editor already saved the same tidy-up: stored is at rev 5.
    stored = { body: { type: 'doc', content: [{ type: 'paragraph' }] }, rev: 5 }
    useDocumentsStore.setState({ active: doc('SAME', { type: 'doc', content: [] }, 4) })
    const s = useDocumentsStore.getState()
    s.saveBody({ content: [{ type: 'paragraph' }], type: 'doc' }) // same content, other key order
    await vi.advanceTimersByTimeAsync(700)
    expect(useDocumentsStore.getState().conflict).toBeNull()
    expect(useDocumentsStore.getState().active?.bodyRev).toBe(5)
    s.saveBody({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'next' }] }] })
    await vi.advanceTimersByTimeAsync(700)
    expect(useDocumentsStore.getState().conflict).toBeNull()
    expect(stored.rev).toBe(6)
  })

  it('a different body still raises it', async () => {
    stored = { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'theirs' }] }] }, rev: 5 }
    useDocumentsStore.setState({ active: doc('DIFF', { type: 'doc', content: [] }, 4) })
    useDocumentsStore.getState().saveBody({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'mine' }] }] })
    await vi.advanceTimersByTimeAsync(700)
    expect(useDocumentsStore.getState().conflict?.id).toBe('DIFF')
  })
})
