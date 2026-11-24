// Declarative operations for direct app APIs (SPEC-CONNECTIONS.md §5 Direct API
// integrations).
//
// An adapter is ONE provider at ONE approved origin. Each operation declares a
// stable id, input and output schemas, a read/write classification, a scope, a
// rate limit, a timeout and a retry rule, and an `execute` that turns validated
// input into requests.
//
// WHAT AN OPERATION CANNOT DO. `execute` never sees a URL, a host or a header.
// It hands `ctx.request` a method, an ApiPath and (optionally) query values and
// a JSON body; the framework (invoke.ts) joins the path to the adapter's pinned
// origin, attaches the adapter's own headers (credential included) and sends it
// through guardedFetch with `allowedOrigin` = that origin. An ApiPath can only
// be built by `apiPath`, which accepts fixed literal text from the adapter's
// source plus interpolated values that must each be ONE plain path segment
// (letters, digits, - _ . ~, no leading dot). So tool input can never set the
// scheme, host, port, a redirect target, a query string, a fragment, an encoded
// slash or a header, and the runtime re-checks the joined URL in case a cast
// smuggled a raw string past the type.
//
// WEBHOOKS are out of scope for this release (§5: "official webhooks where
// available with signature verification, replay protection, deduplication and
// tenant binding"; §8 puts signed webhook ingestion in Release 2). They would
// plug in as an optional `webhooks` member on AppAdapter, e.g.
//   { verifySignature(rawBody, headers, signingSecret): boolean,
//     eventId(body): string /* dedup + replay window */,
//     tenantOf(body): string /* must equal the connection's identity */ }
// fed by a main-process receiver. Until then, adapters poll within their own
// operation rate limits.

import { createHash } from 'node:crypto'
import type { CapabilityHealth, JsonSchema, OperationDef, RetryRule } from '@shared/aispace/connections'
import { assertSupportedSchema } from './jsonSchema'

// ── Paths ─────────────────────────────────────────────────────────────────────

declare const apiPathBrand: unique symbol
export type ApiPath = string & { readonly [apiPathBrand]: true }

// Thrown when input cannot be turned into a request. Always raised BEFORE any
// request for that input is sent.
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

const LITERAL_RE = /^[A-Za-z0-9._~/-]*$/
const SEGMENT_RE = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,199}$/
// The whole joined path: one or more "/segment", no empty or dot segments.
export const SAFE_PATH_RE = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/

// Tagged template: apiPath`/v1/pages/${id}`. Literal text comes from adapter
// source; every interpolated value must be a single plain segment.
export function apiPath(strings: TemplateStringsArray, ...values: unknown[]): ApiPath {
  let out = ''
  strings.forEach((lit, i) => {
    if (!LITERAL_RE.test(lit)) throw new InputError('An adapter path contains characters that are not allowed.')
    out += lit
    if (i < values.length) {
      const v = values[i]
      if (typeof v !== 'string' || !SEGMENT_RE.test(v)) {
        throw new InputError('That value can’t be used in a request path. Use the plain id, not a link or a path.')
      }
      out += v
    }
  })
  if (!SAFE_PATH_RE.test(out)) throw new InputError('That request path is not allowed.')
  return out as ApiPath
}

// ── Requests an operation may make ────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface ApiRequest {
  method: HttpMethod
  path: ApiPath
  // Names come from adapter source; values are percent-encoded by URLSearchParams.
  query?: Record<string, string | number | boolean | undefined>
  // Serialised as JSON by the framework.
  body?: unknown
}

export interface ApiResponse<T = unknown> {
  status: number
  body: T
  requestId: string | null
}

export interface OperationContext {
  request<T = unknown>(req: ApiRequest): Promise<ApiResponse<T>>
  now(): number
}

// Provider identifiers exactly as the provider returned them, kept next to the
// normalised output (§5 "Preserve raw provider identifiers").
export type RawIds = Record<string, string | string[] | null>

export interface ExecuteResult {
  output: unknown
  rawIds: RawIds
}

export interface AppOperation {
  id: string
  title: string
  description: string
  classification: 'read' | 'write'
  scope: string | null
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  rateLimitPerMinute: number
  // Budget for EACH HTTP request the operation makes.
  timeoutMs: number
  retry: RetryRule
  // Said plainly when a write's outcome is unknown, e.g. "Notion may or may not
  // have created the page; check before trying again."
  uncertainDetail?: string
  execute(ctx: OperationContext, input: never): Promise<ExecuteResult>
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type AppResultCode =
  | 'ok'
  | 'invalid_input'
  | 'unknown_operation'
  | 'rate_limited'
  | 'reconnect_required'
  | 'insufficient_scope'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'provider_rejected'
  | 'unavailable'
  | 'timeout'
  | 'network_error'
  | 'egress_refused'
  | 'redirect_refused'
  | 'bad_response'

export interface ProviderErrorInfo {
  status: number
  // The provider's own error code and message from the body, when it sent them.
  providerCode: string | null
  providerMessage: string | null
}

// ── Invocation results ────────────────────────────────────────────────────────

// 'blocked': refused before anything was sent (local rate limit, egress rule).
// 'uncertain': a write was sent and no definite answer came back; it is never
// retried automatically and `detail` says to check before trying again.
export type InvokeStatus = 'ok' | 'error' | 'uncertain' | 'blocked'

export interface InvokeResult {
  status: InvokeStatus
  code: AppResultCode
  output: unknown
  providerRequestId: string | null
  rawIds: RawIds
  // Plain words for a person; secrets redacted.
  detail: string
  // HTTP requests sent for this invocation, retries included (0 = nothing sent).
  attempts: number
  // When a rate limit (ours or the provider's) says how long to wait.
  retryAfterMs: number | null
  // The last HTTP status seen, or null when no answer arrived.
  httpStatus: number | null
  // Sent as the provider's idempotency header for 'idempotent_write' operations.
  idempotencyKey: string | null
}

// ── Verification ──────────────────────────────────────────────────────────────

export interface VerifyContext {
  invoke(operationId: string, input: unknown): Promise<InvokeResult>
  now(): number
}

export interface VerifyResult {
  ok: boolean
  code: AppResultCode
  identity: string | null
  providerOrg: string | null
  detail: string
  capabilities: CapabilityHealth[]
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface AppAdapter {
  id: string
  name: string
  // The ONE origin every request goes to; the credential is bound to it.
  origin: string
  operations: AppOperation[]
  // Headers the framework attaches to every request. Only the adapter sets
  // these; an operation and its input cannot.
  headers(secret: string): Record<string, string>
  // A header the provider honours for idempotent retries (e.g. Stripe's
  // "Idempotency-Key"). Without one, no write can be 'idempotent_write'.
  idempotencyHeader?: string
  // Response headers that may carry the provider's request id.
  requestIdHeaders?: string[]
  // Refine the framework's status → code mapping and say what to do in the
  // provider's own terms. Return null to keep the default.
  describeError?(e: ProviderErrorInfo): { code?: AppResultCode; detail?: string } | null
  verify(ctx: VerifyContext): Promise<VerifyResult>
}

// Checks an adapter is honest about itself before anything can run it. Throws
// on the first problem.
export function defineAdapter<A extends AppAdapter>(adapter: A): A {
  const where = `Adapter ${adapter.id}`
  let origin: string
  try {
    origin = new URL(adapter.origin).origin
  } catch {
    throw new Error(`${where}: origin is not a valid address.`)
  }
  if (origin !== adapter.origin) throw new Error(`${where}: origin must be a bare origin like https://api.example.com.`)
  const seen = new Set<string>()
  for (const op of adapter.operations) {
    const w = `${where} › ${op.id}`
    if (!op.id.startsWith(`${adapter.id}.`) || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(op.id)) throw new Error(`${w}: id must be "${adapter.id}.<name>".`)
    if (seen.has(op.id)) throw new Error(`${w}: duplicate id.`)
    seen.add(op.id)
    if (op.classification === 'write' && op.retry === 'safe_read') throw new Error(`${w}: a write cannot use the safe_read retry rule.`)
    if (op.retry === 'idempotent_write') {
      if (op.classification !== 'write') throw new Error(`${w}: idempotent_write is for writes.`)
      if (!adapter.idempotencyHeader) throw new Error(`${w}: idempotent_write needs a provider idempotency header; use 'never'.`)
    }
    if (!(Number.isInteger(op.rateLimitPerMinute) && op.rateLimitPerMinute >= 1)) throw new Error(`${w}: rateLimitPerMinute must be at least 1.`)
    if (!(Number.isInteger(op.timeoutMs) && op.timeoutMs >= 1 && op.timeoutMs <= 120_000)) throw new Error(`${w}: timeoutMs must be 1..120000.`)
    assertSupportedSchema(op.inputSchema, `${w} input`)
    assertSupportedSchema(op.outputSchema, `${w} output`)
    if (op.inputSchema.type !== 'object' || op.inputSchema.additionalProperties !== false) {
      throw new Error(`${w}: input must be an object schema with additionalProperties: false.`)
    }
  }
  return adapter
}

export function findOperation(adapter: AppAdapter, operationId: string): AppOperation | undefined {
  return adapter.operations.find((o) => o.id === operationId)
}

// ── Operation records ─────────────────────────────────────────────────────────

// Sorted keys, no whitespace, undefined dropped: the same definition always
// hashes the same, whatever order its source listed keys in.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return 'null'
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

export function operationSchemaHash(op: Pick<AppOperation, 'id' | 'inputSchema' | 'outputSchema' | 'classification' | 'scope'>): string {
  const canon = canonicalJson({
    id: op.id,
    inputSchema: op.inputSchema,
    outputSchema: op.outputSchema,
    classification: op.classification,
    scope: op.scope
  })
  return createHash('sha256').update(canon).digest('hex')
}

export function toOperationDef(adapter: AppAdapter, op: AppOperation, connectionId: string | null): OperationDef {
  return {
    id: op.id,
    connectionId,
    adapter: adapter.id,
    title: op.title,
    description: op.description,
    classification: op.classification,
    scope: op.scope,
    destination: adapter.origin,
    inputSchema: op.inputSchema,
    outputSchema: op.outputSchema,
    schemaVersion: 1,
    schemaHash: operationSchemaHash(op),
    rateLimitPerMinute: op.rateLimitPerMinute,
    timeoutMs: op.timeoutMs,
    retry: op.retry,
    reviewState: 'approved',
    origin: 'catalogue'
  }
}

export function operationDefsFor(adapter: AppAdapter, connectionId: string | null): OperationDef[] {
  return adapter.operations.map((op) => toOperationDef(adapter, op, connectionId))
}
