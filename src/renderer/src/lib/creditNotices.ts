// Share credit (4.3.52): someone joined Plexii from a desk this account shared,
// an email invite it sent, or its referral link, and the account earned
// credit. The server pushes a creditEarned notice on the account socket the
// moment it lands, and lists the unseen ones (GET /account/notices) until each
// is dismissed (POST /account/notices/:id/seen). Server: focusbuddy-signal
// src/shareCredit.ts and protocol.ts.
import { signalConfig } from './signalConfig'
import { useAccountStore } from '../stores/account'

export type CreditSource = 'share_link' | 'email_invite' | 'referral_link'

export interface CreditNotice {
  id: string
  kind: 'creditEarned'
  /** What this join earned, in US dollars. */
  usd: number
  /** The account's credit balance after it, in US dollars. */
  balanceUsd: number
  source: CreditSource
  deskTitle: string | null
  /** Set only for an email invite. */
  inviteeName: string | null
  /** The server's own words for what happened; shown as sent. */
  text: string
  actionLabel: string
  /** Where the credit is spent: the site's credit page. */
  actionUrl: string
  shareActionLabel: string
  /** Epoch milliseconds. */
  createdAt: number
}

const SOURCES: ReadonlySet<string> = new Set(['share_link', 'email_invite', 'referral_link'])

/**
 * A notice from the server, checked field by field. Anything malformed is
 * dropped rather than shown half-filled: a card that says "You earned
 * US$NaN" is worse than no card (the notice stays in the server's list).
 */
export function parseCreditNotice(raw: unknown): CreditNotice | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : null)
  const num = (k: string): number | null => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : null)
  const optStr = (k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string) : null)
  const id = str('id')
  const usd = num('usd')
  const balanceUsd = num('balanceUsd')
  const text = str('text')
  const actionUrl = str('actionUrl')
  const source = typeof r.source === 'string' && SOURCES.has(r.source) ? (r.source as CreditSource) : null
  if (!id || usd === null || usd <= 0 || balanceUsd === null || !text || !actionUrl || !source) return null
  if (r.kind !== undefined && r.kind !== 'creditEarned') return null
  return {
    id,
    kind: 'creditEarned',
    usd,
    balanceUsd,
    source,
    deskTitle: optStr('deskTitle'),
    inviteeName: optStr('inviteeName'),
    text,
    actionLabel: str('actionLabel') ?? 'Use my credit',
    actionUrl,
    shareActionLabel: str('shareActionLabel') ?? 'Share another desk',
    createdAt: num('createdAt') ?? Date.now()
  }
}

/** "US$5" for whole dollars, "US$2.50" otherwise. */
export function formatUsd(usd: number): string {
  return `US$${Number.isInteger(usd) ? String(usd) : usd.toFixed(2)}`
}

/** Only an https link (or http on this machine, for a local server) is opened. */
export function safeActionUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return u.toString()
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.toString()
    return null
  } catch {
    return null
  }
}

function urlFor(path: string): string {
  return signalConfig.httpUrl.replace(/\/+$/, '') + path
}
function token(): string | null {
  return useAccountStore.getState().sessionToken
}

/** The account's unseen credit notices, newest first. Null when they could not be fetched. */
export async function fetchCreditNotices(): Promise<CreditNotice[] | null> {
  const t = token()
  if (!t) return null
  try {
    const res = await fetch(urlFor('/account/notices'), { headers: { Authorization: `Bearer ${t}` } })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as { ok?: boolean; notices?: unknown[] } | null
    if (!json?.ok || !Array.isArray(json.notices)) return null
    return json.notices.map(parseCreditNotice).filter((n): n is CreditNotice => n !== null)
  } catch {
    return null
  }
}

/** Mark one notice seen. True when the server took it (or it was already gone). */
export async function markCreditNoticeSeen(id: string): Promise<boolean> {
  const t = token()
  if (!t) return false
  try {
    // A JSON body, even an empty object: Fastify refuses a JSON POST with none.
    const res = await fetch(urlFor(`/account/notices/${encodeURIComponent(id)}/seen`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: '{}'
    })
    // 404: not this account's, or no longer there. Nothing more to mark.
    return res.ok || res.status === 404
  } catch {
    return false
  }
}
