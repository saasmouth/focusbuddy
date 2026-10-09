// What this browser knows about each link it holds a desk from, and what to do
// when the sender has published a newer version of one.
//
// A standing link is sent to many people and lives for months, and the sender
// can replace what it shows without changing the URL. A visitor who opened it
// last week has a copy in this browser made from last week's version. On their
// next visit the page has to decide between three things:
//
//   keep going      the copy is the current version (or they already said
//                   "keep my copy" to this one)
//   load the new    they never changed their copy, so replacing it loses
//                   nothing -- do it without asking
//   ask             they changed it, or we cannot tell, so replacing it could
//                   destroy their work -- the choice is theirs
//
// The decision is a pure function (decideShareUpdate) so it can be tested
// without a browser; the record it reads is a few bytes of localStorage.
//
// ONE RECORD PER LINK. A prospect is often sent more than one link, and every
// link they open unpacks into the same database. The first version of this kept
// one record for the whole browser, keyed by whichever link was opened last, so
// going A -> B -> back to A found no record for A: A's newer version was never
// offered, and A's old rows stayed (unpacking is INSERT OR IGNORE). Now each
// link has its own record -- {version, declined, edited, rootId, offer} under
// fb.share.links[token] -- and replacing one link's desk removes only that
// desk's rows (worker/shareCopy.ts), so nothing about one link decides anything
// about another. The token is the record's key: it is already in this
// browser's history and address bar, and this origin already holds the desk it
// opens, so keeping it here exposes nothing new.
//
// HOW "THEY CHANGED IT" IS KNOWN. Every call the desk makes reaches the
// database through one gate (dbClient.dbCall), and that gate already classifies
// each call with readOnly.changesContent: true for a change to what the desk
// SAYS (a widget's text, a new card, a table cell), false for questions, for
// moving the furniture, and for everything the app writes on its own account.
// The first such change in a page session marks the link this tab is showing
// edited (shareEdits.noteShareEdit -> noteCopyEdited). That is the cheapest
// reliable signal there is: no diffing of databases, no hashes, one write per
// session. A share window shows exactly one desk -- the sidebar, tray and
// footer are hidden in share mode -- so "the link this tab is showing" is the
// desk that was changed. Its one blind spot is deliberate -- a visitor who only
// rearranged widgets is counted as unchanged, because the app writes layout
// itself at startup and counting layout would mark every copy edited before
// anyone touched it. The failure mode that remains points the safe way:
// anything we cannot classify is treated as changed, and changed copies are
// asked about, never replaced.
//
// TWO LINKS, ONE DESK. A sender can mint more than one link for the same desk
// (a standing link and a 48-hour one, say). Both unpack the same rows, so they
// share an edited state (noteCopyEdited marks every record with the same
// rootId), and replacing the desk for one leaves the other's record saying
// "version unknown" so its next visit puts its own version back (or asks).
import type { ShareOffer } from './share'
import { normaliseExpiresAt } from '@shared/shareExpiry'
import { shareRecipientToken } from '@renderer/lib/shareMode'

const LINKS_KEY = 'fb.share.links'
// Set when this browser may hold desks no record accounts for: a copy made by
// an older build, which unpacked every link into the one database but
// remembered only the last. While it is set, a gone link cannot be assumed to
// be the only thing here, so it never empties the whole store.
const UNTRACKED_KEY = 'fb.share.untracked'
// Per tab, so it survives exactly one reload: set when the visitor asks for the
// new version, consumed by the boot that follows.
const NEW_VERSION_KEY = 'fb.share.newVersion'
// What older builds kept: one marker, one offer and one record for the whole
// browser. Read once, by migrateLegacyRecords, and then removed.
const LEGACY_IMPORTED_KEY = 'fb.share.imported'
const LEGACY_OFFER_KEY = 'fb.share.offer'
const LEGACY_COPY_KEY = 'fb.share.copy'

export interface LinkRecord {
  /** updatedAt of the version this link's desk was unpacked from; null when unknown. */
  version: number | null
  /** The newest version the visitor chose to keep their copy over. */
  declined: number | null
  /** Has the visitor changed what this desk says? null when unknown. */
  edited: boolean | null
  /** The desk this link unpacked; null for a copy made before that was kept. */
  rootId: string | null
  /** What the offer said: enough to open the copy when the server cannot be asked. */
  offer: ShareOffer | null
}

export type LinkRecords = Record<string, LinkRecord>

/**
 * What to do with a returning visitor's copy.
 *
 *   'current'     nothing newer to offer
 *   'load'        newer, and the copy is unchanged: replace it without asking
 *   'ask'         newer, and the copy was (or may have been) changed
 *   'ask-unsure'  a copy whose version is unknown (made by an older build, or
 *                 found already here when this link was first opened): there
 *                 may be a newer version, and saying "the sender has updated
 *                 this desk" would be a guess
 */
export type UpdateDecision = 'current' | 'load' | 'ask' | 'ask-unsure'

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

export function decideShareUpdate(
  copy: Pick<LinkRecord, 'version' | 'declined' | 'edited'>,
  offerUpdatedAt: number | null | undefined
): UpdateDecision {
  // A server that does not say when the desk last changed gives nothing to
  // compare with. The copy stays as it is.
  if (!isTime(offerUpdatedAt)) return 'current'
  if (isTime(copy.version) && offerUpdatedAt <= copy.version) return 'current'
  // "Keep my copy" holds until the sender publishes something newer still.
  if (isTime(copy.declined) && offerUpdatedAt <= copy.declined) return 'current'
  // Only a copy positively known to be untouched is replaced without asking.
  if (copy.edited === false) return 'load'
  return isTime(copy.version) ? 'ask' : 'ask-unsure'
}

/** An offer as stored, checked field by field; null when it cannot open anything. */
export function sanitizeOffer(raw: unknown): ShareOffer | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<ShareOffer>
  if (typeof o.rootId !== 'string' || !o.rootId) return null
  return {
    title: typeof o.title === 'string' ? o.title : '',
    expiresAt: normaliseExpiresAt(typeof o.expiresAt === 'number' ? o.expiresAt : null),
    updatedAt: isTime(o.updatedAt) ? o.updatedAt : undefined,
    sizeBytes: typeof o.sizeBytes === 'number' ? o.sizeBytes : 0,
    rootId: o.rootId
  }
}

function sanitizeRecord(raw: unknown): LinkRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<LinkRecord>
  const offer = sanitizeOffer(r.offer)
  return {
    version: isTime(r.version) ? r.version : null,
    declined: isTime(r.declined) ? r.declined : null,
    edited: typeof r.edited === 'boolean' ? r.edited : null,
    rootId: typeof r.rootId === 'string' && r.rootId ? r.rootId : (offer?.rootId ?? null),
    offer
  }
}

/** Every link this browser holds a desk from. Empty when there are none or they cannot be read. */
export function readLinkRecords(): LinkRecords {
  try {
    const raw = localStorage.getItem(LINKS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: LinkRecords = {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    for (const [token, rec] of Object.entries(parsed)) {
      const clean = sanitizeRecord(rec)
      if (token && clean) out[token] = clean
    }
    return out
  } catch {
    return {}
  }
}

function writeLinkRecords(records: LinkRecords): void {
  try {
    if (Object.keys(records).length === 0) localStorage.removeItem(LINKS_KEY)
    else localStorage.setItem(LINKS_KEY, JSON.stringify(records))
  } catch {
    /* private mode: every visit then finds no record, and a desk already here is asked about rather than replaced */
  }
}

/** This link's record, or null when this browser holds no desk from it. */
export function linkRecord(token: string): LinkRecord | null {
  return readLinkRecords()[token] ?? null
}

/** Links other than `token` this browser holds a desk from. */
export function otherLinkTokens(token: string): string[] {
  return Object.keys(readLinkRecords()).filter((t) => t !== token)
}

/** Other links whose desk is the SAME desk as this link's (same rootId). */
export function linksSharingDesk(token: string): string[] {
  const all = readLinkRecords()
  const root = all[token]?.rootId
  if (!root) return []
  return Object.entries(all)
    .filter(([t, r]) => t !== token && r.rootId === root)
    .map(([t]) => t)
}

/** May this browser hold desks no record accounts for? (an older build's copy) */
export function untrackedDesksPossible(): boolean {
  try {
    return localStorage.getItem(UNTRACKED_KEY) === '1'
  } catch {
    // Unreadable: assume the worst, which only ever keeps things.
    return true
  }
}

export function setUntrackedDesksPossible(possible: boolean): void {
  try {
    if (possible) localStorage.setItem(UNTRACKED_KEY, '1')
    else localStorage.removeItem(UNTRACKED_KEY)
  } catch {
    /* nothing to record it in */
  }
}

/**
 * Is anything else in this browser besides `token`'s desk? Other links'
 * records, or desks an older build left without one. Decides whether a link
 * that is gone may take the whole store with it, or only its own desk.
 */
export function othersPresent(token: string): boolean {
  return otherLinkTokens(token).length > 0 || untrackedDesksPossible()
}

/**
 * `token`'s desk was just unpacked here -- fresh, or in place of its older rows
 * -- from the version the offer named.
 *
 * Any other link whose record names the same desk now points at rows that came
 * from THIS link: its version is no longer known, and the rows are untouched.
 */
export function recordUnpacked(token: string, version: number | null | undefined, offer: ShareOffer): void {
  const all = readLinkRecords()
  const cached = sanitizeOffer(offer)
  const rootId = cached?.rootId ?? offer.rootId ?? null
  all[token] = { version: isTime(version) ? version : null, declined: null, edited: false, rootId, offer: cached }
  if (rootId) {
    for (const [t, r] of Object.entries(all)) {
      if (t !== token && r.rootId === rootId) all[t] = { ...r, version: null, declined: null, edited: false }
    }
  }
  writeLinkRecords(all)
}

/**
 * `token` was opened for the first time, and its desk was ALREADY here --
 * unpacked from another link to the same desk, or by an older build -- with
 * changes that are not this page's to throw away. The rows are kept as they
 * are; the record says nothing about which version they are.
 */
export function recordAdopted(token: string, offer: ShareOffer, edited: boolean | null): void {
  const all = readLinkRecords()
  const cached = sanitizeOffer(offer)
  all[token] = { version: null, declined: null, edited, rootId: cached?.rootId ?? offer.rootId ?? null, offer: cached }
  writeLinkRecords(all)
}

/**
 * The offer was read again for a link this browser holds a desk from. The
 * newest title is the one to show, and a record made before offers (or desks)
 * were remembered learns them here.
 */
export function refreshRecordOffer(token: string, offer: ShareOffer): void {
  const all = readLinkRecords()
  const r = all[token]
  if (!r) return
  const cached = sanitizeOffer(offer)
  all[token] = { ...r, offer: cached ?? r.offer, rootId: r.rootId ?? cached?.rootId ?? null }
  writeLinkRecords(all)
}

/**
 * How changed is the desk `rootId`, as far as the records of the links that
 * unpacked it can say? Any of them changed it: changed. All of them positively
 * unchanged: unchanged. No record at all (a copy from an older build): unknown.
 */
export function editedStateOfDesk(rootId: string, exceptToken?: string): boolean | null {
  const states = Object.entries(readLinkRecords())
    .filter(([t, r]) => t !== exceptToken && r.rootId === rootId)
    .map(([, r]) => r.edited)
  if (states.length === 0) return null
  if (states.some((e) => e === true)) return true
  if (states.some((e) => e === null)) return null
  return false
}

/**
 * The visitor changed what the desk this tab is showing says. Every link whose
 * record names that desk is marked, because they all show the same rows.
 */
export function noteCopyEdited(token: string | null = shareRecipientToken()): void {
  if (!token) return
  const all = readLinkRecords()
  const r = all[token]
  if (!r) return
  let changed = false
  for (const [t, rec] of Object.entries(all)) {
    const same = t === token || (r.rootId !== null && rec.rootId === r.rootId)
    if (same && rec.edited !== true) {
      all[t] = { ...rec, edited: true }
      changed = true
    }
  }
  if (changed) writeLinkRecords(all)
}

/** The visitor chose to keep their copy of this link's desk over this version. */
export function noteVersionDeclined(token: string | null, version: number | null | undefined): void {
  if (!token || !isTime(version)) return
  const all = readLinkRecords()
  const r = all[token]
  if (!r) return
  all[token] = { ...r, declined: Math.max(version, r.declined ?? 0) }
  writeLinkRecords(all)
}

/** This link's desk is gone from this browser; so is what was known about it. */
export function forgetLinkRecord(token: string): void {
  const all = readLinkRecords()
  if (!(token in all)) return
  delete all[token]
  writeLinkRecords(all)
}

/** Every link that unpacked the desk `rootId`: its rows are gone. */
export function forgetLinkRecordsForDesk(rootId: string): void {
  const all = readLinkRecords()
  let changed = false
  for (const [t, r] of Object.entries(all)) {
    if (r.rootId === rootId) {
      delete all[t]
      changed = true
    }
  }
  if (changed) writeLinkRecords(all)
}

/** The whole store is gone; so is everything known about it. */
export function forgetAllLinkRecords(): void {
  try {
    for (const k of [LINKS_KEY, UNTRACKED_KEY, LEGACY_IMPORTED_KEY, LEGACY_OFFER_KEY, LEGACY_COPY_KEY]) localStorage.removeItem(k)
  } catch {
    /* nothing to clear */
  }
}

/**
 * Turn what an older build kept into a per-link record. Idempotent; a no-op
 * once the old keys are gone.
 *
 *   HEAD builds    fb.share.imported only: the last link opened. Its version,
 *                  edited state and desk are unknown, and earlier links may
 *                  have left desks here with no trace -- so untracked.
 *   round-2 build  that marker plus one record ({version, declined, edited,
 *                  others}) and the offer. `others` said whether other links'
 *                  desks are in the database; their tokens were never kept.
 */
export function migrateLegacyRecords(): void {
  let token: string | null
  let copyRaw: string | null
  let offerRaw: string | null
  try {
    token = localStorage.getItem(LEGACY_IMPORTED_KEY)
    copyRaw = localStorage.getItem(LEGACY_COPY_KEY)
    offerRaw = localStorage.getItem(LEGACY_OFFER_KEY)
  } catch {
    return
  }
  if (token === null && copyRaw === null && offerRaw === null) return
  const parse = (raw: string | null): unknown => {
    try {
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
  const copy = parse(copyRaw) as { version?: unknown; declined?: unknown; edited?: unknown; others?: unknown } | null
  const offer = sanitizeOffer(parse(offerRaw))
  if (token) {
    const all = readLinkRecords()
    if (!all[token]) {
      const version = copy?.version
      const declined = copy?.declined
      const edited = copy?.edited
      all[token] = {
        version: isTime(version) ? version : null,
        declined: isTime(declined) ? declined : null,
        edited: typeof edited === 'boolean' ? edited : null,
        rootId: offer?.rootId ?? null,
        offer
      }
      writeLinkRecords(all)
    }
    if (!copy || copy.others !== false) setUntrackedDesksPossible(true)
  }
  try {
    for (const k of [LEGACY_IMPORTED_KEY, LEGACY_OFFER_KEY, LEGACY_COPY_KEY]) localStorage.removeItem(k)
  } catch {
    /* read again next time; the migration is idempotent */
  }
}

/**
 * The words of the "replace my copy?" confirmation. Kept here rather than in
 * the banner because it is the only warning a visitor gets before their work
 * is removed, so what it says is tested, not just that it appears.
 *
 * Only this desk is replaced: other links' desks in this browser are not
 * touched, and the words do not claim otherwise. `shared` is the one case where
 * more than this link is affected -- another link in this browser shows the
 * same desk, so it shows the replacement too.
 */
export function replaceConfirmation(unsure: boolean, shared: boolean): string {
  const base = unsure
    ? 'This replaces your copy of this desk with the sender’s latest version, including any changes you made to it.'
    : 'This replaces your copy of this desk, and the changes you made to it, with the sender’s new version.'
  const also = shared
    ? ' Another link you opened in this browser shows this same desk, so it changes there too.'
    : ' Desks from other links in this browser are not touched.'
  return `${base}${also} It cannot be undone.`
}

/** Ask the next boot of this tab to replace the copy with the newest version. */
export function requestNewVersion(): void {
  try {
    sessionStorage.setItem(NEW_VERSION_KEY, '1')
  } catch {
    /* without sessionStorage the reload simply asks again */
  }
}

/** Was a replacement asked for? Reading it clears it, so it happens once. */
export function takeNewVersionRequest(): boolean {
  try {
    const asked = sessionStorage.getItem(NEW_VERSION_KEY) === '1'
    sessionStorage.removeItem(NEW_VERSION_KEY)
    return asked
  } catch {
    return false
  }
}
