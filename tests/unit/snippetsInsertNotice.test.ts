// A converted insert says so: the target returns { ok: true, notice } and the
// store keeps the line and shows it in the house notice toast, which outlives
// the library dialog that closes on success. Landing as itself shows nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSnippetsStore } from '../../src/renderer/src/stores/snippets'
import { useNoticeStore } from '../../src/renderer/src/stores/notice'
import type { Snippet, SnippetTarget } from '../../src/shared/snippets'

const snippet = {
  id: 's1', kind: 'draw', name: 'Logo', description: null,
  body: { kind: 'draw', objects: [{ id: 'r' }] }, tags: [], scope: 'personal', orgId: 'personal',
  authorId: null, revision: 1, usageCount: 0, createdAt: 0, updatedAt: 0
} as unknown as Snippet

function target(insert: SnippetTarget['insert']): SnippetTarget {
  return { id: 'doc:1', label: 'This document', accepts: ['draw'], supports: ['duplicate'], host: 'doc', insert }
}

beforeEach(() => {
  useSnippetsStore.setState({ snippets: [snippet], targets: {}, error: null, notice: null })
  useNoticeStore.getState().clear()
  ;(globalThis as unknown as { window: unknown }).window = { api: { snippets: { recordUse: vi.fn().mockResolvedValue(undefined) } } }
})

describe('a converted insert', () => {
  it('counts as taken, keeps the line and shows it in the notice toast', async () => {
    const line = 'It becomes a picture: edit it in PlexiiDraw.'
    useSnippetsStore.getState().registerTarget(target(() => ({ ok: true, notice: line })))
    expect(await useSnippetsStore.getState().insert(snippet, 'duplicate', 'doc:1')).toBe(true)
    expect(useSnippetsStore.getState().notice).toBe(line)
    expect(useSnippetsStore.getState().error).toBeNull()
    expect(useNoticeStore.getState().notice?.text).toBe(line)
    expect(useSnippetsStore.getState().snippets[0].usageCount).toBe(1)
  })

  it('shows nothing for an insert that landed as itself', async () => {
    useSnippetsStore.getState().registerTarget(target(() => true))
    expect(await useSnippetsStore.getState().insert(snippet, 'duplicate', 'doc:1')).toBe(true)
    expect(useSnippetsStore.getState().notice).toBeNull()
    expect(useNoticeStore.getState().notice).toBeNull()
  })

  it('a refusal clears any earlier line and shows its reason, not a notice', async () => {
    useSnippetsStore.setState({ notice: 'old' })
    useSnippetsStore.getState().registerTarget(target(() => ({ ok: false, reason: 'PlexiiCells holds values, not pictures.' })))
    expect(await useSnippetsStore.getState().insert(snippet, 'duplicate', 'doc:1')).toBe(false)
    expect(useSnippetsStore.getState().notice).toBeNull()
    expect(useSnippetsStore.getState().error).toBe('PlexiiCells holds values, not pictures.')
    expect(useNoticeStore.getState().notice).toBeNull()
  })
})
