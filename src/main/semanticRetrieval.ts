// The semantic-retrieval service: it ties the embedder, the vector store and the
// pure blend math together for PlexiBrain knowledge (and, later, documents). With
// an embedding key configured, knowledge search and AI grounding rank by meaning;
// without one, everything falls back to keyword search and nothing is faked.

import { listKnowledge } from './db/knowledge'
import type { KnowledgeEntry } from '@shared/knowledge'
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
import { cosineSim, blendSemantic, gateSemantic, semanticShare, type ScoredItem } from '@shared/semantic'

const KIND = 'knowledge'

function knowledgeText(e: KnowledgeEntry): string {
  return `${e.title}\n${e.tags.join(' ')}\n${e.body}`.trim()
}

function keywordScore(text: string, title: string, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const terms = q.split(/\s+/).filter(Boolean)
  const h = text.toLowerCase()
  const t = title.toLowerCase()
  let s = 0
  for (const term of terms) {
    if (t.includes(term)) s += 3
    if (h.includes(term)) s += 1
  }
  return s
}

// Embed one entry and store its vector. Best-effort: no key is a silent no-op so
// saving a knowledge entry never blocks or errors on a missing key.
export async function embedKnowledgeEntry(entry: KnowledgeEntry): Promise<void> {
  const r = await embedTexts([knowledgeText(entry)])
  if (r.ok && r.vectors[0]) setEmbedding(KIND, entry.id, r.vectors[0], r.model)
}

// Backfill embeddings for entries lacking one (or all, when force). Returns the
// count embedded and, if it could not, why (e.g. no_key) so the UI stays honest.
//
// A vector written by a different embedder than the live (gated) route counts
// as missing: it is not comparable to the query vector (the model-tag guard
// below), so until it is re-embedded the entry is keyword-only. Batched like
// reindexDocuments, so a large backlog cannot time out as one request and a
// failure partway through keeps the batches already written.
export async function reindexKnowledge(force = false): Promise<{ embedded: number; reason?: string }> {
  const entries = listKnowledge()
  let todo = entries
  if (!force) {
    const active = await gatedActiveEmbedModel()
    const tagged = listEmbeddingModels(KIND)
    todo = entries.filter((e) => needsEmbedding(tagged.get(e.id), active))
  }
  if (todo.length === 0) return { embedded: 0 }
  let embedded = 0
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH)
    const r = await embedTexts(batch.map(knowledgeText))
    // Stop on failure but KEEP what earlier batches wrote, and say why.
    if (!r.ok) return { embedded, reason: r.reason }
    batch.forEach((e, j) => {
      if (r.vectors[j]) {
        setEmbedding(KIND, e.id, r.vectors[j], r.model)
        embedded++
      }
    })
  }
  return { embedded }
}

/** Coverage of the knowledge pool against a given live embedder. Pure lookup. */
export function knowledgeCoverage(activeModel: string | null): CoverageReport {
  return coverageFor(
    listKnowledge().map((e) => e.id),
    listEmbeddingModels(KIND),
    activeModel
  )
}

// Semantic + keyword blended search over knowledge. queryVec is null when there
// is no embedding key, in which case every entry's semantic score is null and
// the blend degrades to keyword search, the same results the old search gave.
export async function semanticSearchKnowledge(query: string, limit = 20): Promise<KnowledgeEntry[]> {
  const entries = listKnowledge()
  if (!query.trim()) return entries.slice(0, limit)
  const q = await embedQueryTagged(query)
  const vectors = q
    ? listEmbeddingsTagged(KIND)
    : new Map<string, { vector: number[]; model: string }>()
  const scored: ScoredItem<KnowledgeEntry>[] = entries.map((e) => {
    const rec = vectors.get(e.id)
    return {
      item: e,
      keyword: keywordScore(knowledgeText(e), e.title, query),
      // Model-tag guard: only vectors from the SAME embedding model as the
      // query are comparable (the tag is the truth; matching dimensions alone
      // can be a coincidence). Mismatches fall back to keyword-only until
      // reindexed, rather than scoring garbage.
      semantic:
        q && rec && rec.model === q.model && rec.vector.length === q.vector.length
          ? cosineSim(q.vector, rec.vector)
          : null
    }
  })
  // The #5 gate before the blend: an uncorroborated cosine field admits
  // nothing (see gateSemantic), so semantic search can only help, never hurt.
  // Index coverage of THIS set — the share holding a vector comparable to the
  // query's — goes to the blend so a partly-indexed corpus does not lock its
  // un-indexed remainder out of the results (see BlendOpts.coverage).
  return blendSemantic(gateSemantic(scored), { limit, coverage: semanticShare(scored) })
}

// True when there is at least one stored knowledge vector, i.e. semantic search
// is actually active (a key is configured and entries have been indexed).
export function knowledgeSemanticActive(): boolean {
  return listEmbeddings(KIND).size > 0
}
