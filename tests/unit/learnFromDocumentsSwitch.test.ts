// "Learn from my documents automatically" (Settings › AI › Local), 4.3.50.
//
// The local-AI tick ran sweepDocumentMemory on every machine with the on-device
// model, so memories appeared without anyone pressing Learn from my documents
// (d0, capturing 4.3.48 screens, 2026-11-17). The background pass stays (the
// button alone had produced nothing, and it runs on the local model only, so
// nothing leaves the Mac), but it now follows a switch, on by default: off,
// a tick asks the model nothing and writes no memory; on, it does.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ learn: true, memoryRows: [] as string[], scanned: new Set<string>() }))

vi.mock('../../src/main/privacyPrefs', () => ({ learnFromDocumentsEnabled: () => state.learn }))
vi.mock('../../src/main/db/documents', () => ({
  listDocuments: () => [{ id: 'd1', title: 'Pricing notes' }, { id: 'd2', title: 'Hiring plan' }],
  getDocument: (id: string) => ({ id, docType: 'doc', body: `body of ${id}` })
}))
vi.mock('../../src/main/workspaceRank', () => ({ extractDocText: (_t: string, body: string) => body }))
vi.mock('../../src/main/ai/localModel', () => ({ localModelStatus: async () => ({ available: true, chatModel: 'local' }) }))
vi.mock('../../src/main/ai/enrichDocuments', () => ({ enrichDocument: async () => ({ ok: true }) }))
vi.mock('../../src/main/ai/extractMemory', () => ({
  extractMemoryFromText: async ({ sourceRef }: { sourceRef: string }) => {
    state.memoryRows.push(`memory from ${sourceRef}`)
    return { added: 1 }
  }
}))
vi.mock('../../src/main/db/localAiLedger', () => ({
  localAiContentHash: (title: string) => title,
  needsLocalAiPass: (_pass: string, id: string) => !state.scanned.has(id),
  markLocalAiPass: (_pass: string, id: string) => void state.scanned.add(id),
  localAiPassCount: () => 0
}))
vi.mock('../../src/main/documentRetrieval', () => ({ reindexDocuments: async () => ({ embedded: 0 }) }))
vi.mock('../../src/main/semanticRetrieval', () => ({ reindexKnowledge: async () => ({ embedded: 0 }) }))
vi.mock('../../src/main/chunkEmbeddings', () => ({ reindexChunkEmbeddings: async () => ({ embedded: 0, pruned: 0 }) }))

import { sweepDocumentMemory } from '../../src/main/ai/localAiSweeps'

beforeEach(() => {
  state.memoryRows = []
  state.scanned = new Set()
})

describe('Learn from my documents automatically', () => {
  it('off: a tick writes no memory and asks the model nothing', async () => {
    state.learn = false
    const r = await sweepDocumentMemory()
    expect(state.memoryRows).toEqual([])
    expect(r).toMatchObject({ processed: 0, added: 0, reason: 'switched_off' })
  })

  it('on: a tick learns from documents not yet scanned', async () => {
    state.learn = true
    const r = await sweepDocumentMemory()
    expect(state.memoryRows).toEqual(['memory from d1', 'memory from d2'])
    expect(r).toMatchObject({ processed: 2, added: 2 })
  })
})
