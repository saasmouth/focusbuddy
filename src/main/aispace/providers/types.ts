// Plexii Connections: the shared model-adapter interface (SPEC-CONNECTIONS.md
// §1 Provider catalogue, §7 Usage and reliability).
//
// One adapter per model API. Every adapter takes an EXPLICIT credential on each
// call (a connection's key, read from the vault by the caller), so two
// connections at one provider never share state. Plexii's feature AI clients in
// src/main/ai/* are deliberately not used here: they are single-key and routed
// by feature, which is the opposite of what a connection needs.
//
// All HTTP goes through guardedFetch (src/main/aispace/net.ts) with the origin
// pinned to the adapter's base URL, so a key can only ever reach the host it was
// approved for. Nothing here logs; every message that leaves an adapter has
// been through scrubSecret.

import type { CapabilityHealth } from '@shared/aispace/connections'
import { redactSecrets } from '@shared/aispace/connections'

export type ModelProviderId = 'anthropic' | 'openai'

export interface ModelMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ModelRequest {
  // The connection's credential. Sent only to the adapter's pinned origin and
  // never included in any message, result or error.
  secret: string
  model: string
  // May be empty; an empty system prompt is not sent.
  system: string
  messages: ModelMessage[]
  maxOutputTokens: number
  // Aborting returns a result with status 'cancelled' and whatever text had
  // arrived. It never throws for the abort itself.
  signal?: AbortSignal
  // Given → the run streams and each text delta is passed here in order.
  // Ignored for background runs.
  onText?: (delta: string) => void
  // OpenAI only: start a background response Plexii can poll, cancel and pick
  // up again after a restart. The Anthropic adapter throws 'unsupported'.
  background?: boolean
  // NOT sent to either provider. Neither adapter is confident the provider
  // honours an Idempotency-Key header on these endpoints, so none is claimed:
  // duplicate protection is Plexii's own run ledger (record the key before
  // dispatch, reconcile by externalId after). Kept on the request so the ledger
  // and the adapter call carry the same value.
  idempotencyKey?: string
  // OpenAI: sent as `metadata` (≤16 pairs, keys ≤64 chars, values ≤512 chars).
  // Anthropic: only `user_id` is accepted by the Messages API, so only that key
  // is sent; others are dropped.
  metadata?: Record<string, string>
}

export type ModelRunStatus = 'completed' | 'in_progress' | 'queued' | 'failed' | 'cancelled' | 'incomplete'

export interface ModelUsage {
  // Each count is exactly what the provider reported, or null when it did not
  // report it (a run cancelled mid-stream reports input tokens but no final
  // output count). Nothing is estimated here.
  inputTokens: number | null
  outputTokens: number | null
  // 'reported' when at least one count came from the provider.
  source: 'reported' | 'unavailable'
}

export interface ModelResult {
  status: ModelRunStatus
  text: string
  usage: ModelUsage
  // The provider's request id for THIS HTTP call (support tickets).
  requestId: string | null
  // The provider's id for the run (Anthropic msg_…, OpenAI resp_…). Only an
  // OpenAI background run can be polled or cancelled by it.
  externalId: string | null
  // The model the provider says it ran, else the requested one.
  model: string
  // Provider's stop reason (Anthropic stop_reason; OpenAI incomplete reason or
  // 'refusal'). null when the provider gave none.
  stopReason: string | null
  // Set when status is 'failed': the provider's own message, scrubbed.
  error: string | null
}

export interface VerifyOptions {
  signal?: AbortSignal
  now?: () => number
}

export interface VerifyResult {
  ok: boolean
  // A stable account identity from the provider's response headers, or null.
  // Never invented.
  identity: string | null
  providerOrg: string | null
  // Every model id the key can list.
  models: string[]
  capabilities: CapabilityHealth[]
  detail: string
  // verify only ever lists models; it never makes a billable call.
  billable: false
  // Set when ok is false because the provider gave a definitive answer about
  // the key (rejected, missing permission, out of credit). Transient failures
  // (rate limits, outages) are thrown as ProviderError instead, because they
  // say nothing about the key.
  errorCode?: ProviderErrorCode
}

export interface PollOptions {
  signal?: AbortSignal
}

export interface ModelAdapter {
  providerId: ModelProviderId
  verify(secret: string, opts?: VerifyOptions): Promise<VerifyResult>
  run(req: ModelRequest): Promise<ModelResult>
  poll?(secret: string, externalId: string, opts?: PollOptions): Promise<ModelResult>
  cancel?(secret: string, externalId: string, opts?: PollOptions): Promise<ModelResult>
  // Micro-dollars (1e-6 USD) from a VERIFIED price table, or null when there is
  // none for this model (cost then shows as Unavailable; tokens still count).
  estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number | null
}

// ── Errors ───────────────────────────────────────────────────────────────────

export const PROVIDER_ERROR_CODES = [
  // 401: the key is invalid, expired or revoked.
  'reconnect_required',
  // 403: the key is valid but lacks permission for this call.
  'insufficient_scope',
  // 429: slow down; retryAfterMs when the provider said how long.
  'rate_limited',
  // 5xx, 529 overloaded, network failure, timeout, stalled stream.
  'unavailable',
  // Out of credit / billing (Anthropic credit balance, OpenAI insufficient_quota).
  'quota',
  // The provider refused the request as malformed, or Plexii refused it before
  // sending (bad model, empty messages, bad response id).
  'bad_request',
  // This adapter or model does not offer the feature.
  'unsupported'
] as const
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number]

export interface ProviderErrorInit {
  providerId: ModelProviderId
  status?: number | null
  retryAfterMs?: number | null
  // The provider's own error type/code (e.g. 'overloaded_error', 'insufficient_quota').
  providerType?: string | null
  requestId?: string | null
  // The credential in play, so its exact text can be removed from the message
  // even when it does not look like a key.
  secret?: string
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly providerId: ModelProviderId
  readonly status: number | null
  readonly retryAfterMs: number | null
  readonly providerType: string | null
  readonly requestId: string | null

  constructor(code: ProviderErrorCode, message: string, init: ProviderErrorInit) {
    super(scrubSecret(message, init.secret))
    this.name = 'ProviderError'
    this.code = code
    this.providerId = init.providerId
    this.status = init.status ?? null
    this.retryAfterMs = init.retryAfterMs ?? null
    this.providerType = init.providerType ? scrubSecret(init.providerType, init.secret) : null
    this.requestId = init.requestId ?? null
  }
}

// Codes a caller may retry with backoff. Everything else needs a person (a new
// key, more credit, a different request) before a retry can succeed.
export function isRetryable(code: ProviderErrorCode): boolean {
  return code === 'rate_limited' || code === 'unavailable'
}

// Remove the exact credential (whatever its shape), then anything key-shaped.
export function scrubSecret(text: string, secret?: string): string {
  let out = text
  const s = secret?.trim()
  if (s && s.length >= 4) out = out.split(s).join('[redacted]')
  return redactSecrets(out)
}
