// Address-bar input handling for the browser widget. Turns whatever the user
// types into something to load: a real address is navigated to, and anything
// that is plainly a search runs as a Google search instead of routing to a
// broken, percent-encoded page. Kept pure and separate from the component so
// the URL-versus-search decision is unit-testable.

// A Google search for free-text the user typed into the address bar.
export function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

// Does this string look like a host the user means to visit, rather than a
// search? Mirrors a browser omnibox: anything with whitespace is a search, a
// bare word with no dot is a search, but localhost, an IP, a port, or a dotted
// hostname with a real-looking TLD is a navigation.
export function looksLikeHost(input: string): boolean {
  if (/\s/.test(input)) return false
  const afterScheme = input.replace(/^[a-z]+:\/\//i, '')
  const host = afterScheme.split(/[/?#]/)[0].split('@').pop() ?? ''
  const hostname = host.split(':')[0]
  if (!hostname) return false
  if (hostname === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true // IPv4
  if (hostname.includes(':') && /^\[?[0-9a-f:]+\]?$/i.test(hostname)) return true // IPv6
  return /\.[a-z]{2,}$/i.test(hostname) // dotted host ending in a TLD-like label
}

// Turn whatever the user typed into a URL to load. Returns null only for empty
// input; every other input resolves either to a real address or to a search.
export function normalizeUrl(input: string): string | null {
  return resolveAddressInput(input, searchUrl)
}

// Address-bar resolution for the unified browser surface: a real address
// navigates, anything searchy goes to the CALLER'S search engine — the pinned
// preference the omnibar and the engine chip share (AI-02), so the address bar
// can never disagree with the rest of the app. normalizeUrl above keeps its
// fixed-Google fallback for callers with no engine in reach (sanitization).
export function resolveAddressInput(
  input: string,
  searchFor: (query: string) => string
): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(about|data|view-source|mailto):/i.test(raw)) {
    try {
      return new URL(raw).toString()
    } catch {
      return searchFor(raw)
    }
  }
  if (looksLikeHost(raw)) {
    try {
      return new URL(`https://${raw}`).toString()
    } catch {
      // looked host-like but would not parse; treat it as a search
    }
  }
  return searchFor(raw)
}

// Sanitize a value before it is loaded as a <webview src> or stored as a webview
// widget's content. A valid absolute URL (any real scheme, e.g. http, https,
// fb-file) passes through untouched, so legitimate content is preserved; a
// relative or scheme-less string is turned into a real URL or a Google search
// instead. This is a security guard, not a convenience: Electron resolves a
// non-absolute <webview src> against the host page's own file:// bundle
// directory, so a bare string (for instance free text an AI create-widget
// proposal wrote into content) could otherwise load a bundle asset such as
// assets/index-*.js and render its raw minified source as plain text. Returns
// '' for empty input.
export function sanitizeWebviewUrl(input: string): string {
  const raw = (input ?? '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).toString()
  } catch {
    /* not an absolute URL — fall through */
  }
  if (looksLikeHost(raw)) {
    try {
      return new URL(`https://${raw}`).toString()
    } catch {
      /* looked host-like but would not parse */
    }
  }
  // NEVER A SEARCH. This used to hand anything unparseable to normalizeUrl,
  // which means a GOOGLE SEARCH — so a pdf widget whose content is a bare
  // fb_files id loaded https://www.google.com/search?q=<file id>. The id went
  // to a third party and the person got search results instead of their PDF
  // (found by d1, 2026-10-24; owner ruled it out of the product the same day).
  //
  // A sanitiser's job is to refuse what it cannot vouch for. Deciding that an
  // unrecognised string is a search query is a decision only the person typing
  // in an address bar can make, and they make it through
  // resolveAddressInput with their own chosen engine. Everything else gets ''
  // and the caller shows an honest state.
  return ''
}

/**
 * What a webview widget should load for a stored `content` value.
 *
 * Three cases, and none of them is a search:
 *   - a real absolute URL, or something host-like, loads as itself;
 *   - a bare fb_files id resolves to the LOCAL file (fb-file://<id>), which is
 *     what a pdf, gdoc or file widget stores;
 *   - anything else returns '', and the widget says it cannot open it.
 *
 * `fileSrcFor` is injected rather than imported so this stays pure and the
 * decision can be tested without the file-URL plumbing — the same shape as
 * resolveAddressInput taking its search engine.
 */
export function webviewSrc(input: string, fileSrcFor: (fileId: string) => string): string {
  const raw = (input ?? '').trim()
  if (!raw) return ''
  const direct = sanitizeWebviewUrl(raw)
  if (direct) return direct
  // An fb_files id: the shape fileUrl.ts itself matches when reading one back
  // (/^fb-file:\/\/([\w-]+)/). Length-guarded so a stray word is not treated
  // as a file that will never resolve.
  if (/^[\w-]{8,}$/.test(raw)) return fileSrcFor(raw)
  return ''
}
