import { useEffect, useMemo, useState } from 'react'
import Icon from '../Icon'
import { DashboardHeader, ListRow, StatTile, StatusPill, RailCard } from '../plexi'
import { useAccountStore } from '../../stores/account'
import { useViewStore } from '../../stores/view'
import { usePresenceStore, type PresenceStatus } from '../../stores/presence'
import { listOrgs, type OrgMembership } from '../../lib/orgsClient'
import { usePeopleMap, type MapPerson } from '../../lib/peopleMap/usePeopleMap'
import { useViewKindEnabled } from '../../lib/viewCapability'
import { personDisplayName, personInitials, personFirstName } from '../../lib/personName'

// PlexiPeople home: the front door of the team area. It reads the SAME real
// sources the People Map reads — the org directory (members, offices, profiles)
// plus the live presence socket — and presents team status, a people directory,
// and a way into the organisation map. There is no sample data anywhere. When a
// workspace has no organisation or no teammates yet, the page shows an honest
// empty state pointing the user to set the team up, never an invented headcount.
//
// Deliberately omitted from the mockup because the data is NOT tracked: upcoming
// birthdays, work anniversaries, "new this month", and "celebrations". Member
// profiles carry title, department, office, location and working hours, but no
// birthdate and no start date, so any such card would have to be fabricated.
// Rather than show empty fake cards we leave them out entirely.

// Labels + avatar-dot colors only; the status chip itself is StatusPill, whose
// PILL map is the one source of presence tones.
const STATUS_META: Record<PresenceStatus, { label: string; dot: string }> = {
  online: { label: 'Online', dot: 'bg-emerald-500' },
  away: { label: 'Away', dot: 'bg-amber-500' },
  focus: { label: 'In focus', dot: 'bg-violet-500' },
  busy: { label: 'Busy', dot: 'bg-rose-500' },
  offline: { label: 'Offline', dot: 'bg-stone-400' }
}

const AV_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444']
function colorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return AV_COLORS[Math.abs(h) % AV_COLORS.length]
}
function initials(handle: string): string {
  const parts = handle.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (handle.replace(/^@/, '').slice(0, 2) || '?').toUpperCase()
}

function Avatar({ seed, name, size = 34, photoUrl }: { seed: string; name?: string; size?: number; photoUrl?: string | null }): JSX.Element {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name ?? seed}
        width={size}
        height={size}
        loading="lazy"
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.4, background: colorFor(seed) }}
    >
      {name ? personInitials({ name }) : initials(seed)}
    </span>
  )
}

function statusRank(s: PresenceStatus): number {
  return s === 'online' ? 0 : s === 'focus' ? 1 : s === 'busy' ? 2 : s === 'away' ? 3 : 4
}

// One row in the directory. Real member only: handle, role/title/department, the
// real live presence dot, and their office if one is set.
function MemberRow({ person, enterDelay }: { person: MapPerson; enterDelay: number }): JSX.Element {
  const meta = STATUS_META[person.liveStatus]
  const sub =
    [person.title, person.department].filter(Boolean).join(' · ') ||
    (person.role === 'guest' ? 'Guest' : person.role)
  return (
    <ListRow
      className="px-3 py-2 fb-fade-in-up"
      style={{ animationDelay: `${enterDelay}ms` }}
      data-testid="people-member-row"
    >
      <span className="relative shrink-0">
        <Avatar seed={person.handle} name={personDisplayName(person, person.handle)} photoUrl={person.photoUrl} />
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--surface-raised)] ${meta.dot}`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <div className="fb-t-body font-medium text-[var(--ink-100)] truncate">
          {personDisplayName(person, person.handle)}
          {person.isSelf && <span className="text-[var(--ink-50)] font-normal"> (you)</span>}
        </div>
        <div className="fb-t-caption truncate">{sub}</div>
      </span>
      <span className="shrink-0" data-testid="people-member-status">
        <StatusPill tone={person.liveStatus} label={meta.label} />
      </span>
    </ListRow>
  )
}

export default function PeopleHomeView(): JSX.Element {
  const token = useAccountStore((s) => s.sessionToken)
  const account = useAccountStore((s) => s.account)
  const goPeopleMap = useViewStore((s) => s.goPeopleMap)
  const goOrg = useViewStore((s) => s.goOrg)
  // The People area itself is product_people; within it the map and the org
  // directory are their own capabilities. Hide the entries that jump to a gated
  // one so a teammate never lands on a locked wall from here.
  const viewEnabled = useViewKindEnabled()
  const mapEnabled = viewEnabled('people-map')
  const orgEnabled = viewEnabled('organization')
  // Subscribe to presence so the counts re-render the instant the socket updates.
  usePresenceStore((s) => s.peers)
  usePresenceStore((s) => s.myStatus)

  const [orgs, setOrgs] = useState<OrgMembership[]>([])
  const [orgId, setOrgId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!token) return
    void listOrgs(token).then((list) => {
      setOrgs(list)
      setOrgId((prev) => prev ?? list.find((o) => !o.personal)?.id ?? list[0]?.id ?? null)
    })
  }, [token])

  const { data, loading, error, refresh } = usePeopleMap(orgId)
  const selectedOrg = orgs.find((o) => o.id === orgId) ?? null

  // Real presence counts, derived from the live merge in usePeopleMap. Online,
  // away and offline are computed from the actual status of each real member.
  const counts = useMemo(() => {
    const people = data?.people ?? []
    const online = people.filter((p) => p.liveStatus === 'online' || p.liveStatus === 'focus').length
    const away = people.filter((p) => p.liveStatus === 'away' || p.liveStatus === 'busy').length
    const offline = people.filter((p) => p.liveStatus === 'offline').length
    return { total: people.length, online, away, offline }
  }, [data])

  const directory = useMemo(() => {
    const people = data?.people ?? []
    const q = query.trim().toLowerCase()
    const filtered = q
      ? people.filter(
          (p) =>
            p.handle.toLowerCase().includes(q) ||
            personDisplayName(p, p.handle).toLowerCase().includes(q) ||
            (p.title ?? '').toLowerCase().includes(q) ||
            (p.department ?? '').toLowerCase().includes(q)
        )
      : people
    return [...filtered].sort(
      (a, b) =>
        statusRank(a.liveStatus) - statusRank(b.liveStatus) ||
        personDisplayName(a, a.handle).localeCompare(personDisplayName(b, b.handle))
    )
  }, [data, query])

  const hh = new Date().getHours()
  const who = account ? personFirstName(account, '') : ''
  const greeting = `Good ${hh < 12 ? 'morning' : hh < 18 ? 'afternoon' : 'evening'}${who ? `, ${who}` : ''}`

  // Honest, layered empty states. Each one names exactly what is missing and
  // points the user at the place to fix it — never a fabricated team.
  let emptyBody: JSX.Element | null = null
  if (!token) {
    emptyBody = (
      <Empty
        title="Sign in to see your team"
        body="PlexiiPeople shows everyone in your workspace, who is around, and your organisation structure."
      />
    )
  } else if (orgs.length > 0 && !orgs.some((o) => !o.personal)) {
    emptyBody = (
      <Empty
        title="Create your organisation first"
        body="PlexiiPeople maps a real organisation. Create one and invite your team, then their profiles appear here."
        action={orgEnabled ? { label: 'Open Organisations', onClick: goOrg } : undefined}
      />
    )
  } else if (loading && !data) {
    emptyBody = (
      <div className="fb-card px-4 py-4 space-y-3" data-testid="people-loading">
        <div className="fb-skeleton h-9 w-1/2" />
        <div className="fb-skeleton h-9" />
        <div className="fb-skeleton h-9" />
        <div className="fb-skeleton h-9 w-3/4" />
      </div>
    )
  } else if (error) {
    emptyBody = <Empty title="Could not load your team" body={error} action={{ label: 'Try again', onClick: refresh }} />
  } else if (!data || data.people.length === 0) {
    emptyBody = (
      <Empty
        title="No teammates yet"
        body="Invite people to your workspace, then give them profiles so they show up in the directory and on the map."
        action={orgEnabled ? { label: 'Invite people to your workspace', onClick: goOrg } : undefined}
      />
    )
  }

  return (
    <div className="h-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="people-home">
      <div className="max-w-[1100px] mx-auto px-6 py-8">
        <DashboardHeader
          title="PlexiiPeople"
          greeting={greeting}
          subtitle={selectedOrg ? `Your team · ${selectedOrg.name}` : 'Your team, who is around, and your organisation'}
          actions={
            <>
              {orgs.filter((o) => !o.personal).length > 1 && (
                <select
                  className="fb-field fb-t-label !w-auto !py-1.5"
                  value={orgId ?? ''}
                  onChange={(e) => setOrgId(e.target.value || null)}
                  data-testid="people-org"
                >
                  {orgs.filter((o) => !o.personal).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
              {mapEnabled && (
                <button
                  onClick={goPeopleMap}
                  data-testid="people-open-map"
                  className="inline-flex items-center gap-1.5 h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-90)]"
                >
                  <Icon name="travel_explore" size={15} />
                  Organisation map
                </button>
              )}
            </>
          }
        />

        {/* Team status — real presence counts only. Total People is the real
            member count. Each tile is computed from the live merge, so an empty
            org reads zero rather than a fabricated headcount. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 fb-fade-in-up" data-testid="people-status">
          <StatTile icon="groups" label="Total people" value={counts.total} tone="accent" />
          <StatTile icon="bolt" label="Online" value={counts.online} tone="emerald" />
          <StatTile icon="schedule" label="Away or busy" value={counts.away} tone="amber" />
          <StatTile icon="dark_mode" label="Offline" value={counts.offline} tone="stone" />
        </div>

        {emptyBody ? (
          <div data-testid="people-directory-empty">{emptyBody}</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <RailCard title="People directory" icon="badge" tone="accent">
                <div className="mb-2">
                  <div className="fb-field flex items-center gap-2 h-9 !py-0">
                    <Icon name="search" size={15} className="text-[var(--ink-50)]" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search people by name, role or team"
                      data-testid="people-directory-search"
                      className="flex-1 bg-transparent fb-t-body text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
                    />
                  </div>
                </div>
                <div data-testid="people-directory">
                  {directory.length === 0 ? (
                    <div className="px-3 py-6 fb-t-label text-[var(--ink-50)] text-center">
                      No one matches that search.
                    </div>
                  ) : (
                    directory.map((p, i) => <MemberRow key={p.accountId} person={p} enterDelay={Math.min(i * 25, 250)} />)
                  )}
                </div>
              </RailCard>
            </div>

            <div className="flex flex-col gap-4">
              <RailCard title="Around right now" icon="bolt" tone="emerald">
                {counts.online === 0 ? (
                  <div className="fb-t-label text-[var(--ink-50)]">No one is online right now.</div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {directory
                      .filter((p) => p.liveStatus === 'online' || p.liveStatus === 'focus')
                      .slice(0, 8)
                      .map((p) => (
                        <div key={p.accountId} className="flex items-center gap-2.5 py-1">
                          <span className="relative shrink-0">
                            <Avatar seed={p.handle} name={personDisplayName(p, p.handle)} size={26} photoUrl={p.photoUrl} />
                            <span
                              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-raised)] ${STATUS_META[p.liveStatus].dot}`}
                            />
                          </span>
                          <span className="min-w-0 flex-1 fb-t-label text-[var(--ink-90)] truncate">
                            {p.liveWorkingOn || personDisplayName(p, p.handle)}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </RailCard>

              {mapEnabled && (
                <RailCard title="Organisation map" icon="account_tree" tone="violet">
                  <p className="fb-t-label text-[var(--ink-70)] leading-snug mb-2.5">
                    See everyone by office and reporting line, with their local day and who is reachable now.
                  </p>
                  <button
                    onClick={goPeopleMap}
                    data-testid="people-orgmap"
                    className="inline-flex items-center gap-1.5 fb-t-label text-accent hover:underline fb-press"
                  >
                    Open the organisation map
                    <Icon name="arrow_forward" size={14} />
                  </button>
                </RailCard>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Empty({
  title,
  body,
  action
}: {
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="fb-card px-6 py-10 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-[var(--radius-row)] bg-[rgb(var(--accent)/0.1)] text-[rgb(var(--accent))] mb-3">
        <Icon name="groups" size={24} />
      </div>
      <h2 className="fb-t-title text-[var(--ink-100)]">{title}</h2>
      <p className="mt-1 fb-t-body text-[var(--ink-50)] max-w-md mx-auto leading-relaxed">{body}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-field)] bg-accent !text-white fb-t-label fb-press hover:bg-[rgb(var(--accent-hover))]"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
