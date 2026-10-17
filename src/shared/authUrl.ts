// Sign-in URL heuristics, shared by the main process (popupRouter decides which
// pop-ups must stay real windows) and the renderer (the connected-app signed-out
// detector). Pure: no electron, no DOM.
//
// TWO QUESTIONS, TWO ANSWERS. popupRouter asks "might this pop-up be part of a
// sign-in?" and errs towards yes, because a wrong no breaks OAuth. The signed-out
// detector asks "has this app landed on a sign-in wall?" and must err towards
// no, because a wrong yes tells someone they are signed out of an app they are
// using. So the SaaS hosts below count for the first question only: a Slack
// connected app lives on slack.com all day, signed in.

// Hosts whose only job is signing people in. Landing on one of these as the
// settled page of a connected app means the app sent you to sign in.
export const IDENTITY_PROVIDER_HOSTS: readonly RegExp[] = [
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
  /(^|\.)amazoncognito\.com$/i,
  /(^|\.)workos\.com$/i,
  /(^|\.)clerk\.accounts\.dev$/i,
  /(^|\.)b2clogin\.com$/i
]

// Hosts that run their sign-in flow on the same host as the product. Matching
// them keeps every step of a connect a real window (popupRouter), but says
// nothing about whether a page on them is a sign-in wall.
//
// Code hosts run their whole sign-in flow (login, 2FA, device, oauth) on their
// own host. The rest are the identity providers and SaaS hosts people actually
// sign in to from a connected app — added after "too many issues with logging
// in to different apps": the path pattern below catches most flows, but a
// provider that runs its sign-in on a bare host path (or hops to a
// device/consent step that does not say "login") fell through to being routed
// as a link, which drops window.opener and breaks the handshake.
export const SIGN_IN_CAPABLE_HOSTS: readonly RegExp[] = [
  /(^|\.)github\.com$/i,
  /(^|\.)gitlab\.com$/i,
  /(^|\.)bitbucket\.org$/i,
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
  /(^|\.)firebaseapp\.com$/i
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

/** Might this URL be a step of a sign-in flow? Errs towards yes (popupRouter). */
export function isAuthUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (IDENTITY_PROVIDER_HOSTS.some((re) => re.test(u.hostname))) return true
    if (SIGN_IN_CAPABLE_HOSTS.some((re) => re.test(u.hostname))) return true
    if (AUTH_PATH.test(u.pathname)) return true
    return AUTH_QUERY.test(u.search.replace(/^\?/, ''))
  } catch {
    return false
  }
}

// The stricter path set for "this page IS a sign-in wall". Drops the steps that
// also name ordinary in-app pages (/connect, /callback, /verify, /device,
// /sessions — a list of your active sessions is not a login page) and keeps the
// shapes that only ever mean "sign in here". Segment-anchored like AUTH_PATH.
const SIGN_IN_WALL_PATH =
  /(^|\/)(oauth2?|authorize|signin|sign[-_]?in|login|log[-_]?in|sso|saml|auth|servicelogin|session\/new|account\/login|u\/login)(\/|$)/i

// Titles a sign-in page gives itself. Anchored at the start (or after a brand
// separator) so "Login settings — Admin" in an app's own UI is not matched by
// the word appearing somewhere in the middle.
const SIGN_IN_TITLE =
  /^(?:.*?[|·•–—-]\s*)?(sign[\s-]?in|log[\s-]?in|sign[\s-]?on|single sign-on)\b(?!\s+(settings|history|activity|methods?|options))/i

export interface SignInObservation {
  /** The page's settled URL. */
  url: string
  /** The page's title, when known. */
  title?: string
  /** Whether a VISIBLE password field is on the page. */
  hasPasswordField?: boolean
}

/**
 * Is this page a sign-in wall? Generic on purpose: the directory of connected
 * apps is not finite, so there is no per-app rule here, only the shapes the
 * whole web uses — an identity-provider host, a login-shaped path, a login
 * title, a visible password field.
 */
export function isSignInPage(obs: SignInObservation): boolean {
  if (obs.hasPasswordField) return true
  if (obs.title && SIGN_IN_TITLE.test(obs.title.trim())) return true
  if (!obs.url) return false
  let u: URL
  try {
    u = new URL(obs.url)
  } catch {
    return false
  }
  if (!/^https?:$/i.test(u.protocol)) return false
  if (IDENTITY_PROVIDER_HOSTS.some((re) => re.test(u.hostname))) return true
  // Hash routers put the route after '#': /#/login is a login page too.
  const hashPath = u.hash.startsWith('#/') ? u.hash.slice(1).split('?')[0] : ''
  return SIGN_IN_WALL_PATH.test(u.pathname) || (!!hashPath && SIGN_IN_WALL_PATH.test(hashPath))
}

/**
 * A URL safe to put in a log line: origin and path only. Query strings and
 * fragments carry tokens, codes and email addresses; they never reach a log.
 */
export function urlForLog(url: string): string {
  try {
    const u = new URL(url)
    if (!/^https?:$/i.test(u.protocol)) return u.protocol
    const path = u.pathname.length > 80 ? `${u.pathname.slice(0, 80)}…` : u.pathname
    return `${u.origin}${path}`
  } catch {
    return '(unparseable url)'
  }
}
