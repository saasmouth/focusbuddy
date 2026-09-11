// Handing someone a desk for 48 hours.
//
// This is the OTHER sharing mechanism, and the difference from deskShareClient
// is worth stating plainly because the two look alike from the outside:
//
//   deskShareClient  — a named person, an account, a lasting grant, and a desk
//                      that keeps syncing in both directions.
//   this             — anyone with the link, no account, a snapshot, one way,
//                      and gone in 48 hours.
//
// The second is for showing a desk to someone who is not a Plexii user yet. They
// can edit what they receive, but their copy is theirs alone: nothing travels
// back, because there is no write route for a share token and a token that
// travels in a URL is not a credential. When the clock runs out the server
// deletes the bundle, and the only way to keep the desk is to put it on a
// desktop.
import { signalConfig, cloudAppUrl } from './signalConfig'
import { useAccountStore } from '../stores/account'

export interface EphemeralShare {
  token: string
  rootId: string
  title: string
  sizeBytes: number
  createdAt: number
  expiresAt: number
  opens: number
  lastOpenedAt: number | null
}

const urlFor = (path: string): string => signalConfig.httpUrl.replace(/\/+$/, '') + path
const token = (): string | null => useAccountStore.getState().sessionToken

/** The link a recipient opens. Empty when no cloud app has been published. */
export function shareUrlFor(shareToken: string): string {
  const base = cloudAppUrl()
  return base ? `${base}/s/${shareToken}` : ''
}

export interface MintResult {
  ok: boolean
  share?: EphemeralShare
  url?: string
  filesOmitted?: Array<{ id: string; name: string; sizeBytes: number; why: string }>
  error?: string
}

/**
 * Pack the desk and hand it to the server.
 *
 * The packing happens in the main process (it reads the database and the file
 * bytes); only the finished bundle crosses to here, and only the account token
 * crosses to Signal.
 */
export async function mintEphemeralShare(deskId: string): Promise<MintResult> {
  const t = token()
  if (!t) return { ok: false, error: 'Sign in to share a desk.' }

  const built = await window.api.shares.buildDeskBundle(deskId)
  if (!built.ok) return { ok: false, error: built.error }

  try {
    const res = await fetch(urlFor('/shares/ephemeral'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ rootId: deskId, title: built.title, bundle: built.json })
    })
    const body = (await res.json()) as { ok?: boolean; share?: EphemeralShare; error?: string }
    if (!res.ok || !body?.ok || !body.share) {
      return { ok: false, error: body?.error ?? `The server refused the share (${res.status}).` }
    }
    return {
      ok: true,
      share: body.share,
      url: shareUrlFor(body.share.token),
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
    const body = (await res.json()) as { ok?: boolean; shares?: EphemeralShare[] }
    return body?.ok && Array.isArray(body.shares) ? body.shares : []
  } catch {
    return []
  }
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
 */
export function timeLeft(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'expired'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m left`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m left`
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`
}
