// plexii:// deep-link auth handoff (plexii:// still accepted).
//
// Flow:
//   1. User signs in or signs up at https://www.plexiidesk.com/account/login.
//   2. Brochure POSTs to signal-server /accounts/login, receives a session
//      token + account row.
//   3. Brochure renders an "Open in Plexii" button that links to
//      plexii://auth?token=<sessionToken>&email=<email>&handle=<handle>.
//   4. macOS routes that URL to this app (or launches it first), and the
//      handlers below capture the token and forward it to the renderer
//      over IPC as the `auth:incoming-token` event.
//   5. The renderer stores the session, but only without a question when the
//      link brought back the state of a sign-in THIS app started
//      (signInNonce.ts). Any other link is asked about first, naming the
//      account the server says the token belongs to (App.tsx).
//
// Two entry points to handle:
//   - "open-url" event (the user clicks the link while the app is running)
//   - process.argv on startup (the user clicks the link before the app is
//     running and macOS launches it with the URL appended to argv)
//   - "second-instance" (the user clicks the link while the app is already
//     running and macOS spawns a second instance — we forward argv from
//     there too)
//
// All of these route through `handleAuthUrl`, which validates the URL and
// fans out a single IPC message to every BrowserWindow.

import { app, BrowserWindow } from 'electron'
import { ALL_DEEP_LINK_SCHEMES, isDeepLinkArg, isKnownDeepLinkProtocol } from '@shared/deepLink'
import { parseDeskHandoffLink } from '@shared/deskHandoff'
import { receiveDeskHandoff } from './deskHandoffReceiver'
import { parseLiteRoomLink } from '@shared/liteRoom'
import { receiveLiteRoom } from './liteRoomReceiver'
import { consumeSignIn, consumeSignInNonce } from './signInNonce'
import { parseAuthLink, type AuthLink, type AuthNotice } from '@shared/authLink'
import { redeemSignInCode } from './authCodeRedeem'

// Named in shared/deepLink.ts, because the renderer generates these links too
// and the two must not drift. See that file for why both schemes are answered
// and only one is generated.
const ALL_SCHEMES = ALL_DEEP_LINK_SCHEMES
const hasKnownScheme = isKnownDeepLinkProtocol

export interface AuthHandoff {
  sessionToken: string
  /** What the LINK claims. Anyone can write a link: never shown, never trusted. */
  email: string | null
  handle: string | null
  // Where the auth came from — useful for analytics + debug.
  origin: 'open-url' | 'argv' | 'second-instance'
  /**
   * Decided here, never read from the URL: the link brought back a state this
   * app made for a sign-in it started (signInNonce.ts), unused and unexpired.
   * Only then may the renderer adopt it without asking.
   */
  startedHere: boolean
}

let pending: AuthHandoff | null = null
// A share deep link (plexii://share?token=...) that arrived before a window was
// ready. Drained by the renderer on load, same pattern as the auth handoff.
let pendingShareToken: string | null = null
// A meeting-join deep link (plexii://meet?room=...) from a meeting invite email,
// same drain-on-ready pattern.
let pendingMeetRoom: string | null = null

// Auth links are parsed in shared/authLink.ts (a session token, a one-time
// code, the website's Cancel, or /start). The renderer never sees a code.

// plexii://share?token=<shareToken> — the "Open in PlexiDesk" link from the
// share-notification email. Returns the share token to hand to the renderer,
// which accepts it into the workspace and opens it.
function parseShareUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!hasKnownScheme(parsed.protocol) || parsed.host !== 'share') return null
    return parsed.searchParams.get('token')
  } catch {
    return null
  }
}

function broadcastShare(shareToken: string) {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) {
    pendingShareToken = shareToken
    return
  }
  for (const win of wins) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('share:incoming-token', shareToken)
      } catch {
        /* renderer still loading; it drains via share:get-pending on ready */
      }
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

export function consumePendingShareToken(): string | null {
  const t = pendingShareToken
  pendingShareToken = null
  return t
}

// plexii://meet?room=<roomId> — the "Join the meeting" link from a meeting
// invite email. Returns the room id for the renderer to join.
function parseMeetUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!hasKnownScheme(parsed.protocol) || parsed.host !== 'meet') return null
    return parsed.searchParams.get('room')
  } catch {
    return null
  }
}

// plexii://edit-md?path=<absolute .md path> — open an external markdown
// document (an ops-console artifact) in the PlexiDocs editor (ws-v-3). The
// path is only a REQUEST here; the mdext IPC layer enforces the allowed root.
let pendingMdEditPath: string | null = null

function parseEditMdUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!hasKnownScheme(parsed.protocol) || parsed.host !== 'edit-md') return null
    return parsed.searchParams.get('path')
  } catch {
    return null
  }
}

function broadcastMdEdit(path: string) {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) {
    pendingMdEditPath = path
    return
  }
  for (const win of wins) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('mdext:incoming-path', path)
      } catch {
        /* renderer still loading; it drains via mdext:get-pending on ready */
      }
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

export function consumePendingMdEditPath(): string | null {
  const p = pendingMdEditPath
  pendingMdEditPath = null
  return p
}

function broadcastMeet(roomId: string) {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) {
    pendingMeetRoom = roomId
    return
  }
  for (const win of wins) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('meet:incoming-room', roomId)
      } catch {
        /* renderer still loading; it drains via meet:get-pending on ready */
      }
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

export function consumePendingMeetRoom(): string | null {
  const r = pendingMeetRoom
  pendingMeetRoom = null
  return r
}

function broadcast(handoff: AuthHandoff) {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) {
    // No window yet — stash it; the renderer will pull on ready.
    pending = handoff
    return
  }
  for (const win of wins) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('auth:incoming-token', handoff)
      } catch {
        // Renderer might still be loading; the renderer requests
        // `auth:get-pending` on ready as a fallback.
      }
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

// ── Auth step 2 (2026-11-20): one-time codes, Cancel, /start ────────────────

// What the window is told that is not a sign-in: a link refused, or "begin a
// sign-in". Kept until a window takes them (a link can launch the app).
let pendingNotices: AuthNotice[] = []
/** A page can open /start as often as it likes: one sign-in begun per this long. */
const START_COOLDOWN_MS = 30_000
let lastStartAt = -Infinity
// States whose sign-in just finished. The website sends a fresh code on each
// press of Continue, so a second press brings a second link for a state already
// used: nothing to redeem, and nothing to warn about on top of a sign-in that
// worked. Ten minutes, a handful at most.
const finished = new Map<string, number>()
const FINISHED_TTL_MS = 10 * 60_000
function rememberFinished(state: string, now: number): void {
  for (const [s, exp] of finished) if (exp <= now) finished.delete(s)
  while (finished.size >= 16) finished.delete(finished.keys().next().value as string)
  finished.set(state, now + FINISHED_TTL_MS)
}

function notify(notice: AuthNotice): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length === 0) {
    pendingNotices.push(notice)
    return
  }
  let told = false
  for (const win of wins) {
    try {
      win.webContents.send('auth:notice', notice)
      told = true
    } catch {
      // Still loading: it takes what is waiting (auth:take-notices) when ready.
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  if (!told) pendingNotices.push(notice)
}

/** The window takes every notice waiting, once each. */
export function takeAuthNotices(): AuthNotice[] {
  const taken = pendingNotices
  pendingNotices = []
  return taken
}

export async function handleAuthLink(link: AuthLink, origin: AuthHandoff['origin'], now: number = Date.now()): Promise<void> {
  switch (link.kind) {
    case 'token':
      // The legacy link. Any page can open it: only a sign-in this app started
      // (its state comes back) is adopted without a question; the renderer asks
      // about the rest, naming the account the server says the token is.
      broadcast({ sessionToken: link.sessionToken, email: link.email, handle: link.handle, origin, startedHere: consumeSignInNonce(link.state, now) })
      return
    case 'code': {
      // Only a sign-in this app started has the verifier the code needs. Any
      // other code link (cold, from someone else, expired, already used) is
      // refused here, before any network call: it can't be redeemed anyway.
      const started = consumeSignIn(link.state, now)
      if (!started || !link.code) {
        // A second press of Continue for a sign-in that just worked: quiet.
        if (!started && link.state && (finished.get(link.state) ?? 0) > now) return
        notify({ kind: 'link-refused', why: 'not-started' })
        return
      }
      await app.whenReady()
      // Exactly once: a code is spent by its first attempt.
      const r = await redeemSignInCode(link.code, started.verifier)
      if (!r.ok) {
        notify({ kind: 'link-refused', why: r.why })
        return
      }
      // A fresh desktop session for the sign-in this app started: adopted without a question.
      rememberFinished(link.state!, now)
      broadcast({ sessionToken: r.sessionToken, email: r.email, handle: r.handle, origin, startedHere: true })
      return
    }
    case 'error':
      // The person pressed Cancel on the website. Spend the state; nothing to say.
      consumeSignIn(link.state, now)
      return
    case 'start':
      // "Begin a sign-in", from the website's cold button. Any page can open it,
      // so the window decides: only when nobody is signed in, never switching
      // accounts. And not again within the cooldown.
      if (now - lastStartAt < START_COOLDOWN_MS) return
      lastStartAt = now
      notify({ kind: 'start' })
      return
  }
}

/** Tests: forget waiting notices and the /start cooldown. */
export function _resetAuthLinksForTests(): void {
  pendingNotices = []
  lastStartAt = -Infinity
  finished.clear()
}

function handleAuthUrl(url: string, origin: AuthHandoff['origin']) {
  const link = parseAuthLink(url)
  if (link) {
    void handleAuthLink(link, origin)
    return
  }
  // Also route share deep links (plexii://share?token=...) from the share
  // notification email so an existing user can open the shared item in-app.
  const shareToken = parseShareUrl(url)
  if (shareToken) {
    broadcastShare(shareToken)
    return
  }
  // And "Download this desk on Plexii" (plexii://desk?handoff=...) from a
  // public share page: a visitor's copy of a desk, kept until someone is
  // signed in to claim it (deskHandoffReceiver.ts).
  const handoffId = parseDeskHandoffLink(url)
  if (handoffId) {
    receiveDeskHandoff(handoffId)
    return
  }
  // And "Open This Room in Plexii" (plexii://lite-room?id=...) from PlexiiLite:
  // a room it described in its own data folder, kept until someone is signed in,
  // then read and ASKED about -- never brought in by the link alone
  // (liteRoomReceiver.ts).
  const liteRoomId = parseLiteRoomLink(url)
  if (liteRoomId) {
    receiveLiteRoom(liteRoomId)
    return
  }
  // And meeting-join links (plexii://meet?room=...) from an invite email.
  const meetRoom = parseMeetUrl(url)
  if (meetRoom) {
    broadcastMeet(meetRoom)
    return
  }
  // And external-markdown edit links from the ops console (ws-v-3).
  const mdPath = parseEditMdUrl(url)
  if (mdPath) broadcastMdEdit(mdPath)
}

// Called from main/ipc.ts handler so the renderer can drain anything
// that arrived before the window was ready.
export function consumePendingAuthHandoff(): AuthHandoff | null {
  const p = pending
  pending = null
  return p
}

export function registerDeepLinkProtocol(opts: { claimProtocol?: boolean } = {}) {
  const { claimProtocol = true } = opts
  // Ask macOS / Windows to route plexii:// URLs to this binary.
  // In dev (electron-vite) the running binary is `node_modules/electron/.../Electron`
  // which doesn't survive a restart — the brochure flow only works end-to-end
  // from a packaged build. The registration is still safe to call in dev.
  // Skipped for PlexiOffice (claimProtocol=false): two apps can't both own the
  // scheme, and it belongs to PlexiDesk's auth handoff.
  if (claimProtocol) {
    // Register the legacy scheme too, or an existing plexii:// link stops
    // opening the app the moment a user updates.
    for (const scheme of ALL_SCHEMES) {
      if (process.defaultApp && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(scheme, process.execPath, [process.argv[1]])
      } else {
        app.setAsDefaultProtocolClient(scheme)
      }
    }
  }

  // macOS — the canonical event for deep links once the app is running.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleAuthUrl(url, 'open-url')
  })

  // Windows / Linux — second-instance fires when the OS tries to spawn
  // another copy of the app to handle a URL. The URL is the last arg.
  // We forward it instead of letting a second copy launch.
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(isDeepLinkArg)
    if (url) handleAuthUrl(url, 'second-instance')
  })

  // Cold-start case — the app was launched by clicking a plexii:// link.
  // On macOS this comes through open-url after whenReady; on Windows it
  // shows up in argv. Both branches are handled.
  const argvUrl = process.argv.find(isDeepLinkArg)
  if (argvUrl) {
    // Defer until whenReady so any window can receive the broadcast.
    app.whenReady().then(() => handleAuthUrl(argvUrl, 'argv'))
  }
}
