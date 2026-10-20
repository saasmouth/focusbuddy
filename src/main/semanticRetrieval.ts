// The semantic-retrieval service: it ties the embedder, the vector store and the
// pure blend math together for PlexiBrain knowledge (and, later, documents). With
// an embedding key configured, knowledge search and AI grounding rank by meaning;
// without one, everything falls back to keyword search and nothing is faked.

import { listKnowledge } from './db/knowledge'
import type { KnowledgeEntry } from '@shared/knowledge'
// Through the Background AI tasks gate: content goes to a cloud embedder only
// while the person allows it (backgroundAiGate.ts).
import { gatedEmbedTexts as embedTexts, gatedEmbedQueryTagged as embedQueryTagged } from './backgroundAiGate'
import { setEmbedding, listEmbeddings, listEmbeddingsTagged, hasEmbedding } from './db/embeddings'
import { cosineSim, blendSemantic, gateSemantic, type ScoredItem } from '@shared/semantic'

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
export async function reindexKnowledge(force = false): Promise<{ embedded: number; reason?: string }> {
  const entries = listKnowledge()
  const todo = force ? entries : entries.filter((e) => !hasEmbedding(KIND, e.id))
  if (todo.length === 0) return { embedded: 0 }
  const r = await embedTexts(todo.map(knowledgeText))
  if (!r.ok) return { embedded: 0, reason: r.reason }
  todo.forEach((e, i) => {
    if (r.vectors[i]) setEmbedding(KIND, e.id, r.vectors[i], r.model)
  })
  return { embedded: todo.length }
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
  return blendSemantic(gateSemantic(scored), { limit })
}

// True when there is at least one stored knowledge vector, i.e. semantic search
// is actually active (a key is configured and entries have been indexed).
export function knowledgeSemanticActive(): boolean {
  return listEmbeddings(KIND).size > 0
}
