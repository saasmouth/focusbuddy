// @vitest-environment node
// The one-time state a sign-in this app starts carries out and back (security,
// 2026-11-20). A haptyx://auth link is adopted without a question only when it
// brings back a state this app made, unused and unexpired.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  consumeSignIn,
  consumeSignInNonce,
  createSignIn,
  createSignInNonce,
  SIGN_IN_NONCE_MAX,
  SIGN_IN_NONCE_TTL_MS,
  _resetSignInNonces
} from '../../src/main/signInNonce'

afterEach(() => _resetSignInNonces())

describe('the sign-in state', () => {
  it('is long, URL-safe and new each time', () => {
    const a = createSignInNonce(), b = createSignInNonce()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(a).not.toBe(b)
  })

  it('a state this app made is accepted once', () => {
    const s = createSignInNonce(1_000)
    expect(consumeSignInNonce(s, 2_000)).toBe(true)
    expect(consumeSignInNonce(s, 2_001)).toBe(false)
  })

  it('expires: minutes, not hours', () => {
    expect(SIGN_IN_NONCE_TTL_MS).toBeLessThanOrEqual(15 * 60_000)
    const s = createSignInNonce(0)
    expect(consumeSignInNonce(s, SIGN_IN_NONCE_TTL_MS + 1)).toBe(false)
  })

  it('no state, an empty one or one it did not make is refused', () => {
    createSignInNonce(0)
    for (const s of [null, undefined, '', 'made-up-state-0000000000000000000000']) expect(consumeSignInNonce(s, 1)).toBe(false)
  })

  it('keeps only a few outstanding: the oldest goes first', () => {
    const first = createSignInNonce(0)
    for (let i = 1; i <= SIGN_IN_NONCE_MAX; i++) createSignInNonce(i)
    expect(consumeSignInNonce(first, SIGN_IN_NONCE_MAX + 1)).toBe(false)
  })
})

// Step 2 (2026-11-20): a sign-in the app starts also carries a PKCE challenge.
// The link back brings a one-time CODE, and only this process, holding the
// verifier, can turn it into a session (main/authCodeRedeem.ts).
describe('the PKCE verifier a started sign-in keeps', () => {
  const S256 = (v: string): string => createHash('sha256').update(v).digest('base64url')

  it('the challenge is the S256 of a verifier that never leaves main', () => {
    const { state, codeChallenge } = createSignIn(1_000)
    // Signal's rule for an app state (a0, signal-sso-state 84a7c7ef).
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const got = consumeSignIn(state, 2_000)
    expect(got).not.toBeNull()
    // RFC 7636: 43 to 128 characters of the unreserved set.
    expect(got!.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(S256(got!.verifier)).toBe(codeChallenge)
  })

  it('each sign-in has its own verifier', () => {
    const a = createSignIn(0), b = createSignIn(0)
    expect(a.codeChallenge).not.toBe(b.codeChallenge)
    expect(consumeSignIn(a.state, 1)!.verifier).not.toBe(consumeSignIn(b.state, 1)!.verifier)
  })

  it('handed out once, and not after it expires', () => {
    const { state } = createSignIn(0)
    expect(consumeSignIn(state, 1)).not.toBeNull()
    expect(consumeSignIn(state, 2)).toBeNull()
    const late = createSignIn(0)
    expect(consumeSignIn(late.state, SIGN_IN_NONCE_TTL_MS + 1)).toBeNull()
    expect(consumeSignIn('made-up-state-0000000000000000000000', 1)).toBeNull()
    expect(consumeSignIn(null, 1)).toBeNull()
  })

  it('the legacy token link uses the same states: one used by either is gone for both', () => {
    const a = createSignIn(0)
    expect(consumeSignInNonce(a.state, 1)).toBe(true)
    expect(consumeSignIn(a.state, 2)).toBeNull()
    const b = createSignIn(0)
    expect(consumeSignIn(b.state, 1)).not.toBeNull()
    expect(consumeSignInNonce(b.state, 2)).toBe(false)
  })
})

