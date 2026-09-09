// Single source of truth for "which signaling backend are we using right
// now" and "where does it live". Read from Vite-injected env vars so the
// app can be built with different backends without touching code.
//
// Default behaviour:
//  - EVERY build (dev AND prod) → useRemote = TRUE pointing at the deployed
//    server. Dev used to default to localhost:8787, which meant anyone who
//    checked out a branch and ran `npm run dev` WITHOUT also starting the local
//    signal server got "server unavailable" on login. Defaulting to the real
//    server means a fresh checkout just works; account login, share and inbox
//    sync all hit prod out of the box.
//
// Local development against a local signal server is now an EXPLICIT opt-in:
//    VITE_USE_LOCAL_SIGNAL=true          # -> defaults to localhost:8787/ws
//    (or point VITE_SIGNAL_HTTP_URL / VITE_SIGNAL_WS_URL at any host directly)
// Start the local server with `cd projects/focusbuddy-signal && npm run dev`.
//
// Other overrides:
//    VITE_USE_REMOTE_SIGNAL=false        # pure local-mock, no server required
//    VITE_SIGNAL_HTTP_URL=https://host   # explicit host (wins over any default)
//    VITE_SIGNAL_WS_URL=wss://host/ws

interface SignalConfig {
  useRemote: boolean
  httpUrl: string
  wsUrl: string
}

const LOCAL_HTTP = 'http://localhost:8787'
const LOCAL_WS = 'ws://localhost:8787/ws'
// The deployed signal server. This is the FALLBACK used when a build does not
// set VITE_SIGNAL_HTTP_URL. It must point at a host that actually exists: the
// old default api.focusbuddy.app was never deployed, so any build that missed
// the env var (the Windows CI build did) could not reach the server at all and
// signup/login failed with "can't connect". When api.focusbuddy.app is set up
// as a DNS alias to this host, this can move back to it.
const PROD_HTTP = 'https://focusbuddy-signal.fly.dev'
const PROD_WS = 'wss://focusbuddy-signal.fly.dev/ws'

// Sanitize a URL from a build-time env var: trim, and take only the first
// whitespace-delimited token. This guards against an env-quoting glitch at build
// time that could concatenate several VITE_ values into one (e.g. the http URL
// ending up as "https://host VITE_SIGNAL_WS_URL=wss://..."). A URL with spaces
// makes every fetch throw and looks exactly like the server being unreachable,
// so we defend against it here rather than trust the build to be perfect.
function firstUrl(v: string | undefined, fallback: string): string {
  const first = (v ?? '').trim().split(/\s+/)[0]
  return first || fallback
}

function readEnv(): SignalConfig {
  const explicit = import.meta.env.VITE_USE_REMOTE_SIGNAL
  let useRemote: boolean
  if (explicit === 'true') useRemote = true
  else if (explicit === 'false') useRemote = false
  else {
    // No explicit override → use the real server in BOTH dev and prod.
    // The dev server runs on localhost:8787; the prod server runs on
    // whatever VITE_SIGNAL_HTTP_URL points at when the app is built.
    useRemote = true
  }
  // Default to the deployed server in every build. Local development against a
  // local signal server is opt-in via VITE_USE_LOCAL_SIGNAL=true (or by setting
  // VITE_SIGNAL_HTTP_URL directly, which overrides this default either way).
  const wantLocal = import.meta.env.VITE_USE_LOCAL_SIGNAL === 'true'
  const defaultHttp = wantLocal ? LOCAL_HTTP : PROD_HTTP
  const defaultWs = wantLocal ? LOCAL_WS : PROD_WS
  const httpUrl = firstUrl(import.meta.env.VITE_SIGNAL_HTTP_URL as string | undefined, defaultHttp)
  const wsUrl = firstUrl(import.meta.env.VITE_SIGNAL_WS_URL as string | undefined, defaultWs)
  return { useRemote, httpUrl, wsUrl }
}

export const signalConfig: SignalConfig = readEnv()

/**
 * Where the browser app lives, for building links that open it.
 *
 * A claim link is only useful if the person receiving it can reach the page it
 * points at, which makes this a deployment fact rather than a code one -- hence
 * the build-time override. Empty means no cloud app has been published yet, and
 * callers should say so rather than mint a link to nowhere: a share link that
 * 404s is worse than no share button, because the sender does not find out.
 */
export function cloudAppUrl(): string {
  const raw = (import.meta.env.VITE_CLOUD_APP_URL as string | undefined) ?? ''
  return raw.trim().replace(/\/+$/, '')
}
