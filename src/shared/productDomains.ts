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
 * THE CUTOVER SWITCH, mid-cutover.
 *
 * `downloads` has moved to R2; `site`, `api` and `viewer` have not. Each is a
 * deliberate decision, not an oversight:
 *
 * - downloads -> R2, because this is the bridge release. Until a build ships
 *   whose download origin is R2, every client asks GitHub forever, and taking
 *   the repo private strands all of them. GitHub keeps serving in parallel so
 *   clients already installed can reach this release in the first place.
 *
 * - site STAYS, because autoUpdate.ts builds the manual-download fallback as
 *   `${ACTIVE.site}/download`, and that path does not exist on the new domain
 *   yet: www.plexiidesk.com still serves a GoDaddy builder page and returns 404
 *   there, while haptyx-web.vercel.app/download returns 200. That URL is
 *   compiled into the installer, so shipping it broken is a release to redo,
 *   reached by exactly the user who has already been told to download manually.
 *   Flip it once the site is on Cloudflare Pages with a /download route.
 *
 * - api STAYS, deliberately, though api.plexiidesk.com is live and verified
 *   (/healthz returns 200 and matches the Fly origin on every path). It carries
 *   signup, login, sharing and plan checks for every user, so it should move in
 *   a release that exists to move it and can be tested as such — not folded
 *   into a release about download origins.
 *
 * - viewer STAYS for the same reason: view.plexiidesk.com resolves and serves,
 *   but shared links already in circulation point at the Vercel host.
 */
export const ACTIVE: ProductDomains = { ...CURRENT, downloads: PRODUCTION.downloads }

/** The WebSocket URL for an API origin: https -> wss, http -> ws, plus /ws. */
export function wsUrlFor(apiOrigin: string): string {
  return `${apiOrigin.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws`
}

/**
 * The URL a release asset is downloaded from.
 *
 * Both the website's download buttons and the macOS in-app updater resolve an
 * asset through here. macOS does NOT use electron-updater's feed — it builds
 * this URL itself and fetches the zip — so this function is the mac update
 * channel, not just a convenience.
 *
 * The shape differs per origin, which is why this is a function and not a
 * concatenation at each call site: GitHub Releases nests assets under
 * `/download/v<version>/`, while an object store like R2 serves them from a
 * flat prefix. Moving origin means editing this one function.
 *
 * THE CONSTRAINT THAT GOVERNS ANY MOVE: this URL is compiled into every
 * installer. A user on 4.3.8 asks GitHub for its update forever, because that
 * is what their copy was built with. So a new origin cannot replace the old one
 * — the old one has to keep serving every version still expected to update
 * in place, which in practice means publishing to both until those clients are
 * gone.
 */
export function releaseAssetUrl(origin: string, version: string, filename: string): string {
  const base = origin.replace(/\/+$/, '')
  // GitHub Releases: /releases/download/<tag>/<asset>
  if (/github\.com/.test(base)) return `${base}/download/v${version}/${filename}`
  // Object store (R2, S3, a CDN): a flat per-version prefix.
  return `${base}/v${version}/${filename}`
}

/**
 * Whether an origin can serve an electron-updater `generic` feed.
 *
 * GitHub Releases cannot: electron-updater's generic provider fetches
 * `<url>/latest-mac.yml` and resolves each asset's `path` beside it, and GitHub
 * nests assets under `/download/<tag>/` instead. So a GitHub origin has to use
 * the `github` provider, and an object store has to use `generic`. Getting this
 * pair wrong bakes a feed into the installer that 404s forever.
 */
export function usesGithubReleases(origin: string): boolean {
  return /github\.com/.test(origin)
}

/**
 * The directory an electron-updater `generic` feed is read from.
 *
 * THE LAYOUT, and why there are two of them. The bucket holds every release
 * twice:
 *
 *   v<version>/<file>   immutable, one prefix per release. This is what
 *                       releaseAssetUrl builds, so it is what the website's
 *                       download buttons and the macOS installer step ask for.
 *
 *   <file>              at the root, overwritten every release. This is the
 *                       rolling "latest", and it exists because electron-updater
 *                       needs a FLAT directory: it reads <root>/latest-mac.yml
 *                       and then resolves that manifest's `path` beside it. A
 *                       versioned prefix cannot serve as the feed, because the
 *                       feed URL is compiled into the installer and would have
 *                       to name the NEXT version's prefix — which is not known
 *                       when the build runs.
 *
 * Both are written by scripts/upload-release-assets.mjs, manifests last, so the
 * rolling feed never names an artifact that has not finished uploading.
 */
export function updateFeedUrl(downloadsOrigin: string): string {
  return downloadsOrigin.replace(/\/+$/, '')
}
