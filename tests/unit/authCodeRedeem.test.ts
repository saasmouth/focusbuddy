// @vitest-environment node
// Turning a one-time sign-in code into a session (step 2, 2026-11-20;
// main/authCodeRedeem.ts). Main alone holds the PKCE verifier, so main redeems.
// The contract is a0's (haptyx-ecosystem signal-desk-auth-codes, pinned there by
// tests/deskHandoffCodeFlow.mjs):
//   POST <signal>/auth/app/token  application/json
//   { grant_type: 'authorization_code', code, code_verifier, redirect_uri: 'haptyx://auth', client_id: 'plexiidesk' }
//   200 { sessionToken, tokenType: 'session', expiresAt, account: { id, email, handle } }
//   400 { error: invalid_grant | invalid_request | invalid_client | unsupported_grant_type, message }
//   429 rate-limited; 5xx.
// A code is spent by its first attempt, right or wrong: redeem exactly once.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
import { AUTH_CLIENT_ID, AUTH_REDIRECT_URI, authApiBase, redeemSignInCode } from '../../src/main/authCodeRedeem'

const VERIFIER = 'v'.repeat(43)
type Call = { url: string; init: RequestInit }
function fakeFetch(respond: (c: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    const c = { url: String(url), init }
    calls.push(c)
    return respond(c)
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('where main redeems', () => {
  it('the API the renderer signs in against, unless a harness or developer names another', () => {
    expect(authApiBase({})).toBe('https://api.plexiidesk.com')
    expect(authApiBase({ FB_SIGNAL_URL: 'http://127.0.0.1:4555/' })).toBe('http://127.0.0.1:4555')
    expect(authApiBase({ SIGNAL_HTTP_URL: 'http://localhost:8787' })).toBe('http://localhost:8787')
  })
})

describe('redeeming a code', () => {
  it('posts the code and the verifier, for this client and return address, and gets a session', async () => {
    const f = fakeFetch(() => json(200, { sessionToken: 'sess-1', tokenType: 'session', expiresAt: 1_900_000_000_000, account: { id: 'a1', email: 'me@example.com', handle: 'me' } }))
    const r = await redeemSignInCode('the-code', VERIFIER, { fetch: f.fetch, base: 'https://api.example.test' })
    expect(r).toEqual({ ok: true, sessionToken: 'sess-1', email: 'me@example.com', handle: 'me' })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe('https://api.example.test/auth/app/token')
    expect(f.calls[0]!.init.method).toBe('POST')
    expect(new Headers(f.calls[0]!.init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: VERIFIER,
      redirect_uri: 'haptyx://auth',
      client_id: 'plexiidesk'
    })
    expect([AUTH_CLIENT_ID, AUTH_REDIRECT_URI]).toEqual(['plexiidesk', 'haptyx://auth'])
  })

  it('the server says no (used, expired, wrong verifier): refused', async () => {
    for (const [status, error] of [[400, 'invalid_grant'], [400, 'invalid_request'], [400, 'invalid_client'], [400, 'unsupported_grant_type'], [401, 'x'], [403, 'x'], [404, 'x']] as const) {
      const f = fakeFetch(() => json(status, { error, message: 'no' }))
      expect(await redeemSignInCode('c', VERIFIER, { fetch: f.fetch, base: 'https://x.test' })).toEqual({ ok: false, why: 'refused' })
    }
  })

  it('exactly one attempt, whatever happens: a code is spent by its first try', async () => {
    for (const respond of [() => json(500, {}), () => json(429, {}), () => json(400, { error: 'invalid_grant' })]) {
      const f = fakeFetch(respond)
      await redeemSignInCode('c', VERIFIER, { fetch: f.fetch, base: 'https://x.test' })
      expect(f.calls).toHaveLength(1)
    }
  })

  it('the server can\'t be reached, fails, or rate-limits: unreachable (try again), never "refused"', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    expect(await redeemSignInCode('c', VERIFIER, { fetch: down.fetch, base: 'https://x.test' })).toEqual({ ok: false, why: 'unreachable' })
    for (const status of [429, 500, 502, 503]) {
      const f = fakeFetch(() => json(status, {}))
      expect(await redeemSignInCode('c', VERIFIER, { fetch: f.fetch, base: 'https://x.test' })).toEqual({ ok: false, why: 'unreachable' })
    }
  })

  it('a 200 without a session in it is not a sign-in', async () => {
    for (const body of [{}, { ok: true }, { sessionToken: '' }, { sessionToken: 42 }, 'nope']) {
      const f = fakeFetch(() => json(200, body))
      expect(await redeemSignInCode('c', VERIFIER, { fetch: f.fetch, base: 'https://x.test' }), JSON.stringify(body)).toEqual({ ok: false, why: 'refused' })
    }
    const notJson = fakeFetch(() => new Response('<html>', { status: 200 }))
    expect(await redeemSignInCode('c', VERIFIER, { fetch: notJson.fetch, base: 'https://x.test' })).toEqual({ ok: false, why: 'refused' })
  })

  it('a slow server is given up on, not waited for forever', async () => {
    const hang = fakeFetch(
      (c) =>
        new Promise<Response>((_, reject) => {
          c.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    expect(await redeemSignInCode('c', VERIFIER, { fetch: hang.fetch, base: 'https://x.test', timeoutMs: 20 })).toEqual({ ok: false, why: 'unreachable' })
  })

  it('never over plain http to anywhere but this machine', async () => {
    const f = fakeFetch(() => json(200, { sessionToken: 's' }))
    expect(await redeemSignInCode('c', VERIFIER, { fetch: f.fetch, base: 'http://api.example.test' })).toEqual({ ok: false, why: 'unreachable' })
    expect(f.calls).toEqual([])
    expect((await redeemSignInCode('c', VERIFIER, { fetch: f.fetch, base: 'http://127.0.0.1:4555' })).ok).toBe(true)
  })
})
