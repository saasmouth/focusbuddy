import { describe, it, expect } from 'vitest'
import { packSources, RETRIEVAL_TOTAL_CHAR_BUDGET, SOURCE_PROMPT_CAP } from '../../src/main/ai/grounding'
import { RETRIEVAL_SOURCE_LIMIT } from '../../src/main/workspaceSearch'

// "Why are the number of files being scrutinised limited?"
//
// Because slots were filled round-robin across SEVEN pools (knowledge, documents,
// tasks/tables/notes, widgets, files, chats, meetings), so the number of ROUNDS
// decided how many documents could be read — not the total. Ten slots is one full
// round plus three stragglers: about two documents, whatever matched.
//
// The fix is more rounds, bounded by a CHARACTER budget rather than a count. A
// count cannot tell twenty short notes from two long contracts, so capping it
// punishes the cheap case to guard against the expensive one.

const POOLS = 7

describe('breadth is measured in rounds, not slots', () => {
  it('gives every pool several rounds', () => {
    // The property that matters: a question spanning a handful of files is
    // grounded in all of them, not in the two that happened to win round one.
    expect(Math.floor(RETRIEVAL_SOURCE_LIMIT / POOLS)).toBeGreaterThanOrEqual(4)
  })

  it('is a clean multiple of the pool count, so no pool is systematically short', () => {
    // A remainder means the pools listed first quietly get an extra slot every
    // single question.
    expect(RETRIEVAL_SOURCE_LIMIT % POOLS).toBe(0)
  })
})

const src = (id: string, len: number) => ({ docId: id, text: 'x'.repeat(len) })

describe('the budget bounds cost, not breadth', () => {
  it('lets many small sources through', () => {
    // Twenty short notes are cheap. A source COUNT would have refused them.
    const many = Array.from({ length: 60 }, (_, i) => src(`n${i}`, 500))
    const { kept, dropped } = packSources(many)
    expect(kept).toHaveLength(60)
    expect(dropped).toBe(0)
  })

  it('stops before blowing the prompt on many large sources', () => {
    const big = Array.from({ length: 60 }, (_, i) => src(`d${i}`, SOURCE_PROMPT_CAP))
    const { kept, dropped } = packSources(big)
    expect(kept.length).toBeLessThan(60)
    expect(dropped).toBeGreaterThan(0)
    const used = kept.reduce((n, s) => n + Math.min(s.text.length, SOURCE_PROMPT_CAP), 0)
    expect(used).toBeLessThanOrEqual(RETRIEVAL_TOTAL_CHAR_BUDGET)
  })

  it('charges a source at most the per-source cap, since that is all that is sent', () => {
    // A 400k-character document contributes 6k to the prompt, so it must be
    // budgeted at 6k — charging its full length would crowd out everything else
    // to protect against text that was never going to be included.
    const { kept } = packSources([src('huge', 400_000), src('a', 100), src('b', 100)])
    expect(kept.map((k) => k.docId)).toEqual(['huge', 'a', 'b'])
  })

  it('keeps at least one source even when it alone exceeds the budget', () => {
    // One over-budget source is still better grounding than none.
    const { kept } = packSources([src('only', 10_000)], 100)
    expect(kept).toHaveLength(1)
  })

  it('keeps the ranked order, so the best match is never the one dropped', () => {
    const ranked = [src('best', 100), src('mid', 100), src('worst', 100)]
    expect(packSources(ranked, 250).kept.map((k) => k.docId)).toEqual(['best', 'mid'])
  })

  it('reports how many it left out, so an answer can admit it may be partial', () => {
    const many = Array.from({ length: 10 }, (_, i) => src(`d${i}`, 1000))
    const { kept, dropped } = packSources(many, 3000)
    expect(kept).toHaveLength(3)
    expect(dropped).toBe(7)
  })

  it('handles an empty set without pretending it packed something', () => {
    expect(packSources([])).toEqual({ kept: [], dropped: 0 })
  })
})

describe('the budget is generous enough to be worth having', () => {
  it('fits every slot at a realistic source size', () => {
    // If the budget could not hold RETRIEVAL_SOURCE_LIMIT ordinary sources, the
    // slot count would be decorative and the real cap would be hidden here.
    const realistic = 1500
    expect(RETRIEVAL_SOURCE_LIMIT * realistic).toBeLessThan(RETRIEVAL_TOTAL_CHAR_BUDGET)
  })
})
