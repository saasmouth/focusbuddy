import { signalConfig } from './signalConfig'
import { useOrgStore } from '../stores/org'

// Multi-org tenancy plumbing. Every request the desktop makes to the signal
// server must carry the active organisation so the server can validate
// membership and scope the response to that org. Rather than thread a header
// through the ~11 separate client modules (each has its own fetch), we install a
// single fetch interceptor that stamps `x-plexi-org` onto any request whose host
// matches the signal server. Non-signal requests pass through untouched.
//
// The value is the active org from the renderer's org store (default 'personal').
// The server treats a missing/invalid/non-member org as the caller's personal
// org, so this can never widen access — it only ever narrows to a real org the
// account belongs to.
//
// Except signal's /public/* routes: unauthenticated and org-agnostic, so the
// header means nothing there, and it costs. This wrapper also runs in the web
// runtime (web/boot.tsx imports the renderer's main), where any custom header
// makes a cross-origin GET one the browser must PREFLIGHT: an extra round trip
// on every page that reads, say, /public/server-features, and from an origin
// outside signal's CORS allowlist a preflight signal answers 404 (seen on
// v184/v185, 2026-11-20). Without it the request stays simple.

let installed = false

export function installSignalOrgHeader(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true

  let signalHost = ''
  try {
    signalHost = new URL(signalConfig.httpUrl).host
  } catch {
    /* no signal host configured — interceptor becomes a no-op */
  }

  const orig = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!signalHost) return orig(input, init)
    try {
      const rawUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url
      const target = new URL(rawUrl, window.location.href)
      if (target.host === signalHost && !target.pathname.startsWith('/public/')) {
        const orgId = useOrgStore.getState().activeOrgId || 'personal'
        // Stamp the active org as a DEFAULT only — a caller that set x-plexi-org
        // explicitly (the per-org sync loop, or a cross-org team listing) keeps its
        // value. Safe: the server independently re-validates membership for the
        // requested org, so an explicit header can never widen access.
        if (input instanceof Request) {
          // A Request carries its own headers; clone it with the header added.
          const headers = new Headers(input.headers)
          if (!headers.has('x-plexi-org')) headers.set('x-plexi-org', orgId)
          return orig(new Request(input, { headers }), init)
        }
        const headers = new Headers(init?.headers)
        if (!headers.has('x-plexi-org')) headers.set('x-plexi-org', orgId)
        return orig(input, { ...init, headers })
      }
    } catch {
      /* fall through to the untouched fetch on any parsing error */
    }
    return orig(input, init)
  }
}
