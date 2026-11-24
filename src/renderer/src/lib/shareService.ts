// ShareService — REST client for the focusbuddy-signal share endpoints.
// Wraps fetch() so the shares store can talk to the hosted service without
// caring about HTTP semantics.
//
// The renderer's existing local SQLite tables (share_links + shared_with_me)
// stay in place — they're the source of truth for THIS user's outgoing
// links and accepted incoming items. ShareService is the *bridge* to the
// hosted side: when a user creates a share, the snapshot also gets posted
// to the server so other users can resolve the token. When accepting a
// link, the renderer looks the token up on the server, then inserts the
// resolved snapshot into the local inbox.

import type { ShareableKind, ShareScope } from '@shared/types'

export interface MintShareInput {
  token: string
  kind: ShareableKind
  snapshot: unknown
  fromHandle: string
  scope: ShareScope
  expiresAt: number | null
  // The sharer's handle for "invited by X" attribution on the recipient view.
  // Forward-compatible: the hosted service stores it once it understands the
  // field, and ignores it until then.
  createdBy?: string | null
  // The desk or room the link was made from (4.3.56 on). Deleting that desk on
  // the server ends the link at once (signal endLinksOfDeletedNode). Left out
  // when the link is not of a desk; a re-mint never blanks it.
  rootId?: string
}

export interface ShareRecipientDto {
  email: string
  handle: string | null
  status: 'invited' | 'accepted'
}

export interface LookupShareResult {
  token: string
  kind: ShareableKind
  snapshot: unknown
  fromHandle: string
  scope: ShareScope
  createdAt: number
}

export class ShareService {
  private baseUrl: string

  constructor(baseUrl: string) {
    // Strip any trailing slash so url joins below stay tidy.
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  // Owner mints a share. Returns the viewer URL the hosted service confirms
  // — same one the renderer would build from the token, but we trust the
  // server's response so the viewer host can move without a client update.
  async mint(input: MintShareInput, sessionToken?: string | null): Promise<{ viewerUrl: string }> {
    // Send the session token when we have one so the server attributes the share
    // to this account and applies the per-account cap. The server also accepts an
    // anonymous mint (older clients send no token), so this stays optional.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`
    const res = await fetch(`${this.baseUrl}/share`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input)
    })
    if (!res.ok) {
      const detail = await safeText(res)
      throw new Error(
        `Share service rejected mint (${res.status}): ${detail}`
      )
    }
    const body = (await res.json()) as { ok?: boolean; viewerUrl?: string }
    if (!body.viewerUrl) {
      throw new Error('Share service returned no viewerUrl.')
    }
    return { viewerUrl: body.viewerUrl }
  }

  // Recipient resolves a share. The hosted service streams back the
  // snapshot the original owner posted, and increments the view counter
  // so the share manager can show "how many people opened this".
  async lookup(token: string): Promise<LookupShareResult> {
    const res = await fetch(`${this.baseUrl}/share/${encodeURIComponent(token)}`)
    if (res.status === 404) {
      throw new Error('Share not found, expired, or revoked.')
    }
    if (!res.ok) {
      throw new Error(`Share service error (${res.status}).`)
    }
    // The server wraps the share in an { ok, record } envelope. Read
    // `record`, but tolerate a flat shape too so a future server change or
    // an older host can't break resolution. Without this the desktop read
    // `snapshot` off the top level (always undefined), which surfaced later
    // as a cryptic "Cannot read properties of undefined (reading 'title')"
    // when the empty snapshot was reconstructed.
    const body = (await res.json()) as
      | { ok?: boolean; record?: LookupShareResult }
      | LookupShareResult
    const record = (body as { record?: LookupShareResult }).record ?? (body as LookupShareResult)
    if (!record || !record.snapshot) {
      throw new Error('This share could not be read. It may be from an incompatible version, or the link may have expired.')
    }
    return record
  }

  // Owner invites someone to a share by email. Server records the recipient
  // and emails them the viewer link. Owner-authenticated.
  async invite(
    token: string,
    email: string,
    sessionToken: string
  ): Promise<{ recipient: ShareRecipientDto; emailDelivered: boolean }> {
    const res = await fetch(`${this.baseUrl}/share/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ token, email })
    })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      recipient?: ShareRecipientDto
      emailDelivered?: boolean
      error?: string
    }
    if (!res.ok || !body.ok || !body.recipient) {
      throw new Error(body.error || `Invite failed (${res.status}).`)
    }
    return { recipient: body.recipient, emailDelivered: !!body.emailDelivered }
  }

  // List recipients for one or more of the owner's shares (for the avatars).
  async recipients(
    tokens: string[],
    sessionToken: string
  ): Promise<Record<string, ShareRecipientDto[]>> {
    if (tokens.length === 0) return {}
    const res = await fetch(
      `${this.baseUrl}/share/recipients?tokens=${encodeURIComponent(tokens.join(','))}`,
      { headers: { Authorization: `Bearer ${sessionToken}` } }
    )
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      byToken?: Record<string, ShareRecipientDto[]>
    }
    if (!res.ok || !body.ok) return {}
    return body.byToken ?? {}
  }

  // Upload the bytes for a raw-file share, hosted publicly against the token so
  // the viewer can preview or download it. Owner-authenticated. Best-effort from
  // the caller's perspective: a failure leaves the share resolvable with
  // metadata only (the snapshot's hosted flag still reflects intent), so the
  // viewer degrades honestly rather than showing a broken embed.
  async uploadFileBlob(
    token: string,
    bytes: ArrayBuffer,
    mimeType: string,
    ext: string,
    sessionToken: string
  ): Promise<boolean> {
    try {
      const qs = `?mime=${encodeURIComponent(mimeType || 'application/octet-stream')}&ext=${encodeURIComponent(ext || '')}`
      const res = await fetch(`${this.baseUrl}/share/${encodeURIComponent(token)}/blob${qs}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${sessionToken}` },
        body: bytes
      })
      return res.ok
    } catch {
      return false
    }
  }

  // Owner revokes a share. The hosted side stops resolving it but the
  // local share_links row stays (marked revoked) so the share manager
  // shows the audit history.
  async revoke(token: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/share/${encodeURIComponent(token)}`, {
      method: 'DELETE'
    })
    if (!res.ok && res.status !== 404) {
      const detail = await safeText(res)
      throw new Error(
        `Share service rejected revoke (${res.status}): ${detail}`
      )
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
