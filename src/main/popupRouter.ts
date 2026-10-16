import type { BrowserWindowConstructorOptions } from 'electron'

// Inputs and outputs are scoped to the fields we actually inspect — keeps the
// router pure so the unit + e2e suites can call it directly without spinning up
// a real <webview>.
export interface PopupDetails {
  url: string
  frameName: string
  features: string
  disposition: string
}

export type PopupDecision =
  | {
      action: 'allow'
      overrideBrowserWindowOptions: BrowserWindowConstructorOptions
    }
  | {
      action: 'deny'
      // Set when we want the renderer to spawn a canvas widget for the URL
      // instead of opening a real popup window. Pure record — no side effects
      // here, the caller wires this up to IPC.
      forwardToRenderer?: { url: string }
    }

export interface PopupRouterContext {
  // Forwarded to overrideBrowserWindowOptions.webPreferences.session so the
  // popup shares the parent webview's cookies + auth state.
  session: Electron.Session
  // Optional parent window for proper z-order + focus-restore on close.
  parentWindow?: Electron.BrowserWindow
}

// Hosts and path shapes that indicate an OAuth / SSO flow. These MUST stay as
// real native popups: the provider posts its callback back through
// `window.opener`, which only exists for an allowed window, so routing them to a
// canvas widget would break sign-in.
const AUTH_HOSTS = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)auth0\.com$/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)onelogin\.com$/i,
  /(^|\.)pingidentity\.com$/i,
  /(^|\.)duosecurity\.com$/i,
  /(^|\.)login\.yahoo\.com$/i,
  // Code hosts run their whole sign-in flow (login, 2FA, device, oauth) on their
  // own host, so match the host and every step of a connect stays a real window.
  /(^|\.)github\.com$/i,
  /(^|\.)gitlab\.com$/i,
  /(^|\.)bitbucket\.org$/i,
  // The identity providers and SaaS hosts people actually sign in to from a
  // connected app. Added after "too many issues with logging in to different
  // apps": the path pattern below catches most flows, but a provider that
  // runs its sign-in on a bare host path (or hops to a device/consent step
  // that does not say "login") fell through to being routed as a link, which
  // drops window.opener and breaks the handshake.
  /(^|\.)slack\.com$/i,
  /(^|\.)atlassian\.com$/i,
  /(^|\.)atlassian\.net$/i,
  /(^|\.)notion\.so$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)zoom\.us$/i,
  /(^|\.)dropbox\.com$/i,
  /(^|\.)box\.com$/i,
  /(^|\.)salesforce\.com$/i,
  /(^|\.)force\.com$/i,
  /(^|\.)hubspot\.com$/i,
  /(^|\.)xero\.com$/i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)shopify\.com$/i,
  /(^|\.)myshopify\.com$/i,
  /(^|\.)discord\.com$/i,
  /(^|\.)figma\.com$/i,
  /(^|\.)canva\.com$/i,
  /(^|\.)amazon\.com$/i,
  /(^|\.)amazoncognito\.com$/i,
  /(^|\.)workos\.com$/i,
  /(^|\.)clerk\.accounts\.dev$/i,
  /(^|\.)firebaseapp\.com$/i,
  /(^|\.)b2clogin\.com$/i
]
// Path shapes that signal a sign-in step for a provider we don't host-match.
// Segment-anchored, so /login matches but /login-help does not.
const AUTH_PATH =
  /\/(oauth2?|authorize|authenticate|signin|sign[-_]?in|login|log[-_]?in|sessions?|sso|saml|openid|connect|device|consent|callback|verify|mfa|2fa|challenge)(\/|$|\?|#)/i

/**
 * Query shapes that mean "this is an OAuth step", whatever the path says.
 *
 * A provider that puts its flow on a bare path — /x?response_type=code&... —
 * matches nothing above, and the popup would be routed to a desk object with
 * no window.opener, which is the same as failing to sign in.
 */
const AUTH_QUERY = /(^|&)(response_type|client_id|redirect_uri|code_challenge|scope|state|id_token_hint)=/i

function isAuthUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (AUTH_HOSTS.some((re) => re.test(u.hostname))) return true
    if (AUTH_PATH.test(u.pathname)) return true
    return AUTH_QUERY.test(u.search.replace(/^\?/, ''))
  } catch {
    return false
  }
}

// A native-window decision, shared by the auth path and the explicit-new-surface
// path. Compact for scripted / OAuth popups; roomy for a full new surface so a
// doc or app opening into it isn't crammed into a tiny window.
function allowWindow(ctx: PopupRouterContext, compact: boolean): PopupDecision {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: compact ? 520 : 1180,
      height: compact ? 720 : 820,
      minWidth: 360,
      minHeight: 480,
      autoHideMenuBar: true,
      parent: ctx.parentWindow,
      webPreferences: {
        session: ctx.session,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false
      }
    }
  }
}

/**
 * Decide what to do with a window.open / link-click from a <webview>, in order:
 *
 *  1. Non-navigable schemes (javascript:, data:, mailto:, blob:) never open.
 *  2. A sign-in flow from ANY provider — a known auth host, or an auth-shaped
 *     path such as /login, /oauth, /authorize, /sso — opens as a real native
 *     window sharing the parent session. The provider hands the session back
 *     through window.opener, which only exists for an allowed window, so this
 *     must never become a canvas widget or a denied popup or sign-in hangs
 *     (this is what makes GitHub, Google, Microsoft and the like connect
 *     reliably whether or not the webview was already signed in).
 *  3. A genuine "open in a new tab" link — a plain foreground/background tab,
 *     no features, no named handle, not an auth URL — opens as a browser object
 *     on the desk, so it never strands the user off the canvas.
 *  4. An explicit new window, a scripted feature popup, or a named handle keeps
 *     a real native window (the opener depends on the returned handle).
 *  5. Anything else still shows: it opens as a browser object on the desk rather
 *     than silently vanishing. No app's popup is ever dropped without a trace.
 *
 * Pure decision logic — no side effects, no IPC.
 */
export function decidePopup(
  details: PopupDetails,
  ctx: PopupRouterContext
): PopupDecision {
  const { url, disposition, features, frameName } = details
  const isHttp = !!url && /^https?:\/\//i.test(url)
  if (!isHttp) return { action: 'deny' } // (1) non-navigable scheme — never opens

  const hasFeatures = !!(features && features.length > 0)
  const namedFrame = !!(frameName && frameName !== '_blank' && frameName !== '')
  const compact = disposition === 'new-window' || hasFeatures

  // (2) Sign-in / OAuth / SSO from any provider → real native window.
  if (isAuthUrl(url)) return allowWindow(ctx, compact)

  // (3) A plain new-tab link → a browser object on the desk.
  const isPlainNewTab =
    (disposition === 'foreground-tab' || disposition === 'background-tab') && !hasFeatures && !namedFrame
  if (isPlainNewTab) return { action: 'deny', forwardToRenderer: { url } }

  // (4) Explicit new window / scripted feature popup / named handle.
  if (disposition === 'new-window' || hasFeatures || namedFrame) {
    return allowWindow(ctx, compact)
  }

  // (5) Fallback: still show it, as a browser object on the desk.
  return { action: 'deny', forwardToRenderer: { url } }
}
