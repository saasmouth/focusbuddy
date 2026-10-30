import { describe, it, expect, vi, beforeEach } from 'vitest'

// Retrieval cost on this device (reported 2026-10-30: a turn spent 15,098ms
// in "Searched your workspace", hit the budget, and came back with nothing).
//
// Two wastes, both per turn, both invisible:
//
//  1. Every stored vector was SELECTed and JSON.parsed on every call, and
//     more than one pool calls it. A 1536-dim vector is ~20KB of JSON, so a
//     few hundred passages is megabytes of parsing, twice, before a single
//     comparison happens. The module's own neighbour already warns about
//     this: listEmbeddingModels exists because "parsing every vector's JSON
//     to read its tag would cost the whole store on every call".
//
//  2. The same question was embedded separately by each pool. On a local
//     embedder that is seconds apiece for a byte-identical input.

const rows: Array<{ item_id: string; vector_json: string; model: string }> = []
let selects = 0

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes('SELECT item_id, vector_json, model')) selects++
        return rows
      },
      run: () => undefined,
      get: () => undefined
    })
  })
}))
vi.mock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => 'personal' }))

beforeEach(() => {
  rows.length = 0
  rows.push({ item_id: 'a', vector_json: JSON.stringify([1, 0, 0]), model: 'm' })
  rows.push({ item_id: 'b', vector_json: JSON.stringify([0, 1, 0]), model: 'm' })
  selects = 0
  vi.resetModules()
})

describe('stored vectors are read once, not once per pool', () => {
  it('serves a repeat call from memory', async () => {
    const db = await import('../../src/main/db/embeddings')
    const first = db.listEmbeddingsTagged('chunk:document')
    const second = db.listEmbeddingsTagged('chunk:document')
    expect(first.size).toBe(2)
    expect(second.size).toBe(2)
    expect(selects, 'the whole vector store was re-read and re-parsed').toBe(1)
  })

  it('re-reads after a vector is written, so a fresh embedding is never missed', async () => {
    const db = await import('../../src/main/db/embeddings')
    db.listEmbeddingsTagged('chunk:document')
    db.setEmbedding('chunk:document', 'c', [0, 0, 1], 'm')
    rows.push({ item_id: 'c', vector_json: JSON.stringify([0, 0, 1]), model: 'm' })
    expect(db.listEmbeddingsTagged('chunk:document').size).toBe(3)
    expect(selects).toBe(2)
  })

  it('re-reads after a vector is deleted', async () => {
    const db = await import('../../src/main/db/embeddings')
    db.listEmbeddingsTagged('chunk:document')
    db.deleteEmbedding('chunk:document', 'a')
    rows.shift()
    expect(db.listEmbeddingsTagged('chunk:document').size).toBe(1)
    expect(selects).toBe(2)
  })

  it('keeps item types apart', async () => {
    const db = await import('../../src/main/db/embeddings')
    db.listEmbeddingsTagged('chunk:document')
    db.listEmbeddingsTagged('chunk:widget')
    expect(selects).toBe(2)
  })

  it('can be cleared outright, for a workspace that was swapped underneath it', async () => {
    const db = await import('../../src/main/db/embeddings')
    db.listEmbeddingsTagged('chunk:document')
    db.clearEmbeddingCache()
    db.listEmbeddingsTagged('chunk:document')
    expect(selects).toBe(2)
  })
})

// ── The second waste: one question, embedded once per pool ─────────────────
describe('a question is embedded once per turn, not once per pool', () => {
  const calls: Array<{ texts: string[]; kind: string }> = []

  beforeEach(() => {
    calls.length = 0
    vi.resetModules()
    vi.doMock('../../src/main/ai/localModel', () => ({
      localEmbed: async (texts: string[], kind: string) => {
        calls.push({ texts, kind })
        return { vectors: texts.map(() => [1, 0, 0]), model: 'local:test' }
      },
      localModelStatus: async () => ({ embedModel: 'local:test' })
    }))
    vi.doMock('../../src/main/ai/local/providerRouter', () => ({ localOnlyActive: () => true }))
    vi.doMock('../../src/main/settingsStore', () => ({ resolveOpenAIKey: () => null }))
  })

  it('embeds a repeated question once', async () => {
    const e = await import('../../src/main/ai/embeddings')
    const a = await e.embedQueryTagged('what did we decide about pricing')
    const b = await e.embedQueryTagged('what did we decide about pricing')
    expect(a).toEqual(b)
    expect(calls, 'the same question was sent to the embedder twice').toHaveLength(1)
  })

  it('shares the vector between embedQuery and embedQueryTagged', async () => {
    // Different callers, same question, same turn — the two pools that ask.
    const e = await import('../../src/main/ai/embeddings')
    await e.embedQueryTagged('what did we decide about pricing')
    await e.embedQuery('what did we decide about pricing')
    expect(calls).toHaveLength(1)
  })

  it('still embeds a DIFFERENT question', async () => {
    const e = await import('../../src/main/ai/embeddings')
    await e.embedQueryTagged('pricing')
    await e.embedQueryTagged('renewals')
    expect(calls).toHaveLength(2)
  })

  it('does not reuse a query vector as a document vector', async () => {
    // nomic-embed is trained with different prefixes for the two, so a cache
    // that ignored `kind` would hand back the wrong kind of vector.
    const e = await import('../../src/main/ai/embeddings')
    await e.embedQueryTagged('pricing')
    await e.embedTexts(['pricing'], 'document')
    expect(calls).toHaveLength(2)
    // The KINDS, not just the count: counting alone passes even if the
    // question is embedded as a document, which is the actual failure.
    expect(calls.map((c) => c.kind)).toEqual(['query', 'document'])
  })

  it('embeds a question AS a question', async () => {
    const e = await import('../../src/main/ai/embeddings')
    await e.embedQueryTagged('pricing')
    expect(calls[0].kind).toBe('query')
  })

  it('forgets a question once the turn is over', async () => {
    vi.useFakeTimers()
    const e = await import('../../src/main/ai/embeddings')
    await e.embedQueryTagged('pricing')
    vi.advanceTimersByTime(e.QUERY_VECTOR_TTL_MS + 1)
    await e.embedQueryTagged('pricing')
    vi.useRealTimers()
    expect(calls).toHaveLength(2)
  })
})
