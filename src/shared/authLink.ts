// What a haptyx://auth (or plexii://auth) link is (auth step 2, 2026-11-20;
// plexii-work/auth-step2-design.md). Four shapes reach Plexii:
//
//   haptyx://auth?code=<code>&state=<state>   a one-time code for a sign-in THIS
//                                              app started (PKCE). Main redeems it
//                                              with the verifier it kept.
//   haptyx://auth?error=<e>&state=<state>     the person pressed Cancel on the
//                                              website: nothing to sign in.
//   haptyx://auth/start                        "begin a sign-in" (the website's
//                                              cold button). Carries nothing.
//   haptyx://auth?token=<session>&…[&state=]   the legacy link with a session in
//                                              it, kept until older builds are rare
//                                              (4.3.53's guard asks about it).
//
// /start wins over everything (anything it carries is ignored); then an error
// (it never carries a sign-in in with it); then a code (a code link never falls
// back to a token in the same link); then a token.
import { isKnownDeepLinkProtocol } from './deepLink'

export type AuthLink =
  | { kind: 'code'; code: string | null; state: string | null }
  | { kind: 'error'; error: string; state: string | null }
  | { kind: 'start' }
  | { kind: 'token'; sessionToken: string; email: string | null; handle: string | null; state: string | null }

/**
 * What main tells the window about an auth link that is not a sign-in to adopt:
 * a link it refused (`not-started`: no verifier for its state, so never sent to
 * the server; `refused`: the server said no; `unreachable`: the server couldn't
 * be reached or failed), or a /start to begin a sign-in.
 */
export type AuthNotice = { kind: 'link-refused'; why: 'not-started' | 'refused' | 'unreachable' } | { kind: 'start' }

/** An app state, as signal accepts one (signal-sso-state): 16 to 128 URL-safe characters. */
export const AUTH_STATE = /^[A-Za-z0-9_-]{16,128}$/
/** A one-time code: URL-safe, bounded (signal's are 43 characters). */
const AUTH_CODE = /^[A-Za-z0-9_-]{16,512}$/
const AUTH_ERROR = /^[a-z_]{1,64}$/

export function parseAuthLink(url: string): AuthLink | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!isKnownDeepLinkProtocol(u.protocol) || u.host !== 'auth') return null
  const path = u.pathname.replace(/\/+$/, '')
  if (path === '/start') return { kind: 'start' }
  if (path !== '') return null
  const q = u.searchParams
  const stateRaw = q.get('state')
  const state = stateRaw && AUTH_STATE.test(stateRaw) ? stateRaw : null
  const error = q.get('error')
  if (error !== null) return { kind: 'error', error: AUTH_ERROR.test(error) ? error : 'unknown', state }
  const code = q.get('code')
  if (code !== null) return { kind: 'code', code: AUTH_CODE.test(code) ? code : null, state }
  const token = q.get('token')
  if (!token) return null
  return { kind: 'token', sessionToken: token, email: q.get('email'), handle: q.get('handle'), state: stateRaw }
}
