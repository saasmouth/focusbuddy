// One menu for the whole app.
//
// There were four: the desk menu in Sidebar, PlexiOffice's richer shell, and
// the two SegmentShell menus for People and Brain — with a tab strip above each
// to move between them. Four menus meant four places to look for a thing, and
// the tab strip meant the thing you wanted was usually in a menu you could not
// see. This is all four, stacked, as collapsible sections.
//
// SECTIONS DEFAULT TO OPEN, and that is not an aesthetic choice. Folding the
// areas into a dropdown (c581655d) put a dozen-times-an-hour action behind a
// rarely-used one, and the fix was to bring them back as always-visible tabs.
// An accordion that ships collapsed would repeat exactly that mistake with
// extra steps, so every section starts open and only a deliberate collapse
// closes one. The state persists per viewer, because a collapse you have to
// redo every launch is not a preference.
//
// THE REGISTRY IS THE SOURCE. Rows come from lib/segmentApps, which already
// feeds the tray and the shells. A menu with its own copy of the app list is
// how you end up with a row that navigates nowhere, or an app that exists in
// three places under two names.

import { useEffect, useState } from 'react'
import Icon from '../Icon'
import AppLogo from '../AppLogo'
import { useViewStore } from '../../stores/view'

type ViewStore = ReturnType<typeof useViewStore.getState>
import { useConnectedAppsStore } from '../../stores/connectedApps'
import { useViewKindEnabled } from '../../lib/viewCapability'
import { useCapabilityStore } from '../../stores/capabilities'
import { useOrgStore } from '../../stores/org'
import { computeEntitlement } from '../../lib/entitlementReason'
import { SEGMENT_APPS, type SegmentAppMeta } from '../../lib/segmentApps'

/**
 * Which Office keys are Plexii's own applications.
 *
 * The distinction the operator drew: PlexiiApps are the things with a Plexii
 * name on them — the ones you would call an app — and everything else in that
 * menu is a tool you reach for while using them. Ordered as a person would
 * expect to find them, not as the registry happens to list them.
 */
const PLEXII_APP_KEYS = [
  'docs',
  'sheets',
  'slides',
  'diagrams',
  'design',
  'draw',
  'sign',
  'meet'
] as const

/** The Office surfaces that are tools rather than applications. */
const TOOL_KEYS = ['mail', 'inbox', 'chat', 'calendar', 'files', 'browser', 'vault'] as const

/**
 * The desk area's top-level places.
 *
 * These are not `plexidesk:<app>` views — they are their own view kinds, and
 * they were the Sidebar's own list, which is why merging the menus needs both
 * halves. Attention is first after Home because its whole job is being one
 * glance away (S6).
 */
const DESK_VIEWS: { kind: string; label: string; icon: string; go: (v: ViewStore) => void }[] = [
  { kind: 'attention', label: 'Attention', icon: 'notifications', go: (v) => v.goAttention() },
  { kind: 'rooms', label: 'Rooms', icon: 'meeting_room', go: (v) => v.goRooms() },
  { kind: 'desks', label: 'Desks', icon: 'desk', go: (v) => v.goDesks() },
  { kind: 'shared', label: 'Shared Desks', icon: 'folder_shared', go: (v) => v.goShared() },
  { kind: 'trash', label: 'Trash', icon: 'delete', go: (v) => v.goTrash() }
]

type SectionId = 'desk' | 'apps' | 'people' | 'brain'

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'desk', label: 'Desk', icon: 'desktop_windows' },
  // "Office" named the room; the operator renamed it for what it holds.
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'people', label: 'People', icon: 'groups' },
  { id: 'brain', label: 'Brain', icon: 'neurology' }
]

const OPEN_KEY = 'fb.nav.accordion.open'

function readOpen(): Record<SectionId, boolean> {
  const allOpen: Record<SectionId, boolean> = {
    desk: true,
    apps: true,
    people: true,
    brain: true
  }
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    if (!raw) return allOpen
    const parsed = JSON.parse(raw) as Partial<Record<SectionId, boolean>>
    return {
      desk: parsed.desk ?? true,
      apps: parsed.apps ?? true,
      people: parsed.people ?? true,
      brain: parsed.brain ?? true
    }
  } catch {
    // Private window, blocked storage, malformed value: show everything. An
    // unreadable preference must never hide the menu.
    return allOpen
  }
}

/**
 * A labelled section that is BOTH the area switch and a collapse control.
 *
 * The header navigates; the chevron folds. That split matters: the four areas
 * used to be a tab strip (`switch-<kind>`), and a header that only folded would
 * have deleted the one-click area switch — the exact regression c581655d was
 * reverted for. So the header keeps the tab's testid and the tab's job, and
 * carries `data-locked` the same way, because an area you are not entitled to
 * must still say why rather than vanish.
 */
function Section({
  id,
  label,
  icon,
  kind,
  locked,
  lockedReason,
  onLockedClick,
  onActivate,
  open,
  onToggle,
  children
}: {
  id: SectionId
  label: string
  icon: string
  kind: string
  locked: boolean
  lockedReason?: string
  onLockedClick?: () => void
  onActivate: () => void
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): JSX.Element {
  if (locked) {
    return (
      <div className="border-b border-[var(--edge-soft)] last:border-b-0">
        <button
          onClick={onLockedClick}
          title={lockedReason}
          data-testid={`switch-${kind}`}
          data-locked="true"
          aria-disabled="true"
          className="w-full flex items-center gap-2 px-3 py-2 text-left opacity-50"
        >
          <Icon name={icon} size={16} className="shrink-0 text-[var(--ink-50)]" />
          <span className="flex-1 min-w-0 truncate text-[11px] uppercase tracking-[0.12em] font-semibold text-[var(--ink-60)]">
            {label}
          </span>
          <Icon name="lock" size={13} className="shrink-0 text-[var(--ink-40)]" />
        </button>
      </div>
    )
  }
  return (
    <div className="border-b border-[var(--edge-soft)] last:border-b-0">
      <div className="flex items-center hover:bg-[var(--surface-sunken)]">
        <button
          onClick={() => {
            // Going to an area whose section is folded and leaving it folded
            // would land you somewhere with no visible way around it.
            if (!open) onToggle()
            onActivate()
          }}
          data-testid={`switch-${kind}`}
          className="flex-1 flex items-center gap-2 px-3 py-2 text-left min-w-0"
        >
          <Icon name={icon} size={16} className="shrink-0 text-[var(--ink-50)]" />
          <span className="flex-1 min-w-0 truncate text-[11px] uppercase tracking-[0.12em] font-semibold text-[var(--ink-60)]">
            {label}
          </span>
        </button>
        <button
          onClick={onToggle}
          aria-expanded={open}
          title={open ? `Collapse ${label}` : `Expand ${label}`}
          data-testid={`nav-section-${id}`}
          className="px-2 py-2 text-[var(--ink-40)] hover:text-[var(--ink-90)]"
        >
          <Icon name={open ? 'expand_less' : 'expand_more'} size={16} />
        </button>
      </div>
      {/* `hidden` rather than unmounting: a collapsed section keeps its scroll
          position and its children's state, and the rows stay findable. */}
      <div hidden={!open} data-testid={`nav-section-body-${id}`} className="pb-1.5">
        {children}
      </div>
    </div>
  )
}

/** A sub-heading inside a section — PlexiiApps, Tools, Connected apps. */
function SubHeading({ label, action }: { label: string; action?: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-1 px-3 pt-2 pb-1">
      <span className="flex-1 min-w-0 truncate text-[10px] uppercase tracking-[0.12em] font-semibold text-[var(--ink-40)]">
        {label}
      </span>
      {action}
    </div>
  )
}

/** One navigable row. */
function Row({
  label,
  icon,
  active,
  onClick,
  testid
}: {
  label: string
  icon: string
  active: boolean
  onClick: () => void
  testid?: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 w-full px-3 py-1.5 rounded-lg text-[13px] mb-0.5 ${
        active
          ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))] font-medium'
          : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <span className="inline-flex items-center justify-center w-6 h-6 shrink-0">
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 truncate text-left">{label}</span>
    </button>
  )
}

/**
 * A grid of icon tiles.
 *
 * Used for the two sets the operator asked to see this way — PlexiiApps and
 * Connected apps. A grid is right for them and wrong for the tools: these are
 * recognised by their mark, and there are enough of them that a list would push
 * everything below out of reach.
 */
function TileGrid({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="grid grid-cols-4 gap-1 px-2">{children}</div>
}

function Tile({
  label,
  active,
  onClick,
  testid,
  children
}: {
  label: string
  active: boolean
  onClick: () => void
  testid?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={label}
      data-testid={testid}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-col items-center gap-1 px-1 py-2 rounded-lg ${
        active
          ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]'
          : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <span className="inline-flex items-center justify-center w-7 h-7 shrink-0">{children}</span>
      {/* Two lines, centred, so "PlexiDiagrams" is readable rather than clipped
          to "PlexiDiag…" in a 4-column grid at the 232px minimum width. */}
      <span className="w-full text-[10px] leading-tight text-center break-words line-clamp-2">
        {label}
      </span>
    </button>
  )
}

/**
 * `appsExtra` — the Office document library (Recent, Starred, Templates, Trash).
 *
 * Those are not navigable views: they are `page` state inside the Office shell,
 * which is also why they only mean anything while you are in Apps. So the shell
 * passes them in rather than this module pretending it can route to them, and
 * rather than them becoming a fifth menu nobody can find. Making them real
 * views is the follow-up that would let them sit here unconditionally.
 */
/**
 * `deskSlot` — the desk sidebar's own, richer desk list.
 *
 * That list is not the flat one this module builds from the registry: Attention
 * carries its six state/due filters and Rooms expands into All desks / Shared
 * with an unread badge. So when the desk sidebar mounts this menu it passes its
 * list in as the Desk section's BODY, rather than having it replaced (which
 * would have silently cost both) or sitting outside the accordion (which cost
 * the Desk section header, and with it the one-click switch back to the desk —
 * `switch-plexidesk`). Everywhere else the flat registry list is used, because
 * those menus never had a desk list at all.
 */
export default function AreaAccordion({
  appsExtra,
  deskSlot
}: {
  appsExtra?: React.ReactNode
  deskSlot?: React.ReactNode
} = {}): JSX.Element {
  const [open, setOpen] = useState<Record<SectionId, boolean>>(readOpen)
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(open))
    } catch {
      // Not persistable here; the session's choice still stands.
    }
  }, [open])
  function toggle(id: SectionId): void {
    setOpen((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const view = useViewStore((s) => s.view)
  const goPlexiDesk = useViewStore((s) => s.goPlexiDesk)
  const goOffice = useViewStore((s) => s.goOffice)
  const goPlexiPeople = useViewStore((s) => s.goPlexiPeople)
  const goPlexiBrain = useViewStore((s) => s.goPlexiBrain)
  const goConnectedApp = useViewStore((s) => s.goConnectedApp)

  const enabled = useViewKindEnabled()
  // Subscribe to the capability MAPS so the menu reacts when entitlements
  // resolve or an org switch changes them, exactly as the tab strip did.
  const capabilities = useCapabilityStore((s) => s.capabilities)
  const sources = useCapabilityStore((s) => s.sources)
  const orgRole = useCapabilityStore((s) => s.orgRole)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const orgName = useOrgStore((s) => s.orgs.find((o) => o.id === s.activeOrgId)?.name ?? null)
  const entInputs = { capabilities, sources, orgRole, activeOrgId, orgName }
  /** Desk is the floor: always available even if its entitlement is unset. */
  function areaEnt(kind: string, cap: string, label: string) {
    const ent = computeEntitlement(entInputs, cap, label)
    return { ...ent, enabled: kind === 'plexidesk' || ent.enabled }
  }
  const deskEnt = areaEnt('plexidesk', 'product_desk', 'Desk')
  const appsEnt = areaEnt('office', 'product_office', 'Apps')
  const peopleEnt = areaEnt('plexipeople', 'product_people', 'People')
  const brainEnt = areaEnt('plexibrain', 'product_brain', 'Brain')
  const connectedApps = useConnectedAppsStore((s) => s.apps)
  const refreshApps = useConnectedAppsStore((s) => s.refresh)
  const appsLoaded = useConnectedAppsStore((s) => s.loaded)
  useEffect(() => {
    if (!appsLoaded) void refreshApps()
  }, [appsLoaded, refreshApps])

  /** Hide what the backbone would refuse, so no row is a dead affordance. */
  const shown = (apps: readonly SegmentAppMeta[]): SegmentAppMeta[] =>
    apps.filter((a) => !a.gateKind || enabled(a.gateKind))

  const officeApps = shown(SEGMENT_APPS.office)
  const byKey = (keys: readonly string[]): SegmentAppMeta[] =>
    keys.map((k) => officeApps.find((a) => a.key === k)).filter((a): a is SegmentAppMeta => !!a)

  const activeArea = view.kind
  const activeApp = 'app' in view ? view.app : undefined
  const isActive = (kind: string, key: string): boolean =>
    activeArea === kind && (activeApp ?? 'home') === key

  return (
    <nav className="flex flex-col" data-testid="area-accordion">
      <Section
        id="desk"
        label="Desk"
        icon="desktop_windows"
        kind="plexidesk"
        locked={!deskEnt.enabled}
        lockedReason={deskEnt.reason}
        onLockedClick={deskEnt.onLockedClick}
        onActivate={() => useViewStore.getState().goHome()}
        open={open.desk}
        onToggle={() => toggle('desk')}
      >
        {deskSlot ?? (
        <div className="px-2 pt-1">
          {DESK_VIEWS.map((d) => (
            <Row
              key={d.kind}
              label={d.label}
              icon={d.icon}
              active={activeArea === d.kind}
              onClick={() => d.go(useViewStore.getState())}
              testid={`nav-desk-${d.kind}`}
            />
          ))}
          {/* A hairline between "places in the desk area" and "apps of the
              desk area" — they route differently and reading as one list made
              Trash look like a sibling of Plans. */}
          <div className="h-px bg-[var(--edge-soft)] my-1.5 mx-1" />
          {shown(SEGMENT_APPS.plexidesk).map((a) => (
            <Row
              key={a.key}
              label={a.label}
              icon={a.icon}
              active={isActive('plexidesk', a.key)}
              onClick={() => goPlexiDesk(a.key)}
              testid={`nav-plexidesk-${a.key}`}
            />
          ))}
        </div>
        )}
      </Section>

      <Section
        id="apps"
        label="Apps"
        icon="apps"
        kind="office"
        locked={!appsEnt.enabled}
        lockedReason={appsEnt.reason}
        onLockedClick={appsEnt.onLockedClick}
        onActivate={() => goOffice()}
        open={open.apps}
        onToggle={() => toggle('apps')}
      >
        <SubHeading label="PlexiiApps" />
        <TileGrid>
          {byKey(PLEXII_APP_KEYS).map((a) => (
            <Tile
              key={a.key}
              label={a.label}
              active={isActive('office', a.key)}
              onClick={() => goOffice(a.key)}
              testid={`office-sideapp-${a.key}`}
            >
              <Icon name={a.icon} size={18} />
            </Tile>
          ))}
        </TileGrid>

        <SubHeading label="Tools" />
        <div className="px-2">
          {byKey(TOOL_KEYS).map((a) => (
            <Row
              key={a.key}
              label={a.label}
              icon={a.icon}
              active={isActive('office', a.key)}
              onClick={() => goOffice(a.key)}
              testid={`office-comms-app-${a.key}`}
            />
          ))}
        </div>

        <SubHeading label="Connected apps" />
        {connectedApps.length === 0 ? (
          // An honest empty state. A grid that renders nothing reads as broken,
          // and inventing sample tiles here would be worse.
          <p className="px-3 pb-1 text-[11px] text-[var(--ink-40)] leading-snug">
            None yet — add one to reach it from any desk.
          </p>
        ) : (
          <TileGrid>
            {connectedApps.map((app) => (
              <Tile
                key={app.id}
                label={app.title}
                active={view.kind === 'connected-app' && view.appId === app.id}
                onClick={() => goConnectedApp(app.id)}
                testid={`nav-connected-app-${app.id}`}
              >
                <AppLogo app={app} size={22} glyphSize={13} />
              </Tile>
            ))}
          </TileGrid>
        )}

        {appsExtra}
      </Section>

      <Section
        id="people"
        label="People"
        icon="groups"
        kind="plexipeople"
        locked={!peopleEnt.enabled}
        lockedReason={peopleEnt.reason}
        onLockedClick={peopleEnt.onLockedClick}
        onActivate={() => goPlexiPeople()}
        open={open.people}
        onToggle={() => toggle('people')}
      >
        <div className="px-2 pt-1">
          {shown(SEGMENT_APPS.plexipeople).map((a) => (
            <Row
              key={a.key}
              label={a.label}
              icon={a.icon}
              active={isActive('plexipeople', a.key)}
              onClick={() => goPlexiPeople(a.key)}
              testid={`nav-plexipeople-${a.key}`}
            />
          ))}
        </div>
      </Section>

      <Section
        id="brain"
        label="Brain"
        icon="neurology"
        kind="plexibrain"
        locked={!brainEnt.enabled}
        lockedReason={brainEnt.reason}
        onLockedClick={brainEnt.onLockedClick}
        onActivate={() => goPlexiBrain()}
        open={open.brain}
        onToggle={() => toggle('brain')}
      >
        <div className="px-2 pt-1">
          {shown(SEGMENT_APPS.plexibrain).map((a) => (
            <Row
              key={a.key}
              label={a.label}
              icon={a.icon}
              active={isActive('plexibrain', a.key)}
              onClick={() => goPlexiBrain(a.key)}
              testid={`nav-plexibrain-${a.key}`}
            />
          ))}
        </div>
      </Section>
    </nav>
  )
}

/** Exported for the tests that assert the menu's shape. */
export { PLEXII_APP_KEYS, TOOL_KEYS, SECTIONS }
