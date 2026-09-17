import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { shell, safeStorage, net, app } from 'electron'
import { randomUUID } from 'crypto'
import { getDb } from '../db/database'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// Signing in to Google and Microsoft.
//
// Authorization Code + PKCE against a loopback redirect, which is the flow both
// providers document for desktop apps: no client secret is involved, because a
// secret shipped inside an app people can unzip is not a secret.
//
// What this CANNOT do by itself: a desktop OAuth client has to be registered by
// somebody with the account, and Google's calendar scope is "sensitive", so an
// unverified client is limited to the test users its owner lists. There is no
// way around that from inside the app, and pretending otherwise -- shipping a
// borrowed client id, say -- would break for every user the moment the quota or
// the consent screen changed. So the client id is configuration, and the UI says
// where to get one.

export interface OAuthProviderConfig {
  clientId: string
}

interface StoredTokens {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms. */
  expiresAt: number
  email?: string
}

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // The read/write events scope rather than calendar.readonly: without it a
    // push comes back 403 at the moment somebody tries it, which is the worst
    // time to discover a permission is missing. Reading still works the same.
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    extraAuth: { access_type: 'offline', prompt: 'consent' } as Record<string, string>
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['Calendars.ReadWrite', 'offline_access', 'User.Read'],
    extraAuth: {} as Record<string, string>
  }
} as const

export type OAuthProvider = keyof typeof PROVIDERS

// ── Client id storage ───────────────────────────────────────────────────────
// Not a secret, but it is configuration the user pasted and it belongs with the
// app's own data rather than in the database (which gets exported and shared).

const configPath = (): string => join(app.getPath('userData'), 'calendar-oauth.json')

export function getProviderConfig(provider: OAuthProvider): OAuthProviderConfig | null {
  try {
    if (!existsSync(configPath())) return null
    const all = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, OAuthProviderConfig>
    const c = all?.[provider]
    return c?.clientId ? c : null
  } catch {
    return null
  }
}

export function setProviderConfig(provider: OAuthProvider, config: OAuthProviderConfig | null): void {
  let all: Record<string, OAuthProviderConfig> = {}
  try {
    if (existsSync(configPath())) all = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    all = {}
  }
  if (config?.clientId) all[provider] = { clientId: config.clientId.trim() }
  else delete all[provider]
  writeFileSync(configPath(), JSON.stringify(all, null, 2), 'utf8')
}

// ── Token storage ───────────────────────────────────────────────────────────

function saveTokens(provider: OAuthProvider, tokens: StoredTokens, accountId?: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable on this machine, so PlexiDesk will not store a calendar token.'
    )
  }
  const cipher = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
  const db = getDb()
  const now = Date.now()
  const id = accountId ?? randomUUID()
  db.prepare(
    `INSERT INTO external_accounts (id, provider, email, token_cipher, created_at, updated_at)
     VALUES (@id, @provider, @email, @cipher, @now, @now)
     ON CONFLICT(id) DO UPDATE SET token_cipher = @cipher, email = @email, updated_at = @now`
  ).run({ id, provider, email: tokens.email ?? null, cipher, now })
  return id
}

function readTokens(accountId: string): { provider: OAuthProvider; tokens: StoredTokens } | null {
  const row = getDb()
    .prepare('SELECT provider, token_cipher FROM external_accounts WHERE id = ?')
    .get(accountId) as { provider: OAuthProvider; token_cipher: string } | undefined
  if (!row) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return {
      provider: row.provider,
      tokens: JSON.parse(safeStorage.decryptString(Buffer.from(row.token_cipher, 'base64')))
    }
  } catch {
    return null
  }
}

export function listAccounts(): Array<{ id: string; provider: string; email: string | null }> {
  return getDb()
    .prepare('SELECT id, provider, email FROM external_accounts ORDER BY created_at')
    .all() as Array<{ id: string; provider: string; email: string | null }>
}

export function deleteAccount(id: string): boolean {
  const res = getDb().prepare('DELETE FROM external_accounts WHERE id = ?').run(id)
  return (res.changes ?? 0) > 0
}

// ── The flow ────────────────────────────────────────────────────────────────

const base64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A loopback server that answers exactly one redirect, then stops. */
function awaitRedirect(): Promise<{ server: Server; port: number; code: Promise<string> }> {
  return new Promise((resolve, reject) => {
    let settle: ((v: string) => void) | null = null
    let fail: ((e: Error) => void) | null = null
    const code = new Promise<string>((res, rej) => {
      settle = res
      fail = rej
    })
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const got = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>PlexiDesk</title>
         <body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#faf9f7;color:#2b2a28">
         <div style="text-align:center"><p style="font-size:17px;font-weight:600">${
           got ? 'Calendar connected' : 'Connection cancelled'
         }</p><p style="opacity:.65">You can close this tab and go back to PlexiDesk.</p></div></body>`
      )
      if (got) settle?.(got)
      else fail?.(new Error(err ? `The provider returned: ${err}` : 'No authorisation code came back.'))
      setTimeout(() => server.close(), 500)
    })
    server.on('error', reject)
    // Port 0 = let the OS pick a free one, which avoids fighting whatever else
    // is on the machine. Both providers allow any loopback port.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port, code })
      else reject(new Error('Could not open a local port for the sign-in redirect.'))
    })
  })
}

async function postForm(
  url: string,
  form: Record<string, string>
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString()
    })
    const text = await res.text()
    let body: Record<string, unknown>
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, error: `The provider returned something that was not JSON (${res.status}).` }
    }
    if (!res.ok) {
      const desc = (body.error_description ?? body.error ?? '') as string
      return { ok: false, error: desc || `The provider refused the request (${res.status}).` }
    }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ConnectResult {
  ok: boolean
  accountId?: string
  email?: string
  error?: string
}

/** Run the whole sign-in and store the tokens. Opens the system browser. */
export async function connect(provider: OAuthProvider): Promise<ConnectResult> {
  const cfg = getProviderConfig(provider)
  if (!cfg?.clientId) {
    return {
      ok: false,
      error: `No ${provider === 'google' ? 'Google' : 'Microsoft'} client ID is configured yet.`
    }
  }

  const p = PROVIDERS[provider]
  const verifier = base64url(randomBytes(64))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(16))

  let redirect: Awaited<ReturnType<typeof awaitRedirect>>
  try {
    redirect = await awaitRedirect()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const redirectUri = `http://127.0.0.1:${redirect.port}`

  const authUrl = new URL(p.authUrl)
  authUrl.searchParams.set('client_id', cfg.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', p.scopes.join(' '))
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  for (const [k, v] of Object.entries(p.extraAuth)) authUrl.searchParams.set(k, v)

  await shell.openExternal(authUrl.toString())

  let code: string
  try {
    // Five minutes is long enough to find a password manager and short enough
    // that a forgotten browser tab does not hold a port forever.
    code = await Promise.race([
      redirect.code,
      new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error('Sign-in timed out after five minutes.')), 300_000)
      )
    ])
  } catch (e) {
    redirect.server.close()
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const token = await postForm(p.tokenUrl, {
    client_id: cfg.clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  })
  if (!token.ok) return { ok: false, error: token.error }

  const accessToken = String(token.body.access_token ?? '')
  const refreshToken = token.body.refresh_token ? String(token.body.refresh_token) : null
  const expiresIn = Number(token.body.expires_in ?? 3600)
  if (!accessToken) return { ok: false, error: 'No access token came back.' }

  const email = await fetchEmail(provider, accessToken)
  try {
    const accountId = saveTokens(provider, {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      email
    })
    return { ok: true, accountId, email }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fetchEmail(provider: OAuthProvider, accessToken: string): Promise<string | undefined> {
  const url =
    provider === 'google'
      ? 'https://www.googleapis.com/oauth2/v2/userinfo'
      : 'https://graph.microsoft.com/v1.0/me'
  try {
    const res = await net.fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return undefined
    const body = (await res.json()) as { email?: string; mail?: string; userPrincipalName?: string }
    return body.email ?? body.mail ?? body.userPrincipalName ?? undefined
  } catch {
    return undefined
  }
}

/** A usable access token, refreshing it first if it has expired. */
export async function accessTokenFor(
  accountId: string | null
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (!accountId) return { ok: false, error: 'This calendar is not linked to an account.' }
  const stored = readTokens(accountId)
  if (!stored) {
    return {
      ok: false,
      error: 'The saved sign-in could not be read. Reconnect the account.'
    }
  }
  // A minute of slack, so a token that expires mid-request is refreshed first.
  if (stored.tokens.expiresAt - 60_000 > Date.now()) {
    return { ok: true, token: stored.tokens.accessToken }
  }
  if (!stored.tokens.refreshToken) {
    return { ok: false, error: 'The sign-in has expired and no refresh token was given. Reconnect the account.' }
  }
  const cfg = getProviderConfig(stored.provider)
  if (!cfg?.clientId) return { ok: false, error: 'The client ID for this provider is no longer configured.' }

  const refreshed = await postForm(PROVIDERS[stored.provider].tokenUrl, {
    client_id: cfg.clientId,
    refresh_token: stored.tokens.refreshToken,
    grant_type: 'refresh_token'
  })
  if (!refreshed.ok) return { ok: false, error: refreshed.error }

  const accessToken = String(refreshed.body.access_token ?? '')
  if (!accessToken) return { ok: false, error: 'The refresh returned no access token.' }
  const expiresIn = Number(refreshed.body.expires_in ?? 3600)
  saveTokens(
    stored.provider,
    {
      accessToken,
      // Providers only re-issue a refresh token sometimes; keeping the old one
      // is what makes a long-lived connection actually long-lived.
      refreshToken: refreshed.body.refresh_token
        ? String(refreshed.body.refresh_token)
        : stored.tokens.refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      email: stored.tokens.email
    },
    accountId
  )
  return { ok: true, token: accessToken }
}

export interface RemoteCalendar {
  id: string
  name: string
  color?: string
  primary?: boolean
}

/** The calendars an account can see, so the user picks rather than types an id. */
export async function listRemoteCalendars(
  accountId: string
): Promise<{ ok: true; calendars: RemoteCalendar[] } | { ok: false; error: string }> {
  const stored = readTokens(accountId)
  if (!stored) return { ok: false, error: 'That account is no longer connected.' }
  const token = await accessTokenFor(accountId)
  if (!token.ok) return { ok: false, error: token.error }

  const url =
    stored.provider === 'google'
      ? 'https://www.googleapis.com/calendar/v3/users/me/calendarList'
      : 'https://graph.microsoft.com/v1.0/me/calendars'
  try {
    const res = await net.fetch(url, { headers: { Authorization: `Bearer ${token.token}` } })
    if (!res.ok) return { ok: false, error: `The provider answered ${res.status}.` }
    const body = (await res.json()) as {
      items?: Array<{ id: string; summary?: string; backgroundColor?: string; primary?: boolean }>
      value?: Array<{ id: string; name?: string; hexColor?: string; isDefaultCalendar?: boolean }>
    }
    const calendars: RemoteCalendar[] =
      stored.provider === 'google'
        ? (body.items ?? []).map((c) => ({
            id: c.id,
            name: c.summary ?? c.id,
            color: c.backgroundColor,
            primary: c.primary
          }))
        : (body.value ?? []).map((c) => ({
            id: c.id,
            name: c.name ?? c.id,
            color: c.hexColor && c.hexColor !== 'auto' ? c.hexColor : undefined,
            primary: c.isDefaultCalendar
          }))
    return { ok: true, calendars }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
