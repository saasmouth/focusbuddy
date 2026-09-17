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
    expect(MODEL_HAIKU).toBe('claude-haiku-4-5-20251001')
    expect(MODEL_SONNET).toBe('claude-sonnet-5')
    expect(MODEL_OPUS).toBe('claude-opus-5')
  })

  it('every tier id prices against the rate table rather than the default', () => {
    expect(rateFor(MODEL_HAIKU)).toEqual({ inPerM: 1, outPerM: 5 })
    expect(rateFor(MODEL_SONNET)).toEqual({ inPerM: 2, outPerM: 10 })
    expect(rateFor(MODEL_OPUS)).toEqual({ inPerM: 5, outPerM: 25 })
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
  it('records that Haiku needs a far larger prefix than the newer models', () => {
    expect(CACHE_MINIMUM[MODEL_HAIKU]).toBe(4096)
    expect(CACHE_MINIMUM[MODEL_SONNET]).toBe(1024)
    expect(CACHE_MINIMUM[MODEL_OPUS]).toBe(512)
    // The non-monotonic bit, stated so it cannot be reasoned away later.
    expect(CACHE_MINIMUM[MODEL_HAIKU]).toBeGreaterThan(CACHE_MINIMUM[MODEL_OPUS])
  })

  it("knows the browse loop's system prompt does not reach Haiku's minimum", async () => {
    const { buildBrowserAgentSystemPrompt } = await import('../../src/main/ai/browserAgentEnvelope')
    // ~3.6 chars/token is the rough English ratio; the point is the order of
    // magnitude, not a precise count.
    const approxTokens = buildBrowserAgentSystemPrompt().length / 3.6
    expect(approxTokens).toBeLessThan(CACHE_MINIMUM[MODEL_HAIKU])
    // If the prompt ever grows past 4096 tokens, caching starts working on the
    // default browse model and this test should be revisited, not deleted.
  })
})

describe('resolveModel', () => {
  it('routes the long agentic loops to the cheap tier, where per-round rate compounds', () => {
    setModelMode('auto')
    expect(resolveModel('browser_agent')).toBe(MODEL_HAIKU)
    expect(resolveModel('command_route')).toBe(MODEL_HAIKU)
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
