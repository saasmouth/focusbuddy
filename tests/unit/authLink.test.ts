// What a haptyx://auth link is (step 2, 2026-11-20; shared/authLink.ts). Three
// shapes reach Plexii, under either scheme:
//   ?token=…&state=…   the legacy link with a session in it (4.3.53's guard)
//   ?code=…&state=…    a one-time code for a sign-in Plexii started (PKCE)
//   /start             "begin a sign-in", from the website's cold button
import { describe, expect, it } from 'vitest'
import { parseAuthLink } from '../../src/shared/authLink'

const STATE = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const CODE = 'c0de_c0de-c0de_c0de-c0de_c0de-c0de_12'

describe('a haptyx://auth link', () => {
  it('a code link: the code and the state, nothing else', () => {
    expect(parseAuthLink(`haptyx://auth?code=${CODE}&state=${STATE}`)).toEqual({ kind: 'code', code: CODE, state: STATE })
    expect(parseAuthLink(`plexii://auth?code=${CODE}&state=${STATE}`)).toEqual({ kind: 'code', code: CODE, state: STATE })
  })

  it('a code link wins over a token in the same link: a code never falls back to a token', () => {
    expect(parseAuthLink(`haptyx://auth?code=${CODE}&state=${STATE}&token=sess`)).toEqual({ kind: 'code', code: CODE, state: STATE })
  })

  it('a code link with no state, or a malformed code or state, is a code link Plexii did not start (state null)', () => {
    expect(parseAuthLink(`haptyx://auth?code=${CODE}`)).toEqual({ kind: 'code', code: CODE, state: null })
    expect(parseAuthLink(`haptyx://auth?code=${CODE}&state=short`)).toEqual({ kind: 'code', code: CODE, state: null })
    expect(parseAuthLink(`haptyx://auth?code=${CODE}&state=${'x'.repeat(129)}`)).toEqual({ kind: 'code', code: CODE, state: null })
    expect(parseAuthLink(`haptyx://auth?code=has%20space&state=${STATE}`)).toEqual({ kind: 'code', code: null, state: STATE })
    expect(parseAuthLink(`haptyx://auth?code=${'c'.repeat(513)}&state=${STATE}`)).toEqual({ kind: 'code', code: null, state: STATE })
  })

  it('/start: begin a sign-in. It carries nothing, and anything it carries is ignored', () => {
    expect(parseAuthLink('haptyx://auth/start')).toEqual({ kind: 'start' })
    expect(parseAuthLink('plexii://auth/start')).toEqual({ kind: 'start' })
    expect(parseAuthLink('haptyx://auth/start?token=sess&code=x')).toEqual({ kind: 'start' })
  })

  it('the legacy token link, as 4.3.53 reads it', () => {
    expect(parseAuthLink(`haptyx://auth?token=sess&email=a%40b.c&handle=ab&state=${STATE}`)).toEqual({
      kind: 'token',
      sessionToken: 'sess',
      email: 'a@b.c',
      handle: 'ab',
      state: STATE
    })
    expect(parseAuthLink('haptyx://auth?token=sess')).toEqual({ kind: 'token', sessionToken: 'sess', email: null, handle: null, state: null })
  })

  it('the website\'s Cancel: an error and the state, nothing else', () => {
    expect(parseAuthLink(`haptyx://auth?error=access_denied&state=${STATE}`)).toEqual({ kind: 'error', error: 'access_denied', state: STATE })
    expect(parseAuthLink('haptyx://auth?error=access_denied')).toEqual({ kind: 'error', error: 'access_denied', state: null })
    // An error never carries a sign-in in with it.
    expect(parseAuthLink(`haptyx://auth?error=access_denied&state=${STATE}&token=sess`)).toEqual({ kind: 'error', error: 'access_denied', state: STATE })
    expect(parseAuthLink(`haptyx://auth?error=${'e'.repeat(65)}&state=${STATE}`)).toEqual({ kind: 'error', error: 'unknown', state: STATE })
  })

  it('anything else is not an auth link', () => {
    for (const u of ['haptyx://share?token=x', 'https://auth?token=x', 'haptyx://auth', 'haptyx://auth/other?token=x', 'not a url', 'haptyx://auth?email=a']) {
      expect(parseAuthLink(u), u).toBeNull()
    }
  })
})
