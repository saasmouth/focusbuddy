// What sign-in TELLS YOU when it fails.
//
// Root-cause of a failure 9d would not let me leave open: the real app, against
// a real server, showed "Invalid email or password." for credentials that were
// correct — curl with the same email and password succeeded seconds later.
//
// The cause is here, not in the harness. `login` falls back to
// `json?.error || 'Invalid email or password.'` for ANY non-ok response. When
// the body is not JSON there is no `json.error`, so a 502 from a gateway, a
// 500 with an HTML error page, or a captive portal's interception all tell the
// person their password is wrong. It isn't. They change a password that was
// fine, or conclude their account is broken.
//
// In my case the plain-text 502 came from the test TLS proxy while its backend
// was momentarily down — but nothing about that is specific to a test. Any
// edge in front of the real server does the same thing: Cloudflare's 502 page
// is HTML, not `{"error":"..."}`.
//
// So the rule these tests hold: the MESSAGE must match what actually happened.
// Only a 401 may talk about credentials.

import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL
  vi.restoreAllMocks()
})

/** Reply with exactly what a given failure looks like on the wire. */
function respond(status: number, body: string, contentType?: string): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: contentType ? { 'content-type': contentType } : {}
    })) as unknown as typeof fetch
}

async function login(): Promise<{ ok: boolean; error?: string; code?: string }> {
  const { login: doLogin } = await import('../../src/renderer/src/lib/accountClient')
  return (await doLogin({ email: 'ada@example.com', password: 'password12345' })) as never
}

describe('a failed sign-in says what actually went wrong', () => {
  it('a GATEWAY 502 with a plain-text body does not blame the password', async () => {
    // Verbatim what the TLS proxy returned when its backend was unreachable,
    // and the shape of every bad-gateway page in front of a real server.
    respond(502, 'proxy error: connect ECONNREFUSED 127.0.0.1:8799')
    const r = await login()
    expect(r.ok).toBe(false)
    expect(r.code, 'a server failure, not a credential one').toBe('SERVER')
    expect(r.error, 'the person is not told their password is wrong').not.toMatch(/password/i)
    expect(r.error).toMatch(/server/i)
  })

  it('a 500 with an HTML error page does not blame the password', async () => {
    respond(500, '<html><body><h1>502 Bad Gateway</h1></body></html>', 'text/html')
    const r = await login()
    expect(r.code).toBe('SERVER')
    expect(r.error).not.toMatch(/password/i)
  })

  it('a 503 while the server restarts does not blame the password', async () => {
    respond(503, 'Service Unavailable')
    const r = await login()
    expect(r.code).toBe('SERVER')
    expect(r.error).not.toMatch(/password/i)
  })

  it('a rate limit says so, rather than anything about credentials', async () => {
    // fastify-rate-limit's body uses `message`; its `error` is the HTTP reason
    // phrase, so the old fallback would have shown "Too Many Requests".
    respond(429, JSON.stringify({ statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' }), 'application/json')
    const r = await login()
    expect(r.ok).toBe(false)
    expect(r.error, 'the real reason, not the reason phrase').toMatch(/too many|rate limit/i)
    expect(r.error).not.toMatch(/password/i)
  })

  it('a REAL 401 still says the credentials are wrong', async () => {
    // The case the message was written for must keep working, or this fix
    // trades one wrong message for another.
    respond(401, JSON.stringify({ ok: false, error: 'Invalid email or password.' }), 'application/json')
    const r = await login()
    expect(r.code).toBe('INVALID_CREDENTIALS')
    expect(r.error).toMatch(/invalid email or password/i)
  })

  it('a 401 with no body still says the credentials are wrong', async () => {
    respond(401, '')
    const r = await login()
    expect(r.code).toBe('INVALID_CREDENTIALS')
    expect(r.error).toMatch(/invalid email or password/i)
  })

  it('an unreachable server says so, and is not confused with either', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const r = await login()
    expect(r.code).toBe('NETWORK')
    expect(r.error).toMatch(/could not reach the server/i)
  })
})
