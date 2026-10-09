import { describe, it, expect } from 'vitest'
import { cleanWebviewUserAgent } from '../../src/main/userAgent'

// A realistic Electron 33 default UA on macOS arm64.
const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) focusbuddy/2.4.3 Chrome/130.0.0.0 Electron/33.2.0 Safari/537.36'

describe('cleanWebviewUserAgent', () => {
  it('removes the Electron token (the primary OAuth-block trigger)', () => {
    const ua = cleanWebviewUserAgent(ELECTRON_UA)
    expect(ua).not.toMatch(/Electron/i)
  })

  it('removes the app-name token, for every name the app has had', () => {
    expect(cleanWebviewUserAgent(ELECTRON_UA)).not.toMatch(/focusbuddy/i)
    // The current name. Electron derives this token from package.json `name`,
    // so each rename adds one more that must still be stripped.
    const plexiiUA = ELECTRON_UA.replace('focusbuddy/2.4.3', 'plexii/4.3.23')
    expect(cleanWebviewUserAgent(plexiiUA)).not.toMatch(/plexii/i)
    const haptyxUA = ELECTRON_UA.replace('focusbuddy/2.4.3', 'Haptyx/2.4.3')
    expect(cleanWebviewUserAgent(haptyxUA)).not.toMatch(/Haptyx/i)
  })

  it('PRESERVES the real Chrome + AppleWebKit + Safari tokens so the UA stays a valid desktop-Chrome string', () => {
    const ua = cleanWebviewUserAgent(ELECTRON_UA)
    expect(ua).toContain('Mozilla/5.0')
    expect(ua).toContain('AppleWebKit/537.36')
    expect(ua).toContain('Chrome/130.0.0.0')
    expect(ua).toContain('Safari/537.36')
    expect(ua).toContain('Macintosh')
  })

  it('leaves no double spaces from the token removals', () => {
    expect(cleanWebviewUserAgent(ELECTRON_UA)).not.toMatch(/ {2,}/)
  })

  it('is idempotent — cleaning an already-clean UA is a no-op', () => {
    const once = cleanWebviewUserAgent(ELECTRON_UA)
    expect(cleanWebviewUserAgent(once)).toBe(once)
  })

  it('the cleaned UA is indistinguishable from desktop Chrome (no embedded-host fingerprint)', () => {
    const ua = cleanWebviewUserAgent(ELECTRON_UA)
    expect(ua).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    )
  })
})
