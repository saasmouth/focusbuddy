import { describe, it, expect } from 'vitest'
import {
  estimateCostMicros,
  cacheCostMicros,
  cacheReadMultiplier,
  rateFor,
  CACHE_WRITE_5M,
  CACHE_WRITE_1H,
  DEFAULT_RATE
} from '../../src/main/ai/aiCost'

// Anthropic's published list prices, USD per million tokens, transcribed from
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-09-15.
//
// This is the whole point of the file: the app's rate table drifted a full
// model generation out of date once (billing Opus at Opus 4.1's $15/$75), and
// nothing caught it because nothing compared it to the published prices. This
// table is that comparison. When Anthropic changes a price, this test fails and
// names the model — which is the intended way to find out.
const OFFICIAL: Record<string, { in: number; out: number }> = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 }
}

describe('rateFor matches published pricing', () => {
  for (const [model, want] of Object.entries(OFFICIAL)) {
    it(`prices ${model} at $${want.in}/$${want.out} per MTok`, () => {
      expect(rateFor(model)).toEqual({ inPerM: want.in, outPerM: want.out })
    })
  }

  // Pricing is not uniform within a family, so matching on the family name
  // alone is a bug waiting to happen: Sonnet 5 is a third cheaper than the
  // Sonnet 4.x it would otherwise be lumped in with.
  it('separates Sonnet 5 from the Sonnet 4.x line', () => {
    expect(rateFor('claude-sonnet-5').inPerM).toBe(2)
    expect(rateFor('claude-sonnet-4-6').inPerM).toBe(3)
  })

  it('falls back to the mid-tier default for an unrecognised model', () => {
    expect(rateFor('some-unknown-model')).toEqual(DEFAULT_RATE)
  })
})

describe('prompt-cache multipliers match published pricing', () => {
  it('uses 1.25x for a 5-minute write and 2x for a 1-hour write', () => {
    expect(CACHE_WRITE_5M).toBe(1.25)
    expect(CACHE_WRITE_1H).toBe(2)
  })

  it('reads at 0.1x of base input on the standard models', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-fable-5']) {
      expect(cacheReadMultiplier(m)).toBe(0.1)
    }
  })

  // Fable 5.1 and Mythos 5.1 are the exception in the published table; charging
  // them the standard 0.1x would overstate their cache reads fourfold.
  it('reads at 0.025x on Fable 5.1 and Mythos 5.1', () => {
    expect(cacheReadMultiplier('claude-fable-5-1')).toBe(0.025)
    expect(cacheReadMultiplier('claude-mythos-5-1')).toBe(0.025)
  })

  it('prices cache traffic off the base input rate', () => {
    // Sonnet 4.6: 1M reads at $3 × 0.1 = $0.30; 1M 5m writes at $3 × 1.25 = $3.75
    expect(cacheCostMicros('claude-sonnet-4-6', 1_000_000, 0)).toBe(300_000)
    expect(cacheCostMicros('claude-sonnet-4-6', 0, 1_000_000)).toBe(3_750_000)
    expect(cacheCostMicros('claude-sonnet-4-6', 0, 0)).toBe(0)
  })

  it('clamps negative token counts', () => {
    expect(cacheCostMicros('claude-sonnet-4-6', -5, -5)).toBe(0)
  })
})

describe('estimateCostMicros', () => {
  it('computes cost from real token counts (opus 5: 1M in + 1M out = $30)', () => {
    expect(estimateCostMicros('claude-opus-4-8', 1_000_000, 1_000_000)).toBe(30_000_000)
  })

  it('scales linearly for partial tokens (sonnet 4.6: 10k in, 2k out)', () => {
    expect(estimateCostMicros('claude-sonnet-4-6', 10_000, 2_000)).toBe(60_000)
  })

  // The run that prompted this audit: ~22 browser-agent rounds on Sonnet 4.6,
  // which the app reported as $1.36. Reproducing that from the rate table is
  // what confirmed the figure was real rather than a display bug.
  it('reproduces the reported cost of the browse that prompted this audit', () => {
    const micros = estimateCostMicros('claude-sonnet-4-6', 440_000, 7_700)
    expect(micros / 1e6).toBeCloseTo(1.436, 2)
  })

  it('is zero for zero tokens and clamps negatives', () => {
    expect(estimateCostMicros('claude-opus-4-8', 0, 0)).toBe(0)
    expect(estimateCostMicros('claude-opus-4-8', -100, -100)).toBe(0)
  })
})
