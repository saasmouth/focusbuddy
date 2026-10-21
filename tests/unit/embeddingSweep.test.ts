// @vitest-environment node
// The embedding sweep (5-minute tick, plus a kick when an OpenAI key is saved or
// Background AI tasks is turned on): it covers document PASSAGES as well as
// whole documents and knowledge, and two triggers never embed the same backlog
// twice in parallel.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as string[],
  release: null as null | (() => void)
}))

vi.mock('../../src/main/db/documents', () => ({ listDocuments: () => [], getDocument: () => null }))
vi.mock('../../src/main/workspaceRank', () => ({ extractDocText: () => '' }))
vi.mock('../../src/main/ai/localModel', () => ({ localModelStatus: async () => ({ available: false }) }))
vi.mock('../../src/main/ai/enrichDocuments', () => ({ enrichDocument: async () => ({ ok: false }) }))
vi.mock('../../src/main/ai/extractMemory', () => ({ extractMemoryFromText: async () => ({ added: 0 }) }))
vi.mock('../../src/main/db/localAiLedger', () => ({
  localAiContentHash: () => '',
  needsLocalAiPass: () => false,
  markLocalAiPass: () => undefined,
  localAiPassCount: () => 0
}))
vi.mock('../../src/main/documentRetrieval', () => ({
  reindexDocuments: async () => {
    state.calls.push('documents')
    // Hold the first pool open so a second trigger arrives mid-sweep.
    if (state.release === null) await new Promise<void>((r) => (state.release = r))
    return { embedded: 2 }
  }
}))
vi.mock('../../src/main/semanticRetrieval', () => ({
  reindexKnowledge: async () => {
    state.calls.push('knowledge')
    return { embedded: 1 }
  }
}))
vi.mock('../../src/main/chunkEmbeddings', () => ({
  reindexChunkEmbeddings: async (sourceType: string) => {
    state.calls.push(`passages:${sourceType}`)
    return { embedded: 7, pruned: 3, reason: 'background_ai_off' }
  }
}))

import { sweepEmbeddings } from '../../src/main/ai/localAiSweeps'

beforeEach(() => {
  state.calls = []
  state.release = null
})

describe('sweepEmbeddings', () => {
  it('embeds document passages too, last, and reports their count and prunes', async () => {
    const p = sweepEmbeddings()
    await vi.waitFor(() => expect(state.release).not.toBeNull())
    state.release!()
    expect(await p).toEqual({ documents: 2, knowledge: 1, passages: 7, pruned: 3, reason: 'background_ai_off' })
    expect(state.calls).toEqual(['documents', 'knowledge', 'passages:document'])
  })

  it('a trigger during a running sweep joins it instead of starting a second', async () => {
    const a = sweepEmbeddings()
    await vi.waitFor(() => expect(state.release).not.toBeNull())
    const b = sweepEmbeddings()
    expect(b).toBe(a)
    state.release!()
    await Promise.all([a, b])
    expect(state.calls.filter((c) => c === 'documents')).toHaveLength(1)
    // Once it settles, the next trigger runs a fresh sweep.
    state.release = () => undefined
    await sweepEmbeddings()
    expect(state.calls.filter((c) => c === 'documents')).toHaveLength(2)
  })
})
