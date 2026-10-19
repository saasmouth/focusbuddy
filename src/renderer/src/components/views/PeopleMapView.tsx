import { useEffect, useMemo, useState } from 'react'
import './peopleMap.css'
import Icon from '../Icon'
import { DashboardHeader, StatTile, RailCard } from '../plexi'
import { useAccountStore } from '../../stores/account'
import { useViewStore } from '../../stores/view'
import { useCallStore } from '../../stores/call'
import { useMessagingStore } from '../../stores/messaging'
import { useKnockStore } from '../../stores/knock'
import {
  reachableNow,
  followTheSunPairs,
  suggestedConnections,
  isolatedRemotes
} from '../../lib/peopleMap/collaboration'
import {
  listOrgs,
  setMemberProfile,
  addRelationship,
  removeRelationship,
  type OrgMembership,
  type WorkWindow,
  type RelationshipKind
} from '../../lib/orgsClient'
import { usePeopleMap, type MapPerson, type PeopleMapData } from '../../lib/peopleMap/usePeopleMap'
import type { PresenceStatus } from '../../stores/presence'
import { daylightFor, dayBarGradient, fmtHour } from '../../lib/peopleMap/daylight'
import { subsolarPoint, sunElevation } from '../../lib/peopleMap/solar'
import { COLS, ROWS, LAND, project, cellCenter } from '../../lib/peopleMap/worldmap'
import { groupByOffice, buildHierarchy, officeWindow } from '../../lib/peopleMap/structure'
import { personDisplayName, personInitials, personFirstName } from '../../lib/personName'
import { entitlementFor } from '../../lib/entitlementReason'
import { promptUpgrade } from '../../stores/upgradePrompt'

// The in-product People Map: every teammate across the org placed by office and
// reporting line, with their real local day and live presence. Reads the org
// People Map endpoint (offices + profiles + resolved work windows) and overlays
// the live presence socket. No sample data — an org with nothing set up shows
// an honest empty state pointing to the admin console.

type Tab = 'offices' | 'global' | 'hierarchy' | 'collaboration'

const STATUS_META: Record<PresenceStatus, { label: string; cls: string }> = {
  online: { label: 'Online', cls: 'pm-st-online' },
  away: { label: 'Away', cls: 'pm-st-away' },
  focus: { label: 'In focus', cls: 'pm-st-focus' },
  busy: { label: 'Busy', cls: 'pm-st-busy' },
  offline: { label: 'Offline', cls: 'pm-st-offline' }
}

// The name we SHOW for a map person, falling back to their handle. Handles stay
// the colour seed and routing key; this is display only.
const dispName = (p: { firstName?: string | null; lastName?: string | null; handle: string }): string =>
  personDisplayName(p, p.handle)

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

// `seed` stays the routing handle so a person keeps the same colour everywhere;
// `name` is the real name we show (alt text + initials), falling back to the seed.
function Avatar({
  seed,
  name,
  size = 30,
  photoUrl
}: {
  seed: string
  name?: string
  size?: number
  photoUrl?: string | null
}): JSX.Element {
  const label = name ?? seed
  if (photoUrl) {
    return (
      <img
        className="pm-av pm-av--photo"
        src={photoUrl}
        alt={label}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        loading="lazy"
      />
    )
  }
  return (
    <span className="pm-av" style={{ width: size, height: size, fontSize: size * 0.4, background: colorFor(seed) }}>
      {name ? personInitials({ name }) : initials(seed)}
    </span>
  )
}

function DayBar({
  lat,
  lng,
  tz,
  work,
  now,
  labels = false,
  height = 8
}: {
  lat: number
  lng: number
  tz: number
  work: WorkWindow
  now: Date
  labels?: boolean
  height?: number
}): JSX.Element {
  const info = daylightFor(lat, lng, tz, now, work)
  const pct = (info.hour / 24) * 100
  const ws = (work.start / 24) * 100
  const we = (work.end / 24) * 100
  return (
    <div className="pm-daybar">
      <div className="pm-daybar__track" style={{ height, background: dayBarGradient(info) }}>
        <span className="pm-daybar__work" style={{ left: `${ws}%`, width: `${Math.max(0, we - ws)}%` }} />
        <span className="pm-daybar__marker" style={{ left: `${pct}%` }} />
      </div>
      {labels && (
        <div className="pm-daybar__labels">
          <span>↑ {fmtHour(info.sunrise)}</span>
          <span>{info.label} · {fmtHour(info.hour)}</span>
          <span>↓ {fmtHour(info.sunset)}</span>
        </div>
      )}
    </div>
  )
}

/* ---------------- offices ---------------- */

// Presence sort order: who is reachable right now comes first.
function statusRank(s: PresenceStatus): number {
  return s === 'online' ? 0 : s === 'focus' ? 1 : s === 'busy' ? 2 : s === 'away' ? 3 : 4
}

function OfficesTab({ data, now }: { data: PeopleMapData; now: Date }): JSX.Element {
  const groups = groupByOffice(data.people, data.offices)
  const liveCount = (people: MapPerson[], st: PresenceStatus): number =>
    people.filter((p) => p.liveStatus === st).length

  return (
    <div className="pm-offices">
      {groups.map(({ office, people }) => {
        const hasGeo = !!office && office.lat != null && office.lng != null
        return (
          <div className="pm-office" key={office?.id ?? 'unassigned'}>
            <div className="pm-office__top">
              <span className="pm-office__name">{office ? office.name : 'No office set'}</span>
              <span className="pm-office__kind">{office ? office.kind : 'unassigned'}</span>
              <span className="pm-office__count">{people.length}</span>
            </div>
            {office?.city && <div className="pm-office__where">{office.city}</div>}
            {hasGeo && (
              <DayBar
                lat={office!.lat!}
                lng={office!.lng!}
                tz={office!.tzOffsetMin}
                work={officeWindow(office!, data.defaultHours)}
                now={now}
                labels
              />
            )}
            <div className="pm-office__pres">
              <span><i className="pm-dot pm-st-online" style={{ width: 7, height: 7 }} /> {liveCount(people, 'online')} online</span>
              <span><i className="pm-dot pm-st-focus" style={{ width: 7, height: 7 }} /> {liveCount(people, 'focus')} focus</span>
              <span><i className="pm-dot pm-st-busy" style={{ width: 7, height: 7 }} /> {liveCount(people, 'busy')} busy</span>
            </div>
            <div className="pm-people">
              {[...people]
                .sort((a, b) => statusRank(a.liveStatus) - statusRank(b.liveStatus) || dispName(a).localeCompare(dispName(b)))
                .map((p) => (
                  <PersonRow key={p.accountId} person={p} now={now} />
                ))}
              {people.length === 0 && <div className="pm-office__where">No one here yet.</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// The reach-anyone-in-a-click action cluster shown on a person row or card:
// message, knock, and call. Hidden for yourself and for anyone offline (you
// cannot reach them). When it is after hours where the person is, the knock
// switches to a moon and warns, so you think twice before knocking at 2am.
function PersonActions({
  person,
  offHours = false,
  className = ''
}: {
  person: MapPerson
  offHours?: boolean
  className?: string
}): JSX.Element | null {
  const startCall = useCallStore((s) => s.startCall)
  const startDm = useMessagingStore((s) => s.startDm)
  const goMessages = useViewStore((s) => s.goMessages)
  const knock = useKnockStore((s) => s.knock)
  if (person.isSelf || person.liveStatus === 'offline') return null
  const target = { accountId: person.accountId, handle: person.handle }
  const name = personDisplayName(person, person.handle)
  async function chat(): Promise<void> {
    // Starting a DM from the map is a chat initiator outside Chat, so gate it on
    // the same 'chat' capability the backbone enforces for the messages surface.
    const ent = entitlementFor('chat', 'Chat')
    if (!ent.enabled) {
      promptUpgrade(ent.reason)
      return
    }
    await startDm(person.handle) // opens the conversation on success
    goMessages()
  }
  return (
    <span className={`pm-actions ${className}`} onClick={(e) => e.stopPropagation()}>
      <button
        className="pm-iconbtn"
        data-testid="person-chat"
        title={`Message ${name}`}
        aria-label={`Message ${name}`}
        onClick={() => void chat()}
      >
        <Icon name="chat_bubble" size={14} />
      </button>
      <button
        className="pm-iconbtn"
        data-testid="person-knock"
        title={offHours ? `Knock ${name} (it is after hours for them)` : `Knock ${name}`}
        aria-label={`Knock ${name}`}
        onClick={() => knock(target)}
      >
        <Icon name={offHours ? 'bedtime' : 'sensor_door'} size={14} className={offHours ? 'text-[var(--ink-50)]' : ''} />
      </button>
      <button
        className="pm-iconbtn"
        data-testid="call-btn"
        title={`Call ${name}`}
        aria-label={`Call ${name}`}
        onClick={() => void startCall(target, 'video')}
      >
        <Icon name="video_call" size={14} />
      </button>
    </span>
  )
}

function PersonRow({ person, now }: { person: MapPerson; now: Date }): JSX.Element {
  const meta = STATUS_META[person.liveStatus]
  const hasGeo = person.lat != null && person.lng != null && person.tzOffsetMin != null
  const day = hasGeo ? daylightFor(person.lat!, person.lng!, person.tzOffsetMin!, now, person.workWindow) : null
  return (
    <div className="pm-prow">
      <span className="pm-prow__rel">
        <Avatar seed={person.handle} name={personDisplayName(person, person.handle)} size={28} photoUrl={person.photoUrl} />
        <span className={`pm-prow__sdot pm-dot ${meta.cls}`} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <div className="pm-prow__name">
          {personDisplayName(person, person.handle)}
          {person.isSelf && <span style={{ color: '#8b96b3', fontWeight: 500 }}> (you)</span>}
          {person.role === 'guest' && <span className="pm-badge-guest">Guest</span>}
        </div>
        <div className="pm-prow__sub">
          {person.liveWorkingOn || person.title || meta.label}
          {person.department ? ` · ${person.department}` : ''}
        </div>
      </span>
      {day && (
        <span className="pm-prow__time">
          {fmtHour(day.hour)}
          <br />
          <span style={{ color: day.working ? '#6ee7b7' : '#93a0bd' }}>{day.workLabel}</span>
        </span>
      )}
      <PersonActions person={person} offHours={day ? !day.working : false} className="pm-prow__call" />
    </div>
  )
}

/* ---------------- global map ---------------- */

function GlobalTab({ data, now }: { data: PeopleMapData; now: Date }): JSX.Element {
  // Which pin's popover is open, if any.
  const [sel, setSel] = useState<{ kind: 'person' | 'office'; id: string } | null>(null)
  const sun = useMemo(() => subsolarPoint(now), [now])
  const sunPos = project(sun.lat, sun.lng)
  const moonPos = project(-sun.lat, ((sun.lng + 360) % 360) - 180)

  const dots = useMemo(() => {
    const out: { col: number; row: number }[] = []
    LAND.forEach((k) => {
      const [c, r] = k.split(',').map(Number)
      out.push({ col: c, row: r })
    })
    return out
  }, [])
  const dotClass = (col: number, row: number): string => {
    const { lat, lng } = cellCenter(col, row)
    const el = sunElevation(lat, lng, now)
    return el > 6 ? 'pm-land' : el < -6 ? 'pm-land pm-land--night' : 'pm-land pm-land--twi'
  }

  const officeById = new Map(data.offices.map((o) => [o.id, o]))
  const clusters = data.offices
    .filter((o) => o.lat != null && o.lng != null)
    .map((o) => ({ office: o, count: data.people.filter((p) => p.officeId === o.id).length }))
  // Remote/external individuals with their own coordinates and no placed office.
  const loosePins = data.people.filter(
    (p) => p.lat != null && p.lng != null && (!p.officeId || !officeById.get(p.officeId)?.lat)
  )

  return (
    <div className="pm-global">
    <div className="pm-world">
      <svg className="pm-world__grid" viewBox={`0 0 ${COLS} ${ROWS}`} preserveAspectRatio="none">
        {dots.map((d) => (
          <circle key={`${d.col}-${d.row}`} cx={d.col + 0.5} cy={d.row + 0.5} r={0.32} className={dotClass(d.col, d.row)} />
        ))}
      </svg>
      <span className="pm-sun" style={{ left: `${sunPos.x * 100}%`, top: `${sunPos.y * 100}%` }}>
        <Icon name="light_mode" size={18} className="" />
      </span>
      <span className="pm-moon" style={{ left: `${moonPos.x * 100}%`, top: `${moonPos.y * 100}%`, opacity: 0.5 }}>
        <Icon name="dark_mode" size={14} className="" />
      </span>

      {clusters.map(({ office, count }) => {
        const { x, y } = project(office.lat!, office.lng!)
        const info = daylightFor(office.lat!, office.lng!, office.tzOffsetMin, now, officeWindow(office, data.defaultHours))
        return (
          <button
            key={office.id}
            className={`pm-pin ${sel?.kind === 'office' && sel.id === office.id ? 'pm-pin--sel' : ''}`}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, background: office.accent ?? '#5566f0', width: 26, height: 26 }}
            title={`${office.name} — ${count} people · ${info.label}, ${fmtHour(info.hour)} local`}
            onClick={() => setSel({ kind: 'office', id: office.id })}
          >
            {count}
          </button>
        )
      })}

      {loosePins.map((p) => {
        const { x, y } = project(p.lat!, p.lng!)
        const meta = STATUS_META[p.liveStatus]
        const working = daylightFor(p.lat!, p.lng!, p.tzOffsetMin ?? 0, now, p.workWindow).working
        return (
          <button
            key={p.accountId}
            className={`pm-pin ${working ? '' : 'pm-pin--off'} ${sel?.kind === 'person' && sel.id === p.accountId ? 'pm-pin--sel' : ''}`}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, background: colorFor(p.handle) }}
            title={`${dispName(p)} — ${meta.label}${p.city ? ` · ${p.city}` : ''}`}
            onClick={() => setSel({ kind: 'person', id: p.accountId })}
          >
            {personInitials(p)}
            <span className={`pm-pin__sdot pm-dot ${meta.cls}`} />
          </button>
        )
      })}
    </div>
    {sel && <MapPopover sel={sel} data={data} now={now} onClose={() => setSel(null)} />}
    </div>
  )
}

// A card that pops over the world map when a pin is clicked: a person's details
// and reach actions, or an office's roster. Positioned near the pin, clamped to
// stay on the map. A backdrop closes it.
function MapPopover({
  sel,
  data,
  now,
  onClose
}: {
  sel: { kind: 'person' | 'office'; id: string }
  data: PeopleMapData
  now: Date
  onClose: () => void
}): JSX.Element | null {
  const person = sel.kind === 'person' ? data.people.find((p) => p.accountId === sel.id) ?? null : null
  const office = sel.kind === 'office' ? data.offices.find((o) => o.id === sel.id) ?? null : null
  const anchor =
    person && person.lat != null && person.lng != null
      ? project(person.lat, person.lng)
      : office && office.lat != null && office.lng != null
        ? project(office.lat, office.lng)
        : null
  if (!anchor) return null
  // Clamp horizontally so the card never runs off the map edges.
  const left = Math.min(86, Math.max(14, anchor.x * 100))
  const below = anchor.y < 0.34
  const officePeople = office
    ? [...data.people.filter((p) => p.officeId === office.id)].sort(
        (a, b) => statusRank(a.liveStatus) - statusRank(b.liveStatus) || dispName(a).localeCompare(dispName(b))
      )
    : []

  return (
    <>
      <div className="pm-pop__backdrop" onClick={onClose} />
      <div
        className="pm-pop"
        style={{ left: `${left}%`, top: `${anchor.y * 100}%`, transform: `translate(-50%, ${below ? '16px' : 'calc(-100% - 16px)'})` }}
        data-testid="map-popover"
      >
        {person && (
          <div className="pm-pop__person">
            <PersonCard person={person} now={now} />
          </div>
        )}
        {office && (
          <div className="pm-pop__office">
            <div className="pm-pop__title">
              {office.name}
              <span className="pm-pop__sub">
                {officePeople.length} {officePeople.length === 1 ? 'person' : 'people'}
              </span>
            </div>
            <div className="pm-pop__list">
              {officePeople.length === 0 ? (
                <div className="pm-office__where">No one here yet.</div>
              ) : (
                officePeople.map((p) => <PersonRow key={p.accountId} person={p} now={now} />)
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// A compact person card for the map popover: who they are, their local time and
// day, and the reach actions.
function PersonCard({ person, now }: { person: MapPerson; now: Date }): JSX.Element {
  const meta = STATUS_META[person.liveStatus]
  const hasGeo = person.lat != null && person.lng != null && person.tzOffsetMin != null
  const day = hasGeo ? daylightFor(person.lat!, person.lng!, person.tzOffsetMin!, now, person.workWindow) : null
  return (
    <div className="pm-pcard">
      <div className="pm-pcard__head">
        <span className="pm-prow__rel">
          <Avatar seed={person.handle} name={dispName(person)} size={34} photoUrl={person.photoUrl} />
          <span className={`pm-prow__sdot pm-dot ${meta.cls}`} />
        </span>
        <span style={{ minWidth: 0 }}>
          <div className="pm-pcard__name">{dispName(person)}</div>
          <div className="pm-pcard__role">
            {person.title || meta.label}
            {person.department ? ` · ${person.department}` : ''}
          </div>
        </span>
      </div>
      {day && (
        <div className="pm-pcard__when">
          {fmtHour(day.hour)} local · <span style={{ color: day.working ? '#34d399' : '#94a3b8' }}>{day.workLabel}</span>
          {person.city ? ` · ${person.city}` : ''}
        </div>
      )}
      <div className="pm-pcard__actions">
        <PersonActions person={person} offHours={day ? !day.working : false} className="pm-pcard__act" />
      </div>
    </div>
  )
}

/* ---------------- hierarchy ---------------- */

function HierarchyTab({ data, now, refresh }: { data: PeopleMapData; now: Date; refresh: () => void }): JSX.Element {
  const { roots, childrenOf } = buildHierarchy(data.people)
  const token = useAccountStore((s) => s.sessionToken)
  // Only an owner or admin can reshape the org chart.
  const myRole = data.people.find((p) => p.isSelf)?.role
  const canEdit = myRole === 'owner' || myRole === 'admin'
  const byId = new Map(data.people.map((p) => [p.accountId, p]))
  const [dragId, setDragId] = useState<string | null>(null)
  const [editErr, setEditErr] = useState<string | null>(null)
  const [addingFor, setAddingFor] = useState<string | null>(null)

  async function reparent(childId: string, managerId: string | null): Promise<void> {
    if (!token || !canEdit || childId === managerId) return
    setEditErr(null)
    const r = await setMemberProfile(token, data.orgId, childId, { managerAccountId: managerId })
    if (!r.ok) setEditErr(r.error ?? 'Could not change reporting line.')
    refresh()
  }
  async function addRel(fromId: string, toId: string, kind: RelationshipKind): Promise<void> {
    if (!token) return
    setEditErr(null)
    const r = await addRelationship(token, data.orgId, fromId, toId, kind)
    if (!r.ok) setEditErr(r.error ?? 'Could not add the dotted line.')
    setAddingFor(null)
    refresh()
  }
  async function removeRel(fromId: string, toId: string, kind: RelationshipKind): Promise<void> {
    if (!token) return
    await removeRelationship(token, data.orgId, fromId, toId, kind)
    refresh()
  }

  const renderNode = (p: MapPerson, depth: number): JSX.Element => {
    const meta = STATUS_META[p.liveStatus]
    const children = childrenOf(p.accountId)
    const hasGeo = p.lat != null && p.lng != null && p.tzOffsetMin != null
    const day = hasGeo ? daylightFor(p.lat!, p.lng!, p.tzOffsetMin!, now, p.workWindow) : null
    return (
      <div className="pm-node" key={p.accountId}>
        <div className="pm-node__self">
          <div
            className={`pm-card ${canEdit ? 'pm-card--draggable' : ''} ${dragId && dragId !== p.accountId ? 'pm-card--drop' : ''}`}
            draggable={canEdit}
            onDragStart={canEdit ? () => setDragId(p.accountId) : undefined}
            onDragEnd={canEdit ? () => setDragId(null) : undefined}
            onDragOver={canEdit && dragId && dragId !== p.accountId ? (e) => e.preventDefault() : undefined}
            onDrop={
              canEdit && dragId && dragId !== p.accountId
                ? (e) => {
                    e.preventDefault()
                    const child = dragId
                    setDragId(null)
                    void reparent(child, p.accountId)
                  }
                : undefined
            }
            title={canEdit ? 'Drag onto another person to change who they report to' : undefined}
          >
            <span className="pm-card__rel">
              <Avatar seed={p.handle} name={dispName(p)} size={32} photoUrl={p.photoUrl} />
              <span className={`pm-card__sdot pm-dot ${meta.cls}`} />
            </span>
            <span>
              <div className="pm-card__name">
                {dispName(p)}
                {p.isSelf && <span style={{ color: '#8b96b3', fontWeight: 500 }}> (you)</span>}
                {p.role === 'guest' && <span className="pm-badge-guest">Guest</span>}
              </div>
              <div className="pm-card__role">{p.title || p.role}{p.department ? ` · ${p.department}` : ''}</div>
            </span>
            {day && (
              <span className={`pm-worktag ${day.working ? 'is-working' : 'is-off'}`} title={`${day.label} · ${fmtHour(day.hour)} local`}>
                {day.working ? 'working' : day.workLabel.toLowerCase()}
              </span>
            )}
            <PersonActions person={p} offHours={day ? !day.working : false} className="pm-card__call" />
          </div>
          {(p.relationships.length > 0 || canEdit) && (
            <div className="pm-dotted" data-testid="pm-dotted">
              {p.relationships.map((r) => (
                <span className="pm-dotted__chip" key={`${r.toAccountId}-${r.kind}`} title={`${r.kind} relationship`}>
                  <Icon name="link" size={11} />
                  {r.kind} · {(() => { const t = byId.get(r.toAccountId); return t ? dispName(t) : 'unknown' })()}
                  {canEdit && (
                    <button
                      className="pm-dotted__x"
                      aria-label="Remove dotted line"
                      data-testid="pm-dotted-remove"
                      onClick={() => void removeRel(p.accountId, r.toAccountId, r.kind)}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  )}
                </span>
              ))}
              {canEdit &&
                (addingFor === p.accountId ? (
                  <DottedLineAdd
                    people={data.people.filter((x) => x.accountId !== p.accountId)}
                    onAdd={(toId, kind) => void addRel(p.accountId, toId, kind)}
                    onCancel={() => setAddingFor(null)}
                  />
                ) : (
                  <button
                    className="pm-dotted__add"
                    data-testid="pm-dotted-add"
                    onClick={() => setAddingFor(p.accountId)}
                  >
                    <Icon name="add" size={11} /> dotted line
                  </button>
                ))}
            </div>
          )}
        </div>
        {children.length > 0 && depth < 12 && (
          <div className="pm-node__kids">{children.map((c) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    )
  }

  return (
    <div className="pm-tree">
      {canEdit && (
        <div className="pm-tree__hint">
          {editErr ? (
            <span className="pm-tree__err">{editErr}</span>
          ) : (
            'Drag a person onto another to change who they report to. Loops are blocked.'
          )}
        </div>
      )}
      {roots.map((r) => renderNode(r, 0))}
    </div>
  )
}

// A compact picker to add a dotted-line relationship: a person and a kind.
function DottedLineAdd({
  people,
  onAdd,
  onCancel
}: {
  people: MapPerson[]
  onAdd: (toId: string, kind: RelationshipKind) => void
  onCancel: () => void
}): JSX.Element {
  const [toId, setToId] = useState('')
  const [kind, setKind] = useState<RelationshipKind>('matrix')
  return (
    <span className="pm-dotted__form">
      <select value={toId} onChange={(e) => setToId(e.target.value)} data-testid="pm-dotted-target">
        <option value="">to…</option>
        {people.map((p) => (
          <option key={p.accountId} value={p.accountId}>
            {dispName(p)}
          </option>
        ))}
      </select>
      <select value={kind} onChange={(e) => setKind(e.target.value as RelationshipKind)} data-testid="pm-dotted-kind">
        <option value="oversight">oversight</option>
        <option value="matrix">matrix</option>
        <option value="stakeholder">stakeholder</option>
        <option value="vendor">vendor</option>
      </select>
      <button
        className="pm-dotted__save"
        disabled={!toId}
        data-testid="pm-dotted-save"
        onClick={() => toId && onAdd(toId, kind)}
      >
        Add
      </button>
      <button className="pm-dotted__cancel" onClick={onCancel} aria-label="Cancel">
        <Icon name="close" size={11} />
      </button>
    </span>
  )
}

/* ---------------- collaboration ---------------- */

// A person reference inside a Collaboration insight: avatar, handle, an optional
// bit of context, and click-to-message. Works whether or not they are online,
// since opening a chat is always possible.
function CollabPerson({ person, context }: { person: MapPerson; context?: string }): JSX.Element {
  const meta = STATUS_META[person.liveStatus]
  const startDm = useMessagingStore((s) => s.startDm)
  const goMessages = useViewStore((s) => s.goMessages)
  return (
    <button
      className="pm-collab__person"
      data-testid="collab-person"
      title={`Message ${dispName(person)}`}
      onClick={() => {
        const ent = entitlementFor('chat', 'Chat')
        if (!ent.enabled) {
          promptUpgrade(ent.reason)
          return
        }
        void startDm(person.handle)
        goMessages()
      }}
    >
      <span className="pm-prow__rel">
        <Avatar seed={person.handle} name={dispName(person)} size={24} photoUrl={person.photoUrl} />
        <span className={`pm-prow__sdot pm-dot ${meta.cls}`} />
      </span>
      <span className="pm-collab__pname">{dispName(person)}</span>
      {context && <span className="pm-collab__pctx">{context}</span>}
    </button>
  )
}

// The Collaboration tab: real, data-derived team-rhythm insights. Every figure is
// computed from work windows, time zones, presence, departments and manager
// links. Where a signal cannot be computed it shows an honest empty state rather
// than a fabricated one.
function CollaborationTab({ data, now }: { data: PeopleMapData; now: Date }): JSX.Element {
  const people = data.people
  const reach = reachableNow(people)
  const handoffs = followTheSunPairs(people, now)
  const connections = suggestedConnections(people)
  const isolated = isolatedRemotes(people)
  const geoPeople = people.filter((p) => p.lat != null && p.lng != null && p.tzOffsetMin != null)
  const inHours = geoPeople.filter((p) => daylightFor(p.lat!, p.lng!, p.tzOffsetMin!, now, p.workWindow).working)

  return (
    <div className="pm-collab">
      <RailCard title="Reachable right now" icon="bolt" tone="emerald">
        {reach.length === 0 ? (
          <div className="pm-collab__empty">No one is online right now.</div>
        ) : (
          <>
            <div className="pm-collab__lead">
              {reach.length} {reach.length === 1 ? 'person is' : 'people are'} around and reachable.
            </div>
            <div className="pm-collab__people">
              {reach.slice(0, 10).map((p) => (
                <CollabPerson key={p.accountId} person={p} />
              ))}
            </div>
          </>
        )}
      </RailCard>

      <RailCard title="Working-hours coverage" icon="schedule" tone="sky">
        {geoPeople.length === 0 ? (
          <div className="pm-collab__empty">No one has a location set, so working hours are not known.</div>
        ) : (
          <div className="pm-collab__lead">
            {inHours.length} of {geoPeople.length} {geoPeople.length === 1 ? 'person is' : 'people are'} inside their
            working hours right now. The rest are before or after their day where they are.
          </div>
        )}
      </RailCard>

      <RailCard title="Follow-the-sun handoffs" icon="wb_twilight" tone="amber">
        {handoffs.length === 0 ? (
          <div className="pm-collab__empty">
            No handoffs to make right now. No one is wrapping up while a teammate is just coming online.
          </div>
        ) : (
          <div className="pm-collab__pairs">
            {handoffs.map((h) => (
              <div className="pm-collab__pair" key={`${h.from.accountId}-${h.to.accountId}`}>
                <CollabPerson person={h.from} context="wrapping up" />
                <Icon name="arrow_forward" size={14} className="pm-collab__arrow" />
                <CollabPerson person={h.to} context={h.sameTeam ? 'starting, same team' : 'starting'} />
              </div>
            ))}
          </div>
        )}
      </RailCard>

      <RailCard title="Suggested connections" icon="handshake" tone="violet">
        {connections.length === 0 ? (
          <div className="pm-collab__empty">
            No new cross-team connections to suggest. The people whose hours overlap already share a team.
          </div>
        ) : (
          <div className="pm-collab__pairs">
            {connections.map((c) => (
              <div className="pm-collab__pair" key={`${c.a.accountId}-${c.b.accountId}`}>
                <CollabPerson person={c.a} context={c.a.department ?? undefined} />
                <span className="pm-collab__overlap">{c.overlapHours}h overlap</span>
                <CollabPerson person={c.b} context={c.b.department ?? undefined} />
              </div>
            ))}
          </div>
        )}
      </RailCard>

      <RailCard title="Isolated by time zone" icon="public_off" tone="rose">
        {isolated.length === 0 ? (
          <div className="pm-collab__empty">No one is isolated by time zone. The team overlaps well.</div>
        ) : (
          <>
            <div className="pm-collab__lead">
              These teammates share only a little of their day with the rest of the team. A check-in or an async ritual
              keeps them in the loop.
            </div>
            <div className="pm-collab__people">
              {isolated.map((r) => (
                <CollabPerson key={r.person.accountId} person={r.person} context={`${r.medianOverlap}h overlap`} />
              ))}
            </div>
          </>
        )}
      </RailCard>
    </div>
  )
}

/* ---------------- live right rail ---------------- */

function PeopleRail({ data, now }: { data: PeopleMapData; now: Date }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const weight = (s: PresenceStatus): number => (s === 'online' ? 0 : s === 'focus' ? 1 : s === 'away' ? 2 : 3)
  const around = data.people
    .filter((p) => p.liveStatus !== 'offline')
    .sort((a, b) => weight(a.liveStatus) - weight(b.liveStatus) || dispName(a).localeCompare(dispName(b)))

  const dayOf = (p: MapPerson): ReturnType<typeof daylightFor> | null =>
    p.lat != null && p.lng != null && p.tzOffsetMin != null
      ? daylightFor(p.lat, p.lng, p.tzOffsetMin, now, p.workWindow)
      : null
  const wrapping = data.people.filter((p) => dayOf(p)?.workLabel === 'Wrapping up')
  const starting = data.people.filter((p) => dayOf(p)?.workLabel === 'Early hours')
  const names = (people: MapPerson[]): string =>
    people.slice(0, 4).map((p) => dispName(p)).join(', ') + (people.length > 4 ? ` +${people.length - 4}` : '')

  const deptCount = new Map<string, number>()
  for (const p of data.people) {
    const k = p.department || 'Unassigned'
    deptCount.set(k, (deptCount.get(k) ?? 0) + 1)
  }
  const depts = [...deptCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  const maxDept = depts[0]?.[1] ?? 1

  return (
    <aside className="pm-rail">
      <RailCard title="Around right now" icon="bolt" tone="emerald">
        {around.length === 0 ? (
          <div className="text-[11.5px] text-[var(--ink-40)]">No one is online right now.</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {(expanded ? around : around.slice(0, 6)).map((p) => {
              const d = dayOf(p)
              return (
                <div key={p.accountId} className="flex items-center gap-2.5 rounded-lg px-1 py-1">
                  <span className="relative shrink-0">
                    <Avatar seed={p.handle} name={dispName(p)} size={26} photoUrl={p.photoUrl} />
                    <span className={`pm-prow__sdot pm-dot ${STATUS_META[p.liveStatus].cls}`} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-[var(--ink-90)] truncate">{dispName(p)}</div>
                    <div className="text-[11px] text-[var(--ink-50)] truncate">
                      {p.liveWorkingOn || p.title || STATUS_META[p.liveStatus].label}
                    </div>
                  </span>
                  {d && <span className="text-[11px] text-[var(--ink-40)] fb-tabular shrink-0">{fmtHour(d.hour)}</span>}
                </div>
              )
            })}
            {around.length > 6 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                data-testid="rail-around-toggle"
                className="text-[11px] text-accent px-1 pt-1 text-left hover:underline"
              >
                {expanded ? 'Show less' : `Show ${around.length - 6} more online`}
              </button>
            )}
          </div>
        )}
      </RailCard>

      <RailCard title="Follow the sun" icon="wb_twilight" tone="amber" className="mt-3">
        {wrapping.length === 0 && starting.length === 0 ? (
          <div className="text-[11.5px] text-[var(--ink-40)]">No handoffs in motion right now.</div>
        ) : (
          <div className="flex flex-col gap-2.5 text-[12px]">
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-[var(--ink-40)] mb-1">Wrapping up</div>
              <div className="text-[var(--ink-70)]">{wrapping.length ? names(wrapping) : '—'}</div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-[var(--ink-40)] mb-1">Starting their day</div>
              <div className="text-[var(--ink-70)]">{starting.length ? names(starting) : '—'}</div>
            </div>
          </div>
        )}
      </RailCard>

      <RailCard title="By department" icon="donut_small" tone="violet" className="mt-3">
        <div className="flex flex-col gap-1.5">
          {depts.map(([name, n]) => (
            <div key={name} className="text-[12px]">
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ink-70)] truncate">{name}</span>
                <span className="text-[var(--ink-40)] fb-tabular shrink-0">{n}</span>
              </div>
              <div className="h-1.5 rounded-full bg-stone-500/10 mt-1 overflow-hidden">
                <div className="h-full rounded-full bg-accent/60" style={{ width: `${(n / maxDept) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </RailCard>
    </aside>
  )
}

/* ---------------- shell ---------------- */

export default function PeopleMapView(): JSX.Element {
  const token = useAccountStore((s) => s.sessionToken)
  const goOrg = useViewStore((s) => s.goOrg)
  const [orgs, setOrgs] = useState<OrgMembership[]>([])
  const [orgId, setOrgId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('offices')
  const [now, setNow] = useState<Date>(() => new Date())

  // Clock heartbeat — keeps every daylight indicator current.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!token) return
    void listOrgs(token).then((list) => {
      setOrgs(list)
      setOrgId((prev) => prev ?? list.find((o) => !o.personal)?.id ?? list[0]?.id ?? null)
    })
  }, [token])

  const { data, loading, error, refresh } = usePeopleMap(orgId)
  const selectedOrg = orgs.find((o) => o.id === orgId) ?? null
  const account = useAccountStore((s) => s.account)

  const hh = now.getHours()
  const who = account ? personFirstName(account, '') : ''
  const greeting = `Good ${hh < 12 ? 'morning' : hh < 18 ? 'afternoon' : 'evening'}${who ? `, ${who}` : ''}`
  const aroundNow = data ? data.people.filter((p) => p.liveStatus !== 'offline').length : 0
  const workingNow = data
    ? data.people.filter(
        (p) =>
          p.lat != null &&
          p.lng != null &&
          p.tzOffsetMin != null &&
          daylightFor(p.lat, p.lng, p.tzOffsetMin, now, p.workWindow).working
      ).length
    : 0

  let body: JSX.Element
  if (!token) {
    body = <div className="pm-empty"><h2>Sign in to see your team</h2><p>The People Map shows everyone in your organization, where they are, and who's around right now.</p></div>
  } else if (orgs.length > 0 && !orgs.some((o) => !o.personal)) {
    body = (
      <div className="pm-empty">
        <h2>Create an organization first</h2>
        <p>The People Map maps a real organization. Create one and invite your team, then set up offices and profiles.</p>
        <button onClick={goOrg}>Open Organizations</button>
      </div>
    )
  } else if (loading && !data) {
    body = <div className="pm-empty"><p>Loading the map…</p></div>
  } else if (error) {
    body = <div className="pm-empty"><h2>Couldn't load the map</h2><p>{error}</p><button onClick={refresh}>Try again</button></div>
  } else if (!data || data.people.length === 0) {
    body = (
      <div className="pm-empty">
        <h2>No teammates yet</h2>
        <p>Invite people to this organization, then give them offices and profiles so they appear on the map.</p>
        <button onClick={goOrg}>Open Organizations</button>
      </div>
    )
  } else if (tab === 'offices') {
    body = <OfficesTab data={data} now={now} />
  } else if (tab === 'global') {
    body = <GlobalTab data={data} now={now} />
  } else if (tab === 'hierarchy') {
    body = <HierarchyTab data={data} now={now} refresh={refresh} />
  } else {
    body = <CollaborationTab data={data} now={now} />
  }

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'offices', label: 'Offices', icon: 'location_city' },
    { id: 'global', label: 'Global', icon: 'public' },
    { id: 'hierarchy', label: 'Hierarchy', icon: 'account_tree' },
    { id: 'collaboration', label: 'Collaboration', icon: 'handshake' }
  ]

  return (
    <div className="pm-root" data-testid="people-map">
      <div style={{ padding: '16px 20px 0' }}>
        <DashboardHeader
          title="People Map"
          greeting={greeting}
          subtitle={selectedOrg ? `PlexiiTeam · ${selectedOrg.name}` : 'See everyone, where they are, and who is around right now'}
          actions={
            <>
              {orgs.filter((o) => !o.personal).length > 0 && (
                <select
                  className="fb-field w-auto text-[12px] text-[var(--ink-70)] px-2 py-1.5"
                  value={orgId ?? ''}
                  onChange={(e) => setOrgId(e.target.value || null)}
                  data-testid="people-map-org"
                >
                  {orgs.filter((o) => !o.personal).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="pm-tabs">
                {TABS.map((t) => (
                  <button key={t.id} className={`pm-tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)} data-testid={`people-map-tab-${t.id}`}>
                    <Icon name={t.icon} size={14} className="" />
                    {t.label}
                  </button>
                ))}
              </div>
              <button className="pm-iconbtn" onClick={refresh} title="Refresh">
                <Icon name="refresh" size={16} className="" />
              </button>
            </>
          }
        />
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile icon="groups" label="People" value={data.people.length} tone="accent" hint={`Company hours ${data.defaultHours.start}:00–${data.defaultHours.end}:00`} />
            <StatTile icon="bolt" label="Around now" value={aroundNow} tone="emerald" />
            <StatTile icon="av_timer" label="In working hours" value={workingNow} tone="violet" />
            <StatTile icon="location_city" label="Offices" value={data.offices.length} tone="sky" />
          </div>
        )}
      </div>
      <div className="pm-body">
        {data && data.people.length > 0 ? (
          <div className="pm-layout">
            <div className="pm-main">{body}</div>
            <PeopleRail data={data} now={now} />
          </div>
        ) : (
          body
        )}
      </div>
    </div>
  )
}
