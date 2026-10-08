// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 2026-10-08 — "its not available from the footer" ───────────────────────
//
// Two separate faults produced one symptom. The feed was stale (fixed in the
// release scripts), and the app polled every FOUR HOURS — so even once the
// feed was right, a release took up to four hours to appear for anyone already
// running the app, and the footer showed nothing at all in the meantime. An
// update that is merely pending is indistinguishable from one that is missing.
//
// Pinned here because an interval is a single number with no visible effect
// until someone is waiting on it, which is how it goes unnoticed.

const SRC = readFileSync(
  join(__dirname, '..', '..', 'src', 'main', 'autoUpdate.ts'),
  'utf-8'
)

describe('update poll cadence', () => {
  it('polls every 5 minutes', () => {
    expect(SRC).toContain('const POLL_MS = 5 * 60 * 1000')
    expect(SRC).not.toContain('const POLL_MS = 4 * 60 * 60 * 1000')
  })

  it('still checks shortly after boot rather than waiting for the first tick', () => {
    expect(SRC).toContain('const FIRST_CHECK_MS = 30 * 1000')
    expect(SRC).toContain('setTimeout(() => checkForUpdates(), FIRST_CHECK_MS)')
  })
})

describe('the poll never fires over work already in flight', () => {
  // This guard is the reason a 5-minute interval is safe at all. Without it
  // the poll would re-check while Windows is mid-download of a ~240MB
  // installer, and would broadcast 'checking' over a macOS banner the user may
  // have already clicked — blanking their own download out from under them.
  it('only polls from idle, none or error', () => {
    expect(SRC).toContain("const POLLABLE = new Set<UpdateState['kind']>(['idle', 'none', 'error'])")
    expect(SRC).toContain('if (!POLLABLE.has(current.kind)) return')
  })

  it('the polled states are exactly the ones with nothing in flight', () => {
    // Derive the full set from the type so a new state cannot be added without
    // this test forcing a decision about whether it is safe to poll from.
    const block = SRC.slice(
      SRC.indexOf('export type UpdateState ='),
      SRC.indexOf("let current: UpdateState")
    )
    const all = [...block.matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1]).sort()
    expect(all).toEqual(['available', 'checking', 'downloading', 'error', 'idle', 'none', 'ready'])

    // The four excluded ones each mean something is already happening:
    // checking (a request is open), downloading (bytes are moving),
    // available (the user is being offered it right now), ready (downloaded,
    // waiting on a restart — there is nothing left to learn).
    const polled = ['idle', 'none', 'error']
    const excluded = all.filter((k) => !polled.includes(k)).sort()
    expect(excluded).toEqual(['available', 'checking', 'downloading', 'ready'])
  })
})
