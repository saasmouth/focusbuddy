// The share page's side of a read link: view.plexiidesk.com/share/<token>,
// opened as a desk.
//
// A desk shared as "a snapshot they can read" with scope 'copy' says anyone who
// wants it may have it. The viewer's button "Open this desk in your browser"
// sends the visitor here, to <share app>/c/<token>, and this page unpacks the
// snapshot into a desk exactly as it unpacks a 'use' link (snapshotDesk.ts) --
// no account, no install, and no desk of their own needed first.
//
// Two routes on Signal, one of which counts:
//
//   GET /share/<token>?meta=1   kind, scope, title, expiry. NOT counted as a
//                               view (server.ts says so), so the offer card and
//                               every return visit cost the link nothing.
//   GET /share/<token>          the snapshot. Counted, as the viewer's own read
//                               is. Fetched only to unpack the desk, or to hand
//                               the visitor the desk file.
//
// Signal answers both from the plexiidesk.com origins (CORS), and answers a
// share that is unknown, revoked or past its expiry the same way: 404 with
// { ok: false, error }. It does not say which, so neither does the page
// ('gone'). What it does say is the scope and the kind, and the page goes no
// further than the sender allowed: a 'view' link is refused for copying (it can
// still be read, and the refusal links there), and so is anything that is not
// a desk.
import { signalConfig } from '@renderer/lib/signalConfig'
import { viewerUrlFor } from '@renderer/lib/shareTokens'
import { normaliseExpiresAt } from '@shared/shareExpiry'
import type { ShareOffer, ShareRefusal } from './share'
import { snapshotToDeskBundle } from './snapshotDesk'

/**
 * A read token exactly as the desktop mints one (lib/shareTokens.ts
 * generateShareToken): 16 characters of its 31-letter alphabet, which leaves
 * out 0, 1, i, l and o -- and has since the first read link was made.
 *
 * Followed by anything that cannot be part of a token, for the same reason as
 * the 'use' token (share.ts): a link pasted into a sentence arrives with the
 * full stop. And distinct from a 'use' token by path (/c/ against /s/) and by
 * shape (16 of these letters against 32 of base64url), so neither page ever
 * reads the other's link: a 32-character token after /c/ has token characters
 * after its sixteenth and is not read at all.
 */
export const READ_TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
const READ_TOKEN = /([23456789abcdefghjkmnpqrstuvwxyz]{16})(?![A-Za-z0-9_-])/
const READ_TOKEN_IN_PATH = new RegExp(`/c/${READ_TOKEN.source}`)

/**
 * The read token in the address bar, or null.
 *
 * Not anchored at the start, as with /s/: the app is mounted under /share/ on
 * the marketing site (so the link is /share/c/<token>) and at the root when it
 * is served on its own.
 */
export function readTokenFromUrl(href = window.location.href): string | null {
  try {
    const m = READ_TOKEN_IN_PATH.exec(new URL(href).pathname)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * Where the visitor can still READ a link this page will not open. ?classic=1:
 * the viewer sends desk links on to this page, and must not send this one back.
 */
export function readLinkViewerUrl(token: string): string {
  return `${viewerUrlFor(encodeURIComponent(token))}?classic=1`
}

const urlFor = (path: string): string => signalConfig.httpUrl.replace(/\/+$/, '') + path

interface ReadRecord {
  kind?: unknown
  scope?: unknown
  title?: unknown
  expiresAt?: unknown
  revoked?: unknown
  fromHandle?: unknown
  snapshot?: unknown
}

/**
 * What a non-OK answer from GET /share/<token> means.
 *
 * Gone only in Signal's own words: 404 with { ok: false }. Anything else -- a
 * 503, a proxy page while the machine restarts, a rate limit, a 404 that is not
 * Signal's -- says nothing about the link and is 'unavailable', for the reason
 * share.refusalFrom gives: a gone link takes this browser's copy with it, and
 * that must never happen on the strength of an answer we cannot attribute.
 */
export function readRefusalFrom(status: number, body: unknown): ShareRefusal {
  const b = (body ?? null) as { ok?: unknown; reason?: unknown } | null
  if (b?.reason === 'unavailable') return 'unavailable'
  if (status === 404 && b !== null && typeof b === 'object' && b.ok === false) return 'gone'
  return 'unavailable'
}

/**
 * Whether the sender let this link be copied, or why not. Scope first: a
 * read-only link of any kind is the sender's choice, and is called that.
 */
export function copyRefusal(record: ReadRecord): ShareRefusal | null {
  if (record.revoked === true) return 'gone'
  if (record.scope !== 'copy') return 'view-only'
  if (record.kind !== 'task') return 'not-a-desk'
  return null
}

/**
 * Whether the link opens here at all (owner, 2026-11-07: every share link
 * opens the full app, "just the interactivity that changes"). A desk opens
 * whatever its scope; the scope decides what the visitor may do (readMode).
 * Something other than a desk -- a document, a file, a room snapshot, which
 * carries no desks inside -- is still the viewer's.
 */
export function openRefusal(record: ReadRecord): ShareRefusal | null {
  if (record.revoked === true) return 'gone'
  if (record.kind !== 'task') return 'not-a-desk'
  return null
}

/** A copyable link is a desk to use; any other scope is a desk to look at. */
export function readMode(record: ReadRecord): 'use' | 'view' {
  return record.scope === 'copy' ? 'use' : 'view'
}

/**
 * What the link offers, before anything is downloaded -- and before the view
 * counter moves (?meta=1).
 *
 * The metadata does not name the desk: that id is inside the snapshot. So the
 * offer's rootId is empty here, and is filled from this browser's record of the
 * link (a return visit) or from the snapshot when it is unpacked (a first
 * visit). sizeBytes is unknown until then too, and is 0, which the offer card
 * leaves out rather than showing as "0.0 MB".
 */
export async function previewReadShare(token: string): Promise<
  { ok: true; offer: ShareOffer } | { ok: false; reason: ShareRefusal }
> {
  try {
    const res = await fetch(urlFor(`/share/${encodeURIComponent(token)}?meta=1`), { cache: 'no-store' })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; record?: ReadRecord } | null
    if (res.ok && body?.ok && body.record) {
      const refused = openRefusal(body.record)
      if (refused) return { ok: false, reason: refused }
      const title = typeof body.record.title === 'string' ? body.record.title : ''
      const expiresAt = typeof body.record.expiresAt === 'number' ? body.record.expiresAt : null
      return {
        ok: true,
        offer: { title, expiresAt: normaliseExpiresAt(expiresAt), sizeBytes: 0, rootId: '', mode: readMode(body.record) }
      }
    }
    return { ok: false, reason: readRefusalFrom(res.status, body) }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

/**
 * The snapshot, unpacked into a desk bundle and handed back as text -- the
 * same thing fetchShareBundle hands back for a 'use' link, so everything after
 * this (shareDesk.openLinkDesk, "Save desk file") is the same code.
 */
export async function fetchReadShareBundle(
  token: string
): Promise<{ ok: true; text: string } | { ok: false; reason: ShareRefusal }> {
  try {
    const res = await fetch(urlFor(`/share/${encodeURIComponent(token)}`), { cache: 'no-store' })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; record?: ReadRecord } | null
    if (res.ok && body?.ok && body.record) {
      const refused = openRefusal(body.record)
      if (refused) return { ok: false, reason: refused }
      const made = snapshotToDeskBundle(body.record.snapshot, { fromHandle: body.record.fromHandle })
      if (!made.ok) return { ok: false, reason: made.why }
      return { ok: true, text: JSON.stringify(made.bundle) }
    }
    return { ok: false, reason: readRefusalFrom(res.status, body) }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

/**
 * The offer as this browser knows it: a returning visitor's record names the
 * desk (and its size) that the metadata route does not.
 */
export function offerWithRecordedDesk(
  offer: ShareOffer,
  record: { rootId: string | null; offer: ShareOffer | null } | null
): ShareOffer {
  const rootId = record?.rootId || record?.offer?.rootId || offer.rootId
  const sizeBytes = offer.sizeBytes || record?.offer?.sizeBytes || 0
  return { ...offer, rootId, sizeBytes }
}

/**
 * A first visit: the desk is named only inside the snapshot, so it is fetched
 * now, once, and the offer completed from it. `fetchBundle` hands that same
 * text to openLinkDesk the first time it asks, so the snapshot is downloaded
 * (and the view counted) once, not twice.
 */
export async function resolveFirstVisit(
  token: string,
  offer: ShareOffer,
  fetchOnce: (token: string) => ReturnType<typeof fetchReadShareBundle> = fetchReadShareBundle
): Promise<
  | { ok: true; offer: ShareOffer; fetchBundle: () => ReturnType<typeof fetchReadShareBundle> }
  | { ok: false; reason: ShareRefusal }
> {
  const got = await fetchOnce(token)
  if (!got.ok) return got
  let rootId = ''
  try {
    rootId = String((JSON.parse(got.text) as { desk?: { id?: unknown } }).desk?.id ?? '')
  } catch {
    /* fetchReadShareBundle only ever hands back JSON it made */
  }
  if (!rootId) return { ok: false, reason: 'unreadable' }
  let first: typeof got | null = got
  return {
    ok: true,
    offer: { ...offer, rootId, sizeBytes: new TextEncoder().encode(got.text).length },
    fetchBundle: async () => {
      if (first) {
        const text = first
        first = null
        return text
      }
      return fetchOnce(token)
    }
  }
}
