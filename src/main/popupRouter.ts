import type { BrowserWindowConstructorOptions } from 'electron'
import { isAuthUrl } from '../shared/authUrl'

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

// Hosts and path shapes that indicate an OAuth / SSO flow live in
// src/shared/authUrl.ts, shared with the renderer's connected-app signed-out
// detector. They MUST stay real native popups: the provider posts its callback
// back through `window.opener`, which only exists for an allowed window, so
// routing them to a canvas widget would break sign-in.
export { isAuthUrl }

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
