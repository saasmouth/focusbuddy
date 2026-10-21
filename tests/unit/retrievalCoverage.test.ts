// The retrieval half of the coverage port, on the REAL retrieval modules with a
// fake store: model-stale vectors count as missing, the knowledge backfill is
// batched, a partly-indexed pool does not lock its un-indexed items out,
// coverage is measured against the GATED route, and the chat trace says how
// much of a search was ranked by meaning.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Rec = { vector: number[]; model: string }
const store = new Map<string, Map<string, Rec>>()
const pool = (kind: string): Map<string, Rec> => {
  if (!store.has(kind)) store.set(kind, new Map())
  return store.get(kind)!
}
const knowledge: Array<{ id: string; title: string; body: string; tags: string[]; pinned: boolean }> = []
const docs = new Map<string, { id: string; docType: string; title: string; body: unknown }>()
let gatedModel: string | null = 'm'
let queryVec: Rec | null = { vector: [1, 0], model: 'm' }
let failAfterBatches = Infinity
const embedCalls: string[][] = []

vi.mock('../../src/main/db/embeddings', () => ({
  setEmbedding: (k: string, id: string, vector: number[], model: string) => pool(k).set(id, { vector, model }),
  listEmbeddings: (k: string) => new Map([...pool(k)].map(([id, r]) => [id, r.vector])),
  listEmbeddingsTagged: (k: string) => new Map(pool(k)),
  listEmbeddingModels: (k: string) => new Map([...pool(k)].map(([id, r]) => [id, { model: r.model }]))
}))
vi.mock('../../src/main/db/knowledge', () => ({ listKnowledge: () => [...knowledge] }))
vi.mock('../../src/main/db/documents', () => ({
  listDocuments: () => [...docs.values()].map((d) => ({ id: d.id, title: d.title, docType: d.docType })),
  getDocument: (id: string) => docs.get(id) ?? null
}))
vi.mock('../../src/main/db/docMetadata', () => ({ listDocMetadata: () => new Map(), getDocMetadata: () => null }))
vi.mock('../../src/main/ai/answerCache', () => ({ bumpAnswerCacheVersion: () => undefined }))
vi.mock('../../src/main/chunkIndex', () => ({ reindexDocumentChunks: () => undefined, chunkIndexActive: () => true }))
vi.mock('../../src/main/backgroundAiGate', () => ({
  EMBED_BATCH: 16,
  gatedActiveEmbedModel: async () => gatedModel,
  gatedEmbedQueryTagged: async () => queryVec,
  gatedEmbedTexts: async (texts: string[]) => {
    if (embedCalls.length >= failAfterBatches) return { ok: false as const, reason: 'network' }
    embedCalls.push(texts)
    return { ok: true as const, vectors: texts.map(() => [1, 0]), model: gatedModel ?? 'm' }
  }
}))

import { reindexKnowledge, semanticSearchKnowledge, knowledgeCoverage } from '../../src/main/semanticRetrieval'
import { reindexDocuments, semanticSearchDocuments, documentCoverage, _resetDocCache } from '../../src/main/documentRetrieval'
import { chatMeaningFraction, traceSemantic, workspaceCoverage } from '../../src/main/embeddingCoverage'
import { getTraceView, type AssistantTrace } from '../../src/renderer/src/lib/traceView'

// A unit vector at cosine `c` to the query [1, 0].
const at = (c: number): number[] => [c, Math.sqrt(1 - c * c)]

function tiptap(text: string): unknown {
  return { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }
}
function seedDoc(id: string, title: string, text: string): void {
  docs.set(id, { id, docType: 'doc', title, body: tiptap(text) })
}
function seedKnowledge(id: string, title: string, body: string): void {
  knowledge.push({ id, title, body, tags: [], pinned: false })
}

beforeEach(() => {
  store.clear()
  knowledge.length = 0
  docs.clear()
  _resetDocCache()
  gatedModel = 'm'
  queryVec = { vector: [1, 0], model: 'm' }
  failAfterBatches = Infinity
  embedCalls.length = 0
})

describe('reindexers treat a model-stale vector as missing', () => {
  it('knowledge: re-embeds the stale entry, leaves the current one alone', async () => {
    seedKnowledge('k1', 'One', 'a')
    seedKnowledge('k2', 'Two', 'b')
    pool('knowledge').set('k1', { vector: [1, 0], model: 'm' })
    pool('knowledge').set('k2', { vector: [1, 0], model: 'text-embedding-3-small' })
    expect(await reindexKnowledge()).toEqual({ embedded: 1 })
    expect(embedCalls).toEqual([['Two\n\nb']])
    expect(pool('knowledge').get('k2')?.model).toBe('m')
  })

  it('documents: the same rule', async () => {
    seedDoc('d1', 'Alpha', 'alpha body text')
    seedDoc('d2', 'Beta', 'beta body text')
    pool('document').set('d1', { vector: [1, 0], model: 'm' })
    pool('document').set('d2', { vector: [1, 0], model: 'ollama:previous' })
    expect(await reindexDocuments()).toEqual({ embedded: 1 })
    expect(pool('document').get('d2')?.model).toBe('m')
  })

  it('with no live route nothing is stale — there is nothing to replace it with', async () => {
    gatedModel = null
    seedKnowledge('k1', 'One', 'a')
    pool('knowledge').set('k1', { vector: [1, 0], model: 'local:nomic' })
    expect(await reindexKnowledge()).toEqual({ embedded: 0 })
    expect(embedCalls).toEqual([])
  })
})

describe('the knowledge backfill is batched', () => {
  it('sends at most EMBED_BATCH texts per request', async () => {
    for (let i = 0; i < 40; i++) seedKnowledge(`k${i}`, `T${i}`, 'x')
    expect(await reindexKnowledge()).toEqual({ embedded: 40 })
    expect(embedCalls.map((c) => c.length)).toEqual([16, 16, 8])
  })

  it('a failure partway keeps the batches already written and says why', async () => {
    for (let i = 0; i < 40; i++) seedKnowledge(`k${i}`, `T${i}`, 'x')
    failAfterBatches = 1
    expect(await reindexKnowledge()).toEqual({ embedded: 16, reason: 'network' })
    expect(pool('knowledge').size).toBe(16)
    // The next sweep picks up exactly where this one stopped.
    failAfterBatches = Infinity
    embedCalls.length = 0
    expect(await reindexKnowledge()).toEqual({ embedded: 24 })
  })
})

describe('a partly-indexed knowledge pool does not lock out its un-indexed entries', () => {
  it('the strongest keyword match without a vector still earns a slot', async () => {
    for (let i = 1; i <= 4; i++) {
      seedKnowledge(`idx${i}`, `Note ${i}`, 'mentions pricing once')
      pool('knowledge').set(`idx${i}`, { vector: at(0.9 - i * 0.01), model: 'm' })
    }
    seedKnowledge('kwBest', 'Pricing policy', 'pricing pricing')
    for (let i = 2; i <= 6; i++) seedKnowledge(`kw${i}`, `Other ${i}`, 'unrelated')
    const out = (await semanticSearchKnowledge('pricing', 4)).map((e) => e.id)
    expect(out).toHaveLength(4)
    expect(out).toContain('kwBest')
    // The indexed group still leads.
    expect(out.slice(0, 3)).toEqual(['idx1', 'idx2', 'idx3'])
  })
})

describe('coverage', () => {
  it('knowledge: stale and missing vectors are not usable', () => {
    seedKnowledge('k1', 'a', 'a')
    seedKnowledge('k2', 'b', 'b')
    seedKnowledge('k3', 'c', 'c')
    pool('knowledge').set('k1', { vector: [1], model: 'm' })
    pool('knowledge').set('k2', { vector: [1], model: 'old' })
    expect(knowledgeCoverage('m')).toMatchObject({ total: 3, embedded: 2, stale: 1, usable: 1 })
  })


  it('is measured against the GATED route: Background AI off and no local model is an honest 0', async () => {
    gatedModel = null
    seedKnowledge('k1', 'a', 'a')
    pool('knowledge').set('k1', { vector: [1], model: 'text-embedding-3-small' })
    const cov = await workspaceCoverage()
    expect(cov.model).toBeNull()
    expect(cov.fraction).toBe(0)
  })

  it('chat counts documents as keyword-ranked while they go through the chunk index', () => {
    const report = (total: number, usable: number) => ({ total, embedded: usable, stale: 0, usable, fraction: 0 })
    const cov = {
      knowledge: report(10, 10),
      documents: report(90, 90),
      model: 'm',
      fraction: 1
    }
    expect(chatMeaningFraction(cov, false)).toBeCloseTo(0.1, 5)
    expect(chatMeaningFraction(cov, true)).toBe(1)
  })
})

describe('the trace says how much of a search was ranked by meaning', () => {
  const base: AssistantTrace = {
    status: 'done',
    startedAt: 0,
    retrievedAt: 1,
    retrievalMs: 12,
    repliedAt: 2,
    completedAt: 3,
    mentions: [],
    sources: [{ n: 1, docId: 'd1', title: 'Doc', docType: 'document', snippet: '' }],
    tools: [],
    activity: null,
    error: null
  }
  const label = (t: Partial<AssistantTrace>): string =>
    getTraceView({ ...base, ...t }, 1).completed.find((l) => l.key === 'retrieve')?.label ?? ''

  it('partial coverage is disclosed, rounded down', () => {
    expect(label({ semantic: true, semanticCoverage: 0.486 })).toContain('48% ranked by meaning')
    expect(label({ semantic: true, semanticCoverage: 0.996 })).toContain('99% ranked by meaning')
  })
  it('full or unknown coverage says nothing extra', () => {
    expect(label({ semantic: true, semanticCoverage: 1 })).not.toContain('meaning')
    expect(label({ semantic: true })).not.toContain('meaning')
  })
  it('keyword-only still reads as keyword match, not as a coverage share', () => {
    const l = label({ semantic: false, semanticCoverage: 0 })
    expect(l).toContain('keyword match')
    expect(l).not.toContain('meaning')
  })
})

describe('what the trace may claim (traceSemantic)', () => {
  it('a saved key with Background AI off and no local model is keyword search', () => {
    // embeddingConfigured() says true (a key exists); the gated route is null.
    expect(traceSemantic(true, { fraction: 0, model: null })).toEqual({ semantic: false, semanticCoverage: null })
  })
  it('with a gated route, the coverage share rides along', () => {
    expect(traceSemantic(true, { fraction: 0.4, model: 'm' })).toEqual({ semantic: true, semanticCoverage: 0.4 })
  })
  it('a failed coverage probe leaves the availability answer alone and discloses no share', () => {
    expect(traceSemantic(true, null)).toEqual({ semantic: true, semanticCoverage: null })
    expect(traceSemantic(false, null)).toEqual({ semantic: false, semanticCoverage: null })
  })
})

describe('the corpus becomes embeddable: sweep now, not at the next tick', () => {
  const ipc = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'ipc', 'index.ts'), 'utf8')
  const handler = (channel: string): string => {
    const start = ipc.indexOf(`ipcMain.handle('${channel}'`)
    expect(start).toBeGreaterThan(0)
    return ipc.slice(start, ipc.indexOf('ipcMain.handle(', start + 10))
  }
  it('saving an OpenAI key kicks the (gated) embedding sweep without awaiting it', () => {
    const h = handler('settings:saveOpenAIKey')
    expect(h).toContain('kickEmbeddingSweep()')
    expect(h).not.toMatch(/await\s+kickEmbeddingSweep/)
  })
  it('turning Background AI tasks on kicks it; any other prefs change does not', () => {
    const h = handler('privacy:setPrefs')
    expect(h).toMatch(/if \(!wasOn && next\.backgroundAi\) kickEmbeddingSweep\(\)/)
  })
})
