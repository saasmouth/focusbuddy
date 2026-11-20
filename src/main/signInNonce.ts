// The one-time state a sign-in THIS app starts carries out and brings back
// (security, 2026-11-20).
//
// A haptyx://auth?token= link signs Plexii in. Any web page can open such a
// link, and adopting one with no question signs this app into whoever made it
// (session fixation). So when the app itself starts a sign-in (the website's
// account page, SSO), it adds `state=<nonce>` to the URL it opens. A link that
// comes back with a state from here, unused and unexpired, is the app's own
// sign-in finishing and is adopted without a question; anything else is asked
// about (renderer, App.tsx). The nonces live in this process's memory only, so
// a restart or another machine's link can never match.
//
// Step 2 (2026-11-20; plexii-work/auth-step2-design.md): each started sign-in
// also keeps a PKCE verifier (RFC 7636, S256). The URL carries only its
// challenge. The link back then brings a one-time code instead of a session
// token, and main alone, holding the verifier, redeems it (authCodeRedeem.ts).
// The verifier never leaves this process: not to the renderer, not into a URL.

import { createHash, randomBytes } from 'node:crypto'

/** How long a started sign-in may take to come back: minutes, not hours. */
export const SIGN_IN_NONCE_TTL_MS = 10 * 60_000
/** At most this many outstanding at once; the oldest goes first. */
export const SIGN_IN_NONCE_MAX = 8

// state -> { expiry (ms), verifier }. A Map keeps insertion order, oldest first.
const outstanding = new Map<string, { exp: number; verifier: string }>()

function prune(now: number): void {
  for (const [n, o] of outstanding) if (o.exp <= now) outstanding.delete(n)
}

/** S256: the challenge a PKCE verifier is checked against (RFC 7636 4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * A sign-in this app is starting: its one-time state, and the PKCE challenge
 * for the URL. The verifier stays here.
 */
export function createSignIn(now: number = Date.now()): { state: string; codeChallenge: string } {
  prune(now)
  while (outstanding.size >= SIGN_IN_NONCE_MAX) {
    const oldest = outstanding.keys().next().value as string
    outstanding.delete(oldest)
  }
  const state = randomBytes(24).toString('base64url')
  // 32 random bytes: a 43-character verifier, the shortest RFC 7636 allows and 256 bits.
  const verifier = randomBytes(32).toString('base64url')
  outstanding.set(state, { exp: now + SIGN_IN_NONCE_TTL_MS, verifier })
  return { state, codeChallenge: pkceChallenge(verifier) }
}

/** The sign-in a state names, once, if this app started it and it has not expired; used up either way. */
export function consumeSignIn(state: string | null | undefined, now: number = Date.now()): { verifier: string } | null {
  if (!state) return null
  const o = outstanding.get(state)
  if (o === undefined) return null
  outstanding.delete(state)
  return o.exp > now ? { verifier: o.verifier } : null
}

/** A new state for a sign-in this app is starting (the legacy token link uses only the state). */
export function createSignInNonce(now: number = Date.now()): string {
  return createSignIn(now).state
}

/** True once for a state this app made that has not expired; it is used up either way. */
export function consumeSignInNonce(state: string | null | undefined, now: number = Date.now()): boolean {
  return consumeSignIn(state, now) !== null
}

/** Tests only. */
export function _resetSignInNonces(): void {
  outstanding.clear()
}
