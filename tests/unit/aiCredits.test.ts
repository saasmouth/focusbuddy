import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseCreditsResponse,
  parseCreditError,
  creditErrorMessage,
  isTrialCreditsExhausted,
  formatCredits,
  TOP_UP_PACKS
} from '../../src/shared/aiCredits'

// Growth spec section 2: credits, the GET /ai/credits contract and the 402
// refusal bodies. The app must read both the new server and the one in
// production today (dollar balance, Anthropic-shaped 402) without inventing a
// value either one did not send.

describe('parseCreditsResponse', () => {
  it('reads the spec shape', () => {
    const snap = parseCreditsResponse({
      balance: 1234,
      buckets: [
        { kind: 'allowance', credits: 800, expiresAt: '2026-11-01T00:00:00Z' },
        { kind: 'bonus', credits: 300, expiresAt: 1800000000 },
        { kind: 'purchased', credits: 134, expiresAt: null },
        { kind: 'mystery', credits: 5 }
      ],
      allowance: 800,
      resetsAt: '2026-11-01T00:00:00Z',
      tier: 'pro'
    })
    expect(snap).toEqual({
      balance: 1234,
      buckets: [
        { kind: 'allowance', credits: 800, expiresAt: Date.parse('2026-11-01T00:00:00Z') },
        { kind: 'bonus', credits: 300, expiresAt: 1800000000 * 1000 },
        { kind: 'purchased', credits: 134, expiresAt: null }
      ],
      allowance: 800,
      resetsAt: Date.parse('2026-11-01T00:00:00Z'),
      tier: 'pro',
      models: null,
      trial: false,
      creditPaidUntil: null,
      proxyAvailable: null
    })
  })

  it('reads the signal server\'s extra fields: models, trial, credit-bank date', () => {
    const snap = parseCreditsResponse({
      ok: true,
      balance: 300,
      buckets: [],
      allowance: 100,
      resetsAt: 1800000000000,
      tier: 'free',
      aiTier: 'trial',
      models: ['haiku', 'sonnet'],
      creditPaidUntil: 1800000000000,
      balanceUsd: 3
    })
    expect(snap?.models).toEqual(['haiku', 'sonnet'])
    expect(snap?.trial).toBe(true)
    expect(snap?.creditPaidUntil).toBe(1800000000000)
    expect(snap?.balance).toBe(300) // credits, not balanceUsd x 100
  })

  it('reads the legacy dollar balance as credits and leaves the rest unknown', () => {
    expect(parseCreditsResponse({ balanceUsd: 0.37, proxyAvailable: true })).toEqual({
      balance: 37,
      buckets: [],
      allowance: null,
      resetsAt: null,
      tier: null,
      models: null,
      trial: false,
      creditPaidUntil: null,
      proxyAvailable: true
    })
  })

  it('returns null for a body that is neither', () => {
    expect(parseCreditsResponse({ ok: true })).toBeNull()
    expect(parseCreditsResponse(null)).toBeNull()
  })
})

describe('parseCreditError', () => {
  it('reads the spec 402 bodies', () => {
    expect(parseCreditError(402, JSON.stringify({ error: 'out_of_credits', next: 'topup' }))).toMatchObject({
      error: 'out_of_credits',
      next: 'topup',
      allowedModel: null
    })
    expect(
      parseCreditError(
        402,
        JSON.stringify({ error: 'model_not_in_plan', next: 'upgrade', allowedModel: 'claude-haiku-5-5' })
      )
    ).toMatchObject({ error: 'model_not_in_plan', next: 'upgrade', allowedModel: 'claude-haiku-5-5' })
  })
  it('reads the signal server\'s nested refusal', () => {
    const e = parseCreditError(
      402,
      JSON.stringify({
        error: {
          type: 'model_not_in_plan',
          message: 'Opus is not included in your plan.',
          cheapestAllowedModel: 'claude-haiku-5-5',
          allowedModelFamilies: ['haiku', 'sonnet'],
          nextAction: 'upgrade'
        }
      })
    )
    expect(e).toEqual({
      error: 'model_not_in_plan',
      next: 'upgrade',
      allowedModel: 'claude-haiku-5-5',
      allowedFamilies: ['haiku', 'sonnet'],
      balance: null
    })
    const spent = parseCreditError(402, JSON.stringify({ error: { type: 'out_of_credits', balance: 4.5, nextAction: 'topup' } }))
    expect(spent).toMatchObject({ error: 'out_of_credits', next: 'topup', balance: 4.5 })
    expect(creditErrorMessage(spent!)).toMatch(/not enough for that request/)
    const unverified = parseCreditError(403, JSON.stringify({ error: { type: 'email_not_verified', nextAction: 'verify_email' } }))
    expect(unverified).toMatchObject({ error: 'email_not_verified', next: null })
  })
  it('reads the older Anthropic-shaped refusal', () => {
    expect(
      parseCreditError(402, JSON.stringify({ error: { type: 'out_of_credits', message: 'x' } }))?.error
    ).toBe('out_of_credits')
  })
  it('treats any other 402 as spent credits, and ignores non-credit statuses', () => {
    expect(parseCreditError(402, 'not json')?.error).toBe('out_of_credits')
    expect(parseCreditError(400, JSON.stringify({ error: 'out_of_credits' }))).toBeNull()
    expect(parseCreditError(403, JSON.stringify({ error: 'forbidden' }))).toBeNull()
  })
  it('reads an email-not-verified refusal', () => {
    expect(parseCreditError(403, JSON.stringify({ error: 'email_not_verified' }))?.error).toBe('email_not_verified')
  })
  it('names the next action in the message', () => {
    expect(creditErrorMessage({ error: 'out_of_credits', next: 'upgrade', allowedModel: null })).toMatch(/Upgrade/)
    expect(creditErrorMessage({ error: 'out_of_credits', next: 'topup', allowedModel: null })).not.toMatch(/Upgrade/)
  })
})

describe('packs, formatting and the trial-credits rule', () => {
  it('sells $10 / $25 / $50 packs at the spec rates', () => {
    expect(TOP_UP_PACKS).toEqual([
      { usd: 10, credits: 1000 },
      { usd: 25, credits: 2600 },
      { usd: 50, credits: 5500 }
    ])
  })
  it('formats credits', () => {
    expect(formatCredits(1234.7)).toBe('1,234 credits')
    expect(formatCredits(1)).toBe('1 credit')
    expect(formatCredits(-3)).toBe('0 credits')
  })
  it('says "trial credits used" only for a free trialist who has run out', () => {
    const spent = { error: 'out_of_credits' as const, next: 'upgrade' as const, allowedModel: null }
    expect(isTrialCreditsExhausted({ trialActive: true, storedPlan: 'free', error: spent, balance: 0 })).toBe(true)
    expect(isTrialCreditsExhausted({ trialActive: true, storedPlan: 'free', error: null, balance: 0 })).toBe(true)
    expect(isTrialCreditsExhausted({ trialActive: true, storedPlan: 'free', error: null, balance: 12 })).toBe(false)
    expect(isTrialCreditsExhausted({ trialActive: true, storedPlan: 'pro', error: spent, balance: 0 })).toBe(false)
    expect(isTrialCreditsExhausted({ trialActive: false, storedPlan: 'free', error: spent, balance: 0 })).toBe(false)
    expect(isTrialCreditsExhausted({ trialActive: true, storedPlan: 'free', error: null, balance: null })).toBe(false)
    // Refused for costing more than what is left: not "used".
    expect(
      isTrialCreditsExhausted({ trialActive: true, storedPlan: 'free', error: { ...spent, balance: 40 }, balance: 40 })
    ).toBe(false)
  })
})

// ── The metered fetch (src/main/ai/creditMode.ts) ───────────────────────────

const state = { token: 'tok' as string | null, mode: 'credits' as 'auto' | 'credits' | 'byok', ownKey: null as string | null }
vi.mock('../../src/main/db/account', () => ({ loadAccountState: () => ({ sessionToken: state.token }) }))
vi.mock('../../src/main/settingsStore', () => ({
  getAiMode: () => state.mode,
  resolveAnthropicKey: () => state.ownKey,
  hasOwnAnthropicKey: () => Boolean(state.ownKey)
}))

const PROXY = 'https://signal.test/ai/anthropic/v1/messages'
const req = (model: string, text = 'hi'): RequestInit => ({
  method: 'POST',
  headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
  body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content: text }] })
})
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

async function load() {
  const mod = await import('../../src/main/ai/creditMode')
  mod.resetCreditCache()
  return mod
}

function recorder(responses: Response[]) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: new Headers(init?.headers as HeadersInit)
    })
    const r = responses.shift()
    if (!r) throw new Error('no response queued')
    return r
  }) as typeof fetch
  return { calls, fetchFn }
}

describe('createMeteredFetch', () => {
  beforeEach(() => {
    state.token = 'tok'
    state.mode = 'credits'
    state.ownKey = null
  })

  it('sends a Free account\'s Sonnet request as Haiku, thinking off', async () => {
    const m = await load()
    const { calls, fetchFn } = recorder([
      json(200, { balance: 50, buckets: [], allowance: 100, resetsAt: null, tier: 'free' }),
      json(200, { content: [] }, { 'x-pd-credits': '49' })
    ])
    globalThis.fetch = fetchFn
    await m.refreshCredits()
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    await f(PROXY, req('claude-sonnet-5-5'))
    expect(calls[1].body.model).toBe('claude-haiku-5-5')
    expect(calls[1].body.thinking).toEqual({ type: 'disabled' })
    expect(m.getAiStatus().balance).toBe(49)
  })

  it('does not attempt a request when the balance is known to be spent', async () => {
    const m = await load()
    const { calls, fetchFn } = recorder([json(200, { balance: 0, buckets: [], allowance: 100, resetsAt: null, tier: 'free' })])
    globalThis.fetch = fetchFn
    await m.refreshCredits()
    const events: string[] = []
    const off = m.onCreditEvent((e) => events.push(`${e.error}:${e.next}`))
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    const res = await f(PROXY, req('claude-haiku-5-5'))
    off()
    expect(calls).toHaveLength(1) // only the balance read; no Messages call
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('out_of_credits')
    expect(body.error.message).toMatch(/used up/)
    expect(events).toEqual(['out_of_credits:upgrade'])
  })

  it('declines a request whose input alone exceeds the balance', async () => {
    const m = await load()
    const { calls, fetchFn } = recorder([json(200, { balance: 1, buckets: [], allowance: 100, resetsAt: null, tier: 'proplus' })])
    globalThis.fetch = fetchFn
    await m.refreshCredits()
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    // ~3M characters of input to Opus: at least $2 at list price.
    const res = await f(PROXY, req('claude-opus-5-5', 'x'.repeat(3_000_000)))
    expect(res.status).toBe(402)
    expect(calls).toHaveLength(1)
  })

  it('on 402 out_of_credits in auto mode with a key, retries the original request on that key', async () => {
    state.mode = 'auto'
    state.ownKey = 'sk-own'
    const m = await load()
    const { calls, fetchFn } = recorder([
      json(402, { error: 'out_of_credits', next: 'topup' }),
      json(200, { content: [] })
    ])
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    const res = await f(PROXY, req('claude-opus-5-5'))
    expect(res.status).toBe(200)
    expect(calls[1].url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[1].headers.get('x-api-key')).toBe('sk-own')
    expect(calls[1].headers.get('authorization')).toBeNull()
    expect(m.getAiStatus().outOfCredits).toBe(true)
    expect(m.getAiStatus().lastError?.next).toBe('topup')
  })

  it('fits to the server\'s family list, so a Free trialist keeps Sonnet', async () => {
    const m = await load()
    const { calls, fetchFn } = recorder([
      json(200, { balance: 300, buckets: [], allowance: 100, resetsAt: null, tier: 'free', aiTier: 'trial', models: ['haiku', 'sonnet'] }),
      json(200, { content: [] })
    ])
    globalThis.fetch = fetchFn
    await m.refreshCredits()
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    await f(PROXY, req('claude-sonnet-5-5'))
    await expect(Promise.resolve(calls[1].body.model)).resolves.toBe('claude-sonnet-5-5')
  })

  it('on the signal server\'s nested model_not_in_plan, retries on the best allowed family', async () => {
    const m = await load()
    const { calls, fetchFn } = recorder([
      json(402, { error: { type: 'model_not_in_plan', cheapestAllowedModel: 'claude-haiku-5-5', allowedModelFamilies: ['haiku', 'sonnet'], nextAction: 'upgrade' } }),
      json(200, { content: [] })
    ])
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    const res = await f(PROXY, req('claude-opus-5-5'))
    expect(res.status).toBe(200)
    expect(calls.map((c) => c.body.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
  })

  it('reads x-pd-credit-balance as credits when the server also sends x-pd-credits-charged', async () => {
    const m = await load()
    const { fetchFn } = recorder([json(200, { content: [] }, { 'x-pd-credit-balance': '287.40', 'x-pd-credits-charged': '0.0123' })])
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    await f(PROXY, req('claude-haiku-5-5'))
    expect(m.getAiStatus().balance).toBeCloseTo(287.4)
  })

  it('keeps a non-zero balance when a request is refused for costing more than it', async () => {
    const m = await load()
    const { fetchFn } = recorder([json(402, { error: { type: 'out_of_credits', balance: 4.5, nextAction: 'topup' } })])
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    await f(PROXY, req('claude-haiku-5-5'))
    expect(m.getAiStatus().balance).toBe(4.5)
    expect(m.getAiStatus().outOfCredits).toBe(false)
  })

  it('on 402 model_not_in_plan, retries once on the model the server named', async () => {
    const m = await load()
    const { calls, fetchFn } = recorder([
      json(402, { error: 'model_not_in_plan', next: 'upgrade', allowedModel: 'claude-haiku-5-5' }),
      json(200, { content: [] })
    ])
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    const res = await f(PROXY, req('claude-opus-5-5'))
    expect(res.status).toBe(200)
    expect(calls.map((c) => c.body.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  })

  it('surfaces email_not_verified as a readable error and remembers it', async () => {
    const m = await load()
    const { fetchFn } = recorder([json(403, { error: 'email_not_verified' })])
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    const res = await f(PROXY, req('claude-haiku-5-5'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/Verify your email/)
    expect(m.getAiStatus().verificationRequired).toBe(true)
    m.markEmailVerified()
    expect(m.getAiStatus().verificationRequired).toBe(false)
  })

  it('reads a legacy dollar balance header as credits', async () => {
    const m = await load()
    const { fetchFn } = recorder([json(200, { content: [] }, { 'x-pd-credit-balance': '0.420000' })])
    const f = m.createMeteredFetch({ fetch: fetchFn, mode: () => state.mode, ownKey: () => state.ownKey })
    await f(PROXY, req('claude-haiku-5-5'))
    expect(m.getAiStatus().balance).toBe(42)
  })

  it('refuses top-up amounts that are not a published pack', async () => {
    const m = await load()
    expect(await m.startTopUp(5)).toEqual({ ok: false, error: 'Credits come in $10, $25 and $50 packs.' })
  })
})
