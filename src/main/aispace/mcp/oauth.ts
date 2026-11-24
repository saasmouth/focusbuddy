// OAuth for protected MCP servers (MCP authorization, spec revision 2025-06-18;
// SPEC-CONNECTIONS.md §3 and §4 Remote setup).
//
// The flow, in order:
//   1. A 401 names the protected resource metadata (RFC 9728), or we look at
//      the well-known address on the MCP server's own origin.
//   2. That metadata must be for THIS endpoint, and names an authorization
//      server; its metadata (RFC 8414, OpenID fallback) must name the same
//      issuer and support PKCE S256, or we refuse.
//   3. Register Plexii as a public client (RFC 7591) unless the person gave a
//      client id, open the system browser at the authorize URL, and wait for
//      the redirect on a one-shot loopback listener (RFC 8252).
//   4. Swap the code for tokens here, in the main process, bound to the
//      resource (RFC 8707), and store them in one write.
//
// Tokens are bound to one canonical resource. They are never sent anywhere
// else, and a token response that says it is for another resource is refused.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { McpError, cleanServerText, fromNetworkError } from './errors'
import type { BearerChallenge } from './challenge'
import { EgressPolicy, canonicalResource, sameResource, type McpNetOptions } from './egress'
import { PREFERRED_PROTOCOL_VERSION, readCappedText, type BoundToken } from './transport'

// ── Stored tokens ─────────────────────────────────────────────────────────────

export interface McpTokens {
  accessToken: string
  refreshToken: string | null
  // Epoch ms; null when the server didn't say.
  expiresAt: number | null
  scope: string | null
  // The canonical MCP endpoint this token was issued for (RFC 8707).
  resource: string
  tokenEndpoint: string
  clientId: string
  issuer: string
}

// Implemented by the vault. `set` always receives the whole object, so a
// rotated refresh token and its access token can never be stored apart.
export interface McpTokenStore {
  get(connectionId: string): Promise<McpTokens | null>
  set(connectionId: string, tokens: McpTokens): Promise<void>
  clear(connectionId: string): Promise<void>
}

// Who started a sign-in. The returning redirect must match all three (§3).
export interface AuthBinding {
  userId: string
  workspaceId: string
  connectionAttemptId: string
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function stripSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

// Issuer identifiers compare as strings (RFC 8414 §3.3); one trailing slash is
// tolerated because servers disagree about it and it names the same issuer.
function sameIssuer(a: string, b: string): boolean {
  return stripSlash(a) === stripSlash(b)
}

export function normaliseScope(s: string | null | undefined): string | null {
  if (!s) return null
  const parts = Array.from(new Set(s.split(/\s+/).filter(Boolean)))
  return parts.length ? parts.join(' ') : null
}

// For a step-up after the person agreed: keep what was granted, add what is needed.
export function mergeScopes(current: string | null, required: string | null): string | null {
  return normaliseScope([current ?? '', required ?? ''].join(' '))
}

function oauthErrorOf(json: unknown): string {
  return isObject(json) && typeof json.error === 'string' ? cleanServerText(json.error, 60) : 'no reason given'
}

// ── Pending sign-ins ──────────────────────────────────────────────────────────

export interface PendingAuth {
  connectionId: string
  codeVerifier: string
  redirectUri: string
  resource: string
  issuer: string
}

export const PENDING_TTL_MS = 10 * 60_000

interface PendingEntry {
  binding: AuthBinding
  data: PendingAuth
  expiresAt: number
}

function sameBinding(a: AuthBinding, b: AuthBinding): boolean {
  return a.userId === b.userId && a.workspaceId === b.workspaceId && a.connectionAttemptId === b.connectionAttemptId
}

// In-memory only: a sign-in that outlives the process should start again.
export class PendingAuthStore {
  private readonly entries = new Map<string, PendingEntry>()

  constructor(
    private readonly ttlMs = PENDING_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  create(binding: AuthBinding, data: PendingAuth): string {
    this.sweep()
    const state = base64url(randomBytes(32))
    this.entries.set(state, { binding: { ...binding }, data, expiresAt: this.now() + this.ttlMs })
    return state
  }

  // Single use: the entry is gone after the first look, whatever the outcome,
  // so a replayed or misdirected redirect can never complete a sign-in.
  consume(state: string, binding: AuthBinding): PendingAuth {
    const entry = this.entries.get(state)
    this.entries.delete(state)
    if (!entry) {
      throw new McpError('refused', 'This sign-in response doesn’t match one Plexii started, or it was already used.', { reason: 'state_unknown' })
    }
    if (entry.expiresAt <= this.now()) {
      throw new McpError('refused', 'This sign-in response came too late. Start again from Plexii.', { reason: 'state_expired' })
    }
    if (!sameBinding(entry.binding, binding)) {
      throw new McpError('refused', 'This sign-in response belongs to a different person, workspace or attempt.', { reason: 'state_mismatch' })
    }
    return entry.data
  }

  discard(state: string): void {
    this.entries.delete(state)
  }

  get size(): number {
    this.sweep()
    return this.entries.size
  }

  private sweep(): void {
    const t = this.now()
    for (const [k, v] of this.entries) if (v.expiresAt <= t) this.entries.delete(k)
  }
}

export const pendingAuthorizations = new PendingAuthStore()

// ── Discovery ─────────────────────────────────────────────────────────────────

export interface AuthorizationDiscovery {
  // The canonical endpoint: what tokens are bound to and sent as `resource`.
  resource: string
  resourceMetadataUrl: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  scopesSupported: string[] | null
  // RFC 9207: the AS promises an `iss` on the redirect, so a missing one is refused.
  issParameterSupported: boolean
}

const METADATA_MAX_BYTES = 256 * 1024
const AS_TIMEOUT_MS = 30_000

async function getJson(
  policy: EgressPolicy,
  url: string,
  allowedOrigin: string,
  init: RequestInit = {}
): Promise<{ status: number; json: unknown }> {
  const host = new URL(url).host
  let res: Response
  try {
    res = await policy.fetch(
      url,
      { ...init, headers: { Accept: 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) } },
      allowedOrigin,
      AS_TIMEOUT_MS
    )
  } catch (e) {
    throw fromNetworkError(e, host)
  }
  let text = ''
  try {
    text = await readCappedText(res, METADATA_MAX_BYTES)
  } catch (e) {
    throw fromNetworkError(e, host)
  }
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json }
}

// RFC 9728 §3.1: the path-aware address first, then the origin root.
function wellKnownResourceUrls(endpoint: string): string[] {
  const u = new URL(endpoint)
  const path = u.pathname.replace(/\/+$/, '')
  const root = `${u.origin}/.well-known/oauth-protected-resource`
  return path ? [`${root}${path}`, root] : [root]
}

// RFC 8414 §3.1 path insertion, then OpenID Connect discovery (both spellings).
function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/+$/, '')
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`
  ]
}

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
}

export async function discoverAuthorization(
  endpoint: string,
  challenge: BearerChallenge | null,
  net: McpNetOptions = {}
): Promise<AuthorizationDiscovery> {
  const policy = new EgressPolicy(endpoint, net)
  const resource = canonicalResource(policy.endpoint)

  // 1. Protected resource metadata. It is the MCP server describing itself, so
  //    it must come from the MCP server's own origin. The address the 401 named
  //    comes first; the well-known ones are the fallback if it doesn't answer.
  const wellKnown = wellKnownResourceUrls(policy.endpoint)
  let candidates = wellKnown
  if (challenge?.resourceMetadata) {
    let u: URL
    try {
      u = new URL(challenge.resourceMetadata, policy.endpoint)
    } catch {
      throw new McpError('protocol_error', 'This server named an invalid sign-in metadata address.', { reason: 'invalid_resource_metadata' })
    }
    if (u.origin !== policy.origin) {
      throw new McpError('refused', 'This server points its sign-in details at a different site, so Plexii won’t use them.', {
        reason: 'metadata_off_origin'
      })
    }
    const named = u.toString()
    candidates = [named, ...wellKnown.filter((w) => w !== named)]
  }

  let prm: Record<string, unknown> | null = null
  let prmUrl = ''
  for (const url of candidates) {
    const r = await getJson(policy, url, policy.origin)
    if (r.status === 200 && isObject(r.json)) {
      prm = r.json
      prmUrl = url
      break
    }
    if (r.status >= 500) {
      throw new McpError('unavailable', 'The server’s sign-in details are temporarily unavailable.', { reason: 'server_error', status: r.status })
    }
  }
  if (!prm) {
    throw new McpError('protocol_error', 'This server asks for sign-in but doesn’t publish how (no protected resource metadata).', {
      reason: 'no_resource_metadata'
    })
  }
  if (typeof prm.resource !== 'string' || !sameResource(prm.resource, policy.endpoint)) {
    throw new McpError('refused', 'This server’s sign-in details are for a different address, so Plexii won’t use them.', {
      reason: 'resource_mismatch'
    })
  }
  const servers = prm.authorization_servers
  if (!Array.isArray(servers) || typeof servers[0] !== 'string' || !servers[0]) {
    throw new McpError('protocol_error', 'This server doesn’t name a sign-in server.', { reason: 'no_authorization_server' })
  }
  const issuerWanted = servers[0]
  // A remote server may not steer us at loopback or private addresses.
  policy.check(issuerWanted, 'sign-in server')
  const asOrigin = new URL(issuerWanted).origin

  // 2. Authorization server metadata, pinned to the authorization server's origin.
  let meta: Record<string, unknown> | null = null
  for (const url of authServerMetadataUrls(issuerWanted)) {
    const r = await getJson(policy, url, asOrigin, { headers: { 'MCP-Protocol-Version': PREFERRED_PROTOCOL_VERSION } })
    if (r.status === 200 && isObject(r.json)) {
      meta = r.json
      break
    }
    if (r.status >= 500) {
      throw new McpError('unavailable', 'The sign-in server is temporarily unavailable.', { reason: 'server_error', status: r.status })
    }
  }
  if (!meta) {
    throw new McpError('protocol_error', 'The sign-in server doesn’t publish its details.', { reason: 'no_authorization_metadata' })
  }

  const m: Record<string, unknown> = meta
  if (typeof m.issuer !== 'string' || !sameIssuer(m.issuer, issuerWanted)) {
    throw new McpError('refused', 'The sign-in server’s details name a different issuer, so Plexii won’t use them.', { reason: 'issuer_mismatch' })
  }
  // MCP authorization: a client MUST refuse to proceed without evidence of S256.
  const methods = stringList(m.code_challenge_methods_supported)
  if (!methods || !methods.includes('S256')) {
    throw new McpError('refused', 'This server’s sign-in doesn’t support PKCE (S256), which Plexii requires.', { reason: 'pkce_unsupported' })
  }
  const responseTypes = stringList(m.response_types_supported)
  if (responseTypes && !responseTypes.includes('code')) {
    throw new McpError('refused', 'This server’s sign-in doesn’t offer the authorization code flow.', { reason: 'code_flow_unsupported' })
  }
  const grants = stringList(m.grant_types_supported)
  if (grants && !grants.includes('authorization_code')) {
    throw new McpError('refused', 'This server’s sign-in doesn’t offer the authorization code flow.', { reason: 'code_flow_unsupported' })
  }

  // Every endpoint must be safe and live on the issuer's own origin, so the
  // code, verifier and refresh token only ever go to the server we checked.
  const issuer: string = m.issuer
  const endpointOf = (key: string, required: boolean): string | null => {
    const v = m[key]
    if (v === undefined || v === null || v === '') {
      if (required) throw new McpError('protocol_error', `The sign-in server’s details lack ${key}.`, { reason: 'incomplete_metadata' })
      return null
    }
    if (typeof v !== 'string') throw new McpError('protocol_error', `The sign-in server’s ${key} isn’t an address.`, { reason: 'incomplete_metadata' })
    const url = policy.check(v, 'sign-in address')
    if (url.origin !== new URL(issuer).origin) {
      throw new McpError('refused', 'The sign-in server sends part of sign-in to a different site, so Plexii won’t use it.', {
        reason: 'endpoint_off_origin'
      })
    }
    return url.toString()
  }

  return {
    resource,
    resourceMetadataUrl: prmUrl,
    issuer,
    authorizationEndpoint: endpointOf('authorization_endpoint', true) as string,
    tokenEndpoint: endpointOf('token_endpoint', true) as string,
    registrationEndpoint: endpointOf('registration_endpoint', false),
    scopesSupported: stringList(prm.scopes_supported) ?? stringList(m.scopes_supported),
    issParameterSupported: m.authorization_response_iss_parameter_supported === true
  }
}

// ── Token responses ───────────────────────────────────────────────────────────

interface TokenContext {
  resource: string
  tokenEndpoint: string
  clientId: string
  issuer: string
  requestedScope: string | null
  previousRefreshToken: string | null
  now: number
}

function tokensFromResponse(json: unknown, ctx: TokenContext): McpTokens {
  if (!isObject(json) || typeof json.access_token !== 'string' || !json.access_token) {
    throw new McpError('protocol_error', 'The sign-in server’s token answer was incomplete.', { reason: 'invalid_token_response' })
  }
  if (json.token_type !== undefined && String(json.token_type).toLowerCase() !== 'bearer') {
    throw new McpError('refused', 'The sign-in server issued a kind of token Plexii doesn’t use.', { reason: 'token_type' })
  }
  // Never accept a token the server says is for somewhere else (RFC 8707).
  if (json.resource !== undefined && (typeof json.resource !== 'string' || !sameResource(json.resource, ctx.resource))) {
    throw new McpError('refused', 'The sign-in server issued a token for a different address, so Plexii refused it.', {
      reason: 'token_resource_mismatch'
    })
  }
  if (json.aud !== undefined) {
    const auds = Array.isArray(json.aud) ? json.aud : [json.aud]
    if (!auds.some((a) => typeof a === 'string' && sameResource(a, ctx.resource))) {
      throw new McpError('refused', 'The sign-in server issued a token for a different audience, so Plexii refused it.', {
        reason: 'token_resource_mismatch'
      })
    }
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : Number(json.expires_in)
  return {
    accessToken: json.access_token,
    // No new refresh token = the server doesn't rotate; keep the one we have.
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : ctx.previousRefreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? ctx.now + expiresIn * 1000 : null,
    // RFC 6749 §5.1: an omitted scope means the scope that was requested.
    scope: typeof json.scope === 'string' ? normaliseScope(json.scope) : ctx.requestedScope,
    resource: ctx.resource,
    tokenEndpoint: ctx.tokenEndpoint,
    clientId: ctx.clientId,
    issuer: ctx.issuer
  }
}

async function tokenRequest(policy: EgressPolicy, tokenEndpoint: string, issuer: string, body: URLSearchParams): Promise<{ status: number; json: unknown }> {
  const origin = new URL(tokenEndpoint).origin
  if (origin !== new URL(issuer).origin) {
    throw new McpError('refused', 'The token address isn’t on the sign-in server’s site.', { reason: 'endpoint_off_origin' })
  }
  policy.check(tokenEndpoint, 'token address')
  return getJson(policy, tokenEndpoint, origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
}

// ── Client registration (RFC 7591) ────────────────────────────────────────────

async function registerClient(policy: EgressPolicy, d: AuthorizationDiscovery, redirectUri: string): Promise<string> {
  if (!d.registrationEndpoint) {
    throw new McpError('protocol_error', 'This server doesn’t let apps register themselves. Add the client ID its owner gave you, then try again.', {
      reason: 'client_id_required'
    })
  }
  const r = await getJson(policy, d.registrationEndpoint, new URL(d.registrationEndpoint).origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Plexii',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  })
  if (r.status >= 500) {
    throw new McpError('unavailable', 'The sign-in server couldn’t register Plexii just now.', { reason: 'server_error', status: r.status })
  }
  if ((r.status !== 200 && r.status !== 201) || !isObject(r.json) || typeof r.json.client_id !== 'string' || !r.json.client_id) {
    throw new McpError('protocol_error', `The sign-in server wouldn’t register Plexii (${oauthErrorOf(r.json)}).`, {
      reason: 'registration_failed',
      status: r.status
    })
  }
  // A desktop app can't keep a client secret (RFC 8252 §8.5): refuse rather
  // than store one next to the tokens.
  const method = r.json.token_endpoint_auth_method
  if (method !== undefined && method !== 'none') {
    throw new McpError('refused', 'This server would only register Plexii with a client secret, which an app on your computer can’t keep safe.', {
      reason: 'confidential_client'
    })
  }
  return r.json.client_id
}

// ── Loopback redirect receiver (RFC 8252 §7.3) ───────────────────────────────

interface CallbackParams {
  state: string
  code: string | null
  error: string | null
  iss: string | null
}

const PAGE_DONE = 'You can close this tab and return to Plexii.'
const PAGE_NOT_GRANTED = 'Access was not granted. You can close this tab and return to Plexii.'
const PAGE_FAILED = 'Sign-in didn’t finish. You can close this tab and return to Plexii.'
const PAGE_MISMATCH = 'This sign-in response doesn’t match the one Plexii started. Return to Plexii and try again.'

// The page the browser shows. Fixed text only: no code, state or token is
// ever echoed into it.
function page(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close'
  })
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plexii</title></head><body><p>${message}</p></body></html>`)
}

class LoopbackReceiver {
  redirectUri = ''
  private readonly server: Server
  private accept: ((p: CallbackParams) => boolean) | null = null
  private result: CallbackParams | null = null
  private settle: ((p: CallbackParams) => void) | null = null

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res))
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      // 127.0.0.1 only: the redirect must never be reachable from the network.
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const port = (this.server.address() as AddressInfo).port
    this.redirectUri = `http://127.0.0.1:${port}/callback`
  }

  expect(accept: (p: CallbackParams) => boolean): void {
    this.accept = accept
  }

  wait(timeoutMs: number, signal?: AbortSignal): Promise<CallbackParams> {
    return new Promise<CallbackParams>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (fn: () => void): void => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.settle = null
        fn()
      }
      const onAbort = (): void => finish(() => reject(new McpError('cancelled', 'Sign-in was cancelled.', { reason: 'cancelled' })))
      if (this.result) {
        resolve(this.result)
        return
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => finish(() => reject(new McpError('timeout', 'Sign-in wasn’t finished in time.', { reason: 'authorization_timeout' }))),
        timeoutMs
      )
      this.settle = (p) => finish(() => resolve(p))
    })
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback') return page(res, 404, 'Not found.')
    const p: CallbackParams = {
      state: url.searchParams.get('state') ?? '',
      code: url.searchParams.get('code'),
      error: url.searchParams.get('error'),
      iss: url.searchParams.get('iss')
    }
    // A stray or forged request doesn't end the sign-in: it is answered 400
    // and we keep waiting for the real redirect (bounded by the timeout).
    if (this.result || !this.accept || !this.accept(p)) return page(res, 400, PAGE_MISMATCH)
    this.result = p
    page(res, 200, p.error ? (p.error === 'access_denied' ? PAGE_NOT_GRANTED : PAGE_FAILED) : PAGE_DONE)
    this.settle?.(p)
  }
}

// ── Authorisation ─────────────────────────────────────────────────────────────

export const AUTHORIZE_TIMEOUT_MS = 5 * 60_000

export interface AuthorizeOptions {
  connectionId: string
  endpoint: string
  binding: AuthBinding
  // Opens the system browser. Injected so the core never imports Electron's
  // shell, and so tests can play the browser themselves.
  openExternal: (url: string) => void | Promise<void>
  tokenStore: McpTokenStore
  // From the 401 that started this, when there was one.
  challenge?: BearerChallenge | null
  // An explicit scope, for a step-up the person agreed to. Otherwise the
  // challenge's scope, otherwise none: Plexii never asks for scopes_supported
  // wholesale.
  scope?: string | null
  // For servers without dynamic registration: the client id their owner issued.
  clientId?: string | null
  timeoutMs?: number
  signal?: AbortSignal
  net?: McpNetOptions
  pending?: PendingAuthStore
  now?: () => number
}

export interface AuthorizeResult {
  issuer: string
  resource: string
  scope: string | null
  expiresAt: number | null
}

export async function authorizeMcpServer(o: AuthorizeOptions): Promise<AuthorizeResult> {
  const net = o.net ?? {}
  const pending = o.pending ?? pendingAuthorizations
  const now = o.now ?? Date.now
  const receiver = new LoopbackReceiver()
  let state: string | null = null
  try {
    const d = await discoverAuthorization(o.endpoint, o.challenge ?? null, net)
    const policy = new EgressPolicy(o.endpoint, net)
    const scope = normaliseScope(o.scope ?? o.challenge?.scope ?? null)

    await receiver.listen()
    // A fresh registration per attempt: the loopback port changes each time
    // and the redirect URI must match exactly.
    const clientId = o.clientId?.trim() || (await registerClient(policy, d, receiver.redirectUri))

    const codeVerifier = base64url(randomBytes(32))
    state = pending.create(o.binding, {
      connectionId: o.connectionId,
      codeVerifier,
      redirectUri: receiver.redirectUri,
      resource: d.resource,
      issuer: d.issuer
    })
    const ownState = state
    let consumed: PendingAuth | null = null
    receiver.expect((p) => {
      if (p.state !== ownState) return false
      try {
        consumed = pending.consume(p.state, o.binding)
        return true
      } catch {
        return false
      }
    })

    const url = new URL(d.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', receiver.redirectUri)
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    url.searchParams.set('resource', d.resource)
    if (scope) url.searchParams.set('scope', scope)
    // The browser resolves the name itself; check it here too so a remote
    // server can't send the person's browser to a private address.
    await policy.checkResolves(url.toString(), 'sign-in page')

    try {
      await o.openExternal(url.toString())
    } catch {
      throw new McpError('unavailable', 'Plexii couldn’t open your browser for sign-in.', { reason: 'browser_failed' })
    }

    const cb = await receiver.wait(o.timeoutMs ?? AUTHORIZE_TIMEOUT_MS, o.signal)
    if (cb.error) {
      if (cb.error === 'access_denied') throw new McpError('denied', 'Access wasn’t granted at the sign-in page.', { reason: 'access_denied' })
      throw new McpError('protocol_error', `The sign-in server reported a problem (${cleanServerText(cb.error, 60)}).`, {
        reason: 'authorization_error'
      })
    }
    // RFC 9207 mix-up defence: the redirect must come from the issuer we checked.
    if (cb.iss !== null ? !sameIssuer(cb.iss, d.issuer) : d.issParameterSupported) {
      throw new McpError('refused', 'The sign-in response came from a different issuer.', { reason: 'issuer_mismatch' })
    }
    const data = consumed as PendingAuth | null
    if (!cb.code || !data) throw new McpError('protocol_error', 'The sign-in server didn’t return a code.', { reason: 'no_code' })

    const r = await tokenRequest(
      policy,
      d.tokenEndpoint,
      d.issuer,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: cb.code,
        redirect_uri: data.redirectUri,
        client_id: clientId,
        code_verifier: data.codeVerifier,
        resource: d.resource
      })
    )
    if (r.status >= 500) {
      throw new McpError('unavailable', 'The sign-in server couldn’t issue a token just now.', { reason: 'server_error', status: r.status })
    }
    if (r.status !== 200) {
      throw new McpError('protocol_error', `The sign-in server wouldn’t issue a token (${oauthErrorOf(r.json)}).`, {
        reason: 'token_exchange_failed',
        status: r.status
      })
    }
    const tokens = tokensFromResponse(r.json, {
      resource: d.resource,
      tokenEndpoint: d.tokenEndpoint,
      clientId,
      issuer: d.issuer,
      requestedScope: scope,
      previousRefreshToken: null,
      now: now()
    })
    await o.tokenStore.set(o.connectionId, tokens)
    return { issuer: d.issuer, resource: d.resource, scope: tokens.scope, expiresAt: tokens.expiresAt }
  } catch (e) {
    // Carry the attempt id so the UI returns the person to the same draft.
    if (e instanceof McpError) e.attemptId = o.binding.connectionAttemptId
    throw e
  } finally {
    if (state) pending.discard(state)
    await receiver.close()
  }
}

// ── Refresh, single-flight ────────────────────────────────────────────────────

// Treat a token as expired a little early so it doesn't lapse in flight.
const EXPIRY_SKEW_MS = 30_000

function reconnect(reason: string, status: number | null = null): McpError {
  return new McpError('reconnect_required', 'Sign-in for this server has expired or was revoked. Reconnect to keep using it.', { reason, status })
}

export class McpTokenManager {
  // One refresh at a time per connection: rotating refresh tokens are single
  // use, so two parallel refreshes would make the second fail (§3).
  private readonly inflight = new Map<string, Promise<McpTokens>>()

  constructor(
    readonly store: McpTokenStore,
    private readonly now: () => number = Date.now
  ) {}

  expired(t: McpTokens): boolean {
    return t.expiresAt !== null && t.expiresAt - EXPIRY_SKEW_MS <= this.now()
  }

  // The token to send to `endpoint`, refreshed first when expired. null means
  // nothing is stored (never authorised). A token bound to another resource is
  // refused here, before it can reach a request.
  async tokenFor(connectionId: string, endpoint: string, net: McpNetOptions): Promise<BoundToken | null> {
    const t = await this.store.get(connectionId)
    if (!t) return null
    if (!sameResource(t.resource, endpoint)) {
      throw new McpError('refused', 'Plexii won’t send this connection’s sign-in to a different address. Reconnect to authorise this one.', {
        reason: 'token_resource_mismatch'
      })
    }
    const fresh = this.expired(t) ? await this.refresh(connectionId, endpoint, t.accessToken, net) : t
    return { token: fresh.accessToken, resource: fresh.resource }
  }

  // `staleAccessToken` is the token the caller found wanting. If the store
  // already holds a different, live one, another caller refreshed first and
  // no second refresh is made.
  refresh(connectionId: string, endpoint: string, staleAccessToken: string, net: McpNetOptions): Promise<McpTokens> {
    const running = this.inflight.get(connectionId)
    if (running) return running
    const p: Promise<McpTokens> = this.doRefresh(connectionId, endpoint, staleAccessToken, net).finally(() => {
      if (this.inflight.get(connectionId) === p) this.inflight.delete(connectionId)
    })
    this.inflight.set(connectionId, p)
    return p
  }

  private async doRefresh(connectionId: string, endpoint: string, staleAccessToken: string, net: McpNetOptions): Promise<McpTokens> {
    const cur = await this.store.get(connectionId)
    if (!cur) throw reconnect('no_tokens')
    if (!sameResource(cur.resource, endpoint)) {
      throw new McpError('refused', 'Plexii won’t send this connection’s sign-in to a different address.', { reason: 'token_resource_mismatch' })
    }
    if (cur.accessToken !== staleAccessToken && !this.expired(cur)) return cur
    if (!cur.refreshToken) throw reconnect('no_refresh_token')

    const policy = new EgressPolicy(cur.resource, net)
    const r = await tokenRequest(
      policy,
      cur.tokenEndpoint,
      cur.issuer,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cur.refreshToken, client_id: cur.clientId, resource: cur.resource })
    )
    // An outage isn't a revoked grant: say "try later", not "reconnect".
    if (r.status >= 500 || r.status === 429) {
      throw new McpError('unavailable', 'The sign-in server is temporarily unavailable.', { reason: 'server_error', status: r.status })
    }
    if (r.status !== 200) throw reconnect('refresh_rejected', r.status)
    let next: McpTokens
    try {
      next = tokensFromResponse(r.json, {
        resource: cur.resource,
        tokenEndpoint: cur.tokenEndpoint,
        clientId: cur.clientId,
        issuer: cur.issuer,
        requestedScope: cur.scope,
        previousRefreshToken: cur.refreshToken,
        now: this.now()
      })
    } catch (e) {
      if (e instanceof McpError && e.code === 'protocol_error') throw reconnect('refresh_invalid')
      throw e
    }
    // One write with the whole object: the rotated refresh token and the new
    // access token land together or not at all.
    await this.store.set(connectionId, next)
    return next
  }
}

// Every client for the same store shares one manager, so single-flight holds
// across a run and the settings screen talking to the same connection.
const managers = new WeakMap<McpTokenStore, McpTokenManager>()

export function tokenManagerFor(store: McpTokenStore): McpTokenManager {
  let m = managers.get(store)
  if (!m) {
    m = new McpTokenManager(store)
    managers.set(store, m)
  }
  return m
}
