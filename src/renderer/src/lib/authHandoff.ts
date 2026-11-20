// What to do with a haptyx://auth?token= link (security, 2026-11-20).
//
// The website and SSO hand a session token back in that link, and any page can
// open one. Adopted without a question, a link from someone else signs this
// app into the sender's account (session fixation). So:
//   - a sign-in THIS app started is adopted without a question. Main decides
//     that (startedHere: the link brought back the one-time state the app added
//     to the URL it opened, src/main/signInNonce.ts), never the link itself;
//   - every other link, a cold launch included, is asked about, naming the
//     account the SERVER says the token belongs to (the link's own email can
//     say anything), with Cancel as the default.
import { getMe, type MeResult } from './accountClient'
import { alertDialog, confirmDialog } from '../components/plexi/PromptDialog'
import type { AuthNotice } from '@shared/authLink'

export interface IncomingAuthHandoff {
  sessionToken: string
  /** What the link claims. Never shown, never trusted. */
  email: string | null
  startedHere: boolean
}

export type AdoptFn = (input: { sessionToken: string; email: string | null }) => Promise<unknown>

export interface HandoffDeps {
  getMe: (token: string) => Promise<MeResult>
  confirm: typeof confirmDialog
  alert: typeof alertDialog
}

const DEFAULT_DEPS: HandoffDeps = { getMe, confirm: confirmDialog, alert: alertDialog }

export async function receiveAuthHandoff(
  handoff: IncomingAuthHandoff,
  adopt: AdoptFn,
  deps: HandoffDeps = DEFAULT_DEPS
): Promise<'adopted' | 'declined' | 'invalid' | 'unreachable'> {
  if (handoff.startedHere === true) {
    await adopt({ sessionToken: handoff.sessionToken, email: handoff.email })
    return 'adopted'
  }
  const me = await deps.getMe(handoff.sessionToken)
  if (me.status === 'unauthenticated') {
    await deps.alert({ title: 'This sign-in link has expired', body: 'Sign in again from Plexii or plexiidesk.com.' })
    return 'invalid'
  }
  if (me.status !== 'ok') {
    await deps.alert({ title: 'Could not check this sign-in link', body: 'Check your connection, then open the link again.' })
    return 'unreachable'
  }
  const ok = await deps.confirm({
    title: `Sign in to Plexii as ${me.account.email}?`,
    body: 'A sign-in link opened Plexii. Only sign in if you just signed in to this account yourself.',
    confirmLabel: 'Sign in',
    cancelIsDefault: true
  })
  if (!ok) return 'declined'
  await adopt({ sessionToken: handoff.sessionToken, email: me.account.email })
  return 'adopted'
}

// ── Auth step 2 (2026-11-20; plexii-work/auth-step2-design.md) ─────────────
// A sign-in this app starts now carries a PKCE challenge too. The website or SSO
// then sends back a one-time code, which main redeems with the verifier it kept
// (main/authCodeRedeem.ts); the renderer only ever sees the session that buys.

/** This app, as signal knows it: the client a website-issued code is for. */
export const AUTH_CLIENT_ID = 'plexiidesk'

/**
 * A sign-in URL with what the link back must match: the one-time state, the
 * PKCE challenge (S256) and, for the website, this client. The verifier is
 * never in it: main keeps that.
 */
export function signInUrl(url: string, kind: 'website' | 'sso', begin: { state: string; codeChallenge: string }): string {
  const u = new URL(url)
  u.searchParams.set('state', begin.state)
  u.searchParams.set('code_challenge', begin.codeChallenge)
  u.searchParams.set('code_challenge_method', 'S256')
  if (kind === 'website') u.searchParams.set('client_id', AUTH_CLIENT_ID)
  return u.toString()
}

/**
 * A sign-in URL this app is about to open, begun in main (signInUrl). Unchanged
 * where the runtime has no deep links (the web build): every link is then simply
 * asked about.
 */
export async function withSignInState(url: string, kind: 'website' | 'sso' = 'website'): Promise<string> {
  try {
    const begin = await window.api.auth.beginSignIn()
    if (!begin || typeof begin !== 'object' || !begin.state || !begin.codeChallenge) return url
    return signInUrl(url, kind, begin)
  } catch {
    return url
  }
}

export interface NoticeDeps {
  alert: typeof alertDialog
  /** A quiet, passing line (the notice toast). */
  notify: (text: string) => void
  /** The signed-in account's email, or null when nobody is signed in. */
  signedInAs: () => string | null
  /** Begin a sign-in in the browser: the website's sign-in page, with this app's state and challenge. */
  beginBrowserSignIn: () => Promise<void>
}

const REFUSED: Record<'not-started' | 'refused' | 'unreachable', { title: string; body: string }> = {
  'not-started': { title: 'This sign-in link has expired or wasn’t started from this Plexii', body: 'Sign in again from Plexii.' },
  refused: { title: 'This sign-in link has expired', body: 'Sign in again from Plexii.' },
  unreachable: { title: 'Plexii couldn’t finish signing in', body: 'It couldn’t reach the server. Check your connection, then sign in again from Plexii.' }
}

// Any page can open sign-in links: one alert at a time, never a stack of them.
let alerting = false

/** What main says about an auth link that was not a sign-in to adopt. */
export async function receiveAuthNotice(notice: AuthNotice, deps: NoticeDeps): Promise<void> {
  if (notice.kind === 'start') {
    // /start never switches accounts: with someone signed in, it only says who.
    const who = deps.signedInAs()
    if (who) {
      deps.notify(`You’re already signed in to Plexii as ${who}.`)
      return
    }
    await deps.beginBrowserSignIn()
    return
  }
  if (alerting) return
  alerting = true
  try {
    await deps.alert(REFUSED[notice.why] ?? REFUSED.refused)
  } finally {
    alerting = false
  }
}
