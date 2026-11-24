// @vitest-environment node
//
// The model adapters (src/main/aispace/providers) against local reference
// servers that speak the Anthropic Messages/Models and OpenAI Responses/Models
// wire protocols (tests/unit/helpers/aispaceFakeModelApis.ts). No request in
// this file leaves 127.0.0.1; the default-endpoint checks use a stub fetch.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimateCostMicros as aiCostMicros, rateFor } from '../../src/main/ai/aiCost'
import {
  BACKGROUND_UNTESTED_DETAIL,
  createAnthropicAdapter,
  createModelAdapter,
  createOpenAIAdapter,
  isRetryable,
  type ModelAdapter,
  type ModelRequest,
  ProviderError,
  type ProviderErrorCode
} from '../../src/main/aispace/providers'
import {
  type AnthropicMode,
  type FakeAnthropic,
  type FakeOpenAI,
  OPENAI_SNAPSHOT_SUFFIX,
  type OpenAIMode,
  startFakeAnthropic,
  startFakeOpenAI
} from './helpers/aispaceFakeModelApis'

const ANT_KEY = 'sk-ant-test-abcdefghijklmnop'
const OAI_KEY = 'sk-test-abcdefghijklmnop'
// A key no "looks like a key" pattern recognises: only exact-match scrubbing
// keeps it out of messages.
const ODD_KEY = 'oddshape.KEY.000111222333'

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected the call to throw, and it resolved')
}

async function providerError(p: Promise<unknown>, code: ProviderErrorCode): Promise<ProviderError> {
  const e = await caught(p)
  expect(e).toBeInstanceOf(ProviderError)
  const pe = e as ProviderError
  expect(pe.code, pe.message).toBe(code)
  return pe
}

function expectNoKey(e: unknown, key: string): void {
  const err = e as Error
  for (const text of [err.message, String(err.stack), String(err), JSON.stringify({ ...err })]) {
    expect(text.includes(key), `key leaked into: ${text.replace(key, '<KEY>')}`).toBe(false)
  }
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const ask = (secret: string, model: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({
  secret,
  model,
  system: 'Answer in one line.',
  messages: [
    { role: 'user', content: 'What is the answer?' },
    { role: 'assistant', content: 'Which question?' },
    { role: 'user', content: 'The big one.' }
  ],
  maxOutputTokens: 256,
  ...extra
})

// ── Anthropic ────────────────────────────────────────────────────────────────

describe('Anthropic adapter', () => {
  let fake: FakeAnthropic
  let claude: ModelAdapter
  const MODEL = 'claude-sonnet-5-5'

  beforeEach(async () => {
    fake = await startFakeAnthropic({
      key: ANT_KEY,
      org: 'org-7f3a-test',
      models: ['claude-sonnet-5-5', 'claude-haiku-5-5-20261001', 'claude-legacy-3']
    })
    claude = createAnthropicAdapter({ baseUrl: fake.url, allowLoopback: true })
  })
  afterEach(async () => {
    await fake.close()
  })

  describe('verify', () => {
    it('reads the organisation from the response header, lists models, and makes no billable call', async () => {
      const r = await claude.verify(ANT_KEY, { now: () => 1_000 })
      expect(r).toMatchObject({ ok: true, identity: 'org-7f3a-test', providerOrg: 'org-7f3a-test', billable: false })
      expect(r.models).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5-20261001', 'claude-legacy-3'])
      expect(r.capabilities).toHaveLength(1)
      expect(r.capabilities[0]).toMatchObject({ capability: 'run_model', state: 'passed', checkedAt: 1_000 })
      // A dated snapshot counts for its catalogue model; an unrelated id does not.
      expect(r.capabilities[0].detail).toContain('Claude Sonnet 5.5')
      expect(r.capabilities[0].detail).toContain('Claude Haiku 5.5')
      expect(r.capabilities[0].detail).not.toContain('Opus')
      expect(r.detail).toMatch(/no billable call/i)

      expect(fake.requests.length).toBeGreaterThan(0)
      expect(fake.requests.some((q) => q.method !== 'GET')).toBe(false)
      expect(fake.requests.every((q) => q.path === '/v1/models')).toBe(true)
      const first = fake.requests[0]
      expect(first.query.get('limit')).toBe('100')
      expect(first.headers['x-api-key']).toBe(ANT_KEY)
      expect(first.headers['anthropic-version']).toBe('2023-06-01')
    })

    it('follows the model list across pages', async () => {
      fake.state.pageSize = 1
      const r = await claude.verify(ANT_KEY)
      expect(r.models).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5-20261001', 'claude-legacy-3'])
      expect(fake.requests.map((q) => q.query.get('after_id'))).toEqual([null, 'claude-sonnet-5-5', 'claude-haiku-5-5-20261001'])
    })

    it('leaves identity null when the organisation header is absent (never invented)', async () => {
      fake.state.org = null
      const r = await claude.verify(ANT_KEY)
      expect(r.ok).toBe(true)
      expect(r.identity).toBeNull()
      expect(r.providerOrg).toBeNull()
    })

    it('fails run_model when the key authenticates but no Plexii model is listed', async () => {
      fake.state.models = ['claude-legacy-3', 'claude-sonnet-5-5-preview']
      const r = await claude.verify(ANT_KEY)
      expect(r.ok).toBe(false)
      expect(r.errorCode).toBeUndefined()
      expect(r.capabilities[0]).toMatchObject({ capability: 'run_model', state: 'failed' })
      expect(r.capabilities[0].detail).toMatch(/none of the models Plexii offers/)
      expect(r.models).toEqual(['claude-legacy-3', 'claude-sonnet-5-5-preview'])
    })

    it('reports a rejected key as failed with reconnect_required, without echoing the key', async () => {
      const r = await claude.verify('sk-ant-test-wrongwrongwrong')
      expect(r).toMatchObject({ ok: false, errorCode: 'reconnect_required', identity: null, billable: false })
      expect(r.capabilities[0]).toMatchObject({ capability: 'run_model', state: 'failed' })
      expect(r.detail).not.toContain('sk-ant-test-wrongwrongwrong')
      expect(r.capabilities[0].detail).not.toContain('sk-ant-test-wrongwrongwrong')
    })

    it('reports a missing key without sending anything', async () => {
      const r = await claude.verify('   ')
      expect(r).toMatchObject({ ok: false, errorCode: 'reconnect_required' })
      expect(fake.requests).toHaveLength(0)
    })

    it('throws on transient failures, which say nothing about the key', async () => {
      fake.state.mode = 'overloaded'
      await providerError(claude.verify(ANT_KEY), 'unavailable')
    })
  })

  describe('run', () => {
    it('streams text in order and reports usage, request id and message id', async () => {
      const deltas: string[] = []
      const r = await claude.run(ask(ANT_KEY, MODEL, { onText: (d) => deltas.push(d) }))
      expect(deltas).toEqual(fake.state.chunks)
      expect(r).toEqual({
        status: 'completed',
        text: fake.state.chunks.join(''),
        usage: { inputTokens: 42, outputTokens: 17, source: 'reported' },
        requestId: 'req_fake_1',
        externalId: 'msg_fake_1',
        model: MODEL,
        stopReason: 'end_turn',
        error: null
      })
      const sent = fake.requests[0]
      expect(sent.method).toBe('POST')
      expect(sent.path).toBe('/v1/messages')
      expect(sent.json).toEqual({
        model: MODEL,
        max_tokens: 256,
        system: 'Answer in one line.',
        messages: ask(ANT_KEY, MODEL).messages,
        stream: true
      })
      expect(sent.headers['x-api-key']).toBe(ANT_KEY)
      expect(sent.headers['anthropic-version']).toBe('2023-06-01')
      expect(sent.headers['idempotency-key']).toBeUndefined()
    })

    it('parses a CRLF stream the same way', async () => {
      fake.state.crlf = true
      const deltas: string[] = []
      const r = await claude.run(ask(ANT_KEY, MODEL, { onText: (d) => deltas.push(d) }))
      expect(deltas).toEqual(fake.state.chunks)
      expect(r.status).toBe('completed')
      expect(r.usage).toEqual({ inputTokens: 42, outputTokens: 17, source: 'reported' })
    })

    it('runs without streaming when no onText is given', async () => {
      const r = await claude.run(ask(ANT_KEY, MODEL, { system: '' }))
      expect(r).toMatchObject({
        status: 'completed',
        text: fake.state.chunks.join(''),
        usage: { inputTokens: 42, outputTokens: 17, source: 'reported' },
        requestId: 'req_fake_1',
        externalId: 'msg_fake_1',
        stopReason: 'end_turn'
      })
      expect(fake.requests[0].json).not.toHaveProperty('stream')
      // An empty system prompt is not sent.
      expect(fake.requests[0].json).not.toHaveProperty('system')
    })

    it('sends only user_id as metadata', async () => {
      await claude.run(ask(ANT_KEY, MODEL, { metadata: { user_id: 'u-123', project: 'p-9' } }))
      expect(fake.requests[0].json?.metadata).toEqual({ user_id: 'u-123' })
    })

    it('marks a reply cut off by max_tokens as incomplete (stream and non-stream)', async () => {
      fake.state.mode = 'max_tokens'
      const streamed = await claude.run(ask(ANT_KEY, MODEL, { onText: () => undefined }))
      expect(streamed).toMatchObject({ status: 'incomplete', stopReason: 'max_tokens' })
      const once = await claude.run(ask(ANT_KEY, MODEL))
      expect(once).toMatchObject({ status: 'incomplete', stopReason: 'max_tokens' })
    })

    it('refuses background runs as unsupported and sends nothing', async () => {
      const e = await providerError(claude.run(ask(ANT_KEY, MODEL, { background: true })), 'unsupported')
      expect(e.message).toMatch(/background/i)
      expect(fake.requests).toHaveLength(0)
      expect(claude.poll).toBeUndefined()
      expect(claude.cancel).toBeUndefined()
    })

    it('returns cancelled with the partial text when aborted mid-stream, and closes the stream', async () => {
      fake.state.mode = 'stall'
      const ctrl = new AbortController()
      const deltas: string[] = []
      const r = await claude.run(
        ask(ANT_KEY, MODEL, {
          signal: ctrl.signal,
          onText: (d) => {
            deltas.push(d)
            ctrl.abort()
          }
        })
      )
      expect(r.status).toBe('cancelled')
      expect(r.text).toBe(fake.state.chunks[0])
      expect(deltas).toEqual([fake.state.chunks[0]])
      // Input tokens arrived in message_start; the final output count never did.
      expect(r.usage).toEqual({ inputTokens: 42, outputTokens: null, source: 'reported' })
      expect(r.externalId).toBe('msg_fake_1')
      await waitFor(() => fake.abortedStreams === 1)
    })

    it('returns cancelled without sending when the signal is already aborted', async () => {
      const ctrl = new AbortController()
      ctrl.abort()
      const r = await claude.run(ask(ANT_KEY, MODEL, { signal: ctrl.signal, onText: () => undefined }))
      expect(r).toMatchObject({ status: 'cancelled', text: '', usage: { source: 'unavailable' } })
      expect(fake.requests).toHaveLength(0)
    })

    it('treats a stalled stream as unavailable', async () => {
      fake.state.mode = 'stall'
      const quick = createAnthropicAdapter({ baseUrl: fake.url, allowLoopback: true, streamIdleTimeoutMs: 150 })
      const started = Date.now()
      const e = await providerError(quick.run(ask(ANT_KEY, MODEL, { onText: () => undefined })), 'unavailable')
      expect(e.message).toMatch(/stalled/)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(isRetryable(e.code)).toBe(true)
    })

    it('treats a stream that ends without message_stop as unavailable', async () => {
      fake.state.mode = 'truncated'
      const e = await providerError(claude.run(ask(ANT_KEY, MODEL, { onText: () => undefined })), 'unavailable')
      expect(e.message).toMatch(/ended before/)
    })

    it('maps an error event inside the stream', async () => {
      fake.state.mode = 'error_event'
      const e = await providerError(claude.run(ask(ANT_KEY, MODEL, { onText: () => undefined })), 'unavailable')
      expect(e.providerType).toBe('overloaded_error')
      expect(e.requestId).toBe('req_fake_1')
    })

    it('rethrows an exception from onText as the caller’s own error', async () => {
      const boom = new Error('renderer went away')
      const e = await caught(
        claude.run(
          ask(ANT_KEY, MODEL, {
            onText: () => {
              throw boom
            }
          })
        )
      )
      expect(e).toBe(boom)
    })

    it('refuses malformed requests before sending anything', async () => {
      await providerError(claude.run(ask(ANT_KEY, MODEL, { messages: [] })), 'bad_request')
      await providerError(claude.run(ask(ANT_KEY, MODEL, { maxOutputTokens: 0 })), 'bad_request')
      await providerError(claude.run(ask(ANT_KEY, MODEL, { maxOutputTokens: 1.5 })), 'bad_request')
      await providerError(claude.run(ask(ANT_KEY, '')), 'bad_request')
      await providerError(claude.run(ask(ANT_KEY, MODEL, { messages: [{ role: 'user', content: '  ' }] })), 'bad_request')
      await providerError(claude.run(ask('', MODEL)), 'reconnect_required')
      await providerError(claude.run(ask('sk-ant-has space-1234', MODEL)), 'reconnect_required')
      expect(fake.requests).toHaveLength(0)
    })
  })

  describe('error mapping', () => {
    const cases: Array<[AnthropicMode, ProviderErrorCode, number]> = [
      ['unauthorized', 'reconnect_required', 401],
      ['forbidden', 'insufficient_scope', 403],
      ['rate_limited', 'rate_limited', 429],
      ['overloaded', 'unavailable', 529],
      ['server_error', 'unavailable', 500],
      ['credit_balance', 'quota', 400],
      ['billing_402', 'quota', 402],
      ['bad_request', 'bad_request', 400]
    ]
    for (const [mode, code, status] of cases) {
      it(`${mode} → ${code} (HTTP ${status}), streaming and not, with the key kept out`, async () => {
        fake.state.mode = mode
        for (const onText of [undefined, () => undefined]) {
          const e = await providerError(claude.run(ask(ANT_KEY, MODEL, { onText })), code)
          expect(e.status).toBe(status)
          expect(e.providerId).toBe('anthropic')
          expect(e.requestId).toMatch(/^req_fake_\d+$/)
          expectNoKey(e, ANT_KEY)
        }
      })
    }

    it('reads retry-after on 429 and on overload', async () => {
      fake.state.mode = 'rate_limited'
      expect((await providerError(claude.run(ask(ANT_KEY, MODEL)), 'rate_limited')).retryAfterMs).toBe(7_000)
      fake.state.mode = 'overloaded'
      fake.state.retryAfter = '3'
      expect((await providerError(claude.run(ask(ANT_KEY, MODEL)), 'unavailable')).retryAfterMs).toBe(3_000)
      fake.state.retryAfter = null
      expect((await providerError(claude.run(ask(ANT_KEY, MODEL)), 'unavailable')).retryAfterMs).toBeNull()
    })

    it('keeps the key out even when the provider echoes it in full, whatever its shape', async () => {
      // The fake echoes whatever key it was sent in its 401 body.
      const shaped = await providerError(claude.run(ask('sk-ant-test-zyxwvutsrqponm', MODEL)), 'reconnect_required')
      expectNoKey(shaped, 'sk-ant-test-zyxwvutsrqponm')
      const odd = await providerError(claude.run(ask(ODD_KEY, MODEL)), 'reconnect_required')
      expect(odd.message).toContain('[redacted]')
      expectNoKey(odd, ODD_KEY)
    })

    it('reports an unreachable server as unavailable', async () => {
      const dead = createAnthropicAdapter({ baseUrl: 'http://127.0.0.1:1', allowLoopback: true })
      const e = await providerError(dead.run(ask(ANT_KEY, MODEL)), 'unavailable')
      expectNoKey(e, ANT_KEY)
    })
  })

  it('estimates Claude cost from the verified aiCost table, and returns null for unknown models', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']) {
      const r = rateFor(model)
      const expected = Math.round(((1_234 / 1e6) * r.inPerM + (567 / 1e6) * r.outPerM) * 1e6)
      expect(claude.estimateCostMicros(model, 1_234, 567)).toBe(expected)
      expect(claude.estimateCostMicros(model, 1_234, 567)).toBe(aiCostMicros(model, 1_234, 567))
    }
    // aiCost would price these at its middle-tier default; that is a guess, so null.
    expect(claude.estimateCostMicros('claude-mystery-9', 1_000, 1_000)).toBeNull()
    expect(claude.estimateCostMicros('local:llama', 1_000, 1_000)).toBeNull()
    expect(claude.estimateCostMicros('claude-sonnet-5-5', Number.NaN, 1)).toBeNull()
  })
})

// ── OpenAI ───────────────────────────────────────────────────────────────────

describe('OpenAI adapter', () => {
  let fake: FakeOpenAI
  let gpt: ModelAdapter
  const MODEL = 'gpt-5.5'

  beforeEach(async () => {
    fake = await startFakeOpenAI({ key: OAI_KEY, org: 'org-plexii-test' })
    gpt = createOpenAIAdapter({ baseUrl: fake.url, allowLoopback: true })
  })
  afterEach(async () => {
    await fake.close()
  })

  describe('verify', () => {
    it('reads the organisation header, passes run_model, and leaves background features untested', async () => {
      const r = await gpt.verify(OAI_KEY, { now: () => 2_000 })
      expect(r).toMatchObject({ ok: true, identity: 'org-plexii-test', providerOrg: 'org-plexii-test', billable: false })
      expect(r.models).toEqual(['gpt-5.5', 'gpt-5.4-mini-2026-08-01', 'text-embedding-3-small'])
      expect(r.capabilities).toEqual([
        { capability: 'run_model', state: 'passed', checkedAt: 2_000, detail: expect.stringContaining('GPT-5.5') },
        { capability: 'track_run', state: 'untested', checkedAt: null, detail: BACKGROUND_UNTESTED_DETAIL },
        { capability: 'cancel_run', state: 'untested', checkedAt: null, detail: BACKGROUND_UNTESTED_DETAIL },
        { capability: 'resume_run', state: 'untested', checkedAt: null, detail: BACKGROUND_UNTESTED_DETAIL }
      ])
      expect(BACKGROUND_UNTESTED_DETAIL).toMatch(/^Checked on the first background run/)
      expect(BACKGROUND_UNTESTED_DETAIL).toMatch(/billable/)
      expect(r.capabilities[0].detail).toContain('GPT-5.4 mini')
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests.some((q) => q.method !== 'GET')).toBe(false)
      expect(fake.requests[0].path).toBe('/v1/models')
      expect(fake.requests[0].headers.authorization).toBe(`Bearer ${OAI_KEY}`)
    })

    it('leaves the organisation null when the header is absent', async () => {
      fake.state.org = null
      const r = await gpt.verify(OAI_KEY)
      expect(r.ok).toBe(true)
      expect(r.providerOrg).toBeNull()
      expect(r.identity).toBeNull()
    })

    it('fails every capability for a rejected key, without echoing it', async () => {
      const r = await gpt.verify('sk-test-wrongwrongwrong')
      expect(r).toMatchObject({ ok: false, errorCode: 'reconnect_required', billable: false })
      expect(r.capabilities.map((c) => c.state)).toEqual(['failed', 'failed', 'failed', 'failed'])
      expect(JSON.stringify(r)).not.toContain('sk-test-wrongwrongwrong')
    })

    it('reports an out-of-quota key as failed with quota', async () => {
      fake.state.mode = 'insufficient_quota'
      const r = await gpt.verify(OAI_KEY)
      expect(r).toMatchObject({ ok: false, errorCode: 'quota' })
    })

    it('fails run_model when no Plexii model is listed', async () => {
      fake.state.models = ['gpt-4o', 'gpt-5.5-turbo']
      const r = await gpt.verify(OAI_KEY)
      expect(r.ok).toBe(false)
      expect(r.capabilities[0]).toMatchObject({ capability: 'run_model', state: 'failed' })
    })
  })

  describe('run', () => {
    it('streams text in order with usage from response.completed, and keeps nothing at OpenAI', async () => {
      const deltas: string[] = []
      const r = await gpt.run(ask(OAI_KEY, MODEL, { onText: (d) => deltas.push(d) }))
      expect(deltas).toEqual(fake.state.chunks)
      expect(r).toEqual({
        status: 'completed',
        text: fake.state.chunks.join(''),
        usage: { inputTokens: 31, outputTokens: 12, source: 'reported' },
        requestId: 'req_fake_1',
        externalId: 'resp_fake1',
        model: `${MODEL}${OPENAI_SNAPSHOT_SUFFIX}`,
        stopReason: null,
        error: null
      })
      const sent = fake.requests[0]
      expect(sent.path).toBe('/v1/responses')
      expect(sent.json).toEqual({
        model: MODEL,
        input: ask(OAI_KEY, MODEL).messages,
        max_output_tokens: 256,
        instructions: 'Answer in one line.',
        store: false,
        stream: true
      })
      expect(sent.headers.authorization).toBe(`Bearer ${OAI_KEY}`)
      expect(sent.headers['idempotency-key']).toBeUndefined()
    })

    it('reads output[] message text without streaming, skipping non-message items', async () => {
      const r = await gpt.run(ask(OAI_KEY, MODEL, { system: '' }))
      expect(r).toMatchObject({
        status: 'completed',
        text: fake.state.chunks.join(''),
        usage: { inputTokens: 31, outputTokens: 12, source: 'reported' },
        externalId: 'resp_fake1',
        requestId: 'req_fake_1'
      })
      expect(fake.requests[0].json).toEqual({ model: MODEL, input: ask(OAI_KEY, MODEL).messages, max_output_tokens: 256, store: false })
    })

    it('passes metadata through and refuses metadata over OpenAI’s limits before sending', async () => {
      await gpt.run(ask(OAI_KEY, MODEL, { metadata: { plexii_run: 'run-1' } }))
      expect(fake.requests[0].json?.metadata).toEqual({ plexii_run: 'run-1' })
      const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))
      await providerError(gpt.run(ask(OAI_KEY, MODEL, { metadata: many })), 'bad_request')
      await providerError(gpt.run(ask(OAI_KEY, MODEL, { metadata: { k: 'x'.repeat(513) } })), 'bad_request')
      expect(fake.requests).toHaveLength(1)
    })

    it('reports response.failed as a failed run with the provider’s reason, scrubbed', async () => {
      // The connection's key is odd-shaped, so only exact-match scrubbing can
      // catch it; a key-shaped stranger is caught by the pattern.
      fake.state.key = ODD_KEY
      fake.state.mode = 'failed'
      fake.state.failMessage = `Upstream failed for ${ODD_KEY} near sk-proj-strangerkey123456`
      const r = await gpt.run(ask(ODD_KEY, MODEL, { onText: () => undefined }))
      expect(r.status).toBe('failed')
      expect(r.error).toBe('Upstream failed for [redacted] near [redacted]')
      expect(r.usage).toEqual({ inputTokens: 31, outputTokens: 12, source: 'reported' })
    })

    it('reports response.incomplete with its reason', async () => {
      fake.state.mode = 'incomplete'
      const deltas: string[] = []
      const r = await gpt.run(ask(OAI_KEY, MODEL, { onText: (d) => deltas.push(d) }))
      expect(r).toMatchObject({ status: 'incomplete', stopReason: 'max_output_tokens', text: deltas.join('') })
      const once = await gpt.run(ask(OAI_KEY, MODEL))
      expect(once).toMatchObject({ status: 'incomplete', stopReason: 'max_output_tokens' })
    })

    it('returns cancelled with the partial text when aborted mid-stream', async () => {
      fake.state.mode = 'stall'
      const ctrl = new AbortController()
      const r = await gpt.run(ask(OAI_KEY, MODEL, { signal: ctrl.signal, onText: () => ctrl.abort() }))
      expect(r).toMatchObject({ status: 'cancelled', text: fake.state.chunks[0], externalId: 'resp_fake1' })
      expect(r.usage).toEqual({ inputTokens: null, outputTokens: null, source: 'unavailable' })
      await waitFor(() => fake.abortedStreams === 1)
    })

    it('treats a stalled or truncated stream as unavailable and maps an error event', async () => {
      const quick = createOpenAIAdapter({ baseUrl: fake.url, allowLoopback: true, streamIdleTimeoutMs: 150 })
      fake.state.mode = 'stall'
      expect((await providerError(quick.run(ask(OAI_KEY, MODEL, { onText: () => undefined })), 'unavailable')).message).toMatch(/stalled/)
      fake.state.mode = 'truncated'
      expect((await providerError(gpt.run(ask(OAI_KEY, MODEL, { onText: () => undefined })), 'unavailable')).message).toMatch(/ended before/)
      fake.state.mode = 'error_event'
      const e = await providerError(gpt.run(ask(OAI_KEY, MODEL, { onText: () => undefined })), 'unavailable')
      expect(e.providerType).toBe('server_error')
    })
  })

  describe('error mapping', () => {
    const cases: Array<[OpenAIMode, ProviderErrorCode, number]> = [
      ['unauthorized', 'reconnect_required', 401],
      ['forbidden', 'insufficient_scope', 403],
      ['rate_limited', 'rate_limited', 429],
      ['insufficient_quota', 'quota', 429],
      ['server_error', 'unavailable', 500],
      ['unavailable_503', 'unavailable', 503],
      ['bad_request', 'bad_request', 400]
    ]
    for (const [mode, code, status] of cases) {
      it(`${mode} → ${code} (HTTP ${status}), streaming and not, with the key kept out`, async () => {
        fake.state.mode = mode
        for (const onText of [undefined, () => undefined]) {
          const e = await providerError(gpt.run(ask(OAI_KEY, MODEL, { onText })), code)
          expect(e.status).toBe(status)
          expect(e.providerId).toBe('openai')
          expect(e.requestId).toMatch(/^req_fake_\d+$/)
          expectNoKey(e, OAI_KEY)
        }
      })
    }

    it('reads retry-after on 429 and 503, and does not treat insufficient_quota as retryable', async () => {
      fake.state.mode = 'rate_limited'
      expect((await providerError(gpt.run(ask(OAI_KEY, MODEL)), 'rate_limited')).retryAfterMs).toBe(5_000)
      fake.state.mode = 'unavailable_503'
      fake.state.retryAfter = '2'
      expect((await providerError(gpt.run(ask(OAI_KEY, MODEL)), 'unavailable')).retryAfterMs).toBe(2_000)
      fake.state.mode = 'insufficient_quota'
      const q = await providerError(gpt.run(ask(OAI_KEY, MODEL)), 'quota')
      expect(isRetryable(q.code)).toBe(false)
    })

    it('keeps an odd-shaped key out of messages even when echoed in full', async () => {
      const e = await providerError(gpt.run(ask(ODD_KEY, MODEL)), 'reconnect_required')
      expect(e.message).toContain('[redacted]')
      expectNoKey(e, ODD_KEY)
    })
  })

  describe('background runs (the trackable agent)', () => {
    it('starts with background + store, returns the id, and polls queued → in_progress → completed', async () => {
      const deltas: string[] = []
      const started = await gpt.run(ask(OAI_KEY, MODEL, { background: true, onText: (d) => deltas.push(d) }))
      expect(started).toMatchObject({ status: 'queued', text: '', externalId: 'resp_fake1', usage: { source: 'unavailable' } })
      expect(deltas).toEqual([])
      expect(fake.requests[0].json).toMatchObject({ background: true, store: true })
      expect(fake.requests[0].json).not.toHaveProperty('stream')

      const id = started.externalId as string
      const second = await gpt.poll!(OAI_KEY, id)
      expect(second.status).toBe('in_progress')
      const done = await gpt.poll!(OAI_KEY, id)
      expect(done).toMatchObject({
        status: 'completed',
        text: fake.state.chunks.join(''),
        usage: { inputTokens: 31, outputTokens: 12, source: 'reported' },
        externalId: id,
        model: `${MODEL}${OPENAI_SNAPSHOT_SUFFIX}`
      })
      expect(done.requestId).toMatch(/^req_fake_\d+$/)
      expect(fake.requests.slice(1).map((q) => `${q.method} ${q.path}`)).toEqual([`GET /v1/responses/${id}`, `GET /v1/responses/${id}`])
      expect(fake.requests[1].headers.authorization).toBe(`Bearer ${OAI_KEY}`)
    })

    it('reports a background run that ends failed', async () => {
      const started = await gpt.run(ask(OAI_KEY, MODEL, { background: true }))
      fake.state.mode = 'failed'
      await gpt.poll!(OAI_KEY, started.externalId!)
      const end = await gpt.poll!(OAI_KEY, started.externalId!)
      expect(end).toMatchObject({ status: 'failed', error: fake.state.failMessage })
    })

    it('cancels by id with a bodyless POST, and later polls read cancelled', async () => {
      const started = await gpt.run(ask(OAI_KEY, MODEL, { background: true }))
      const id = started.externalId as string
      const c = await gpt.cancel!(OAI_KEY, id)
      expect(c.status).toBe('cancelled')
      const req = fake.requests[1]
      expect(`${req.method} ${req.path}`).toBe(`POST /v1/responses/${id}/cancel`)
      expect(req.body).toBe('')
      expect(req.headers['content-type']).toBeUndefined()
      expect((await gpt.poll!(OAI_KEY, id)).status).toBe('cancelled')
    })

    it('sends nothing for a background start whose signal is already aborted', async () => {
      const ctrl = new AbortController()
      ctrl.abort()
      const r = await gpt.run(ask(OAI_KEY, MODEL, { background: true, signal: ctrl.signal }))
      expect(r.status).toBe('cancelled')
      expect(fake.requests).toHaveLength(0)
    })

    it('rejects a malformed response id before any request is made', async () => {
      const bad = ['', '../models', 'resp_abc/../../v1/models', 'resp_', 'msg_123', 'resp_abc?x=1', 'resp_abc def', 'resp_%2e%2e', 'resp_a#b', `resp_${'a'.repeat(300)}`]
      for (const id of bad) {
        await providerError(gpt.poll!(OAI_KEY, id), 'bad_request')
        await providerError(gpt.cancel!(OAI_KEY, id), 'bad_request')
      }
      expect(fake.requests).toHaveLength(0)
    })

    it('maps an unknown response id to bad_request', async () => {
      await providerError(gpt.poll!(OAI_KEY, 'resp_doesnotexist'), 'bad_request')
    })
  })

  it('returns null for cost: there is no verified OpenAI price table', () => {
    expect(gpt.estimateCostMicros(MODEL, 1_000, 1_000)).toBeNull()
    expect(gpt.estimateCostMicros('gpt-5.4-mini', 0, 0)).toBeNull()
  })
})

// ── Endpoints and the network gate ───────────────────────────────────────────

describe('endpoints', () => {
  it('defaults to the providers’ public origins (stub fetch, nothing leaves the machine)', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> })
      const body = url.includes('anthropic')
        ? { data: [{ id: 'claude-sonnet-5-5' }], has_more: false }
        : { object: 'list', data: [{ id: 'gpt-5.5' }] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const resolve = async (): Promise<string[]> => ['203.0.113.10']
    const a = await createModelAdapter('anthropic', { fetchImpl, resolve, allowLoopback: false }).verify(ANT_KEY)
    const o = await createModelAdapter('openai', { fetchImpl, resolve, allowLoopback: false }).verify(OAI_KEY)
    expect(a.ok && o.ok).toBe(true)
    expect(seen.map((s) => s.url)).toEqual(['https://api.anthropic.com/v1/models?limit=100', 'https://api.openai.com/v1/models'])
    expect(seen[0].headers['x-api-key']).toBe(ANT_KEY)
    expect(seen[1].headers.authorization).toBe(`Bearer ${OAI_KEY}`)
  })

  it('refuses a loopback or plain-http base URL unless loopback is explicitly allowed', () => {
    expect(() => createAnthropicAdapter({ baseUrl: 'http://127.0.0.1:9', allowLoopback: false })).toThrow(/refused/)
    expect(() => createOpenAIAdapter({ baseUrl: 'http://api.openai.com', allowLoopback: false })).toThrow(/refused/)
    expect(() => createOpenAIAdapter({ baseUrl: 'https://10.0.0.5', allowLoopback: false })).toThrow(/refused/)
  })

  it('surfaces the gate refusing a host that resolves to a private address, untouched', async () => {
    const fetchImpl = (async () => {
      throw new Error('fetch must not be reached')
    }) as unknown as typeof fetch
    const adapter = createOpenAIAdapter({ fetchImpl, resolve: async () => ['10.1.2.3'], allowLoopback: false })
    const e = await caught(adapter.verify(OAI_KEY))
    expect((e as Error).name).toBe('EgressRefused')
    expect((e as { code?: string }).code).toBe('private_destination')
  })
})
