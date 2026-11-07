// A "Live web view" link, opened in the full app.
//
// Owner, 2026-11-07: "they all should be the same, just the interactivity that
// changes. Should be full web version of the local app." A live link
// (view.plexiidesk.com/share/dsk_…, minted by "Live web view → Publish this
// desk to the web") used to open a separate read-only viewer drawing the
// desk's PROJECTION. Now the desktop also keeps the desk itself -- the same
// bundle a "desk they can use" link carries -- beside it on Signal
// (PUT /shares/desks/:token/bundle), and this page opens that, like any other
// link: /share/l/<dsk_token>. The visitor may look around and arrange it
// (VisitorMode 'view'); the desk follows the sender, so a newer one replaces it.
//
//   GET /share/:token?meta=1           kind 'desk', title, revoked, bundleUpdatedAt
//   GET /share/:token/desk/bundle      the desk, latest only
//
// A live link whose desk has not been sent yet (the sender's app predates this,
// or has not run since) cannot open here: the page says so and points at the
// classic viewer, which still draws the projection.
import { signalConfig } from '@renderer/lib/signalConfig'
import { ACTIVE } from '@shared/productDomains'
import { normaliseExpiresAt } from '@shared/shareExpiry'
import type { ShareOffer, ShareRefusal } from './share'

/** A live-desk token as Signal mints one: dsk_ and a long url-safe tail. */
const LIVE_TOKEN = /(dsk_[A-Za-z0-9_-]{8,120})(?![A-Za-z0-9_-])/
const LIVE_TOKEN_IN_PATH = new RegExp(`/l/${LIVE_TOKEN.source}`)

/** The live token in the address bar (/l/<token>, or /share/l/<token> on the site), or null. */
export function liveTokenFromUrl(href = window.location.href): string | null {
  try {
    const m = LIVE_TOKEN_IN_PATH.exec(new URL(href).pathname)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** Where the classic viewer still draws a live link (?classic=1: it must not send the visitor back here). */
export function classicViewerUrl(token: string): string {
  return `${ACTIVE.viewer}/share/${encodeURIComponent(token)}?classic=1`
}

const urlFor = (path: string): string => signalConfig.httpUrl.replace(/\/+$/, '') + path

interface LiveRecord {
  kind?: unknown
  title?: unknown
  revoked?: unknown
  expiresAt?: unknown
  bundleUpdatedAt?: unknown
}

/** What a non-OK answer means for a live link. */
function refusalFrom(status: number, body: { error?: unknown; reason?: unknown } | null): ShareRefusal {
  const code = String(body?.error ?? body?.reason ?? '')
  if (status === 404 || status === 410 || /revoked|expired|unknown|not_found|gone/.test(code)) return 'gone'
  return 'unavailable'
}

/** Read a live link's record into an offer, or why it cannot open. Exported for tests. */
export function liveOffer(record: LiveRecord): { ok: true; offer: ShareOffer } | { ok: false; reason: ShareRefusal } {
  if (record.revoked === true) return { ok: false, reason: 'gone' }
  if (record.kind !== 'desk') return { ok: false, reason: 'not-a-desk' }
  const updatedAt = typeof record.bundleUpdatedAt === 'number' ? record.bundleUpdatedAt : null
  if (updatedAt === null) return { ok: false, reason: 'not-ready' }
  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : null
  return {
    ok: true,
    offer: {
      title: typeof record.title === 'string' ? record.title : '',
      expiresAt: normaliseExpiresAt(expiresAt),
      updatedAt,
      // Named inside the desk itself, as for a read link: filled from this
      // browser's record of the link, or from the desk when it is unpacked.
      sizeBytes: 0,
      rootId: '',
      mode: 'view'
    }
  }
}

/** What the link offers, without counting a view. */
export async function previewLiveShare(token: string): Promise<
  { ok: true; offer: ShareOffer } | { ok: false; reason: ShareRefusal }
> {
  try {
    const res = await fetch(urlFor(`/share/${encodeURIComponent(token)}?meta=1`), { cache: 'no-store' })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; record?: LiveRecord; error?: unknown } | null
    if (res.ok && body?.ok && body.record) return liveOffer(body.record)
    return { ok: false, reason: refusalFrom(res.status, body) }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

/** The desk behind the link, as text, for the Worker to import. */
export async function fetchLiveShareBundle(
  token: string
): Promise<{ ok: true; text: string } | { ok: false; reason: ShareRefusal }> {
  try {
    const res = await fetch(urlFor(`/share/${encodeURIComponent(token)}/desk/bundle`), { cache: 'no-store' })
    if (res.ok) return { ok: true, text: await res.text() }
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    if (res.status === 404 && body?.error === 'no_bundle') return { ok: false, reason: 'not-ready' }
    return { ok: false, reason: refusalFrom(res.status, body) }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

/** When the sender last sent the desk, or null when it cannot be asked. */
export async function liveBundleUpdatedAt(token: string): Promise<number | null> {
  const got = await previewLiveShare(token)
  return got.ok ? (got.offer.updatedAt ?? null) : null
}
