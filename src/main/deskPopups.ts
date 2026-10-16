import {
  BrowserWindow,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type HandlerDetails,
  type WebContents,
  type WindowOpenHandlerResponse
} from 'electron'
import { decidePopup } from './popupRouter'
import { openExternalSafe } from './safeOpenExternal'
import { getPopupsNative, setPopupsNative } from './settingsStore'
import {
  envForcesNativePopups,
  fallbackPopupBounds,
  isAllowedPopupNavigation,
  isHandoffEnd,
  popupBoundsFromCssRect,
  shouldUseNativePopups,
  type DeskPopupInfo,
  type DeskPopupMode,
  type PopupRect
} from '@shared/deskPopup'

// Desk pop-ups — the main-process half. See src/shared/deskPopup.ts for why.
//
// HOW THE OPENER SURVIVES. A pop-up is created by Chromium the moment the page
// calls window.open; Electron then asks the window-open handler what to wrap it
// in. Returning `createWindow` lets us wrap that SAME webContents in a
// WebContentsView instead of a BrowserWindow. The opener relationship lives in
// the webContents (Blink's opener link, the shared browsing-context group), not
// in the window around it, so window.opener, postMessage to the opener and
// window.close() all keep working — which is what an OAuth hand-off needs.
//
// The view is a child of the main window's contentView. Native views always
// paint above the renderer, so the renderer draws the card chrome (backdrop,
// header, close) around an empty slot and reports that slot's rect; we place the
// view exactly over it.
//
// Security: the pop-up's webPreferences come from popupRouter's
// overrideBrowserWindowOptions (sandbox, contextIsolation, no node, no webview
// tag, the opener's session) — no preload, so no window.api. The IPC error
// boundary also refuses any invoke whose sender is not the app's own renderer,
// so even a page that found ipcRenderer could not reach a handler.

interface Entry {
  info: DeskPopupInfo
  view: WebContentsView
  host: BrowserWindow
  /** The renderer-reported slot, CSS px. Null until the card has laid out. */
  rect: PopupRect | null
  /** The desk webview this pop-up chain started from; link forwards go there. */
  rootSourceId: number
  everLoadedWeb: boolean
  fallbackTimer: ReturnType<typeof setTimeout> | null
  /** Set when the renderer missed its grace period; main places the view itself. */
  fallbackDue: boolean
  closed: boolean
}

/** Insertion order is stacking order: the last entry is on top. */
const entries = new Map<string, Entry>()
const hostsWired = new WeakSet<BrowserWindow>()
let seq = 0

/** How long to wait for the renderer's slot before placing the view ourselves. */
const RENDERER_SLOT_GRACE_MS = 1500

export function getDeskPopupMode(): DeskPopupMode {
  const forcedByEnv = envForcesNativePopups(process.env.PLEXI_POPUPS_NATIVE)
  let pref = false
  try {
    pref = getPopupsNative()
  } catch {
    pref = false
  }
  return { native: shouldUseNativePopups({ env: process.env.PLEXI_POPUPS_NATIVE, pref }), forcedByEnv }
}

export function setDeskPopupNativeMode(native: boolean): DeskPopupMode {
  setPopupsNative(native === true)
  return getDeskPopupMode()
}

/** The window whose desk a pop-up from `opener` belongs on. */
function hostWindowFor(opener: WebContents): BrowserWindow | null {
  for (const e of entries.values()) {
    if (!e.closed && !e.view.webContents.isDestroyed() && e.view.webContents.id === opener.id) {
      return e.host.isDestroyed() ? null : e.host
    }
  }
  const embedder = (opener as WebContents & { hostWebContents?: WebContents }).hostWebContents
  const win =
    (embedder ? BrowserWindow.fromWebContents(embedder) : null) ??
    BrowserWindow.fromWebContents(opener) ??
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0] ??
    null
  return win && !win.isDestroyed() ? win : null
}

function send(host: BrowserWindow, channel: string, payload: unknown): void {
  if (host.isDestroyed() || host.webContents.isDestroyed()) return
  host.webContents.send(channel, payload)
}

/** The top-most live pop-up on `host`'s desk. */
function topOf(host: BrowserWindow): Entry | null {
  let top: Entry | null = null
  for (const e of entries.values()) if (e.host === host && !e.closed) top = e
  return top
}

/**
 * Only the top card's page is shown. Native views ignore CSS stacking, so a
 * lower card's page would otherwise paint over the header of the card above
 * it; the lower cards show their header and a placeholder until brought back.
 */
function restack(host: BrowserWindow): void {
  for (const e of entries.values()) if (e.host === host) applyBounds(e)
}

function applyBounds(e: Entry): void {
  if (e.closed || e.host.isDestroyed()) return
  if (topOf(e.host) !== e || (!e.rect && !e.fallbackDue)) {
    e.view.setVisible(false)
    return
  }
  const [cw, ch] = e.host.getContentSize()
  const content = { width: cw, height: ch }
  let bounds: PopupRect | null
  if (e.rect) {
    let zoom = 1
    try {
      zoom = e.host.webContents.getZoomFactor()
    } catch {
      zoom = 1
    }
    bounds = popupBoundsFromCssRect(e.rect, zoom, content)
  } else {
    bounds = fallbackPopupBounds(content, { width: e.info.preferredWidth, height: e.info.preferredHeight })
  }
  if (!bounds) {
    e.view.setVisible(false)
    return
  }
  e.view.setBounds(bounds)
  e.view.setVisible(true)
}

function wireHost(host: BrowserWindow): void {
  if (hostsWired.has(host)) return
  hostsWired.add(host)
  // Re-place every pop-up on resize. The renderer re-reports its slots too
  // (its layout moved), but doing it here as well means a view never lags a
  // frame behind a window that the renderer is slow to re-measure.
  host.on('resize', () => {
    for (const e of entries.values()) if (e.host === host) applyBounds(e)
  })
  host.on('closed', () => {
    for (const [id, e] of [...entries]) if (e.host === host) closeDeskPopup(id)
  })
  // A renderer reload loses the cards; until it re-lists them, the views keep
  // their last bounds rather than vanishing.
}

function teardown(id: string): void {
  const e = entries.get(id)
  if (!e) return
  e.closed = true
  entries.delete(id)
  if (e.fallbackTimer) clearTimeout(e.fallbackTimer)
  try {
    if (!e.host.isDestroyed()) e.host.contentView.removeChildView(e.view)
  } catch {
    // already detached
  }
  send(e.host, 'deskPopup:closed', { id })
  if (!e.host.isDestroyed()) restack(e.host)
}

function publish(e: Entry): void {
  send(e.host, 'deskPopup:updated', { ...e.info })
}

/** Test hook: force WebContentsView creation to fail so the fallback is provable. */
function simulatedViewFailure(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.PLEXI_DESK_POPUP_FAIL === '1'
}

function mountDeskPopup(
  host: BrowserWindow,
  options: BrowserWindowConstructorOptions,
  details: HandlerDetails,
  rootSourceId: number
): WebContents {
  const guest = (options as BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents
  if (simulatedViewFailure()) throw new Error('simulated WebContentsView failure (PLEXI_DESK_POPUP_FAIL)')
  // Adopt the webContents Chromium already created for window.open — the one
  // the opener holds a handle to. Without `guest` (never expected) a fresh
  // contents with the router's prefs is still correct, just opener-less.
  const view = guest ? new WebContentsView({ webContents: guest }) : new WebContentsView({ webPreferences: options.webPreferences })
  const contents = view.webContents

  const id = `dp-${++seq}`
  const e: Entry = {
    info: {
      id,
      url: details.url,
      title: '',
      preferredWidth: Number(options.width) || 520,
      preferredHeight: Number(options.height) || 720
    },
    view,
    host,
    rect: null,
    rootSourceId,
    everLoadedWeb: false,
    fallbackTimer: null,
    fallbackDue: false,
    closed: false
  }
  entries.set(id, e)
  wireHost(host)

  view.setBackgroundColor('#ffffff')
  view.setVisible(false)
  host.contentView.addChildView(view)
  // The new card is on top; the page beneath it hides until brought back.
  restack(host)

  contents.on('page-title-updated', (_ev, title) => {
    e.info.title = title
    publish(e)
  })
  contents.on('did-navigate', (_ev, url) => {
    if (isHandoffEnd(url, e.everLoadedWeb)) {
      // Deferred: closing a webContents from inside its own navigation event
      // is asking for re-entrancy trouble.
      setImmediate(() => closeDeskPopup(id))
      return
    }
    if (/^https?:/i.test(url)) e.everLoadedWeb = true
    e.info.url = url
    publish(e)
  })
  contents.on('did-navigate-in-page', (_ev, url, isMainFrame) => {
    if (!isMainFrame) return
    e.info.url = url
    publish(e)
  })
  // window.close() from the page: Electron closes a view-hosted webContents and
  // emits 'destroyed'. Either way the card goes with it.
  contents.once('destroyed', () => teardown(id))

  // Nav-guard parity with the desk webviews: a pop-up may only load web pages.
  const guard = (ev: { preventDefault: () => void }, url: string, via: string): void => {
    if (isAllowedPopupNavigation(url)) return
    ev.preventDefault()
    // eslint-disable-next-line no-console
    console.warn(`[nav-guard] desk pop-up blocked ${via} -> ${url.slice(0, 200)}`)
  }
  contents.on('will-navigate', (ev, url) => guard(ev, url, 'will-navigate'))
  contents.on('will-redirect', (ev, url) => guard(ev, url, 'will-redirect'))

  // Esc closes the top card even when focus is inside the pop-up page, where
  // the renderer's own key handler cannot hear it.
  contents.on('before-input-event', (ev, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !input.isAutoRepeat) {
      const top = [...entries.values()].pop()
      if (top?.info.id === id) {
        ev.preventDefault()
        closeDeskPopup(id)
      }
    }
  })

  // A pop-up opening its own pop-up follows the same rules as a desk webview:
  // sign-in and scripted windows stack as another card, plain links become a
  // browser object on the desk (sent to the webview the chain started from,
  // which is the one listening for its own source id).
  contents.setWindowOpenHandler((d) => routeWindowOpen(contents, d, rootSourceId))

  // If the renderer never reports a slot, show the pop-up anyway, centred.
  e.fallbackTimer = setTimeout(() => {
    e.fallbackTimer = null
    if (e.closed || e.rect) return
    // eslint-disable-next-line no-console
    console.warn(`[desk-popup] no card slot from the renderer after ${RENDERER_SLOT_GRACE_MS}ms — centring ${id}`)
    e.fallbackDue = true
    applyBounds(e)
  }, RENDERER_SLOT_GRACE_MS)

  send(host, 'deskPopup:opened', { ...e.info })
  // eslint-disable-next-line no-console
  console.log(`[desk-popup] opened ${id} on the desk: ${details.url.slice(0, 160)}`)
  return contents
}

/**
 * The window-open response for a pop-up popupRouter decided to ALLOW. On the
 * desk unless the native fallback is on; if the desk view cannot be created the
 * pop-up still opens, as a native window, and the reason is logged.
 */
export function allowPopupResponse(
  opener: WebContents,
  details: HandlerDetails,
  overrideBrowserWindowOptions: BrowserWindowConstructorOptions,
  rootSourceId: number
): WindowOpenHandlerResponse {
  // outlivesOpener MUST stay true for OAuth: the opener often navigates the
  // moment the pop-up launches, and the pop-up has to survive that to finish.
  const base: WindowOpenHandlerResponse = { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions }
  if (getDeskPopupMode().native) return base
  const host = hostWindowFor(opener)
  if (!host) {
    // eslint-disable-next-line no-console
    console.warn('[desk-popup] no main window to host the pop-up on — opening a native window')
    return base
  }
  return {
    ...base,
    createWindow: (options) => {
      try {
        return mountDeskPopup(host, options, details, rootSourceId)
      } catch (err) {
        // Never drop a pop-up: fall back to the window it would have had.
        // eslint-disable-next-line no-console
        console.warn('[desk-popup] could not open the pop-up on the desk; opening a native window instead:', err)
        const win = new BrowserWindow(options)
        return win.webContents
      }
    }
  }
}

/** Full window-open routing for a desk pop-up's own window.open calls. */
function routeWindowOpen(contents: WebContents, details: HandlerDetails, rootSourceId: number): WindowOpenHandlerResponse {
  const host = hostWindowFor(contents)
  const decision = decidePopup(details, { session: contents.session, parentWindow: host ?? undefined })
  if (decision.action === 'allow') {
    return allowPopupResponse(contents, details, decision.overrideBrowserWindowOptions, rootSourceId)
  }
  if (decision.forwardToRenderer && host) {
    send(host, 'webview:link-clicked', { sourceWebContentsId: rootSourceId, url: decision.forwardToRenderer.url })
  }
  return { action: 'deny' }
}

// ── Renderer-facing operations (wired in ipc/index.ts) ─────────────────────

export function listDeskPopups(): DeskPopupInfo[] {
  return [...entries.values()].map((e) => ({ ...e.info }))
}

export function setDeskPopupBounds(id: string, rect: PopupRect): boolean {
  const e = entries.get(id)
  if (!e || e.closed) return false
  e.rect = { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) }
  if (e.fallbackTimer) {
    clearTimeout(e.fallbackTimer)
    e.fallbackTimer = null
  }
  applyBounds(e)
  return true
}

export function focusDeskPopup(id: string): boolean {
  const e = entries.get(id)
  if (!e || e.closed || e.host.isDestroyed()) return false
  // Re-adding a child view moves it to the top of the native stack; moving the
  // entry to the end of the map keeps "last = top" true for Esc.
  e.host.contentView.addChildView(e.view)
  entries.delete(id)
  entries.set(id, e)
  restack(e.host)
  if (!e.view.webContents.isDestroyed()) e.view.webContents.focus()
  return true
}

export function closeDeskPopup(id: string): boolean {
  const e = entries.get(id)
  if (!e) return false
  const contents = e.view.webContents
  teardown(id)
  try {
    if (!contents.isDestroyed()) contents.close()
  } catch {
    // already gone
  }
  return true
}

export async function openDeskPopupExternally(id: string): Promise<boolean> {
  const e = entries.get(id)
  if (!e) return false
  const url = e.view.webContents.isDestroyed() ? e.info.url : e.view.webContents.getURL() || e.info.url
  const opened = await openExternalSafe(url)
  if (opened) closeDeskPopup(id)
  return opened
}
