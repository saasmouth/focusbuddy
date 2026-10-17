// The signed-out detector for connected apps. Pure, so the unit suite drives it
// directly; the renderer feeds it observations from the full-pane view, desk
// widgets and the background unread probe.
//
// "SIGNED OUT" IS A TRANSITION, NOT A PAGE. An app showing its sign-in page the
// first time you open it is not signed out — it was never signed in, and
// badging it would be noise. Signed out means: we saw this app signed in (a
// settled, non-sign-in page in its own jar), and now it shows a sign-in wall.
// That is the event worth telling someone about, because it is the one that
// silently stops their unread counts. It clears the moment the app is back on a
// non-sign-in page.

import { isSignInPage, type SignInObservation } from './authUrl'

export interface AppSignInState {
  /** We have seen this app signed in at least once (persisted). */
  everSignedIn: boolean
  /** It was signed in, and now shows a sign-in page. */
  signedOut: boolean
  /** When signedOut became true (ms), for the tooltip. */
  since?: number
}

export const INITIAL_SIGN_IN_STATE: AppSignInState = { everSignedIn: false, signedOut: false }

export type SignInTransition = 'signed-out' | 'signed-in' | null

/** Which universal signal made the call — logged, never the page itself. */
export function signInSignal(obs: SignInObservation): string {
  if (obs.hasPasswordField) return 'password-field'
  if (!isSignInPage({ url: obs.url, title: obs.title })) return 'none'
  if (!isSignInPage({ url: obs.url })) return 'title'
  return 'url'
}

/**
 * Fold one observation into an app's sign-in state.
 *
 * Only http(s) pages count: about:blank, an error page, or a page that failed
 * to load says nothing about whether you are signed in.
 */
export function nextSignInState(
  prev: AppSignInState | undefined,
  obs: SignInObservation,
  now: number
): { state: AppSignInState; transition: SignInTransition } {
  const cur = prev ?? INITIAL_SIGN_IN_STATE
  if (!obs.url || !/^https?:\/\//i.test(obs.url)) return { state: cur, transition: null }
  if (isSignInPage(obs)) {
    if (!cur.everSignedIn || cur.signedOut) return { state: cur, transition: null }
    return { state: { everSignedIn: true, signedOut: true, since: now }, transition: 'signed-out' }
  }
  if (cur.everSignedIn && !cur.signedOut) return { state: cur, transition: null }
  return {
    state: { everSignedIn: true, signedOut: false },
    transition: cur.signedOut ? 'signed-in' : null
  }
}
