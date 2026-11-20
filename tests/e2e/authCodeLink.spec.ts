/**
 * Auth step 2 (2026-11-20; plexii-work/auth-step2-design.md): a sign-in link
 * carries a one-time CODE, never a session, and only this Plexii can redeem it.
 *
 * Signal is stood in for by a local server written to a0's contract
 * (haptyx-ecosystem signal-desk-auth-codes f4104856, tests/deskHandoffCodeFlow.mjs):
 *   POST /auth/app/code   (what the website calls once the person is signed in)
 *        { client_id, redirect_uri, code_challenge, code_challenge_method, state }
 *        -> { redirectTo: 'haptyx://auth?code=…&state=…' }
 *   POST /auth/app/token  (what Plexii's MAIN process calls)
 *        { grant_type, code, code_verifier, redirect_uri, client_id }
 *        -> 200 { sessionToken, tokenType, expiresAt, account } | 400 { error }
 *        A code is spent by its first attempt; S256(verifier) must be its challenge.
 * Main reaches it through FB_SIGNAL_URL. The renderer's own calls (/accounts/me)
 * are answered from before the first window. Nothing reaches the real server,
 * and shell.openExternal is recorded in main, so no browser opens.
 *
 * JOINT CHECK: with PLEXII_JOINT_SIGNAL=<http://127.0.0.1:port of a0's real
 * signal on loopback> the stand-in becomes a recording proxy to it (each test
 * signs a fresh account up there and the website's code is minted with its
 * session), so every assertion below holds against the real server too.
 *
 *   AC-1  A sign-in Plexii started: the code link that comes back is redeemed
 *         ONCE by main, with the verifier whose challenge went out, and adopted
 *         without a question. A second press of Continue (a fresh code, the same
 *         spent state) is never sent to signal, and says nothing.
 *   AC-2  A code link Plexii did not start: one alert, and never sent to signal.
 *   AC-3  The website's cold button (haptyx://auth/start), nobody signed in:
 *         Plexii opens the website's sign-in with its state, PKCE challenge
 *         and client; the code that comes back for it signs in.
 *   AC-4  /start with someone signed in: nothing opens, nobody is switched.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { ACTIVE } from '../../src/shared/productDomains'

const API = new URL(ACTIVE.api)
const ME = { id: 'acct-me', email: 'me@example.com', handle: 'me', firstName: 'Robin', lastName: 'Lee', createdAt: 0, lastLoginAt: null, emailVerified: true }

// ── The stand-in signal ──────────────────────────────────────────────────────
type Code = { challenge: string; state: string; used: boolean }
type Stub = {
  url: string
  server: Server
  codes: Map<string, Code>
  tokenCalls: Array<Record<string, unknown>>
  /** Sessions /auth/app/token handed out, in order. */
  sessions: string[]
  /** The account the website is signed in as. */
  email: string
  /** Joint check: the real signal, and the website's session there. */
  joint: { base: string; session: string } | null
}
let stub: Stub
const S256 = (v: string): string => createHash('sha256').update(v).digest('base64url')
const JOINT = process.env.PLEXII_JOINT_SIGNAL?.replace(/\/+$/, '') || null
if (JOINT && !/^http:\/\/127\.0\.0\.1:\d+$/.test(JOINT)) throw new Error('PLEXII_JOINT_SIGNAL must be a loopback signal (http://127.0.0.1:<port>), never a real host')

test.beforeEach(async () => {
  const codes = new Map<string, Code>()
  const tokenCalls: Array<Record<string, unknown>> = []
  const sessions: string[] = []
  let joint: Stub['joint'] = null
  let email = ME.email
  if (JOINT) {
    // The person, signed in on the website: a fresh account on the real signal.
    email = `desk-${randomBytes(6).toString('hex')}@desk-codes.test`
    const r = await fetch(`${JOINT}/accounts/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct horse battery', firstName: 'Robin', lastName: 'Lee' })
    })
    const j = (await r.json()) as { sessionToken?: string }
    if (r.status !== 200 || !j.sessionToken) throw new Error(`joint signup failed: ${r.status}`)
    joint = { base: JOINT, session: j.sessionToken }
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (joint) {
        // A recording proxy to the real signal: the website's call carries its session.
        if (req.url === '/auth/app/token') tokenCalls.push(JSON.parse(raw || '{}') as Record<string, unknown>)
        void fetch(`${joint.base}${req.url}`, {
          method: req.method,
          headers: { 'content-type': 'application/json', ...(req.url === '/auth/app/code' ? { authorization: `Bearer ${joint.session}` } : {}) },
          body: req.method === 'POST' ? raw : undefined
        }).then(async (r) => {
          const text = await r.text()
          if (req.url === '/auth/app/token' && r.status === 200) sessions.push((JSON.parse(text) as { sessionToken: string }).sessionToken)
          res.writeHead(r.status, { 'content-type': 'application/json' })
          res.end(text)
        })
        return
      }
      const body = (() => {
        try {
          return JSON.parse(raw) as Record<string, unknown>
        } catch {
          return {}
        }
      })()
      if (req.method === 'POST' && req.url === '/auth/app/code') {
        if (body.client_id !== 'plexiidesk' || body.redirect_uri !== 'haptyx://auth' || body.code_challenge_method !== 'S256') return send(400, { error: 'invalid_request' })
        const code = randomBytes(32).toString('base64url')
        codes.set(code, { challenge: String(body.code_challenge), state: String(body.state), used: false })
        return send(200, { redirectTo: `haptyx://auth?code=${code}&state=${encodeURIComponent(String(body.state))}` })
      }
      if (req.method === 'POST' && req.url === '/auth/app/token') {
        tokenCalls.push(body)
        if (body.grant_type !== 'authorization_code') return send(400, { error: 'unsupported_grant_type', message: 'no' })
        if (body.client_id !== 'plexiidesk' || body.redirect_uri !== 'haptyx://auth') return send(400, { error: 'invalid_client', message: 'no' })
        const c = codes.get(String(body.code))
        if (!c || c.used) return send(400, { error: 'invalid_grant', message: 'used or unknown' })
        c.used = true // spent by the first attempt, right or wrong
        if (S256(String(body.code_verifier)) !== c.challenge) return send(400, { error: 'invalid_grant', message: 'verifier' })
        const sessionToken = `desk-session-${sessions.length + 1}`
        sessions.push(sessionToken)
        return send(200, { sessionToken, tokenType: 'session', expiresAt: Date.now() + 30 * 864e5, account: { id: ME.id, email: ME.email, handle: ME.handle } })
      }
      send(404, { error: 'not here' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  stub = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, codes, tokenCalls, sessions, email, joint }
})

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  await new Promise<void>((r) => stub.server.close(() => r()))
})

/** What the website does once the person is signed in and clicks Continue: ask signal for a code. */
async function websiteIssuesCode(state: string, codeChallenge: string): Promise<string> {
  const r = await fetch(`${stub.url}/auth/app/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'plexiidesk', redirect_uri: 'haptyx://auth', code_challenge: codeChallenge, code_challenge_method: 'S256', state })
  })
  return ((await r.json()) as { redirectTo: string }).redirectTo
}

/** The renderer's server: /accounts/me knows the stub's sessions as ME; the rest is 404 (never signs anyone out). */
async function rendererServer(app: ElectronApplication): Promise<void> {
  const ctx = app.context()
  await ctx.route((u) => u.origin === API.origin, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) }))
  await ctx.routeWebSocket((u) => u.host === API.host, () => undefined)
  await ctx.route((u) => u.origin === API.origin && u.pathname === '/accounts/me', async (route) => {
    const auth = route.request().headers()['authorization'] ?? ''
    if (stub.joint) {
      // The real signal answers who the session is.
      const r = await fetch(`${stub.joint.base}/accounts/me`, { headers: { authorization: auth } })
      return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() })
    }
    if (!stub.sessions.includes(auth.replace(/^Bearer /, ''))) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false }) })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, account: ME }) })
  })
}

const launch = (): Promise<LaunchedApp> => launchApp({ env: { FB_SIGNAL_URL: stub.url }, beforeFirstWindow: rendererServer })
const sessionToken = (window: Page): Promise<string | null> =>
  window.evaluate(() => (window as unknown as { __fbAccount: { getState: () => { sessionToken: string | null } } }).__fbAccount.getState().sessionToken)
/** Signed in with the first session /auth/app/token handed out (read when polled, not before). */
const adoptedFirstSession = (window: Page) => async (): Promise<boolean> => {
  const t = await sessionToken(window)
  return t !== null && t === stub.sessions[0]
}
const beginSignIn = (window: Page): Promise<{ state: string; codeChallenge: string }> =>
  window.evaluate(() => (window as unknown as { api: { auth: { beginSignIn: () => Promise<{ state: string; codeChallenge: string }> } } }).api.auth.beginSignIn())
async function openLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: a }, u) => {
    a.emit('open-url', { preventDefault: () => undefined }, u)
  }, url)
}
async function recordOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (u: string) => void g.__opened.push(u)
  })
}
const opened = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __opened?: string[] }).__opened ?? [])
const prompt = (window: Page) => window.locator('[data-testid="prompt-dialog"]')

test('AC-1 a sign-in Plexii started: main redeems the code once, with its own verifier, and it is adopted without a question', async () => {
  launched = await launch()
  const { app, window } = launched
  await waitForReady(window)
  const begin = await beginSignIn(window)
  expect(JSON.stringify(begin)).not.toMatch(/verifier/) // the renderer never holds it
  const link = await websiteIssuesCode(begin.state, begin.codeChallenge)
  expect(link).toMatch(/^haptyx:\/\/auth\?code=[A-Za-z0-9_-]{43}&state=/)
  await openLink(app, link)
  await expect.poll(adoptedFirstSession(window), { timeout: 15_000 }).toBe(true)
  await expect(prompt(window)).toHaveCount(0)
  expect(stub.tokenCalls).toHaveLength(1)
  expect(stub.tokenCalls[0]).toMatchObject({ grant_type: 'authorization_code', client_id: 'plexiidesk', redirect_uri: 'haptyx://auth' })
  expect(S256(String(stub.tokenCalls[0]!.code_verifier))).toBe(begin.codeChallenge)

  // Continue pressed again on the website: a fresh code for the same, spent state.
  // Never sent to signal, and nothing said on top of a sign-in that worked.
  await openLink(app, await websiteIssuesCode(begin.state, begin.codeChallenge))
  await window.waitForTimeout(1500)
  await expect(prompt(window)).toHaveCount(0)
  expect(stub.tokenCalls).toHaveLength(1)
  expect(await sessionToken(window)).toBe(stub.sessions[0])
})

test('AC-2 a code link Plexii did not start: one alert, never sent to signal, nobody signed in', async () => {
  launched = await launch()
  const { app, window } = launched
  await waitForReady(window)
  // A real code, minted for someone else's challenge and state (another app, or an attacker's).
  const link = await websiteIssuesCode('someone-elses-state-000000000', S256('someone-elses-verifier-000000000000000000000'))
  await openLink(app, link)
  await openLink(app, link) // twice: still one alert
  await expect(prompt(window)).toBeVisible({ timeout: 10_000 })
  await expect(prompt(window)).toContainText('This sign-in link has expired or wasn’t started from this Plexii')
  await expect(prompt(window)).toHaveCount(1)
  await prompt(window).getByRole('button', { name: 'OK' }).click()
  await expect(prompt(window)).toBeHidden({ timeout: 3_000 })
  expect(stub.tokenCalls).toEqual([])
  expect(await sessionToken(window)).toBeNull()
})

test('AC-3 the website\'s cold button with nobody signed in: Plexii begins its own sign-in, and the code for it signs in', async () => {
  launched = await launch()
  const { app, window } = launched
  await waitForReady(window)
  await recordOpenExternal(app)
  await openLink(app, 'haptyx://auth/start')
  await expect.poll(async () => (await opened(app)).length, { timeout: 10_000 }).toBe(1)
  const u = new URL((await opened(app))[0]!)
  expect(u.pathname).toBe('/account/login')
  expect(u.searchParams.get('client_id')).toBe('plexiidesk')
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  const state = u.searchParams.get('state')!
  const challenge = u.searchParams.get('code_challenge')!
  expect(state).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
  // The website (signed in, after the person's Continue click) issues the code for exactly that.
  await openLink(app, await websiteIssuesCode(state, challenge))
  await expect.poll(adoptedFirstSession(window), { timeout: 15_000 }).toBe(true)
  await expect(prompt(window)).toHaveCount(0)
  // Another /start within the half minute opens nothing more.
  await openLink(app, 'haptyx://auth/start')
  await window.waitForTimeout(1000)
  expect(await opened(app)).toHaveLength(1)
})

test('AC-4 /start with someone signed in: nothing opens, and nobody is switched', async () => {
  launched = await launch()
  const { app, window } = launched
  await waitForReady(window)
  // Signed in by a sign-in Plexii started.
  const begin = await beginSignIn(window)
  await openLink(app, await websiteIssuesCode(begin.state, begin.codeChallenge))
  await expect.poll(adoptedFirstSession(window), { timeout: 15_000 }).toBe(true)
  await recordOpenExternal(app)
  await openLink(app, 'haptyx://auth/start')
  await expect(window.getByText(`You’re already signed in to Plexii as ${stub.email}.`)).toBeVisible({ timeout: 10_000 })
  expect(await opened(app)).toEqual([])
  expect(await sessionToken(window)).toBe(stub.sessions[0])
})
