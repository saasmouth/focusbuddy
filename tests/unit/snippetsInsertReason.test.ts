// A target that declines must be able to say WHY, and that reason must reach the
// user unaltered.
//
// This exists because the first version of the contract could not do it: insert
// returned a bare boolean and the store then overwrote whatever the surface had
// set with a generic "<label> did not take the snippet.". The Cells sheet target
// is the case that exposed it — a formula whose relative reference would land
// above row 1 is DECLINED rather than silently clamped to row 1, because a
// clamped reference is a plausible-looking wrong answer. Declining is only
// useful if the user is told which cell, so the reason is the feature.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSnippetsStore } from '../../src/renderer/src/stores/snippets'
import type { Snippet, SnippetTarget } from '../../src/shared/snippets'

const snippet: Snippet = {
  id: 's1',
  kind: 'sheet',
  name: 'Commission block',
  description: null,
  body: { kind: 'sheet', rows: [['=A1*0.1']] },
  tags: [],
  scope: 'personal',
  orgId: 'personal',
  authorId: null,
  revision: 1,
  usageCount: 0,
  createdAt: 0,
  updatedAt: 0
} as unknown as Snippet

function target(over: Partial<SnippetTarget>): SnippetTarget {
  return {
    id: 'sheet:1',
    label: 'This sheet',
    accepts: ['sheet'],
    supports: ['duplicate'],
    insert: () => true,
    ...over
  }
}

beforeEach(() => {
  useSnippetsStore.setState({ snippets: [snippet], targets: {}, error: null })
  // Only the success path records a use.
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { snippets: { recordUse: vi.fn().mockResolvedValue(undefined) } }
  }
})

describe('a target that declines', () => {
  it("surfaces the target's own reason verbatim", async () => {
    const reason = 'A1 in this snippet would point above row 1 from C2.'
    useSnippetsStore.getState().registerTarget(target({ insert: () => ({ ok: false, reason }) }))
    const took = await useSnippetsStore.getState().insert(snippet, 'duplicate', 'sheet:1')
    expect(took).toBe(false)
    // Verbatim: not wrapped, not prefixed with the target label, because the
    // surface named a cell and that is the actionable part.
    expect(useSnippetsStore.getState().error).toBe(reason)
  })

  it('falls back to a generic message when it declines without one', async () => {
    useSnippetsStore.getState().registerTarget(target({ insert: () => false }))
    const took = await useSnippetsStore.getState().insert(snippet, 'duplicate', 'sheet:1')
    expect(took).toBe(false)
    expect(useSnippetsStore.getState().error).toMatch(/This sheet did not take the snippet/)
  })

  it('does not count a use, so usage figures mean something', async () => {
    useSnippetsStore.getState().registerTarget(target({ insert: () => ({ ok: false, reason: 'no' }) }))
    await useSnippetsStore.getState().insert(snippet, 'duplicate', 'sheet:1')
    expect(useSnippetsStore.getState().snippets[0]!.usageCount).toBe(0)
  })
})

describe('a target that takes it', () => {
  it('clears the error and counts the use', async () => {
    useSnippetsStore.getState().registerTarget(target({ insert: () => true }))
    const took = await useSnippetsStore.getState().insert(snippet, 'duplicate', 'sheet:1')
    expect(took).toBe(true)
    expect(useSnippetsStore.getState().error).toBeNull()
    expect(useSnippetsStore.getState().snippets[0]!.usageCount).toBe(1)
  })

  it('a bare `true` is the only thing read as success', async () => {
    // Guards the comparison itself: `outcome !== true` must not be loosened to
    // a truthiness check, or `{ ok: false }` would read as a successful insert.
    useSnippetsStore.getState().registerTarget(
      target({ insert: () => ({ ok: false, reason: 'declined' }) })
    )
    expect(await useSnippetsStore.getState().insert(snippet, 'duplicate', 'sheet:1')).toBe(false)
  })
})
