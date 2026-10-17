import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isAuthUrl, isSignInPage, urlForLog } from '../../src/shared/authUrl'
import { INITIAL_SIGN_IN_STATE, nextSignInState, signInSignal } from '../../src/shared/signInState'
import { useAppNotifications } from '../../src/renderer/src/stores/appNotifications'

// Signed-out detection for connected apps. "Signed out" is a TRANSITION — the
// app was seen signed in and now shows a sign-in wall — because that is the
// event that silently stops its unread counts in the side menu.

describe('what counts as a sign-in page', () => {
  it('a visible password field, whatever the URL', () => {
    expect(isSignInPage({ url: 'https://app.example.com/inbox', hasPasswordField: true })).toBe(true)
  })

  it('identity-provider hosts', () => {
    expect(isSignInPage({ url: 'https://accounts.google.com/v3/signin/identifier?continue=x' })).toBe(true)
    expect(isSignInPage({ url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' })).toBe(true)
    expect(isSignInPage({ url: 'https://acme.okta.com/app/x' })).toBe(true)
  })

  it('login-shaped paths, including hash routes', () => {
    for (const u of [
      'https://app.example.com/login',
      'https://app.example.com/signin?next=/inbox',
      'https://app.example.com/sign-in',
      'https://example.com/users/sign_in',
      'https://example.com/session/new',
      'https://example.com/u/login',
      'https://example.com/auth/',
      'https://example.com/#/login'
    ]) {
      expect(isSignInPage({ url: u }), u).toBe(true)
    }
  })

  it('login titles', () => {
    expect(isSignInPage({ url: 'https://app.example.com/', title: 'Sign in - Example Accounts' })).toBe(true)
    expect(isSignInPage({ url: 'https://app.example.com/', title: 'Example | Log in' })).toBe(true)
    expect(isSignInPage({ url: 'https://app.example.com/', title: 'Login to Example' })).toBe(true)
  })

  it('not an ordinary app page — including SaaS hosts that also host sign-in', () => {
    for (const [url, title] of [
      ['https://mail.example.com/u/0/#inbox', '(3) Inbox'],
      ['https://app.slack.com/client/T123/C456', 'general (Channel) - Acme - Slack'],
      ['https://github.com/notifications', 'Notifications'],
      ['https://example.com/authors/jane', 'Jane'],
      ['https://example.com/settings/sessions', 'Your sessions'],
      ['https://example.com/connect/apps', 'Connected apps'],
      ['https://example.com/admin', 'Login settings — Admin'],
      ['https://example.com/login-help', 'Help']
    ]) {
      expect(isSignInPage({ url, title }), url).toBe(false)
    }
  })

  it('non-web pages are never a sign-in wall', () => {
    expect(isSignInPage({ url: 'about:blank' })).toBe(false)
    expect(isSignInPage({ url: '' })).toBe(false)
  })

  it('the pop-up router still treats SaaS hosts as sign-in capable (its question errs towards yes)', () => {
    expect(isAuthUrl('https://slack.com/oauth/v2/authorize')).toBe(true)
    expect(isAuthUrl('https://github.com/notifications')).toBe(true)
    expect(isAuthUrl('https://unknown.example/x?response_type=code&client_id=a')).toBe(true)
    expect(isAuthUrl('https://example.com/docs')).toBe(false)
  })
})

describe('the transition', () => {
  const NOW = 1_000
  const app = { url: 'https://app.example.com/inbox', title: '(2) Inbox' }
  const wall = { url: 'https://app.example.com/login?next=%2Finbox', title: 'Log in' }

  it('a sign-in page before we ever saw the app signed in is NOT signed out', () => {
    const r = nextSignInState(undefined, wall, NOW)
    expect(r.state).toEqual(INITIAL_SIGN_IN_STATE)
    expect(r.transition).toBeNull()
  })

  it('a normal page marks it signed in, silently', () => {
    const r = nextSignInState(undefined, app, NOW)
    expect(r.state).toEqual({ everSignedIn: true, signedOut: false })
    expect(r.transition).toBeNull()
  })

  it('signed in, then a sign-in page: signed out, once', () => {
    const a = nextSignInState(undefined, app, NOW).state
    const b = nextSignInState(a, wall, NOW + 1)
    expect(b.state).toEqual({ everSignedIn: true, signedOut: true, since: NOW + 1 })
    expect(b.transition).toBe('signed-out')
    // A second sign-in page is not a second event.
    const c = nextSignInState(b.state, { url: 'https://accounts.google.com/signin' }, NOW + 2)
    expect(c.transition).toBeNull()
    expect(c.state).toBe(b.state)
  })

  it('back on a normal page: cleared', () => {
    const out = { everSignedIn: true, signedOut: true, since: NOW }
    const r = nextSignInState(out, app, NOW + 5)
    expect(r.state).toEqual({ everSignedIn: true, signedOut: false })
    expect(r.transition).toBe('signed-in')
  })

  it('a password field on an ordinary URL counts', () => {
    const a = nextSignInState(undefined, app, NOW).state
    expect(nextSignInState(a, { url: app.url, hasPasswordField: true }, NOW).transition).toBe('signed-out')
  })

  it('a non-web page changes nothing', () => {
    const a = nextSignInState(undefined, app, NOW).state
    for (const url of ['about:blank', 'chrome-error://chromewebdata/', '']) {
      const r = nextSignInState(a, { url }, NOW)
      expect(r.state).toBe(a)
      expect(r.transition).toBeNull()
    }
  })

  it('names the signal, never the page', () => {
    expect(signInSignal({ url: app.url, hasPasswordField: true })).toBe('password-field')
    expect(signInSignal({ url: 'https://x.example/login' })).toBe('url')
    expect(signInSignal({ url: 'https://x.example/', title: 'Sign in' })).toBe('title')
    expect(signInSignal(app)).toBe('none')
  })
})

describe('log-safe URLs', () => {
  it('keeps origin and path, drops query and fragment', () => {
    expect(urlForLog('https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail&email=a%40b.c#x')).toBe(
      'https://accounts.google.com/v3/signin/identifier'
    )
    expect(urlForLog('not a url')).toBe('(unparseable url)')
    expect(urlForLog('data:text/html,<b>secret</b>')).toBe('data:')
  })
})

describe('the store', () => {
  const report = vi.fn(async () => {})

  beforeEach(() => {
    localStorage.clear()
    report.mockClear()
    ;(window as unknown as { api: unknown }).api = { sessions: { reportSignedOut: report } }
    useAppNotifications.setState({ signIn: {} })
  })

  it('marks an app signed out after it was signed in, persists it, and reports once', () => {
    const s = useAppNotifications.getState()
    s.observeSignIn('a', { url: 'https://app.example.com/inbox' })
    expect(useAppNotifications.getState().signedOutFor('a')).toBe(false)
    s.observeSignIn('a', { url: 'https://app.example.com/login?token=SECRET' })
    expect(useAppNotifications.getState().signedOutFor('a')).toBe(true)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('a', 'https://app.example.com/login?token=SECRET', 'url')
    s.observeSignIn('a', { url: 'https://app.example.com/login' })
    expect(report).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(localStorage.getItem('fb.appNotifications.signIn') ?? '{}')
    expect(saved.a).toMatchObject({ everSignedIn: true, signedOut: true })
  })

  it('clears once the app is back on a normal page', () => {
    const s = useAppNotifications.getState()
    s.observeSignIn('a', { url: 'https://app.example.com/inbox' })
    s.observeSignIn('a', { url: 'https://app.example.com/login' })
    s.observeSignIn('a', { url: 'https://app.example.com/inbox' })
    expect(useAppNotifications.getState().signedOutFor('a')).toBe(false)
  })

  it('never signs out an app it never saw signed in', () => {
    useAppNotifications.getState().observeSignIn('b', { url: 'https://app.example.com/login' })
    expect(useAppNotifications.getState().signedOutFor('b')).toBe(false)
    expect(report).not.toHaveBeenCalled()
  })
})

describe('wiring pins', () => {
  const root = resolve(__dirname, '../..')
  const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')

  it('every surface that shows a connected app feeds the detector', () => {
    expect(read('src/renderer/src/components/views/ConnectedAppView.tsx')).toMatch(/useSignInWatch\(wvEl, app\?\.id/)
    expect(read('src/renderer/src/components/widgets/WebViewWidget.tsx')).toMatch(/useSignInWatch\(/)
    expect(read('src/renderer/src/components/AppNotificationHost.tsx')).toMatch(/store\.observeSignIn\(app\.id/)
  })

  it('the side menu tile shows the signed-out state for every connected app', () => {
    const src = read('src/renderer/src/components/nav/AreaAccordion.tsx')
    expect(src).toMatch(/signedOut=\{appSignIn\[app\.id\]\?\.signedOut === true\}/)
    expect(src).toContain('Signed out — sign in')
    expect(src).toContain('data-testid="nav-signed-out"')
  })

  it('the pop-up router uses the shared heuristics rather than a second copy', () => {
    const src = read('src/main/popupRouter.ts')
    expect(src).toMatch(/from '\.\.\/shared\/authUrl'/)
    expect(src).not.toMatch(/const AUTH_HOSTS/)
  })
})
