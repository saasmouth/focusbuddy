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

import { randomBytes } from 'node:crypto'

/** How long a started sign-in may take to come back: minutes, not hours. */
export const SIGN_IN_NONCE_TTL_MS = 10 * 60_000
/** At most this many outstanding at once; the oldest goes first. */
export const SIGN_IN_NONCE_MAX = 8

// nonce -> expiry (ms). A Map keeps insertion order, oldest first.
const outstanding = new Map<string, number>()

function prune(now: number): void {
  for (const [n, exp] of outstanding) if (exp <= now) outstanding.delete(n)
}

/** A new state for a sign-in this app is starting. */
export function createSignInNonce(now: number = Date.now()): string {
  prune(now)
  while (outstanding.size >= SIGN_IN_NONCE_MAX) {
    const oldest = outstanding.keys().next().value as string
    outstanding.delete(oldest)
  }
  const nonce = randomBytes(24).toString('base64url')
  outstanding.set(nonce, now + SIGN_IN_NONCE_TTL_MS)
  return nonce
}

/** True once for a state this app made that has not expired; it is used up either way. */
export function consumeSignInNonce(state: string | null | undefined, now: number = Date.now()): boolean {
  if (!state) return false
  const exp = outstanding.get(state)
  if (exp === undefined) return false
  outstanding.delete(state)
  return exp > now
}

/** Tests only. */
export function _resetSignInNonces(): void {
  outstanding.clear()
}
