import { signalConfig } from './signalConfig'
import { useAccountStore } from '../stores/account'
import { crdtSeedDeskLinks } from './crdtBridge'

// Renderer client for per-desk live sharing (share a desk with named individuals so
// they get bidirectional near-live updates). It talks to the signal /workspace/desk
// and /workspace/shared routes with the plain account bearer token — access rides
// resource_acls grants, not org membership. Sharing also stamps the desk subtree
// locally (via main) so it starts flowing down the ACL-scoped shared sync path, and
// kicks an immediate cycle so grantees see it within a second or two.

function urlFor(path: string): string {
  return signalConfig.httpUrl.replace(/\/+$/, '') + path
}
function token(): string | null {
  return useAccountStore.getState().sessionToken
}

export interface DeskAccessGrant {
  accountId: string
  handle: string
  name: string
  email: string | null
  permission: string
}
export interface DeskAccess {
  owner: string | null
  grants: DeskAccessGrant[]
  pending: Array<{ email: string; permission: string }>
}
export interface DeskInvite {
  accountId?: string
  email?: string
  permission?: string
}

// Share a desk live with the given people. Stamps the subtree locally first so it
// syncs down the shared path, registers the grants on the server, then kicks a
// sync so the desk pushes immediately. Returns the refreshed access list.
export async function shareDeskLive(
  rootId: string,
  invites: DeskInvite[],
  permission: 'view' | 'edit' = 'edit'
): Promise<{ ok: boolean; access?: DeskAccess; error?: string }> {
  const t = token()
  if (!t) return { ok: false, error: 'Not signed in.' }
  try {
  // Push the desk to the server BEFORE asking to share it. The server will only
  // register a desk root for someone who demonstrably holds that desk, and the
  // proof it accepts is the desk being in their own synced workspace -- which
  // stops anyone who merely knows a desk id from registering it and locking the
  // real owner out. A desk created moments ago has not synced yet, so without
  // this the first share of a brand-new desk would be refused.
  const { syncWorkspaceOnce } = await import('./workspaceSync')
  await syncWorkspaceOnce()
    await window.api.workspaceSync.stampSharedDesk(rootId)
    const res = await fetch(urlFor('/workspace/desk/share'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootId, invites, permission })
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; access?: DeskAccess; error?: string }
    if (!res.ok || !json.ok) return { ok: false, error: json.error || 'Could not share the desk.' }
    // Push the freshly-stamped desk down the shared path, so grantees can pull it.
    void syncWorkspaceOnce()
    // Seed the desk's existing wires onto the substrate. The poll's shared cycle
    // carries widgets/nodes/tables/rows but not widget_links, so without this a
    // grantee would see the shared desk's widgets and none of its connectors.
    // No-op when the substrate is off.
    crdtSeedDeskLinks(rootId)
    return { ok: true, access: json.access }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error.' }
  }
}

export interface DeskClaimLink {
  token: string
  rootId: string
  permission: 'view' | 'edit'
  singleUse: boolean
  label: string
  claims: number
  expiresAt: number | null
  revoked: boolean
  createdAt: number
}

/**
 * Mint a link that anyone can open, sign up against, and claim.
 *
 * The stamp is not optional and not an optimisation. It marks the desk's
 * subtree as shared so the next sync pushes those rows into the shared bucket;
 * without it the claimer receives a perfectly valid grant on a desk whose rows
 * have never left the owner's personal bucket, and sees an empty canvas. That
 * failure is silent on both sides, which is why this mirrors shareDeskLive's
 * order exactly: stamp, register, then push.
 */
export async function createDeskClaimLink(
  rootId: string,
  opts: { permission?: 'view' | 'edit'; singleUse?: boolean; label?: string; expiresAt?: number | null } = {}
): Promise<{ ok: boolean; link?: DeskClaimLink; error?: string }> {
  const t = token()
  if (!t) return { ok: false, error: 'Not signed in.' }
  try {
  // Push the desk to the server BEFORE asking to share it. The server will only
  // register a desk root for someone who demonstrably holds that desk, and the
  // proof it accepts is the desk being in their own synced workspace -- which
  // stops anyone who merely knows a desk id from registering it and locking the
  // real owner out. A desk created moments ago has not synced yet, so without
  // this the first share of a brand-new desk would be refused.
  const { syncWorkspaceOnce } = await import('./workspaceSync')
  await syncWorkspaceOnce()
    await window.api.workspaceSync.stampSharedDesk(rootId)
    const res = await fetch(urlFor(`/workspace/desk/${rootId}/claim-link`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        permission: opts.permission ?? 'view',
        singleUse: opts.singleUse ?? false,
        label: opts.label ?? '',
        expiresAt: opts.expiresAt ?? null
      })
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; link?: DeskClaimLink; error?: string }
    if (!res.ok || !json.ok || !json.link) {
      return { ok: false, error: json.error || 'Could not create the link.' }
    }
    // Push the freshly-stamped desk now, so the first person to claim finds
    // something there rather than an empty desk that fills in a minute later.
    void syncWorkspaceOnce()
    crdtSeedDeskLinks(rootId)
    return { ok: true, link: json.link }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error.' }
  }
}

/** Every link minted for this desk, plus who has claimed one. */
export async function listDeskClaimLinks(
  rootId: string
): Promise<{ links: DeskClaimLink[]; claims: Array<{ token: string; accountId: string; name: string; permission: string; claimedAt: number }> }> {
  const t = token()
  if (!t) return { links: [], claims: [] }
  try {
    const res = await fetch(urlFor(`/workspace/desk/${rootId}/claim-links`), {
      headers: { Authorization: `Bearer ${t}` }
    })
    if (!res.ok) return { links: [], claims: [] }
    const json = (await res.json()) as { ok?: boolean; links?: DeskClaimLink[]; claims?: never[] }
    return json.ok ? { links: json.links ?? [], claims: json.claims ?? [] } : { links: [], claims: [] }
  } catch {
    return { links: [], claims: [] }
  }
}

/**
 * Stop a link working. Access already claimed through it is untouched --
 * those are real grants now, removed from the access list like any other.
 */
export async function revokeDeskClaimLink(linkToken: string): Promise<boolean> {
  const t = token()
  if (!t) return false
  try {
    const res = await fetch(urlFor(`/workspace/desk/claim-link/${linkToken}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${t}` }
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean }
    return res.ok && json.ok === true
  } catch {
    return false
  }
}

export async function getDeskAccess(rootId: string): Promise<DeskAccess | null> {
  const t = token()
  if (!t) return null
  try {
    const res = await fetch(urlFor(`/workspace/desk/${rootId}/access`), {
      headers: { Authorization: `Bearer ${t}` }
    })
    if (!res.ok) return null
    const json = (await res.json()) as { ok?: boolean; access?: DeskAccess }
    return json.ok && json.access ? json.access : null
  } catch {
    return null
  }
}

export async function revokeDeskAccess(rootId: string, accountId: string): Promise<DeskAccess | null> {
  const t = token()
  if (!t) return null
  try {
    const res = await fetch(urlFor(`/workspace/desk/${rootId}/access/${accountId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${t}` }
    })
    if (!res.ok) return null
    const json = (await res.json()) as { ok?: boolean; access?: DeskAccess }
    return json.ok && json.access ? json.access : null
  } catch {
    return null
  }
}

export async function revokeDeskInvite(rootId: string, email: string): Promise<DeskAccess | null> {
  const t = token()
  if (!t) return null
  try {
    const res = await fetch(urlFor(`/workspace/desk/${rootId}/invite?email=${encodeURIComponent(email)}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${t}` }
    })
    if (!res.ok) return null
    const json = (await res.json()) as { ok?: boolean; access?: DeskAccess }
    return json.ok && json.access ? json.access : null
  } catch {
    return null
  }
}
