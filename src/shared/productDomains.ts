// Where the four public surfaces live.
//
// Plexii is not one host. It is a brochure site, an API/WebSocket backend, a
// public share viewer and a download origin, and the desktop app has all four
// COMPILED INTO IT at build time. That is the fact that shapes this file: a
// user running 4.3.8 carries whatever these said on the day it was built, and
// changing DNS afterwards does not reach them. Getting these wrong is not a
// deploy to redo, it is a release to redo.
//
// So they are named once, here, and the three modules that need them read from
// this file rather than carrying their own literal. Cutover is one edit to
// ACTIVE, not a hunt through nine files for `fly.dev`.

export interface ProductDomains {
  /** Brochure, help, pricing, account pages. */
  site: string
  /** Signal: the HTTP API. The WebSocket URL is derived from it. */
  api: string
  /** The public viewer a shared desk link opens in. */
  viewer: string
  /** Where installers are served from. */
  downloads: string
}

/** The domains Plexii is going to. Not live until DNS is cut over. */
export const PRODUCTION: ProductDomains = {
  site: 'https://www.plexiidesk.com',
  api: 'https://api.plexiidesk.com',
  viewer: 'https://view.plexiidesk.com',
  downloads: 'https://dl.plexiidesk.com'
}

/**
 * Where they live today.
 *
 * These are real, deployed and working. They stay ACTIVE until each production
 * host actually resolves and serves — flipping early would ship an app that
 * cannot reach its own backend, and the failure would be invisible until a user
 * tried to sign in.
 */
export const CURRENT: ProductDomains = {
  site: 'https://haptyx-web.vercel.app',
  api: 'https://focusbuddy-signal.fly.dev',
  viewer: 'https://focusbuddy-viewer.vercel.app',
  downloads: 'https://github.com/saasmouth/focusbuddy/releases'
}

/**
 * THE CUTOVER SWITCH. Change to PRODUCTION when the domains are live.
 *
 * Do it per-surface if they come up at different times — this is a plain object,
 * so `{ ...CURRENT, site: PRODUCTION.site }` is a legitimate intermediate state
 * and is safer than waiting to move all four at once.
 */
export const ACTIVE: ProductDomains = CURRENT

/** The WebSocket URL for an API origin: https -> wss, http -> ws, plus /ws. */
export function wsUrlFor(apiOrigin: string): string {
  return `${apiOrigin.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws`
}
