// Running one direct app-API operation (SPEC-CONNECTIONS.md §5, §7 retries).
//
// invokeOperation does NOT decide whether a call is allowed: grants, approvals
// and policy are the caller's job (shared/aispace/policy.ts canInvoke). It does
// everything between "allowed" and "here is the result":
//
//   1. find the operation; validate input against its schema BEFORE any request
//      (unknown properties are refused: every input schema is closed);
//   2. take a token from the (connection, operation) bucket, failing fast with
//      retryAfterMs when empty (see rateLimit.ts);
//   3. run the operation, whose requests can only be built from an ApiPath and
//      go through guardedFetch pinned to the adapter's one origin, with the
//      adapter's own headers, a per-request timeout and redirects refused
//      across origins;
//   4. retry by the operation's rule:
//        safe_read         429 / 502 / 503 / 504 and connection errors, at most
//                          3 attempts, Retry-After honoured (capped at 20 s;
//                          longer and it returns rate_limited with the wait),
//                          otherwise exponential backoff with jitter;
//        idempotent_write  the same, but only with the adapter's idempotency
//                          header carrying ONE key across every attempt;
//        never             one attempt.
//      A timeout is not retried: the request already spent its whole budget.
//   5. normalise errors (401 reconnect_required, 403 insufficient_scope or
//      forbidden, 404 not_found, 429 rate_limited, 5xx unavailable) and keep the
//      provider's raw identifiers beside the normalised output;
//   6. say 'uncertain' for a write that was sent without a definite answer (a
//      timeout or dropped connection after sending, a 5xx, a refused redirect, an
//      unreadable 2xx reply) and never retry it.
//
// Every detail string passes through redactSecrets, and the exact secret is
// masked too in case it has a shape the pattern does not know.

import { randomUUID } from 'node:crypto'
import { redactSecrets } from '@shared/aispace/connections'
import { EgressRefused, guardedFetch } from '../net'
import {
  findOperation,
  InputError,
  SAFE_PATH_RE,
  type ApiRequest,
  type ApiResponse,
  type AppAdapter,
  type AppOperation,
  type AppResultCode,
  type InvokeResult,
  type InvokeStatus,
  type OperationContext,
  type ProviderErrorInfo,
  type RawIds,
  type VerifyResult
} from './adapter'
import { describeErrors, validateJson } from './jsonSchema'
import { defaultRateLimiter, type RateLimiter } from './rateLimit'

export const MAX_ATTEMPTS = 3
export const MAX_RETRY_WAIT_MS = 20_000
export const BACKOFF_BASE_MS = 500
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])

// Connection errors that happen before a single request byte leaves: nothing
// can have been done at the provider, so even a write is a plain error.
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

export interface InvokeOptions {
  adapter: AppAdapter
  operationId: string
  connectionId: string
  input: unknown
  // The credential, read from the vault by the caller. Never logged or returned.
  secret: string
  fetchImpl?: typeof fetch
  // Tests and local reference servers only.
  allowLoopback?: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  limiter?: RateLimiter
  // For 'idempotent_write': reuse a key from an earlier, uncertain attempt.
  idempotencyKey?: string
}

// ── Internal failures (normalised by invokeOperation) ─────────────────────────

class HttpFailure extends Error {
  constructor(
    readonly info: ProviderErrorInfo,
    readonly requestId: string | null,
    readonly retryAfterMs: number | null,
    readonly writeRequest: boolean
  ) {
    super(`HTTP ${info.status}`)
  }
}

class TransportFailure extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'egress' | 'redirect' | 'bad_response',
    message: string,
    // True when the request may have reached the provider.
    readonly maybeSent: boolean,
    readonly writeRequest: boolean
  ) {
    super(message)
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function errCode(e: unknown): string | null {
  const c = (e as { cause?: { code?: unknown }; code?: unknown } | null) ?? null
  const code = c?.cause?.code ?? c?.code
  return typeof code === 'string' ? code : null
}

function isAbort(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null
  const h = header.trim()
  if (/^\d+(\.\d+)?$/.test(h)) return Math.round(Number(h) * 1000)
  const at = Date.parse(h)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

function backoffMs(attempt: number, random: () => number): number {
  const exp = BACKOFF_BASE_MS * 2 ** (attempt - 1)
  // "Equal jitter": half fixed, half random, so retries from many runs spread out.
  return Math.round(exp / 2 + random() * (exp / 2))
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function providerError(status: number, body: unknown): ProviderErrorInfo {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const nested = (typeof b.error === 'object' && b.error !== null ? b.error : {}) as Record<string, unknown>
  return {
    status,
    providerCode: str(b.code) ?? str(nested.code) ?? str(nested.type) ?? (typeof b.error === 'string' ? str(b.error) : null),
    providerMessage: str(b.message) ?? str(nested.message) ?? str(b.error_description)
  }
}

function requestIdOf(adapter: AppAdapter, headers: Headers, body: unknown): string | null {
  for (const h of adapter.requestIdHeaders ?? []) {
    const v = headers.get(h)
    if (v && v.trim()) return v.trim().slice(0, 200)
  }
  const fromBody = (body as { request_id?: unknown } | null)?.request_id
  return typeof fromBody === 'string' && fromBody.trim() ? fromBody.trim().slice(0, 200) : null
}

// A token is sent in a header, so it must be visible ASCII with no spaces or
// line breaks. Checked before anything is sent, and never echoed.
function secretIsSendable(secret: string): boolean {
  return typeof secret === 'string' && /^[\x21-\x7e]{8,4096}$/.test(secret)
}

function makeRedactor(secret: string): (s: string) => string {
  return (s: string) => {
    let out = s
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]')
    return redactSecrets(out)
  }
}

const DEFAULT_DETAIL: Record<AppResultCode, (name: string) => string> = {
  ok: () => 'Done.',
  invalid_input: () => 'The input was not valid.',
  unknown_operation: (n) => `That isn’t an action ${n} offers here.`,
  rate_limited: (n) => `${n} is limiting how fast requests can be made. Wait and try again.`,
  reconnect_required: (n) => `${n} refused the saved credential. Reconnect to continue.`,
  insufficient_scope: (n) => `The credential doesn’t have permission for this in ${n}.`,
  forbidden: (n) => `${n} refused access to that.`,
  not_found: (n) => `${n} couldn’t find that.`,
  conflict: (n) => `${n} reported a conflict with another change. Try again shortly.`,
  provider_rejected: (n) => `${n} rejected the request.`,
  unavailable: (n) => `${n} is having trouble right now. Try again later.`,
  timeout: (n) => `${n} didn’t answer in time.`,
  network_error: (n) => `Couldn’t reach ${n}.`,
  egress_refused: () => 'The request was refused before it was sent.',
  redirect_refused: () => 'A redirect to another address was refused.',
  bad_response: (n) => `${n}’s reply wasn’t in the expected shape.`
}

function codeForStatus(status: number): AppResultCode {
  if (status === 401) return 'reconnect_required'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  if (status >= 400) return 'provider_rejected'
  return 'bad_response'
}

const UNCERTAIN_DEFAULT = (name: string): string => `${name} may or may not have completed this; check before trying again.`

// ── The engine ────────────────────────────────────────────────────────────────

export async function invokeOperation(opts: InvokeOptions): Promise<InvokeResult> {
  const { adapter, connectionId, secret } = opts
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = opts.random ?? Math.random
  const limiter = opts.limiter ?? defaultRateLimiter
  const redact = makeRedactor(secret)

  const state = {
    attempts: 0,
    providerRequestId: null as string | null,
    httpStatus: null as number | null,
    // A write request got a 2xx: the provider did it.
    writeConfirmed: false
  }

  const result = (
    status: InvokeStatus,
    code: AppResultCode,
    detail: string,
    extra: Partial<Pick<InvokeResult, 'output' | 'rawIds' | 'retryAfterMs' | 'idempotencyKey'>> = {}
  ): InvokeResult => ({
    status,
    code,
    output: extra.output ?? null,
    providerRequestId: state.providerRequestId,
    rawIds: extra.rawIds ?? {},
    detail: redact(detail),
    attempts: state.attempts,
    retryAfterMs: extra.retryAfterMs ?? null,
    httpStatus: state.httpStatus,
    idempotencyKey: extra.idempotencyKey ?? null
  })

  // 1. The operation and its input.
  const op: AppOperation | undefined = findOperation(adapter, opts.operationId)
  if (!op) return result('error', 'unknown_operation', DEFAULT_DETAIL.unknown_operation(adapter.name))

  const valid = validateJson(op.inputSchema, opts.input)
  if (!valid.ok) return result('error', 'invalid_input', `${op.title}: ${describeErrors(valid.errors)}`)

  if (!secretIsSendable(secret)) {
    return result('error', 'reconnect_required', `The saved ${adapter.name} credential is empty or has spaces or line breaks in it. Paste it again.`)
  }

  // 2. Rate limit (fail fast).
  const take = limiter.take(connectionId, op.id, op.rateLimitPerMinute, now())
  if (!take.ok) {
    const secs = Math.ceil(take.retryAfterMs / 1000)
    return result('blocked', 'rate_limited', `${op.title} is limited to ${op.rateLimitPerMinute} a minute on this connection. Try again in ${secs} s.`, {
      retryAfterMs: take.retryAfterMs
    })
  }

  const idempotencyKey = op.retry === 'idempotent_write' && adapter.idempotencyHeader ? (opts.idempotencyKey ?? randomUUID()) : null
  const retryable = op.retry === 'safe_read' || (op.retry === 'idempotent_write' && idempotencyKey !== null)
  const uncertainText = op.uncertainDetail ?? UNCERTAIN_DEFAULT(adapter.name)

  // 3. The one way an operation reaches the network.
  const request = async <T>(req: ApiRequest): Promise<ApiResponse<T>> => {
    if (!METHODS.has(req.method)) throw new InputError('That request method is not allowed.')
    // Re-checked at run time: a cast can get a raw string past the ApiPath type.
    if (typeof req.path !== 'string' || !SAFE_PATH_RE.test(req.path)) throw new InputError('That request path is not allowed.')
    const url = new URL(adapter.origin + req.path)
    if (url.origin !== adapter.origin || url.pathname !== req.path || url.search || url.hash) {
      throw new InputError('That request path is not allowed.')
    }
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))

    const headers: Record<string, string> = { accept: 'application/json', ...adapter.headers(secret) }
    let bodyText: string | undefined
    if (req.body !== undefined) {
      bodyText = JSON.stringify(req.body)
      headers['content-type'] = 'application/json'
    }
    if (idempotencyKey && adapter.idempotencyHeader) headers[adapter.idempotencyHeader] = idempotencyKey
    const writeRequest = op.classification === 'write' && req.method !== 'GET'

    for (let attempt = 1; ; attempt++) {
      state.attempts++
      let res: Response
      try {
        res = await guardedFetch(
          url.toString(),
          { method: req.method, headers, body: bodyText },
          { allowedOrigin: adapter.origin, allowLoopback: opts.allowLoopback, timeoutMs: op.timeoutMs, fetchImpl: opts.fetchImpl }
        )
      } catch (e) {
        if (e instanceof EgressRefused) {
          if (e.code === 'timeout') throw new TransportFailure('timeout', e.message, true, writeRequest)
          // The provider answered with a redirect; a write may have been acted on.
          if (e.code === 'redirect_refused') throw new TransportFailure('redirect', e.message, true, writeRequest)
          throw new TransportFailure('egress', e.message, false, writeRequest)
        }
        const code = errCode(e)
        const notSent = code !== null && NOT_SENT_CODES.has(code)
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt, random))
          continue
        }
        throw new TransportFailure('network', `Couldn’t reach ${url.host} (${code ?? 'connection failed'}).`, !notSent, writeRequest)
      }

      state.httpStatus = res.status
      let text: string
      try {
        text = await res.text()
      } catch (e) {
        throw new TransportFailure(
          isAbort(e) ? 'timeout' : 'network',
          isAbort(e) ? `${url.host} stopped sending its reply within ${Math.round(op.timeoutMs / 1000)} s.` : `The reply from ${url.host} was cut off.`,
          true,
          writeRequest
        )
      }
      const parsed = parseJson(text)
      const body = parsed.ok ? parsed.value : null
      state.providerRequestId = requestIdOf(adapter, res.headers, body) ?? state.providerRequestId

      if (res.status >= 200 && res.status < 300) {
        if (writeRequest) state.writeConfirmed = true
        if (!parsed.ok) throw new TransportFailure('bad_response', `${adapter.name} answered with something that isn’t JSON.`, true, writeRequest)
        return { status: res.status, body: body as T, requestId: state.providerRequestId }
      }

      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now())
      if (retryable && RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        const wait = retryAfterMs ?? backoffMs(attempt, random)
        if (wait <= MAX_RETRY_WAIT_MS) {
          await sleep(wait)
          continue
        }
      }
      throw new HttpFailure(providerError(res.status, body), state.providerRequestId, retryAfterMs, writeRequest)
    }
  }

  const ctx: OperationContext = { request, now }

  // 4. Run, then normalise whatever happened.
  let executed: { output: unknown; rawIds: RawIds }
  try {
    executed = await op.execute(ctx, opts.input as never)
  } catch (e) {
    if (e instanceof InputError) return result('error', 'invalid_input', `${op.title}: ${e.message}`, { idempotencyKey })

    if (e instanceof HttpFailure) {
      const base = codeForStatus(e.info.status)
      const refined = adapter.describeError?.(e.info) ?? null
      const code = refined?.code ?? base
      let detail = refined?.detail ?? DEFAULT_DETAIL[code](adapter.name)
      if (e.info.providerMessage) detail += ` ${adapter.name} said: “${e.info.providerMessage.slice(0, 300)}”`
      const uncertain = e.writeRequest && e.info.status >= 500
      if (uncertain) detail += ` ${uncertainText}`
      return result(uncertain ? 'uncertain' : 'error', code, detail, { retryAfterMs: e.retryAfterMs, idempotencyKey })
    }

    if (e instanceof TransportFailure) {
      const code: AppResultCode =
        e.kind === 'timeout' ? 'timeout' : e.kind === 'egress' ? 'egress_refused' : e.kind === 'redirect' ? 'redirect_refused' : e.kind === 'bad_response' ? 'bad_response' : 'network_error'
      if (e.writeRequest && e.maybeSent) {
        return result('uncertain', code, `${e.message} ${uncertainText}`, { idempotencyKey })
      }
      const status: InvokeStatus = e.kind === 'egress' || e.kind === 'redirect' ? 'blocked' : 'error'
      return result(status, code, e.message, { idempotencyKey })
    }

    // Anything else is the adapter failing to read a reply it got.
    const msg = e instanceof Error ? e.message : String(e)
    if (state.writeConfirmed) {
      return result('uncertain', 'bad_response', `${adapter.name} accepted the request, but its reply couldn’t be read (${msg}). ${uncertainText}`, { idempotencyKey })
    }
    return result('error', 'bad_response', `Couldn’t read ${adapter.name}’s reply (${msg}).`, { idempotencyKey })
  }

  // 5. The output must match what the operation promised.
  const out = validateJson(op.outputSchema, executed.output, 'output')
  if (!out.ok) {
    const why = `${DEFAULT_DETAIL.bad_response(adapter.name)} ${describeErrors(out.errors)}`
    if (state.writeConfirmed) return result('uncertain', 'bad_response', `${why} ${uncertainText}`, { rawIds: executed.rawIds, idempotencyKey })
    return result('error', 'bad_response', why, { rawIds: executed.rawIds, idempotencyKey })
  }
  return result('ok', 'ok', 'Done.', { output: executed.output, rawIds: executed.rawIds, idempotencyKey })
}

// Run an adapter's own check (§2 test and repair) through invokeOperation, so
// verification gets the same validation, limits, pinning and redaction.
export async function verifyConnection(opts: Omit<InvokeOptions, 'operationId' | 'input'>): Promise<VerifyResult> {
  const now = opts.now ?? Date.now
  return opts.adapter.verify({
    invoke: (operationId, input) => invokeOperation({ ...opts, operationId, input }),
    now
  })
}
