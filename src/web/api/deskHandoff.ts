// "Download this desk on Plexii", the share page's end (shared/deskHandoff.ts).
//
// Two jobs:
//
//   1. The download. The installer for the visitor's computer starts at the
//      first gate. Which file that is comes from the site, not from this build:
//      the site writes /app-release.json from the same release record its
//      own download buttons use (plexii-site/compose.mjs), so a share page
//      built from an older app commit never offers a stale installer. When the
//      file is missing the visitor is sent to the download page instead.
//
//   2. The desk. The visitor's copy, with whatever they dragged onto it, is
//      uploaded to Signal as a handoff, and "Open this desk in Plexii" hands
//      its id to the app (plexii://desk?handoff=<id>). Offered only when BOTH
//      ends can do it: the released app receives handoffs (app-release.json says
//      so) and Signal keeps them (server feature desk_handoff). A promise that
//      half the system cannot keep is not made.
import { signalConfig } from '@renderer/lib/signalConfig'
import { deskHandoffLink } from '@shared/deskHandoff'
import { dbCall } from './dbClient'

export interface Installers {
  version: string
  /** Windows builds can lag the Mac release (plexii-site WIN_VERSION). */
  winVersion: string
  mac: string | null
  windows: string | null
  /** The released app opens plexii://desk?handoff= links. */
  deskHandoff: boolean
}

export type VisitorPlatform = 'mac' | 'windows' | 'phone' | 'other'

const urlFor = (path: string): string => signalConfig.httpUrl.replace(/\/+$/, '') + path

/** Read the site's record of the current installers. Exported for tests. */
export function parseInstallers(body: unknown): Installers | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const url = (v: unknown): string | null =>
    typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) ? v : null
  if (typeof b.version !== 'string') return null
  return {
    version: b.version,
    winVersion: typeof b.winVersion === 'string' ? b.winVersion : b.version,
    mac: url(b.mac),
    windows: url(b.windows),
    deskHandoff: b.deskHandoff === true
  }
}

let installersMemo: Promise<Installers | null> | null = null

/** The installers, from the page's own site. Null when they cannot be read. */
export function loadInstallers(origin: string = window.location.origin): Promise<Installers | null> {
  installersMemo ??= (async () => {
    try {
      const res = await fetch(`${origin}/app-release.json`, { cache: 'no-store' })
      if (!res.ok) return null
      return parseInstallers(await res.json())
    } catch {
      return null
    }
  })()
  return installersMemo
}

let featureMemo: Promise<boolean> | null = null

/** Does Signal keep handoffs? (GET /public/server-features lists desk_handoff.) */
export function serverKeepsHandoffs(): Promise<boolean> {
  featureMemo ??= (async () => {
    try {
      const res = await fetch(urlFor('/public/server-features'), { cache: 'no-store' })
      if (!res.ok) return false
      const body = (await res.json()) as { features?: unknown; serverFeatures?: unknown } | unknown[]
      const list = Array.isArray(body)
        ? body
        : Array.isArray((body as { features?: unknown }).features)
          ? ((body as { features: unknown[] }).features)
          : Array.isArray((body as { serverFeatures?: unknown }).serverFeatures)
            ? ((body as { serverFeatures: unknown[] }).serverFeatures)
            : []
      return list.includes('desk_handoff')
    } catch {
      return false
    }
  })()
  return featureMemo
}

/** Which computer the visitor is on, as far as the download is concerned. */
export function visitorPlatform(nav: { userAgent: string; platform?: string; maxTouchPoints?: number } = navigator): VisitorPlatform {
  const ua = nav.userAgent || ''
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return 'phone'
  // iPadOS asks for the desktop site and says "Macintosh"; it has touch.
  if (/Macintosh|Mac OS X/i.test(ua)) return (nav.maxTouchPoints ?? 0) > 1 ? 'phone' : 'mac'
  if (/Windows/i.test(ua)) return 'windows'
  return 'other'
}

/** The installer for this computer, or null when there is none to start. */
export function installerFor(platform: VisitorPlatform, installers: Installers | null): string | null {
  if (!installers) return null
  if (platform === 'mac') return installers.mac
  if (platform === 'windows') return installers.windows
  return null
}

/**
 * Start a download without leaving the page.
 *
 * A link to the installer, clicked: the file is not something a browser shows,
 * so it downloads and the desk stays where it is. (A hidden frame would keep
 * the page safe from an error response too, but browsers block downloads that
 * start in a frame the person never touched.)
 */
export function startDownload(url: string, doc: Document = document): void {
  const a = doc.createElement('a')
  a.href = url
  a.rel = 'noopener'
  a.style.display = 'none'
  doc.body.appendChild(a)
  a.click()
  a.remove()
}

// ── The handoff ─────────────────────────────────────────────────────────────

interface HandoffRecord {
  id: string
  secret: string
  /** When the copy was last sent (ms). */
  sentAt: number
}

const RECORD_KEY = (token: string): string => `fb.share.handoff.${token}`

function readRecord(token: string): HandoffRecord | null {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORD_KEY(token)) ?? 'null') as Partial<HandoffRecord> | null
    if (raw && typeof raw.id === 'string' && typeof raw.secret === 'string') {
      return { id: raw.id, secret: raw.secret, sentAt: typeof raw.sentAt === 'number' ? raw.sentAt : 0 }
    }
  } catch {
    /* unreadable: a new handoff is made */
  }
  return null
}

function writeRecord(token: string, rec: HandoffRecord): void {
  try {
    localStorage.setItem(RECORD_KEY(token), JSON.stringify(rec))
  } catch {
    /* private mode: this page keeps it in memory below */
  }
  memoRecords.set(token, rec)
}

const memoRecords = new Map<string, HandoffRecord>()

export type HandoffOutcome =
  | { ok: true; id: string; link: string }
  | { ok: false; why: 'unsupported' | 'too-large' | 'gone' | 'busy' | 'offline' | 'failed' }

export interface HandoffSource {
  /** The link this copy came from. */
  token: string
  kind: 'use' | 'copy'
  /** The desk (or room) the link opened. */
  rootId: string
  title: string
}

const outcomeFor = (status: number): HandoffOutcome => ({
  ok: false,
  why: status === 413 ? 'too-large' : status === 404 || status === 410 ? 'gone' : status === 429 ? 'busy' : 'failed'
})

/**
 * Send the visitor's copy as it is now, and say which link opens it in Plexii.
 *
 * The first time, a handoff is made; after that the same one is updated (its
 * id is already in the deep link the visitor may have clicked), and a new one
 * is made only if the old one is gone or was already claimed.
 */
export async function sendCopy(src: HandoffSource): Promise<HandoffOutcome> {
  let bundle: string
  try {
    bundle = String(await dbCall('shareCopy:exportDesk', [src.rootId]))
  } catch {
    return { ok: false, why: 'failed' }
  }
  const rec = memoRecords.get(src.token) ?? readRecord(src.token)
  try {
    if (rec) {
      const res = await fetch(urlFor(`/desk-handoffs/${encodeURIComponent(rec.id)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-handoff-secret': rec.secret },
        body: JSON.stringify({ bundle, title: src.title })
      })
      if (res.ok) {
        writeRecord(src.token, { ...rec, sentAt: Date.now() })
        return { ok: true, id: rec.id, link: deskHandoffLink(rec.id) }
      }
      // Gone, claimed or not ours any more: a fresh one below. Anything else
      // (too big, rate limited, the server down) is the answer.
      if (![403, 404, 409, 410].includes(res.status)) return outcomeFor(res.status)
    }
    const res = await fetch(urlFor('/desk-handoffs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareToken: src.token, kind: src.kind, title: src.title, bundle })
    })
    if (!res.ok) return outcomeFor(res.status)
    const body = (await res.json().catch(() => null)) as { id?: unknown; secret?: unknown } | null
    if (!body || typeof body.id !== 'string' || typeof body.secret !== 'string') return { ok: false, why: 'failed' }
    writeRecord(src.token, { id: body.id, secret: body.secret, sentAt: Date.now() })
    return { ok: true, id: body.id, link: deskHandoffLink(body.id) }
  } catch {
    return { ok: false, why: 'offline' }
  }
}

/** Tests: forget what was memoised. */
export function resetDeskHandoffForTests(): void {
  installersMemo = null
  featureMemo = null
  memoRecords.clear()
}
