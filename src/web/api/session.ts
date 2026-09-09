// Cloud sign-in.
//
// The desktop keeps its session token in the main process and hands it to the
// renderer through window.api.account; the browser keeps it in localStorage and
// serves the same four methods from here. The renderer's account code is
// unchanged either way -- it asks window.api for a token and gets one.
//
// Signal already had the endpoints: /accounts/login, /signup, /me, /logout,
// with second-factor support. Nothing server-side was added for this.
import { signalConfig } from '@renderer/lib/signalConfig'

// The same Signal the desktop talks to, resolved by the same module, so the
// two runtimes cannot end up pointed at different servers.
const base = (): string => signalConfig.httpUrl.replace(/\/+$/, '')

const TOKEN_KEY = 'plexii.session.token'
const EMAIL_KEY = 'plexii.session.email'
const SKIPPED_KEY = 'plexii.session.skippedAt'

export interface CloudAccount {
  id: string
  email: string
  handle?: string | null
  displayName?: string | null
}

export interface LoginResult {
  ok: boolean
  error?: string
  /** True when the password was right but a second factor is needed. */
  needsCode?: boolean
  account?: CloudAccount
}

/** Storage can throw outright in private modes, so never let it break boot. */
function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* a session that cannot persist still works for this tab */ }
}

export function sessionToken(): string | null {
  return read(TOKEN_KEY)
}

export async function login(email: string, password: string, code?: string): Promise<LoginResult> {
  let res: Response
  try {
    res = await fetch(`${base()}/accounts/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, ...(code ? { code } : {}) })
    })
  } catch {
    // Distinguish "could not reach the server" from "credentials rejected".
    // Collapsing the two is how a user ends up retyping a correct password
    // while offline.
    return { ok: false, error: 'Could not reach Plexii. Check your connection and try again.' }
  }
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean; sessionToken?: string; account?: CloudAccount; error?: string; needsCode?: boolean
  }
  if (!res.ok || !body.ok || !body.sessionToken) {
    return { ok: false, error: body.error || `Sign-in failed (${res.status})`, needsCode: body.needsCode }
  }
  write(TOKEN_KEY, body.sessionToken)
  write(EMAIL_KEY, body.account?.email ?? email)
  return { ok: true, account: body.account }
}

/**
 * Create an account.
 *
 * `claimToken` is the desk link the person is holding, passed through so the
 * server can see they were invited. It matters only when signup is closed; when
 * it is open the server ignores it entirely.
 */
export async function signup(email: string, password: string, claimToken?: string | null): Promise<LoginResult> {
  let res: Response
  try {
    res = await fetch(`${base()}/accounts/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, ...(claimToken ? { claimToken } : {}) })
    })
  } catch {
    return { ok: false, error: 'Could not reach Plexii. Check your connection and try again.' }
  }
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean; sessionToken?: string; account?: CloudAccount; error?: string
  }
  if (!res.ok || !body.ok || !body.sessionToken) {
    return { ok: false, error: body.error || `Could not create the account (${res.status})` }
  }
  write(TOKEN_KEY, body.sessionToken)
  write(EMAIL_KEY, body.account?.email ?? email)
  return { ok: true, account: body.account }
}

/** Confirm a stored token is still good before booting the app behind it. */
export async function resolveSession(): Promise<CloudAccount | null> {
  const token = sessionToken()
  if (!token) return null
  try {
    const res = await fetch(`${base()}/accounts/me`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) {
      // 401 means the token is genuinely dead -- clear it. Any other status is
      // the server having a bad moment, and clearing on that would sign people
      // out during an outage they could otherwise have waited out.
      if (res.status === 401) logout()
      return null
    }
    const body = (await res.json()) as { ok?: boolean; account?: CloudAccount }
    return body.ok ? (body.account ?? null) : null
  } catch {
    return null
  }
}

export function logout(): void {
  write(TOKEN_KEY, null)
  write(EMAIL_KEY, null)
}

/**
 * The account namespace, served on the main thread rather than in the Worker.
 * The token belongs to the browser session, not to the database.
 */
export function accountNamespace(): Record<string, unknown> {
  return {
    load: async () => ({
      sessionToken: read(TOKEN_KEY),
      skippedAt: read(SKIPPED_KEY) ? Number(read(SKIPPED_KEY)) : null,
      cachedEmail: read(EMAIL_KEY)
    }),
    saveSession: async (input: { token: string; email: string | null }) => {
      write(TOKEN_KEY, input.token)
      write(EMAIL_KEY, input.email)
    },
    clearSession: async () => { logout() },
    setSkipped: async (skipped: boolean) => { write(SKIPPED_KEY, skipped ? String(Date.now()) : null) },
    setCachedEmail: async (email: string | null) => { write(EMAIL_KEY, email) }
  }
}
