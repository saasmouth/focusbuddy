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

/**
 * A sign-in URL this app is about to open, with the one-time state the link
 * back must carry (main mints it). Unchanged where the runtime has no deep
 * links (the web build): every link is then simply asked about.
 */
export async function withSignInState(url: string): Promise<string> {
  try {
    const state = await window.api.auth.beginSignIn()
    if (!state) return url
    const u = new URL(url)
    u.searchParams.set('state', state)
    return u.toString()
  } catch {
    return url
  }
}
