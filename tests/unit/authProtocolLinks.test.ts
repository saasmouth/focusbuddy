// @vitest-environment node
// What main does with each haptyx://auth link (auth step 2, 2026-11-20;
// main/authProtocol.ts handleAuthLink). Electron and the network are stood in;
// the sign-in states, the PKCE verifier and the parser are real.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => ({
  sent: [] as Array<[string, unknown]>,
  windows: 1,
  fetches: [] as Array<{ url: string; body: Record<string, unknown> }>,
  respond: (() => new Response('{}', { status: 500 })) as (body: Record<string, unknown>) => Response
}))
vi.mock('electron', () => ({
  app: { whenReady: async () => undefined, on: () => undefined },
  BrowserWindow: {
    getAllWindows: () =>
      Array.from({ length: h.windows }, () => ({
        isDestroyed: () => false,
        isMinimized: () => false,
        restore: () => undefined,
        focus: () => undefined,
        webContents: { send: (ch: string, payload: unknown) => h.sent.push([ch, payload]) }
      }))
  },
  net: {
    fetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      h.fetches.push({ url, body })
      return h.respond(body)
    }
  }
}))
vi.mock('../../src/main/deskHandoffReceiver', () => ({ receiveDeskHandoff: () => undefined }))
vi.mock('../../src/main/liteRoomReceiver', () => ({ receiveLiteRoom: () => undefined }))

import { handleAuthLink, takeAuthNotices, consumePendingAuthHandoff, _resetAuthLinksForTests } from '../../src/main/authProtocol'
import { createSignIn, _resetSignInNonces } from '../../src/main/signInNonce'
import { parseAuthLink } from '../../src/shared/authLink'

const S256 = (v: string): string => createHash('sha256').update(v).digest('base64url')
const ok = (session = 'fresh-desktop-session') => (): Response =>
  new Response(JSON.stringify({ sessionToken: session, tokenType: 'session', expiresAt: 9e12, account: { id: 'a1', email: 'me@example.com', handle: 'me' } }), { status: 200 })
const link = (url: string) => parseAuthLink(url)!
const CODE = 'C'.repeat(43)

beforeEach(() => {
  h.sent.length = 0
  h.fetches.length = 0
  h.windows = 1
  h.respond = () => new Response('{}', { status: 500 })
  _resetSignInNonces()
  _resetAuthLinksForTests()
  consumePendingAuthHandoff()
  vi.stubEnv('FB_SIGNAL_URL', 'http://127.0.0.1:4555')
})

describe('a code link', () => {
  it('for a sign-in this app started: main redeems it ONCE with its own verifier, and the window adopts it without a question', async () => {
    const { state, codeChallenge } = createSignIn()
    h.respond = ok()
    await handleAuthLink(link(`haptyx://auth?code=${CODE}&state=${state}`), 'open-url')
    expect(h.fetches).toHaveLength(1)
    expect(h.fetches[0]!.url).toBe('http://127.0.0.1:4555/auth/app/token')
    expect(h.fetches[0]!.body.code).toBe(CODE)
    // The verifier sent is the one whose challenge went out in the URL.
    expect(S256(h.fetches[0]!.body.code_verifier as string)).toBe(codeChallenge)
    expect(h.sent).toEqual([
      ['auth:incoming-token', { sessionToken: 'fresh-desktop-session', email: 'me@example.com', handle: 'me', origin: 'open-url', startedHere: true }]
    ])
    // The same link again: its state is spent, so it is never sent (a second use
    // would end the session it bought); and as its sign-in just worked, nothing is said.
    await handleAuthLink(link(`haptyx://auth?code=${CODE}&state=${state}`), 'open-url')
    expect(h.fetches).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
  })

  it('a second code for a sign-in that just finished (the person pressed Continue twice): nothing sent, nothing said', async () => {
    const { state } = createSignIn()
    h.respond = ok()
    await handleAuthLink(link(`haptyx://auth?code=${CODE}&state=${state}`), 'open-url')
    expect(h.sent).toHaveLength(1)
    await handleAuthLink(link(`haptyx://auth?code=${'D'.repeat(43)}&state=${state}`), 'open-url')
    expect(h.fetches).toHaveLength(1)
    expect(h.sent).toHaveLength(1) // no alert on top of a sign-in that worked
  })

  it('but a state only REFUSED before is not "just finished": its second link is refused out loud', async () => {
    const { state } = createSignIn()
    h.respond = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    await handleAuthLink(link(`haptyx://auth?code=${CODE}&state=${state}`), 'open-url')
    await handleAuthLink(link(`haptyx://auth?code=${'D'.repeat(43)}&state=${state}`), 'open-url')
    expect(h.sent).toEqual([
      ['auth:notice', { kind: 'link-refused', why: 'refused' }],
      ['auth:notice', { kind: 'link-refused', why: 'not-started' }]
    ])
  })

  it('one this app did not start (no state, a made-up one, a malformed code): refused, and never sent to the server', async () => {
    createSignIn()
    for (const url of [`haptyx://auth?code=${CODE}`, `haptyx://auth?code=${CODE}&state=made-up-state-00000000000000`, `haptyx://auth?code=bad%20code&state=${createSignIn().state}`]) {
      await handleAuthLink(link(url), 'open-url')
    }
    expect(h.fetches).toEqual([])
    expect(h.sent.map(([c, p]) => [c, p])).toEqual(Array(3).fill(['auth:notice', { kind: 'link-refused', why: 'not-started' }]))
  })

  it('the server says no, or can\'t be reached: the window is told which, and nothing is adopted', async () => {
    h.respond = () => new Response(JSON.stringify({ error: 'invalid_grant', message: 'used' }), { status: 400 })
    await handleAuthLink(link(`haptyx://auth?code=${CODE}&state=${createSignIn().state}`), 'open-url')
    h.respond = () => new Response('{}', { status: 503 })
    await handleAuthLink(link(`haptyx://auth?code=${CODE}&state=${createSignIn().state}`), 'open-url')
    expect(h.sent).toEqual([
      ['auth:notice', { kind: 'link-refused', why: 'refused' }],
      ['auth:notice', { kind: 'link-refused', why: 'unreachable' }]
    ])
    expect(h.fetches).toHaveLength(2) // one attempt each, never a retry
  })

  it('a link that launched the app: the notice waits for the window', async () => {
    h.windows = 0
    await handleAuthLink(link(`haptyx://auth?code=${CODE}&state=made-up-state-00000000000000`), 'argv')
    expect(h.sent).toEqual([])
    expect(takeAuthNotices()).toEqual([{ kind: 'link-refused', why: 'not-started' }])
    expect(takeAuthNotices()).toEqual([])
  })
})

describe('the other auth links', () => {
  it('Cancel on the website spends the state and says nothing', async () => {
    const { state } = createSignIn()
    await handleAuthLink(link(`haptyx://auth?error=access_denied&state=${state}`), 'open-url')
    expect(h.sent).toEqual([])
    // That sign-in can't be finished by a code afterwards.
    h.respond = ok()
    await handleAuthLink(link(`haptyx://auth?code=${CODE}&state=${state}`), 'open-url')
    expect(h.fetches).toEqual([])
  })

  it('/start asks the window to begin a sign-in, at most once per half minute', async () => {
    await handleAuthLink(link('haptyx://auth/start'), 'open-url', 1_000)
    await handleAuthLink(link('haptyx://auth/start'), 'open-url', 20_000)
    await handleAuthLink(link('haptyx://auth/start'), 'open-url', 31_001)
    expect(h.sent).toEqual([
      ['auth:notice', { kind: 'start' }],
      ['auth:notice', { kind: 'start' }]
    ])
  })

  it('the legacy token link is as 4.3.53 left it: silent only with this app\'s state', async () => {
    const { state } = createSignIn()
    await handleAuthLink(link(`haptyx://auth?token=sess&email=x%40y.z&state=${state}`), 'open-url')
    await handleAuthLink(link('haptyx://auth?token=sess2'), 'open-url')
    expect(h.sent).toEqual([
      ['auth:incoming-token', { sessionToken: 'sess', email: 'x@y.z', handle: null, origin: 'open-url', startedHere: true }],
      ['auth:incoming-token', { sessionToken: 'sess2', email: null, handle: null, origin: 'open-url', startedHere: false }]
    ])
    expect(h.fetches).toEqual([])
  })
})
