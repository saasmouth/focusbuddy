import { describe, it, expect } from 'vitest'
import { slowestPoolNote } from '../../src/renderer/src/lib/traceView'

// A slow turn must explain itself (2026-10-30).
//
// This is the safeguard for a process failure, not a code one. Retrieval
// reported ONE number for five parallel pools, so the only report a user
// could make was "it took 15 seconds" — and working out which pool from
// reading the code produced two confident wrong answers in a row. A
// measurement settled it in minutes.
//
// The lesson is not "read more carefully". It is that a total invites a
// guess and a breakdown ends the argument, so the app should carry the
// breakdown and the user should never have to be asked for it.

describe('slowestPoolNote', () => {
  const timings = [
    { name: 'workspace', ms: 210 },
    { name: 'mail', ms: 6000, cappedAt: 6000 },
    { name: 'embedding-probe', ms: 40 }
  ]

  it('names the pool that took the time', () => {
    expect(slowestPoolNote(6100, timings)).toContain('mail')
  })

  it('says a capped pool hit its LIMIT, not that it cost that much', () => {
    // "mail (6000ms)" reads as work done. It was stopped at 6000ms; what it
    // would have cost is unknown, and the note must not imply otherwise.
    const note = slowestPoolNote(6100, timings)
    expect(note).toContain('limit')
    expect(note).not.toMatch(/6000ms/)
  })

  it('reports a genuine cost plainly when nothing was capped', () => {
    const note = slowestPoolNote(4000, [
      { name: 'workspace', ms: 3800 },
      { name: 'mail', ms: 120 }
    ])
    expect(note).toContain('workspace')
    expect(note).toContain('3800ms')
  })

  it('stays quiet on a fast turn — a breakdown nobody needs is noise', () => {
    expect(slowestPoolNote(400, timings)).toBe('')
  })

  it('stays quiet when an older main process sent no breakdown', () => {
    expect(slowestPoolNote(9000, null)).toBe('')
    expect(slowestPoolNote(9000, [])).toBe('')
  })
})

describe('the breakdown survives the whole way to the user', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const r = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf-8')

  it('main measures every pool', () => {
    const src = r('src/main/ai/anthropic.ts')
    // Every pooled() call must hand over the collector, or that pool's cost
    // is invisible again. Parsed from the pooled( calls themselves: an
    // earlier version looked up the bare pool NAME and matched
    // makeProposalId('mail', …) hundreds of lines away, reporting "mail is
    // not measured" about a call that measures it. A false alarm is worse
    // than no alarm — it teaches you to edit the test.
    const measured = new Map<string, boolean>()
    for (const m of src.matchAll(/pooled\(\s*'([a-z-]+)'/g)) {
      const at = m.index ?? 0
      measured.set(m[1], src.slice(at, at + 320).includes('poolTimings'))
    }
    for (const pool of ['workspace', 'web-search', 'embedding-probe', 'mail', 'coverage-probe']) {
      expect(measured.has(pool), `${pool} has no pooled() call`).toBe(true)
      expect(measured.get(pool), `${pool} is not measured`).toBe(true)
    }
  })

  it('main logs a slow turn with the full breakdown', () => {
    const src = r('src/main/ai/anthropic.ts')
    expect(src).toContain('logSlowRetrieval(prepared.retrievalMs, prepared.poolTimings)')
    expect(src).toContain('[chat] slow retrieval')
  })

  it('and sends it to the renderer rather than only logging it', () => {
    // A log nobody reads is not a safeguard. The number the user can SEE and
    // paste back is the one that ends the guessing.
    expect(r('src/main/ai/anthropic.ts')).toContain('poolTimings: prepared.poolTimings.length > 0')
    expect(r('src/renderer/src/stores/chat.ts')).toContain('poolTimings: t.poolTimings ?? null')
    expect(r('src/renderer/src/lib/traceView.ts')).toContain('slowestPoolNote(ms, trace.poolTimings)')
  })
})
