// @vitest-environment node
// The one-time state a sign-in this app starts carries out and back (security,
// 2026-11-20). A haptyx://auth link is adopted without a question only when it
// brings back a state this app made, unused and unexpired.
import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeSignInNonce,
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
