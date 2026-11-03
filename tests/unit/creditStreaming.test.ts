import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCreditClient, isStreamingUnsupported, SIGNAL_BASE } from '../../src/main/ai/creditMode'

// DEC-051 — the PlexiDesk credits proxy REFUSES streaming (400 "Streaming is
// not supported on PlexiDesk credits"). The guard that keeps streams off it
// used to ask policy — `shouldUseCredits() && getCreditClient() === c` — which
// is re-derived long after the client was chosen, and drifts:
//
//   1. `c = getClient()` at the top of the turn → the credits proxy.
//   2. retrieval runs (its own AI calls) → the balance lands at 0, so in auto
//      mode `shouldUseCredits()` now answers FALSE; or a settings change calls
//      invalidateCreditClient(), so `getCreditClient() === c` is now FALSE.
//   3. the guard therefore streams — straight into the proxy that just said
//      it will not stream. The user sees a raw 400 where the answer goes.
//
// The client's own baseURL cannot drift out from under the request it is
// about to make, so that is the fact we read.

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('isCreditClient — the decision that cannot drift', () => {
  it('recognises the metered proxy by its baseURL', () => {
    expect(isCreditClient({ baseURL: `${SIGNAL_BASE}/ai/anthropic` })).toBe(true)
  })

  it('says no for a direct-to-Anthropic (BYOK) client', () => {
    expect(isCreditClient({ baseURL: 'https://api.anthropic.com' })).toBe(false)
  })

  it('says no for a missing/!string baseURL rather than throwing', () => {
    expect(isCreditClient(null)).toBe(false)
    expect(isCreditClient(undefined)).toBe(false)
    expect(isCreditClient({})).toBe(false)
  })

  it('does not match a look-alike host that merely CONTAINS the base', () => {
    expect(isCreditClient({ baseURL: 'https://evil.example/?u=' + SIGNAL_BASE })).toBe(false)
  })
})

describe('isStreamingUnsupported — only the retryable 400', () => {
  it('matches the proxy refusal in the shapes the SDK throws it', () => {
    expect(
      isStreamingUnsupported(
        new Error('400 {"error":{"type":"invalid_request_error","message":"Streaming is not supported on PlexiDesk credits."}}')
      )
    ).toBe(true)
    expect(isStreamingUnsupported('Streaming is not supported on PlexiDesk credits.')).toBe(true)
    expect(
      isStreamingUnsupported({ error: { message: 'streaming is not supported here' } })
    ).toBe(true)
  })

  it('does NOT swallow other 400s — they must still surface', () => {
    expect(isStreamingUnsupported(new Error('400 invalid_request_error: max_tokens too large'))).toBe(
      false
    )
    expect(isStreamingUnsupported(new Error('401 authentication_error'))).toBe(false)
    expect(isStreamingUnsupported(null)).toBe(false)
  })
})

describe('the streaming call sites (file-level pins)', () => {
  const src = read('src/main/ai/anthropic.ts')

  it('no streaming site decides from drifting policy any more', () => {
    // The exact racy expression that produced the operator's 400.
    expect(src).not.toContain('shouldUseCredits() && getCreditClient() === c')
    // Both sites read the client instead.
    expect(src.match(/isCreditClient\(c\)/g)?.length).toBe(2)
  })

  it('every stream has a non-streamed fallback for the proxy refusal', () => {
    // One fallback per stream: the two chat paths, and Build with AI's
    // streamToFinalMessage (2026-11-03, uncapped desks).
    const streams = src.match(/\.messages\.stream\(/g)?.length ?? 0
    expect(streams).toBe(3)
    expect(src.match(/isStreamingUnsupported\(e\)/g)?.length).toBe(streams)
    // The fallback re-runs the SAME request body, so the two shapes converge.
    expect(src.match(/final(Msg)? = await nonStreamed\(\)/g)?.length).toBe(4)
  })

  it('the latency trail reports what ACTUALLY happened, not what was planned', () => {
    // `streamed=` used to echo the pre-decision; a fallback would have logged
    // a lie, which is exactly how this stayed invisible.
    expect(src).toContain('streamed=${streamed}')
    expect(src).toContain('streamed = false')
  })
})
