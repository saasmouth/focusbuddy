import { signalConfig } from './signalConfig'

// Client for the organization / membership / roles API on the signal server.
// Pure fetch with the account session token, same pattern as docCollabClient.

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest'

export interface OrgMembership {
  id: string
  name: string
  slug: string | null
  personal: boolean
  role: OrgRole
  memberCount: number
  createdAt: number
}
export interface OrgMember {
  accountId: string
  role: OrgRole
  addedAt: number
  handle: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}
export interface OrgInvite {
  id: string
  orgId: string
  email: string
  role: OrgRole
  invitedBy: string
  createdAt: number
}
export interface OrgDetail {
  org: { id: string; name: string; personal: boolean }
  role: OrgRole | null
  members: OrgMember[]
  invites: OrgInvite[]
}

function url(path: string): string {
  return signalConfig.httpUrl.replace(/\/+$/, '') + path
}

async function call<T>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown
): Promise<{ ok: boolean; status: number; json: T | null }> {
  try {
    const res = await fetch(url(path), {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    let json: T | null = null
    try {
      json = (await res.json()) as T
    } catch {
      /* ignore */
    }
    return { ok: res.ok, status: res.status, json }
  } catch {
    return { ok: false, status: 0, json: null }
  }
}

export async function listOrgs(token: string): Promise<OrgMembership[]> {
  const { json } = await call<{ ok: boolean; orgs?: OrgMembership[] }>('GET', '/orgs', token)
  return json?.orgs ?? []
}

export interface AuditEvent {
  id: string
  orgId: string | null
  actorAccountId: string
  action: string
  targetType: string | null
  targetId: string | null
  detail: string | null
  createdAt: number
}

export async function listAudit(token: string, id: string): Promise<AuditEvent[]> {
  const { json } = await call<{ ok: boolean; events?: AuditEvent[] }>('GET', `/orgs/${id}/audit`, token)
  return json?.ok ? json.events ?? [] : []
}

export interface OrgSsoConfig {
  orgId: string
  connectionId: string
  domain: string
  createdAt: number
  /** When the org proved it owns `domain` by DNS; null until then, and SSO is off (signal sso.ts). */
  verifiedAt?: number | null
}

/** The DNS TXT record that proves the domain: plexii-verify=<token> on the domain (or alsoAt). */
export interface OrgSsoRecord {
  type: 'TXT'
  name: string
  value: string
  alsoAt: string
}

/** What a save or Check now found (POST /orgs/:id/sso/verify). */
export interface OrgSsoCheck {
  verified: boolean
  verifiedAt: number | null
  reason?: 'record_not_found' | 'dns_unavailable' | 'no_config'
  message: string
  record?: OrgSsoRecord | null
}

// Returns whether the server can do SSO at all (creds present), this org's
// config if set, and the DNS record that proves its domain.
export async function getSso(
  token: string,
  id: string
): Promise<{ configured: boolean; config: OrgSsoConfig | null; verification: OrgSsoRecord | null }> {
  const { json } = await call<{ ok: boolean; configured?: boolean; config?: OrgSsoConfig | null; verification?: OrgSsoRecord | null }>(
    'GET',
    `/orgs/${id}/sso`,
    token
  )
  return { configured: !!json?.configured, config: json?.config ?? null, verification: json?.verification ?? null }
}

export async function setSso(
  token: string,
  id: string,
  connectionId: string,
  domain: string
): Promise<{ ok: boolean; error?: string; verification?: OrgSsoCheck }> {
  const { json } = await call<{ ok: boolean; error?: string; verification?: OrgSsoCheck }>('PUT', `/orgs/${id}/sso`, token, { connectionId, domain })
  return { ok: !!json?.ok, error: json?.error, verification: json?.verification }
}

/** Check now: signal looks the domain's TXT record up again. */
export async function verifySso(token: string, id: string): Promise<OrgSsoCheck> {
  const { json } = await call<{ ok: boolean; error?: string; verification?: OrgSsoCheck }>('POST', `/orgs/${id}/sso/verify`, token)
  if (json?.ok && json.verification) return json.verification
  return { verified: false, verifiedAt: null, message: json?.error ?? 'Plexii could not check the record. Try again in a moment.' }
}

export async function clearSso(token: string, id: string): Promise<void> {
  await call('DELETE', `/orgs/${id}/sso`, token)
}

export interface OrgScimStatus {
  configured: boolean
  lastUsedAt: number | null
}

// Directory sync (SCIM) status for this org. Returns whether a provisioning
// token is currently active, when it was last used by the identity provider, and
// the base URL the admin pastes into their IdP.
export async function getScim(
  token: string,
  id: string
): Promise<{ ok: boolean; status: OrgScimStatus; baseUrl: string }> {
  const { json } = await call<{
    ok: boolean
    status?: OrgScimStatus
    baseUrl?: string
  }>('GET', `/orgs/${id}/scim`, token)
  return {
    ok: !!json?.ok,
    status: json?.status ?? { configured: false, lastUsedAt: null },
    baseUrl: json?.baseUrl ?? ''
  }
}

// Mint a fresh SCIM provisioning token. The raw token is returned exactly once,
// so it must be surfaced to the admin immediately and never re-fetched. Minting
// again rotates the token and invalidates the previous one.
export async function mintScimToken(
  token: string,
  id: string
): Promise<{ ok: boolean; token?: string; baseUrl?: string; error?: string }> {
  const { json } = await call<{ ok: boolean; token?: string; baseUrl?: string; error?: string }>(
    'POST',
    `/orgs/${id}/scim/token`,
    token
  )
  return json ?? { ok: false, error: 'Request failed.' }
}

// Revoke the active SCIM token, turning directory sync off for this org.
export async function revokeScimToken(token: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('DELETE', `/orgs/${id}/scim/token`, token)
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function getOrg(token: string, id: string): Promise<OrgDetail | null> {
  const { json } = await call<{ ok: boolean } & OrgDetail>('GET', `/orgs/${id}`, token)
  return json?.ok ? { org: json.org, role: json.role, members: json.members, invites: json.invites } : null
}
export async function createOrg(token: string, name: string): Promise<OrgMembership | null> {
  const { json } = await call<{ ok: boolean; org?: OrgMembership }>('POST', '/orgs', token, { name })
  return json?.org ?? null
}
export async function renameOrg(token: string, id: string, name: string): Promise<void> {
  await call('POST', `/orgs/${id}/rename`, token, { name })
}
export async function inviteMember(
  token: string,
  id: string,
  email: string,
  role: OrgRole
): Promise<{ ok: boolean; added?: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; added?: boolean; error?: string }>('POST', `/orgs/${id}/members`, token, { email, role })
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function setMemberRole(
  token: string,
  id: string,
  accountId: string,
  role: OrgRole
): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('POST', `/orgs/${id}/members/${accountId}/role`, token, { role })
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function removeMember(
  token: string,
  id: string,
  accountId: string
): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('DELETE', `/orgs/${id}/members/${accountId}`, token)
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function revokeInvite(token: string, id: string, inviteId: string): Promise<void> {
  await call('DELETE', `/orgs/${id}/invites/${inviteId}`, token)
}
export async function deleteOrg(token: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('DELETE', `/orgs/${id}`, token)
  return json ?? { ok: false, error: 'Request failed.' }
}

/* ---------------- People Map: offices, profiles, working hours ---------------- */

export type OfficeKind = 'physical' | 'remote' | 'external'
export interface Office {
  id: string
  orgId: string
  name: string
  kind: OfficeKind
  city: string | null
  lat: number | null
  lng: number | null
  tzOffsetMin: number
  workStart: number | null
  workEnd: number | null
  accent: string | null
  createdAt: number
}
export interface OfficeInput {
  name?: string
  kind?: OfficeKind
  city?: string | null
  lat?: number | null
  lng?: number | null
  tzOffsetMin?: number
  workStart?: number | null
  workEnd?: number | null
  accent?: string | null
}
export interface MemberProfile {
  orgId: string
  accountId: string
  title: string | null
  department: string | null
  officeId: string | null
  managerAccountId: string | null
  workStart: number | null
  workEnd: number | null
  city: string | null
  lat: number | null
  lng: number | null
  tzOffsetMin: number | null
  updatedAt: number
}
export type ProfilePatch = Partial<Omit<MemberProfile, 'orgId' | 'accountId' | 'updatedAt'>>
export interface WorkWindow {
  start: number
  end: number
}
export interface PeopleMapPerson {
  accountId: string
  handle: string
  firstName?: string | null
  lastName?: string | null
  role: OrgRole
  title: string | null
  department: string | null
  officeId: string | null
  managerAccountId: string | null
  city: string | null
  lat: number | null
  lng: number | null
  tzOffsetMin: number | null
  workWindow: WorkWindow
  // Relative URL of the member's avatar, or null. Resolved to an absolute URL by
  // the People Map merge.
  photoUrl: string | null
  // This person's outgoing dotted-line relationships.
  relationships: { toAccountId: string; kind: RelationshipKind }[]
}

export type RelationshipKind = 'oversight' | 'matrix' | 'stakeholder' | 'vendor'
export interface PeopleMap {
  orgId: string
  defaultHours: WorkWindow
  offices: Office[]
  people: PeopleMapPerson[]
}

export async function getOrgHours(token: string, id: string): Promise<WorkWindow> {
  const { json } = await call<{ ok: boolean; hours?: WorkWindow }>('GET', `/orgs/${id}/settings`, token)
  return json?.hours ?? { start: 9, end: 17 }
}

export interface InvitePolicy {
  allowExternalInvite: boolean
  domain: string | null
}

// The org's invite domain policy. When allowExternalInvite is false, only people
// at `domain` can be invited; sharing to others is flagged. Reads from the same
// /settings endpoint as working hours.
export async function getInvitePolicy(token: string, id: string): Promise<InvitePolicy> {
  const { json } = await call<{ ok: boolean; allowExternalInvite?: boolean; domain?: string | null }>(
    'GET',
    `/orgs/${id}/settings`,
    token
  )
  return { allowExternalInvite: json?.allowExternalInvite ?? true, domain: json?.domain ?? null }
}

export async function setInvitePolicy(
  token: string,
  id: string,
  allowExternalInvite: boolean
): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('PUT', `/orgs/${id}/invite-policy`, token, {
    allowExternalInvite
  })
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function setOrgHours(token: string, id: string, hours: WorkWindow): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('PUT', `/orgs/${id}/settings`, token, hours)
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function listOffices(token: string, id: string): Promise<Office[]> {
  const { json } = await call<{ ok: boolean; offices?: Office[] }>('GET', `/orgs/${id}/offices`, token)
  return json?.offices ?? []
}
export async function createOffice(token: string, id: string, input: OfficeInput): Promise<{ ok: boolean; office?: Office; error?: string }> {
  const { json } = await call<{ ok: boolean; office?: Office; error?: string }>('POST', `/orgs/${id}/offices`, token, input)
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function updateOffice(token: string, id: string, officeId: string, patch: OfficeInput): Promise<{ ok: boolean; office?: Office; error?: string }> {
  const { json } = await call<{ ok: boolean; office?: Office; error?: string }>('PATCH', `/orgs/${id}/offices/${officeId}`, token, patch)
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function deleteOffice(token: string, id: string, officeId: string): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('DELETE', `/orgs/${id}/offices/${officeId}`, token)
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function getMemberProfile(token: string, id: string, accountId: string): Promise<MemberProfile | null> {
  const { json } = await call<{ ok: boolean; profile?: MemberProfile }>('GET', `/orgs/${id}/members/${accountId}/profile`, token)
  return json?.profile ?? null
}
export async function setMemberProfile(token: string, id: string, accountId: string, patch: ProfilePatch): Promise<{ ok: boolean; profile?: MemberProfile; error?: string }> {
  const { json } = await call<{ ok: boolean; profile?: MemberProfile; error?: string }>('PUT', `/orgs/${id}/members/${accountId}/profile`, token, patch)
  return json ?? { ok: false, error: 'Request failed.' }
}
export async function getPeopleMap(token: string, id: string): Promise<PeopleMap | null> {
  const { json } = await call<{ ok: boolean; map?: PeopleMap }>('GET', `/orgs/${id}/people-map`, token)
  return json?.map ?? null
}

/** Resolve a relative people-map photo URL to an absolute one the browser can load. */
export function absolutePhotoUrl(relative: string): string {
  return url(relative)
}

export async function addRelationship(
  token: string,
  id: string,
  accountId: string,
  toAccountId: string,
  kind: RelationshipKind
): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('POST', `/orgs/${id}/members/${accountId}/relationships`, token, { toAccountId, kind })
  return json ?? { ok: false, error: 'Request failed.' }
}

export async function removeRelationship(
  token: string,
  id: string,
  accountId: string,
  toAccountId: string,
  kind: RelationshipKind
): Promise<{ ok: boolean; error?: string }> {
  const { json } = await call<{ ok: boolean; error?: string }>('DELETE', `/orgs/${id}/members/${accountId}/relationships/${toAccountId}/${kind}`, token)
  return json ?? { ok: false, error: 'Request failed.' }
}

/** Upload a member's avatar image (admin or self). Sends the raw bytes with the
 *  image type as a query param. Returns the new photo URL on success. */
export async function uploadMemberPhoto(
  token: string,
  id: string,
  accountId: string,
  bytes: ArrayBuffer,
  mime: string
): Promise<{ ok: boolean; photoUrl?: string; error?: string }> {
  try {
    const res = await fetch(url(`/orgs/${id}/members/${accountId}/photo?mime=${encodeURIComponent(mime)}`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes
    })
    const json = (await res.json()) as { ok: boolean; photoUrl?: string; error?: string }
    return json
  } catch {
    return { ok: false, error: 'Upload failed.' }
  }
}
