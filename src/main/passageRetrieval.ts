// The chat / ask document pool, ranked on PASSAGES by meaning as well as by
// keyword.
//
// Until 4.3.42 the PlexiiBrain answer paths (PlexiiAssist, PlexiSearch Ask, Ask
// your workspace) found documents through the chunk index alone: BM25 over
// ~1200-char passages. The passage VECTORS that 4.3.41 started writing with the
// bundled nomic model (chunkEmbeddings.ts) ranked documents only in Search, so
// on those paths "Passages ranked by meaning" in Settings described a signal no
// answer used, a paraphrased question could not find the paragraph that
// answers it, and the search line's "· N% ranked by meaning" counted documents
// as keyword-only (chatMeaningFraction) — 43% on the owner's workspace.
//
// Here both signals rank the same passages:
//   - keyword: the chunk index's BM25 hits, as before;
//   - meaning: every passage vector compared with the question's vector (one
//     embedding per search), each document scored on its BEST passage, the
//     whole-document vector as the fallback for a document whose passages are
//     not embedded yet.
// The same #5 gate and blend as the other semantic pools (gateSemantic /
// blendSemantic): an uncorroborated cosine field admits nothing. A document
// chosen by meaning is grounded on the passages that matched by meaning first,
// then the keyword passages — never on its opening.
//
// With no embedder (none installed, Background AI off and no local model) or no
// passage vectors yet, this is exactly the BM25 pool it replaces.

import { getDb } from './db/database'
import { getActiveOrgId } from './db/activeOrg'
import { getDocMetadata } from './db/docMetadata'
import { listEmbeddingsTagged } from './db/embeddings'
import { gatedEmbedQueryTagged, gatedEmbedTexts } from './backgroundAiGate'
import { chunkKind } from './chunkEmbeddings'
import { chunkSearchDocuments, searchChunks, type ChunkDb } from './chunkIndex'
import { chunkText, queryTerms, snippetFor, termVariants, type WorkspaceSource } from './workspaceRank'
import { cosineSim, blendSemantic, gateSemantic, semanticShare, type ScoredItem } from '@shared/semantic'

/** What a source's grounding text may carry, as selectPassages does. */
const PASSAGE_CHARS = 6000
/** Passages matched by meaning carried per document. */
const MEANING_PASSAGES = 2

interface ChunkRow {
  id: string
  sourceId: string
  title: string
  sourceKind: string | null
  text: string
}

export interface ScoredChunk {
  id: string
  sourceId: string
  score: number
}

/**
 * Every comparable passage of `sourceType`, scored against the query vector,
 * grouped by source, best first. Passages written by another embedder (or of
 * another dimension) are not comparable and are left out. Pure over its inputs;
 * exported for tests.
 */
export function scorePassages(
  query: { vector: number[]; model: string },
  chunks: ReadonlyArray<{ id: string; sourceId: string }>,
  vectors: ReadonlyMap<string, { vector: number[]; model: string }>
): Map<string, ScoredChunk[]> {
  const out = new Map<string, ScoredChunk[]>()
  for (const c of chunks) {
    const rec = vectors.get(c.id)
    if (!rec || rec.model !== query.model || rec.vector.length !== query.vector.length) continue
    const list = out.get(c.sourceId) ?? []
    list.push({ id: c.id, sourceId: c.sourceId, score: cosineSim(query.vector, rec.vector) })
    out.set(c.sourceId, list)
  }
  for (const list of out.values()) list.sort((a, b) => b.score - a.score)
  return out
}

interface Candidate {
  sourceId: string
  title: string
  docType: string
  /** BM25 passages, best first. */
  keywordPassages: string[]
  /** Passages by meaning, best first. */
  meaning: ScoredChunk[]
}

/**
 * Rank documents for a question on keyword AND passage meaning. Pure over its
 * inputs (the BM25 hits, the scored passages, the passage texts); exported for
 * tests. `bm25` is best first.
 */
export function rankDocumentPassages(
  bm25: ReadonlyArray<{ sourceId: string; title: string; sourceKind: string | null; passages: string[] }>,
  meaning: ReadonlyMap<string, ScoredChunk[]>,
  wholeDoc: ReadonlyMap<string, number>,
  rows: ReadonlyMap<string, ChunkRow>,
  limit: number
): Array<{ sourceId: string; title: string; docType: string; text: string; byMeaning: boolean }> {
  const cands = new Map<string, Candidate>()
  bm25.forEach((h) => {
    cands.set(h.sourceId, {
      sourceId: h.sourceId,
      title: h.title,
      docType: h.sourceKind ?? 'doc',
      keywordPassages: h.passages,
      meaning: meaning.get(h.sourceId) ?? []
    })
  })
  for (const [sourceId, list] of meaning) {
    if (cands.has(sourceId) || list.length === 0) continue
    const row = rows.get(list[0].id)
    if (!row) continue
    cands.set(sourceId, { sourceId, title: row.title, docType: row.sourceKind ?? 'doc', keywordPassages: [], meaning: list })
  }
  const kwRank = new Map(bm25.map((h, i) => [h.sourceId, bm25.length - i]))
  const scored: ScoredItem<Candidate>[] = [...cands.values()].map((c) => ({
    item: c,
    keyword: kwRank.get(c.sourceId) ?? 0,
    semantic: c.meaning.length > 0 ? c.meaning[0].score : (wholeDoc.get(c.sourceId) ?? null)
  }))
  const gated = gateSemantic(scored)
  const admitted = new Set(gated.filter((s) => s.semantic !== null).map((s) => s.item))
  return blendSemantic(gated, { limit, coverage: semanticShare(scored) }).map((c) => {
    const byMeaning = admitted.has(c) && c.meaning.length > 0
    const lead = byMeaning
      ? c.meaning
          .slice(0, MEANING_PASSAGES)
          .map((m) => rows.get(m.id)?.text ?? '')
          .filter(Boolean)
      : []
    const seen = new Set<string>()
    const passages = [...lead, ...c.keywordPassages].filter((p) => {
      const k = p.trim()
      if (!k || seen.has(k)) return false
      seen.add(k)
      return true
    })
    return { sourceId: c.sourceId, title: c.title, docType: c.docType, text: passages.join('\n…\n').slice(0, PASSAGE_CHARS), byMeaning }
  })
}

function db(): ChunkDb {
  return getDb() as unknown as ChunkDb
}

function listDocumentChunks(): ChunkRow[] {
  const rows = getDb()
    .prepare(
      "SELECT id, source_id, title, source_kind, text FROM fb_chunks WHERE source_type = 'document' AND org_id = ? ORDER BY source_id, chunk_index"
    )
    .all(getActiveOrgId()) as Array<{ id: string; source_id: string; title: string; source_kind: string | null; text: string }>
  return rows.map((r) => ({ id: r.id, sourceId: r.source_id, title: r.title, sourceKind: r.source_kind, text: r.text }))
}

/**
 * The document pool for an answer: passages ranked on keyword and meaning.
 * Falls back to the keyword-only chunk pool when there is nothing to compare
 * (no embedder, or no passage vectors yet). Never throws.
 */
export async function passageSearchDocuments(query: string, limit = 6): Promise<WorkspaceSource[]> {
  if (!query.trim()) return []
  try {
    const q = await gatedEmbedQueryTagged(query)
    const passageVecs = q ? listEmbeddingsTagged(chunkKind('document')) : new Map<string, { vector: number[]; model: string }>()
    if (!q || passageVecs.size === 0) return chunkSearchDocuments(query, limit)
    const chunks = listDocumentChunks()
    const rows = new Map(chunks.map((c) => [c.id, c]))
    const meaning = scorePassages(q, chunks, passageVecs)
    if (meaning.size === 0) return chunkSearchDocuments(query, limit)
    const whole = new Map<string, number>()
    for (const [docId, rec] of listEmbeddingsTagged('document')) {
      if (rec.model === q.model && rec.vector.length === q.vector.length) whole.set(docId, cosineSim(q.vector, rec.vector))
    }
    // Every keyword-matching document competes, not just the first `limit`:
    // a document the blend lifts on meaning must be able to displace one that
    // only matched a word.
    const bm25 = searchChunks(db(), query, { orgId: getActiveOrgId(), sourceType: 'document', limit: 40 })
    return rankDocumentPassages(bm25, meaning, whole, rows, limit).map((d, i) => {
      const meta = getDocMetadata(d.sourceId)
      return {
        docId: d.sourceId,
        title: d.title || 'Untitled',
        docType: d.docType,
        snippet: snippetFor(d.text, query),
        text: d.text,
        score: 1 - i * 0.01,
        summary: meta?.summary || undefined,
        category: meta?.category || undefined,
        dates: meta?.dates,
        entities: meta?.entities
      }
    })
  } catch {
    // Retrieval is best-effort: a failed embed or read leaves keyword search.
    return chunkSearchDocuments(query, limit)
  }
}

// ── "This document" scope ────────────────────────────────────────────────────
//
// Ask your workspace can ground on the open document alone. It used to send the
// document's first 12,000 characters, so on a long document a fact past ~page 4
// could never be answered ("Your documents don't say …" about a sentence that
// was right there, LBP-1 at 37115bfb). A document that fits is sent whole, as
// before; a longer one is cut to its opening plus the passages that answer the
// question — by keyword, and by meaning when an embedder is available.

/** Characters of the open document an answer may carry. */
export const DOC_SCOPE_CHARS = 12_000

function keywordHits(passage: string, terms: string[]): number {
  const hay = passage.toLowerCase()
  let n = 0
  for (const t of terms) if (termVariants(t).some((v) => hay.includes(v))) n++
  return n
}

/**
 * Pick the passages of one long text that answer `question`, within `cap`
 * characters, in document order, the opening first. `meaning` holds a cosine
 * per passage index when one was computed. Pure; exported for tests.
 */
export function pickDocumentPassages(question: string, passages: string[], meaning: ReadonlyArray<number | null>, cap = DOC_SCOPE_CHARS): string {
  const terms = queryTerms(question)
  const kw = passages.map((p) => keywordHits(p, terms))
  const maxKw = Math.max(1, ...kw)
  const sem = passages.map((_, i) => meaning[i] ?? null)
  const hasSem = sem.some((v) => v !== null)
  const score = passages.map((_, i) => (hasSem ? 0.7 * Math.max(0, sem[i] ?? 0) + 0.3 * (kw[i] / maxKw) : kw[i] / maxKw))
  const chosen = new Set<number>([0])
  let used = passages[0]?.length ?? 0
  const order = passages.map((_, i) => i).filter((i) => i > 0).sort((a, b) => score[b] - score[a])
  for (const i of order) {
    if (used + passages[i].length + 3 > cap) continue
    chosen.add(i)
    used += passages[i].length + 3
  }
  return [...chosen]
    .sort((a, b) => a - b)
    .map((i) => passages[i])
    .join('\n…\n')
    .slice(0, cap)
}

/** The open document as an answer may carry it: whole when it fits, else its answering passages. Never throws. */
export async function documentScopeText(question: string, text: string, cap = DOC_SCOPE_CHARS): Promise<string> {
  if (text.length <= cap) return text
  const passages = chunkText(text)
  let meaning: Array<number | null> = []
  try {
    const q = await gatedEmbedQueryTagged(question)
    if (q) {
      const r = await gatedEmbedTexts(passages)
      if (r.ok && r.model === q.model) {
        meaning = passages.map((_, i) => (r.vectors[i] && r.vectors[i].length === q.vector.length ? cosineSim(q.vector, r.vectors[i]) : null))
      }
    }
  } catch {
    meaning = []
  }
  return pickDocumentPassages(question, passages, meaning, cap)
}
