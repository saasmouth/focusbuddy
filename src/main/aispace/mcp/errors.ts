// Typed errors for the MCP client (SPEC-CONNECTIONS.md §2 Status and repair).
//
// The UI maps `code` to a repair action, so the codes are a short, stable
// list. `reason` narrows a code for copy and support without growing the list
// the UI must handle. Messages are plain English and pass through
// redactSecrets, because a server's error text is untrusted and could echo a
// token back at us.

import { redactSecrets } from '@shared/aispace/connections'
import { EgressRefused } from '../net'
import type { BearerChallenge } from './challenge'

export type McpErrorCode =
  | 'reconnect_required' // authorisation missing, expired or revoked: sign in again
  | 'consent_required' // more scope needed: ask the person before signing in again
  | 'unavailable' // 5xx, rate limit, network: try later (retryAfterMs when known)
  | 'protocol_error' // the server broke the protocol or answered with an error
  | 'refused' // Plexii's own egress or credential rules said no
  | 'denied' // the person (or the server) declined access
  | 'timeout' // no answer in time
  | 'cancelled' // the caller gave up (signal aborted)

export interface McpErrorDetails {
  reason?: string
  status?: number | null
  retryAfterMs?: number | null
  rpcCode?: number | null
  challenge?: BearerChallenge | null
  attemptId?: string | null
  // True when the server may have acted before the answer was lost. A write
  // whose result is uncertain must never be replayed (§3 rotation rule).
  uncertain?: boolean
}

export class McpError extends Error {
  readonly code: McpErrorCode
  readonly reason: string
  readonly status: number | null
  readonly retryAfterMs: number | null
  readonly rpcCode: number | null
  readonly challenge: BearerChallenge | null
  readonly uncertain: boolean
  // Set by the authorisation flow so the UI can return the person to the same
  // draft setup after a denial or a timeout (§2 Connect flow, step 3).
  attemptId: string | null

  constructor(code: McpErrorCode, message: string, d: McpErrorDetails = {}) {
    super(redactSecrets(message))
    this.name = 'McpError'
    this.code = code
    this.reason = d.reason ?? code
    this.status = d.status ?? null
    this.retryAfterMs = d.retryAfterMs ?? null
    this.rpcCode = d.rpcCode ?? null
    this.challenge = d.challenge ?? null
    this.attemptId = d.attemptId ?? null
    this.uncertain = d.uncertain ?? false
  }
}

// Scope step-up (MCP authorization, insufficient_scope). Never answered by a
// silent re-authorisation: wider access needs the person's consent again (§4).
export class ConsentRequired extends McpError {
  readonly requiredScope: string | null

  constructor(requiredScope: string | null, d: McpErrorDetails = {}) {
    super(
      'consent_required',
      requiredScope
        ? `This needs more access than was granted (${requiredScope}). Ask before signing in again.`
        : 'This needs more access than was granted. Ask before signing in again.',
      { reason: 'insufficient_scope', ...d }
    )
    this.name = 'ConsentRequired'
    this.requiredScope = requiredScope
  }
}

export function isMcpError(e: unknown, code?: McpErrorCode): e is McpError {
  return e instanceof McpError && (code === undefined || e.code === code)
}

// Server text is untrusted: strip control characters, cap the length and mask
// anything that looks like a credential before it can reach a message.
export function cleanServerText(s: unknown, max = 300): string {
  const raw = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s)
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat
  return redactSecrets(cut)
}

// Turn whatever a fetch or a body read threw into a typed error.
export function fromNetworkError(e: unknown, host: string, signal?: AbortSignal): McpError {
  if (e instanceof McpError) return e
  if (signal?.aborted) return new McpError('cancelled', 'Cancelled.', { reason: 'cancelled', uncertain: true })
  if (e instanceof EgressRefused) {
    if (e.code === 'timeout') return new McpError('timeout', e.message, { reason: 'timeout', uncertain: true })
    return new McpError('refused', e.message, { reason: e.code })
  }
  const name = (e as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new McpError('timeout', `No answer from ${host} in time.`, { reason: 'timeout', uncertain: true })
  }
  // A failure after the request left may mean the server acted: say so.
  return new McpError('unavailable', `Couldn’t reach ${host}.`, { reason: 'network', uncertain: true })
}

// Retry-After is seconds or an HTTP date. Capped at an hour so a hostile
// server cannot park a connection for days.
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const v = value.trim()
  let ms: number | null = null
  if (/^\d+$/.test(v)) ms = Number(v) * 1000
  else {
    const at = Date.parse(v)
    if (Number.isFinite(at)) ms = Math.max(0, at - now)
  }
  return ms === null ? null : Math.min(ms, 3_600_000)
}
