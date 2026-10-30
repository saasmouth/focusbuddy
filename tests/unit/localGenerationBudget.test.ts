import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  generationBudgetMs,
  startGenerationBudget,
  LOCAL_GENERATION_BUDGET_MS
} from '../../src/main/ai/anthropic'

// A local turn must END (reported 2026-10-30: "Writing… 982s").
//
// Retrieval is bounded now — the same trace showed a pool giving up at
// 15,098ms, which is the budget working. What was still unbounded is the
// generation itself. The on-device engine caps how many TOKENS it writes, and
// nothing caps how LONG it takes to write them: a small model on a nearly
// full context can spend a quarter of an hour, showing a rising counter and
// no words.
//
// The engine already supports exactly what is needed — "an AbortSignal stops
// generation; whatever streamed is kept" — so the budget keeps the partial
// answer rather than throwing it away.

afterEach(() => vi.useRealTimers())

describe('generationBudgetMs', () => {
  it('bounds a local turn', () => {
    expect(generationBudgetMs(true)).toBe(LOCAL_GENERATION_BUDGET_MS)
  })

  it('leaves cloud turns alone', () => {
    // A cloud model writing a long document can legitimately run for a while,
    // and it streams while it does — the user is not staring at nothing.
    expect(generationBudgetMs(false)).toBeNull()
  })

  it('is generous enough for a real on-device answer', () => {
    // Long enough that a genuine slow answer finishes; short enough that
    // nobody watches a counter pass ten minutes.
    expect(LOCAL_GENERATION_BUDGET_MS).toBeGreaterThanOrEqual(120_000)
    expect(LOCAL_GENERATION_BUDGET_MS).toBeLessThanOrEqual(300_000)
  })
})

describe('startGenerationBudget', () => {
  it('aborts once the budget passes', () => {
    vi.useFakeTimers()
    const abort = vi.fn()
    startGenerationBudget(1000, abort)
    expect(abort).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1001)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('does not abort a turn that finished in time', () => {
    vi.useFakeTimers()
    const abort = vi.fn()
    const done = startGenerationBudget(1000, abort)
    done()
    vi.advanceTimersByTime(5000)
    expect(abort).not.toHaveBeenCalled()
  })

  it('is a no-op when there is no budget, and still returns a canceller', () => {
    vi.useFakeTimers()
    const abort = vi.fn()
    const done = startGenerationBudget(null, abort)
    vi.advanceTimersByTime(600_000)
    expect(abort).not.toHaveBeenCalled()
    expect(() => done()).not.toThrow()
  })
})

describe('the budget is actually wired into the chat stream', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const SRC = readFileSync(join(__dirname, '../..', 'src/main/ai/anthropic.ts'), 'utf-8')

  /** The body of sendChatStream, where the budget has to live. */
  const body = (() => {
    const at = SRC.indexOf('export async function sendChatStream(')
    const next = SRC.indexOf('\nexport ', at + 1)
    return SRC.slice(at, next === -1 ? SRC.length : next)
  })()

  it('starts on the stream and is cleared when it ends', () => {
    // A budget nobody starts bounds nothing. Matched on the calls rather
    // than one line's exact spelling — the arguments wrap.
    expect(body).toContain('startGenerationBudget(')
    expect(body).toContain('generationBudgetMs(')
    expect(body).toContain('endGenerationBudget()')
  })

  it('clears it in a finally, so a timer cannot outlive its stream', () => {
    // Clearing only on the happy path leaves a live timer that aborts the
    // NEXT turn instead of this one — a bug that would look random.
    expect(body).toMatch(/\} finally \{[\s\S]{0,300}?endGenerationBudget\(\)/)
  })
})

// ── Pool budgets ────────────────────────────────────────────────────────────
describe('the remote pool waits less than the local ones', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const SRC = readFileSync(join(__dirname, '../..', 'src/main/ai/anthropic.ts'), 'utf-8')

  it('mail has its own, shorter budget', () => {
    // Measured on the owner's workspace: every other pool here is
    // sub-second, and mail is the only one that leaves the machine. A slow
    // mailbox must not set the pace of a question asked on a desk.
    expect(SRC).toMatch(/const MAIL_POOL_BUDGET_MS = 6_000/)
    // The call gained the timings collector; what matters here is that mail
    // is pooled with its OWN budget, not the exact argument list.
    const at = SRC.indexOf("pooled('mail'")
    expect(at).toBeGreaterThan(-1)
    expect(SRC.slice(at, at + 200)).toContain('MAIL_POOL_BUDGET_MS')
  })

  it('and it really is shorter than the general one', () => {
    const general = Number(/const POOL_BUDGET_MS = ([\d_]+)/.exec(SRC)?.[1].replace(/_/g, ''))
    const mail = Number(/const MAIL_POOL_BUDGET_MS = ([\d_]+)/.exec(SRC)?.[1].replace(/_/g, ''))
    expect(mail).toBeLessThan(general)
    // Long enough for the local index plus a quick reach to the server.
    expect(mail).toBeGreaterThanOrEqual(5_000)
  })
})
