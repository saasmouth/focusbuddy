// Passage-level embeddings: rank a document on its best passage, not on one
// vector for the whole thing.
//
// Document retrieval embedded ONE vector per document, capped at 8000 chars. A
// long document's single vector is a blurred centroid of everything it says, so
// a short specific question cannot match it. Measured on a real corpus (29
// questions taken from content deep inside a document, asking which document
// comes back first): whole-document vectors recall@1 19/29, mean rank 5.55;
// passage vectors recall@1 23/29, mean rank 2.28.
//
// The passages already exist: chunkIndex.ts splits every document, widget, file
// and chat into ~1200-char chunks for FTS. This module gives those chunks
// vectors, keyed by chunk id under `chunk:<sourceType>`, and rolls the best
// passage score up to its source.
//
// Every embedding goes through the Background AI tasks gate
// (backgroundAiGate.ts): with the switch off, only a local model is asked, and
// with no local model nothing is embedded and the reason is returned.

import { getDb } from './db/database'
import { getActiveOrgId } from './db/activeOrg'
import { setEmbedding, listEmbeddingsTagged, listEmbeddingModels, deleteEmbedding } from './db/embeddings'
import { gatedEmbedTexts, gatedActiveEmbedModel, EMBED_BATCH } from './backgroundAiGate'
import { cosineSim } from '@shared/semantic'
import { coverageFor, needsEmbedding, type CoverageReport } from './ai/coverageMath'

/** Vectors are stored per chunk, namespaced by the chunk's source type. */
export function chunkKind(sourceType: string): string {
  return `chunk:${sourceType}`
}

interface ChunkRow {
  id: string
  sourceId: string
  title: string
  text: string
}

function listChunkRows(sourceType: string): ChunkRow[] {
  const rows = getDb()
    .prepare(
      'SELECT id, source_id, title, text FROM fb_chunks WHERE source_type = ? AND org_id = ? ORDER BY source_id, chunk_index'
    )
    .all(sourceType, getActiveOrgId()) as { id: string; source_id: string; title: string; text: string }[]
  return rows.map((r) => ({ id: r.id, sourceId: r.source_id, title: r.title, text: r.text }))
}

/** Chunk id -> source id, without reading any passage text. */
function listChunkSources(sourceType: string): { id: string; sourceId: string }[] {
  const rows = getDb()
    .prepare('SELECT id, source_id FROM fb_chunks WHERE source_type = ? AND org_id = ? ORDER BY source_id, chunk_index')
    .all(sourceType, getActiveOrgId()) as { id: string; source_id: string }[]
  return rows.map((r) => ({ id: r.id, sourceId: r.source_id }))
}

/**
 * What we embed for a chunk: its source's title leads the passage, so a passage
 * that never names its own subject ("the rate is 12%") still carries it.
 */
function chunkEmbedText(c: ChunkRow): string {
  return `${c.title}\n${c.text}`.trim()
}

/**
 * Give every chunk of `sourceType` a vector under the live (gated) embedder.
 *
 * Incremental and stale-aware on the same rules as the document and knowledge
 * reindexers: a vector written by a different model is unusable at query time
 * and counts as missing. Batched, because localEmbed sends a whole array in one
 * request on a 60 s timeout; progress persists per batch.
 */
export async function reindexChunkEmbeddings(
  sourceType = 'document',
  force = false
): Promise<{ embedded: number; pruned: number; reason?: string }> {
  const kind = chunkKind(sourceType)
  const chunks = listChunkRows(sourceType)
  const tagged = listEmbeddingModels(kind)

  // Chunks are rewritten whenever their source changes (new ids), so vectors for
  // chunk ids that no longer exist would accumulate forever. Drop them. This
  // needs no model and runs even when embedding is not allowed.
  const live = new Set(chunks.map((c) => c.id))
  let pruned = 0
  for (const id of tagged.keys()) {
    if (!live.has(id)) {
      deleteEmbedding(kind, id)
      pruned++
    }
  }

  let todo = chunks
  if (!force) {
    const active = await gatedActiveEmbedModel()
    todo = chunks.filter((c) => needsEmbedding(tagged.get(c.id), active))
  }
  let embedded = 0
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH)
    const r = await gatedEmbedTexts(batch.map(chunkEmbedText))
    // Stop on failure, keep the batches already written, and say why.
    if (!r.ok) return { embedded, pruned, reason: r.reason }
    batch.forEach((c, j) => {
      if (r.vectors[j]) {
        setEmbedding(kind, c.id, r.vectors[j], r.model)
        embedded++
      }
    })
  }
  return { embedded, pruned }
}

/**
 * Per source, the model tag of its passage vectors as the query side sees them:
 * a comparable tag when ANY of the source's chunks is embedded under the live
 * model, otherwise some stale tag, and absent when no chunk has a vector. For
 * coverage — reads no vectors.
 */
export function passageModelsBySource(
  sourceType: string,
  activeModel: string | null
): Map<string, { model: string }> {
  const tagged = listEmbeddingModels(chunkKind(sourceType))
  const out = new Map<string, { model: string }>()
  for (const c of listChunkSources(sourceType)) {
    const rec = tagged.get(c.id)
    if (!rec) continue
    const prev = out.get(c.sourceId)
    if (!prev || (activeModel !== null && rec.model === activeModel)) out.set(c.sourceId, rec)
  }
  return out
}

/** Coverage of a chunk pool (per passage) against the live embedder. */
export function chunkEmbeddingCoverage(sourceType: string, activeModel: string | null): CoverageReport {
  return coverageFor(
    listChunkSources(sourceType).map((c) => c.id),
    listEmbeddingModels(chunkKind(sourceType)),
    activeModel
  )
}

/**
 * Best passage similarity per source: sourceId -> highest cosine among that
 * source's chunks, for a query vector the caller already has (one embedding per
 * search, shared with the whole-document scorer). Sources with no comparable
 * chunk vector are simply absent, so the caller falls back to whatever it used
 * before rather than scoring them zero — absence of a vector is not evidence of
 * irrelevance.
 */
export function bestChunkScores(
  query: { vector: number[]; model: string } | null,
  sourceType = 'document'
): Map<string, number> {
  const out = new Map<string, number>()
  if (!query) return out
  const tagged = listEmbeddingsTagged(chunkKind(sourceType))
  if (tagged.size === 0) return out
  for (const c of listChunkSources(sourceType)) {
    const rec = tagged.get(c.id)
    // Same model-tag guard the document scorer uses: vectors from different
    // embedders are not comparable and score garbage if mixed.
    if (!rec || rec.model !== query.model || rec.vector.length !== query.vector.length) continue
    const s = cosineSim(query.vector, rec.vector)
    const prev = out.get(c.sourceId)
    if (prev === undefined || s > prev) out.set(c.sourceId, s)
  }
  return out
}
