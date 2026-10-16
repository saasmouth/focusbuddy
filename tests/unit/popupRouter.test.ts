import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decidePopup } from '../../src/main/popupRouter'

// Stand-in for Electron.Session — the router only stores it for re-emission into
// webPreferences, never calls methods on it.
const FAKE_SESSION = { _stub: true } as unknown as Electron.Session

const ctx = { session: FAKE_SESSION }

describe('decidePopup', () => {
  describe('OAuth-style popups', () => {
    it('allows window.open with explicit features as a native popup', () => {
      const result = decidePopup(
        {
          url: 'https://accounts.google.com/o/oauth2/auth?...',
          frameName: '',
          features: 'width=600,height=700,popup=true',
          disposition: 'new-window'
        },
        ctx
      )
      expect(result.action).toBe('allow')
      if (result.action !== 'allow') return
      expect(result.overrideBrowserWindowOptions.width).toBe(520)
      expect(result.overrideBrowserWindowOptions.height).toBe(720)
    })

    it('shares the parent session so cookies + auth state survive', () => {
      const result = decidePopup(
        {
          url: 'https://github.com/login/oauth',
          frameName: '',
          features: 'popup=true',
          disposition: 'new-window'
        },
        ctx
      )
      expect(result.action).toBe('allow')
      if (result.action !== 'allow') return
      expect(result.overrideBrowserWindowOptions.webPreferences?.session).toBe(
        FAKE_SESSION
      )
    })

    it('disables nodeIntegration + webviewTag on the popup (sandboxed)', () => {
      const result = decidePopup(
        {
          url: 'https://login.microsoftonline.com',
          frameName: '',
          features: 'popup=true',
          disposition: 'new-window'
        },
        ctx
      )
      expect(result.action).toBe('allow')
      if (result.action !== 'allow') return
      const prefs = result.overrideBrowserWindowOptions.webPreferences!
      expect(prefs.nodeIntegration).toBe(false)
      expect(prefs.contextIsolation).toBe(true)
      expect(prefs.sandbox).toBe(true)
      expect(prefs.webviewTag).toBe(false)
    })

    it('allows named popups (window.open(url, "popupName")) as native windows', () => {
      // Some OAuth providers use frameName as the window handle for postMessage —
      // a named non-_blank target should be treated as a popup, not a link click.
      const result = decidePopup(
        {
          url: 'https://provider.example/auth',
          frameName: 'oauth_popup',
          features: '',
          disposition: 'new-window'
        },
        ctx
      )
      expect(result.action).toBe('allow')
    })
  })

  describe('new tabs (target=_blank / window.open without features) → desk widget', () => {
    it('forwards a plain foreground-tab to a canvas widget with the URL', () => {
      const result = decidePopup(
        {
          url: 'https://docs.example.com/article',
          frameName: '_blank',
          features: '',
          disposition: 'foreground-tab'
        },
        ctx
      )
      expect(result.action).toBe('deny')
      if (result.action !== 'deny') return
      expect(result.forwardToRenderer?.url).toBe('https://docs.example.com/article')
    })

    it('forwards a background-tab to a canvas widget too', () => {
      const result = decidePopup(
        { url: 'https://x.example', frameName: '', features: '', disposition: 'background-tab' },
        ctx
      )
      expect(result.action).toBe('deny')
      if (result.action !== 'deny') return
      expect(result.forwardToRenderer?.url).toBe('https://x.example')
    })

    it('a "new document" opened as a plain new tab becomes a desk object, not a stranded window', () => {
      // The user's report: clicking "create new doc" opened a separate window
      // with no path back to the desk. A plain new tab to a known URL now lands
      // as a canvas widget instead.
      const result = decidePopup(
        {
          url: 'https://docs.google.com/document/d/abc/edit',
          frameName: '',
          features: '',
          disposition: 'foreground-tab'
        },
        ctx
      )
      expect(result.action).toBe('deny')
      if (result.action !== 'deny') return
      expect(result.forwardToRenderer?.url).toContain('docs.google.com')
    })

    it('denies non-http schemes (javascript:, data:, mailto:) without forwarding', () => {
      for (const url of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.com']) {
        const result = decidePopup(
          { url, frameName: '_blank', features: '', disposition: 'foreground-tab' },
          ctx
        )
        expect(result.action).toBe('deny')
        if (result.action !== 'deny') return
        expect(result.forwardToRenderer).toBeUndefined()
      }
    })
  })

  describe('auth exception — a plain new tab that IS an auth flow stays native', () => {
    it('keeps a foreground-tab to an auth host (accounts.google.com) as a native window', () => {
      const result = decidePopup(
        { url: 'https://accounts.google.com/signin/v2', frameName: '', features: '', disposition: 'foreground-tab' },
        ctx
      )
      expect(result.action).toBe('allow')
    })

    it('keeps a foreground-tab whose path is an oauth/authorize flow native', () => {
      const result = decidePopup(
        { url: 'https://provider.example/oauth2/authorize?client_id=x', frameName: '', features: '', disposition: 'foreground-tab' },
        ctx
      )
      expect(result.action).toBe('allow')
    })
  })

  describe('regression guards', () => {
    it('an explicit new-window still opens as a native window (handle-dependent)', () => {
      const result = decidePopup(
        { url: 'https://app.example/tool', frameName: '', features: '', disposition: 'new-window' },
        ctx
      )
      expect(result.action).toBe('allow')
    })

    it('OAuth popups stay compact and keep the session (preserves window.opener)', () => {
      const result = decidePopup(
        {
          url: 'https://provider.example/oauth',
          frameName: '',
          features: 'popup=true,width=500,height=600',
          disposition: 'new-window'
        },
        ctx
      )
      expect(result.action).toBe('allow')
      if (result.action !== 'allow') return
      expect(result.overrideBrowserWindowOptions.width).toBe(520)
    })
  })

  describe('sign-in from any connected app stays a native window', () => {
    it('GitHub plain login as a foreground-tab opens native (the connect-spins fix)', () => {
      // A user not yet signed into GitHub in the app hits github.com/login first,
      // which is not an /oauth path. Host-matching keeps it a real window so the
      // sign-in completes instead of being forwarded to the canvas as a widget.
      const result = decidePopup(
        {
          url: 'https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize',
          frameName: '',
          features: '',
          disposition: 'foreground-tab'
        },
        ctx
      )
      expect(result.action).toBe('allow')
    })

    it('GitHub two-factor and device popups open native', () => {
      for (const url of ['https://github.com/sessions/two-factor', 'https://github.com/login/device']) {
        const result = decidePopup({ url, frameName: '', features: '', disposition: 'foreground-tab' }, ctx)
        expect(result.action).toBe('allow')
      }
    })

    it('GitLab and Bitbucket hosts open native too', () => {
      for (const url of ['https://gitlab.com/users/sign_in', 'https://bitbucket.org/account/signin']) {
        const result = decidePopup({ url, frameName: '', features: '', disposition: 'foreground-tab' }, ctx)
        expect(result.action).toBe('allow')
      }
    })

    it('an unknown provider whose path looks like sign-in opens native', () => {
      for (const url of ['https://acme.example/login', 'https://acme.example/sso/start', 'https://acme.example/oauth/authorize']) {
        const result = decidePopup({ url, frameName: '', features: '', disposition: 'foreground-tab' }, ctx)
        expect(result.action).toBe('allow')
      }
    })

    it('does not mistake a content path that merely contains "login" (/login-help) for auth', () => {
      const result = decidePopup(
        { url: 'https://docs.example.com/login-help', frameName: '', features: '', disposition: 'foreground-tab' },
        ctx
      )
      expect(result.action).toBe('deny') // ordinary link → desk browser widget
      if (result.action !== 'deny') return
      expect(result.forwardToRenderer?.url).toContain('login-help')
    })
  })

  describe('no popup is ever silently dropped', () => {
    it('an http popup with an odd disposition still shows as a desk browser object', () => {
      const result = decidePopup(
        { url: 'https://random.example/thing', frameName: '', features: '', disposition: 'other' },
        ctx
      )
      expect(result.action).toBe('deny')
      if (result.action !== 'deny') return
      expect(result.forwardToRenderer?.url).toBe('https://random.example/thing')
    })

    it('still refuses non-http schemes outright, with no forward', () => {
      const result = decidePopup(
        { url: 'javascript:alert(1)', frameName: '', features: '', disposition: 'other' },
        ctx
      )
      expect(result.action).toBe('deny')
      if (result.action !== 'deny') return
      expect(result.forwardToRenderer).toBeUndefined()
    })
  })
})

// ── "Enable popup windows… too many issues with logging in to apps" ───────
//
// Two faults. The connected-app pane never set `allowpopups` at attach — it
// set it from an effect, which Electron ignores — so no popup could open from
// a connected app at all, whatever the router below decided. And the router
// only recognised a sign-in by a short host list or a path keyword, so a
// provider running its flow on a bare path got routed to a desk object, which
// has no `window.opener` and therefore cannot complete OAuth.

describe('a connected app may actually open a popup', () => {
  const view = readFileSync(
    join(__dirname, '..', '..', 'src/renderer/src/components/views/ConnectedAppView.tsx'),
    'utf8'
  )

  it('sets allowpopups in the JSX, where Electron will read it', () => {
    expect(view).toContain('allowpopups="true"')
  })

  it('and no longer tries to set it from an effect, which does nothing', () => {
    expect(view).not.toContain("wv.setAttribute('allowpopups'")
  })
})

describe('sign-in flows are recognised however the provider shapes them', () => {
  const open = (url: string): string =>
    decidePopup(
      { url, disposition: 'new-foreground-tab', features: '', frameName: '' } as never,
      { session: FAKE_SESSION }
    ).action

  it('allows a real window for an OAuth query on a bare path', () => {
    // The case the keyword list missed entirely.
    expect(open('https://unknown-saas.example/x?response_type=code&client_id=abc&redirect_uri=z')).toBe('allow')
  })

  it('allows the providers people actually connect', () => {
    for (const u of [
      'https://slack.com/openid/connect/start',
      'https://id.atlassian.com/',
      'https://www.notion.so/',
      'https://login.xero.com/',
      'https://example.b2clogin.com/'
    ]) {
      expect(open(u), u).toBe('allow')
    }
  })

  it('still recognises the keyword paths it always did', () => {
    for (const u of [
      'https://any.example/oauth/authorize',
      'https://any.example/sign-in',
      'https://any.example/sso/saml',
      'https://any.example/mfa/challenge'
    ]) {
      expect(open(u), u).toBe('allow')
    }
  })

  it('does NOT turn every link into a popup', () => {
    // The desk-object routing for a plain new-tab link is a deliberate
    // feature, not a bug to fix — widening auth detection must not eat it.
    for (const u of ['https://example.com/pricing', 'https://news.example/article/123']) {
      expect(open(u), u).toBe('deny')
    }
  })

  it('never opens a non-http scheme', () => {
    expect(open('file:///etc/passwd')).toBe('deny')
    expect(open('javascript:alert(1)')).toBe('deny')
  })
})
