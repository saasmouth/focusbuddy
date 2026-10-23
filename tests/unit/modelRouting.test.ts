import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MODEL_HAIKU,
  MODEL_SONNET,
  MODEL_OPUS,
  resolveModel,
  setModelMode
} from '../../src/main/ai/modelRouting'
import { rateFor } from '../../src/main/ai/aiCost'

describe('model tier ids', () => {
  // The app ran a full generation behind on two tiers without anyone noticing,
  // because the ids were scattered across eight files and nothing compared them
  // to what was current. These assertions are the reminder.
  it('names the current generation for each tier', () => {
    // 2026-10-16: moved to the 5.5 generation (was claude-haiku-4-5-20251001,
    // claude-sonnet-5, claude-opus-5).
    expect(MODEL_HAIKU).toBe('claude-haiku-5-5')
    expect(MODEL_SONNET).toBe('claude-sonnet-5-5')
    expect(MODEL_OPUS).toBe('claude-opus-5-5')
  })

  it('every tier id prices against the rate table rather than the default', () => {
    expect(rateFor(MODEL_HAIKU)).toEqual({ inPerM: 0.1, outPerM: 0.5 })
    expect(rateFor(MODEL_SONNET)).toEqual({ inPerM: 2, outPerM: 10 })
    expect(rateFor(MODEL_OPUS)).toEqual({ inPerM: 4, outPerM: 20 })
  })

  // The point of the tiers: each is strictly cheaper than the one above it.
  it('keeps the tiers ordered by price', () => {
    const cost = (m: string): number => rateFor(m).inPerM
    expect(cost(MODEL_HAIKU)).toBeLessThan(cost(MODEL_SONNET))
    expect(cost(MODEL_SONNET)).toBeLessThan(cost(MODEL_OPUS))
  })
})

// Anthropic's minimum cacheable prefix, from
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching —
// checked 2026-09-15. It is NOT monotonic across generations, which is the trap:
// Haiku 4.5 needs 4096 tokens while the newer Opus 5 needs only 512. A prefix
// under the minimum caches silently — no error, just no saving — so a cost
// estimate that assumes caching works can be wrong with nothing to show for it.
// Imported from production rather than redeclared here: a copy in the test
// would go on passing after the real table drifted, which is the opposite of
// what this file is for. The assertions below are literals, so they still pin
// the values rather than merely agreeing with whatever the source says.
export { CACHE_MINIMUM } from '../../src/main/ai/cacheControl'
import { CACHE_MINIMUM } from '../../src/main/ai/cacheControl'

describe('prompt-cache minimums', () => {
  // Rewritten 2026-10-16. Under Haiku 4.5 (4096) / Sonnet 5 (1024) / Opus 5
  // (512) this pinned the non-monotonic trap: the cheap tier needed the LONGEST
  // prefix. Every 5.5 model caches from 512, so the trap is gone for the routed
  // tiers — but an unknown model still assumes the worst (4096), so an estimate
  // never promises a cache read that may not happen.
  it('records the 5.5 generation minimums, and stays conservative for unknown ids', async () => {
    expect(CACHE_MINIMUM[MODEL_HAIKU]).toBe(512)
    expect(CACHE_MINIMUM[MODEL_SONNET]).toBe(512)
    expect(CACHE_MINIMUM[MODEL_OPUS]).toBe(512)
    const { cacheMinimumFor } = await import('../../src/main/ai/cacheControl')
    expect(cacheMinimumFor('claude-haiku-4-5-20251001')).toBe(4096)
  })

  it("knows the browse loop's system prompt now reaches Haiku's minimum", async () => {
    const { buildBrowserAgentSystemPrompt } = await import('../../src/main/ai/browserAgentEnvelope')
    // ~3.6 chars/token is the rough English ratio; the point is the order of
    // magnitude, not a precise count. Under Haiku 4.5 this asserted the prompt
    // could NOT cache (below 4096); on Haiku 5.5 the marker starts working.
    const approxTokens = buildBrowserAgentSystemPrompt().length / 3.6
    expect(approxTokens).toBeGreaterThanOrEqual(CACHE_MINIMUM[MODEL_HAIKU])
  })
})

describe('resolveModel', () => {
  it('routes the long agentic loops to the cheap tier, where per-round rate compounds', () => {
    setModelMode('auto')
    expect(resolveModel('browser_agent')).toBe(MODEL_HAIKU)
  })

  it('keeps quality-sensitive one-shot work on the higher tiers', () => {
    setModelMode('auto')
    expect(resolveModel('chat')).toBe(MODEL_SONNET)
    expect(resolveModel('custom_widget')).toBe(MODEL_OPUS)
  })

  it('honours the global override in both directions', () => {
    setModelMode('haiku')
    expect(resolveModel('custom_widget')).toBe(MODEL_HAIKU)
    setModelMode('opus')
    expect(resolveModel('browser_agent')).toBe(MODEL_OPUS)
    setModelMode('auto')
  })
})

// A hardcoded id elsewhere escapes BOTH the routing table and the user's
// model-mode override, which is how three call sites ended up pinned to a
// previous generation while the router moved on. This fails the build instead.
describe('no model id escapes the router', () => {
  const ROOTS = ['src/main', 'src/renderer', 'src/preload', 'src/shared', 'src/web']
  const ALLOWED = ['src/main/ai/modelRouting.ts', 'src/main/ai/aiCost.ts']

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(p)) out.push(p)
    }
    return out
  }

  it('declares every Anthropic model id in modelRouting (or names why not)', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (ALLOWED.some((a) => file.endsWith(a.replace('src/', 'src/')))) continue
        const src = readFileSync(file, 'utf8')
        for (const line of src.split('\n')) {
          const m = line.match(/['"]claude-(?:opus|sonnet|haiku|fable|mythos)[a-z0-9.-]*['"]/i)
          // src/web cannot import from src/main; it names its ping model in a
          // single documented constant instead.
          if (m && !line.includes('PING_MODEL')) offenders.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('managed-AI models per plan (growth spec section 1)', () => {
  it('runs Free on Haiku only', async () => {
    const { modelForPlan } = await import('../../src/main/ai/modelRouting')
    expect(modelForPlan(MODEL_SONNET, 'free')).toBe(MODEL_HAIKU)
    expect(modelForPlan(MODEL_OPUS, 'free')).toBe(MODEL_HAIKU)
    expect(modelForPlan(MODEL_HAIKU, 'free')).toBe(MODEL_HAIKU)
  })
  it('caps Pro and Team at Sonnet; Pro+ and Enterprise run Opus', async () => {
    const { modelForPlan } = await import('../../src/main/ai/modelRouting')
    expect(modelForPlan(MODEL_OPUS, 'pro')).toBe(MODEL_SONNET)
    expect(modelForPlan(MODEL_OPUS, 'team')).toBe(MODEL_SONNET)
    expect(modelForPlan(MODEL_SONNET, 'pro')).toBe(MODEL_SONNET)
    expect(modelForPlan(MODEL_OPUS, 'proplus')).toBe(MODEL_OPUS)
    expect(modelForPlan(MODEL_OPUS, 'enterprise')).toBe(MODEL_OPUS)
  })
  it('never upgrades a request and passes unknown ids through', async () => {
    const { modelForPlan } = await import('../../src/main/ai/modelRouting')
    expect(modelForPlan(MODEL_HAIKU, 'proplus')).toBe(MODEL_HAIKU)
    expect(modelForPlan('some-other-model', 'free')).toBe('some-other-model')
  })
})

describe('withModelDefaults', () => {
  it('turns thinking off for Haiku 5.5 unless the call set it', async () => {
    const { withModelDefaults } = await import('../../src/main/ai/modelRouting')
    expect(withModelDefaults({ model: MODEL_HAIKU })).toEqual({ model: MODEL_HAIKU, thinking: { type: 'disabled' } })
    const own = { model: MODEL_HAIKU, thinking: { type: 'adaptive' } }
    expect(withModelDefaults(own)).toBe(own)
  })
  it('leaves Sonnet, Opus and older Haiku alone', async () => {
    const { withModelDefaults } = await import('../../src/main/ai/modelRouting')
    for (const model of [MODEL_SONNET, MODEL_OPUS, 'claude-haiku-4-5-20251001']) {
      const b = { model }
      expect(withModelDefaults(b)).toBe(b)
    }
  })
})
