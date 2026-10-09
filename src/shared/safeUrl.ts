// An address taken from content and handed to the browser to open, frame or
// link to.
//
// On the desktop the main process re-checks every window.open (see
// setWindowOpenHandler in main/index.ts). The browser build has no such second
// line: the same renderer runs on the public share page, where the desk -- and
// every address in it -- was written by whoever minted the link. There,
// window.open('javascript:…') runs script in the share page's own origin, and a
// tab opened without noopener can rewrite the page that opened it.
//
// The rules are the ones the public-desk contract already applies to anything
// it publishes (isSafePublicUrl in publicDeskValidate.ts), restated here
// because that file is vendored and generated:
//
//   1. http: and https: only. javascript:, data:, blob:, file:, fb-file: and
//      every app scheme are refused.
//   2. No embedded credentials. https://user:pass@host is a phishing tell, and
//      nothing in this app ever needs one.
//
// One convenience, matching what the address fields have always accepted: an
// address typed without a scheme ("example.com/pricing") is read as https.
// Something that already names another scheme ("javascript:…", "mailto:…")
// does not survive that -- it either fails to parse as a host, or parses with
// credentials and is refused by rule 2.

/**
 * The http(s) URL `raw` names, or null when it names anything else.
 *
 * Relative and scheme-relative input ("/share/…", "//host") is refused rather
 * than resolved: it would resolve against whatever page happens to be showing,
 * which on the share site is the share site itself.
 */
export function toHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.startsWith('/') || s.startsWith('\\')) return null
  // "scheme://…" naming any scheme but http(s) is refused as written, rather
  // than read as a host called "javascript" or "file".
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username !== '' || u.password !== '') return null
  if (!u.hostname) return null
  return u
}

/** True when `raw` is an http(s) address `toHttpUrl` would accept. */
export function isHttpUrl(raw: unknown): boolean {
  return toHttpUrl(raw) !== null
}
