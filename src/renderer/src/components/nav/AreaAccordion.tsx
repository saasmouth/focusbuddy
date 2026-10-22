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
import PlexiiIcon from '../PlexiiIcon'
import { segmentAppEntity, viewKindEntity, type EntityRef } from '../../lib/plexiiIconMap'
import { SubHeading, Tile, TileGrid } from './menuParts'
import { useViewStore } from '../../stores/view'

type ViewStore = ReturnType<typeof useViewStore.getState>
import { useConnectedAppsStore } from '../../stores/connectedApps'
import { useAppNotifications } from '../../stores/appNotifications'
import { useViewKindEnabled } from '../../lib/viewCapability'
import { useCapabilityStore } from '../../stores/capabilities'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
import AddConnectedAppDialog from '../AddConnectedAppDialog'
import { AREA_TONES } from '../../lib/areaTones'
import { computeEntitlement } from '../../lib/entitlementReason'
import { SEGMENT_APPS, type SegmentAppMeta } from '../../lib/segmentApps'
import { DRAG_MIME, catalogFor } from '../../lib/widgetCatalog'
import { tileWidgetKind } from '../../lib/widgetMenu'
import { addKindToOpenDesk } from '../../lib/addWidget'
import { useFileManagerStore } from '../../stores/fileManager'
import { useNodeStore } from '../../stores/nodes'
import CanvasContextMenu from '../CanvasContextMenu'
import WidgetsSection from './WidgetsSection'
import { CONNECTED_APP_DRAG_MIME } from '../Sidebar'

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

// What dropping an app or tool tile onto a desk creates is no longer a table
// here: each app in SEGMENT_APPS carries its own `widgetKinds`, and the first
// one the catalogue knows is the tile's drag kind (lib/widgetMenu
// tileWidgetKind). The same field keeps those kinds out of the Widgets section,
// so the two can never disagree. `sign`, `meet` and `vault` have no draggable
// kind, so they stay undraggable rather than grabbable-but-inert.

/**
 * The desk area's top-level places.
 *
 * These are not `plexidesk:<app>` views — they are their own view kinds, and
 * they were the Sidebar's own list, which is why merging the menus needs both
 * halves. Attention is first after Home because its whole job is being one
 * glance away (S6).
 */
const DESK_VIEWS: {
  kind: string
  label: string
  icon: string
  tone: string
  go: (v: ViewStore) => void
}[] = [
  // Tones come from AREA_TONES, never from literals here. This list and the
  // Sidebar's desk list render in the SAME menu — this one when there is no
  // `deskSlot`, the Sidebar's when there is — so a literal in either place
  // means one concept in two colours depending on which half drew it. That is
  // exactly how Rooms ended up sky in one and teal in the other.
  { kind: 'attention', label: 'Focus', icon: 'notifications', tone: AREA_TONES.attention, go: (v) => v.goAttention() },
  { kind: 'rooms', label: 'Rooms', icon: 'meeting_room', tone: AREA_TONES.rooms, go: (v) => v.goRooms() },
  { kind: 'desks', label: 'Desks', icon: 'desk', tone: AREA_TONES.desks, go: (v) => v.goDesks() },
  { kind: 'shared', label: 'Shared Desks', icon: 'folder_shared', tone: AREA_TONES.shared, go: (v) => v.goShared() },
  { kind: 'trash', label: 'Trash', icon: 'delete', tone: AREA_TONES.trash, go: (v) => v.goTrash() }
]

type SectionId = 'desk' | 'apps' | 'widgets' | 'connected' | 'people' | 'brain'

const SECTIONS: { id: SectionId; label: string; icon: string; tone: string }[] = [
  // Section heads take the hue of the area they open, from the same map as
  // every row inside them.
  { id: 'desk', label: 'PlexiiDesk', icon: 'desktop_windows', tone: AREA_TONES.home },
  // "Office" named the room; the operator renamed it for what it holds.
  { id: 'apps', label: 'Apps', icon: 'apps', tone: AREA_TONES.office },
  // Widgets that are not an app (4.3.32): standalone widget files, and the way
  // widgets are added to a desk now that the header button is gone. Directly
  // under the office apps and above the connected apps (owner, 4.3.32): the
  // things you make sit beside the apps you make them with.
  { id: 'widgets', label: 'Work widgets', icon: 'widgets', tone: AREA_TONES.widgets },
  // Connected apps were the tail of the Apps section; they are their own
  // section now so Work widgets can sit between the two. Same Apps tone.
  { id: 'connected', label: 'Connected apps', icon: 'hub', tone: AREA_TONES.office },
  { id: 'people', label: 'People', icon: 'groups', tone: AREA_TONES.people },
  { id: 'brain', label: 'PlexiiBrain', icon: 'neurology', tone: AREA_TONES.brain }
]

/** The section headers' colours, by id, so the four are coloured too. */
const SECTION_TONE: Record<SectionId, string> = SECTIONS.reduce(
  (acc, s) => ({ ...acc, [s.id]: s.tone }),
  {} as Record<SectionId, string>
)

const OPEN_KEY = 'fb.nav.accordion.open'

function readOpen(): Record<SectionId, boolean> {
  const allOpen: Record<SectionId, boolean> = {
    desk: true,
    apps: true,
    widgets: true,
    connected: true,
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
      widgets: parsed.widgets ?? true,
      // Connected apps used to fold with Apps. Someone who had Apps folded
      // keeps them folded; the new section inherits that choice once, and is
      // stored on its own from then on. Nothing else they set is touched.
      connected: parsed.connected ?? parsed.apps ?? true,
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
  /** Where the header goes. A section that is not an area (Connected apps) has none: its header folds. */
  onActivate?: () => void
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
          <SectionIcon id={id} icon={icon} />
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
            if (!onActivate) {
              onToggle()
              return
            }
            if (!open) onToggle()
            onActivate()
          }}
          data-testid={`switch-${kind}`}
          className="flex-1 flex items-center gap-2 px-3 py-2 text-left min-w-0"
        >
          <SectionIcon id={id} icon={icon} />
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

/**
 * A section head's icon. The two areas that are apps in their own right
 * (PlexiiDesk, PlexiiBrain) wear their Plexii tile; the rest are groupings,
 * not entities, and keep their glyph in the area's hue.
 */
const SECTION_ENTITY: Partial<Record<SectionId, string>> = { desk: 'plexidesk', brain: 'plexibrain' }

function SectionIcon({ id, icon }: { id: SectionId; icon: string }): JSX.Element {
  const app = SECTION_ENTITY[id]
  if (app) return <PlexiiIcon kind="app" id={app} size={18} fallback={icon} fallbackFilled fallbackClassName={`shrink-0 ${SECTION_TONE[id]}`} />
  return <Icon name={icon} size={17} filled className={`shrink-0 ${SECTION_TONE[id]}`} />
}

/**
 * Right-click on an app tile that has a widget to become: "Add to this desk",
 * the keyboard-and-mouse twin of dragging the tile onto the open desk. Every
 * other tile is left exactly as it was.
 */
function AppTileMenu({ app, children }: { app: SegmentAppMeta; children: React.ReactNode }): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const view = useViewStore((s) => s.view)
  const activeDesk = useNodeStore((s) => s.activeTaskId)
  const kind = tileWidgetKind(app)
  const deskOpen = view.kind === 'task' && !!(activeDesk ?? view.taskId)
  return (
    <div
      onContextMenu={(e) => {
        if (!kind || !deskOpen) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {children}
      {menu && kind && (
        <CanvasContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: `Add ${catalogFor(kind)?.label ?? app.label} to this desk`,
              icon: 'add_to_queue',
              onClick: () => void addKindToOpenDesk(kind)
            }
          ]}
        />
      )}
    </div>
  )
}

/** One navigable row. */
function Row({
  label,
  icon,
  tone,
  entity,
  active,
  onClick,
  testid
}: {
  label: string
  icon: string
  /** The icon's colour. Every icon in this menu carries one. */
  tone?: string
  /** The entity this row opens, when it has a Plexii icon of its own (lib/plexiiIconMap). */
  entity?: EntityRef | null
  active: boolean
  onClick: () => void
  testid?: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      aria-current={active ? 'page' : undefined}
      className={`fb-nav-item fb-nav-row text-[13px] mb-0.5 ${
        active
          ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))] font-medium'
          : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      {/* Coloured, and filled rather than outlined — an outline at 16px reads
          as grey whatever colour it is given. The active row keeps the accent
          so selection still wins over the icon's own hue. */}
      <span
        className={`inline-flex items-center justify-center w-6 h-6 shrink-0 ${
          active ? '' : (tone ?? 'text-[var(--ink-60)]')
        }`}
      >
        {entity ? <PlexiiIcon kind={entity.kind} id={entity.id} size={18} fallback={icon} fallbackFilled /> : <Icon name={icon} size={17} filled />}
      </span>
      <span className="min-w-0 truncate text-left whitespace-nowrap">{label}</span>
    </button>
  )
}

/**
 * `deskSlot` — the desk sidebar's own, richer desk list.
 *
 * (The Office document library used to come in here as `appsExtra`. It moved
 * to the Office dashboard, beside the documents it filters — a menu is for
 * getting somewhere, not for filtering a list you cannot see from it.)
 */
export default function AreaAccordion({
  deskSlot
}: {
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
  const brainEnt = areaEnt('plexibrain', 'product_brain', 'PlexiiBrain')
  // Which org's apps these are. Personal is the only aggregate — it is the
  // account that belongs to the person rather than to a company — so it is
  // also the only place a tile needs to say which account it came from.
  const orgs = useOrgStore((s) => s.orgs)
  const isPersonal = activeOrgId === PERSONAL_ORG_ID
  const orgLabel = (id: string): string =>
    id === PERSONAL_ORG_ID ? 'Personal' : (orgs.find((o) => o.id === id)?.name ?? 'Other org')
  const [addAppOpen, setAddAppOpen] = useState(false)

  const connectedApps = useConnectedAppsStore((s) => s.apps)
  const unreadCounts = useAppNotifications((s) => s.counts)
  const appStatus = useAppNotifications((s) => s.status)
  const appSignIn = useAppNotifications((s) => s.signIn)
  const refreshApps = useConnectedAppsStore((s) => s.refresh)
  const appsLoaded = useConnectedAppsStore((s) => s.loaded)
  useEffect(() => {
    if (!appsLoaded) void refreshApps()
  }, [appsLoaded, refreshApps])

  /**
   * Hide what the backbone would refuse, so no row is a dead affordance, and
   * what another row already reaches (`notInMenu`), so nothing is offered twice.
   */
  const shown = (apps: readonly SegmentAppMeta[]): SegmentAppMeta[] =>
    apps.filter((a) => !a.notInMenu && (!a.gateKind || enabled(a.gateKind)))

  const officeApps = shown(SEGMENT_APPS.office)
  const byKey = (keys: readonly string[]): SegmentAppMeta[] =>
    keys.map((k) => officeApps.find((a) => a.key === k)).filter((a): a is SegmentAppMeta => !!a)

  /**
   * Drag an app or tool tile onto a desk, when it has a widget to become.
   * Returns undefined for the ones that do not, which leaves the tile
   * undraggable rather than grabbable-but-inert.
   */
  const tileDrag = (key: string): ((e: React.DragEvent) => void) | undefined => {
    const app = officeApps.find((a) => a.key === key)
    const kind = app ? tileWidgetKind(app) : undefined
    if (!kind) return undefined
    return (e) => {
      e.dataTransfer.setData(DRAG_MIME, kind)
      e.dataTransfer.effectAllowed = 'copy'
    }
  }

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
          {/* Home first, as in the desk sidebar's own list. It is the one Home
              row: the registry's desk hub is kept out of the app list below
              (notInMenu), and both routes draw the same Home dashboard. The
              testid is the hub row's old one, so existing checks still find it. */}
          <Row
            label="Home"
            icon="plexii:home"
            tone={AREA_TONES.home}
            active={activeArea === 'home' || isActive('plexidesk', 'home')}
            onClick={() => useViewStore.getState().goHome()}
            testid="nav-plexidesk-home"
          />
          {DESK_VIEWS.map((d) => (
            <Row
              key={d.kind}
              label={d.label}
              icon={d.icon}
              tone={d.tone}
              entity={viewKindEntity(d.kind)}
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
              tone={a.tone}
              entity={segmentAppEntity('plexidesk', a.key)}
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
            <AppTileMenu key={a.key} app={a}>
            <Tile
              label={a.label}
              active={isActive('office', a.key)}
              onClick={() => goOffice(a.key)}
              testid={`office-sideapp-${a.key}`}
              onDragStart={tileDrag(a.key)}
            >
              {/* The app's own Plexii tile; its registry glyph, in the app's
                  colour, only where the set has none (lib/plexiiIconMap). */}
              <PlexiiIcon
                kind="app"
                id={a.key}
                size={22}
                fallback={a.icon}
                fallbackFilled
                fallbackClassName={isActive('office', a.key) ? '' : (a.tone ?? 'text-[var(--ink-70)]')}
              />
            </Tile>
            </AppTileMenu>
          ))}
        </TileGrid>

        <SubHeading label="Tools" />
        {/* A grid, on the same rules as PlexiiApps and Connected apps: same
            tile, same single-line label, same column count giving way as the
            menu narrows. It was a list of rows, which made this one section
            read as a different kind of thing from the two around it. */}
        <TileGrid>
          {byKey(TOOL_KEYS).map((a) => (
            <AppTileMenu key={a.key} app={a}>
            <Tile
              label={a.label}
              active={isActive('office', a.key)}
              onClick={() => goOffice(a.key)}
              testid={`office-comms-app-${a.key}`}
              onDragStart={tileDrag(a.key)}
            >
              <PlexiiIcon
                kind="app"
                id={a.key}
                size={22}
                fallback={a.icon}
                fallbackFilled
                fallbackClassName={isActive('office', a.key) ? '' : (a.tone ?? 'text-[var(--ink-70)]')}
              />
            </Tile>
            </AppTileMenu>
          ))}
        </TileGrid>
      </Section>

      <Section
        id="widgets"
        label="Work widgets"
        icon="widgets"
        kind="widgets"
        locked={false}
        onActivate={() => {
          // The header lists every widget file: Files, narrowed to widgets.
          useFileManagerStore.getState().setTypeFilter('widgets')
          void useFileManagerStore.getState().openFolder(null)
          useViewStore.getState().goFiles()
        }}
        open={open.widgets}
        onToggle={() => toggle('widgets')}
      >
        <WidgetsSection />
      </Section>

      <Section
        id="connected"
        label="Connected apps"
        icon="hub"
        kind="connected-apps"
        locked={!appsEnt.enabled}
        lockedReason={appsEnt.reason}
        onLockedClick={appsEnt.onLockedClick}
        open={open.connected}
        onToggle={() => toggle('connected')}
      >
        {/* Connected apps belong to the ACTIVE ORG. The heading says which,
            because the same app is a different account per org and a tile that
            does not say whose account it is is a trap. */}
        <SubHeading
          label={isPersonal ? 'Connected apps — all accounts' : `Connected apps — ${orgName ?? 'this org'}`}
          action={
            <button
              onClick={() => setAddAppOpen(true)}
              data-testid="nav-add-connected-app"
              title={
                isPersonal
                  ? 'Connect an app to your personal account'
                  : `Connect an app to ${orgName ?? 'this organisation'}`
              }
              className="inline-flex items-center justify-center w-5 h-5 rounded-md shrink-0 text-[var(--ink-50)] hover:text-[rgb(var(--accent))] hover:bg-[var(--surface-sunken)]"
            >
              <Icon name="add" size={15} />
            </button>
          }
        />
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
                onClick={() => {
                  // Opening it is reading it: drop the badge rather than
                  // leaving a number the user has just dealt with.
                  useAppNotifications.getState().clear(app.id)
                  goConnectedApp(app.id)
                }}
                testid={`nav-connected-app-${app.id}`}
                // Restores dragging an app onto a canvas. The row list that
                // used to carry this was removed when the duplicate second
                // list went; the grid never had it, so the affordance was
                // lost entirely in the expanded menu. Same three types the
                // old row set, so the canvas handler is unchanged: the id for
                // a real connected-app widget, and the URL so a drop target
                // that only understands links still gets something useful.
                onDragStart={(e) => {
                  e.dataTransfer.setData(CONNECTED_APP_DRAG_MIME, app.id)
                  e.dataTransfer.setData('text/uri-list', app.url)
                  e.dataTransfer.setData('text/plain', app.url)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                badge={app.notifications ? (unreadCounts[app.id]?.count ?? 0) : 0}
                liveness={app.notifications ? (appStatus[app.id]?.liveness ?? 'asleep') : null}
                unit={unreadCounts[app.id]?.unit ?? 'unknown'}
                signedOut={appSignIn[app.id]?.signedOut === true}
                // In the personal aggregate the same app can appear once per
                // org, so each tile says which account it is. Inside an org
                // every tile is that org's, and the label would be noise.
                note={isPersonal ? orgLabel(app.orgId) : undefined}
              >
                <AppLogo app={app} size={22} glyphSize={13} />
              </Tile>
            ))}
          </TileGrid>
        )}
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
              tone={a.tone}
              entity={segmentAppEntity('plexipeople', a.key)}
              active={isActive('plexipeople', a.key)}
              onClick={() => goPlexiPeople(a.key)}
              testid={`nav-plexipeople-${a.key}`}
            />
          ))}
        </div>
      </Section>

      <Section
        id="brain"
        label="PlexiiBrain"
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
              tone={a.tone}
              entity={segmentAppEntity('plexibrain', a.key)}
              active={isActive('plexibrain', a.key)}
              onClick={() => goPlexiBrain(a.key)}
              testid={`nav-plexibrain-${a.key}`}
            />
          ))}
        </div>
      </Section>

      {/* Connecting an app from the menu lands it in the ACTIVE org, which is
          what the heading above the + already said it would do. */}
      {addAppOpen && (
        <AddConnectedAppDialog
          onClose={() => setAddAppOpen(false)}
          onAdded={(id) => {
            setAddAppOpen(false)
            goConnectedApp(id)
          }}
        />
      )}
    </nav>
  )
}

/** Exported for the tests that assert the menu's shape. */
export { PLEXII_APP_KEYS, TOOL_KEYS, SECTIONS }
