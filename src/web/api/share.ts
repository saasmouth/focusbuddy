// The recipient's side of a 48-hour share.
//
// The cloud app exists for exactly this: someone was sent a link, and it opens a
// desk they can look at and change for two days. There is no account, no sign-in
// and no sync. What they get is a copy.
//
// When the clock runs out the copy goes as well, on both sides — the server
// deletes the bundle and this wipes the browser's database. That is deliberate
// and it is what makes "download the desktop app" the obvious next step rather
// than a suggestion: the alternative is copies of someone's desk sitting in
// strangers' browsers indefinitely.
import { signalConfig } from '@renderer/lib/signalConfig'

export interface ShareOffer {
  title: string
  expiresAt: number
  sizeBytes: number
  rootId: string
}

export type ShareRefusal = 'unknown' | 'revoked' | 'expired' | 'offline'

const urlFor = (path: string): string => signalConfig.httpUrl.replace(/\/+$/, '') + path

/**
 * The share token in the address bar, or null.
 *
 * `/s/<token>` is the shape the desktop mints. A query parameter is accepted too
 * because links get mangled by chat clients and an ugly fallback that works
 * beats a clean one that does not.
 */
export function shareTokenFromUrl(href = window.location.href): string | null {
  try {
    const url = new URL(href)
    // Not anchored at the start: the app is mounted under a path on the
    // marketing site, so the link is /share/s/<token> there and /s/<token> when
    // it is served from a root of its own.
    const m = /\/s\/([A-Za-z0-9_-]{8,})\/?$/.exec(url.pathname)
    if (m) return m[1]
    const q = url.searchParams.get('share')
    return q && /^[A-Za-z0-9_-]{8,}$/.test(q) ? q : null
  } catch {
    return null
  }
}

/** What the link offers, before anything is downloaded. */
export async function previewShare(token: string): Promise<
  { ok: true; offer: ShareOffer } | { ok: false; reason: ShareRefusal }
> {
  try {
    const res = await fetch(urlFor(`/public/shares/${encodeURIComponent(token)}`), { cache: 'no-store' })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; share?: ShareOffer; reason?: ShareRefusal } | null
    if (res.ok && body?.ok && body.share) return { ok: true, offer: body.share }
    return { ok: false, reason: body?.reason ?? 'unknown' }
  } catch {
    // A network failure is not a dead link, and telling someone their link has
    // expired when their wifi dropped is a lie they will act on.
    return { ok: false, reason: 'offline' }
  }
}

/** The bundle itself, as text — it goes straight to the Worker to be imported. */
export async function fetchShareBundle(token: string): Promise<string | null> {
  try {
    const res = await fetch(urlFor(`/public/shares/${encodeURIComponent(token)}/bundle`), { cache: 'no-store' })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

const IMPORTED_KEY = 'fb.share.imported'

/** Has this token's bundle already been unpacked into this browser? */
export function alreadyImported(token: string): boolean {
  try {
    return localStorage.getItem(IMPORTED_KEY) === token
  } catch {
    return false
  }
}

export function markImported(token: string): void {
  try {
    localStorage.setItem(IMPORTED_KEY, token)
  } catch {
    /* private mode: the desk is still usable, it just re-imports on reload */
  }
}

/**
 * Erase the recipient's copy.
 *
 * Everything: the OPFS database, the file bytes beside it, and the local marks
 * that say a share was ever here. Called when the clock runs out and when the
 * server says the share is gone.
 */
export async function wipeLocalCopy(): Promise<void> {
  try {
    localStorage.removeItem(IMPORTED_KEY)
  } catch {
    /* nothing to clear */
  }
  try {
    sessionStorage.clear()
  } catch {
    /* nothing to clear */
  }
  // OPFS holds both the SQLite pool and the Drive bytes. Removing the root
  // entries is the whole of the recipient's copy.
  try {
    const root = await navigator.storage.getDirectory()
    for await (const name of (root as unknown as { keys: () => AsyncIterable<string> }).keys()) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined)
    }
  } catch {
    /* no OPFS, or already empty */
  }
}

/** Milliseconds left, floored at zero. */
export const msLeft = (expiresAt: number, now = Date.now()): number => Math.max(0, expiresAt - now)

/**
 * A countdown that reads at a glance.
 *
 * Coarse while there is time and precise near the end, because those are the two
 * different questions a recipient is actually asking.
 */
export function countdown(expiresAt: number, now = Date.now()): string {
  const ms = msLeft(expiresAt, now)
  if (ms === 0) return 'expired'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'less than a minute left'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} left`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m left`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h left`
}

/** Hand the recipient the bundle as a file, to open in the desktop app. */
export function downloadBundle(bundleJson: string, title: string): void {
  const safe = (title || 'desk').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'desk'
  const blob = new Blob([bundleJson], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safe}.plexii-desk.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick: revoking synchronously races the download in
  // some browsers and the file arrives empty.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
