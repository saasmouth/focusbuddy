import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, MenuItem, protocol, session, shell, net } from 'electron'
import { join, resolve as resolvePath, sep } from 'path'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { config as loadEnv } from 'dotenv'
import { closeDb, getDb } from './db/database'
import { composeCustomWidgetDocument, cspFor } from '@shared/customWidgetSandbox'
import { resolveWidgetInputs } from './db/widgetInputs'
import { markUiVisible } from './db/account'
import { runRetentionSweep } from './db/retention'
import { autoBackupOnLaunch } from './db/backup'
import { registerIpcHandlers } from './ipc'
import { startCalendarSyncLoop } from './calendar/sync'
import { registerMdExternal } from './mdExternal'
import { decidePopup } from './popupRouter'
import { isAgentDrivenWc } from './ai/browserActions'
import { cleanWebviewUserAgent } from './userAgent'
import { getFile } from './db/files'
import { installFocusTracker } from './streamdeckActions'
import { installActivityTracker } from './activityTracker'
import { registerHaptyxAuthProtocol } from './authProtocol'
import { installAutoUpdater, checkForUpdates } from './autoUpdate'
import { detectOfficeBuild, detectPreviewBuild } from './appMode'
import { runDueFlows } from './db/flows'
import { sweepDocumentChunks, sweepWidgetChunks, sweepChatChunks, sweepFileChunks } from './chunkIndex'
import { sweepDocumentEnrichment, sweepDocumentMemory, sweepEmbeddings } from './ai/localAiSweeps'
import { runDueReports } from './db/reports'
import { installMainCrashHandlers, recordCrash } from './db/crashLog'
import { installIpcErrorBoundary } from './ipc/errorBoundary'
import { startNotificationScheduler } from './notifications/scheduler'

// Capture uncaught errors + unhandled rejections from the main process before
// anything else runs, so a startup failure is recorded instead of lost. The
// handlers only touch the DB when a crash actually fires, by which point it is
// ready, so installing this early is safe.
installMainCrashHandlers()

// Wrap every invoke handler registered from here on, so a handler that lets a
// raw error escape cannot hand the renderer a database error, a filesystem
// errno, or a main-process stack trace. Must run before registerIpcHandlers()
// and before any module registers a channel of its own.
installIpcErrorBoundary()

// Load .env for dev/prod, but NOT under the Playwright harness (FB_TEST_USER_DATA):
// the e2e suite strips API keys from the launch env to stay hermetic, and loading a
// developer's local .env from disk here would silently defeat that and make real,
// billable AI calls. A deliberate live test passes its keys in the launch env, which
// this guard leaves untouched.
if (!process.env.FB_TEST_USER_DATA) {
  loadEnv({ path: join(app.getAppPath(), '.env') })
  loadEnv({ path: join(app.getAppPath(), '..', '.env') })
}

// Test-isolation hook: when running under Playwright we want a throwaway
// userData (separate DB, separate cookies) so tests don't touch the developer's
// real FocusBuddy data. Must be set BEFORE app.whenReady() so getPath('userData')
// picks up the override on first access.
// Which product is this binary? See detectOfficeBuild for why app.getName() alone
// is not enough. Set the app name early so getName(), the menu, the renderer
// selection, and the default paths are all office-correct from here on.
const isOfficeBuild = detectOfficeBuild({
  plexiAppEnv: process.env['PLEXI_APP'],
  execPath: process.execPath,
  appName: app.getName()
})
if (isOfficeBuild) app.setName('PlexiOffice')

const isPreviewBuild =
  !isOfficeBuild &&
  detectPreviewBuild({
    plexiAppEnv: process.env['PLEXI_APP'],
    execPath: process.execPath,
    appName: app.getName()
  })
if (isPreviewBuild) app.setName('PlexiDesk 3 Preview')

if (process.env.FB_TEST_USER_DATA) {
  app.setPath('userData', process.env.FB_TEST_USER_DATA)
} else if (isPreviewBuild) {
  // The preview build ALWAYS gets its own userData directory — packaged AND
  // dev — so it can never open the production install's database (which the
  // legacy-Haptyx pinning below would otherwise hand it) and never contends
  // for its single-instance lock. Delete this directory to reset the preview.
  app.setPath('userData', join(app.getPath('appData'), 'PlexiDesk3Preview'))
} else if (isOfficeBuild) {
  // PlexiOffice gets its OWN userData directory. Without this it inherits
  // PlexiDesk's directory and therefore PlexiDesk's single-instance lock, so
  // launching it while PlexiDesk is open makes it quit immediately (~0.5s). The
  // two apps share documents through the cloud-documents API, not a shared local
  // database, so a separate local cache is exactly right.
  app.setPath('userData', join(app.getPath('appData'), 'PlexiOffice'))
} else if (app.isPackaged) {
  // Data-safe rename: the app was renamed Haptyx → PlexiDesk, which would
  // otherwise move userData from "…/Application Support/Haptyx" to "…/PlexiDesk"
  // and orphan every existing user's database, vault and settings. So if the
  // legacy Haptyx data directory exists, keep using it in place (no copy, no
  // move — zero risk). Fresh installs (no legacy dir) use the default PlexiDesk
  // directory. Cross-platform: getPath('appData') is the per-user app-data root
  // on macOS and Windows alike. Must run BEFORE app.whenReady()/getDb().
  try {
    const legacyUserData = join(app.getPath('appData'), 'Haptyx')
    if (existsSync(legacyUserData)) {
      app.setPath('userData', legacyUserData)
    }
  } catch {
    // If anything goes wrong, fall through to the default path rather than crash.
  }
}

// Register `fb-file://` as a privileged custom protocol so renderers can use it
// in <img>, <video>, <audio>, <iframe>, and CSS background-image. Must happen
// BEFORE app.whenReady() per Electron's protocol-registration rules.
//
// Behaviour: `fb-file://<file-id>` resolves to the on-disk path of the file
// stored under userData/files/. We deliberately don't expose the absolute path
// to the renderer — the protocol is the single source of truth so we can swap
// storage later without touching consumers.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'fb-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true, // enables range requests for videos / PDFs
      bypassCSP: true
    }
  },
  // `fb-dev://` is a development-only protocol that serves files from the
  // project's `Mock Videos/` directory (and could serve other mock assets
  // later). It's registered unconditionally — same privilege set as
  // fb-file so video streaming works — but the protocol.handle() below is
  // only wired in dev. In a packaged build the scheme exists but never
  // resolves, so production behaviour is safe.
  {
    scheme: 'fb-dev',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  },
  // `fb-widget://<widget-id>/` serves one AI-built Custom widget's document.
  //
  // This exists because of a measured failure, not a preference. The obvious
  // implementation -- an <iframe srcdoc> holding the generated document -- does
  // not work: `about:srcdoc` is a local scheme, so it INHERITS the embedding
  // page's CSP, and this app's renderer runs under `script-src 'self'`. The
  // widget's markup rendered and every line of its JavaScript was refused. A
  // custom scheme gives the document a real origin of its own, so the only
  // policy that applies is the one served with it.
  //
  // `standard` is what makes it a real origin; `bypassCSP` lets the renderer's
  // own `default-src 'self'` frame it. The document is still loaded into an
  // iframe sandboxed WITHOUT allow-same-origin, so it stays on an opaque origin
  // with no reach into this app's storage, DOM or preload bridge -- the scheme
  // changes where the document comes from, never what it is allowed to touch.
  {
    scheme: 'fb-widget',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      stream: false,
      bypassCSP: true
    }
  }
])

const isDev = !app.isPackaged

// ── Permission hardening ──────────────────────────────────────────────────
// By default Electron AUTO-GRANTS every permission a page requests. Because we
// embed arbitrary third-party websites in <webview> browser widgets, that means
// any loaded page could silently obtain geolocation, WebHID / WebSerial /
// WebUSB device access, MIDI-sysex, etc. We install a denylist for the
// genuinely dangerous device/location permissions while leaving the ones the
// app actually uses (media for voice/video notes, notifications, clipboard,
// fullscreen) granted. Applied to the default session (main renderer) AND to
// every <webview> session in web-contents-created below.
const DENIED_PERMISSIONS = new Set<string>([
  'geolocation',
  'hid',
  'serial',
  'usb',
  'midiSysex',
  'idle-detection',
  'speaker-selection'
])

function applyPermissionPolicy(ses: Electron.Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => !DENIED_PERMISSIONS.has(permission))
}

// Screen sharing (PlexiMeet "Share screen" / collaborative screen-share mode).
// Electron does NOT wire navigator.mediaDevices.getDisplayMedia by default, so a
// call from the renderer rejects unless a display-media request handler is set.
// We prefer the OS-native source picker where the platform has one (macOS 15+,
// Windows), which lets the user choose a specific screen or window. Where no
// system picker exists we fall back to the primary screen so the feature still
// works rather than throwing. Screen recording itself is still gated by the OS
// permission prompt, which is the honest place for that consent to live.
// M6 (SPEC-003 P6, G1) — guest capture arms ONE display-media grant that
// bypasses the system picker: primary screen + system-audio loopback
// (ScreenCaptureKit under Electron ≥31). Armed per-request over IPC and
// disarmed the moment it fires, so screen SHARE keeps the native picker and
// nothing else can ride the no-picker path. The video track is a vehicle —
// the renderer stops it immediately; only the loopback audio is kept. On a
// platform where loopback is unsupported the stream simply arrives with no
// audio track, and the renderer degrades to mic-only ("Plexii can hear you,
// not them") rather than pretending.
let guestCaptureArmed = false
let displayMediaSession: Electron.Session | null = null

ipcMain.handle('guestCapture:arm', () => {
  guestCaptureArmed = true
  if (displayMediaSession) applyDisplayMediaHandler(displayMediaSession)
  return true
})

function applyDisplayMediaHandler(ses: Electron.Session): void {
  displayMediaSession = ses
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      const forGuestCapture = guestCaptureArmed
      guestCaptureArmed = false
      desktopCapturer
        .getSources({ types: ['screen', 'window'] })
        .then((sources) => {
          // Guest capture — or platforms without a system picker: default to
          // the whole primary screen. For a share that is what "share my
          // screen" means; for guest capture the screen is only the loopback
          // vehicle. The user can stop from the in-app control either way.
          const primary = sources.find((s) => s.id.startsWith('screen:')) ?? sources[0]
          if (primary) callback(forGuestCapture ? { video: primary, audio: 'loopback' } : { video: primary })
          else callback({})
          // Restore the picker path once an armed grant has fired.
          if (forGuestCapture) applyDisplayMediaHandler(ses)
        })
        .catch(() => {
          callback({})
          if (forGuestCapture) applyDisplayMediaHandler(ses)
        })
    },
    // An armed request must reach the handler, so the system picker steps
    // aside for exactly that one grant.
    { useSystemPicker: !guestCaptureArmed }
  )
}

// Register haptyx:// before whenReady so the OS knows we own the
// protocol scheme. Also handles second-instance / open-url events for
// the web→desktop auth handoff. See authProtocol.ts.
// PlexiOffice must not claim the haptyx:// scheme — only one app can own it, and
// it belongs to PlexiDesk's web→desktop auth handoff. PlexiOffice still takes its
// own single-instance lock (on its own userData) inside this call.
// The preview must not steal haptyx:// deep links from the production install.
registerHaptyxAuthProtocol({ claimProtocol: !isOfficeBuild && !isPreviewBuild })

// Send a zoom command to the focused window's renderer, which owns the app-wide
// UI scale (lib/uiScale.ts). Driving zoom from the menu this way keeps the
// keyboard shortcuts, the View menu and the Settings control all in sync on a
// single stored value, instead of Chromium's separate zoom-level roles which
// don't touch that value (the reason Cmd +/- appeared to do nothing before).
function sendZoom(dir: 'in' | 'out' | 'reset'): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('app:zoom', dir)
}

// Build the application menu. There was previously no explicit menu, so the app
// ran on Electron's default, whose View-menu zoom roles were never wired to the
// app's own scale. This template restores the standard menus (so copy/paste,
// window and quit behave exactly as before) and adds a View menu whose Zoom
// items drive the app scale, with accelerators so Cmd +, Cmd - and Cmd 0 work.
function buildAppMenu(): Electron.Menu {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CommandOrControl+=', click: () => sendZoom('in') },
        // Also fire on the shifted "+" and the numeric-keypad plus, which some
        // users press. Hidden so the menu shows a single Zoom In item.
        { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', visible: false, click: () => sendZoom('in') },
        { label: 'Zoom In', accelerator: 'CommandOrControl+numadd', visible: false, click: () => sendZoom('in') },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => sendZoom('out') },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+numsub', visible: false, click: () => sendZoom('out') },
        { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => sendZoom('reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev
          ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }]
          : [])
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => checkForUpdates()
        },
        { type: 'separator' },
        // These three used to sit in a permanent footer on every screen,
        // carrying nothing anybody needs while working. On macOS reference
        // material lives in the menu bar, so that is where they are now.
        {
          label: 'Help & Support',
          click: () => {
            void shell.openExternal('https://plexii.app/help')
          }
        },
        {
          label: "What's New",
          click: () => {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('app:show-whats-new')
            }
          }
        },
        {
          label: 'Terms of Use',
          click: () => {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('app:show-terms')
            }
          }
        }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}

function createCommandCenter(): BrowserWindow {
  // The window stays opaque. Live-mirror widgets render desktopCapturer
  // screenshots in the canvas (cheap, no recording indicator at rest); the
  // user clicks "expand" to push the real native window to the foreground for
  // interactivity. Both modes — screenshot and expanded — are simpler and
  // more reliable than the mix-blend-mode punch-through approach we tried
  // first, which couldn't escape the canvas's CSS-transform stacking context.
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: 'PlexiDesk',
    backgroundColor: '#fbf7ee',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Centre the macOS traffic lights vertically within the 40px (h-10) header
    // and inset them from the left, so they align with the header controls and
    // the renderer can reserve a matching left gap (see isMac padding in App).
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 13 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    markUiVisible()
  })

  // DEC-060 — safety-net reveal. `ready-to-show` fires when the renderer has
  // painted its first frame; if it never does, a window created with
  // show:false stays invisible forever and the app looks dead with no clue why.
  // Showing it anyway after a grace period turns a silent failure into a
  // visible one you can actually debug.
  //
  // Honest about the limit: this is a timer, so it cannot rescue a BLOCKED main
  // thread — nothing fires then. It covers the renderer-side half. The
  // main-thread half is prevented at the source by keeping the boot path off
  // the OS keychain (see db/account.ts).
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      console.warn('[window] ready-to-show never fired after 10s — revealing anyway (DEC-060)')
      win.show()
      markUiVisible()
    }
  }, 10_000)

  win.webContents.setWindowOpenHandler((details) => {
    // Validate the scheme before handing the URL to the OS. Content rendered in
    // the trusted main renderer (a shared document, imported markdown, AI
    // output) could otherwise open a dangerous scheme (file:, smb:, ms-msdt:)
    // via a target=_blank link. Mirrors the will-navigate guard below.
    let ok = false
    try {
      const p = new URL(details.url).protocol
      ok = p === 'http:' || p === 'https:' || p === 'mailto:'
    } catch {
      ok = false
    }
    if (ok) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // The app shell never navigates its own top frame. If a dropped tab/link or
  // an errant click tries to navigate the host window to another origin (the
  // classic "drop a URL and it replaces your whole app" failure), block it and
  // open it in the user's browser instead. Webview widgets are separate
  // webContents and are unaffected by this guard.
  win.webContents.on('will-navigate', (e, url) => {
    // The app shell must NEVER navigate its own top frame. Real in-app
    // navigation is React state and never fires will-navigate, so anything that
    // does fire here is an errant link, drag-drop or redirect. Crucially this
    // includes SAME-ORIGIN navigations: a link that resolves to a bundle asset
    // (e.g. /assets/index-*.js) would otherwise load that file and Chromium
    // would render the raw minified source as plain text in the window. Block
    // every navigation; send genuine web links to the user's browser instead.
    const current = win.webContents.getURL()
    if (url === current) return // reloading the shell to itself is fine
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // Which product is this build? The PlexiOffice electron-builder config sets
  // productName 'PlexiOffice' (→ app.getName()); PLEXI_APP=office forces it in dev.
  // PlexiOffice loads its own renderer entry; everything else is PlexiDesk.
  const officeMode =
    process.env['PLEXI_APP'] === 'office' || app.getName().toLowerCase().includes('office')
  const rendererHtml = officeMode ? 'plexioffice.html' : 'index.html'

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${officeMode ? 'plexioffice.html' : ''}`)
    win.webContents.once('did-finish-load', () => {
      win.webContents.openDevTools({ mode: 'detach' })
    })
    // Mirror the renderer's [voice] trace to the main-process stdout (dev only)
    // so `npm run dev > log` captures the whole voice flow without anyone
    // needing to open DevTools. Temporary diagnostic.
    win.webContents.on('console-message', (_e, _level, message) => {
      if (typeof message === 'string' && message.includes('[voice]')) {
        // eslint-disable-next-line no-console
        console.log('[renderer]', message)
      }
    })
  } else {
    win.loadFile(join(__dirname, `../renderer/${rendererHtml}`))
  }

  // Capture a renderer/GPU process death (WS03). This is the most severe crash
  // class: the window goes blank or closes, and the renderer's own JS error
  // handlers never fire, so it was previously invisible. Record it (in the main
  // process, which survives) so the reason is not lost.
  win.webContents.on('render-process-gone', (_e, details) => {
    recordCrash({
      source: 'main',
      kind: 'render-process-gone',
      message: `renderer ${details.reason}${typeof details.exitCode === 'number' ? ` (exit ${details.exitCode})` : ''}`
    })
    // eslint-disable-next-line no-console
    console.error('[crash] render-process-gone', details)
  })
  win.on('unresponsive', () => {
    recordCrash({ source: 'main', kind: 'unresponsive', message: 'the window stopped responding' })
    // eslint-disable-next-line no-console
    console.error('[crash] window unresponsive')
  })

  return win
}

app.on('web-contents-created', (_, contents) => {
  // ── <webview> attach policy ─────────────────────────────────────────────
  // The moment a <webview> attaches is the only point its privileges can still
  // be changed, and the preferences arrive from the PAGE. Anything script in the
  // renderer could set — a preload of its own choosing, Node integration — is
  // stripped here rather than trusted: without this, script that reaches the
  // renderer can attach a <webview> carrying its own preload and escape the
  // sandbox entirely.
  //
  // This fires on the HOST contents (the app's own renderer), which is why it is
  // registered above the webview-only guard below rather than inside it.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    // The app's own browser widgets never set a preload; only an attacker would.
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.webSecurity = true

    // Browser widgets legitimately load arbitrary web pages, so the scheme
    // allowlist stays deliberately wide. A guest loading from disk is the case
    // nothing in this app asks for and an attacker does.
    const src = String(params.src ?? '')
    if (src && /^(file|blob):/i.test(src)) {
      console.warn(`[webview] refused a guest loading from ${src.slice(0, 12)}`)
      event.preventDefault()
    }
  })

  // Only attach to <webview> tag contents — not the main window's React renderer
  if (contents.getType() !== 'webview') return

  // ── User-Agent + permissions ────────────────────────────────────────────
  // Present each browser widget as plain desktop Chrome (strip the Electron +
  // app-name tokens) so OAuth providers stop rejecting the embedded UA with
  // `disallowed_useragent`. Set on the webview's SESSION so popup windows that
  // share the session (see popupRouter) inherit the clean UA too. Also install
  // the permission denylist on this session so embedded sites can't grab
  // geolocation / WebHID / WebSerial / WebUSB. See userAgent.ts.
  try {
    const ses = contents.session
    ses.setUserAgent(cleanWebviewUserAgent(ses.getUserAgent()))
    applyPermissionPolicy(ses)
  } catch {
    // session unavailable on a torn-down contents — best effort
  }

  // ── Popup / OAuth handling ──────────────────────────────────────────────
  // OAuth providers (Google, GitHub, Microsoft, etc.) post their callback back
  // to `window.opener.postMessage` from the popup. If we deny the popup or open
  // it in a context that doesn't share the webview's session, the callback
  // either never fires or fails the cookie check.
  //
  // The fix: allow popups as real native windows AND tell Electron to use the
  // SAME session as the parent webview (so cookies/auth state are shared).
  // For plain target=_blank link clicks (disposition='foreground-tab' or
  // 'background-tab'), we deny here and forward the URL to the renderer so it
  // can spawn a new canvas widget — keeping the click-link-as-widget UX while
  // letting OAuth popups go native.
  contents.setWindowOpenHandler((details) => {
    // R29: while an agent run drives this webContents, nothing opens a
    // window outside the panel — popups (OAuth included: logins are the
    // human's) deny, and target=_blank forwards to navigate in place.
    if (isAgentDrivenWc(contents.id)) {
      const mainWin = BrowserWindow.getAllWindows()[0]
      if (/^https?:\/\//i.test(details.url)) {
        mainWin?.webContents.send('webview:link-clicked', {
          sourceWebContentsId: contents.id,
          url: details.url
        })
      }
      return { action: 'deny' }
    }
    const decision = decidePopup(details, {
      session: contents.session,
      parentWindow: BrowserWindow.getFocusedWindow() ?? undefined
    })
    if (decision.action === 'allow') {
      return {
        action: 'allow',
        // outlivesOpener MUST be true for OAuth. A sign-in popup routinely
        // outlives a navigation of the page that opened it (the opener often
        // redirects to a "signing you in…" URL, or reloads, the moment the popup
        // is launched). With outlivesOpener:false Electron destroys the popup the
        // instant the opener navigates, which aborts the OAuth handshake and
        // bounces the page back to where it started — exactly the "logging in
        // resets and reloads the original page" symptom. Keeping the popup alive
        // lets the provider finish and postMessage the callback back to the opener.
        outlivesOpener: true,
        overrideBrowserWindowOptions: decision.overrideBrowserWindowOptions
      }
    }
    if (decision.forwardToRenderer) {
      const mainWin = BrowserWindow.getAllWindows()[0]
      mainWin?.webContents.send('webview:link-clicked', {
        sourceWebContentsId: contents.id,
        url: decision.forwardToRenderer.url
      })
    }
    return { action: 'deny' }
  })

  contents.on('context-menu', (_event, params) => {
    // Editable fields keep a NATIVE menu so spellcheck suggestions, undo/redo,
    // cut/copy/paste, select-all, and password-manager autofill all behave as
    // the user expects inside the embedded browser. Replacing these with our own
    // menu would silently break them, which the design forbids.
    if (params.isEditable) {
      const menu = new Menu()
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menu.append(new MenuItem({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) }))
      }
      if (params.dictionarySuggestions.length > 0) menu.append(new MenuItem({ type: 'separator' }))
      if (params.misspelledWord) {
        menu.append(
          new MenuItem({
            label: 'Add to dictionary',
            click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
          })
        )
        menu.append(new MenuItem({ type: 'separator' }))
      }
      menu.append(new MenuItem({ role: 'undo' }))
      menu.append(new MenuItem({ role: 'redo' }))
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(new MenuItem({ role: 'cut' }))
      menu.append(new MenuItem({ role: 'copy' }))
      menu.append(new MenuItem({ role: 'paste' }))
      menu.append(new MenuItem({ role: 'selectAll' }))
      menu.popup()
      return
    }

    // Non-editable content: suppress the native menu and hand off to the
    // renderer's unified Haptyx menu, which classifies the target (text / image
    // / link / video / empty) and offers the same sections as everywhere else.
    const mainWin = BrowserWindow.getAllWindows()[0]
    mainWin?.webContents.send('webview:context-menu', {
      webContentsId: contents.id,
      x: params.x,
      y: params.y,
      selectionText: params.selectionText || undefined,
      linkURL: params.linkURL || undefined,
      srcURL: params.srcURL || undefined,
      mediaType: params.mediaType
    })
  })
})

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('agency.saasmouth.focusbuddy')
  }
  getDb()
  // Rotating safety-net snapshot of the database, at most once per 12h. Runs
  // async, never blocks boot, and is the recovery path if the live DB is later
  // lost or corrupted.
  autoBackupOnLaunch()
  // Harden the main renderer's session too (voice/video-note media stays
  // granted; dangerous device/location permissions are denied).
  applyPermissionPolicy(session.defaultSession)
  // Enable getDisplayMedia so PlexiMeet can share a screen or window.
  applyDisplayMediaHandler(session.defaultSession)
  registerIpcHandlers()
  registerMdExternal()
  // The notification substrate's scheduler (Attention S4): app-start sweep +
  // 30s cadence; durable rows mean scheduled banners survive restarts.
  startNotificationScheduler()
  // External calendars: one refresh shortly after boot, then every 15 minutes.
  // A mirror that only updates when somebody opens the settings screen is a
  // mirror of last Tuesday.
  startCalendarSyncLoop()
  // Stream Deck focus handoff — caches the previously-frontmost app so
  // ⌘C / ⌘V / ⌘⇧4 / type-text land in the user's actual workspace
  // rather than in FocusBuddy itself.
  installFocusTracker()
  // Activity tracker — polls frontmost app while FocusBuddy is open so
  // the AI macro suggestor can later analyse repetitive workflows and
  // propose macros. Off by default; the user opts in from the Stream
  // Deck widget.
  installActivityTracker()
  // Auto-updater — polls GitHub Releases on boot + every 4h, broadcasts
  // state via the `update:state` IPC event. No-op in dev builds.
  installAutoUpdater()

  // Install the application menu so the View-menu zoom items and the Cmd +/-/0
  // shortcuts drive the app's UI scale. Without this the app ran on Electron's
  // default menu, whose zoom roles never touched the app scale.
  Menu.setApplicationMenu(buildAppMenu())

  // Automation scheduler — runs due PlexiFlows and scheduled PlexiReports in the
  // background so a daily digest or a weekly report actually fires whether or not
  // the user has the Flow/Report view open. Runs shortly after boot and then on a
  // five-minute tick; each run only executes items whose next-run time has passed.
  const runDueAutomation = (): void => {
    void runDueFlows().catch((err) => console.error('[scheduler] flows:', err))
    void runDueReports().catch((err) => console.error('[scheduler] reports:', err))
  }
  setTimeout(runDueAutomation, 20_000)
  setInterval(runDueAutomation, 5 * 60_000)

  // DEC-056 — retention sweep. Bounded tables only; Events are protected four
  // ways and are never in scope (see db/retention.ts). Deferred off the boot
  // path and run once per launch: the queue only grows while the app is open,
  // so a per-boot cap is enough to keep it flat.
  setTimeout(() => {
    try {
      for (const o of runRetentionSweep()) {
        if (o.removed > 0) {
          // eslint-disable-next-line no-console
          console.log(`[retention] ${o.target}: released ${o.removed}, retained ${o.kept}`)
        }
      }
    } catch (err) {
      console.warn('[retention] sweep failed (non-fatal):', (err as Error).message)
    }
  }, 30_000)

  // Chunk-index sweep (A2, R10 + #16): reconcile fb_chunks with the document
  // and widget populations once per boot — content-hash cheap for unchanged
  // sources, and it removes chunks whose source is gone. Deferred off the
  // boot path.
  setTimeout(() => {
    try {
      const d = sweepDocumentChunks()
      const w = sweepWidgetChunks()
      const c = sweepChatChunks()
      if (d.indexed + d.removed + w.indexed + w.removed + c.indexed + c.removed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[chunk-index] sweep: docs ${d.indexed}/${d.removed}, ` +
            `widgets ${w.indexed}/${w.removed}, chats ${c.indexed}/${c.removed} (indexed/removed)`
        )
      }
      // Files last and async: extraction is the expensive step (PDF parse,
      // OCR), batch-capped per boot with the remainder reported, never
      // silently dropped.
      void sweepFileChunks()
        .then((f) => {
          if (f.indexed + f.removed + f.deferred > 0) {
            // eslint-disable-next-line no-console
            console.log(
              `[chunk-index] files: ${f.indexed} indexed, ${f.removed} removed` +
                (f.deferred > 0 ? `, ${f.deferred} deferred to the next boot` : '')
            )
          }
        })
        .catch((err) => console.error('[chunk-index] file sweep failed:', err))
    } catch (err) {
      console.error('[chunk-index] sweep failed:', err)
    }
  }, 12_000)

  // Local-AI passes: document enrichment + memory extraction.
  //
  // Both run on the LOCAL model, so they cost nothing and leave nothing. Both
  // were previously reachable only from a button in Settings, which is why a
  // year-old workspace had zero enriched documents — and therefore why the
  // enriched grounding header (Category / Dates / Mentions / Summary) that
  // groundingBlock renders had never appeared in a single prompt.
  //
  // Deliberately gentle: a small batch per tick, several minutes apart, so a
  // backlog drains over an hour of normal use instead of pinning a core at
  // launch. Each pass is ledgered by content hash, so once the backlog is clear
  // these ticks do nothing until a document actually changes. No local model
  // means both return a reason and write nothing.
  const LOCAL_AI_FIRST_RUN_MS = 45_000
  const LOCAL_AI_INTERVAL_MS = 5 * 60_000
  let localAiQuiet = false
  const runLocalAiPasses = async (): Promise<void> => {
    try {
      // Embeddings go FIRST. They are batched and fast, and they are what makes
      // a question about churn find a document about attrition — the single
      // cheapest gain of the three. Enrichment and memory are per-document model
      // calls measured in seconds, so running them first starves embeddings
      // behind a backlog that can take an hour to drain.
      const v = await sweepEmbeddings()
      if (v.documents + v.knowledge > 0) {
        // eslint-disable-next-line no-console
        console.log(`[local-ai] embedded ${v.documents} document(s), ${v.knowledge} knowledge entr(ies)`)
      } else if (v.reason) {
        // A backlog that embeds nothing must say why. Silence here is what made
        // the shortfall invisible: coverage simply sat below 100% with no
        // explanation anywhere.
        // eslint-disable-next-line no-console
        console.log(`[local-ai] embedding backfill made no progress: ${v.reason}`)
      }
      const e = await sweepDocumentEnrichment()
      const m = await sweepDocumentMemory()
      if (e.reason === 'no_local_model' || m.reason === 'no_local_model') {
        if (!localAiQuiet) {
          localAiQuiet = true
          // eslint-disable-next-line no-console
          console.log('[local-ai] no local model available — enrichment and memory are idle, nothing written')
        }
        return
      }
      localAiQuiet = false
      if (e.processed + m.processed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[local-ai] enriched ${e.processed} (${e.remaining} left), ` +
            `memory scanned ${m.processed} (+${m.added} remembered, ${m.remaining} left)`
        )
      }
    } catch (err) {
      console.error('[local-ai] sweep failed:', err)
    }
  }
  setTimeout(() => {
    void runLocalAiPasses()
    setInterval(() => void runLocalAiPasses(), LOCAL_AI_INTERVAL_MS).unref?.()
  }, LOCAL_AI_FIRST_RUN_MS).unref?.()

  // Wire `fb-file://<id>` → file on disk. Uses Electron's modern `protocol.handle`
  // which supports Range requests transparently (critical for streaming
  // video/audio playback and chunked PDF rendering).
  protocol.handle('fb-file', async (request) => {
    try {
      const url = new URL(request.url)
      // host is the file id (e.g. fb-file://abc-123/) — Chromium normalises
      // to lowercase, but our UUIDs are lowercase anyway. The path is ignored.
      const id = url.hostname
      const file = getFile(id)
      if (!file || !existsSync(file.storedPath)) {
        return new Response('Not found', { status: 404 })
      }
      // net.fetch on a file:// URL streams the file and sets Content-Type
      // based on the extension. We override the mime header to our stored
      // value so the renderer always picks the right viewer.
      const fileUrl = pathToFileURL(file.storedPath).toString()
      const response = await net.fetch(fileUrl)
      const headers = new Headers(response.headers)
      headers.set('Content-Type', file.mimeType)
      headers.set('Cache-Control', 'no-cache')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      })
    } catch (err) {
      return new Response(`fb-file error: ${String(err)}`, { status: 500 })
    }
  })

  // Wire `fb-widget://<widget-id>/` → that Custom widget's composed document.
  //
  // Main owns this rather than the renderer handing over a blob because main
  // already owns the database: the document is always built from the row as it
  // stands, so a reload can never resurrect a stale generation, and the widget's
  // saved state is inlined at compose time with no round-trip.
  //
  // The CSP is served as a real header here AND embedded as a meta element by
  // the composer. Either alone would do; both means the policy survives a
  // transport that drops headers, and when two policies are present the browser
  // enforces their intersection -- so the redundancy can only ever tighten.
  protocol.handle('fb-widget', async (request) => {
    const deny = (status: number, msg: string): Response =>
      new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    try {
      const url = new URL(request.url)
      const id = url.hostname
      if (!id) return deny(400, 'No widget id.')
      const row = getDb()
        .prepare('SELECT kind, content FROM widgets WHERE id = ?')
        .get(id) as { kind?: string; content?: string } | undefined
      if (!row) return deny(404, 'That widget no longer exists.')
      // Only ever serve a Custom widget through this scheme. Without this check
      // the protocol would happily render any widget's content as a live
      // document, which is exactly the sort of confused-deputy step that turns a
      // note into an execution surface.
      if (row.kind !== 'custom') return deny(403, 'Not a custom widget.')

      let parsed: { code?: unknown; state?: unknown; net?: unknown } = {}
      try {
        parsed = JSON.parse(row.content || '{}')
      } catch {
        return deny(422, 'This widget could not be read.')
      }
      const code = typeof parsed.code === 'string' ? parsed.code : ''
      if (!code.trim()) return deny(404, 'This widget has not been built yet.')
      const net = parsed.net === true
      const state =
        parsed.state && typeof parsed.state === 'object' && !Array.isArray(parsed.state)
          ? (parsed.state as Record<string, unknown>)
          : {}

      const html = composeCustomWidgetDocument({
        code,
        state,
        net,
        dark: url.searchParams.get('dark') === '1',
        // Resolved here rather than sent by the renderer: main already holds the
        // wires, the widgets and the tables, so the document is built with real
        // data on its first frame and there is no round-trip to wait for.
        inputs: resolveWidgetInputs(id)
      })
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': cspFor(net),
          // The renderer busts this with a version parameter when the generated
          // code changes; nothing else should ever be served from cache.
          'Cache-Control': 'no-store'
        }
      })
    } catch (err) {
      return deny(500, `Could not build this widget: ${String(err)}`)
    }
  })

  // Dev-only mock asset protocol — serves files from the project's
  // `Mock Videos/` directory so the body double dialog can use a stand-in
  // video while WebRTC is being built. Only registered when running from
  // a Vite dev server (process.env.ELECTRON_RENDERER_URL is the signal
  // electron-vite uses). In a packaged build this handler isn't installed
  // and fb-dev:// URLs fail gracefully.
  if (process.env.ELECTRON_RENDERER_URL) {
    // app.getAppPath() in dev typically returns the project root because
    // electron-vite runs from there — but log it once on registration so
    // when a fb-dev:// request fails we have the resolved root for
    // diagnosis. (The renderer's silent <video> error is otherwise opaque.)
    // eslint-disable-next-line no-console
    console.log('[fb-dev] registering protocol; appPath =', app.getAppPath())
    protocol.handle('fb-dev', async (request) => {
      try {
        const url = new URL(request.url)
        const subdir = url.hostname
        const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
        const allowedSubdirs: Record<string, string> = {
          'mock-videos': 'Mock Videos'
        }
        const mappedSubdir = allowedSubdirs[subdir]
        if (!mappedSubdir) {
          // eslint-disable-next-line no-console
          console.warn('[fb-dev] forbidden subdir:', subdir)
          return new Response('Forbidden', { status: 403 })
        }
        const root = app.getAppPath()
        const baseDir = `${root}/${mappedSubdir}`
        const onDisk = `${baseDir}/${relPath}`
        // Path-traversal guard: resolve and confirm the final path stays under
        // the mapped directory, so a "../.." relPath cannot escape it. Dev-only
        // handler, but cheap and correct to lock down.
        const resolved = resolvePath(onDisk)
        if (resolved !== resolvePath(baseDir) && !resolved.startsWith(resolvePath(baseDir) + sep)) {
          return new Response('Forbidden', { status: 403 })
        }
        // Sanity check before handing off — net.fetch's 404 page wraps the
        // real cause in a long HTML body that's hard to spot in the log.
        if (!existsSync(onDisk)) {
          // eslint-disable-next-line no-console
          console.warn('[fb-dev] file does not exist on disk:', onDisk)
          return new Response('Not found', { status: 404 })
        }
        const response = await net.fetch(pathToFileURL(onDisk).toString())
        const headers = new Headers(response.headers)
        if (relPath.endsWith('.mp4')) headers.set('Content-Type', 'video/mp4')
        else if (relPath.endsWith('.webm')) headers.set('Content-Type', 'video/webm')
        headers.set('Cache-Control', 'no-cache')
        // Helpful one-line dev log so we see "the file IS being served"
        // when the user reports the video isn't loading. If this line
        // doesn't print but the <video> shows the fallback, the issue is
        // CSP / element wiring, not the protocol.
        // eslint-disable-next-line no-console
        console.log('[fb-dev] served', request.url, '→', onDisk)
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[fb-dev] handler threw:', err)
        return new Response(`fb-dev error: ${String(err)}`, { status: 500 })
      }
    })
  }

  createCommandCenter()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createCommandCenter()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    closeDb()
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDb()
})
