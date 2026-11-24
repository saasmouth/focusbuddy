// The Claude API adapter (Anthropic Messages + Models APIs), plain fetch through
// Plexii's network gate.
//
//  - verify lists models (GET /v1/models). It is free and read-only; no
//    message is ever sent to check a key.
//  - run calls POST /v1/messages, streaming when the caller wants text as it
//    arrives. Background runs are not offered in this release: the Messages API
//    has no run Plexii could poll or cancel later, so the adapter says
//    'unsupported' rather than pretending.
//  - cost comes from the verified Claude price table (src/main/ai/aiCost.ts).
//
// No Idempotency-Key is sent: the Messages API does not document one, so the
// adapter claims no duplicate protection. Plexii's run ledger provides it.

import { providerById } from '@shared/aispace/catalogue'
import { providerModels } from '../models'
import type { CapabilityHealth } from '@shared/aispace/connections'
import { PRICING, estimateCostMicros as claudeCostMicros } from '../../ai/aiCost'
import {
  type AdapterOptions,
  CallbackFailure,
  checkRequest,
  checkSecret,
  combineSignals,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  type ErrorBody,
  IdleWatch,
  buildProviderError,
  errorFromResponse,
  listedMatches,
  num,
  obj,
  parseEventData,
  readJson,
  readSse,
  str,
  Transport,
  usageOf
} from './http'
import {
  type ModelAdapter,
  type ModelRequest,
  type ModelResult,
  ProviderError,
  type ProviderErrorCode,
  type VerifyOptions,
  type VerifyResult
} from './types'

export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com'
export const ANTHROPIC_VERSION = '2023-06-01'
const NAME = 'Claude API'
const PROVIDER = 'anthropic' as const
// Anthropic sends `ping` events while a stream is open, so two quiet minutes
// means the stream is gone.
const DEFAULT_STREAM_IDLE_MS = 120_000
// 100 models a page; ten pages is far beyond any real account.
const MAX_MODEL_PAGES = 10
// A reply cut off by a limit is 'incomplete', the same word the OpenAI adapter
// uses for max_output_tokens, so the run view reads one way for both.
const INCOMPLETE_STOPS = new Set(['max_tokens', 'model_context_window_exceeded'])
// Answers about the key itself; anything else (rate limit, outage) says nothing
// about the key and is thrown from verify instead.
const DEFINITIVE: ReadonlySet<ProviderErrorCode> = new Set(['reconnect_required', 'insufficient_scope', 'quota'])

// Anthropic errors: {type:'error', error:{type, message}}. `status` is 0 for an
// `error` event inside a stream, where only the type is known.
export function classifyAnthropicError(status: number, body: ErrorBody): ProviderErrorCode {
  const type = body.type
  if (status === 401 || type === 'authentication_error') return 'reconnect_required'
  if (status === 402 || type === 'billing_error') return 'quota'
  // A spent prepaid balance arrives as a 400 invalid_request_error whose
  // message names the credit balance.
  if (body.message && /credit balance/i.test(body.message)) return 'quota'
  if (status === 403 || type === 'permission_error') return 'insufficient_scope'
  if (status === 429 || type === 'rate_limit_error') return 'rate_limited'
  if (status === 408 || status >= 500 || type === 'overloaded_error' || type === 'api_error' || type === 'timeout_error') {
    return 'unavailable'
  }
  if (status === 0) {
    return type === 'invalid_request_error' || type === 'not_found_error' || type === 'request_too_large' ? 'bad_request' : 'unavailable'
  }
  return 'bad_request'
}

export function createAnthropicAdapter(opts: AdapterOptions = {}): ModelAdapter {
  const t = new Transport(PROVIDER, NAME, ANTHROPIC_DEFAULT_BASE, 'request-id', opts)
  const requestTimeout = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const runTimeout = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const idleMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS
  const def = providerById(PROVIDER)
  const catalogue = def ? providerModels(def.id) : []
  const declared = def?.declaredCapabilities ?? ['run_model']

  const headers = (secret: string): Record<string, string> => ({
    'x-api-key': secret,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    accept: 'application/json'
  })

  function failedVerify(err: ProviderError, at: number): VerifyResult {
    return {
      ok: false,
      identity: null,
      providerOrg: null,
      models: [],
      capabilities: declared.map((capability): CapabilityHealth => ({ capability, state: 'failed', checkedAt: at, detail: err.message })),
      detail: err.message,
      billable: false,
      errorCode: err.code
    }
  }

  async function verify(secret: string, vopts: VerifyOptions = {}): Promise<VerifyResult> {
    const now = vopts.now ?? Date.now
    try {
      checkSecret(secret, PROVIDER, NAME)
    } catch (e) {
      if (e instanceof ProviderError) return failedVerify(e, now())
      throw e
    }
    const listed: string[] = []
    let org: string | null = null
    let after: string | null = null
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const q = new URLSearchParams({ limit: '100' })
      if (after) q.set('after_id', after)
      const res = await t.send(`/v1/models?${q}`, {
        method: 'GET',
        headers: headers(secret),
        signal: vopts.signal,
        timeoutMs: requestTimeout,
        secret
      })
      if (!res.ok) {
        const err = await errorFromResponse(t, res, secret, classifyAnthropicError)
        if (DEFINITIVE.has(err.code)) return failedVerify(err, now())
        throw err
      }
      // The organisation the key belongs to, straight from Anthropic's response
      // header. Absent → null; never guessed.
      org ??= res.headers.get('anthropic-organization-id')?.trim() || null
      const body = await readJson(res, t, secret)
      if (!Array.isArray(body.data)) {
        throw new ProviderError('unavailable', `The ${NAME} sent a model list Plexii couldn’t read.`, {
          providerId: PROVIDER,
          status: res.status,
          requestId: t.requestIdOf(res),
          secret
        })
      }
      for (const m of body.data) {
        const id = str(obj(m)?.id)
        if (id && !listed.includes(id)) listed.push(id)
      }
      const last = str(body.last_id)
      if (body.has_more === true && last && last !== after) after = last
      else break
    }

    const at = now()
    const found = catalogue.filter((m) => listed.some((l) => listedMatches(l, m.id)))
    const run: CapabilityHealth = found.length
      ? {
          capability: 'run_model',
          state: 'passed',
          checkedAt: at,
          detail: `Key accepted. Models available: ${found.map((m) => m.label).join(', ')}.`
        }
      : {
          capability: 'run_model',
          state: 'failed',
          checkedAt: at,
          detail: `Key accepted, but none of the models Plexii offers (${catalogue.map((m) => m.id).join(', ')}) are listed for it.`
        }
    const capabilities = declared.map(
      (capability): CapabilityHealth =>
        capability === 'run_model' ? run : { capability, state: 'untested', checkedAt: null, detail: 'Not checked by this adapter.' }
    )
    const who = org ? ` for organisation ${org}` : ''
    return {
      ok: found.length > 0,
      identity: org,
      providerOrg: org,
      models: listed,
      capabilities,
      detail: `${found.length ? `Key accepted${who}.` : `Key accepted${who}, but no Plexii model is available to it.`} ${found.length} of ${catalogue.length} Plexii models listed. Checked by listing models; no billable call was made.`,
      billable: false
    }
  }

  function cancelled(req: ModelRequest, partial: Partial<ModelResult> = {}): ModelResult {
    return {
      status: 'cancelled',
      text: partial.text ?? '',
      usage: partial.usage ?? usageOf(null, null),
      requestId: partial.requestId ?? null,
      externalId: partial.externalId ?? null,
      model: partial.model ?? req.model,
      stopReason: null,
      error: null
    }
  }

  function statusFor(stop: string | null): ModelResult['status'] {
    return stop && INCOMPLETE_STOPS.has(stop) ? 'incomplete' : 'completed'
  }

  async function runOnce(req: ModelRequest, body: Record<string, unknown>): Promise<ModelResult> {
    let res: Response
    try {
      res = await t.send('/v1/messages', {
        method: 'POST',
        headers: headers(req.secret),
        body: JSON.stringify(body),
        signal: req.signal,
        timeoutMs: runTimeout,
        secret: req.secret
      })
    } catch (e) {
      if (req.signal?.aborted) return cancelled(req)
      throw e
    }
    const requestId = t.requestIdOf(res)
    if (!res.ok) throw await errorFromResponse(t, res, req.secret, classifyAnthropicError)
    let json: Record<string, unknown>
    try {
      json = await readJson(res, t, req.secret)
    } catch (e) {
      if (req.signal?.aborted) return cancelled(req, { requestId })
      throw t.transportError(e, req.secret)
    }
    const content = Array.isArray(json.content) ? json.content : []
    const text = content
      .map(obj)
      .filter((b): b is Record<string, unknown> => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    const usage = obj(json.usage)
    const stop = str(json.stop_reason)
    return {
      status: statusFor(stop),
      text,
      usage: usageOf(num(usage?.input_tokens), num(usage?.output_tokens)),
      requestId,
      externalId: str(json.id),
      model: str(json.model) ?? req.model,
      stopReason: stop,
      error: null
    }
  }

  async function runStream(req: ModelRequest, body: Record<string, unknown>, onText: (d: string) => void): Promise<ModelResult> {
    const idle = new IdleWatch(idleMs)
    let text = ''
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let externalId: string | null = null
    let model: string | null = null
    let stop: string | null = null
    let requestId: string | null = null
    let finished = false
    const sofar = (): Partial<ModelResult> => ({
      text,
      usage: usageOf(inputTokens, outputTokens),
      requestId,
      externalId,
      model: model ?? req.model
    })
    idle.start()
    try {
      const res = await t.send('/v1/messages', {
        method: 'POST',
        headers: { ...headers(req.secret), accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: combineSignals(req.signal, idle.signal),
        timeoutMs: runTimeout,
        secret: req.secret
      })
      requestId = t.requestIdOf(res)
      if (!res.ok) throw await errorFromResponse(t, res, req.secret, classifyAnthropicError)
      if (!res.body) throw new ProviderError('unavailable', `The ${NAME} sent an empty stream.`, { providerId: PROVIDER, requestId, secret: req.secret })
      for await (const ev of readSse(res.body, () => idle.touch())) {
        const d = parseEventData(ev)
        if (!d) continue
        switch (str(d.type) ?? ev.event) {
          case 'message_start': {
            const m = obj(d.message)
            externalId = str(m?.id) ?? externalId
            model = str(m?.model) ?? model
            inputTokens = num(obj(m?.usage)?.input_tokens) ?? inputTokens
            break
          }
          case 'content_block_delta': {
            const delta = obj(d.delta)
            if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              text += delta.text
              try {
                onText(delta.text)
              } catch (e) {
                throw new CallbackFailure(e)
              }
            }
            break
          }
          case 'message_delta': {
            stop = str(obj(d.delta)?.stop_reason) ?? stop
            const u = obj(d.usage)
            // Both counts in message_delta are cumulative for the message.
            outputTokens = num(u?.output_tokens) ?? outputTokens
            inputTokens = num(u?.input_tokens) ?? inputTokens
            break
          }
          case 'message_stop':
            finished = true
            break
          case 'error': {
            const e = obj(d.error)
            const eb: ErrorBody = { message: str(e?.message), type: str(e?.type), code: null }
            throw buildProviderError(t, classifyAnthropicError(0, eb), eb, { status: null, retryAfterMs: null, requestId, secret: req.secret })
          }
          default:
            break
        }
        if (finished) break
      }
    } catch (e) {
      if (e instanceof CallbackFailure) throw e.original
      if (req.signal?.aborted) return cancelled(req, sofar())
      if (idle.fired) {
        throw new ProviderError('unavailable', `The ${NAME} stream stalled: nothing arrived for ${Math.round(idleMs / 1000)} s.`, {
          providerId: PROVIDER,
          requestId,
          secret: req.secret
        })
      }
      throw t.transportError(e, req.secret)
    } finally {
      idle.stop()
    }
    if (!finished) {
      if (req.signal?.aborted) return cancelled(req, sofar())
      throw new ProviderError('unavailable', `The ${NAME} stream ended before the reply finished.`, {
        providerId: PROVIDER,
        requestId,
        secret: req.secret
      })
    }
    return {
      status: statusFor(stop),
      text,
      usage: usageOf(inputTokens, outputTokens),
      requestId,
      externalId,
      model: model ?? req.model,
      stopReason: stop,
      error: null
    }
  }

  async function run(req: ModelRequest): Promise<ModelResult> {
    checkRequest(req, PROVIDER, NAME)
    if (req.background) {
      throw new ProviderError(
        'unsupported',
        'The Claude API connection doesn’t offer background runs (track, cancel, resume) in this release. Run it in the foreground.',
        { providerId: PROVIDER, secret: req.secret }
      )
    }
    if (req.signal?.aborted) return cancelled(req)
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content }))
    }
    if (req.system.trim()) body.system = req.system
    // The Messages API accepts only user_id in metadata.
    const userId = req.metadata?.user_id
    if (userId) body.metadata = { user_id: userId }
    const onText = req.onText
    if (typeof onText === 'function') {
      body.stream = true
      return runStream(req, body, onText)
    }
    return runOnce(req, body)
  }

  // Micro-dollars from the verified Claude table. A model no row of that table
  // recognises returns null rather than aiCost's middle-tier default, which
  // would be a guess presented as an estimate.
  function estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number | null {
    if (typeof model !== 'string' || /^local:/.test(model)) return null
    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null
    if (!PRICING.some((p) => p.match.test(model))) return null
    return claudeCostMicros(model, inputTokens, outputTokens)
  }

  return { providerId: PROVIDER, verify, run, estimateCostMicros }
}
