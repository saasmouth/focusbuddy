// Widevine in desk web pages: the CDM's lifecycle, the probe that every web
// page carries, and the notice when protected video cannot play.
//
// THE RUNTIME. PlexiiDesk runs on castLabs' Electron for Content Security
// (ECS), a drop-in Electron that adds the `components` API: Chromium's
// component updater installs Google's Widevine CDM into userData (WidevineCdm/)
// and keeps it updated. Stock Electron has no CDM at all, which is what
// Netflix's error M7701-1003 in a desk page was saying.
//
// NEVER DELAY START-UP ON IT. ECS 45 would install the CDM on its own, but on
// a delay timer; startWidevine() asks for it at once (components.whenReady)
// and does not wait. Pages that need it wait instead: the probe holds a
// Widevine requestMediaKeySystemAccess until the CDM has settled (or
// CDM_WAIT_MS passes), so a page opened during a first launch's download plays
// once it lands rather than failing.
//
// EVERY WEB PAGE. Desk widgets, the web panel, Office's browser, connected
// apps and desk pop-ups all render in non-default sessions
// (persist:webview-default, persist:connectedapp-*, …). The CDM is
// process-wide, so each of them can use it; what each needs from here is the
// probe (src/preload/drmProbe.ts), registered once per session as a session
// preload for http(s) pages. No `plugins` flag is involved: the CDM is not a
// plugin, and tests/e2e/widevine.spec.ts proves a desk page gets Widevine
// without one.
//
// THE NOTICE. The probe reports what a page did (src/shared/drm.ts decides
// whether it means protected video cannot play, and why), and the app window
// shows a calm notice above that page with "Open in your browser"
// (components/browser/DrmNotice). Main never acts on a report beyond that.
import { app, ipcMain, session, BrowserWindow, type Session, type WebContents } from 'electron'
import * as electron from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  classifyDrm,
  drmNoticeText,
  parseVmpMarker,
  sanitizeDrmEvidence,
  type CdmStatus,
  type DrmNoticePayload,
  type VmpState
} from '@shared/drm'

/** How long a page's Widevine request waits for a first-launch CDM download. */
export const CDM_WAIT_MS = 30_000
const PROBE_ID = 'plexii-drm-probe'

// ── The CDM ──────────────────────────────────────────────────────────────────

let status: CdmStatus = { state: 'installing' }
let started = false
const settleWaiters = new Set<() => void>()

interface ComponentsApi {
  whenReady(required?: string[]): Promise<unknown>
  status(): Record<string, { status: string; title: string | null; version: string | null }>
  readonly WIDEVINE_CDM_ID: string
}

/** ECS's components API, or null on stock Electron. */
function componentsApi(): ComponentsApi | null {
  const c = (electron as unknown as { components?: ComponentsApi }).components
  return c && typeof c.whenReady === 'function' ? c : null
}

function setStatus(next: CdmStatus): void {
  status = next
  console.log(
    `[widevine] ${next.state}${next.version ? ` ${next.version}` : ''}${next.error ? `: ${next.error}` : ''}`
  )
  for (const w of [...settleWaiters]) w()
}

/** A ComponentsError in a sentence: its component errors' messages. */
function describeError(err: unknown): string {
  const e = err as { message?: string; errors?: Array<{ message?: string; detail?: { status?: string } }> }
  const parts = (e?.errors ?? [])
    .map((x) => x?.message || x?.detail?.status)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
  const text = parts.length ? parts.join('; ') : e?.message || String(err)
  // ECS's words for "the component updater is off" (--disable-component-update,
  // or updates disabled before the CDM was ever installed): the CDM was never
  // registered. The person reads this, so say what it means.
  if (/unsupported component/i.test(text)) return 'downloading it is switched off on this computer'
  return text.slice(0, 160)
}

/**
 * Ask for the Widevine CDM now (installing it if this is a first launch) and
 * return immediately. Call once, after `ready`.
 */
export function startWidevine(): void {
  if (started) return
  started = true
  const comps = componentsApi()
  if (!comps) {
    setStatus({ state: 'unsupported' })
    return
  }
  const id = comps.WIDEVINE_CDM_ID
  let whenReady: Promise<unknown>
  try {
    whenReady = comps.whenReady([id])
  } catch (err) {
    setStatus({ state: 'failed', error: describeError(err) })
    return
  }
  whenReady.then(
    () => {
      let version: string | null = null
      try {
        version = comps.status()[id]?.version ?? null
      } catch {
        version = null
      }
      setStatus({ state: 'ready', version })
    },
    (err) => setStatus({ state: 'failed', error: describeError(err) })
  )
}

export function widevineStatus(): CdmStatus {
  return status
}

/** The CDM's state once it has settled, or as it stands after `timeoutMs`. */
export function waitForWidevine(timeoutMs: number): Promise<CdmStatus> {
  if (status.state !== 'installing') return Promise.resolve(status)
  return new Promise((resolve) => {
    const done = (): void => {
      settleWaiters.delete(done)
      clearTimeout(timer)
      resolve(status)
    }
    const timer = setTimeout(done, timeoutMs)
    settleWaiters.add(done)
  })
}

// ── The VMP signature, as the build recorded it ──────────────────────────────

let vmpCached: VmpState | null = null
/**
 * Packaged: what build/vmp.cjs recorded in Resources/vmp.json. Unpackaged (dev
 * and e2e): the ECS binary in node_modules carries castLabs' development
 * signature.
 */
export function vmpState(): VmpState {
  if (vmpCached) return vmpCached
  if (!app.isPackaged) {
    vmpCached = 'development'
    return vmpCached
  }
  const marker = join(process.resourcesPath, 'vmp.json')
  try {
    vmpCached = parseVmpMarker(existsSync(marker) ? readFileSync(marker, 'utf8') : null)
  } catch {
    vmpCached = 'unknown'
  }
  return vmpCached
}

// ── The probe in every web session ───────────────────────────────────────────

const probed = new WeakSet<Session>()

function probePath(): string {
  return join(__dirname, '../preload/drmProbe.js')
}

/**
 * Register the page probe on a web session. The app's own window runs in the
 * default session and never gets it.
 */
export function installDrmProbe(ses: Session | null | undefined): void {
  if (!ses || probed.has(ses)) return
  if (ses === session.defaultSession) return
  probed.add(ses)
  try {
    ses.registerPreloadScript({
      type: 'frame',
      id: PROBE_ID,
      filePath: probePath(),
      matches: ['http://*/*', 'https://*/*']
    })
  } catch (err) {
    console.warn('[drm] could not register the page probe:', err instanceof Error ? err.message : err)
  }
}

// ── Reports from pages, and the notice ───────────────────────────────────────

/** Web page contents only: never the app's own window (default session, file://). */
function isWebPage(wc: WebContents): boolean {
  try {
    if (wc.isDestroyed() || wc.session === session.defaultSession) return false
    return /^https?:/i.test(wc.getURL())
  } catch {
    return false
  }
}

/** Notices already shown, per page: once per reason and address. */
const shown = new Map<number, Set<string>>()

function sendNotice(wc: WebContents, payload: DrmNoticePayload): void {
  const host = (wc as unknown as { hostWebContents?: WebContents | null }).hostWebContents
  const targets = host && !host.isDestroyed() ? [host] : BrowserWindow.getAllWindows().map((w) => w.webContents)
  for (const t of targets) {
    try {
      if (!t.isDestroyed()) t.send('webview:drm-notice', payload)
    } catch {
      /* a window going away */
    }
  }
}

export function registerDrmIpc(): void {
  ipcMain.on('drm:cdm-wait', (event) => {
    if (!isWebPage(event.sender)) return
    void waitForWidevine(CDM_WAIT_MS).then((s) => {
      try {
        event.reply('drm:cdm-status', s)
      } catch {
        /* the page went away while it waited */
      }
    })
  })

  ipcMain.on('drm:report', (event, raw: unknown) => {
    const wc = event.sender
    if (!isWebPage(wc)) return
    const evidence = sanitizeDrmEvidence(raw)
    if (!evidence) return
    const verdict = classifyDrm(evidence, { cdm: status, vmp: vmpState() })
    let url = ''
    let hostName = ''
    try {
      url = wc.getURL()
      hostName = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      /* keep empty */
    }
    console.log(
      `[drm] ${hostName || 'page'} ${evidence.kind}${'code' in evidence ? ` ${evidence.code}` : ''} → ${verdict ? verdict.reason : 'no notice'} (cdm ${status.state}, vmp ${vmpState()})`
    )
    if (!verdict) return
    const key = `${verdict.reason}|${url}`
    let seen = shown.get(wc.id)
    if (!seen) {
      seen = new Set()
      shown.set(wc.id, seen)
      const id = wc.id
      wc.once('destroyed', () => shown.delete(id))
    }
    if (seen.has(key)) return
    seen.add(key)
    sendNotice(wc, {
      webContentsId: wc.id,
      reason: verdict.reason,
      detail: verdict.detail,
      url,
      text: drmNoticeText(verdict, hostName)
    })
  })
}
