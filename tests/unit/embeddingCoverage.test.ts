// Coverage-aware retrieval: the fix for "the assistant only knows recent things".
//
// A vector is written when an item is created, edited or explicitly reindexed,
// so embedding coverage tracks what was TOUCHED most recently. Un-indexed items
// are capped at their keyword weight in the blend, so on a partly-indexed
// corpus the untouched majority loses to the recently-edited minority — a
// recency prior produced by coverage, not by any recency term.
import { describe, it, expect } from 'vitest'
import { blendSemantic, reserveSlots, type ScoredItem } from '../../src/shared/semantic'
import { coverageFor } from '../../src/main/ai/coverageMath'

const s = (item: string, keyword: number, semantic: number | null): ScoredItem<string> => ({
  item,
  keyword,
  semantic
})

describe('coverageFor', () => {
  const tagged = new Map([
    ['a', { vector: [1], model: 'openai:v1' }],
    ['b', { vector: [1], model: 'openai:v1' }],
    ['c', { vector: [1], model: 'ollama:old' }] // written by a different embedder
  ])

  it('counts a model-stale vector as unusable, because the query cannot compare it', () => {
    const r = coverageFor(['a', 'b', 'c', 'd'], tagged, 'openai:v1')
    expect(r.total).toBe(4)
    expect(r.embedded).toBe(3) // c holds a vector…
    expect(r.usable).toBe(2) // …but not one this query can use
    expect(r.stale).toBe(1)
    expect(r.fraction).toBe(0.5)
  })

  it('reports zero usable when no embedder is configured', () => {
    const r = coverageFor(['a', 'b', 'c'], tagged, null)
    expect(r.embedded).toBe(3)
    expect(r.usable).toBe(0)
    expect(r.fraction).toBe(0)
  })

  it('treats an empty pool as fully covered — nothing is being missed', () => {
    expect(coverageFor([], tagged, 'openai:v1').fraction).toBe(1)
  })
})

describe('reserveSlots', () => {
  it('reserves nothing at full coverage, so ranking is untouched', () => {
    expect(reserveSlots(10, 1)).toBe(0)
  })

  it('reserves more as coverage falls, bounded to half the limit', () => {
    expect(reserveSlots(10, 0.8)).toBe(1)
    expect(reserveSlots(10, 0.4)).toBe(3)
    expect(reserveSlots(10, 0)).toBe(5)
    expect(reserveSlots(4, 0)).toBe(2)
  })
})

describe('blendSemantic with partial coverage', () => {
  // Four indexed items with mediocre semantic scores, six un-indexed ones of
  // which the first is the corpus's strongest keyword match.
  const scored: ScoredItem<string>[] = [
    s('idx1', 0, 0.8),
    s('idx2', 0, 0.7),
    s('idx3', 0, 0.6),
    s('idx4', 0, 0.5),
    s('kwBest', 10, null),
    s('kw2', 8, null),
    s('kw3', 6, null),
    s('kw4', 4, null),
    s('kw5', 2, null),
    s('kw6', 1, null)
  ]

  it('without coverage, a partly-indexed corpus shuts its un-indexed half out', () => {
    // The documented pre-existing behaviour: every indexed item outranks the
    // best keyword match, which can never exceed its 0.3 weight.
    expect(blendSemantic(scored, { limit: 4 })).toEqual(['idx1', 'idx2', 'idx3', 'idx4'])
  })

  it('with coverage, the strongest un-indexed match earns a place', () => {
    const out = blendSemantic(scored, { limit: 4, coverage: 0.4 })
    expect(out).toContain('kwBest')
    // The indexed group still leads: the reserve is a minority of the slots.
    expect(out.slice(0, 3)).toEqual(['idx1', 'idx2', 'idx3'])
    expect(out).toHaveLength(4)
  })

  it('is a no-op at full coverage', () => {
    const full = scored.map((x) => (x.semantic === null ? s(x.item, x.keyword, 0.1) : x))
    expect(blendSemantic(full, { limit: 4, coverage: 1 })).toEqual(
      blendSemantic(full, { limit: 4 })
    )
  })

  it('still ranks a real semantic match above a keyword-only one', () => {
    // The property the blend exists for must survive the reserve.
    const out = blendSemantic([s('kw', 10, null), s('sem', 0, 0.9)], { limit: 2, coverage: 0.5 })
    expect(out[0]).toBe('sem')
  })

  it('never invents results: an all-unindexed corpus ranks exactly as keyword search', () => {
    const kwOnly = scored.filter((x) => x.semantic === null)
    expect(blendSemantic(kwOnly, { limit: 3, coverage: 0 })).toEqual(
      blendSemantic(kwOnly, { limit: 3 })
    )
  })
})
