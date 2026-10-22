// "PlexiiBrain ranks by passage" (owner check, 4.3.41). At 37115bfb the answer
// paths ranked documents by keyword alone (BM25 over chunks) while Settings
// reported passage vectors; the search line then said "· 0% ranked by meaning"
// over a fully embedded workspace (LBP-1), and "This document" sent only the
// first 12,000 characters, so a deep fact was "not in your documents".
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Rec = { vector: number[]; model: string }
let chunkRows: Array<{ id: string; source_id: string; title: string; source_kind: string; text: string }> = []
let passageVecs = new Map<string, Rec>()
let wholeVecs = new Map<string, Rec>()
let queryVec: Rec | null = { vector: [1, 0], model: 'm' }
let bm25: Array<{ sourceId: string; title: string; sourceKind: string; roomId: null; rank: number; passages: string[] }> = []
let embedTexts: (texts: string[]) => { ok: true; vectors: number[][]; model: string } | { ok: false; reason: string } = (t) => ({
  ok: true,
  vectors: t.map(() => [0, 1]),
  model: 'm'
})

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({ prepare: () => ({ all: () => chunkRows }) })
}))
vi.mock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => 'personal' }))
vi.mock('../../src/main/db/docMetadata', () => ({ getDocMetadata: () => null }))
vi.mock('../../src/main/db/embeddings', () => ({
  listEmbeddingsTagged: (k: string) => (k === 'chunk:document' ? new Map(passageVecs) : new Map(wholeVecs))
}))
vi.mock('../../src/main/backgroundAiGate', () => ({
  gatedEmbedQueryTagged: async () => queryVec,
  gatedEmbedTexts: async (texts: string[]) => embedTexts(texts)
}))
vi.mock('../../src/main/chunkEmbeddings', () => ({ chunkKind: (s: string) => `chunk:${s}` }))
vi.mock('../../src/main/chunkIndex', () => ({
  searchChunks: () => bm25,
  chunkSearchDocuments: () => bm25.map((h) => ({ docId: h.sourceId, title: h.title, docType: 'doc', snippet: '', text: h.passages.join('\n…\n'), score: 1 }))
}))

import { passageSearchDocuments, scorePassages, pickDocumentPassages, documentScopeText, DOC_SCOPE_CHARS } from '../../src/main/passageRetrieval'

const at = (c: number): number[] => [c, Math.sqrt(1 - c * c)]
const FACT = 'The standby diesel generator at the Ballarat distribution centre is maintained by Kestrel Power Systems every fourteen weeks.'

beforeEach(() => {
  queryVec = { vector: [1, 0], model: 'm' }
  wholeVecs = new Map()
  // A long manual: many passages; the fact sits deep in passage 9.
  chunkRows = Array.from({ length: 12 }, (_, i) => ({
    id: `man-${i}`,
    source_id: 'manual',
    title: 'Warehouse operations manual',
    source_kind: 'doc',
    text: i === 9 ? FACT : `Picking, part ${i}. Pickers work in waves and report anything unusual to the Ballarat shift lead.`
  }))
  chunkRows.push({ id: 'brand-0', source_id: 'brand', title: 'Brand guidelines', source_kind: 'doc', text: 'Use the reversed logo on dark backgrounds.' })
  passageVecs = new Map(chunkRows.map((c) => [c.id, { vector: at(c.id === 'man-9' ? 0.9 : c.id === 'brand-0' ? 0.2 : 0.5), model: 'm' }]))
  // Keyword search finds the manual on "Ballarat" but leads with an opening passage.
  bm25 = [{ sourceId: 'manual', title: 'Warehouse operations manual', sourceKind: 'doc', roomId: null, rank: -3, passages: [chunkRows[0].text, chunkRows[1].text] }]
})

describe('the answer paths rank documents on their passages by meaning', () => {
  it('the passage that answers leads the grounding text, ahead of the keyword passages', async () => {
    const out = await passageSearchDocuments('Who looks after the backup power generator at our Ballarat site?', 6)
    expect(out.map((d) => d.docId)).toEqual(['manual'])
    expect(out[0].text.startsWith(FACT)).toBe(true)
    expect(out[0].text).toContain(chunkRows[0].text)
  })
  it('a document no keyword reaches can still be admitted by meaning when the keyword band corroborates it', async () => {
    chunkRows.push({ id: 'policy-0', source_id: 'policy', title: 'Site services', source_kind: 'doc', text: 'Generators are serviced quarterly by contractors.' })
    passageVecs.set('policy-0', { vector: at(0.88), model: 'm' })
    const out = await passageSearchDocuments('Who looks after the backup power generator at our Ballarat site?', 6)
    expect(out.map((d) => d.docId)).toContain('policy')
  })
  it('an uncorroborated cosine field admits nothing (the #5 gate)', async () => {
    bm25 = []
    expect(await passageSearchDocuments('anything at all', 6)).toEqual([])
  })
  it('with no embedder, or no passage vectors yet, it is exactly the keyword pool', async () => {
    queryVec = null
    const a = await passageSearchDocuments('Ballarat generator', 6)
    expect(a[0].text).toBe(bm25[0].passages.join('\n…\n'))
    queryVec = { vector: [1, 0], model: 'm' }
    passageVecs = new Map()
    const b = await passageSearchDocuments('Ballarat generator', 6)
    expect(b[0].text).toBe(bm25[0].passages.join('\n…\n'))
  })
  it('vectors from another embedder are not compared', () => {
    const m = scorePassages({ vector: [1, 0], model: 'm' }, [{ id: 'a', sourceId: 's' }, { id: 'b', sourceId: 's' }], new Map([
      ['a', { vector: [1, 0], model: 'other' }],
      ['b', { vector: at(0.3), model: 'm' }]
    ]))
    expect(m.get('s')!.map((c) => c.id)).toEqual(['b'])
  })
})

describe('"This document" scope: a long document is cut to its answering passages, not its head', () => {
  const long = Array.from({ length: 60 }, (_, i) => (i === 51 ? FACT : `Section ${i}. Pallets are checked on arrival and damage is logged before the driver leaves.`).padEnd(700, ' .')).join('\n\n')

  it('a document that fits is sent whole', async () => {
    expect(await documentScopeText('q', 'short text')).toBe('short text')
  })
  it('a deep fact past the old 12,000-character head is carried, with the opening', async () => {
    expect(long.indexOf(FACT)).toBeGreaterThan(DOC_SCOPE_CHARS)
    const text = await documentScopeText('Who maintains the generator at Ballarat?', long)
    expect(text.length).toBeLessThanOrEqual(DOC_SCOPE_CHARS)
    expect(text).toContain(FACT)
    expect(text.startsWith('Section 0.')).toBe(true)
  })
  it('by meaning alone when no word matches', () => {
    const passages = ['Opening.', 'Alpha.', 'Beta.', 'Gamma.']
    const out = pickDocumentPassages('zzz', passages, [0.1, 0.1, 0.95, 0.1], 'Opening.'.length + 'Beta.'.length + 3)
    expect(out).toBe('Opening.\n…\nBeta.')
  })
  it('an embedder failure leaves the keyword choice', async () => {
    embedTexts = () => ({ ok: false, reason: 'down' })
    const text = await documentScopeText('Who maintains the generator at Ballarat?', long)
    expect(text).toContain(FACT)
  })
})
