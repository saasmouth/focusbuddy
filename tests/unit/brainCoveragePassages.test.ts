// Settings › AI › Local: "Passages ranked by meaning: X of Y".
//
// LBP-2 at 37115bfb: the panel opened at "0 of 40" and stayed there while the
// background sweep embedded all 40 passages behind it — it read the counts
// once, on open. The counts themselves, and the signal that makes them move.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const chunkRows: { id: string; source_id: string; title: string; text: string }[] = []
let stored = new Map<string, { vector: number[]; model: string }>()
const signals: number[] = []

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({ prepare: () => ({ all: () => chunkRows }) })
}))
vi.mock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => 'personal' }))
vi.mock('../../src/main/db/embeddings', () => ({
  listEmbeddingsTagged: () => stored,
  listEmbeddingModels: () => new Map([...stored].map(([id, r]) => [id, { model: r.model }])),
  setEmbedding: (_k: string, id: string, v: number[], m: string) => stored.set(id, { vector: v, model: m }),
  deleteEmbedding: (_k: string, id: string) => stored.delete(id)
}))
vi.mock('../../src/main/backgroundAiGate', () => ({
  EMBED_BATCH: 4,
  gatedActiveEmbedModel: async () => 'local:nomic-embed-text-v1.5',
  gatedEmbedTexts: async (texts: string[]) => ({ ok: true as const, vectors: texts.map(() => [1, 0]), model: 'local:nomic-embed-text-v1.5' })
}))
// The sweep's other pools have nothing to do here.
vi.mock('../../src/main/documentRetrieval', () => ({ reindexDocuments: async () => ({ embedded: 0 }) }))
vi.mock('../../src/main/semanticRetrieval', () => ({ reindexKnowledge: async () => ({ embedded: 0 }) }))
vi.mock('../../src/main/db/documents', () => ({ listDocuments: () => [], getDocument: () => null }))
vi.mock('../../src/main/ai/localModel', () => ({ localModelStatus: async () => ({ available: false }) }))
vi.mock('../../src/main/ai/enrichDocuments', () => ({ enrichDocument: async () => ({ ok: false }) }))
vi.mock('../../src/main/ai/extractMemory', () => ({ extractMemoryFromText: async () => ({ added: 0 }) }))
vi.mock('../../src/main/db/localAiLedger', () => ({
  localAiContentHash: () => 'h',
  needsLocalAiPass: () => false,
  markLocalAiPass: () => undefined
}))

import { chunkEmbeddingCoverage } from '../../src/main/chunkEmbeddings'
import { sweepEmbeddings, setCoverageSink } from '../../src/main/ai/localAiSweeps'

const MODEL = 'local:nomic-embed-text-v1.5'
function longDocument(passages: number): void {
  for (let i = 0; i < passages; i++) chunkRows.push({ id: `c${i}`, source_id: 'manual', title: 'Manual', text: `passage ${i}` })
}

beforeEach(() => {
  chunkRows.length = 0
  stored = new Map()
  signals.length = 0
  setCoverageSink(() => signals.push(Date.now()))
})

describe('the counts: X passages comparable to the live embedder, of Y passages', () => {
  it('a long document is many passages, each counted', () => {
    longDocument(40)
    expect(chunkEmbeddingCoverage('document', MODEL)).toMatchObject({ total: 40, usable: 0 })
    for (let i = 0; i < 25; i++) stored.set(`c${i}`, { vector: [1, 0], model: MODEL })
    expect(chunkEmbeddingCoverage('document', MODEL)).toMatchObject({ total: 40, usable: 25 })
  })
  it('a passage embedded by another model is not counted as ranked by meaning', () => {
    longDocument(3)
    stored.set('c0', { vector: [1, 0], model: MODEL })
    stored.set('c1', { vector: [1, 0], model: 'openai:text-embedding-3-small' })
    expect(chunkEmbeddingCoverage('document', MODEL)).toMatchObject({ total: 3, usable: 1, stale: 1 })
  })
  it('with no embedder nothing is usable, and nothing is invented', () => {
    longDocument(3)
    expect(chunkEmbeddingCoverage('document', null)).toMatchObject({ total: 3, usable: 0 })
  })
})

describe('the counts move while the panel is open', () => {
  it('the sweep embeds every passage and signals that coverage changed', async () => {
    longDocument(40)
    const r = await sweepEmbeddings()
    expect(r.passages).toBe(40)
    expect(chunkEmbeddingCoverage('document', MODEL)).toMatchObject({ total: 40, usable: 40 })
    // At least the final signal, after the last batch was written.
    expect(signals.length).toBeGreaterThanOrEqual(1)
  })
  it('a sweep with nothing to do stays quiet', async () => {
    longDocument(2)
    for (let i = 0; i < 2; i++) stored.set(`c${i}`, { vector: [1, 0], model: MODEL })
    await sweepEmbeddings()
    expect(signals).toEqual([])
  })
  it('main broadcasts it, and Settings re-reads the counts on it', () => {
    const root = join(__dirname, '..', '..', 'src')
    expect(readFileSync(join(root, 'main', 'index.ts'), 'utf8')).toMatch(/setCoverageSink\([\s\S]{0,200}'brain:coverageChanged'/)
    expect(readFileSync(join(root, 'preload', 'index.ts'), 'utf8')).toMatch(/onCoverageChanged[\s\S]{0,200}'brain:coverageChanged'/)
    expect(readFileSync(join(root, 'renderer', 'src', 'components', 'settings', 'LocalAiSection.tsx'), 'utf8')).toMatch(
      /onCoverageChanged\?\.\(\(\) => void refreshCoverage\(\)\)/
    )
  })
})
