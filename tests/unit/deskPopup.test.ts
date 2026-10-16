/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  CARD_CASCADE_PX,
  CARD_HEADER_PX,
  CARD_MARGIN_PX,
  cardLayout,
  envForcesNativePopups,
  fallbackPopupBounds,
  isAllowedPopupNavigation,
  isHandoffEnd,
  popupBoundsFromCssRect,
  popupHostLabel,
  popupTitleLabel,
  shouldUseNativePopups
} from '../../src/shared/deskPopup'

const WIN = { width: 1440, height: 900 }

describe('popupBoundsFromCssRect — renderer slot to native view bounds', () => {
  it('passes a rect through unchanged at zoom 1', () => {
    expect(popupBoundsFromCssRect({ x: 100, y: 80, width: 520, height: 720 }, 1, WIN)).toEqual({
      x: 100,
      y: 80,
      width: 520,
      height: 720
    })
  })

  it('scales by the webContents zoom factor (the app UI scale), not devicePixelRatio', () => {
    // 0.85 is the default scale on a <=1440x900 screen (uiScale.autoDefaultScale).
    expect(popupBoundsFromCssRect({ x: 100, y: 100, width: 600, height: 400 }, 0.85, WIN)).toEqual({
      x: 85,
      y: 85,
      width: 510,
      height: 340
    })
    expect(popupBoundsFromCssRect({ x: 10, y: 20, width: 100, height: 50 }, 1.5, WIN)).toEqual({
      x: 15,
      y: 30,
      width: 150,
      height: 75
    })
  })

  it('rounds edges, not sizes, so fractional rects never gain or lose a pixel against neighbours', () => {
    const b = popupBoundsFromCssRect({ x: 10.4, y: 10.6, width: 100.4, height: 100.4 }, 1, WIN)!
    expect(b.x).toBe(10)
    expect(b.y).toBe(11)
    expect(b.x + b.width).toBe(Math.round(10.4 + 100.4))
    expect(b.y + b.height).toBe(Math.round(10.6 + 100.4))
  })

  it('clamps to the window content area', () => {
    expect(popupBoundsFromCssRect({ x: -50, y: -20, width: 200, height: 200 }, 1, WIN)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 180
    })
    expect(popupBoundsFromCssRect({ x: 1400, y: 800, width: 200, height: 200 }, 1, WIN)).toEqual({
      x: 1400,
      y: 800,
      width: 40,
      height: 100
    })
  })

  it('returns null for a rect that cannot be shown', () => {
    expect(popupBoundsFromCssRect({ x: 2000, y: 0, width: 100, height: 100 }, 1, WIN)).toBeNull()
    expect(popupBoundsFromCssRect({ x: 0, y: 0, width: 0, height: 100 }, 1, WIN)).toBeNull()
    expect(popupBoundsFromCssRect({ x: NaN, y: 0, width: 100, height: 100 }, 1, WIN)).toBeNull()
    expect(
      popupBoundsFromCssRect({ x: 0, y: 0, width: Infinity, height: 100 }, 1, WIN)
    ).toBeNull()
    expect(popupBoundsFromCssRect(null as never, 1, WIN)).toBeNull()
  })

  it('treats a nonsense zoom factor as 1', () => {
    const r = { x: 10, y: 10, width: 100, height: 100 }
    expect(popupBoundsFromCssRect(r, 0, WIN)).toEqual(r)
    expect(popupBoundsFromCssRect(r, NaN, WIN)).toEqual(r)
  })
})

describe('cardLayout — where each stacked card sits', () => {
  const area = { width: 1200, height: 800 }

  it('centres the first card at its preferred size plus the header', () => {
    const l = cardLayout(area, { width: 520, height: 600 }, 0)
    expect(l.width).toBe(520)
    expect(l.height).toBe(600 + CARD_HEADER_PX)
    expect(l.left).toBe((1200 - 520) / 2)
    expect(l.top).toBe(Math.round((800 - 640) / 2))
  })

  it('cascades each later card so the headers beneath stay visible', () => {
    const a = cardLayout(area, { width: 520, height: 600 }, 0)
    const b = cardLayout(area, { width: 520, height: 600 }, 1)
    expect(b.left - a.left).toBe(CARD_CASCADE_PX)
    expect(b.top - a.top).toBe(CARD_CASCADE_PX)
  })

  it('never exceeds the area, even for a roomy 1180x820 pop-up in a small pane', () => {
    for (let i = 0; i < 8; i++) {
      const l = cardLayout({ width: 900, height: 600 }, { width: 1180, height: 820 }, i)
      expect(l.left).toBeGreaterThanOrEqual(0)
      expect(l.top).toBeGreaterThanOrEqual(0)
      expect(l.left + l.width).toBeLessThanOrEqual(900)
      expect(l.top + l.height).toBeLessThanOrEqual(600)
      expect(l.width).toBeLessThanOrEqual(900 - CARD_MARGIN_PX * 2)
    }
  })

  it('falls back to a sign-in sized card when the preferred size is missing', () => {
    const l = cardLayout(area, { width: 0, height: NaN }, 0)
    expect(l.width).toBe(520)
  })
})

describe('fallbackPopupBounds — when the renderer never reports a slot', () => {
  it('centres the preferred size inside the window', () => {
    const b = fallbackPopupBounds(WIN, { width: 520, height: 720 })
    expect(b).toEqual({ x: 460, y: 90, width: 520, height: 720 })
  })
  it('shrinks to fit a small window rather than overflowing it', () => {
    const b = fallbackPopupBounds({ width: 400, height: 500 }, { width: 1180, height: 820 })
    expect(b.width).toBeLessThanOrEqual(400)
    expect(b.height).toBeLessThanOrEqual(500)
    expect(b.x).toBeGreaterThanOrEqual(0)
  })
})

describe('labels', () => {
  it('shows the host without www, and nothing for non-web URLs', () => {
    expect(popupHostLabel('https://accounts.google.com/o/oauth2/auth?x=1')).toBe('accounts.google.com')
    expect(popupHostLabel('https://www.example.com/')).toBe('example.com')
    expect(popupHostLabel('about:blank')).toBe('')
    expect(popupHostLabel('not a url')).toBe('')
  })
  it('prefers the page title, then the host, then a plain label', () => {
    expect(popupTitleLabel('Sign in - Google Accounts', 'https://accounts.google.com/')).toBe(
      'Sign in - Google Accounts'
    )
    expect(popupTitleLabel('', 'https://accounts.google.com/')).toBe('accounts.google.com')
    expect(popupTitleLabel('https://x.test/a', 'https://x.test/a')).toBe('x.test')
    expect(popupTitleLabel(null, 'about:blank')).toBe('Pop-up')
  })
})

describe('isHandoffEnd — a pop-up that blanks itself after an OAuth hand-off', () => {
  it('is the end only after a real page has loaded', () => {
    expect(isHandoffEnd('about:blank', true)).toBe(true)
    expect(isHandoffEnd('about:blank#done', true)).toBe(true)
    expect(isHandoffEnd('about:blank', false)).toBe(false)
  })
  it('is not the end for an ordinary page', () => {
    expect(isHandoffEnd('https://example.com/callback?code=1', true)).toBe(false)
    expect(isHandoffEnd('about:blanket', true)).toBe(false)
  })
})

describe('isAllowedPopupNavigation — the desk pop-up nav-guard', () => {
  it('allows web pages and about:blank', () => {
    expect(isAllowedPopupNavigation('https://login.microsoftonline.com/')).toBe(true)
    expect(isAllowedPopupNavigation('http://127.0.0.1:3000/cb')).toBe(true)
    expect(isAllowedPopupNavigation('about:blank')).toBe(true)
  })
  it('refuses disk, blob and app schemes, as the desk webviews do', () => {
    expect(isAllowedPopupNavigation('file:///etc/passwd')).toBe(false)
    expect(isAllowedPopupNavigation('blob:https://x/1')).toBe(false)
    expect(isAllowedPopupNavigation('javascript:alert(1)')).toBe(false)
    expect(isAllowedPopupNavigation('smb://host/share')).toBe(false)
  })
})

describe('the native-window fallback switch', () => {
  it('reads PLEXI_POPUPS_NATIVE truthily', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) expect(envForcesNativePopups(v)).toBe(true)
    for (const v of [undefined, '', '0', 'false', 'no']) expect(envForcesNativePopups(v)).toBe(false)
  })
  it('is native when either the env flag or the Settings toggle says so', () => {
    expect(shouldUseNativePopups({ env: undefined, pref: false })).toBe(false)
    expect(shouldUseNativePopups({ env: undefined, pref: undefined })).toBe(false)
    expect(shouldUseNativePopups({ env: '1', pref: false })).toBe(true)
    expect(shouldUseNativePopups({ env: undefined, pref: true })).toBe(true)
  })
})

// Wiring pins. The behaviour needs a real Electron to prove (see the e2e
// desk-popups.spec.ts); these stop a refactor quietly unwiring it.
describe('wiring pins', () => {
  const root = resolve(__dirname, '../..')
  const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')

  it('the webview window-open handler routes allowed pop-ups through the desk', () => {
    const src = read('src/main/index.ts')
    expect(src).toMatch(/allowPopupResponse\(contents, details, decision\.overrideBrowserWindowOptions, contents\.id\)/)
  })

  it('desk pop-ups adopt the window.open webContents and keep outlivesOpener', () => {
    const src = read('src/main/deskPopups.ts')
    expect(src).toMatch(/createWindow: \(options\) =>/)
    expect(src).toMatch(/new WebContentsView\(\{ webContents: guest \}\)/)
    expect(src).toMatch(/outlivesOpener: true/)
    // Never silently drop a pop-up: the failure path opens a native window.
    expect(src).toMatch(/new BrowserWindow\(options\)/)
  })

  it('pop-ups get no preload — their prefs come only from the router', () => {
    const router = read('src/main/popupRouter.ts')
    const block = router.slice(router.indexOf('function allowWindow'), router.indexOf('export function decidePopup'))
    expect(block).not.toMatch(/preload/)
    expect(block).toMatch(/sandbox: true/)
    expect(block).toMatch(/contextIsolation: true/)
    expect(block).toMatch(/nodeIntegration: false/)
    expect(read('src/main/deskPopups.ts')).not.toMatch(/preload:/)
  })
})
