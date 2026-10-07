// The compatibility half of the rename, which nothing else asserts.
//
// Generating plexii:// is easy to verify and easy to keep right. The half that
// silently rots is ACCEPTING haptyx://: drop it and every deep link already
// sent — an auth handoff in an inbox, a meeting invite from an older build —
// stops opening the app, with no error anywhere to notice.
import { describe, expect, it } from 'vitest'
import {
  ALL_DEEP_LINK_SCHEMES,
  DEEP_LINK_SCHEME,
  isDeepLinkArg,
  isKnownDeepLinkProtocol,
  LEGACY_DEEP_LINK_SCHEMES,
  meetingDeepLink
} from '../../src/shared/deepLink'

describe('deep link schemes', () => {
  it('generates only the current scheme', () => {
    expect(DEEP_LINK_SCHEME).toBe('plexii')
    expect(meetingDeepLink('room-1')).toBe('plexii://meet?room=room-1')
    expect(meetingDeepLink('room-1')).not.toContain('haptyx')
  })

  it('still accepts the pre-rename scheme', () => {
    expect(LEGACY_DEEP_LINK_SCHEMES).toContain('haptyx')
    expect(isKnownDeepLinkProtocol('haptyx:')).toBe(true)
    expect(isDeepLinkArg('haptyx://auth?token=abc')).toBe(true)
  })

  it('accepts the current scheme', () => {
    expect(isKnownDeepLinkProtocol('plexii:')).toBe(true)
    expect(isDeepLinkArg('plexii://meet?room=r1')).toBe(true)
  })

  it('accepts nothing else', () => {
    for (const p of ['http:', 'https:', 'file:', 'javascript:', 'plexi:', 'plexiidesk:']) {
      expect(isKnownDeepLinkProtocol(p), p).toBe(false)
    }
    expect(isDeepLinkArg('https://plexiidesk.com')).toBe(false)
    // A scheme that merely starts with ours is not ours.
    expect(isDeepLinkArg('plexiible://meet')).toBe(false)
  })

  it('encodes the room id, so a crafted id cannot add parameters', () => {
    expect(meetingDeepLink('a&b=c')).toBe('plexii://meet?room=a%26b%3Dc')
  })

  it('every accepted scheme is listed exactly once', () => {
    expect(new Set(ALL_DEEP_LINK_SCHEMES).size).toBe(ALL_DEEP_LINK_SCHEMES.length)
    expect(ALL_DEEP_LINK_SCHEMES[0]).toBe(DEEP_LINK_SCHEME)
  })
})
