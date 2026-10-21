import { useCallback, useEffect, useState } from 'react'
import Icon from '../Icon'
import { DashboardHeader, StatTile, PLEXI_CARD } from '../plexi'
import { confirmDialog } from '../plexi/PromptDialog'
import { personDisplayName } from '../../lib/personName'
import { useAccountStore } from '../../stores/account'
import { useOrgStore } from '../../stores/org'
import {
  listOrgs,
  getOrg,
  createOrg,
  renameOrg,
  inviteMember,
  setMemberRole,
  removeMember,
  revokeInvite,
  listOffices,
  createOffice,
  updateOffice,
  deleteOffice,
  getOrgHours,
  setOrgHours,
  getInvitePolicy,
  setInvitePolicy,
  getMemberProfile,
  setMemberProfile,
  uploadMemberPhoto,
  absolutePhotoUrl,
  listAudit,
  getSso,
  setSso as setSsoConfig,
  clearSso,
  getScim,
  mintScimToken,
  revokeScimToken,
  type AuditEvent,
  type OrgSsoConfig,
  type OrgScimStatus,
  type OrgMembership,
  type OrgDetail,
  type OrgRole,
  type Office,
  type OfficeKind,
  type OfficeInput,
  type MemberProfile,
  type WorkWindow
} from '../../lib/orgsClient'

// The customer-facing organization admin console: switch between the orgs you
// belong to, manage members and their roles, invite people by email, and set up
// the workforce — company working hours, offices/locations (with the geo + time
// zone the People Map needs), and each member's profile (title, department,
// office, who they report to, personal hours). The server enforces every role
// guard; the UI surfaces its errors.

const ROLE_OPTIONS: OrgRole[] = ['owner', 'admin', 'member', 'guest']
const OFFICE_KINDS: OfficeKind[] = ['physical', 'remote', 'external']

const numOrNull = (v: string): number | null => (v.trim() === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const hourStr = (v: number | null): string => (v == null ? '' : String(v))

export default function OrgAdminView(): JSX.Element {
  const token = useAccountStore((s) => s.sessionToken)
  const myId = useAccountStore((s) => s.account?.id ?? null)
  const [orgs, setOrgs] = useState<OrgMembership[]>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OrgDetail | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrgRole>('member')
  const [newOrg, setNewOrg] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  // People-Map setup state
  const [offices, setOffices] = useState<Office[]>([])
  const [orgHours, setHoursState] = useState<WorkWindow>({ start: 9, end: 17 })
  const [invitePolicy, setInvitePolicyState] = useState<{ allowExternalInvite: boolean; domain: string | null }>({
    allowExternalInvite: true,
    domain: null
  })
  const [profiles, setProfiles] = useState<Record<string, MemberProfile>>({})
  const [openProfile, setOpenProfile] = useState<string | null>(null)
  const [newOffice, setNewOffice] = useState('')
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [sso, setSsoState] = useState<{ configured: boolean; config: OrgSsoConfig | null }>({ configured: false, config: null })
  const [ssoConn, setSsoConn] = useState('')
  const [ssoDomain, setSsoDomain] = useState('')
  // Directory sync (SCIM) state. The base URL comes from the server; the raw
  // token is only ever held in memory after a mint and is never re-fetched.
  const [scim, setScimState] = useState<{ status: OrgScimStatus; baseUrl: string }>({
    status: { configured: false, lastUsedAt: null },
    baseUrl: ''
  })
  const [scimToken, setScimToken] = useState<string | null>(null)
  const [scimBusy, setScimBusy] = useState(false)

  // Follow the organisation the user has switched to, so the admin/people view
  // shows the org they're actually working in rather than an arbitrary first one.
  const activeOrgId = useOrgStore((s) => s.activeOrgId)

  const refreshOrgs = useCallback(async () => {
    if (!token) return
    const list = await listOrgs(token)
    setOrgs(list)
    setSelId(
      (prev) =>
        (activeOrgId && activeOrgId !== 'personal' && list.some((o) => o.id === activeOrgId)
          ? activeOrgId
          : prev) ??
        prev ??
        list.find((o) => !o.personal)?.id ??
        list[0]?.id ??
        null
    )
  }, [token, activeOrgId])

  useEffect(() => {
    if (activeOrgId && activeOrgId !== 'personal' && orgs.some((o) => o.id === activeOrgId)) {
      setSelId(activeOrgId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId])

  const refreshDetail = useCallback(async () => {
    if (!token || !selId) {
      setDetail(null)
      return
    }
    setDetail(await getOrg(token, selId))
  }, [token, selId])

  const refreshAux = useCallback(async () => {
    if (!token || !selId) {
      setOffices([])
      setProfiles({})
      return
    }
    setOffices(await listOffices(token, selId))
    setHoursState(await getOrgHours(token, selId))
    setInvitePolicyState(await getInvitePolicy(token, selId))
    setAudit(await listAudit(token, selId)) // server returns [] for non-admins
    const s = await getSso(token, selId)
    setSsoState(s)
    setSsoConn(s.config?.connectionId ?? '')
    setSsoDomain(s.config?.domain ?? '')
    const sc = await getScim(token, selId)
    setScimState({ status: sc.status, baseUrl: sc.baseUrl })
    setScimToken(null) // a freshly loaded org never reveals a previously minted token
    setProfiles({})
    setOpenProfile(null)
  }, [token, selId])

  useEffect(() => {
    void refreshOrgs()
  }, [refreshOrgs])
  useEffect(() => {
    void refreshDetail()
  }, [refreshDetail])
  useEffect(() => {
    void refreshAux()
  }, [refreshAux])

  // Lazily load a member's raw profile when its editor opens.
  useEffect(() => {
    if (!token || !selId || !openProfile || profiles[openProfile]) return
    void getMemberProfile(token, selId, openProfile).then((p) => {
      if (p) setProfiles((m) => ({ ...m, [openProfile]: p }))
    })
  }, [token, selId, openProfile, profiles])

  const canAdmin = detail?.role === 'owner' || detail?.role === 'admin'

  async function doCreate(): Promise<void> {
    if (!token || !newOrg.trim()) return
    const org = await createOrg(token, newOrg.trim())
    setNewOrg('')
    if (org) {
      await refreshOrgs()
      setSelId(org.id)
    }
  }
  async function doRename(name: string): Promise<void> {
    if (!token || !selId) return
    await renameOrg(token, selId, name)
    void refreshOrgs()
  }
  async function doInvite(): Promise<void> {
    if (!token || !selId || !inviteEmail.includes('@')) return
    const email = inviteEmail.trim().toLowerCase()
    // Warn before granting access to someone external to the organisation — either
    // an explicit guest, or an email outside the org's domain.
    const domain = email.split('@')[1] ?? ''
    const orgDomain = invitePolicy.domain?.toLowerCase() ?? null
    const isExternal = inviteRole === 'guest' || (orgDomain ? domain !== orgDomain : false)
    if (isExternal) {
      const ok = await confirmDialog({
        title: `Invite ${email}?`,
        body: `${email} is external to this organisation${orgDomain ? ` (${orgDomain})` : ''}. ${
          inviteRole === 'guest'
            ? 'As a guest they see only the tasks assigned to them in the shared workspace, with the desk each one is on, and can mark them done. Its desks, documents and files stay private.'
            : 'They will join as a full member with access to shared content.'
        }`,
        confirmLabel: 'Invite external person',
        danger: true
      })
      if (!ok) return
    }
    const res = await inviteMember(token, selId, email, inviteRole)
    setMsg(res.ok ? (res.added ? 'Added to the organization.' : 'Access granted. They will join when they sign in with that email. No email is sent from here.') : res.error ?? 'Could not add that person.')
    if (res.ok) {
      setInviteEmail('')
      void refreshDetail()
    }
  }
  async function doSetPolicy(allow: boolean): Promise<void> {
    if (!token || !selId) return
    setInvitePolicyState((p) => ({ ...p, allowExternalInvite: allow }))
    const res = await setInvitePolicy(token, selId, allow)
    if (!res.ok) {
      setMsg(res.error ?? 'Could not change the invite policy.')
      // Revert the optimistic flip on failure.
      setInvitePolicyState(await getInvitePolicy(token, selId))
    }
  }
  async function doRole(accountId: string, role: OrgRole): Promise<void> {
    if (!token || !selId) return
    const res = await setMemberRole(token, selId, accountId, role)
    if (!res.ok) setMsg(res.error ?? 'Could not change role.')
    void refreshDetail()
  }
  async function doRemove(accountId: string): Promise<void> {
    if (!token || !selId) return
    const res = await removeMember(token, selId, accountId)
    if (!res.ok) setMsg(res.error ?? 'Could not remove.')
    void refreshDetail()
    if (accountId === myId) void refreshOrgs()
  }
  async function doRevoke(inviteId: string): Promise<void> {
    if (!token || !selId) return
    await revokeInvite(token, selId, inviteId)
    void refreshDetail()
  }

  // ---- People-Map setup actions ----
  async function saveHours(w: WorkWindow): Promise<void> {
    if (!token || !selId) return
    setHoursState(w)
    const res = await setOrgHours(token, selId, w)
    if (!res.ok) setMsg(res.error ?? 'Could not save working hours.')
  }
  async function addOffice(): Promise<void> {
    if (!token || !selId || !newOffice.trim()) return
    const res = await createOffice(token, selId, { name: newOffice.trim(), kind: 'physical' })
    setNewOffice('')
    if (res.ok) setOffices(await listOffices(token, selId))
    else setMsg(res.error ?? 'Could not add office.')
  }
  async function patchOffice(officeId: string, patch: OfficeInput): Promise<void> {
    if (!token || !selId) return
    const res = await updateOffice(token, selId, officeId, patch)
    if (res.ok && res.office) setOffices((list) => list.map((o) => (o.id === officeId ? res.office! : o)))
    else setMsg(res.error ?? 'Could not update office.')
  }
  async function removeOfficeById(officeId: string): Promise<void> {
    if (!token || !selId) return
    await deleteOffice(token, selId, officeId)
    setOffices((list) => list.filter((o) => o.id !== officeId))
  }
  async function saveProfile(accountId: string, patch: Partial<MemberProfile>): Promise<void> {
    if (!token || !selId) return
    const res = await setMemberProfile(token, selId, accountId, patch)
    if (res.ok && res.profile) setProfiles((m) => ({ ...m, [accountId]: res.profile! }))
    else setMsg(res.error ?? 'Could not save profile.')
  }

  const officeName = (id: string | null): string => offices.find((o) => o.id === id)?.name ?? '—'

  return (
    <div className="h-full overflow-auto desk-paper no-tod p-6" data-testid="org-admin">
      <div className="max-w-5xl mx-auto">
        <DashboardHeader
          title="Organizations"
          subtitle="Set up your company: members and roles, offices and locations, working hours, and each person's profile — the directory the People Map reads."
        />

        {detail && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <StatTile icon="apartment" label="Organizations" value={orgs.filter((o) => !o.personal).length} tone="accent" />
            <StatTile icon="groups" label="Members" value={detail.members.length} tone="emerald" />
            <StatTile icon="location_city" label="Offices" value={offices.length} tone="sky" />
            <StatTile icon="mail" label="Pending invites" value={detail.invites.length} tone="violet" />
          </div>
        )}

        {/* Only the active organisation is shown here — switching is done from the
            top-of-sidebar org switcher, so this admin panel stays scoped to the
            org you are actually in. Creating a new org is still available. */}
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {orgs.filter((o) => o.id === selId).map((o) => (
            <button
              key={o.id}
              onClick={() => setSelId(o.id)}
              data-testid={`org-pick-${o.id}`}
              className={`inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full border ${o.id === selId ? 'border-accent text-accent bg-accent/[0.06]' : 'border-[var(--edge-soft)] hover:border-accent'}`}
            >
              <Icon name={o.personal ? 'person' : 'apartment'} size={13} />
              {o.name}
              <span className="text-[10px] text-[var(--ink-40)]">{o.role}</span>
            </button>
          ))}
          <span className="inline-flex items-center gap-1 ml-1">
            <input
              value={newOrg}
              onChange={(e) => setNewOrg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doCreate()
              }}
              placeholder="New organization…"
              data-testid="org-new-name"
              className="fb-field px-2 py-1 text-[12px] w-40"
            />
            <button onClick={() => void doCreate()} disabled={!newOrg.trim()} className="icon-btn disabled:opacity-40" title="Create" data-testid="org-create">
              <Icon name="add" size={15} />
            </button>
          </span>
        </div>

        {msg && <div className="mb-3 text-[12px] text-[var(--ink-50)]">{msg}</div>}

        {detail && (
          <div className={`${PLEXI_CARD} p-4`}>
            <div className="flex items-center gap-2 mb-3">
              {canAdmin && !detail.org.personal ? (
                <input
                  defaultValue={detail.org.name}
                  onBlur={(e) => void doRename(e.target.value)}
                  className="text-[15px] font-semibold bg-transparent border-b border-transparent hover:border-[var(--edge-firm)] focus:border-accent"
                  data-testid="org-rename"
                />
              ) : (
                <span className="text-[15px] font-semibold">{detail.org.name}</span>
              )}
              <span className="text-[11px] text-[var(--ink-40)]">you are {detail.role}</span>
            </div>

            {/* Company working hours */}
            <div className="mb-3 pb-3 border-b border-[var(--edge-soft)] flex items-center gap-2 flex-wrap" data-testid="org-hours">
              <Icon name="schedule" size={15} className="text-[var(--ink-40)]" />
              <span className="text-[12px] text-[var(--ink-70)]">Company working hours</span>
              {canAdmin ? (
                <span className="inline-flex items-center gap-1.5">
                  <input
                    type="number" min={0} max={24}
                    defaultValue={orgHours.start}
                    key={`hs-${orgHours.start}`}
                    onBlur={(e) => void saveHours({ start: numOrNull(e.target.value) ?? 9, end: orgHours.end })}
                    data-testid="org-hours-start"
                    className="fb-field w-14 text-[12px] text-center px-1.5 py-0.5"
                  />
                  <span className="text-[11px] text-[var(--ink-40)]">to</span>
                  <input
                    type="number" min={0} max={24}
                    defaultValue={orgHours.end}
                    key={`he-${orgHours.end}`}
                    onBlur={(e) => void saveHours({ start: orgHours.start, end: numOrNull(e.target.value) ?? 17 })}
                    data-testid="org-hours-end"
                    className="fb-field w-14 text-[12px] text-center px-1.5 py-0.5"
                  />
                  <span className="text-[11px] text-[var(--ink-40)]">local · inherited by every office and person</span>
                </span>
              ) : (
                <span className="text-[12px] text-[var(--ink-50)]">{orgHours.start}:00 – {orgHours.end}:00 local</span>
              )}
            </div>

            {/* Members */}
            <div className="space-y-1">
              {detail.members.map((m) => {
                const editable = canAdmin || m.accountId === myId
                const isOpen = openProfile === m.accountId
                const prof = profiles[m.accountId]
                return (
                  <div key={m.accountId} className="border-b border-[var(--edge-soft)] dark:border-white/[0.04] last:border-0" data-testid={`org-member-${m.accountId}`}>
                    <div className="flex items-center gap-2 py-1">
                      {editable && (
                        <button
                          onClick={() => setOpenProfile(isOpen ? null : m.accountId)}
                          className="icon-btn"
                          title="Edit profile"
                          data-testid={`org-profile-toggle-${m.accountId}`}
                        >
                          <Icon name={isOpen ? 'expand_more' : 'chevron_right'} size={15} />
                        </button>
                      )}
                      <span className="text-[13px] text-[var(--ink-90)] flex-1 min-w-0 truncate">
                        {personDisplayName(m, m.handle)}
                        {m.accountId === myId && <span className="text-[11px] text-[var(--ink-40)]"> (you)</span>}
                        {prof?.title && <span className="text-[11px] text-[var(--ink-40)]"> · {prof.title}</span>}
                        {prof?.officeId && <span className="text-[11px] text-[var(--ink-40)]"> · {officeName(prof.officeId)}</span>}
                      </span>
                      {canAdmin ? (
                        <select
                          value={m.role}
                          onChange={(e) => void doRole(m.accountId, e.target.value as OrgRole)}
                          data-testid={`org-role-${m.accountId}`}
                          className="fb-field w-auto text-[12px] px-1.5 py-0.5"
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[12px] text-[var(--ink-50)]">{m.role}</span>
                      )}
                      {editable && (
                        <button onClick={() => void doRemove(m.accountId)} className="icon-btn" title={m.accountId === myId ? 'Leave' : 'Remove'} data-testid={`org-remove-${m.accountId}`}>
                          <Icon name={m.accountId === myId ? 'logout' : 'person_remove'} size={14} />
                        </button>
                      )}
                    </div>

                    {isOpen && (
                      <ProfileEditor
                        profile={prof}
                        offices={offices}
                        members={detail.members.filter((x) => x.accountId !== m.accountId)}
                        onSave={(patch) => void saveProfile(m.accountId, patch)}
                        onUploadPhoto={async (bytes, mime) => {
                          if (!token || !selId) return
                          const r = await uploadMemberPhoto(token, selId, m.accountId, bytes, mime)
                          if (!r.ok) setMsg(r.error ?? 'Photo upload failed.')
                          void refreshDetail()
                        }}
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {/* Pending invites */}
            {detail.invites.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[var(--edge-soft)]">
                <div className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] mb-1">Pending invites</div>
                {detail.invites.map((iv) => (
                  <div key={iv.id} className="flex items-center gap-2 py-0.5 text-[12px]">
                    <Icon name="mail" size={13} className="text-[var(--ink-40)]" />
                    <span className="flex-1 min-w-0 truncate text-[var(--ink-70)]">{iv.email}</span>
                    <span className="text-[11px] text-[var(--ink-40)]">{iv.role}</span>
                    {canAdmin && (
                      <button onClick={() => void doRevoke(iv.id)} className="icon-btn" title="Revoke">
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Invite domain policy */}
            {canAdmin && !detail.org.personal && (
              <div className="mt-3 pt-3 border-t border-[var(--edge-soft)]">
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={invitePolicy.allowExternalInvite}
                    onChange={(e) => void doSetPolicy(e.target.checked)}
                    className="mt-0.5 accent-accent"
                    data-testid="org-allow-external"
                  />
                  <span className="text-[12px] text-[var(--ink-70)]">
                    Allow inviting people outside{' '}
                    {invitePolicy.domain ? `@${invitePolicy.domain}` : 'the organization domain'}.
                    {!invitePolicy.allowExternalInvite && (
                      <span className="block text-[11px] text-[var(--ink-50)]">
                        Off: only people at {invitePolicy.domain ? `@${invitePolicy.domain}` : 'your domain'} can be
                        invited, and sharing outside is flagged.
                      </span>
                    )}
                    {!invitePolicy.domain && (
                      <span className="block text-[11px] text-[var(--ink-50)]">
                        Set an SSO domain below to enforce this.
                      </span>
                    )}
                  </span>
                </label>
              </div>
            )}

            {/* Invite */}
            {canAdmin && (
              <div className="mt-3 pt-3 border-t border-[var(--edge-soft)] flex items-center gap-1.5">
                <input
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doInvite()
                  }}
                  placeholder="Invite by email…"
                  data-testid="org-invite-email"
                  className="fb-field flex-1 px-2 py-1 text-[12px]"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                  className="fb-field w-auto text-[12px] px-1.5 py-1"
                >
                  <option value="admin">admin</option>
                  <option value="member">member</option>
                  <option value="guest">guest</option>
                </select>
                <button onClick={() => void doInvite()} disabled={!inviteEmail.includes('@')} className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-50" data-testid="org-invite-send">
                  Invite
                </button>
              </div>
            )}
          </div>
        )}

        {/* Offices & locations */}
        {detail && (
          <div className={`${PLEXI_CARD} mt-4 p-4`} data-testid="org-offices">
            <div className="flex items-center gap-2 mb-3">
              <Icon name="location_city" size={16} className="text-accent" />
              <h2 className="text-[14px] font-semibold">Offices &amp; locations</h2>
              <span className="text-[11px] text-[var(--ink-40)]">where people sit · drives the People Map</span>
            </div>

            {offices.length === 0 && (
              <p className="text-[12px] text-[var(--ink-50)] mb-2">
                No offices yet. Add one (including a “Remote” location) so workers can be placed on the map.
              </p>
            )}

            <div className="space-y-2">
              {offices.map((o) => (
                <OfficeRow key={o.id} office={o} canAdmin={canAdmin} onSave={(p) => void patchOffice(o.id, p)} onDelete={() => void removeOfficeById(o.id)} />
              ))}
            </div>

            {canAdmin && (
              <div className="mt-3 pt-3 border-t border-[var(--edge-soft)] flex items-center gap-1.5">
                <input
                  value={newOffice}
                  onChange={(e) => setNewOffice(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addOffice()
                  }}
                  placeholder="New office or location name…"
                  data-testid="org-office-new"
                  className="fb-field flex-1 px-2 py-1 text-[12px]"
                />
                <button onClick={() => void addOffice()} disabled={!newOffice.trim()} className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-50" data-testid="org-office-add">
                  Add office
                </button>
              </div>
            )}
          </div>
        )}

        {detail && canAdmin && (
          <div className={`${PLEXI_CARD} mt-4 p-4`} data-testid="org-audit">
            <div className="flex items-center gap-2 mb-3">
              <Icon name="history" size={16} className="text-accent" />
              <h2 className="text-[14px] font-semibold">Audit log</h2>
              <span className="text-[11px] text-[var(--ink-40)]">membership, role, and sign-in activity</span>
            </div>
            {audit.length === 0 ? (
              <p className="text-[12px] text-[var(--ink-50)]">No activity recorded yet.</p>
            ) : (
              <div className="space-y-1 max-h-[360px] overflow-auto">
                {audit.map((e) => {
                  const actor = detail.members.find((m) => m.accountId === e.actorAccountId)
                  const who = personDisplayName(actor, e.actorAccountId.slice(0, 8))
                  return (
                    <div
                      key={e.id}
                      className="flex items-center gap-2 text-[12px] py-1 border-b border-[var(--edge-soft)] last:border-0"
                    >
                      <span className="text-[var(--ink-40)] fb-tabular shrink-0 w-[130px]">
                        {new Date(e.createdAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </span>
                      <span className="font-medium text-[var(--ink-70)] shrink-0">{who}</span>
                      <span className="text-[var(--ink-50)]">{humanizeAudit(e.action)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {detail && canAdmin && (
          <div className={`${PLEXI_CARD} mt-4 p-4`} data-testid="org-sso">
            <div className="flex items-center gap-2 mb-3">
              <Icon name="vpn_key" size={16} className="text-accent" />
              <h2 className="text-[14px] font-semibold">Single sign-on (SSO)</h2>
              <span className="text-[11px] text-[var(--ink-40)]">WorkOS, sign in with your identity provider</span>
            </div>
            {!sso.configured ? (
              <p className="text-[12px] text-[var(--ink-50)] leading-relaxed">
                SSO is not enabled on this server yet. Once WorkOS is configured server-side, set your connection here
                and your team can sign in with your identity provider.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-[var(--ink-50)] leading-relaxed">
                  Paste your WorkOS connection id and the email domain your team signs in with. People with that domain
                  can then use Sign in with SSO.
                </p>
                <input
                  value={ssoConn}
                  onChange={(e) => setSsoConn(e.target.value)}
                  placeholder="WorkOS connection id (conn_…)"
                  data-testid="org-sso-conn"
                  className="fb-field w-full px-2 py-1 text-[12px]"
                />
                <input
                  value={ssoDomain}
                  onChange={(e) => setSsoDomain(e.target.value)}
                  placeholder="Email domain (acme.com)"
                  data-testid="org-sso-domain"
                  className="fb-field w-full px-2 py-1 text-[12px]"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      if (!token || !selId) return
                      const r = await setSsoConfig(token, selId, ssoConn.trim(), ssoDomain.trim())
                      setMsg(r.ok ? 'SSO connection saved.' : r.error ?? 'Could not save SSO.')
                      if (r.ok) await refreshAux()
                    }}
                    disabled={!ssoConn.trim() || !ssoDomain.trim()}
                    className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-50"
                    data-testid="org-sso-save"
                  >
                    Save SSO
                  </button>
                  {sso.config && (
                    <button
                      onClick={async () => {
                        if (!token || !selId) return
                        await clearSso(token, selId)
                        setMsg('SSO connection removed.')
                        await refreshAux()
                      }}
                      className="text-[12px] px-2.5 py-1 rounded text-rose-500 hover:bg-rose-500/10"
                    >
                      Remove
                    </button>
                  )}
                  {sso.config && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Active for {sso.config.domain}</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {detail && (
          <div className={`${PLEXI_CARD} mt-4 p-4`} data-testid="org-scim">
            <div className="flex items-center gap-2 mb-3">
              <Icon name="sync_alt" size={16} className="text-accent" />
              <h2 className="text-[14px] font-semibold">Directory sync (SCIM)</h2>
              <span className="text-[11px] text-[var(--ink-40)]">provision and deprovision members from your IdP</span>
            </div>

            {scim.status.configured ? (
              <p className="text-[12px] text-emerald-600 dark:text-emerald-400 leading-relaxed mb-2" data-testid="org-scim-status">
                Directory sync is on.{' '}
                <span className="text-[var(--ink-50)]">
                  {scim.status.lastUsedAt
                    ? `Last used ${new Date(scim.status.lastUsedAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit'
                      })}.`
                    : 'Not used yet.'}
                </span>
              </p>
            ) : (
              <p className="text-[12px] text-[var(--ink-50)] leading-relaxed mb-2" data-testid="org-scim-status">
                Directory sync lets your identity provider such as Okta, Microsoft Entra, or OneLogin provision and
                deprovision members automatically. Generate a token, then paste it and the base URL below into your
                provider.
              </p>
            )}

            <p className="text-[11px] text-[var(--ink-40)] leading-relaxed mb-2">
              Directory sync is available on the Team and Enterprise plans.
            </p>

            {/* Base URL is always shown and copyable. */}
            <label className="block text-[10px] uppercase tracking-wide text-[var(--ink-40)] mb-1">SCIM base URL</label>
            <div className="flex items-center gap-1.5 mb-3">
              <input
                readOnly
                value={scim.baseUrl}
                placeholder="Available once the server enables directory sync."
                data-testid="org-scim-baseurl"
                onFocus={(e) => e.currentTarget.select()}
                className="fb-field flex-1 px-2 py-1 text-[12px] font-mono"
              />
              <CopyButton text={scim.baseUrl} disabled={!scim.baseUrl} />
            </div>

            {/* Revealed token, shown only once immediately after minting. */}
            {scimToken && (
              <div className="mb-3">
                <label className="block text-[10px] uppercase tracking-wide text-[var(--ink-40)] mb-1">
                  Provisioning token
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    readOnly
                    value={scimToken}
                    data-testid="org-scim-token"
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 bg-[var(--surface-sunken)] border border-accent rounded px-2 py-1 text-[12px] font-mono"
                  />
                  <CopyButton text={scimToken} />
                </div>
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                  This token is shown only now. Copy it into your identity provider and store it there, because it
                  cannot be retrieved again.
                </p>
              </div>
            )}

            {canAdmin ? (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    if (!token || !selId) return
                    setScimBusy(true)
                    const r = await mintScimToken(token, selId)
                    setScimBusy(false)
                    if (r.ok && r.token) {
                      setScimToken(r.token)
                      setScimState((s) => ({ status: { configured: true, lastUsedAt: s.status.lastUsedAt }, baseUrl: r.baseUrl ?? s.baseUrl }))
                      setMsg('Directory sync token generated.')
                    } else {
                      setMsg(r.error ?? 'Could not generate a token.')
                    }
                  }}
                  disabled={scimBusy}
                  className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-50"
                  data-testid="org-scim-generate"
                >
                  {scim.status.configured ? 'Regenerate token' : 'Generate token'}
                </button>
                {scim.status.configured && (
                  <button
                    onClick={async () => {
                      if (!token || !selId) return
                      setScimBusy(true)
                      const r = await revokeScimToken(token, selId)
                      setScimBusy(false)
                      if (r.ok) {
                        setScimToken(null)
                        setScimState((s) => ({ status: { configured: false, lastUsedAt: null }, baseUrl: s.baseUrl }))
                        setMsg('Directory sync turned off.')
                      } else {
                        setMsg(r.error ?? 'Could not revoke the token.')
                      }
                    }}
                    disabled={scimBusy}
                    className="text-[12px] px-2.5 py-1 rounded text-rose-500 hover:bg-rose-500/10 disabled:opacity-50"
                    data-testid="org-scim-revoke"
                  >
                    Revoke
                  </button>
                )}
                <span className="text-[11px] text-[var(--ink-40)]">
                  Generating a token rotates it, which invalidates the previous one.
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-[var(--ink-40)]">Only an organization admin can generate or revoke the sync token.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Copy the given text to the clipboard and briefly confirm, matching the copy
// affordance used elsewhere in the app.
function CopyButton({ text, disabled }: { text: string; disabled?: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        if (!text) return
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard unavailable; leave state unchanged */
        }
      }}
      disabled={disabled}
      className="fb-btn-surface inline-flex items-center gap-1 text-[12px] px-2 py-1 hover:border-accent disabled:opacity-40"
      title="Copy"
    >
      <Icon name={copied ? 'check' : 'content_copy'} size={13} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// Turn an audit action code into a readable phrase for the log.
function humanizeAudit(action: string): string {
  const map: Record<string, string> = {
    'auth.login': 'signed in',
    'auth.logout': 'signed out',
    'auth.password_reset': 'reset their password',
    'auth.2fa_enabled': 'turned on two-factor',
    'auth.2fa_disabled': 'turned off two-factor',
    'org.created': 'created the organization',
    'org.deleted': 'deleted the organization',
    'member.added': 'added a member',
    'member.invited': 'invited a member',
    'member.removed': 'removed a member',
    'member.left': 'left the organization',
    'member.role_changed': 'changed a member role',
    'member.profile_updated': 'updated a member profile',
    'member.photo_updated': 'updated a member photo',
    'member.relationship_added': 'added a reporting line',
    'office.created': 'added an office',
    'office.deleted': 'removed an office',
    'livedoc.shared_with_org': 'shared a folder with the org'
  }
  return map[action] ?? action
}

/* ---------------- per-member profile editor ---------------- */

function ProfileEditor({
  profile,
  offices,
  members,
  onSave,
  onUploadPhoto
}: {
  profile: MemberProfile | undefined
  offices: Office[]
  members: { accountId: string; handle: string }[]
  onSave: (patch: Partial<MemberProfile>) => void
  onUploadPhoto: (bytes: ArrayBuffer, mime: string) => Promise<void>
}): JSX.Element {
  const [photoBust, setPhotoBust] = useState(0)
  const [uploading, setUploading] = useState(false)
  if (!profile) {
    return <div className="pl-7 pb-2 text-[11px] text-[var(--ink-40)]">Loading profile…</div>
  }
  const field = 'text-[12px] bg-[var(--surface-sunken)] rounded px-2 py-1 focus:border-accent'
  const photoSrc = absolutePhotoUrl(`/orgs/${profile.orgId}/members/${profile.accountId}/photo`) + (photoBust ? `?v=${photoBust}` : '')
  return (
    <div className="pl-7 pb-3 grid grid-cols-2 gap-2" data-testid="org-profile-editor">
      <div className="col-span-2 flex items-center gap-3">
        <img
          src={photoSrc}
          alt=""
          className="h-11 w-11 rounded-full object-cover bg-[var(--surface-sunken)] ring-1 ring-black/10"
          onError={(e) => {
            e.currentTarget.style.visibility = 'hidden'
          }}
          onLoad={(e) => {
            e.currentTarget.style.visibility = 'visible'
          }}
        />
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Photo</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            data-testid="profile-photo"
            disabled={uploading}
            className="text-[11px] text-[var(--ink-50)]"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setUploading(true)
              const bytes = await f.arrayBuffer()
              await onUploadPhoto(bytes, f.type)
              setUploading(false)
              setPhotoBust(Date.now())
              e.target.value = ''
            }}
          />
        </label>
      </div>
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Title</span>
        <input defaultValue={profile.title ?? ''} onBlur={(e) => onSave({ title: e.target.value || null })} className={field} data-testid="profile-title" placeholder="e.g. Senior Engineer" />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Department</span>
        <input defaultValue={profile.department ?? ''} onBlur={(e) => onSave({ department: e.target.value || null })} className={field} placeholder="e.g. Engineering" />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Office</span>
        <select value={profile.officeId ?? ''} onChange={(e) => onSave({ officeId: e.target.value || null })} className={field} data-testid="profile-office">
          <option value="">— none —</option>
          {offices.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Reports to</span>
        <select value={profile.managerAccountId ?? ''} onChange={(e) => onSave({ managerAccountId: e.target.value || null })} className={field} data-testid="profile-manager">
          <option value="">— no manager —</option>
          {members.map((m) => (
            <option key={m.accountId} value={m.accountId}>
              {personDisplayName(m, m.handle)}
            </option>
          ))}
        </select>
      </label>
      <div className="col-span-2 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Personal hours</span>
        <input
          type="number" min={0} max={24}
          defaultValue={hourStr(profile.workStart)}
          key={`pws-${profile.workStart}`}
          onBlur={(e) => onSave({ workStart: numOrNull(e.target.value) })}
          placeholder="start"
          className="fb-field w-16 text-[12px] text-center px-1.5 py-0.5"
        />
        <span className="text-[11px] text-[var(--ink-40)]">to</span>
        <input
          type="number" min={0} max={24}
          defaultValue={hourStr(profile.workEnd)}
          key={`pwe-${profile.workEnd}`}
          onBlur={(e) => onSave({ workEnd: numOrNull(e.target.value) })}
          placeholder="end"
          className="fb-field w-16 text-[12px] text-center px-1.5 py-0.5"
        />
        <span className="text-[11px] text-[var(--ink-40)]">blank = inherit office, then company</span>
      </div>
    </div>
  )
}

/* ---------------- one office row ---------------- */

function OfficeRow({
  office,
  canAdmin,
  onSave,
  onDelete
}: {
  office: Office
  canAdmin: boolean
  onSave: (patch: OfficeInput) => void
  onDelete: () => void
}): JSX.Element {
  const field = 'text-[12px] bg-[var(--surface-sunken)] rounded px-2 py-1 focus:border-accent'
  const small = 'w-16 text-[12px] text-center bg-[var(--surface-sunken)] rounded px-1.5 py-0.5'
  if (!canAdmin) {
    return (
      <div className="text-[12px] text-[var(--ink-70)] flex items-center gap-2">
        <Icon name="business" size={13} className="text-[var(--ink-40)]" />
        {office.name}
        <span className="text-[11px] text-[var(--ink-40)]">{office.kind}{office.city ? ` · ${office.city}` : ''}</span>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-[var(--edge-soft)] p-2" data-testid={`office-row-${office.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <input defaultValue={office.name} onBlur={(e) => onSave({ name: e.target.value })} className={`${field} flex-1 min-w-[120px] font-medium`} data-testid="office-name" />
        <select defaultValue={office.kind} onChange={(e) => onSave({ kind: e.target.value as OfficeKind })} className={field}>
          {OFFICE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button onClick={onDelete} className="icon-btn" title="Delete office" data-testid="office-delete">
          <Icon name="delete" size={14} />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap text-[11px] text-[var(--ink-40)]">
        <input defaultValue={office.city ?? ''} onBlur={(e) => onSave({ city: e.target.value || null })} placeholder="City" className={`${field} w-28`} />
        <span>lat</span>
        <input defaultValue={office.lat == null ? '' : String(office.lat)} onBlur={(e) => onSave({ lat: numOrNull(e.target.value) })} placeholder="lat" className={small} />
        <span>lng</span>
        <input defaultValue={office.lng == null ? '' : String(office.lng)} onBlur={(e) => onSave({ lng: numOrNull(e.target.value) })} placeholder="lng" className={small} />
        <span>tz min</span>
        <input defaultValue={String(office.tzOffsetMin)} onBlur={(e) => onSave({ tzOffsetMin: numOrNull(e.target.value) ?? 0 })} placeholder="0" className={small} />
        <span>hours</span>
        <input defaultValue={hourStr(office.workStart)} key={`ows-${office.workStart}`} onBlur={(e) => onSave({ workStart: numOrNull(e.target.value) })} placeholder="start" className={small} />
        <span>to</span>
        <input defaultValue={hourStr(office.workEnd)} key={`owe-${office.workEnd}`} onBlur={(e) => onSave({ workEnd: numOrNull(e.target.value) })} placeholder="end" className={small} />
      </div>
    </div>
  )
}
