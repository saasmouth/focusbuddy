// Turning a one-time sign-in code into a session (auth step 2, 2026-11-20;
// plexii-work/auth-step2-design.md).
//
// A sign-in this app starts carries a PKCE challenge out (signInNonce.ts); the
// website or SSO sends back haptyx://auth?code=…&state=…. Only main holds the
// verifier, so only main can redeem the code. A code copied out of the link is
// useless anywhere else. The contract is a0's, on signal (haptyx-ecosystem
// signal-desk-auth-codes, pinned there by tests/deskHandoffCodeFlow.mjs):
//
//   POST <signal>/auth/app/token  application/json
//   { grant_type: 'authorization_code', code, code_verifier,
//     redirect_uri: 'haptyx://auth', client_id: 'plexiidesk' }
//   200 { sessionToken, tokenType: 'session', expiresAt, account: { id, email, handle } }
//   400 { error, message }   the code is used, expired, or not this one's
//   429, 5xx
//
// A code is spent by its first attempt, right or wrong, and a second use of a
// used code ends the session it bought. So: exactly one attempt, never a retry.
// After any failure the person starts the sign-in again.
//
// Electron's net.fetch, not Node's: Chromium's network stack, so the system's
// certificates and proxy, the same as the renderer's own sign-in.
import { net } from 'electron'
import { ACTIVE } from '@shared/productDomains'

export const AUTH_CLIENT_ID = 'plexiidesk'
/** Exactly the return address signal binds the code to. */
export const AUTH_REDIRECT_URI = 'haptyx://auth'
const REDEEM_TIMEOUT_MS = 15_000

/**
 * The signal server to redeem at: the one the renderer signs in against
 * (productDomains ACTIVE.api), unless the e2e harness or a developer names
 * another (FB_SIGNAL_URL, SIGNAL_HTTP_URL; as ai/creditMode.ts reads them).
 */
export function authApiBase(env: Record<string, string | undefined> = process.env): string {
  return (env.FB_SIGNAL_URL || env.SIGNAL_HTTP_URL || ACTIVE.api).trim().replace(/\/+$/, '')
}

export type RedeemResult = { ok: true; sessionToken: string; email: string | null; handle: string | null } | { ok: false; why: 'refused' | 'unreachable' }

/** https anywhere; plain http only to this machine (a developer's or the harness's signal). */
function safeBase(base: string): boolean {
  try {
    const u = new URL(base)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
  } catch {
    return false
  }
}

export async function redeemSignInCode(
  code: string,
  verifier: string,
  opts: { fetch?: typeof fetch; base?: string; timeoutMs?: number } = {}
): Promise<RedeemResult> {
  const base = opts.base ?? authApiBase()
  if (!safeBase(base)) return { ok: false, why: 'unreachable' }
  const doFetch = opts.fetch ?? (net.fetch as unknown as typeof fetch)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? REDEEM_TIMEOUT_MS)
  let res: Response
  try {
    res = await doFetch(`${base}/auth/app/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: AUTH_REDIRECT_URI, client_id: AUTH_CLIENT_ID }),
      signal: ctrl.signal
    })
  } catch {
    return { ok: false, why: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
  // Rate-limited or a server fault: the server never judged the code. Still no retry (it may be spent).
  if (res.status === 429 || res.status >= 500) return { ok: false, why: 'unreachable' }
  if (!res.ok) return { ok: false, why: 'refused' }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, why: 'refused' }
  }
  const b = body as { sessionToken?: unknown; account?: { email?: unknown; handle?: unknown } } | null
  if (!b || typeof b !== 'object' || typeof b.sessionToken !== 'string' || !b.sessionToken) return { ok: false, why: 'refused' }
  const email = typeof b.account?.email === 'string' ? b.account.email : null
  const handle = typeof b.account?.handle === 'string' ? b.account.handle : null
  return { ok: true, sessionToken: b.sessionToken, email, handle }
}
