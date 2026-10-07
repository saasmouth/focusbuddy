// haptyx:// deep-link auth handoff.
//
// Flow:
//   1. User signs in or signs up at https://haptyx.app/account/login.
//   2. Brochure POSTs to signal-server /accounts/login, receives a session
//      token + account row.
//   3. Brochure renders an "Open in Plexii" button that links to
//      haptyx://auth?token=<sessionToken>&email=<email>&handle=<handle>.
//   4. macOS routes that URL to this app (or launches it first), and the
//      handlers below capture the token and forward it to the renderer
//      over IPC as the `auth:incoming-token` event.
//   5. The renderer stores the session and treats the user as signed in.
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

const SCHEME = 'haptyx'

export interface AuthHandoff {
  sessionToken: string
  email: string | null
  handle: string | null
  // Where the auth came from — useful for analytics + debug.
  origin: 'open-url' | 'argv' | 'second-instance'
}

let pending: AuthHandoff | null = null
// A share deep link (haptyx://share?token=...) that arrived before a window was
// ready. Drained by the renderer on load, same pattern as the auth handoff.
let pendingShareToken: string | null = null
// A meeting-join deep link (haptyx://meet?room=...) from a meeting invite email,
// same drain-on-ready pattern.
let pendingMeetRoom: string | null = null

function parseHaptyxUrl(url: string): Omit<AuthHandoff, 'origin'> | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${SCHEME}:`) return null
    // Expect haptyx://auth?token=... The host portion is the "action".
    if (parsed.host !== 'auth') return null
    const token = parsed.searchParams.get('token')
    if (!token) return null
    return {
      sessionToken: token,
      email: parsed.searchParams.get('email'),
      handle: parsed.searchParams.get('handle')
    }
  } catch {
    return null
  }
}

// haptyx://share?token=<shareToken> — the "Open in PlexiDesk" link from the
// share-notification email. Returns the share token to hand to the renderer,
// which accepts it into the workspace and opens it.
function parseShareUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${SCHEME}:` || parsed.host !== 'share') return null
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

// haptyx://meet?room=<roomId> — the "Join the meeting" link from a meeting
// invite email. Returns the room id for the renderer to join.
function parseMeetUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${SCHEME}:` || parsed.host !== 'meet') return null
    return parsed.searchParams.get('room')
  } catch {
    return null
  }
}

// haptyx://edit-md?path=<absolute .md path> — open an external markdown
// document (an ops-console artifact) in the PlexiDocs editor (ws-v-3). The
// path is only a REQUEST here; the mdext IPC layer enforces the allowed root.
let pendingMdEditPath: string | null = null

function parseEditMdUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${SCHEME}:` || parsed.host !== 'edit-md') return null
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

function handleAuthUrl(url: string, origin: AuthHandoff['origin']) {
  const parsed = parseHaptyxUrl(url)
  if (parsed) {
    broadcast({ ...parsed, origin })
    return
  }
  // Also route share deep links (haptyx://share?token=...) from the share
  // notification email so an existing user can open the shared item in-app.
  const shareToken = parseShareUrl(url)
  if (shareToken) {
    broadcastShare(shareToken)
    return
  }
  // And meeting-join links (haptyx://meet?room=...) from an invite email.
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

export function registerHaptyxAuthProtocol(opts: { claimProtocol?: boolean } = {}) {
  const { claimProtocol = true } = opts
  // Ask macOS / Windows to route haptyx:// URLs to this binary.
  // In dev (electron-vite) the running binary is `node_modules/electron/.../Electron`
  // which doesn't survive a restart — the brochure flow only works end-to-end
  // from a packaged build. The registration is still safe to call in dev.
  // Skipped for PlexiOffice (claimProtocol=false): two apps can't both own the
  // scheme, and it belongs to PlexiDesk's auth handoff.
  if (claimProtocol) {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(SCHEME, process.execPath, [process.argv[1]])
    } else {
      app.setAsDefaultProtocolClient(SCHEME)
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
    const url = argv.find((arg) => arg.startsWith(`${SCHEME}://`))
    if (url) handleAuthUrl(url, 'second-instance')
  })

  // Cold-start case — the app was launched by clicking a haptyx:// link.
  // On macOS this comes through open-url after whenReady; on Windows it
  // shows up in argv. Both branches are handled.
  const argvUrl = process.argv.find((arg) => arg.startsWith(`${SCHEME}://`))
  if (argvUrl) {
    // Defer until whenReady so any window can receive the broadcast.
    app.whenReady().then(() => handleAuthUrl(argvUrl, 'argv'))
  }
}
