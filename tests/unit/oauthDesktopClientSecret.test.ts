// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The calendar sign-in could never have worked.
//
// Google and Microsoft both issue a "client secret" alongside a DESKTOP app
// client, and both token endpoints require it — PKCE on its own is refused with
// `invalid_client`. Neither the authorisation-code exchange nor the refresh was
// sending one, so connecting a Google calendar would have failed at the first
// click with an error that points at the client id rather than the missing
// field.
//
// The refresh matters at least as much as the exchange. Had only the exchange
// been fixed, the connection would have worked for an hour and then failed for
// good — by which time the calendar is on screen and being trusted, which is a
// far worse failure than one that never connects at all.
//
// This is a source assertion rather than a behavioural test because postForm
// closes over electron's `net` and takes no injectable transport, unlike
// calendar/push.ts. Asserting the field is present in both bodies is what keeps
// it from being "tidied" out of either one.

const src = readFileSync(
  join(__dirname, '..', '..', 'src', 'main', 'calendar', 'oauth.ts'),
  'utf8'
)

const between = (from: string, to: string): string => {
  const a = src.indexOf(from)
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a)
  return src.slice(a, b > -1 ? b : undefined)
}

describe('a desktop client sends its secret to the token endpoint', () => {
  it('on the authorisation-code exchange', () => {
    const exchange = between("grant_type: 'authorization_code'", '}')
    const body = between('const token = await postForm(p.tokenUrl, {', '})')
    expect(exchange.length).toBeGreaterThan(0)
    expect(body).toContain('client_secret: cfg.clientSecret')
  })

  it('on every refresh, so the connection outlives the first hour', () => {
    // Slice to the line AFTER the call, not to the first '})' — the spread
    // itself contains braces.
    const body = between('const refreshed = await postForm(', 'if (!refreshed.ok)')
    expect(body).toContain('client_secret: cfg.clientSecret')
    expect(body).toContain("grant_type: 'refresh_token'")
  })

  it('omits the field entirely when there is no secret, for a true public client', () => {
    // Spread-on-condition, not `client_secret: undefined` — some token
    // endpoints reject the key being present and empty.
    const occurrences = src.match(/\.\.\.\(cfg\.clientSecret \? \{ client_secret: cfg\.clientSecret \} : \{\}\)/g)
    expect(occurrences, 'both call sites must be conditional').toHaveLength(2)
  })

  it('keeps the secret optional in the stored config', () => {
    expect(src).toContain('clientSecret?: string')
  })

  it('persists a secret when one is given, and drops it when cleared', () => {
    const setter = between('export function setProviderConfig', '// ── Token storage')
    expect(setter).toContain('clientSecret')
    // Clearing the provider still deletes the whole entry, secret included.
    expect(setter).toContain('else delete all[provider]')
  })

  it('still asks for the read/write scope, so a push is not a surprise 403', () => {
    expect(src).toContain('https://www.googleapis.com/auth/calendar.events')
    // offline access is what yields a refresh token at all.
    expect(src).toContain("access_type: 'offline'")
  })
})

describe('the secret never travels back to the renderer', () => {
  const ipc = readFileSync(
    join(__dirname, '..', '..', 'src', 'main', 'ipc', 'index.ts'),
    'utf8'
  )
  const handler = ipc.slice(
    ipc.indexOf("ipcMain.handle('extcal:getProviderConfig'"),
    ipc.indexOf("ipcMain.handle('extcal:connect'")
  )

  it('reports only WHETHER one is held', () => {
    expect(handler).toContain('hasSecret: Boolean(getProviderConfig(provider)?.clientSecret)')
    // The value itself is never put on the wire.
    expect(handler).not.toContain('clientSecret: getProviderConfig')
  })

  it('accepts one on the way in', () => {
    expect(handler).toContain('clientSecret?: string')
  })
})
