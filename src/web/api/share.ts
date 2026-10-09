// The recipient's side of a desk share link.
//
// The cloud app exists for exactly this: someone was sent a link, and it opens a
// desk they can look at and change. There is no account, no sign-in and no
// sync. What they get is a copy.
//
// A link either expires (48 hours by default, or a window the sender chose) or
// it never does -- the standing link a sender puts in front of every prospect.
// When an expiring link's clock runs out the copy goes as well, on both sides:
// the server deletes the bundle and this wipes the browser's database. That is
// deliberate, and it is what makes "download the desktop app" the obvious next
// step rather than a suggestion. A link that never expires has no clock, so
// nothing here counts down or wipes on a timer; the copy still goes the moment
// the sender turns the link off.
//
// The sender can also replace what a link shows without changing it. The offer
// says when that last happened (updatedAt), and shareVersion.ts decides what a
// returning visitor's copy should do about it.
//
// Only a link that is GONE takes its copy with it: Signal's own 404 "unknown"
// or 410 "revoked"/"expired". A server that is up but cannot serve the desk
// right now (503 "unavailable"), a proxy page while the machine restarts, a
// rate limit or a dropped connection says nothing about the link, and the
// visitor's copy is kept and opened as it was (refusalFrom, linkIsGone).
//
// And a gone link takes only ITS copy. A browser can hold desks from several
// links (shareVersion.ts keeps a record per link); a link this browser never
// unpacked -- a mistyped one, another link that was turned off, a bare visit --
// takes nothing at all, and one that did takes its own desk, or the whole store
// only when nothing else is in it (whenRefused, shareDesk.dropLinkCopy).
import { signalConfig } from '@renderer/lib/signalConfig'
import { expiresNever, normaliseExpiresAt } from '@shared/shareExpiry'
import {
  forgetAllLinkRecords, linkRecord, readLinkRecords, recordUnpacked, refreshRecordOffer,
  setUntrackedDesksPossible, type LinkRecord
} from './shareVersion'

export interface ShareOffer {
  title: string
  /** When the link stops working, or null when it never does. */
  expiresAt: number | null
  /** When the sender last replaced the desk behind the link. Absent from older servers. */
  updatedAt?: number
  sizeBytes: number
  rootId: string
}

/** Does this link run out? False for a link that never expires. */
export function linkExpires(offer: Pick<ShareOffer, 'expiresAt'>): boolean {
  return !expiresNever(offer.expiresAt)
}

export type ShareRefusal = 'unknown' | 'revoked' | 'expired' | 'offline' | 'unavailable'

/** The refusals that mean the link is gone for good, so its copy goes too. */
export type GoneRefusal = 'unknown' | 'revoked' | 'expired'

export function linkIsGone(reason: ShareRefusal): reason is GoneRefusal {
  return reason === 'unknown' || reason === 'revoked' || reason === 'expired'
}

/**
 * What a non-OK answer from a public share route means.
 *
 * Gone is only ever Signal saying so in its own words: { ok: false, reason }
 * with 404 'unknown', or 410 'revoked' / 'expired'. Everything else is
 * 'unavailable' -- Signal's 503 { reason: 'unavailable' } (the share is live
 * but its desk cannot be read just now), a proxy's 502 page while the machine
 * restarts, a 429, a 404 that is not Signal's. Deleting somebody's work on the
 * strength of an answer we cannot attribute is the one mistake here that
 * cannot be taken back; keeping a copy one visit too long can.
 */
export function refusalFrom(status: number, body: unknown): ShareRefusal {
  const b = (body ?? null) as { ok?: unknown; reason?: unknown } | null
  const fromSignal = b !== null && b.ok === false
  if (b?.reason === 'unavailable') return 'unavailable'
  if (fromSignal && status === 410) return b.reason === 'revoked' ? 'revoked' : 'expired'
  if (fromSignal && status === 404 && b.reason === 'unknown') return 'unknown'
  return 'unavailable'
}

/**
 * What to do with this browser's copy when the offer for `token` could not be
 * read.
 *
 *   explain    nothing of this link's is here (another link's copy may be):
 *              say why, and delete NOTHING. A mistyped link, someone else's
 *              revoked link, a link mangled by a mail client -- none of them
 *              is this browser's copy, and none of them may erase it.
 *   wipe       the link is gone (or, unreachable, its own clock has run out),
 *              this browser's copy came from it, and nothing else is here:
 *              the whole store goes with it
 *   forget     the same, but other links' desks are here too: only this
 *              link's desk goes (shareDesk.dropLinkCopy)
 *   open-copy  the link is only unreachable, and this browser holds its copy:
 *              open that, as the visitor left it
 *
 * `mine` is this link's record (shareVersion.linkRecord), null when this
 * browser holds nothing from it. Its offer is what the copy was unpacked from;
 * without one the copy cannot be opened (it does not say which desk), but it
 * is kept. `othersPresent` is shareVersion.othersPresent(token).
 */
export function whenRefused(
  reason: ShareRefusal,
  mine: Pick<LinkRecord, 'offer'> | null,
  othersPresent: boolean,
  now = Date.now()
):
  | { action: 'wipe' | 'forget'; reason: GoneRefusal }
  | { action: 'open-copy'; offer: ShareOffer }
  | { action: 'explain'; reason: ShareRefusal } {
  const drop = (why: GoneRefusal): { action: 'wipe' | 'forget'; reason: GoneRefusal } =>
    ({ action: othersPresent ? 'forget' : 'wipe', reason: why })
  if (!mine) return { action: 'explain', reason }
  if (linkIsGone(reason)) return drop(reason)
  const cached = mine.offer
  if (!cached) return { action: 'explain', reason }
  // A timed link's clock does not stop because the server cannot be reached:
  // past it, the server would be saying "expired", and the copy goes as it
  // would have.
  if (linkExpires(cached) && msLeft(cached.expiresAt, now) === 0) return drop('expired')
  return { action: 'open-copy', offer: cached }
}

/** What the share page says for each refusal. */
export function refusalLine(reason?: ShareRefusal): string {
  switch (reason) {
    case 'expired':
      return 'That share has expired, and the desk it held has been deleted.'
    case 'revoked':
      return 'That share was turned off by the person who sent it.'
    case 'offline':
      return 'That link could not be reached just now. Check your connection and try again.'
    case 'unavailable':
      // Not gone, so not "expired": the same link is expected to work again.
      return 'That shared desk is temporarily unavailable. Try the link again in a few minutes.'
    case 'unknown':
      return 'That link is not a share we recognise. It may have already been deleted.'
    default:
      return 'Plexii is a desktop app. Your desks, files and notes live on your own machine.'
  }
}

const urlFor = (path: string): string => signalConfig.httpUrl.replace(/\/+$/, '') + path

/**
 * A share token exactly as Signal mints one: randomBytes(24) in base64url
 * (focusbuddy-signal/src/ephemeralShares.ts), which is 32 characters of
 * [A-Za-z0-9_-] with no padding -- and has been since the first link was minted.
 *
 * Exact, and followed by anything that cannot be part of a token, because mail
 * and chat clients carry punctuation into the link: "see plexiidesk.com/share/s/
 * <token>." arrives with the full stop, "(link: .../s/<token>)" with the bracket.
 * Reading "<token>." as no token at all sent the visitor to the download page;
 * reading it as a 33-character token asked Signal about a link that does not
 * exist. Both are the right link, and now read as it.
 */
const TOKEN = /([A-Za-z0-9_-]{32})(?![A-Za-z0-9_-])/
const TOKEN_IN_PATH = new RegExp(`/s/${TOKEN.source}`)
const TOKEN_ALONE = new RegExp(`^${TOKEN.source}`)

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
    const m = TOKEN_IN_PATH.exec(url.pathname)
    if (m) return m[1]
    const q = url.searchParams.get('share')
    const qm = q ? TOKEN_ALONE.exec(q) : null
    return qm ? qm[1] : null
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
    const body = (await res.json().catch(() => null)) as { ok?: boolean; share?: ShareOffer; reason?: unknown } | null
    if (res.ok && body?.ok && body.share) {
      // The never-expires sentinel is mapped to null by the server; mapping it
      // again here costs nothing and means a response that slipped through
      // unmapped still shows no countdown to the year 9999.
      return { ok: true, offer: { ...body.share, expiresAt: normaliseExpiresAt(body.share.expiresAt) } }
    }
    return { ok: false, reason: refusalFrom(res.status, body) }
  } catch {
    // A network failure is not a dead link, and telling someone their link has
    // expired when their wifi dropped is a lie they will act on.
    return { ok: false, reason: 'offline' }
  }
}

/**
 * The bundle itself, as text — it goes straight to the Worker to be imported.
 * A refusal says why, so that "gone" and "not right now" are never confused.
 */
export async function fetchShareBundle(
  token: string
): Promise<{ ok: true; text: string } | { ok: false; reason: ShareRefusal }> {
  try {
    const res = await fetch(urlFor(`/public/shares/${encodeURIComponent(token)}/bundle`), { cache: 'no-store' })
    if (res.ok) return { ok: true, text: await res.text() }
    const body = await res.json().catch(() => null)
    return { ok: false, reason: refusalFrom(res.status, body) }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

// The SQLite pool VFS keeps the database in a directory named '.' + the VFS
// name, and worker/sqlite.ts installs it as 'plexii'. Emptying the store removes
// this FIRST (emptyOpfs). tests/unit/shareLinkRound2.test.ts keeps the two in step.
const DB_POOL_ENTRY = '.plexii'
// Set when a link that was the only thing in this browser went while its
// database was open in this tab: the desk's rows went at once, and the rest of
// the store goes at the start of the next load, before anything opens it.
const WIPE_PENDING_KEY = 'fb.share.wipePending'

/** Does this browser hold a desk unpacked from this link? */
export function alreadyImported(token: string): boolean {
  return linkRecord(token) !== null
}

/**
 * This link's desk is unpacked here, made from the version the offer named.
 * That version is the offer's updatedAt as read BEFORE the bundle was fetched,
 * so if the sender updated in between, the copy is recorded as older than it
 * is: the cost is one unnecessary "new version" on the next visit, and the
 * alternative -- recording a newer version than the copy holds -- would hide a
 * real update. Other links' records are not touched (shareVersion.recordUnpacked).
 */
export function markImported(token: string, version: number | null | undefined, offer: ShareOffer): void {
  recordUnpacked(token, version, offer)
}

/**
 * The offer was read again for a link this browser holds a desk from: keep the
 * newest, so a copy unpacked before offers were remembered (or by an older
 * build) can still be opened the next time the server cannot be asked. The
 * desk, the clock and the size do not change for a link; the title may.
 */
export function refreshCachedOffer(token: string, offer: ShareOffer): void {
  refreshRecordOffer(token, offer)
}

/**
 * The offer this link's desk was unpacked from, for opening it when the server
 * cannot be asked. Null when this browser holds nothing from the link, or does
 * not know which desk it is.
 */
export function cachedOffer(token: string): ShareOffer | null {
  return linkRecord(token)?.offer ?? null
}

async function opfsEntryNames(root: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = []
  for await (const name of (root as unknown as { keys: () => AsyncIterable<string> }).keys()) names.push(name)
  return names
}

/** Remove every OPFS root entry. True when nothing is left. */
async function removeOpfsEntries(root: FileSystemDirectoryHandle): Promise<boolean> {
  for (const name of await opfsEntryNames(root)) {
    await root.removeEntry(name, { recursive: true }).catch(() => undefined)
  }
  return (await opfsEntryNames(root)).length === 0
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Empty OPFS in the one order that is safe to stop halfway through: the
 * database first, then everything else.
 *
 * The store is a database plus the file bytes its rows point at. Removing in
 * whatever order the directory lists them could take the bytes and then fail
 * on the database, leaving a copy that opens with every picture blank. Database
 * first means the only partial outcomes are "nothing removed" and "the database
 * is gone and some bytes nothing points at are left over".
 *
 *   { ok: false }               the database would not go (another tab has it
 *                               open); nothing else was touched
 *   { ok: true, leftover: [] }  everything is gone
 *   { ok: true, leftover }      the database is gone; these would not go. They
 *                               are orphans: no row refers to them
 */
export async function emptyOpfs(
  root: FileSystemDirectoryHandle,
  retryMs = 250
): Promise<{ ok: false } | { ok: true; leftover: string[] }> {
  for (let attempt = 0; ; attempt++) {
    let present: boolean
    try {
      if ((await opfsEntryNames(root)).includes(DB_POOL_ENTRY)) {
        await root.removeEntry(DB_POOL_ENTRY, { recursive: true }).catch(() => undefined)
      }
      present = (await opfsEntryNames(root)).includes(DB_POOL_ENTRY)
    } catch {
      // The store could not even be listed, so the database cannot be shown
      // to be gone. Treated as still there.
      present = true
    }
    if (!present) break
    // A page that has just reloaded can still be releasing its handles.
    if (attempt === 3) return { ok: false }
    await pause(retryMs * (attempt + 1))
  }
  // The database is gone; from here on the copy cannot be kept, so the rest is
  // removed as thoroughly as it can be and whatever stays is reported.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (await removeOpfsEntries(root)) return { ok: true, leftover: [] }
    } catch {
      /* listing failed; try again */
    }
    await pause(retryMs * (attempt + 1))
  }
  try {
    return { ok: true, leftover: await opfsEntryNames(root) }
  } catch {
    return { ok: true, leftover: ['(the store could not be listed)'] }
  }
}

/**
 * Erase everything this browser holds from share links: the OPFS database, the
 * file bytes beside it, and every record of a link.
 *
 * ONLY for a browser whose one link is gone (whenRefused 'wipe'), and only from
 * a tab that has not opened the database itself -- an open database cannot be
 * removed, and this would then leave the rows behind with nothing recording
 * them. Called through shareDesk.dropLinkCopy, never directly by the page.
 *
 * True when the database went. When it did not (another tab is holding it),
 * its rows are still there with no record, and the next decision is told so.
 */
export async function wipeLocalCopy(): Promise<boolean> {
  forgetAllLinkRecords()
  try {
    // The renderer's per-tab state names widgets of the old copy.
    sessionStorage.clear()
  } catch {
    /* nothing to clear */
  }
  let databaseGone = true
  try {
    // OPFS holds both the SQLite pool and the Drive bytes: the database first,
    // for the same reason as everywhere else (emptyOpfs).
    databaseGone = (await emptyOpfs(await navigator.storage.getDirectory(), 100)).ok
  } catch {
    /* no OPFS: nothing was ever stored */
  }
  // Rows nobody has a record of are still here: say so, so that no later
  // decision takes this browser for empty.
  if (!databaseGone) setUntrackedDesksPossible(true)
  return databaseGone
}

/** Ask the next load to finish emptying the store, before it opens the database. */
export function requestWipeOnNextLoad(): void {
  try {
    localStorage.setItem(WIPE_PENDING_KEY, '1')
  } catch {
    /* the desk's rows are already gone; only the empty store stays */
  }
}

/**
 * Finish a wipe an earlier page asked for (requestWipeOnNextLoad). Called first
 * thing, before this page has opened the database. Done only when no link has
 * been unpacked since -- a desk from a link opened in between is not the old
 * link's to take -- and asked for once either way.
 */
export async function finishPendingWipe(): Promise<void> {
  let pending = false
  try {
    pending = localStorage.getItem(WIPE_PENDING_KEY) === '1'
    if (pending) localStorage.removeItem(WIPE_PENDING_KEY)
  } catch {
    return
  }
  if (!pending) return
  if (Object.keys(readLinkRecords()).length > 0) return
  await wipeLocalCopy()
}

/** Milliseconds left, floored at zero. Infinity for a link that never expires. */
export const msLeft = (expiresAt: number | null, now = Date.now()): number =>
  expiresNever(expiresAt) ? Infinity : Math.max(0, (expiresAt as number) - now)

/**
 * A countdown that reads at a glance.
 *
 * Coarse while there is time and precise near the end, because those are the two
 * different questions a recipient is actually asking.
 *
 * Empty for a link that never expires: there is no countdown to show, and the
 * callers show none.
 */
export function countdown(expiresAt: number | null, now = Date.now()): string {
  if (expiresNever(expiresAt)) return ''
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
