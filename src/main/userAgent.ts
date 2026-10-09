// User-Agent normalisation for in-canvas <webview> browsing.
//
// WHY THIS EXISTS (the headline browser bug):
// Electron's default User-Agent advertises the app as an embedded Electron
// host, e.g.
//   Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
//   (KHTML, like Gecko) focusbuddy/2.4.3 Chrome/130.0.0.0 Electron/33.2.0 Safari/537.36
// Identity providers (Google, Microsoft, Apple, and many others) fingerprint
// the `Electron/x` and app-name tokens and HARD-BLOCK sign-in from "embedded
// user-agents" with the well-known `disallowed_useragent` / "this browser or
// app may not be secure" error. That single token is why logins fail inside
// the browser widget.
//
// The fix is to strip the Electron + app-name tokens so the webview presents
// as plain desktop Chrome. We do NOT fabricate a fake UA string from scratch —
// we keep Electron's real Chrome/AppleWebKit/platform tokens (so feature
// detection and the Chrome version stay honest) and only remove the two tokens
// that trip the embedded-browser detectors.
//
// Pure + side-effect free so it can be unit-tested without booting Electron
// (same pattern as popupRouter.ts).

/** Tokens we strip: `Electron/<ver>`, and the app-name token, which has been
 *  `Haptyx/`, `focusbuddy/`, `PlexiDesk/` and now `plexii/` across renames.
 *  Every past name stays in this list: the token comes from Electron's default
 *  UA, so an older build still emits its own, and a webview that leaks one of
 *  them is fingerprintable as this app. Strip all so the webview presents as
 *  plain desktop Chrome regardless of which build is running. */
const STRIP_PATTERNS: RegExp[] = [
  / Electron\/[^ ]+/gi,
  / plexii\/[^ ]+/gi,
  / focusbuddy\/[^ ]+/gi,
  / Haptyx\/[^ ]+/gi,
  / PlexiDesk\/[^ ]+/gi
]

/**
 * Return a desktop-Chrome User-Agent derived from Electron's default UA with
 * the embedded-host tokens removed. Idempotent: cleaning an already-clean UA
 * is a no-op.
 */
export function cleanWebviewUserAgent(defaultUA: string): string {
  let ua = defaultUA
  for (const re of STRIP_PATTERNS) ua = ua.replace(re, '')
  // Collapse any double spaces left by the removals and trim.
  return ua.replace(/\s{2,}/g, ' ').trim()
}
