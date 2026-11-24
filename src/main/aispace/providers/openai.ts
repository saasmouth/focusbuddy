// The OpenAI API adapter (Responses + Models APIs), plain fetch through
// Plexii's network gate.
//
//  - verify lists models (GET /v1/models): free and read-only. Track, cancel
//    and resume can't be checked without starting a billable background run,
//    so verify reports them 'untested' and says so.
//  - run calls POST /v1/responses. Foreground runs send store:false, so OpenAI
//    does not keep the conversation for later retrieval (nothing needs it).
//  - background:true is the trackable agent: the run is created with
//    background:true + store:true, keeps going at OpenAI after Plexii closes,
//    and is picked up again by id with poll (GET /v1/responses/{id}) and
//    stopped with cancel (POST /v1/responses/{id}/cancel).
//  - estimateCostMicros returns null: this codebase has no verified OpenAI price
//    table, so cost shows as Unavailable while tokens are still reported. Add a
//    verified, test-pinned table (like src/main/ai/aiCost.ts) before changing it.
//
// No Idempotency-Key header is sent. Whether /v1/responses honours one is not
// documented clearly enough to rely on, so no duplicate protection is claimed;
// Plexii's run ledger records the key before dispatch and reconciles by id.

import { providerById } from '@shared/aispace/catalogue'
import type { CapabilityHealth } from '@shared/aispace/connections'
import {
  type AdapterOptions,
  CallbackFailure,
  checkRequest,
  checkSecret,
  clip,
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
  scrubSecret,
  str,
  Transport,
  usageOf
} from './http'
import {
  type ModelAdapter,
  type ModelRequest,
  type ModelResult,
  type ModelRunStatus,
  type PollOptions,
  ProviderError,
  type ProviderErrorCode,
  type VerifyOptions,
  type VerifyResult
} from './types'

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com'
const NAME = 'OpenAI API'
const PROVIDER = 'openai' as const
// OpenAI sends no keep-alive pings, and a reasoning model can think for a while
// before its first text, so the stall window is wider than Anthropic's.
const DEFAULT_STREAM_IDLE_MS = 300_000
const DEFINITIVE: ReadonlySet<ProviderErrorCode> = new Set(['reconnect_required', 'insufficient_scope', 'quota'])
const BACKGROUND_CAPS = new Set(['track_run', 'cancel_run', 'resume_run'])
export const BACKGROUND_UNTESTED_DETAIL =
  'Checked on the first background run. It can’t be checked here without starting a billable run.'

// A response id goes into a URL path, so only this exact shape is accepted.
export const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]+$/

export function isResponseId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 200 && RESPONSE_ID_PATTERN.test(id)
}

const STATUS: Record<string, ModelRunStatus> = {
  queued: 'queued',
  in_progress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  incomplete: 'incomplete'
}

// OpenAI errors: {error:{message, type, param, code}}. `status` is 0 for an
// `error` event inside a stream.
export function classifyOpenAIError(status: number, body: ErrorBody): ProviderErrorCode {
  const { type, code } = body
  if (status === 401 || code === 'invalid_api_key') return 'reconnect_required'
  // Out of credit arrives as a 429 with code insufficient_quota: not a rate
  // limit, and retrying will not help.
  if (code === 'insufficient_quota' || type === 'insufficient_quota' || status === 402) return 'quota'
  if (status === 403) return 'insufficient_scope'
  if (status === 429 || code === 'rate_limit_exceeded') return 'rate_limited'
  if (status === 408 || status >= 500 || code === 'server_error' || type === 'server_error') return 'unavailable'
  if (status === 0) return type === 'invalid_request_error' ? 'bad_request' : 'unavailable'
  return 'bad_request'
}

// Text from a response's output: message items → output_text parts. Refusal
// parts are kept as text (the person should see why) and flagged.
function extractOutput(output: unknown): { text: string; refused: boolean } {
  let text = ''
  let refused = false
  if (!Array.isArray(output)) return { text, refused }
  for (const item of output) {
    const it = obj(item)
    if (it?.type !== 'message' || !Array.isArray(it.content)) continue
    for (const part of it.content) {
      const p = obj(part)
      if (p?.type === 'output_text' && typeof p.text === 'string') text += p.text
      else if (p?.type === 'refusal' && typeof p.refusal === 'string') {
        text += p.refusal
        refused = true
      }
    }
  }
  return { text, refused }
}

export function createOpenAIAdapter(opts: AdapterOptions = {}): ModelAdapter {
  const t = new Transport(PROVIDER, NAME, OPENAI_DEFAULT_BASE, 'x-request-id', opts)
  const requestTimeout = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const runTimeout = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const idleMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS
  const def = providerById(PROVIDER)
  const catalogue = def?.models ?? []
  const declared = def?.declaredCapabilities ?? ['run_model', 'track_run', 'cancel_run', 'resume_run']

  const headers = (secret: string, json = true): Record<string, string> => ({
    authorization: `Bearer ${secret}`,
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {})
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
    const res = await t.send('/v1/models', {
      method: 'GET',
      headers: headers(secret, false),
      signal: vopts.signal,
      timeoutMs: requestTimeout,
      secret
    })
    if (!res.ok) {
      const err = await errorFromResponse(t, res, secret, classifyOpenAIError)
      if (DEFINITIVE.has(err.code)) return failedVerify(err, now())
      throw err
    }
    // The organisation OpenAI says the key belongs to. Absent → null.
    const org = res.headers.get('openai-organization')?.trim() || null
    const body = await readJson(res, t, secret)
    if (!Array.isArray(body.data)) {
      throw new ProviderError('unavailable', `The ${NAME} sent a model list Plexii couldn’t read.`, {
        providerId: PROVIDER,
        status: res.status,
        requestId: t.requestIdOf(res),
        secret
      })
    }
    const listed: string[] = []
    for (const m of body.data) {
      const id = str(obj(m)?.id)
      if (id && !listed.includes(id)) listed.push(id)
    }
    const at = now()
    const found = catalogue.filter((m) => listed.some((l) => listedMatches(l, m.id)))
    const capabilities = declared.map((capability): CapabilityHealth => {
      if (capability === 'run_model') {
        return found.length
          ? { capability, state: 'passed', checkedAt: at, detail: `Key accepted. Models available: ${found.map((m) => m.label).join(', ')}.` }
          : {
              capability,
              state: 'failed',
              checkedAt: at,
              detail: `Key accepted, but none of the models Plexii offers (${catalogue.map((m) => m.id).join(', ')}) are listed for it.`
            }
      }
      if (BACKGROUND_CAPS.has(capability)) return { capability, state: 'untested', checkedAt: null, detail: BACKGROUND_UNTESTED_DETAIL }
      return { capability, state: 'untested', checkedAt: null, detail: 'Not checked by this adapter.' }
    })
    const who = org ? ` for organisation ${org}` : ''
    return {
      ok: found.length > 0,
      identity: org,
      providerOrg: org,
      models: listed,
      capabilities,
      detail: `${found.length ? `Key accepted${who}.` : `Key accepted${who}, but no Plexii model is available to it.`} ${found.length} of ${catalogue.length} Plexii models listed. Background run features are checked on the first background run. Checked by listing models; no billable call was made.`,
      billable: false
    }
  }

  // A response object (POST, GET, cancel, or a stream's terminal event) as a
  // ModelResult. An unknown status is thrown rather than guessed at, so a
  // poller keeps the run in its last known state and asks again.
  function fromResponse(json: Record<string, unknown>, requestId: string | null, fallbackModel: string, secret: string, streamed = ''): ModelResult {
    const raw = str(json.status)
    const status = raw ? STATUS[raw] : undefined
    if (!status) {
      throw new ProviderError('unavailable', `The ${NAME} reported a run status Plexii doesn’t know (“${clip(String(json.status), 40)}”).`, {
        providerId: PROVIDER,
        requestId,
        secret
      })
    }
    const out = extractOutput(json.output)
    const u = obj(json.usage)
    const reason = str(obj(json.incomplete_details)?.reason)
    const errMsg = str(obj(json.error)?.message)
    return {
      status,
      text: out.text || streamed,
      usage: usageOf(num(u?.input_tokens), num(u?.output_tokens)),
      requestId,
      externalId: str(json.id),
      model: str(json.model) ?? fallbackModel,
      stopReason: status === 'incomplete' ? reason : out.refused ? 'refusal' : null,
      error: status === 'failed' ? scrubSecret(clip(errMsg ?? 'The run failed and OpenAI gave no reason.', 500), secret) : null
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

  function baseBody(req: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      input: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: req.maxOutputTokens
    }
    if (req.system.trim()) body.instructions = req.system
    if (req.metadata && Object.keys(req.metadata).length) body.metadata = req.metadata
    return body
  }

  function checkMetadata(req: ModelRequest): void {
    if (!req.metadata) return
    const entries = Object.entries(req.metadata)
    const bad = (why: string): never => {
      throw new ProviderError('bad_request', `${NAME}: ${why}`, { providerId: PROVIDER, secret: req.secret })
    }
    if (entries.length > 16) bad('metadata can hold at most 16 pairs.')
    for (const [k, v] of entries) {
      if (k.length > 64) bad('a metadata key is longer than 64 characters.')
      if (v.length > 512) bad('a metadata value is longer than 512 characters.')
    }
  }

  // Background start. The request itself is not abortable mid-flight: once
  // sent, OpenAI may already have created the run, and abandoning the reply
  // would leave a billable run Plexii can't see. An already-aborted signal
  // sends nothing; otherwise stop it with cancel(id) once this returns.
  async function runBackground(req: ModelRequest): Promise<ModelResult> {
    const body = { ...baseBody(req), background: true, store: true }
    const res = await t.send('/v1/responses', {
      method: 'POST',
      headers: headers(req.secret),
      body: JSON.stringify(body),
      timeoutMs: requestTimeout,
      secret: req.secret
    })
    if (!res.ok) throw await errorFromResponse(t, res, req.secret, classifyOpenAIError)
    const requestId = t.requestIdOf(res)
    const result = fromResponse(await readJson(res, t, req.secret), requestId, req.model, req.secret)
    if (!isResponseId(result.externalId)) {
      throw new ProviderError(
        'unavailable',
        `The ${NAME} started a background run but returned an id Plexii can’t track (“${clip(String(result.externalId), 60)}”). Check the OpenAI dashboard before starting it again.`,
        { providerId: PROVIDER, requestId, secret: req.secret }
      )
    }
    return result
  }

  async function runOnce(req: ModelRequest): Promise<ModelResult> {
    const body = { ...baseBody(req), store: false }
    let res: Response
    try {
      res = await t.send('/v1/responses', {
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
    if (!res.ok) throw await errorFromResponse(t, res, req.secret, classifyOpenAIError)
    let json: Record<string, unknown>
    try {
      json = await readJson(res, t, req.secret)
    } catch (e) {
      if (req.signal?.aborted) return cancelled(req, { requestId })
      throw t.transportError(e, req.secret)
    }
    return fromResponse(json, requestId, req.model, req.secret)
  }

  async function runStream(req: ModelRequest, onText: (d: string) => void): Promise<ModelResult> {
    const body = { ...baseBody(req), store: false, stream: true }
    const idle = new IdleWatch(idleMs)
    let text = ''
    let externalId: string | null = null
    let model: string | null = null
    let requestId: string | null = null
    let final: Record<string, unknown> | null = null
    const sofar = (): Partial<ModelResult> => ({ text, requestId, externalId, model: model ?? req.model })
    idle.start()
    try {
      const res = await t.send('/v1/responses', {
        method: 'POST',
        headers: { ...headers(req.secret), accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: combineSignals(req.signal, idle.signal),
        timeoutMs: runTimeout,
        secret: req.secret
      })
      requestId = t.requestIdOf(res)
      if (!res.ok) throw await errorFromResponse(t, res, req.secret, classifyOpenAIError)
      if (!res.body) throw new ProviderError('unavailable', `The ${NAME} sent an empty stream.`, { providerId: PROVIDER, requestId, secret: req.secret })
      for await (const ev of readSse(res.body, () => idle.touch())) {
        const d = parseEventData(ev)
        if (!d) continue
        const type = str(d.type) ?? ev.event
        switch (type) {
          case 'response.created':
          case 'response.queued':
          case 'response.in_progress': {
            const r = obj(d.response)
            externalId = str(r?.id) ?? externalId
            model = str(r?.model) ?? model
            break
          }
          case 'response.output_text.delta':
          case 'response.refusal.delta': {
            if (typeof d.delta === 'string' && d.delta) {
              text += d.delta
              try {
                onText(d.delta)
              } catch (e) {
                throw new CallbackFailure(e)
              }
            }
            break
          }
          case 'response.completed':
          case 'response.incomplete':
          case 'response.failed': {
            const r = obj(d.response) ?? {}
            // The terminal event names the outcome even if its object omits it.
            final = { ...r, status: r.status ?? type.slice('response.'.length) }
            break
          }
          case 'error': {
            const e = obj(d.error) ?? d
            const eb: ErrorBody = { message: str(e.message), type: str(e.type) === 'error' ? null : str(e.type), code: str(e.code) }
            throw buildProviderError(t, classifyOpenAIError(0, eb), eb, { status: null, retryAfterMs: null, requestId, secret: req.secret })
          }
          default:
            break
        }
        if (final) break
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
    if (!final) {
      if (req.signal?.aborted) return cancelled(req, sofar())
      throw new ProviderError('unavailable', `The ${NAME} stream ended before the reply finished.`, {
        providerId: PROVIDER,
        requestId,
        secret: req.secret
      })
    }
    return fromResponse(final, requestId, model ?? req.model, req.secret, text)
  }

  async function run(req: ModelRequest): Promise<ModelResult> {
    checkRequest(req, PROVIDER, NAME)
    checkMetadata(req)
    if (req.signal?.aborted) return cancelled(req)
    if (req.background) return runBackground(req)
    const onText = req.onText
    return typeof onText === 'function' ? runStream(req, onText) : runOnce(req)
  }

  function checkId(secret: string, id: unknown): asserts id is string {
    if (!isResponseId(id)) {
      throw new ProviderError('bad_request', `${NAME}: “${clip(String(id), 60)}” isn’t a response id Plexii can look up.`, {
        providerId: PROVIDER,
        secret
      })
    }
  }

  async function byId(secret: string, id: string, method: 'GET' | 'POST', suffix: string, popts: PollOptions): Promise<ModelResult> {
    checkSecret(secret, PROVIDER, NAME)
    checkId(secret, id)
    const res = await t.send(`/v1/responses/${id}${suffix}`, {
      method,
      // cancel has no body, so no content-type is sent with it.
      headers: headers(secret, false),
      signal: popts.signal,
      timeoutMs: requestTimeout,
      secret
    })
    if (!res.ok) throw await errorFromResponse(t, res, secret, classifyOpenAIError)
    return fromResponse(await readJson(res, t, secret), t.requestIdOf(res), '', secret)
  }

  const poll = (secret: string, externalId: string, popts: PollOptions = {}): Promise<ModelResult> =>
    byId(secret, externalId, 'GET', '', popts)
  const cancel = (secret: string, externalId: string, popts: PollOptions = {}): Promise<ModelResult> =>
    byId(secret, externalId, 'POST', '/cancel', popts)

  // No verified OpenAI price table exists in this codebase: cost is shown as
  // Unavailable rather than estimated from unverified numbers.
  function estimateCostMicros(): number | null {
    return null
  }

  return { providerId: PROVIDER, verify, run, poll, cancel, estimateCostMicros }
}
