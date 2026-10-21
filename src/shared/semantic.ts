// Pure semantic-retrieval math, shared by the main-process retrieval service and
// its unit tests. No embeddings model and no DB here, just the vector similarity
// and the keyword/semantic blend, so the ranking is testable in isolation.
//
// The foundation: items carry a stored embedding (a vector). A query is embedded
// to a vector, each item's cosine similarity to the query is its semantic score,
// and that is blended with the existing keyword score so results are strong when
// either signal is strong. Items without a stored vector fall back to keyword
// alone, so a half-indexed corpus still ranks sensibly. Nothing is invented: an
// item with no signal scores zero and drops out.

export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface ScoredItem<T> {
  item: T
  // Raw keyword relevance (any non-negative scale; normalised internally).
  keyword: number
  // Cosine similarity to the query in [-1, 1], or null when the item has no
  // stored vector (then keyword carries it).
  semantic: number | null
}

export interface GateOpts {
  // How far below the pool's best semantic score the admission band reaches.
  relFrac?: number
  // Hard cap on how many items may keep a semantic score per pool.
  maxKeep?: number
  // An UNCORROBORATED item (no keyword overlap) must sit this close to the
  // best corroborated item to ride along as a probable paraphrase.
  paraphraseFrac?: number
}

// The #5 gate (fix before any embeddings enable — the standing law since the
// 2026-08-21 audit). The defect: blendSemantic's absolute floor filters
// nothing once a query vector exists — any two English texts score ≈0.07+,
// so six irrelevant documents get injected and cited. The 2026-08-22
// measurement on the real corpus proved an absolute threshold can NEVER
// work: random cross-doc pairs score median 0.361 / p99 0.629 / max 0.797
// while adjacent same-doc chunks score median 0.680 — noise and signal
// distributions overlap. So admission is relative and corroborated instead:
//
// 1. Only items within relFrac of the pool's best semantic score are
//    considered at all (a relative-rank band, never an absolute floor).
// 2. The band needs an ANCHOR: its best item that ALSO has keyword overlap.
//    No anchor means the query has no independent evidence in this pool, and
//    a high cosine alone is indistinguishable from noise — nothing is
//    admitted on semantics (keyword pools still run; nothing is lost).
// 3. With an anchor: corroborated band items keep their semantic score, and
//    uncorroborated ones ride along only within paraphraseFrac of the
//    anchor (a paraphrase sits near a proven match; noise rarely does).
//
// Items that fail keep their keyword standing — semantic is set to null, the
// item is not removed — so composing gateSemantic → blendSemantic demotes
// noise to its (usually zero) keyword score and the blend's floor finally
// has teeth. Pure and deterministic; runs per pool, per route.
export function gateSemantic<T>(scored: ScoredItem<T>[], opts: GateOpts = {}): ScoredItem<T>[] {
  const relFrac = opts.relFrac ?? 0.85
  const maxKeep = opts.maxKeep ?? 6
  const paraphraseFrac = opts.paraphraseFrac ?? 0.92
  // Non-positive similarity is no signal at all — such scores never survive
  // the gate (the blend would clamp them to zero anyway; nulling is honest).
  const cands = scored.filter((s) => s.semantic !== null && s.semantic > 0)
  const top = cands.length ? Math.max(...cands.map((s) => s.semantic as number)) : 0
  const band = cands
    .filter((s) => (s.semantic as number) >= top * relFrac)
    .sort((a, b) => (b.semantic as number) - (a.semantic as number))
    .slice(0, maxKeep)
  const anchor = band.find((s) => s.keyword > 0) ?? null
  const keep = new Set<ScoredItem<T>>()
  if (anchor) {
    for (const s of band) {
      if (s.keyword > 0) keep.add(s)
      else if ((s.semantic as number) >= (anchor.semantic as number) * paraphraseFrac) keep.add(s)
    }
  }
  return scored.map((s) => (s.semantic === null || keep.has(s) ? s : { ...s, semantic: null }))
}

export interface BlendOpts {
  semWeight?: number
  kwWeight?: number
  threshold?: number
  limit?: number
  /**
   * Fraction of the searched corpus that actually holds a comparable vector,
   * 0..1. Optional: omit it and ranking is exactly as before.
   *
   * Why it exists. A vectorless item can never score above its keyword weight
   * (0.3 by default) while an indexed one reaches 1.0. That is correct when
   * everything is indexed — a real semantic match SHOULD beat a keyword-only
   * one, which is what the blend is for. It is not correct when only part of
   * the corpus is indexed, because coverage tracks whatever was written or
   * edited most recently: the un-indexed remainder is then locked out of the
   * results on an accident of history rather than on meaning, which reads to
   * the user as the assistant only knowing recent things.
   *
   * The fix is recall, not re-weighting: reserve a share of the result slots
   * proportional to the UN-indexed share of the corpus, so a strongly matching
   * un-indexed item is not crowded out. Ranking within each group is untouched,
   * and at full coverage the reserve is zero and this is a no-op.
   */
  coverage?: number
}

/**
 * Index coverage of a scored set: the share holding a vector comparable to the
 * query's (a non-null semantic score). 1 for an empty set — nothing is missed.
 */
export function semanticShare(scored: ReadonlyArray<{ semantic: number | null }>): number {
  return scored.length ? scored.filter((s) => s.semantic !== null).length / scored.length : 1
}

/**
 * How much of the limit is handed to the un-indexed group at a given coverage.
 * Half of the un-indexed share: at 50% coverage a quarter of the slots are
 * reserved. Bounded to half the limit so the indexed group always leads.
 */
export function reserveSlots(limit: number, coverage: number): number {
  if (!Number.isFinite(coverage) || coverage >= 1 || limit <= 0) return 0
  const unindexed = Math.min(1, Math.max(0, 1 - coverage))
  return Math.min(Math.floor(limit / 2), Math.round(limit * unindexed * 0.5))
}

// Blend semantic + keyword into one ranking. Keyword scores are normalised to
// [0,1] against the best keyword match in the set so the two signals are
// comparable; cosine is already in range. Returns the items ranked best-first,
// dropping anything below the threshold. Pure and deterministic.
export function blendSemantic<T>(scored: ScoredItem<T>[], opts: BlendOpts = {}): T[] {
  const sw = opts.semWeight ?? 0.7
  const kw = opts.kwWeight ?? 0.3
  const th = opts.threshold ?? 0.01
  const maxKw = Math.max(1, ...scored.map((s) => s.keyword))
  const ranked = scored
    .map((s) => {
      const kwNorm = s.keyword / maxKw
      // Clamp cosine to [0,1] for blending; negative similarity is no signal.
      const sem = s.semantic === null ? null : Math.max(0, s.semantic)
      // A vectorless item earns only its keyword weight, never a free full score,
      // so it cannot unfairly outrank a genuine semantic match.
      const combined = sem === null ? kw * kwNorm : sw * sem + kw * kwNorm
      return { item: s.item, combined, semantic: sem }
    })
    .filter((s) => s.combined > th)
    .sort((a, b) => b.combined - a.combined)
  const items = ranked.map((s) => s.item)
  if (!opts.limit) return items
  const reserve =
    opts.coverage === undefined ? 0 : reserveSlots(opts.limit, opts.coverage)
  if (reserve === 0) return items.slice(0, opts.limit)

  // Fill most of the limit by pure rank, then give the reserved tail to the
  // best-scoring items that had no vector to compete with — but only if they
  // did not already earn a place. Anything left over falls back to rank order,
  // so a corpus with no un-indexed matches returns exactly the ranked list.
  const head = ranked.slice(0, Math.max(0, opts.limit - reserve))
  const chosen = new Set(head.map((s) => s.item))
  const out = head.map((s) => s.item)
  for (const s of ranked) {
    if (out.length >= opts.limit) break
    if (s.semantic !== null || chosen.has(s.item)) continue
    chosen.add(s.item)
    out.push(s.item)
  }
  for (const s of ranked) {
    if (out.length >= opts.limit) break
    if (chosen.has(s.item)) continue
    chosen.add(s.item)
    out.push(s.item)
  }
  return out
}
