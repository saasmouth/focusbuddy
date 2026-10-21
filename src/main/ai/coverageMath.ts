// Coverage MATH — dependency-free so both retrieval pools can score themselves
// without importing the orchestrator that calls them (which would be a cycle).
// See embeddingCoverage.ts for why coverage, not availability, is the number
// that governs retrieval quality.
export interface CoverageReport {
  /** Items in the pool. */
  total: number
  /** Items holding any vector at all. */
  embedded: number
  /** Embedded, but by a DIFFERENT model than the live route — unusable, and
   *  indistinguishable from missing at query time (the model-tag guard). */
  stale: number
  /** Embedded AND comparable to the current query vector. What actually helps. */
  usable: number
  /** usable / total, 1 for an empty pool (nothing is being missed). */
  fraction: number
}

/** Pure: score one pool against the model the live route would use. */
export function coverageFor(
  ids: string[],
  // Only the model tag is read, so a cheap id -> model map serves as well as
  // the full vector store (db/embeddings listEmbeddingModels).
  tagged: ReadonlyMap<string, { model: string }>,
  activeModel: string | null
): CoverageReport {
  let embedded = 0
  let usable = 0
  for (const id of ids) {
    const rec = tagged.get(id)
    if (!rec) continue
    embedded++
    // No configured route means nothing is comparable — honest 0 usable rather
    // than claiming coverage the query side cannot spend.
    if (activeModel !== null && rec.model === activeModel) usable++
  }
  const total = ids.length
  return {
    total,
    embedded,
    stale: embedded - usable,
    usable,
    fraction: total === 0 ? 1 : usable / total
  }
}

/**
 * Whether a reindexer should (re-)embed an item: it has no vector, or its vector
 * was written by a different model than the live route. A stale vector is not
 * comparable to the query (the model-tag guard), so it is dead weight until
 * re-embedded; treating it as present is what let a change of embedder degrade
 * the whole corpus to keyword search with no way back short of a forced reindex.
 * With no live route nothing counts as stale — there is nothing to replace it
 * with, and discarding a vector the person may route back to would be a loss.
 */
export function needsEmbedding(rec: { model: string } | undefined, activeModel: string | null): boolean {
  return !rec || (activeModel !== null && rec.model !== activeModel)
}
