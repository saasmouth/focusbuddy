// Embedding COVERAGE: how much of the workspace the semantic route can actually
// reach, as opposed to whether a route merely exists.
//
// embeddingConfigured() answers "is an embedder reachable". Retrieval quality
// depends on a different question. A vector is only written when an item is
// created, edited or swept, and only under whichever embedder was live at the
// time, so a workspace can have a working embedder and still answer like a
// keyword search for most of its content: un-indexed (or model-stale) items are
// capped at their keyword weight in the blend. That reads to the person as an
// assistant that only knows what was touched recently.
//
// Measured against the GATED route (backgroundAiGate.gatedActiveEmbedModel):
// with Background AI tasks off and no local model, nothing is comparable and
// coverage is an honest 0, even if an OpenAI key is saved.

import { gatedActiveEmbedModel } from './backgroundAiGate'
import type { CoverageReport } from './ai/coverageMath'
import { knowledgeCoverage } from './semanticRetrieval'
import { documentCoverage } from './documentRetrieval'
import { chunkEmbeddingCoverage, passageModelsBySource } from './chunkEmbeddings'

export interface WorkspaceCoverage {
  /** PlexiiBrain entries. */
  knowledge: CoverageReport
  /** Documents reachable by meaning — through a passage vector or, failing
   *  that, the whole-document fallback. */
  documents: CoverageReport
  /** Document passages (chunks) individually: the backfill's real backlog. */
  documentChunks: CoverageReport
  /** The embedder the gated route would use; null when none is allowed. */
  model: string | null
  /** Usable share of knowledge + documents together, weighted by pool size. */
  fraction: number
}

/** The whole workspace's coverage, for the active org. */
export async function workspaceCoverage(): Promise<WorkspaceCoverage> {
  const model = await gatedActiveEmbedModel()
  const knowledge = knowledgeCoverage(model)
  const documents = documentCoverage(model, passageModelsBySource('document', model))
  const documentChunks = chunkEmbeddingCoverage('document', model)
  const total = knowledge.total + documents.total
  const usable = knowledge.usable + documents.usable
  return { knowledge, documents, documentChunks, model, fraction: total === 0 ? 1 : usable / total }
}

/**
 * The share of what a chat turn searches that was ranked by meaning, 0..1.
 *
 * `documentsByMeaning` says whether the document pool compared vectors. Until
 * 4.3.42 the chunk-index path (BM25 over passages) compared none, so documents
 * counted as keyword-ranked however many held vectors; it now ranks the same
 * passages by meaning too (passageRetrieval.ts), so documents count through
 * their passage (or whole-document) vectors on both paths.
 */
export function chatMeaningFraction(cov: WorkspaceCoverage, documentsByMeaning: boolean): number {
  const total = cov.knowledge.total + cov.documents.total
  if (total === 0) return 1
  const usable = cov.knowledge.usable + (documentsByMeaning ? cov.documents.usable : 0)
  return usable / total
}

/**
 * What the trace may claim for a turn, from the availability probe and the
 * coverage probe. The coverage probe measures the GATED route (Background AI
 * tasks): with the switch off and no local model, a saved OpenAI key embeds
 * nothing, so the search was keyword matching whatever embeddingConfigured()
 * says. Coverage is only reported when there was a route to cover. A failed
 * coverage probe (null) leaves the availability answer as it was.
 */
export function traceSemantic(
  semanticOn: boolean,
  coverage: { fraction: number; model: string | null } | null
): { semantic: boolean; semanticCoverage: number | null } {
  if (!coverage) return { semantic: semanticOn, semanticCoverage: null }
  const semantic = semanticOn && coverage.model !== null
  return { semantic, semanticCoverage: semantic ? coverage.fraction : null }
}

/** Coverage for one chat turn's retrieval trace. Never throws; null = unknown. */
export async function chatRetrievalCoverage(): Promise<{ fraction: number; model: string | null } | null> {
  try {
    const cov = await workspaceCoverage()
    // Both document paths compare vectors now: the chunk index through
    // passageSearchDocuments, the fallback through semanticSearchDocuments.
    return { fraction: chatMeaningFraction(cov, true), model: cov.model }
  } catch {
    return null
  }
}
