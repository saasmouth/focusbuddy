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
import { useAppNotifications } from '../../stores/appNotifications'
import { useViewKindEnabled } from '../../lib/viewCapability'
import { useCapabilityStore } from '../../stores/capabilities'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
import AddConnectedAppDialog from '../AddConnectedAppDialog'
import { AREA_TONES } from '../../lib/areaTones'
import { computeEntitlement } from '../../lib/entitlementReason'
import { SEGMENT_APPS, type SegmentAppMeta } from '../../lib/segmentApps'
import { DRAG_MIME } from '../../lib/widgetCatalog'
import { CONNECTED_APP_DRAG_MIME } from '../Sidebar'
import type { WidgetKind } from '@shared/types'

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
 * What dropping an app or tool tile onto a desk creates.
 *
 * Only the ones with a real widget equivalent are here. `sign`, `meet` and
 * `vault` are deliberately absent: there is no widget for them, so they stay
 * undraggable rather than offering a grab cursor that does nothing when you
 * let go. The canvas already handles this MIME from the widget palette, so
 * dropping goes down a path that was working before this was wired up.
 */
const TILE_WIDGET_KIND: Record<string, WidgetKind> = {
  docs: 'doc',
  sheets: 'sheet',
  slides: 'slides',
  diagrams: 'diagram',
  design: 'design',
  draw: 'draw',
  mail: 'email',
  inbox: 'inbox',
  chat: 'chat-thread',
  calendar: 'calendar',
  files: 'drive',
  browser: 'webview'
}

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
  { kind: 'attention', label: 'Attention', icon: 'notifications', tone: AREA_TONES.attention, go: (v) => v.goAttention() },
  { kind: 'rooms', label: 'Rooms', icon: 'meeting_room', tone: AREA_TONES.rooms, go: (v) => v.goRooms() },
  { kind: 'desks', label: 'Desks', icon: 'desk', tone: AREA_TONES.desks, go: (v) => v.goDesks() },
  { kind: 'shared', label: 'Shared Desks', icon: 'folder_shared', tone: AREA_TONES.shared, go: (v) => v.goShared() },
  { kind: 'trash', label: 'Trash', icon: 'delete', tone: AREA_TONES.trash, go: (v) => v.goTrash() }
]

type SectionId = 'desk' | 'apps' | 'people' | 'brain'

const SECTIONS: { id: SectionId; label: string; icon: string; tone: string }[] = [
  // Section heads take the hue of the area they open, from the same map as
  // every row inside them.
  { id: 'desk', label: 'Desk', icon: 'desktop_windows', tone: AREA_TONES.home },
  // "Office" named the room; the operator renamed it for what it holds.
  { id: 'apps', label: 'Apps', icon: 'apps', tone: AREA_TONES.office },
  { id: 'people', label: 'People', icon: 'groups', tone: AREA_TONES.people },
  { id: 'brain', label: 'Brain', icon: 'neurology', tone: AREA_TONES.brain }
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
          <Icon name={icon} size={17} filled className={`shrink-0 ${SECTION_TONE[id]}`} />
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
          <Icon name={icon} size={17} filled className={`shrink-0 ${SECTION_TONE[id]}`} />
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
  tone,
  active,
  onClick,
  testid
}: {
  label: string
  icon: string
  /** The icon's colour. Every icon in this menu carries one. */
  tone?: string
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
      {/* Coloured, and filled rather than outlined — an outline at 16px reads
          as grey whatever colour it is given. The active row keeps the accent
          so selection still wins over the icon's own hue. */}
      <span
        className={`inline-flex items-center justify-center w-6 h-6 shrink-0 ${
          active ? '' : (tone ?? 'text-[var(--ink-60)]')
        }`}
      >
        <Icon name={icon} size={17} filled />
      </span>
      <span className="min-w-0 truncate text-left whitespace-nowrap">{label}</span>
    </button>
  )
}

/**
 * A grid of icon tiles — PlexiiApps, Tools and Connected apps.
 *
 * COLUMNS FOLLOW THE WIDTH, and that is the whole trick. It was a fixed
 * `grid-cols-4`, so at the 232px minimum sidebar width each tile got ~52px and
 * "PlexiDiagrams" had nowhere to go but a second line. `auto-fit` with a
 * minimum tile width drops to three columns, then two, as the menu narrows —
 * which is what the operator asked for: fewer columns rather than wrapped
 * names. No ResizeObserver needed; the grid does it in CSS, so it also follows
 * a drag-resize live.
 *
 * TILE_MIN is the floor that keeps the longest real label on one line at this
 * font size — "PlexiDiagrams" is the one that sets it.
 */
const TILE_MIN = 84

function TileGrid({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      className="grid gap-1 px-2"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${TILE_MIN}px, 1fr))` }}
      data-testid="nav-tile-grid"
    >
      {children}
    </div>
  )
}

function Tile({
  label,
  active,
  onClick,
  testid,
  badge = 0,
  liveness = null,
  unit = 'unknown',
  note,
  signedOut = false,
  onDragStart,
  children
}: {
  label: string
  active: boolean
  onClick: () => void
  testid?: string
  /** A second, quieter line — which account this tile is. Omitted when there
   *  is nothing to disambiguate. */
  note?: string
  /**
   * Makes the tile draggable onto a desk canvas.
   *
   * Omitted means not draggable, and that is the honest default: a tile with
   * a grab cursor that does nothing when dropped is worse than one that never
   * offered. Only tiles with a real destination get this.
   */
  onDragStart?: (e: React.DragEvent) => void
  /** An unread count the app itself reported. 0 renders nothing. */
  badge?: number
  /**
   * Whether that count is arriving live from a signed-in background session.
   *
   * 'live' is a sun and a green count; anything else is a moon and a grey one.
   * A bare number would be making two different claims with one mark — "4
   * unread right now" and "4 unread whenever we last managed to look".
   */
  liveness?: 'live' | 'signed-out' | 'asleep' | null
  /**
   * What `badge` counts. The title gives threads, the page's accessible labels
   * give messages, and saying "4" for either without saying which was the bug.
   */
  unit?: 'messages' | 'conversations' | 'unknown'
  /**
   * The app was signed in and has since landed on a sign-in page — the event
   * that silently stops its unread counts. Shown on every connected app, not
   * only watched ones, and cleared the moment the app is back on a normal
   * page. Clicking the tile opens the app, which is where you sign in.
   */
  signedOut?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      title={note ? `${label} — ${note}` : label}
      data-testid={testid}
      data-signed-out={signedOut ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-col items-center gap-1 px-1 py-2 rounded-lg ${onDragStart ? 'cursor-grab active:cursor-grabbing ' : ''}${
        active
          ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]'
          : 'text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <span className="relative inline-flex items-center justify-center w-7 h-7 shrink-0">
        {children}
        {signedOut && (
          <span
            className="absolute -top-1 -left-1.5 inline-flex items-center justify-center w-[15px] h-[15px] rounded-full bg-amber-500 text-white"
            data-testid="nav-signed-out-badge"
            aria-hidden="true"
          >
            <Icon name="key" size={9} filled />
          </span>
        )}
        {badge > 0 && (
          <span
            className={`absolute -top-1 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold leading-[15px] text-center fb-tabular ${
              liveness === 'live'
                ? 'bg-emerald-500 text-white'
                : 'bg-[var(--ink-30)] text-[var(--surface-base)]'
            }`}
            data-testid="nav-unread-badge"
            data-live={liveness === 'live' ? 'true' : 'false'}
            title={
              // Name the unit when we know it. "4 unread" was ambiguous in the
              // worst way: the user read messages and we meant threads.
              (() => {
                const what =
                  unit === 'messages'
                    ? `${badge} unread ${badge === 1 ? 'message' : 'messages'}`
                    : unit === 'conversations'
                      ? `${badge} ${badge === 1 ? 'conversation' : 'conversations'} with unread`
                      : `${badge} unread`
                return liveness === 'live'
                  ? `${what} — signed in, checked just now`
                  : liveness === 'signed-out'
                    ? `${what} when last seen — signed out, so this is not current`
                    : `${what} when last seen — not being checked right now`
              })()
            }
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        {/* Awake or asleep. Shown whenever the app is watched, including at
            zero unread, because "nothing new" and "we cannot see" are not the
            same answer and the user asked to be able to tell. */}
        {liveness !== null && (
          <span
            className="absolute -bottom-1 -right-1 inline-flex items-center justify-center"
            data-testid="nav-liveness"
            data-liveness={liveness}
            title={
              liveness === 'live'
                ? 'Signed in — counts are arriving live'
                : liveness === 'signed-out'
                  ? 'Signed out — sign in to this app for live counts'
                  : 'Asleep — not being checked right now'
            }
          >
            <Icon
              name={liveness === 'live' ? 'wb_sunny' : 'bedtime'}
              size={11}
              filled
              className={liveness === 'live' ? 'text-amber-400' : 'text-[var(--ink-40)]'}
            />
          </span>
        )}
      </span>
      {/* ONE LINE, ALWAYS. A wrapped name makes every tile in the row taller
          and the grid ragged; the column count gives way instead (see
          TileGrid). The full name is on the tile's title, so an ellipsis never
          loses it. */}
      <span className="w-full text-[10px] leading-tight text-center truncate whitespace-nowrap">
        {label}
      </span>
      {signedOut ? (
        // Replaces the account note while it applies: "you are signed out" is
        // the more urgent line, and the account is still on the tooltip.
        <span
          className="w-full text-[9px] tracking-tight leading-tight text-center truncate whitespace-nowrap font-medium text-amber-700 dark:text-amber-400"
          data-testid="nav-signed-out"
          title={`${note ? `${label} (${note})` : label} was signed out — click to open it and sign in`}
        >
          Signed out — sign in
        </span>
      ) : (
        note && (
          <span
            className="w-full text-[9px] leading-tight text-center truncate whitespace-nowrap text-[var(--ink-40)]"
            data-testid="nav-tile-note"
          >
            {note}
          </span>
        )
      )}
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
  const brainEnt = areaEnt('plexibrain', 'product_brain', 'Brain')
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

  /** Hide what the backbone would refuse, so no row is a dead affordance. */
  const shown = (apps: readonly SegmentAppMeta[]): SegmentAppMeta[] =>
    apps.filter((a) => !a.gateKind || enabled(a.gateKind))

  const officeApps = shown(SEGMENT_APPS.office)
  const byKey = (keys: readonly string[]): SegmentAppMeta[] =>
    keys.map((k) => officeApps.find((a) => a.key === k)).filter((a): a is SegmentAppMeta => !!a)

  /**
   * Drag an app or tool tile onto a desk, when it has a widget to become.
   * Returns undefined for the ones that do not, which leaves the tile
   * undraggable rather than grabbable-but-inert.
   */
  const tileDrag = (key: string): ((e: React.DragEvent) => void) | undefined => {
    const kind = TILE_WIDGET_KIND[key]
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
          {DESK_VIEWS.map((d) => (
            <Row
              key={d.kind}
              label={d.label}
              icon={d.icon}
              tone={d.tone}
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
              onDragStart={tileDrag(a.key)}
            >
              {/* Filled, not outlined, and in the app's own colour. An outlined
                  glyph reads as grey at this size no matter what colour it is
                  given, which is why these looked monochrome. */}
              <Icon
                name={a.icon}
                size={22}
                filled
                className={isActive('office', a.key) ? '' : (a.tone ?? 'text-[var(--ink-70)]')}
              />
            </Tile>
          ))}
        </TileGrid>

        <SubHeading label="Tools" />
        {/* A grid, on the same rules as PlexiiApps and Connected apps: same
            tile, same single-line label, same column count giving way as the
            menu narrows. It was a list of rows, which made this one section
            read as a different kind of thing from the two around it. */}
        <TileGrid>
          {byKey(TOOL_KEYS).map((a) => (
            <Tile
              key={a.key}
              label={a.label}
              active={isActive('office', a.key)}
              onClick={() => goOffice(a.key)}
              testid={`office-comms-app-${a.key}`}
              onDragStart={tileDrag(a.key)}
            >
              <Icon
                name={a.icon}
                size={22}
                filled
                className={isActive('office', a.key) ? '' : (a.tone ?? 'text-[var(--ink-70)]')}
              />
            </Tile>
          ))}
        </TileGrid>

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
              tone={a.tone}
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
