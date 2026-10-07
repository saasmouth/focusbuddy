import { signalConfig } from './signalConfig'

// Thin REST client for the signal server's accounts + inbox endpoints.
// Lives in the renderer because it's pure fetch — main doesn't need to
// proxy network calls. The session token comes from the account store
// (which loads it from the IPC-backed secure storage on boot).

export interface ServerAccount {
  id: string
  email: string
  handle: string | null
  firstName: string | null
  lastName: string | null
  createdAt: number
  lastLoginAt: number | null
}

export interface InboxItemFromServer {
  id: string
  accountId: string
  shareToken: string
  addedAt: number
  share: {
    token: string
    kind: 'folder' | 'task' | 'widget'
    fromHandle: string
    scope: 'view' | 'copy'
    createdAt: number
    snapshot: unknown
  } | null
}

interface AuthSuccess {
  ok: true
  sessionToken: string
  account: ServerAccount
}

interface AuthFailure {
  ok: false
  error: string
  code: 'EMAIL_EXISTS' | 'INVALID_CREDENTIALS' | 'NETWORK' | 'BAD_INPUT' | 'SERVER' | 'TWO_FACTOR'
}

export type AuthResult = AuthSuccess | AuthFailure

function urlFor(path: string): string {
  // Trim trailing slash so we get clean concatenation.
  return signalConfig.httpUrl.replace(/\/+$/, '') + path
}

async function postJson<T>(
  path: string,
  body: unknown,
  token?: string
): Promise<{ res: Response; json: T | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(urlFor(path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  let json: T | null = null
  try {
    json = (await res.json()) as T
  } catch {
    json = null
  }
  return { res, json }
}

async function getJson<T>(path: string, token?: string): Promise<{ res: Response; json: T | null }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(urlFor(path), { method: 'GET', headers })
  let json: T | null = null
  try {
    json = (await res.json()) as T
  } catch {
    json = null
  }
  return { res, json }
}

// ── Auth ────────────────────────────────────────────────────────────────

export async function signup(input: {
  email: string
  password: string
  handle?: string | null
  firstName?: string | null
  lastName?: string | null
}): Promise<AuthResult> {
  try {
    const { res, json } = await postJson<{
      ok: boolean
      sessionToken?: string
      account?: ServerAccount
      error?: string
    }>('/accounts/signup', input)
    if (!res.ok || !json) {
      const code: AuthFailure['code'] =
        res.status === 409 ? 'EMAIL_EXISTS' : res.status === 400 ? 'BAD_INPUT' : 'SERVER'
      return {
        ok: false,
        error: json?.error || `Signup failed (${res.status}).`,
        code
      }
    }
    if (!json.sessionToken || !json.account) {
      return {
        ok: false,
        error: 'Server returned an unexpected response.',
        code: 'SERVER'
      }
    }
    return { ok: true, sessionToken: json.sessionToken, account: json.account }
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach the server: ${(err as Error).message}`,
      code: 'NETWORK'
    }
  }
}

export async function login(input: {
  email: string
  password: string
  code?: string
}): Promise<AuthResult> {
  try {
    const { res, json } = await postJson<{
      ok: boolean
      sessionToken?: string
      account?: ServerAccount
      error?: string
      twoFactorRequired?: boolean
    }>('/accounts/login', input)
    if (!res.ok || !json) {
      // Password was right but a second factor is needed (or the supplied code
      // was wrong) — surface this distinctly so the UI can prompt for the code.
      if (json?.twoFactorRequired) {
        return { ok: false, error: json.error || 'Enter your authentication code.', code: 'TWO_FACTOR' }
      }
      const code: AuthFailure['code'] =
        res.status === 401 ? 'INVALID_CREDENTIALS' : 'SERVER'
      return {
        ok: false,
        error: json?.error || 'Invalid email or password.',
        code
      }
    }
    if (!json.sessionToken || !json.account) {
      return {
        ok: false,
        error: 'Server returned an unexpected response.',
        code: 'SERVER'
      }
    }
    return { ok: true, sessionToken: json.sessionToken, account: json.account }
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach the server: ${(err as Error).message}`,
      code: 'NETWORK'
    }
  }
}

/**
 * Start a paid upgrade for the signed-in account.
 *
 * Returns what the caller should do:
 *   'redirect' — open `url`, a Stripe Checkout page, in the browser
 *   'portal'   — open `url`, Stripe's Billing Portal, because this account
 *                already has a subscription and wants to change it rather than
 *                buy a second one
 *   'pending'  — Stripe is not configured on the server, so there is nothing to
 *                open. The caller must say so rather than appear to succeed.
 *
 * Before this existed the upgrade button opened the public pricing page, whose
 * Pro link goes to /account/signup — asking a signed-in user to create a second
 * account in order to pay for the one they already had.
 */
export interface UpgradeStart {
  action: 'redirect' | 'portal' | 'pending'
  url?: string
  plan?: string
}

export async function startUpgrade(
  plan: 'pro' | 'team',
  interval: 'month' | 'year',
  token: string
): Promise<UpgradeStart | null> {
  const { res, json } = await postJson<{ ok: boolean; action?: string; url?: string; plan?: string }>(
    '/billing/checkout',
    { plan, interval },
    token
  )
  if (!res.ok || !json?.ok || !json.action) return null
  return { action: json.action as UpgradeStart['action'], url: json.url, plan: json.plan }
}

export async function logout(token: string): Promise<void> {
  try {
    await postJson('/accounts/logout', {}, token)
  } catch {
    // best effort — the token is being thrown away anyway
  }
}

// Resolve the current session against the server. Used on app boot to
// confirm the cached session is still valid. Returns null on any failure
// (network or unauthorized).
// Result of validating a session token. `unauthenticated` means the server
// answered and explicitly rejected the token (expired/revoked). `unreachable`
// means we could not confirm one way or the other (offline, DNS failure, 5xx,
// unparseable body). Callers MUST treat these differently: only `unauthenticated`
// justifies destroying a local session. On `unreachable` the safe move is to
// keep the user signed in and retry.
export type MeResult =
  | { status: 'ok'; account: ServerAccount }
  | { status: 'unauthenticated' }
  | { status: 'unreachable' }

export async function getMe(token: string): Promise<MeResult> {
  try {
    const { res, json } = await getJson<{ ok: boolean; account?: ServerAccount }>(
      '/accounts/me',
      token
    )
    if (res.status === 401 || res.status === 403) return { status: 'unauthenticated' }
    // Any other non-2xx (5xx, proxy/gateway error) is inconclusive — the token
    // may still be valid, we just could not check it. Keep the session.
    if (!res.ok) return { status: 'unreachable' }
    if (json?.ok && json.account) return { status: 'ok', account: json.account }
    // A 200 that explicitly says ok:false is a real rejection; anything else
    // (missing/unparseable body) is inconclusive and must not sign the user out.
    if (json && json.ok === false) return { status: 'unauthenticated' }
    return { status: 'unreachable' }
  } catch {
    // fetch rejected — offline / connection refused / timeout. Not a rejection.
    return { status: 'unreachable' }
  }
}

// Update the signed-in user's real name. Returns the refreshed account, or null
// on any failure so the caller can keep the old value and surface an error.
export async function updateProfile(
  token: string,
  input: { firstName: string | null; lastName: string | null }
): Promise<ServerAccount | null> {
  try {
    const { res, json } = await postJson<{ ok: boolean; account?: ServerAccount }>(
      '/accounts/profile',
      input,
      token
    )
    if (!res.ok || !json?.ok || !json.account) return null
    return json.account
  } catch {
    return null
  }
}

// ── Two-factor (TOTP) ─────────────────────────────────────────────────────

export async function twoFactorStatus(token: string): Promise<{ enabled: boolean; pending: boolean }> {
  try {
    const { res, json } = await getJson<{ ok: boolean; enabled?: boolean; pending?: boolean }>('/account/2fa', token)
    if (!res.ok || !json?.ok) return { enabled: false, pending: false }
    return { enabled: !!json.enabled, pending: !!json.pending }
  } catch {
    return { enabled: false, pending: false }
  }
}

export async function twoFactorSetup(
  token: string
): Promise<{ ok: true; secret: string; otpauthUrl: string } | { ok: false; error: string }> {
  try {
    const { res, json } = await postJson<{ ok: boolean; secret?: string; otpauthUrl?: string; error?: string }>(
      '/account/2fa/setup',
      {},
      token
    )
    if (!res.ok || !json?.ok || !json.secret || !json.otpauthUrl) {
      return { ok: false, error: json?.error || 'Could not start setup.' }
    }
    return { ok: true, secret: json.secret, otpauthUrl: json.otpauthUrl }
  } catch (err) {
    return { ok: false, error: `Could not reach the server: ${(err as Error).message}` }
  }
}

export async function twoFactorEnable(
  token: string,
  code: string
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
  try {
    const { res, json } = await postJson<{ ok: boolean; recoveryCodes?: string[]; error?: string }>(
      '/account/2fa/enable',
      { code },
      token
    )
    if (!res.ok || !json?.ok || !json.recoveryCodes) {
      return { ok: false, error: json?.error || 'That code is not valid.' }
    }
    return { ok: true, recoveryCodes: json.recoveryCodes }
  } catch (err) {
    return { ok: false, error: `Could not reach the server: ${(err as Error).message}` }
  }
}

export async function twoFactorDisable(token: string, code: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { res, json } = await postJson<{ ok: boolean; error?: string }>('/account/2fa/disable', { code }, token)
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error || 'That code is not valid.' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `Could not reach the server: ${(err as Error).message}` }
  }
}

// ── Inbox ───────────────────────────────────────────────────────────────

export async function listInbox(
  token: string,
  since?: number
): Promise<InboxItemFromServer[]> {
  try {
    const suffix = since !== undefined ? `?since=${since}` : ''
    const { res, json } = await getJson<{
      ok: boolean
      items?: InboxItemFromServer[]
    }>(`/inbox${suffix}`, token)
    if (!res.ok || !json?.ok || !Array.isArray(json.items)) return []
    return json.items
  } catch {
    return []
  }
}

export async function dismissInbox(token: string, id: string): Promise<void> {
  try {
    await fetch(urlFor(`/inbox/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    })
  } catch {
    // ignore
  }
}
