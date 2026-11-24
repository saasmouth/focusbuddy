// Shared plumbing for the model adapters: one guarded transport, error-body
// parsing, Retry-After, request validation, and a Server-Sent Events reader
// with stall detection.
//
// Nothing in this file knows a provider's error vocabulary; each adapter maps
// (status, type, message) to a ProviderErrorCode itself.

import { validateEndpoint } from '@shared/aispace/netPolicy'
import { EgressRefused, guardedFetch, loopbackAllowedByEnv } from '../net'
import { type ModelProviderId, type ModelRequest, ProviderError, type ProviderErrorCode, scrubSecret } from './types'

// ── Options ──────────────────────────────────────────────────────────────────

export interface AdapterOptions {
  // Defaults to the provider's public API. Tests point this at a 127.0.0.1
  // server and set allowLoopback.
  baseUrl?: string
  allowLoopback?: boolean
  fetchImpl?: typeof fetch
  resolve?: (host: string) => Promise<string[]>
  // verify, poll, cancel and background starts. Default 30 s.
  requestTimeoutMs?: number
  // A whole foreground run, including every byte of a stream. Default 10 min.
  runTimeoutMs?: number
  // A stream that sends nothing (not even a ping) for this long is treated as
  // stalled and abandoned. Also bounds the wait for a stream's first byte.
  streamIdleTimeoutMs?: number
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000

// ── Transport ────────────────────────────────────────────────────────────────

export interface SendInit {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs: number
  secret: string
}

export class Transport {
  readonly base: string
  readonly origin: string

  constructor(
    readonly providerId: ModelProviderId,
    readonly providerName: string,
    defaultBase: string,
    private readonly requestIdHeader: string,
    private readonly opts: AdapterOptions
  ) {
    const raw = (opts.baseUrl ?? defaultBase).replace(/\/+$/, '')
    const allowLoopback = opts.allowLoopback ?? loopbackAllowedByEnv()
    const v = validateEndpoint(raw, { allowLoopback })
    if (!v.ok || !v.url) throw new Error(`${providerName}: base URL refused. ${v.reason}`)
    if (v.url.search) throw new Error(`${providerName}: base URL may not carry a query string.`)
    this.origin = v.url.origin
    this.base = `${v.url.origin}${v.url.pathname.replace(/\/+$/, '')}`
  }

  requestIdOf(res: Response): string | null {
    return res.headers.get(this.requestIdHeader)?.trim() || null
  }

  // One request through the network gate, origin-pinned. Transport failures
  // become ProviderError('unavailable'); Plexii's own policy refusals (the
  // gate refusing a redirect or a private address, local-only AI mode) are
  // rethrown untouched because they are not a provider condition. An abort by
  // the caller's signal is rethrown as-is for the caller to interpret.
  async send(path: string, init: SendInit): Promise<Response> {
    try {
      return await guardedFetch(
        this.base + path,
        { method: init.method, headers: init.headers, body: init.body, signal: init.signal },
        {
          allowedOrigin: this.origin,
          allowLoopback: this.opts.allowLoopback,
          timeoutMs: init.timeoutMs,
          fetchImpl: this.opts.fetchImpl,
          resolve: this.opts.resolve
        }
      )
    } catch (e) {
      if (init.signal?.aborted) throw e
      throw this.transportError(e, init.secret)
    }
  }

  transportError(e: unknown, secret: string): Error {
    if (e instanceof ProviderError) return e
    if (e instanceof EgressRefused) {
      // invalid_endpoint can only mean a failed DNS lookup here: the base URL
      // was validated when the adapter was built.
      if (e.code === 'timeout' || e.code === 'invalid_endpoint') {
        return new ProviderError('unavailable', `Couldn’t reach the ${this.providerName}. ${e.message}`, {
          providerId: this.providerId,
          secret
        })
      }
      return e
    }
    if (e instanceof Error && e.name === 'LocalOnlyEgressError') return e
    return new ProviderError('unavailable', `Couldn’t reach the ${this.providerName}: ${describeNetworkError(e)}`, {
      providerId: this.providerId,
      secret
    })
  }
}

function describeNetworkError(e: unknown): string {
  if (!(e instanceof Error)) return 'network error.'
  if (e.name === 'TimeoutError') return 'no answer in time.'
  const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause
  const code = cause && typeof cause.code === 'string' ? cause.code : null
  return code ? `${e.message} (${code}).` : `${e.message}.`
}

// ── Response bodies ──────────────────────────────────────────────────────────

const MAX_ERROR_BODY = 32 * 1024
export const MAX_JSON_BODY = 8 * 1024 * 1024

export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        out += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))), { stream: true })
        break
      }
      out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return out
}

// Parse a success body as JSON. A body Plexii can't read is 'unavailable' (the
// provider or something in between sent something unexpected).
export async function readJson(res: Response, t: Transport, secret: string): Promise<Record<string, unknown>> {
  const text = await readCappedText(res, MAX_JSON_BODY)
  try {
    const v = JSON.parse(text) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* fall through */
  }
  throw new ProviderError('unavailable', `The ${t.providerName} sent a response Plexii couldn’t read (HTTP ${res.status}).`, {
    providerId: t.providerId,
    status: res.status,
    requestId: t.requestIdOf(res),
    secret
  })
}

export interface ErrorBody {
  message: string | null
  type: string | null
  code: string | null
}

// Both providers nest the useful part under `error`. Anthropic:
// {type:'error', error:{type, message}}. OpenAI: {error:{message, type, code}}.
export function parseErrorBody(text: string): ErrorBody {
  try {
    const v = JSON.parse(text) as { error?: unknown; message?: unknown; type?: unknown; code?: unknown }
    const e = (v && typeof v.error === 'object' && v.error ? v.error : v) as Record<string, unknown>
    return {
      message: typeof e.message === 'string' ? e.message : null,
      type: typeof e.type === 'string' ? e.type : null,
      code: typeof e.code === 'string' ? e.code : null
    }
  } catch {
    return { message: text.trim() ? text.trim().slice(0, 300) : null, type: null, code: null }
  }
}

export async function readErrorBody(res: Response): Promise<ErrorBody> {
  let text = ''
  try {
    text = await readCappedText(res, MAX_ERROR_BODY)
  } catch {
    /* the status alone still classifies the error */
  }
  return parseErrorBody(text)
}

const FRIENDLY: Record<ProviderErrorCode, string> = {
  reconnect_required: 'rejected this key (invalid, expired or revoked). Reconnect with a working key.',
  insufficient_scope: 'accepted this key, but it doesn’t have permission for this.',
  rate_limited: 'is rate limiting this key. Try again shortly.',
  unavailable: 'is temporarily unavailable.',
  quota: 'says this account is out of credit or over its billing limit.',
  bad_request: 'refused the request.',
  unsupported: 'doesn’t support this.'
}

export type ErrorClassifier = (status: number, body: ErrorBody) => ProviderErrorCode

export function buildProviderError(
  t: Transport,
  code: ProviderErrorCode,
  body: ErrorBody,
  extra: { status: number | null; retryAfterMs: number | null; requestId: string | null; secret: string }
): ProviderError {
  // Scrub BEFORE clipping, so a cut can never leave half a key behind.
  const said = body.message ? ` It said: “${clip(scrubSecret(body.message, extra.secret))}”` : ''
  const where = extra.status ? ` (HTTP ${extra.status})` : ''
  return new ProviderError(code, `The ${t.providerName} ${FRIENDLY[code]}${said}${where}`, {
    providerId: t.providerId,
    status: extra.status,
    retryAfterMs: extra.retryAfterMs,
    providerType: body.code ?? body.type,
    requestId: extra.requestId,
    secret: extra.secret
  })
}

export async function errorFromResponse(t: Transport, res: Response, secret: string, classify: ErrorClassifier): Promise<ProviderError> {
  const body = await readErrorBody(res)
  return buildProviderError(t, classify(res.status, body), body, {
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers),
    requestId: t.requestIdOf(res),
    secret
  })
}

// Retry-After in ms: `retry-after-ms` (OpenAI), else `retry-after` as seconds
// or an HTTP date. null when absent or unreadable.
export function parseRetryAfter(headers: Headers, now = Date.now()): number | null {
  const ms = headers.get('retry-after-ms')
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms.trim()))
  const ra = headers.get('retry-after')?.trim()
  if (!ra) return null
  if (/^\d+(\.\d+)?$/.test(ra)) return Math.round(Number(ra) * 1000)
  const at = Date.parse(ra)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

export function clip(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ── Validation (before anything is sent) ─────────────────────────────────────

// API keys are printable ASCII with no spaces. Anything else could not be a
// valid header value and would fail as a confusing network error.
const KEY_CHARS = /^[\x21-\x7e]+$/

export function checkSecret(secret: unknown, providerId: ModelProviderId, providerName: string): asserts secret is string {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new ProviderError('reconnect_required', `No key is stored for this ${providerName} connection.`, { providerId })
  }
  if (!KEY_CHARS.test(secret)) {
    throw new ProviderError(
      'reconnect_required',
      `The stored ${providerName} key contains spaces or characters a key can’t contain. Paste it again.`,
      { providerId, secret }
    )
  }
}

export function checkRequest(req: ModelRequest, providerId: ModelProviderId, providerName: string): void {
  checkSecret(req.secret, providerId, providerName)
  const bad = (why: string): never => {
    throw new ProviderError('bad_request', `${providerName}: ${why}`, { providerId, secret: req.secret })
  }
  if (typeof req.model !== 'string' || !req.model.trim() || req.model.length > 256) bad('choose a model.')
  if (typeof req.system !== 'string') bad('the system prompt must be text.')
  if (!Array.isArray(req.messages) || req.messages.length === 0) bad('there is no message to send.')
  for (const m of req.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) bad('every message must be from the user or the assistant.')
    if (typeof m.content !== 'string' || !m.content.trim()) bad('a message is empty.')
  }
  if (!Number.isInteger(req.maxOutputTokens) || req.maxOutputTokens < 1) bad('the output limit must be a whole number above zero.')
  if (req.metadata !== undefined) {
    if (!req.metadata || typeof req.metadata !== 'object') bad('metadata must be a set of text pairs.')
    for (const [k, v] of Object.entries(req.metadata)) {
      if (typeof v !== 'string') bad(`metadata "${clip(k, 64)}" must be text.`)
    }
  }
}

// ── Catalogue matching ───────────────────────────────────────────────────────

// A catalogue id matches a listed id exactly, or a dated snapshot of it
// (claude-x-20261001, gpt-x-2026-10-01). Nothing looser: a near-miss id is a
// different model.
export function listedMatches(listedId: string, catalogueId: string): boolean {
  if (listedId === catalogueId) return true
  if (!listedId.startsWith(`${catalogueId}-`)) return false
  return /^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(listedId.slice(catalogueId.length + 1))
}

// ── Stall detection ──────────────────────────────────────────────────────────

export class IdleWatch {
  private readonly ctrl = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly ms: number) {}

  get signal(): AbortSignal {
    return this.ctrl.signal
  }

  get fired(): boolean {
    return this.ctrl.signal.aborted
  }

  start(): void {
    this.stop()
    this.timer = setTimeout(() => this.ctrl.abort(new Error('stream idle')), this.ms)
  }

  touch(): void {
    if (this.timer && !this.fired) this.start()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const s = signals.filter((x): x is AbortSignal => Boolean(x))
  if (s.length === 0) return undefined
  return s.length === 1 ? s[0] : AbortSignal.any(s)
}

// ── Server-Sent Events ───────────────────────────────────────────────────────

export interface SseEvent {
  event: string
  data: string
}

// Reads an SSE body per the WHATWG event-stream rules: LF, CRLF or CR line
// ends (including a CR at a chunk boundary), multi-line data, comments, and
// UTF-8 split across chunks. `onBytes` fires for every chunk, comments and
// pings included, so a quiet-but-alive stream is not mistaken for a stall.
// Leaving the loop early cancels the body, which closes the connection.
export async function* readSse(body: ReadableStream<Uint8Array>, onBytes?: () => void): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let eventName = ''
  let data: string[] = []
  let finished = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        finished = true
        break
      }
      onBytes?.()
      buf += decoder.decode(value, { stream: true })
      let start = 0
      let i = 0
      while (i < buf.length) {
        const c = buf.charCodeAt(i)
        if (c !== 10 && c !== 13) {
          i++
          continue
        }
        // A CR as the last char may be the first half of a CRLF: wait for more.
        if (c === 13 && i === buf.length - 1) break
        const line = buf.slice(start, i)
        i += c === 13 && buf.charCodeAt(i + 1) === 10 ? 2 : 1
        start = i
        if (line === '') {
          if (data.length > 0) yield { event: eventName || 'message', data: data.join('\n') }
          eventName = ''
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let val = colon === -1 ? '' : line.slice(colon + 1)
        if (val.startsWith(' ')) val = val.slice(1)
        if (field === 'event') eventName = val
        else if (field === 'data') data.push(val)
      }
      buf = buf.slice(start)
    }
    // An event not ended by a blank line at end-of-stream is discarded (spec).
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    else reader.releaseLock()
  }
}

export function parseEventData(ev: SseEvent): Record<string, unknown> | null {
  try {
    const v = JSON.parse(ev.data) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Wraps an exception thrown by the caller's onText so it is rethrown as the
// caller's own error, never misreported as a provider or network failure.
export class CallbackFailure extends Error {
  constructor(readonly original: unknown) {
    super('onText threw')
  }
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function usageOf(inputTokens: number | null, outputTokens: number | null): {
  inputTokens: number | null
  outputTokens: number | null
  source: 'reported' | 'unavailable'
} {
  return {
    inputTokens,
    outputTokens,
    source: inputTokens !== null || outputTokens !== null ? 'reported' : 'unavailable'
  }
}

export { scrubSecret }
