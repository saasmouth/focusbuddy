// Handing someone a desk through a link -- for 48 hours, a few weeks, or for good.
//
// This is the OTHER sharing mechanism, and the difference from deskShareClient
// is worth stating plainly because the two look alike from the outside:
//
//   deskShareClient  — a named person, an account, a lasting grant, and a desk
//                      that keeps syncing in both directions.
//   this             — anyone with the link, no account, a snapshot, one way,
//                      and gone when the link expires (if it ever does).
//
// The second is for showing a desk to someone who is not a Plexii user yet. They
// can edit what they receive, but their copy is theirs alone: nothing travels
// back, because there is no write route for a share token and a token that
// travels in a URL is not a credential. When the clock runs out the server
// deletes the bundle, and the only way to keep the desk is to put it on a
// desktop.
//
// A link can also be a STANDING one: the same URL sent to many prospects over
// weeks and months. Two things make that work. It can be told never to expire
// (expiresAt null), and the sender can replace what it shows without changing
// the URL (updateEphemeralShare) -- fixing a typo in a demo desk must not mean
// re-sending a link to everyone who already has the old one.
import { signalConfig, cloudAppUrl } from './signalConfig'
import { useAccountStore } from '../stores/account'
import {
  expiresNever, normaliseExpiresAt, utf8Bytes, linkMegabytes,
  LINK_SHARE_MAX_BODY_BYTES, LINK_SHARE_LIMIT_WORDS
} from '@shared/shareExpiry'

export interface EphemeralShare {
  token: string
  rootId: string
  title: string
  sizeBytes: number
  createdAt: number
  /** When the link stops working, or null when it never does. */
  expiresAt: number | null
  /** When the content behind the link was last replaced (createdAt if never). */
  updatedAt: number
  opens: number
  lastOpenedAt: number | null
}

/**
 * A share as the server sent it, made safe to render.
 *
 * Signal maps its never-expires sentinel to null, and rows from before updates
 * existed carry no updatedAt. Both are settled here, once, so no screen has to
 * remember that a 9999 date means "never" or that updatedAt can be missing.
 */
export function normaliseShare(raw: unknown): EphemeralShare {
  const r = (raw ?? {}) as Partial<EphemeralShare> & { expiresAt?: number | null; updatedAt?: number }
  const createdAt = Number(r.createdAt) || 0
  const updatedAt = Number(r.updatedAt)
  return {
    token: String(r.token ?? ''),
    rootId: String(r.rootId ?? ''),
    title: String(r.title ?? ''),
    sizeBytes: Number(r.sizeBytes) || 0,
    createdAt,
    expiresAt: normaliseExpiresAt(r.expiresAt),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : createdAt,
    opens: Number(r.opens) || 0,
    lastOpenedAt: typeof r.lastOpenedAt === 'number' ? r.lastOpenedAt : null
  }
}

/**
 * The expiry fields of a mint request.
 *
 *   null       → { expires: 'never' }   the share sheet's "Never"
 *   undefined  → {}                     the server's 48-hour default
 *   n > 0      → { ttlMs: n }           an explicit window, clamped server-side
 *
 * null and undefined are deliberately different. "Never" used to be sent as
 * null, which this dropped on the floor exactly like undefined, so every
 * never-expiring link quietly died after 48 hours. The 48-hour callers pass
 * nothing and must keep getting 48 hours.
 */
export function expiryFields(ttlMs: number | null | undefined): { expires: 'never' } | { ttlMs: number } | Record<string, never> {
  if (ttlMs === null) return { expires: 'never' }
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) return { ttlMs }
  return {}
}

const urlFor = (path: string): string => signalConfig.httpUrl.replace(/\/+$/, '') + path
const token = (): string | null => useAccountStore.getState().sessionToken

/** The link a recipient opens. Empty when no cloud app has been published. */
export function shareUrlFor(shareToken: string): string {
  const base = cloudAppUrl()
  return base ? `${base}/s/${shareToken}` : ''
}

export type OmittedFile = { id: string; name: string; sizeBytes: number; why: string }

export interface MintResult {
  ok: boolean
  share?: EphemeralShare
  url?: string
  filesOmitted?: OmittedFile[]
  error?: string
}

/** What Signal answered, as far as a refusal needs to know. */
type ReplyBody = { ok?: boolean; share?: unknown; error?: unknown } | null

/**
 * The words to show a sender whose mint or update was refused.
 *
 * Signal's own refusals ({ ok: false, error }) are written for a person and
 * win. Anything else -- a framework's { error: "Payload Too Large" }, a
 * proxy's HTML page, nothing at all -- is replaced by a sentence, because
 * "Payload Too Large" tells a sender neither what happened nor what to do.
 */
export function linkRefusal(status: number, body: ReplyBody, action: 'share' | 'update'): string {
  const own = body?.ok === false && typeof body.error === 'string' && body.error.trim() ? body.error.trim() : undefined
  if (own) return own
  if (status === 413) {
    return `This desk is too large to send as a link: a link can carry at most ${LINK_SHARE_LIMIT_WORDS}. Move its largest files to another desk and try again.`
  }
  if (status === 401) return action === 'share' ? 'Sign in again to share this desk.' : 'Sign in again to update this link.'
  if (status === 429) return 'Too many requests just now. Wait a minute and try again.'
  if (status >= 500) return 'The share server could not take this just now. Try again in a moment.'
  if (action === 'update') return updateRefusal(status)
  return `The server refused the share (${status}).`
}

/**
 * The request body for a mint or update, or the sentence saying it is too big
 * to send. Checked here as well as when packing, because the server's limit is
 * on the whole body and the cost of finding out from the server is uploading
 * eight megabytes to be told no.
 */
export function linkRequestBody(fields: Record<string, unknown>): { ok: true; body: string } | { ok: false; error: string } {
  const body = JSON.stringify(fields)
  const bytes = utf8Bytes(body)
  if (bytes > LINK_SHARE_MAX_BODY_BYTES) {
    return {
      ok: false,
      error: `This desk is too large to send as a link (${linkMegabytes(bytes)}; a link can carry at most ${LINK_SHARE_LIMIT_WORDS}). Move its largest files to another desk and try again.`
    }
  }
  return { ok: true, body }
}

/**
 * The files a link went out without, said plainly and grouped by why: "too big
 * for a link" and "not on this computer" are different problems with different
 * fixes. Empty when nothing was left out.
 */
export function describeOmitted(files: OmittedFile[] | undefined): string {
  if (!files?.length) return ''
  // Under a tenth of a megabyte, "0 MB" would be true and useless.
  const size = (n: number): string => (n < 100 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : linkMegabytes(n))
  const list = (fs: OmittedFile[]): string =>
    fs.map((f) => (f.sizeBytes > 0 ? `${f.name} (${size(f.sizeBytes)})` : f.name)).join(', ')
  const missing = files.filter((f) => /not on this device/.test(f.why))
  const tooBig = files.filter((f) => !missing.includes(f))
  const parts: string[] = []
  if (tooBig.length) {
    parts.push(`Left out because a link can carry at most ${LINK_SHARE_LIMIT_WORDS}: ${list(tooBig)}.`)
  }
  if (missing.length) parts.push(`Left out because the file is not on this computer: ${list(missing)}.`)
  return parts.join(' ')
}

/**
 * Pack the desk and hand it to the server.
 *
 * The packing happens in the main process (it reads the database and the file
 * bytes); only the finished bundle crosses to here, and only the account token
 * crosses to Signal.
 */
export async function mintEphemeralShare(
  deskId: string,
  // Absent keeps the server's 48-hour default. A number is an explicit window
  // (the server clamps it to MAX_SHARE_TTL_MS). null is "never expires": the
  // standing link a sender reuses for every prospect. See expiryFields.
  ttlMs?: number | null
): Promise<MintResult> {
  const t = token()
  if (!t) return { ok: false, error: 'Sign in to share a desk.' }

  // Packed to fit a link: the main process holds the bundle to the link budget
  // and names every file it had to leave out (deskBundle.buildDeskBundle).
  const built = await window.api.shares.buildDeskBundle(deskId)
  if (!built.ok) return { ok: false, error: built.error }

  const request = linkRequestBody({
    rootId: deskId,
    title: built.title,
    bundle: built.json,
    ...expiryFields(ttlMs)
  })
  if (!request.ok) return { ok: false, error: request.error }

  try {
    const res = await fetch(urlFor('/shares/ephemeral'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: request.body
    })
    const body = (await res.json().catch(() => null)) as ReplyBody
    if (!res.ok || !body?.ok || !body.share) {
      return { ok: false, error: linkRefusal(res.status, body, 'share') }
    }
    const share = normaliseShare(body.share)
    return {
      ok: true,
      share,
      url: shareUrlFor(share.token),
      // Said out loud rather than discovered by the recipient: a desk whose
      // pictures were too big to travel is still worth sharing, but the sender
      // should know before they send it.
      filesOmitted: built.filesOmitted
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function listEphemeralShares(): Promise<EphemeralShare[]> {
  const t = token()
  if (!t) return []
  try {
    const res = await fetch(urlFor('/shares/ephemeral'), { headers: { authorization: `Bearer ${t}` } })
    const body = (await res.json()) as { ok?: boolean; shares?: unknown[] }
    return body?.ok && Array.isArray(body.shares) ? body.shares.map(normaliseShare) : []
  } catch {
    return []
  }
}

export interface UpdateResult {
  ok: boolean
  share?: EphemeralShare
  filesOmitted?: OmittedFile[]
  error?: string
}

/**
 * Replace what an existing link shows with the desk as it is now.
 *
 * Same token, same URL, same expiry: everyone who already has the link gets the
 * new version the next time they open it. The bundle is built exactly as a mint
 * builds it, so an updated link carries nothing a fresh one would not.
 */
export async function updateEphemeralShare(shareToken: string, deskId: string): Promise<UpdateResult> {
  const t = token()
  if (!t) return { ok: false, error: 'Sign in to update a link.' }

  // Same packing, same budget as a mint.
  const built = await window.api.shares.buildDeskBundle(deskId)
  if (!built.ok) return { ok: false, error: built.error }

  const request = linkRequestBody({ bundle: built.json, title: built.title })
  if (!request.ok) return { ok: false, error: request.error }

  try {
    const res = await fetch(urlFor(`/shares/ephemeral/${encodeURIComponent(shareToken)}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: request.body
    })
    const body = (await res.json().catch(() => null)) as ReplyBody
    if (!res.ok || !body?.ok || !body.share) {
      // Only Signal's own refusals ({ ok: false, error }) are worded for a
      // person. A framework 404 says "Not Found", which is what an older server
      // with no update route answers, and that deserves a sentence instead.
      return { ok: false, error: linkRefusal(res.status, body, 'update') }
    }
    return { ok: true, share: normaliseShare(body.share), filesOmitted: built.filesOmitted }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** What to tell the sender when an update was refused. The server's words win. */
export function updateRefusal(status: number, serverError?: string): string {
  if (serverError) return serverError
  if (status === 410) return 'This link has expired or was turned off, so it cannot be updated. Create a new one.'
  if (status === 404) return 'This link no longer exists, or the server does not support updating links yet.'
  if (status === 403) return 'Only the account that created this link can update it.'
  if (status === 413) return linkRefusal(413, null, 'update')
  return `The server refused the update (${status}).`
}

export async function revokeEphemeralShare(shareToken: string): Promise<boolean> {
  const t = token()
  if (!t) return false
  try {
    const res = await fetch(urlFor(`/shares/ephemeral/${encodeURIComponent(shareToken)}`), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${t}` }
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * "1d 4h left", for a countdown that has to read at a glance.
 *
 * Deliberately coarse above an hour and precise below it: the number that
 * matters to a sender is whether this is still good tomorrow, and the number
 * that matters near the end is how many minutes are left.
 *
 * A link that never expires says so, rather than counting down to 9999.
 */
export function timeLeft(expiresAt: number | null, now = Date.now()): string {
  if (expiresNever(expiresAt)) return 'Never expires'
  const ms = (expiresAt as number) - now
  if (ms <= 0) return 'expired'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m left`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m left`
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`
}
