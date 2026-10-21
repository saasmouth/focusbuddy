// Passage-level embedding: the rollup, the model guard, the prune, and the
// Background AI tasks gate.
//
// Ground-truth eval on the real corpus (29 queries taken from content deep
// inside a document, asking which document comes back first):
//   whole-document vectors  recall@1 19/29, mean rank 5.55
//   passage vectors         recall@1 23/29, mean rank 2.28
import { describe, it, expect, vi, beforeEach } from 'vitest'

const chunkRows: { id: string; source_id: string; title: string; text: string }[] = []
let stored = new Map<string, { vector: number[]; model: string }>()
const deleted: string[] = []
let queryVec: { vector: number[]; model: string } | null = null
// What the gated route reports: the live model, or null when Background AI
// tasks is off and there is no local model.
let gatedModel: string | null = 'ollama:test'
let gateOpen = true
const embedCalls: string[][] = []

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({ prepare: () => ({ all: () => chunkRows }) })
}))
vi.mock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => 'personal' }))
vi.mock('../../src/main/db/embeddings', () => ({
  listEmbeddingsTagged: () => stored,
  listEmbeddingModels: () => new Map([...stored].map(([id, r]) => [id, { model: r.model }])),
  setEmbedding: (_k: string, id: string, v: number[], m: string) => stored.set(id, { vector: v, model: m }),
  deleteEmbedding: (_k: string, id: string) => { deleted.push(id); stored.delete(id) }
}))
// Every passage embedding goes through the gate, never ai/embeddings directly.
vi.mock('../../src/main/backgroundAiGate', () => ({
  EMBED_BATCH: 16,
  gatedActiveEmbedModel: async () => gatedModel,
  gatedEmbedTexts: async (texts: string[]) => {
    if (!gateOpen) return { ok: false as const, reason: 'background_ai_off' }
    embedCalls.push(texts)
    return { ok: true as const, vectors: texts.map(() => [1, 0, 0]), model: 'ollama:test' }
  }
}))

import {
  bestChunkScores,
  reindexChunkEmbeddings,
  chunkKind,
  passageModelsBySource
} from '../../src/main/chunkEmbeddings'

beforeEach(() => {
  chunkRows.length = 0
  deleted.length = 0
  stored = new Map()
  queryVec = { vector: [1, 0, 0], model: 'ollama:test' }
  gatedModel = 'ollama:test'
  gateOpen = true
  embedCalls.length = 0
})

describe('chunkKind', () => {
  it('namespaces vectors by source type so pools never collide', () => {
    expect(chunkKind('document')).toBe('chunk:document')
    expect(chunkKind('widget')).toBe('chunk:widget')
  })
})

describe('bestChunkScores', () => {
  it('rolls the BEST passage up to its document, not the average', () => {
    chunkRows.push(
      { id: 'c1', source_id: 'docA', title: 'A', text: 'x' },
      { id: 'c2', source_id: 'docA', title: 'A', text: 'y' }
    )
    // c2 points straight at the query; c1 is orthogonal. A mean would bury docA.
    stored.set('c1', { vector: [0, 1, 0], model: 'ollama:test' })
    stored.set('c2', { vector: [1, 0, 0], model: 'ollama:test' })
    expect(bestChunkScores(queryVec, 'document').get('docA')).toBeCloseTo(1, 5)
  })

  it('skips vectors from a different embedder rather than scoring garbage', async () => {
    chunkRows.push({ id: 'c1', source_id: 'docA', title: 'A', text: 'x' })
    stored.set('c1', { vector: [1, 0, 0], model: 'openai:other' })
    expect(bestChunkScores(queryVec, 'document').size).toBe(0)
  })

  it('omits a document with no usable passage vector, rather than scoring it zero', async () => {
    chunkRows.push({ id: 'c1', source_id: 'docA', title: 'A', text: 'x' })
    // Absence of a vector is not evidence of irrelevance: the caller falls back.
    expect(bestChunkScores(queryVec, 'document').has('docA')).toBe(false)
  })

  it('returns nothing when no embedder is configured', async () => {
    queryVec = null
    chunkRows.push({ id: 'c1', source_id: 'docA', title: 'A', text: 'x' })
    stored.set('c1', { vector: [1, 0, 0], model: 'ollama:test' })
    expect(bestChunkScores(queryVec, 'document').size).toBe(0)
  })
})

describe('reindexChunkEmbeddings', () => {
  it('embeds only what is missing', async () => {
    chunkRows.push(
      { id: 'c1', source_id: 'docA', title: 'A', text: 'x' },
      { id: 'c2', source_id: 'docA', title: 'A', text: 'y' }
    )
    stored.set('c1', { vector: [1, 0, 0], model: 'ollama:test' })
    expect((await reindexChunkEmbeddings('document')).embedded).toBe(1)
  })

  it('treats a model-stale vector as missing', async () => {
    chunkRows.push({ id: 'c1', source_id: 'docA', title: 'A', text: 'x' })
    stored.set('c1', { vector: [1, 0, 0], model: 'ollama:previous' })
    expect((await reindexChunkEmbeddings('document')).embedded).toBe(1)
  })

  it('prunes vectors whose chunk no longer exists', async () => {
    // Chunks are rewritten whenever their source changes; without the prune,
    // orphaned vectors accumulate forever.
    chunkRows.push({ id: 'c1', source_id: 'docA', title: 'A', text: 'x' })
    stored.set('c1', { vector: [1, 0, 0], model: 'ollama:test' })
    stored.set('gone', { vector: [1, 0, 0], model: 'ollama:test' })
    const r = await reindexChunkEmbeddings('document')
    expect(r.pruned).toBe(1)
    expect(deleted).toEqual(['gone'])
  })
})

describe('reindexChunkEmbeddings respects the Background AI tasks gate', () => {
  it('embeds in batches, so a large backlog is never one request', async () => {
    for (let i = 0; i < 40; i++) chunkRows.push({ id: `c${i}`, source_id: 'docA', title: 'A', text: `t${i}` })
    const r = await reindexChunkEmbeddings('document')
    expect(r.embedded).toBe(40)
    expect(embedCalls.map((b) => b.length)).toEqual([16, 16, 8])
  })

  it('off with no local model: nothing embedded, the reason returned, local vectors kept', async () => {
    gateOpen = false
    gatedModel = null
    chunkRows.push(
      { id: 'c1', source_id: 'docA', title: 'A', text: 'x' },
      { id: 'c2', source_id: 'docA', title: 'A', text: 'y' }
    )
    stored.set('c1', { vector: [1, 0, 0], model: 'local:nomic' })
    const r = await reindexChunkEmbeddings('document')
    expect(r).toEqual({ embedded: 0, pruned: 0, reason: 'background_ai_off' })
    // With no live route, an existing vector is not "stale": nothing replaces it.
    expect(stored.get('c1')?.model).toBe('local:nomic')
  })

  it('a vector from the gated-off cloud model is stale once the route is local', async () => {
    gatedModel = 'ollama:test'
    chunkRows.push({ id: 'c1', source_id: 'docA', title: 'A', text: 'x' })
    stored.set('c1', { vector: [1, 0, 0], model: 'text-embedding-3-small' })
    expect((await reindexChunkEmbeddings('document')).embedded).toBe(1)
    expect(stored.get('c1')?.model).toBe('ollama:test')
  })
})

describe('passageModelsBySource', () => {
  it('reports a source as comparable when ANY of its passages is', () => {
    chunkRows.push(
      { id: 'c1', source_id: 'docA', title: 'A', text: 'x' },
      { id: 'c2', source_id: 'docA', title: 'A', text: 'y' },
      { id: 'c3', source_id: 'docB', title: 'B', text: 'z' }
    )
    stored.set('c1', { vector: [1], model: 'ollama:old' })
    stored.set('c2', { vector: [1], model: 'ollama:test' })
    stored.set('c3', { vector: [1], model: 'ollama:old' })
    const m = passageModelsBySource('document', 'ollama:test')
    expect(m.get('docA')?.model).toBe('ollama:test')
    expect(m.get('docB')?.model).toBe('ollama:old')
  })
})
