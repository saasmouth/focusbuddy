// Semantic retrieval for documents, the companion to semanticRetrieval.ts which
// does the same for PlexiBrain knowledge. With an embedding key configured the
// "ask your workspace" grounding ranks documents by meaning (cosine similarity
// blended with keyword overlap); without one every document's semantic score is
// null and the blend degrades to keyword search, the same result the old
// rankSources path gave. Nothing is invented: a document with no signal scores
// zero and drops out.

import { listDocuments, getDocument } from './db/documents'
import { extractDocText, selectPassages, snippetFor, type WorkspaceSource } from './workspaceRank'
// Through the Background AI tasks gate: content goes to a cloud embedder only
// while the person allows it (backgroundAiGate.ts).
import {
  gatedEmbedTexts as embedTexts,
  gatedEmbedQueryTagged as embedQueryTagged,
  gatedActiveEmbedModel,
  EMBED_BATCH
} from './backgroundAiGate'
import { coverageFor, needsEmbedding, type CoverageReport } from './ai/coverageMath'
import { setEmbedding, listEmbeddings, listEmbeddingsTagged, listEmbeddingModels } from './db/embeddings'
import { listDocMetadata, getDocMetadata, type DocMetadata } from './db/docMetadata'
import { bumpAnswerCacheVersion } from './ai/answerCache'
import { cosineSim, blendSemantic, gateSemantic, semanticShare, type ScoredItem } from '@shared/semantic'
import { reindexDocumentChunks } from './chunkIndex'
import { bestChunkScores } from './chunkEmbeddings'

const KIND = 'document'
// Cap the text we embed so a very long document stays inside the embedding
// model's token budget. The same slice is what extractDocText already returns,
// so titles and the document head dominate the vector, which is what we want.
const EMBED_CHARS = 8000

interface DocItem {
  docId: string
  title: string
  docType: string
  text: string
  // AI-enriched metadata (local model), when the doc has been enriched.
  meta?: DocMetadata
}

// Build the full document pool once: metadata joined to extracted body text,
// skipping archived docs (listDocuments already excludes them) and any that
// extract to nothing so an empty doc never becomes a phantom source. AI-enriched
// metadata is joined in one query so retrieval + grounding can use it.
// The document corpus, cached against a signature of the documents themselves.
//
// loadDocItems() reads EVERY document body and extracts its text on every call,
// and it is called on every assistant turn: 139 documents on a real workspace,
// re-parsed before the model sees a word. The content is query-independent, so
// it is built once and reused until a document actually changes.
//
// Keyed on a data signature rather than on bumpAnswerCacheVersion(), which
// fires on document saves but says nothing about the enriched metadata joined
// in here — and stale context is a worse failure than a slow answer.
let docCache: { sig: string; items: DocItem[] } | null = null

/** Test seam: drop the cache so a test can observe a rebuild. */
export function _resetDocCache(): void {
  docCache = null
}

/**
 * Fingerprint the document set from the SAME api the corpus is built from.
 *
 * An earlier version fingerprinted the underlying SQL tables, which is unsound
 * the moment the two disagree: a caller reading documents through a seam that
 * is not that table gets a signature that never moves while the data does, and
 * the cache then serves the first corpus it ever built. listDocuments() is a
 * single indexed query, so this costs nothing next to the extraction it guards.
 */
function docSetSignature(): string {
  let n = 0
  let newest = 0
  for (const m of listDocuments()) {
    n++
    const u = (m as { updatedAt?: number }).updatedAt ?? 0
    if (u > newest) newest = u
  }
  return `${n}:${newest}`
}

function loadDocItemsCached(): DocItem[] {
  const sig = docSetSignature()
  if (!docCache || docCache.sig !== sig) docCache = { sig, items: loadDocItems() }
  return docCache.items
}

function loadDocItems(): DocItem[] {
  const metaMap = listDocMetadata()
  const items: DocItem[] = []
  for (const m of listDocuments()) {
    const full = getDocument(m.id)
    if (!full) continue
    const text = extractDocText(m.docType, full.body)
    if (text.length === 0) continue
    items.push({ docId: m.id, title: m.title, docType: m.docType as string, text, meta: metaMap.get(m.id) })
  }
  return items
}

// The text we embed for a document. When enriched, the distilled metadata
// (category, summary, keywords, entities) leads the vector so a long doc's whole
// gist is captured, not just the head that fits under EMBED_CHARS. Un-enriched
// docs fall back to the original title + body, so behaviour is unchanged for them.
function embedText(item: DocItem): string {
  const m = item.meta
  const metaLead = m
    ? [m.category, m.summary, m.keywords.join(' '), m.entities.join(' ')]
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n')
    : ''
  return `${item.title}\n${metaLead}\n${item.text}`.replace(/\n{2,}/g, '\n').trim().slice(0, EMBED_CHARS)
}

// Keyword overlap on the same scale the knowledge scorer uses, so the blend
// weights are comparable across the two corpora: title hits count for more than
// body hits, summed over the query's terms.
function keywordScore(item: DocItem, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const terms = q.split(/\s+/).filter(Boolean)
  const t = item.title.toLowerCase()
  const b = item.text.toLowerCase()
  let s = 0
  for (const term of terms) {
    if (t.includes(term)) s += 3
    if (b.includes(term)) s += 1
  }
  return s
}

// Snippet anchoring is the shared rule (workspaceRank.snippetFor, defect #27):
// earliest CONTENT-term hit, never a stopword.

// Embed one document and store its vector. Best-effort: no key is a silent no-op
// so saving a document never blocks or errors on a missing key.
export async function embedDocument(docId: string): Promise<void> {
  // A document changed (this is the save/restore chokepoint), so any cached
  // workspace answer is now potentially stale — invalidate the answer cache.
  bumpAnswerCacheVersion()
  // Keep the chunk index in step (A2, R10): content-hash cheap, synchronous,
  // and independent of the embedding key below.
  reindexDocumentChunks(docId)
  const full = getDocument(docId)
  if (!full) return
  const meta = listDocuments().find((m) => m.id === docId)
  const text = extractDocText(full.docType, full.body)
  if (text.length === 0) return
  const item: DocItem = { docId, title: meta?.title ?? '', docType: full.docType, text, meta: getDocMetadata(docId) ?? undefined }
  const r = await embedTexts([embedText(item)])
  if (r.ok && r.vectors[0]) setEmbedding(KIND, docId, r.vectors[0], r.model)
}

// Backfill embeddings for documents lacking one (or all, when force). Returns the
// count embedded and, if it could not, why (e.g. no_key) so the UI stays honest.
// Batched (EMBED_BATCH, backgroundAiGate.ts). The whole backlog used to go in ONE
// request: with a large workspace that is hundreds of kilobytes of text in a
// single call, and because a failure returned `embedded: 0` and wrote nothing, a
// backlog too big to embed in one shot could never shrink — it failed
// identically every time. Batching makes progress durable: each batch that
// succeeds is persisted, and a later failure leaves the earlier work in place.
//
// A vector written by a different embedder than the live (gated) route counts
// as missing — see needsEmbedding. Without that, switching embedder (a local
// model installed, Background AI tasks turned off or on) left every document
// keyword-only until a forced reindex nobody knew to run.
export async function reindexDocuments(force = false): Promise<{ embedded: number; reason?: string }> {
  const items = loadDocItems()
  let todo = items
  if (!force) {
    const active = await gatedActiveEmbedModel()
    const tagged = listEmbeddingModels(KIND)
    todo = items.filter((d) => needsEmbedding(tagged.get(d.docId), active))
  }
  if (todo.length === 0) return { embedded: 0 }
  let embedded = 0
  let reason: string | undefined
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH)
    const r = await embedTexts(batch.map(embedText))
    if (!r.ok) {
      // Stop on the first failing batch and report why, keeping everything
      // already written. A missing key fails the first batch and reports
      // honestly rather than looking like a partial success.
      reason = r.reason
      break
    }
    batch.forEach((d, j) => {
      if (r.vectors[j]) {
        setEmbedding(KIND, d.docId, r.vectors[j], r.model)
        embedded++
      }
    })
  }
  return reason ? { embedded, reason } : { embedded }
}

/**
 * Coverage of the document pool against a given live embedder, per DOCUMENT: a
 * document is usable when the query side can compare it at all — through a
 * passage vector (what ranking prefers) or, failing that, its whole-document
 * vector (the fallback). Stale = holds vectors, none of them comparable.
 */
export function documentCoverage(
  activeModel: string | null,
  passageSources: ReadonlyMap<string, { model: string }> = new Map()
): CoverageReport {
  const whole = listEmbeddingModels(KIND)
  const merged = new Map<string, { model: string }>()
  for (const d of loadDocItemsCached()) {
    const passage = passageSources.get(d.docId)
    const doc = whole.get(d.docId)
    // Prefer whichever record is comparable; otherwise any record (stale).
    const usable = [passage, doc].find((r) => r && activeModel !== null && r.model === activeModel)
    const rec = usable ?? passage ?? doc
    if (rec) merged.set(d.docId, rec)
  }
  return coverageFor(
    loadDocItemsCached().map((d) => d.docId),
    merged,
    activeModel
  )
}

// Semantic + keyword blended search over documents, returned as WorkspaceSource
// so the grounding path can use it directly. queryVec is null when there is no
// embedding key, in which case every semantic score is null and the blend is
// pure keyword, identical to the old rankSources behaviour.
export async function semanticSearchDocuments(query: string, limit = 6): Promise<WorkspaceSource[]> {
  if (!query.trim()) return []
  const items = loadDocItemsCached()
  if (items.length === 0) return []
  const q = await embedQueryTagged(query)
  const vectors = q
    ? listEmbeddingsTagged(KIND)
    : new Map<string, { vector: number[]; model: string }>()
  // Best PASSAGE score per document, when its chunks carry vectors. This is the
  // primary semantic signal: a whole-document vector is a blurred centroid of
  // everything the document says (capped at EMBED_CHARS), which a short specific
  // question cannot match. Measured on a real corpus, 29 questions drawn from
  // deep inside documents: whole-document vectors put the containing document
  // first 19/29 times (mean rank 5.55), passage vectors 23/29 (mean rank 2.28).
  // The whole-document vector stays as the fallback for a document whose chunks
  // are not embedded yet — absence of a passage vector is not irrelevance.
  // The same query vector is reused: one embedding per search, not two.
  const passageBest = q ? bestChunkScores(q, 'document') : new Map<string, number>()
  const scored: ScoredItem<DocItem>[] = items.map((d) => {
    const rec = vectors.get(d.docId)
    const passage = passageBest.get(d.docId)
    return {
      item: d,
      keyword: keywordScore(d, query),
      // Model-tag guard: a stored vector is only comparable to a query vector
      // from the SAME embedding model (384-dim local and 1536-dim OpenAI never
      // mix, and two different same-dim models would score garbage silently).
      // Mismatches fall back to keyword-only for that item until reindexed.
      semantic:
        passage !== undefined
          ? passage
          : q && rec && rec.model === q.model && rec.vector.length === q.vector.length
            ? cosineSim(q.vector, rec.vector)
            : null
    }
  })
  // The #5 gate runs BEFORE the blend: relative band + keyword corroboration
  // (see gateSemantic) — an uncorroborated cosine field admits nothing, so
  // enabling embeddings can no longer inject six unrelated documents. Index
  // coverage of this set goes to the blend so a partly-indexed corpus does not
  // lock its un-indexed remainder out (see BlendOpts.coverage).
  return blendSemantic(gateSemantic(scored), { limit, coverage: semanticShare(scored) }).map((d, i) => ({
    docId: d.docId,
    title: d.title || 'Untitled',
    docType: d.docType,
    snippet: snippetFor(d.text, query),
    // The best-matching passage(s), not the head (M1 defect #2): tasks and
    // notes already got passage extraction via rankSources; documents — the
    // richest content — were shipped as their opening 6000 chars, so a match
    // deep in a long document quoted the cover page.
    text: selectPassages(query, d.text),
    // Descending by blended rank so the strongest source leads the grounding.
    score: 1 - i * 0.01,
    // Carry AI-enriched metadata through so the grounding header can frame this
    // source (category, dates, entities, summary) before its body. Absent for
    // un-enriched docs — the header simply omits those lines.
    summary: d.meta?.summary || undefined,
    category: d.meta?.category || undefined,
    dates: d.meta?.dates,
    entities: d.meta?.entities
  }))
}

// True when there is at least one stored document vector, i.e. semantic document
// search is actually active (a key is configured and documents are indexed).
export function documentSemanticActive(): boolean {
  return listEmbeddings(KIND).size > 0
}
