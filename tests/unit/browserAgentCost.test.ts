import { describe, it, expect } from 'vitest'
import {
  capElements,
  transcript,
  ELEMENT_BUDGET,
  VERBATIM_ROUNDS,
  type Turn
} from '../../src/main/ai/browserAgent'
import type { PageElement } from '../../src/main/ai/browserActions'

const el = (i: number, over: Partial<PageElement> = {}): PageElement =>
  ({ idx: i, tag: 'a', label: `link ${i}`, ...over }) as PageElement

const turn = (i: number, size = 4000): Turn => ({
  observation: `ROUND ${i} OBSERVATION ${'x'.repeat(size)}`,
  digest: `ROUND ${i} at https://example.test — did a thing`,
  reply: `{"narration":"round ${i}","status":"working"}`
})

describe('capElements', () => {
  it('passes a modest page through untouched', () => {
    const els = Array.from({ length: 10 }, (_, i) => el(i))
    const { kept, dropped } = capElements(els)
    expect(kept).toHaveLength(10)
    expect(dropped).toBe(0)
  })

  // An uncapped element list was the single largest line item in a run's bill:
  // a directory page yields hundreds, and every one was re-sent every round.
  it('caps a huge page and reports how many it dropped', () => {
    const els = Array.from({ length: 500 }, (_, i) => el(i))
    const { kept, dropped } = capElements(els)
    expect(kept).toHaveLength(ELEMENT_BUDGET)
    expect(dropped).toBe(500 - ELEMENT_BUDGET)
  })

  it('keeps DOM order so indices still read down the page', () => {
    const els = Array.from({ length: 300 }, (_, i) => el(i))
    const idxs = capElements(els).kept.map((e) => e.idx)
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs)
  })

  it('prefers form controls and labelled elements over unlabelled filler', () => {
    const filler = Array.from({ length: 300 }, (_, i) => el(i + 100, { tag: 'div', label: '' }))
    const search = el(1, { tag: 'input', label: 'Search' })
    const kept = capElements([...filler, search]).kept
    expect(kept.map((e) => e.idx)).toContain(1)
  })

  it('does not promote a disabled control over a usable one', () => {
    const filler = Array.from({ length: 300 }, (_, i) => el(i + 100, { tag: 'div', label: '' }))
    const dead = el(1, { tag: 'input', label: 'Search', disabled: true })
    const live = el(2, { tag: 'a', label: 'Next page' })
    const kept = capElements([...filler, dead, live]).kept.map((e) => e.idx)
    expect(kept).toContain(2)
  })
})

describe('transcript', () => {
  it('keeps one message per past round plus the current observation', () => {
    const turns = [turn(1), turn(2)]
    const { messages } = transcript(turns, 'CURRENT')
    expect(messages).toHaveLength(5) // 2 turns × (user + assistant) + current
    expect(messages[messages.length - 1].content).toBe('CURRENT')
  })

  // Only the page in front of the model is charged at full price; everything
  // it already mined is a digest, because the facts live in the findings.
  it('keeps exactly one full observation in the request — the current one', () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1))
    const { messages } = transcript(turns, 'CURRENT OBSERVATION')
    const verbatim = messages.filter((m) => String(m.content).includes('OBSERVATION'))
    expect(verbatim).toHaveLength(1)
  })

  // The bug that made a 22-round run cost $1.36: round N re-sent every earlier
  // observation in full, so cost grew with the SQUARE of the run length.
  it('collapses observations older than the verbatim window to their digest', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1))
    const { messages } = transcript(turns, 'CURRENT')
    const userMsgs = messages.filter((m) => m.role === 'user')
    const verbatim = userMsgs.filter((m) => String(m.content).includes('OBSERVATION'))
    expect(verbatim.length).toBeLessThanOrEqual(VERBATIM_ROUNDS + 1)
    expect(String(messages[0].content)).toBe(turns[0].digest)
  })

  // The cost bug in one assertion: each extra round used to add a whole
  // observation to every subsequent request (quadratic). Now it adds a digest.
  it('grows by a digest per round, not by an observation', () => {
    const OBS = 4000
    const size = (n: number): number =>
      JSON.stringify(
        transcript(Array.from({ length: n }, (_, i) => turn(i + 1, OBS)), 'CURRENT').messages
      ).length
    const perRound = (size(22) - size(12)) / 10
    expect(perRound).toBeLessThan(OBS / 10)
  })

  it('stays far below what re-sending every observation would cost', () => {
    const OBS = 4000
    const turns = Array.from({ length: 22 }, (_, i) => turn(i + 1, OBS))
    const actual = JSON.stringify(transcript(turns, 'CURRENT').messages).length
    // What the old append-everything transcript would have sent on round 22.
    expect(actual).toBeLessThan(22 * OBS * 0.1)
  })

  it('marks a cache breakpoint inside the stable prefix, never in the sliding window', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1))
    const { messages, cacheAt } = transcript(turns, 'CURRENT')
    expect(cacheAt).toBeGreaterThanOrEqual(0)
    expect(cacheAt).toBeLessThan(messages.length)
    // Everything up to the breakpoint must be frozen content (digests and
    // replies), or the cache would miss every round.
    for (let i = 0; i <= cacheAt; i++) {
      expect(String(messages[i].content)).not.toContain('OBSERVATION')
    }
  })

  it('marks nothing while there is no stable prefix yet', () => {
    expect(transcript([], 'CURRENT').cacheAt).toBeLessThan(0)
    expect(transcript([turn(1)], 'CURRENT').cacheAt).toBeLessThan(0)
  })

  // The prefix must be byte-identical between rounds or the cache never hits.
  it('produces an identical cached prefix from one round to the next', () => {
    const base = Array.from({ length: 8 }, (_, i) => turn(i + 1))
    const a = transcript(base, 'OBS-A')
    const b = transcript([...base, turn(9)], 'OBS-B')
    const prefixOf = (r: ReturnType<typeof transcript>): string[] =>
      r.messages.slice(0, r.cacheAt + 1).map((m) => JSON.stringify(m))
    const pa = prefixOf(a)
    const pb = prefixOf(b)
    // B's cached prefix must EXTEND A's message-for-message: a single changed
    // message anywhere in it invalidates the cache for the whole round.
    expect(pb.length).toBeGreaterThanOrEqual(pa.length)
    expect(pb.slice(0, pa.length)).toEqual(pa)
  })
})
