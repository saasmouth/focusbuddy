// @vitest-environment node
// Web notifications are the person's choice, per site (main/webNotifications).
//
// Measured 2026-11-05: every page in the desk browser had notifications
// GRANTED on first visit (Electron auto-grants; the policy only denied device
// and location permissions), so any site could put macOS notifications on the
// screen without asking. Real Chrome says "default" and asks.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'webnotif-'))
const sessions = new Map<string, object>()
const defaultSession = { name: 'default' }
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  session: {
    get defaultSession() {
      return defaultSession
    },
    fromPartition: (p: string) => {
      if (!sessions.has(p)) sessions.set(p, { name: p })
      return sessions.get(p)
    }
  }
}))

import {
  noteWebviewPartition,
  notificationsAllowed,
  resetWebNotificationsForTests,
  setSiteNotifications,
  siteNotificationsAllowed
} from '../../src/main/webNotifications'

const web = (): Electron.Session => sessions.get('persist:webview-default') as Electron.Session
const appSes = (): Electron.Session => sessions.get('persist:connectedapp-slack') as Electron.Session

beforeEach(() => {
  rmSync(join(dir, 'web-notification-sites.json'), { force: true })
  resetWebNotificationsForTests()
  noteWebviewPartition('persist:webview-default')
  noteWebviewPartition('persist:connectedapp-slack')
})
afterEach(() => resetWebNotificationsForTests())

describe('desk-browser pages: blocked until the person allows the site', () => {
  it('a page has no notifications by default', () => {
    expect(notificationsAllowed(web(), 'https://finviz.com')).toBe(false)
    expect(notificationsAllowed(web(), 'https://www.tradingview.com/chart/')).toBe(false)
  })

  it('allowing a site allows that origin only, and it is remembered', () => {
    expect(setSiteNotifications('https://www.tradingview.com/chart/?symbol=AAPL', true)).toBe(true)
    expect(notificationsAllowed(web(), 'https://www.tradingview.com')).toBe(true)
    expect(notificationsAllowed(web(), 'https://www.tradingview.com/some/other/page')).toBe(true)
    // Another origin, or the same host on another scheme, is not.
    expect(notificationsAllowed(web(), 'https://tradingview.com')).toBe(false)
    expect(notificationsAllowed(web(), 'http://www.tradingview.com')).toBe(false)
    // Survives a restart (the file, not the cache).
    resetWebNotificationsForTests()
    expect(siteNotificationsAllowed('https://www.tradingview.com/x')).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'web-notification-sites.json'), 'utf8'))).toEqual({ allowed: ['https://www.tradingview.com'] })
  })

  it('turning it off blocks it again', () => {
    setSiteNotifications('https://finviz.com/news.php', true)
    expect(setSiteNotifications('https://finviz.com/', false)).toBe(false)
    expect(notificationsAllowed(web(), 'https://finviz.com')).toBe(false)
  })

  it('nothing that is not a web origin can be allowed', () => {
    expect(setSiteNotifications('file:///etc/passwd', true)).toBe(false)
    expect(setSiteNotifications('not a url', true)).toBe(false)
    expect(notificationsAllowed(web(), '')).toBe(false)
  })
})

describe('connected apps and the app itself keep their notifications', () => {
  it('a connected app (added on purpose) is allowed without a choice', () => {
    expect(notificationsAllowed(appSes(), 'https://app.slack.com')).toBe(true)
  })

  it("the app's own windows (a session no webview attached to) are allowed", () => {
    expect(notificationsAllowed(defaultSession as unknown as Electron.Session, 'file:///index.html')).toBe(true)
  })
})
