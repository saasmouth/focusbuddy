// The page's side of "this link's desk": open it, put a newer version in its
// place, or take it out -- one link at a time, never another link's.
//
// The rows themselves are worked on in the Worker (worker/shareCopy.ts), over
// the 'shareCopy:*' channels. What lives here is everything that has to be
// decided on the page: which link's record says what (shareVersion.ts), whether
// another tab is showing the desk, and what to tell the visitor.
//
// THE THREE RULES THIS FILE KEEPS
//
//   1. A link this browser never unpacked takes nothing (dropLinkCopy returns
//      at once without a record). The share page used to empty the whole store
//      for a bare visit, a mistyped link, or somebody else's revoked link.
//   2. A link that did, and is gone, takes its own desk -- or the whole store
//      only when nothing else is in it (whenRefused 'wipe' vs 'forget').
//   3. Replacing a link's desk removes that desk's rows and nothing else. The
//      import is INSERT OR IGNORE, so the old rows MUST go first or the old
//      version stays on screen under the new version's record; other links'
//      desks, and documents or files they also show, are left exactly as they
//      are (shareCopy.deskRows).
//
// FETCHING COUNTS AS AN OPEN. Signal counts every bundle download as an open of
// the link, so the bundle is fetched only to unpack a desk or to replace it with
// a newer version. A returning visitor whose copy is current costs the sender's
// count nothing: the offer (metadata) is read, and the desk opens from here.
import { dbCall, startCoordinator } from './dbClient'
import {
  fetchShareBundle, linkIsGone, markImported, wipeLocalCopy, requestWipeOnNextLoad,
  type ShareOffer, type ShareRefusal
} from './share'
import {
  editedStateOfDesk, forgetLinkRecord, forgetLinkRecordsForDesk, linkRecord, linksSharingDesk,
  otherLinkTokens, othersPresent, readLinkRecords, recordAdopted, setUntrackedDesksPossible, untrackedDesksPossible
} from './shareVersion'
import { markShareRecipient, setShareDeskId } from '@renderer/lib/shareMode'
import type { RemovedDesk, ReplaceOutcome } from '../worker/shareCopy'
import type { DeskBundle } from '../../main/db/deskBundle'

// ── The Worker's side, by channel ──────────────────────────────────────────

const call = <T>(channel: string, args: unknown[]): Promise<T> => {
  // Idempotent. A refusal page that has to take one desk out of a browser
  // holding several needs the database without the rest of window.api.
  startCoordinator()
  return dbCall(channel, args) as Promise<T>
}

export const deskPresent = (rootId: string): Promise<boolean> => call('shareCopy:deskPresent', [rootId])
export const rootDesks = (): Promise<string[]> => call('shareCopy:rootDesks', [])
export const removeDesk = (rootId: string): Promise<RemovedDesk> => call('shareCopy:removeDesk', [rootId])
export const replaceDesk = (rootIds: string[], bundle: DeskBundle): Promise<ReplaceOutcome> =>
  call('shareCopy:replaceDesk', [rootIds, bundle])
const importDesk = (bundle: DeskBundle): Promise<{ ok?: boolean; reason?: string } | null> =>
  call('shares:importBundle', [bundle])

// ── Which tab is showing which desk ─────────────────────────────────────────
//
// A tab showing a desk holds a SHARED Web Lock named for it for as long as it
// shows it. Replacing or removing a desk first takes the same lock EXCLUSIVELY,
// which it gets only when no other tab is showing that desk -- so a desk is
// never pulled out from under a tab that has it on screen (whose next save
// would write the old version back over the new one). Another tab showing a
// DIFFERENT link's desk does not stand in the way. The browser releases a
// tab's locks when it closes or navigates, including on reload.

export const DESK_LOCK_PREFIX = 'plexii.share.desk.'
const held = new Map<string, () => void>()

type Locks = Pick<LockManager, 'request'>
const lockManager = (): Locks | null => {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: Locks }).locks : undefined
  return locks?.request ? locks : null
}

/** This tab is showing `rootId`: hold its lock until the tab goes (or releaseDesk). */
export function holdDesk(rootId: string): void {
  const locks = lockManager()
  if (!locks || !rootId || held.has(rootId)) return
  let release: () => void = () => undefined
  const done = new Promise<void>((r) => (release = r))
  held.set(rootId, release)
  void locks.request(DESK_LOCK_PREFIX + rootId, { mode: 'shared' }, () => done).catch(() => undefined)
}

/** This tab stops showing `rootId` (it is about to remove it). */
export function releaseDesk(rootId: string): void {
  held.get(rootId)?.()
  held.delete(rootId)
}

/**
 * Run `fn` while no other tab is showing any of `rootIds`. Waits up to `waitMs`
 * for a tab that is just reloading to let go; past that, another tab really has
 * the desk open, and `fn` does not run.
 */
export async function withDesksToThisTab<T>(
  rootIds: string[],
  fn: () => Promise<T>,
  waitMs = 3000
): Promise<{ ok: true; value: T } | { ok: false }> {
  const locks = lockManager()
  const ids = [...new Set(rootIds.filter(Boolean))].sort()
  // No Web Locks: this browser runs one tab at a time (dbClient), so there is
  // no other tab to wait for.
  if (!locks) return { ok: true, value: await fn() }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), waitMs)
  let entered = false
  const take = async (i: number): Promise<T> => {
    if (i === ids.length) {
      clearTimeout(timer)
      entered = true
      return fn()
    }
    return locks.request(DESK_LOCK_PREFIX + ids[i], { mode: 'exclusive', signal: abort.signal }, () => take(i + 1)) as Promise<T>
  }
  try {
    return { ok: true, value: await take(0) }
  } catch (err) {
    clearTimeout(timer)
    // Only a lock that was never granted means "open elsewhere"; an error from
    // `fn` itself is the caller's to hear.
    if (entered) throw err
    return { ok: false }
  }
}

// ── Taking a link's desk out ────────────────────────────────────────────────

/**
 * The link `token` is gone (or its clock ran out): take its copy out of this
 * browser, and nothing that is not its own.
 *
 *   no record for the link   nothing happens. It is not this browser's copy.
 *                            (One exception, `showing`: the tab whose clock ran
 *                            out has the desk on screen, so it knows the desk
 *                            is this link's even if another tab of the same
 *                            link has already dropped the record.)
 *   'wipe'                   the link was the only thing here: the whole store
 *                            goes -- at once when this tab has not opened the
 *                            database, otherwise this desk's rows now and the
 *                            rest at the start of the next load
 *   'forget'                 other links' desks are here: only this link's
 *                            desk goes, and only when no other link still
 *                            names the same desk
 *
 * A desk another tab is showing is left where it is, and so is its record, so
 * the next visit tries again; nothing else is touched either way.
 */
export async function dropLinkCopy(
  token: string,
  how: 'wipe' | 'forget',
  opts: { databaseOpenHere?: boolean; showing?: string } = {}
): Promise<void> {
  const mine = linkRecord(token)
  if (!mine && !opts.showing) return
  if (mine && how === 'wipe' && !opts.databaseOpenHere) {
    await wipeLocalCopy()
    return
  }
  let wholeStore = how === 'wipe'
  let root = mine?.rootId ?? opts.showing ?? null
  if (!root) {
    // A copy from an older build that never said which desk it was. If the
    // database holds exactly one desk and no other link is recorded, that desk
    // can only be this link's (the older build emptied the whole store
    // whenever anything was refused, so every desk here is from a link opened
    // since -- and this one, the last opened, is the only one left). Anything
    // more, and they cannot be told apart: all of them stay.
    const roots = otherLinkTokens(token).length === 0 ? await rootDesks().catch(() => null) : null
    if (roots && roots.length === 1) {
      root = roots[0]
      wholeStore = true
    } else {
      forgetLinkRecord(token)
      if (!roots || roots.length > 0) setUntrackedDesksPossible(true)
      else setUntrackedDesksPossible(false)
      return
    }
  }
  if (Object.entries(readLinkRecords()).some(([t, r]) => t !== token && r.rootId === root)) {
    // Another link in this browser shows this same desk and is not gone.
    forgetLinkRecord(token)
    return
  }
  releaseDesk(root)
  let removed = false
  try {
    removed = (await withDesksToThisTab([root], () => removeDesk(root))).ok
  } catch (err) {
    console.warn('[share] the desk could not be removed; it will be tried again on the next visit', err)
  }
  if (!removed) return
  forgetLinkRecord(token)
  if (wholeStore) {
    setUntrackedDesksPossible(false)
    requestWipeOnNextLoad()
  }
}

// ── Opening a link's desk ───────────────────────────────────────────────────

/** Said above the desk once it is open. Mirrors boot.tsx's UpdateNotice. */
export type DeskNotice =
  | { kind: 'loaded' }
  | { kind: 'blocked'; why: 'open-elsewhere' | 'unreadable' }
  | { kind: 'ask-unsure'; version: number | null; shared: boolean; existing: boolean }

export type OpenOutcome =
  | { kind: 'open'; bundleText: string | null; notice: DeskNotice | null }
  // The bundle could not be fetched. A gone link's copy has been dealt with.
  | { kind: 'refused'; reason: ShareRefusal }
  | { kind: 'failed'; detail: string }

/** A newer version, fetched by the boot before the database was opened. */
export interface ReplacePlan {
  text: string
  /** The visitor asked for it (the banner), rather than it being an untouched copy. */
  asked: boolean
}

type ReplaceResult =
  | { ok: true }
  | { ok: false; why: 'open-elsewhere' | 'unreadable' }
  | { ok: false; why: 'failed'; detail: string }

/**
 * Put `text` (a fetched bundle) in place of this link's desk, and record it.
 *
 * The desks taken out are this link's desk as recorded, the desk the offer now
 * names, and the desk the bundle names -- normally all one id.
 */
export async function replaceLinkDesk(token: string, offer: ShareOffer, text: string): Promise<ReplaceResult> {
  let bundle: DeskBundle
  try {
    bundle = JSON.parse(text) as DeskBundle
  } catch {
    return { ok: false, why: 'unreadable' }
  }
  const mine = linkRecord(token)
  const roots = [...new Set([mine?.rootId, offer.rootId, bundle?.desk?.id])].filter(
    (r): r is string => typeof r === 'string' && r !== ''
  )
  let locked: { ok: true; value: ReplaceOutcome } | { ok: false }
  try {
    locked = await withDesksToThisTab(roots, () => replaceDesk(roots, bundle))
  } catch (err) {
    return { ok: false, why: 'failed', detail: (err as Error).message }
  }
  if (!locked.ok) return { ok: false, why: 'open-elsewhere' }
  const out = locked.value
  if (!out.ok && out.removed === null) {
    console.warn('[share] the new version was not unpacked; the copy is unchanged:', out.reason)
    return { ok: false, why: 'unreadable' }
  }
  if (!out.ok) {
    // The old rows went and the new ones did not land: whatever named these
    // desks is wrong now. Forgetting it makes the next visit unpack from scratch.
    for (const r of roots) forgetLinkRecordsForDesk(r)
    forgetLinkRecord(token)
    return { ok: false, why: 'failed', detail: out.reason }
  }
  markImported(token, offer.updatedAt ?? null, offer)
  resetTabState(token, offer.rootId)
  return { ok: true }
}

/**
 * The renderer keeps per-tab state in sessionStorage that names widgets of the
 * desk it last showed; after a replacement those may be gone. The two keys the
 * share page itself keeps there are put straight back.
 */
function resetTabState(token: string, rootId: string): void {
  try {
    sessionStorage.clear()
  } catch {
    /* nothing to clear */
  }
  markShareRecipient(token)
  setShareDeskId(rootId)
}

/** The bundle could not be fetched: a gone link's own copy goes (dropLinkCopy). */
async function refused(token: string, reason: ShareRefusal): Promise<OpenOutcome> {
  if (linkIsGone(reason)) {
    await dropLinkCopy(token, othersPresent(token) ? 'forget' : 'wipe', { databaseOpenHere: true })
  }
  return { kind: 'refused', reason }
}

/**
 * Get this link's desk ready to show. Called once window.api is up (the
 * database is reachable) and before the renderer is imported.
 *
 *   a newer version, fetched    replace this link's desk with it (`plan`)
 *   a copy that is here         open it; NOTHING is fetched
 *   the desk is already here    from another link to the same desk, or an
 *   but not from this link      older build: replaced if positively untouched,
 *                               otherwise kept and asked about
 *   nothing here                fetch and unpack
 */
export async function openLinkDesk(token: string, offer: ShareOffer, plan: ReplacePlan | null): Promise<OpenOutcome> {
  const outcome = await openLinkDeskInner(token, offer, plan)
  if (outcome.kind === 'open') await settleUntracked()
  return outcome
}

async function openLinkDeskInner(token: string, offer: ShareOffer, plan: ReplacePlan | null): Promise<OpenOutcome> {
  const mine = linkRecord(token)
  if (plan && mine) {
    const r = await replaceLinkDesk(token, offer, plan.text)
    if (r.ok) return { kind: 'open', bundleText: plan.text, notice: plan.asked ? { kind: 'loaded' } : null }
    if (r.why === 'failed') return { kind: 'failed', detail: r.detail }
    return { kind: 'open', bundleText: null, notice: { kind: 'blocked', why: r.why } }
  }

  if (mine && (await deskPresent(mine.rootId ?? offer.rootId))) {
    return { kind: 'open', bundleText: null, notice: null }
  }
  // A record whose desk is not here (the browser cleared site data under it,
  // say) is no copy at all: it is unpacked again below, as a first visit is.

  if (await deskPresent(offer.rootId)) {
    const edited = editedStateOfDesk(offer.rootId, token)
    if (edited !== false) {
      // Somebody's work may be in these rows. Kept, and asked about.
      recordAdopted(token, offer, edited)
      return {
        kind: 'open',
        bundleText: null,
        notice: { kind: 'ask-unsure', version: offer.updatedAt ?? null, shared: linksSharingDesk(token).length > 0, existing: true }
      }
    }
    const got = await fetchShareBundle(token)
    if (!got.ok) return refused(token, got.reason)
    const r = await replaceLinkDesk(token, offer, got.text)
    if (r.ok) return { kind: 'open', bundleText: got.text, notice: null }
    if (r.why === 'failed') return { kind: 'failed', detail: r.detail }
    recordAdopted(token, offer, edited)
    return { kind: 'open', bundleText: null, notice: { kind: 'blocked', why: r.why } }
  }

  const got = await fetchShareBundle(token)
  if (!got.ok) return refused(token, got.reason)
  let bundle: DeskBundle
  try {
    bundle = JSON.parse(got.text) as DeskBundle
  } catch {
    return { kind: 'failed', detail: 'the desk could not be read' }
  }
  const res = await importDesk(bundle)
  if (!res?.ok) return { kind: 'failed', detail: res?.reason ?? 'the desk could not be unpacked' }
  markImported(token, offer.updatedAt ?? null, offer)
  return { kind: 'open', bundleText: got.text, notice: null }
}

/**
 * A browser migrated from an older build may hold desks nothing records
 * (untrackedDesksPossible). Once the database is reachable, look: if every
 * top-level desk here belongs to a recorded link, there are none, and a gone
 * link may again be judged the only thing in this browser.
 */
async function settleUntracked(): Promise<void> {
  if (!untrackedDesksPossible()) return
  try {
    const known = new Set(Object.values(readLinkRecords()).map((r) => r.rootId).filter(Boolean))
    const roots = await rootDesks()
    if (roots.every((r) => known.has(r))) setUntrackedDesksPossible(false)
  } catch {
    /* still unknown; it stays set, which only ever keeps things */
  }
}
