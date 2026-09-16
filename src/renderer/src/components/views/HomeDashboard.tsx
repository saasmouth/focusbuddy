import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DeskWidgetCard,
  OfficeDocumentCard,
  DeskWidgetPicker,
  DocumentPicker
} from './dashboardEmbeds'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'framer-motion'
import { createPortal } from 'react-dom'
import {
  SIZE_SPAN,
  SUBDIV,
  bestInsertionIndex,
  cellRect,
  clampSize,
  packGrid,
  pointerCell,
  sizedFromColumns,
  type GridMetrics,
  type SizedInstance,
  type WidgetSize
} from './homeGridLayout'
import { useViewStore } from '../../stores/view'
import { useAccountStore } from '../../stores/account'
import { personFirstName } from '../../lib/personName'
import { useDocumentsStore } from '../../stores/documents'
import { useNodeStore } from '../../stores/nodes'
import { useFocusSessionStore } from '../../stores/focusSession'
import { RailCard } from '../plexi'
import Modal from '../plexi/Modal'
import StandupHome from './StandupHome'
import StartOrAskPlexi from './StartOrAskPlexi'
import DashboardWizardOverlay from './DashboardWizardOverlay'
import Icon from '../Icon'
import {
  AttentionPulseBlock,
  OverdueRadarBlock,
  AgendaBlock,
  RecentActivityBlock
} from '../attention/attentionBlocks'
import { migrateQuickLinks } from './homeShortcutTargets'
import {
  HOME_WIDGET_DEFS,
  widgetDef,
  type HomeWidgetConfig,
  type HomeWidgetId,
  type HomeWidgetInstance,
  PinnedDeskWidget,
  RoomPortalWidget,
  AppLauncherWidget,
  CreateWidget,
  FocusTimerWidget,
  OneThingNowWidget,
  WhereWasIWidget,
  StalledDeskWidget,
  ShortcutsWidget,
  NewMeetingWidget,
  PinnedConversationWidget,
  TranscribeWidget,
  NewDeskWidget,
  DiscoverWidget,
  conversationName
} from './homeWidgets'
import type { DashboardSurface } from './homeWidgetDefs'
import PeopleHomeView from './PeopleHomeView'
import {
  AttentionWidget,
  AttentionQueueWidget,
  AttentionCalendarWidget,
  AttentionCompletedWidget,
  AttentionSystemWidget,
  StaleDesksWidget
} from './attentionWidgets'
import { useMessagingStore } from '../../stores/messaging'
import { usePresenceStore } from '../../stores/presence'
import { useCapabilityEnabled } from '../../stores/capabilities'
import { personDisplayName } from '../../lib/personName'
import type { ActivityEvent, DocumentMeta, FbNode } from '@shared/types'

// Home — the landing dashboard, laid out as a desk the app sets for you.
// The page sits on the same desk-paper substrate as a real canvas, and every
// section is a widget pinned into a slot: same visual language as canvas
// widgets, but locked positions, so arriving home never feels like leaving the
// workspace for a website. Widgets can be re-slotted by dragging their corner
// grip; the arrangement persists locally and can be reset to the stock layout.
//
// Every section reads a real source and shows an honest empty or zero state
// when there is nothing to show. Nothing here is seeded or invented.
//
// Real sources, widget by widget:
//   greeting            useAccountStore().account.handle (+ time-of-day from the clock)
//   hero input          StartOrAskPlexi (spec §4.1) + the AI command bar trigger
//   standup             StandupHome (Assistant 4.5)
//   rooms & desks       window.api.nodes.list() — the real rooms/desks, columns left→right
//   continue            useDocumentsStore().list, sorted by real updatedAt
//   today's agenda      window.api.timeBlocks.list() for the local day
//   pulse               real counts derived from the nodes + the agenda
//   quick actions       navigate to real destinations via the view store
//   recent activity     window.api.trail.recent(null, ...) — the real activity log
//   focus mode          the real 5-minute-promise focus session (useFocusSessionStore)

const DOC_TYPE_ICON: Record<string, { icon: string; tint: string; label: string }> = {
  doc: { icon: 'description', tint: 'text-sky-500', label: 'Document' },
  sheet: { icon: 'table_chart', tint: 'text-emerald-500', label: 'Spreadsheet' },
  slides: { icon: 'slideshow', tint: 'text-orange-500', label: 'Presentation' },
  map: { icon: 'gesture', tint: 'text-violet-500', label: 'Drawing' },
  design: { icon: 'palette', tint: 'text-fuchsia-500', label: 'Design' }
}


function relTime(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const hrs = Math.round(m / 60)
  if (hrs < 24) return `${hrs}h ago`
  const d = Math.round(hrs / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}


// Greeting name from the real account. We never invent a name: signed-out users
// get a plain, friendly fallback rather than a fabricated identity.
function greetingName(handle: string | null | undefined, email: string | null): string {
  const h = (handle ?? '').replace(/^@/, '').trim()
  if (h) return h
  if (email) {
    const local = email.split('@')[0]?.trim()
    if (local) return local
  }
  return 'there'
}

function timeOfDay(now: number): string {
  const h = new Date(now).getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}



// Locally-dismissed activity items (spec §4.2 "Dismiss — remove low-value items
// from view"). Kept in localStorage so a dismissal sticks across reloads; capped
// so the list can't grow without bound.

// ── The slot system ──────────────────────────────────────────────────────────
// Two columns — a wide main track and a narrow rail — each an ordered list of
// placed widget INSTANCES. An instance is a widget id plus its config (which
// desk is pinned, which room the portal opens, which links are picked), so
// configurable widgets can appear more than once. Customize mode edits this
// arrangement through the gallery drawer; everything persists per device.

interface HomeLayout {
  main: HomeWidgetInstance[]
  rail: HomeWidgetInstance[]
}

// Each dashboard opens with a layout that suits it. Home keeps the layout it
// has always had; the three new surfaces open on widgets that mean something
// there, with People leading on the view that used to BE its home screen so
// nothing is lost by turning that page into a grid.
const STOCK_BY_SURFACE: Record<Exclude<DashboardSurface, 'home'>, HomeLayout> = {
  office: {
    main: [
      { key: 'office-document', widget: 'office-document' },
      { key: 'continue', widget: 'continue' }
    ],
    rail: [
      { key: 'quick', widget: 'quick' },
      { key: 'activity', widget: 'activity' }
    ]
  },
  people: {
    main: [
      { key: 'people-home', widget: 'people-home' },
      { key: 'standup', widget: 'standup' }
    ],
    rail: [
      { key: 'agenda', widget: 'agenda' },
      { key: 'activity', widget: 'activity' }
    ]
  },
  brain: {
    main: [
      { key: 'navigator', widget: 'navigator' },
      { key: 'continue', widget: 'continue' }
    ],
    rail: [
      { key: 'pulse', widget: 'pulse' },
      { key: 'activity', widget: 'activity' }
    ]
  }
}

const STOCK_LAYOUT: HomeLayout = {
  main: [
    { key: 'standup', widget: 'standup' },
    { key: 'navigator', widget: 'navigator' },
    { key: 'continue', widget: 'continue' }
  ],
  rail: [
    { key: 'agenda', widget: 'agenda' },
    { key: 'pulse', widget: 'pulse' },
    { key: 'quick', widget: 'quick' },
    { key: 'activity', widget: 'activity' }
  ]
}
const KNOWN_IDS = new Set<string>(HOME_WIDGET_DEFS.map((d) => d.id))
const LAYOUT_KEY_V1 = 'home.layout.v1'
const LAYOUT_KEY = 'home.layout.v2'

function newInstanceKey(widget: HomeWidgetId): string {
  return `${widget}:${Math.random().toString(36).slice(2, 9)}`
}

function loadLayout(): HomeLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<HomeLayout>
      const seen = new Set<string>()
      const clean = (list: unknown): HomeWidgetInstance[] =>
        (Array.isArray(list) ? list : []).filter(
          (it): it is HomeWidgetInstance =>
            !!it &&
            typeof it === 'object' &&
            typeof (it as HomeWidgetInstance).key === 'string' &&
            KNOWN_IDS.has((it as HomeWidgetInstance).widget) &&
            !seen.has((it as HomeWidgetInstance).key) &&
            !!seen.add((it as HomeWidgetInstance).key)
        )
      return { main: clean(parsed.main), rail: clean(parsed.rail) }
    }
    // Migrate a v1 layout (plain widget-id arrays) into instances once.
    const v1 = localStorage.getItem(LAYOUT_KEY_V1)
    if (v1) {
      const parsed = JSON.parse(v1) as { main?: unknown; rail?: unknown }
      const lift = (ids: unknown): HomeWidgetInstance[] =>
        (Array.isArray(ids) ? ids : [])
          .filter((id): id is HomeWidgetId => typeof id === 'string' && KNOWN_IDS.has(id))
          .map((id) => ({ key: id, widget: id }))
      const migrated = { main: lift(parsed.main), rail: lift(parsed.rail) }
      if (migrated.main.length + migrated.rail.length > 0) return migrated
    }
    return STOCK_LAYOUT
  } catch {
    return STOCK_LAYOUT
  }
}

// ── The widget grid (Apple widget-picker mission) ───────────────────────────
// One flat, ordered, sized list renders as a packed 4-column grid; per-widget
// sizes come from each def's `sizes`/`defaultSize` and persist as v3 (the v2
// key stays untouched for rollback). Every feel knob lives here.

const GRID = {
  cols: 4,
  cellH: 200,
  gap: 18,
  // Displaced widgets sliding aside, and the placeholder gap moving.
  reflowSpring: { type: 'spring' as const, stiffness: 550, damping: 40 },
  // The lifted card settling into its slot on release.
  settleSpring: { type: 'spring' as const, stiffness: 520, damping: 42 },
  liftScale: 1.04,
  // Pointer travel before a press becomes a drag (below it, it's a click).
  dragActivationPx: 6
}

// v3 persistence: the flat sized list, stored whole. v2 (and v1 through the
// v2 reader) migrate on first load — main-column widgets arrive large, rail
// widgets small — and the v2 key is never deleted, so rolling back to a
// pre-grid build finds the user's old layout intact.
// Home keeps the original key so an existing layout survives untouched; the
// other dashboards get their own, so each personalises independently.
function flatKey(surface: DashboardSurface): string {
  return surface === 'home' ? 'home.layout.v3' : `home.layout.v3.${surface}`
}
const SIZE_VALUES: readonly string[] = ['icon', 'sm', 'md', 'lg', 'stack']

// The packing runs in half-cell subunits (see homeGridLayout.ts): same gap,
// same visual geometry for every existing size, plus the icon tier. These
// derive the subunit metrics from the visual feel knobs above.
const SUBROW_H = (GRID.cellH - GRID.gap) / 2

const STOCK_FLAT: SizedInstance[] = sizedFromColumns(STOCK_LAYOUT.main, STOCK_LAYOUT.rail)

function stockFlatFor(surface: DashboardSurface): SizedInstance[] {
  if (surface === 'home') return STOCK_FLAT
  const l = STOCK_BY_SURFACE[surface]
  return sizedFromColumns(l.main, l.rail)
}

function loadFlat(surface: DashboardSurface): SizedInstance[] {
  const stock = stockFlatFor(surface)
  try {
    const raw = localStorage.getItem(flatKey(surface))
    if (raw) {
      const parsed = JSON.parse(raw) as { widgets?: unknown }
      const seen = new Set<string>()
      const clean = (Array.isArray(parsed.widgets) ? parsed.widgets : []).filter(
        (it): it is SizedInstance =>
          !!it &&
          typeof it === 'object' &&
          typeof (it as SizedInstance).key === 'string' &&
          KNOWN_IDS.has((it as SizedInstance).widget) &&
          SIZE_VALUES.includes((it as SizedInstance).size) &&
          !seen.has((it as SizedInstance).key) &&
          !!seen.add((it as SizedInstance).key)
      )
      if (clean.length > 0)
        return clean
          .map(migrateQuickLinks)
          .map((it) => ({ ...it, size: clampSize(widgetDef(it.widget), it.size) }))
    }
    // The v1/v2 migration only ever applied to Home; the other dashboards are
    // new and have nothing to migrate from.
    if (surface !== 'home') return stock
    const legacy = loadLayout()
    // Absorb quick-links before sizing so the columns carry Shortcuts defs.
    const migrated = sizedFromColumns(legacy.main.map(migrateQuickLinks), legacy.rail.map(migrateQuickLinks))
    return migrated.length > 0 ? migrated : stock
  } catch {
    return stock
  }
}

function saveFlat(surface: DashboardSurface, flat: SizedInstance[]): void {
  try {
    localStorage.setItem(flatKey(surface), JSON.stringify({ widgets: flat }))
  } catch {
    /* ignore quota */
  }
}

function flatIsStock(surface: DashboardSurface, flat: SizedInstance[]): boolean {
  const stock = stockFlatFor(surface)
  return (
    flat.length === stock.length &&
    flat.every((it, i) => it.widget === stock[i].widget && it.size === stock[i].size)
  )
}

// Deterministic per-room tint so the navigator reads like the colored room
// tiles in the design reference without inventing stored data.
const ROOM_TINTS = [
  'bg-violet-500/12 text-violet-500',
  'bg-sky-500/12 text-sky-500',
  'bg-emerald-500/12 text-emerald-500',
  'bg-amber-500/12 text-amber-600',
  'bg-rose-500/12 text-rose-500',
  'bg-fuchsia-500/12 text-fuchsia-500',
  'bg-teal-500/12 text-teal-500',
  'bg-indigo-500/12 text-indigo-500'
]
function roomTint(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ROOM_TINTS[Math.abs(h) % ROOM_TINTS.length]
}

const TOP_LEVEL = '__top__'

export default function HomeDashboard({
  surface = 'home'
}: { surface?: DashboardSurface } = {}): JSX.Element {
  const v = useViewStore()
  const account = useAccountStore((s) => s.account)

  const docs = useDocumentsStore((s) => s.list)
  const refreshDocs = useDocumentsStore((s) => s.refresh)
  const createBlankDoc = useDocumentsStore((s) => s.createBlank)

  const nodes = useNodeStore((s) => s.nodes)
  const refreshNodes = useNodeStore((s) => s.refresh)
  const createNode = useNodeStore((s) => s.create)
  const setActive = useNodeStore((s) => s.setActive)

  const focusActive = useFocusSessionStore((s) => s.active)
  const startFocus = useFocusSessionStore((s) => s.start)
  const finishFocus = useFocusSessionStore((s) => s.finish)

  // Today's real time blocks and the real workspace-wide activity feed are loaded
  // imperatively. null means "still loading"; [] means "loaded, genuinely empty".
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null)
  // A clock that ticks each minute so the greeting + relative times stay current.
  const [now, setNow] = useState(() => Date.now())

  // The sized widget list, rendered as one packed grid. Order IS the layout.
  const [flat, setFlat] = useState<SizedInstance[]>(() => loadFlat(surface))
  // A pointer drag in flight. React state carries only identity and the
  // settling flag; per-frame position rides motion values so pointer moves
  // never re-render.
  const [drag, setDrag] = useState<{ key: string; settling: boolean } | null>(null)
  const [customize, setCustomize] = useState(false)
  // The center-screen widget picker, over a blurred home page.
  const [gallery, setGallery] = useState(false)
  // The configuration wizard: a few questions, then a dashboard built from
  // the answers. Opens from the header and writes through commitFlat like any
  // other arrangement change, so Reset layout still undoes it.
  const [wizard, setWizard] = useState(false)
  // The instance just added from the picker: enters with a spring and a
  // short-lived glow so the eye lands where the widget did.
  const [justPlaced, setJustPlaced] = useState<string | null>(null)
  useEffect(() => {
    if (!justPlaced) return
    document
      .querySelector(`[data-widget-key="${justPlaced}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const t = window.setTimeout(() => setJustPlaced(null), 1800)
    return () => window.clearTimeout(t)
  }, [justPlaced])
  // A placed widget selected for swapping (click it, then click a gallery card).
  const [swapKey, setSwapKey] = useState<string | null>(null)
  // A config picker in flight: the widget def needing config, plus what happens
  // with the result — place at a position, swap an instance, or edit in place.
  const [picker, setPicker] = useState<{
    widget: HomeWidgetId
    kind: 'desk' | 'room' | 'conversation' | 'desk-widget' | 'document'
    initial?: HomeWidgetConfig
    apply: (config: HomeWidgetConfig) => void
  } | null>(null)

  // Imperative drag machinery. flatRef mirrors `flat` for the window-level
  // pointer handlers; dragInfoRef carries one drag's constants; the motion
  // values position the lifted card without React in the loop.
  const flatRef = useRef<SizedInstance[]>([])
  const gridRef = useRef<HTMLDivElement>(null)
  // Column count follows the container: the 4-column board collapses to 2
  // and then 1 as the window narrows. packGrid clamps spans, so lg/md become
  // full-width rather than overflowing.
  const [cols, setCols] = useState(GRID.cols)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const pick = (w: number): number => (w >= 1000 ? 4 : w >= 520 ? 2 : 1)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setCols((c) => (pick(w) === c ? c : pick(w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Honour the OS reduced-motion setting: reflow and settle become quick
  // fades instead of springs.
  const reducedMotion = useReducedMotion()
  const dragInfoRef = useRef<{
    key: string
    size: WidgetSize
    grabDX: number
    grabDY: number
    width: number
    height: number
    orig: SizedInstance[]
    lastCell: { col: number; row: number } | null
  } | null>(null)
  const movedRef = useRef(false)
  const cancelDragRef = useRef<() => void>(() => {})
  const dragX = useMotionValue(0)
  const dragY = useMotionValue(0)
  const dragScale = useMotionValue(1)
  flatRef.current = flat

  // Which room the navigator has open. TOP_LEVEL is the pseudo-room holding
  // standalone desks that live outside any room.
  const [navRoom, setNavRoom] = useState<string>(TOP_LEVEL)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    void refreshDocs()
    void refreshNodes()
    // Workspace-wide activity over the last 7 days. A null taskId asks the real
    // activity log for every recorded event, newest first.
    window.api.trail
      .recent(null, Date.now() - 7 * 86_400_000, 60)
      .then(setActivity)
      .catch(() => setActivity([]))
  }, [refreshDocs, refreshNodes])

  const name = personFirstName(account, greetingName(account?.handle, account?.email ?? null))

  // Continue where you left off — the real documents you last touched.
  const recentDocs = useMemo<DocumentMeta[]>(
    () =>
      docs
        .filter((d) => !d.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4),
    [docs]
  )

  // The navigator's left column: real rooms, most recently touched first.
  const rooms = useMemo<FbNode[]>(
    () =>
      nodes
        .filter((n) => n.kind === 'folder' && !n.archived && n.parentId === null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [nodes]
  )

  // Desk counts per room, and the desks of whichever room is open. Counts and
  // rows come straight from the real nodes — nothing invented.
  const deskCountByRoom = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of nodes) {
      if (n.kind === 'task' && !n.archived) {
        const key = n.parentId ?? TOP_LEVEL
        m.set(key, (m.get(key) ?? 0) + 1)
      }
    }
    return m
  }, [nodes])

  const navDesks = useMemo<FbNode[]>(
    () =>
      nodes
        .filter(
          (n) =>
            n.kind === 'task' &&
            !n.archived &&
            (navRoom === TOP_LEVEL ? n.parentId === null : n.parentId === navRoom)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8),
    [nodes, navRoom]
  )

  // If the open room disappears (archived elsewhere), fall back to Top level.
  useEffect(() => {
    if (navRoom !== TOP_LEVEL && !rooms.some((r) => r.id === navRoom)) setNavRoom(TOP_LEVEL)
  }, [rooms, navRoom])

  // Today's agenda — only the events that fall on the local day, in time order.

  // Pulse — real counts only. Tasks due today / overdue come from the real
  // nodes; events today from the real agenda. Anything not instrumented
  // (productivity %, focus-time %) is deliberately absent.


  const openDesk = (n: FbNode): void => {
    if (n.kind === 'folder') {
      // A folder node is a room: land on its dashboard, same as RoomsView.
      setActive(n.id)
      v.goRoom(n.id)
      return
    }
    setActive(n.id)
    v.goTask(n.id)
  }


  const onCreate = async (): Promise<void> => {
    // Create a real blank document and open it — the same path the documents hub
    // uses for its New button.
    const doc = await createBlankDoc('doc')
    v.goDocument(doc.id)
  }

  const onNewDesk = async (): Promise<void> => {
    try {
      const node = await createNode({
        parentId: navRoom === TOP_LEVEL ? null : navRoom,
        kind: 'task',
        title: 'New desk'
      })
      setActive(node.id)
      v.goTask(node.id)
    } catch {
      // create() throws DESK_LIMIT_REACHED on the free tier after prompting an
      // upgrade. Swallow it here: the prompt already told the user what happened.
    }
  }

  const toggleFocus = async (): Promise<void> => {
    if (focusActive) {
      await finishFocus('done')
    } else {
      // A global 5-minute promise, not bound to a specific task.
      await startFocus(null, 5 * 60, '5min')
    }
  }

  // ── Slot editing on the flat sized list ────────────────────────────────────
  const commitFlat = (next: SizedInstance[]): void => {
    flatRef.current = next
    setFlat(next)
    saveFlat(surface, next)
  }

  const findInstance = (key: string): SizedInstance | null =>
    flat.find((it) => it.key === key) ?? null

  // Place a new widget at the end of the board. The picker overlay passes
  // size and (for configurable widgets) config it already collected; without
  // a config the widget's own picker runs first. Singletons already placed
  // are a no-op.
  const placeWidget = (id: HomeWidgetId, size?: WidgetSize, config?: HomeWidgetConfig): void => {
    const def = widgetDef(id)
    if (!def.multi && isPlaced(id)) return
    const finalSize = clampSize(def, size ?? def.defaultSize)
    const finish = (cfg?: HomeWidgetConfig): void => {
      const key = newInstanceKey(id)
      commitFlat([...flatRef.current, { key, widget: id, config: cfg, size: finalSize }])
      setJustPlaced(key)
    }
    if (config !== undefined || !def.config) {
      finish(config)
    } else {
      setPicker({ widget: id, kind: def.config, apply: (cfg) => finish(cfg) })
    }
  }

  // Swap a placed instance for a different widget, keeping its slot and, as
  // far as the new widget supports it, its size.
  const swapWidget = (key: string, id: HomeWidgetId): void => {
    const def = widgetDef(id)
    if (!def.multi && isPlaced(id)) return
    const replaceWith = (config?: HomeWidgetConfig): void => {
      commitFlat(
        flatRef.current.map((it) =>
          it.key === key ? { key: newInstanceKey(id), widget: id, config, size: clampSize(def, it.size) } : it
        )
      )
      setSwapKey(null)
    }
    if (def.config) {
      setPicker({ widget: id, kind: def.config, apply: (config) => replaceWith(config) })
    } else {
      replaceWith()
    }
  }

  const removeInstance = (key: string): void => {
    commitFlat(flat.filter((it) => it.key !== key))
    if (swapKey === key) setSwapKey(null)
  }

  const editInstance = (key: string): void => {
    const inst = findInstance(key)
    if (!inst) return
    const def = widgetDef(inst.widget)
    if (!def.config) return
    setPicker({
      widget: inst.widget,
      kind: def.config,
      initial: inst.config,
      apply: (config) => {
        commitFlat(flatRef.current.map((it) => (it.key === key ? { ...it, config } : it)))
      }
    })
  }

  const isPlaced = (id: HomeWidgetId): boolean => flat.some((it) => it.widget === id)

  const resetLayout = (): void => {
    commitFlat(stockFlatFor(surface))
    setSwapKey(null)
  }

  // Escape backs out of customize mode one layer at a time: a drag in flight
  // first (restoring the pre-drag order), then the picker overlay, then swap
  // selection, then the mode.
  useEffect(() => {
    if (!customize) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (wizard) return
      if (dragInfoRef.current) cancelDragRef.current()
      else if (gallery) setGallery(false)
      else if (swapKey) setSwapKey(null)
      else setCustomize(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [customize, swapKey, gallery, wizard])

  // One widget = one tile. The renderer owns the chrome; content adapts to the
  // instance's size (row caps, column counts) so every size is designed, not
  // squeezed. The original dashboard widgets render inline because they share
  // this component's imperatively-loaded data, the catalog widgets come from
  // homeWidgets.tsx and read their stores directly.
  const renderWidget = (inst: SizedInstance): JSX.Element | null => {
    const size = inst.size
    switch (inst.widget) {
      case 'pinned-desk':
        // Add desk pins another desk: it places a fresh pinned-desk widget,
        // running the desk picker first.
        return <PinnedDeskWidget deskId={inst.config?.deskId} onAddAnother={() => placeWidget('pinned-desk')} />
      case 'people-home':
        // The whole former People home page, now one widget on its own grid.
        return <PeopleHomeView />
      case 'desk-widget':
        // The real object, live and editable. Re-picking replaces this card's
        // target rather than placing another.
        return (
          <DeskWidgetCard
            deskId={inst.config?.deskId}
            widgetId={inst.config?.widgetId}
            onPick={() =>
              setPicker({
                widget: 'desk-widget',
                kind: 'desk-widget',
                apply: (cfg) =>
                  commitFlat(
                    flatRef.current.map((it) =>
                      it.key === inst.key ? { ...it, config: { ...it.config, ...cfg } } : it
                    )
                  )
              })
            }
          />
        )
      case 'office-document':
        return (
          <OfficeDocumentCard
            documentId={inst.config?.documentId}
            documentTitle={inst.config?.documentTitle}
            onPick={() =>
              setPicker({
                widget: 'office-document',
                kind: 'document',
                apply: (cfg) =>
                  commitFlat(
                    flatRef.current.map((it) =>
                      it.key === inst.key ? { ...it, config: { ...it.config, ...cfg } } : it
                    )
                  )
              })
            }
          />
        )
      case 'room-portal':
        return <RoomPortalWidget roomId={inst.config?.roomId} size={size} />
      case 'shortcuts':
        // The composer commits config live. Previews render synthetic
        // instances whose keys are not in the layout; the guard keeps their
        // edits from touching the real board.
        return (
          <ShortcutsWidget
            config={inst.config}
            size={size}
            onUpdate={(config) => {
              if (!flatRef.current.some((it) => it.key === inst.key)) return
              commitFlat(flatRef.current.map((it) => (it.key === inst.key ? { ...it, config } : it)))
            }}
          />
        )
      case 'app-launcher':
        return <AppLauncherWidget />
      // The Attention family (S6, SPEC-014).
      // DEC-019c: 'attention' is the one offered widget (section slider
      // inside); the att-* cases below keep any stored placements rendering.
      case 'attention':
        return <AttentionWidget size={size} />
      case 'att-tasks':
        return <AttentionQueueWidget queue="to_do" title="To Do" emptyLine="Nothing needs you. Capture with ⌘K." size={size} />
      case 'att-reviews':
        return <AttentionQueueWidget queue="to_review" title="Review" emptyLine="No reviews waiting." size={size} />
      case 'att-calendar':
        return <AttentionCalendarWidget size={size} />
      case 'att-ack':
        return <AttentionQueueWidget queue="to_respond" title="Respond" emptyLine="No one waiting on you." size={size} />
      case 'att-completed':
        return <AttentionCompletedWidget size={size} />
      case 'att-stale':
        return <StaleDesksWidget size={size} />
      case 'att-system':
        return <AttentionSystemWidget size={size} />
      case 'create':
        return <CreateWidget />
      case 'focus-timer':
        return <FocusTimerWidget size={size} />
      case 'overdue':
        // DEC-048: attention-backed, one component with a variant prop — the
        // full variant lives on the Attention command center.
        return <OverdueRadarBlock variant="compact" />
      case 'one-thing':
        return <OneThingNowWidget />
      case 'where-was-i':
        return <WhereWasIWidget activity={activity} />
      case 'stalled':
        return <StalledDeskWidget />
      case 'new-meeting':
        return <NewMeetingWidget size={size} />
      case 'pinned-conversation':
        return <PinnedConversationWidget config={inst.config} size={size} />
      case 'transcribe':
        return <TranscribeWidget size={size} />
      case 'new-desk':
        return <NewDeskWidget />
      case 'discover':
        return <DiscoverWidget />
      case 'standup':
        // StandupHome carries its own card chrome + margin one level deeper
        // than the tile wrapper can reach; neutralize both here so the glass
        // tile is the only surface.
        return (
          <div className="[&>*]:!mb-0 [&>*]:h-full [&>*]:!bg-transparent [&>*]:!shadow-none [&>*]:!border-0">
            <StandupHome />
          </div>
        )

      case 'navigator':
        return (
          <RailCard
            title="Rooms and desks"
            icon="meeting_room"
            tone="sky"
            action={{ label: 'All rooms', onClick: () => v.goRooms() }}
            fill
            // DEC-132 — the tile owns the height; each column scrolls on its
            // own (rooms on the left, desks on the right), so no room or desk
            // is ever cut off mid-row and the header stays put.
            bodyClassName="px-4 pb-4 flex flex-col"
          >
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(150px,200px)_1fr] flex-1 min-h-0 gap-3" data-testid="home-navigator">
              {/* Rooms column */}
              <div className="flex sm:flex-col gap-1 overflow-x-auto sm:overflow-y-auto min-h-0 sm:border-r sm:border-[var(--edge-soft)] sm:pr-3">
                <button
                  onClick={() => setNavRoom(TOP_LEVEL)}
                  data-testid="home-nav-room-top"
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left shrink-0 transition-colors ${
                    navRoom === TOP_LEVEL ? 'bg-[rgb(var(--accent)/0.10)]' : 'hover:bg-[var(--surface-sunken)]'
                  }`}
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-stone-500/10 text-[var(--ink-60)] shrink-0">
                    <Icon name="home" size={15} />
                  </span>
                  <span className="min-w-0">
                    <span className={`block truncate text-[12.5px] ${navRoom === TOP_LEVEL ? 'text-[var(--ink-100)] font-medium' : 'text-[var(--ink-90)]'}`}>
                      Top level
                    </span>
                    <span className="block fb-t-caption text-[var(--ink-45)]">
                      {deskCountByRoom.get(TOP_LEVEL) ?? 0} {(deskCountByRoom.get(TOP_LEVEL) ?? 0) === 1 ? 'desk' : 'desks'}
                    </span>
                  </span>
                </button>
                {rooms.map((r) => {
                  const count = deskCountByRoom.get(r.id) ?? 0
                  const active = navRoom === r.id
                  return (
                    <button
                      key={r.id}
                      // First click selects (fills the desks column); a second
                      // click on the selected room opens it for real.
                      onClick={() => (active ? openDesk(r) : setNavRoom(r.id))}
                      title={active ? 'Open room' : undefined}
                      data-testid={`home-nav-room-${r.id}`}
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left shrink-0 transition-colors ${
                        active ? 'bg-[rgb(var(--accent)/0.10)]' : 'hover:bg-[var(--surface-sunken)]'
                      }`}
                    >
                      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0 ${roomTint(r.id)}`}>
                        <Icon name="folder" size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[12.5px] ${active ? 'text-[var(--ink-100)] font-medium' : 'text-[var(--ink-90)]'}`}>
                          {r.title || 'Untitled room'}
                        </span>
                        <span className="block fb-t-caption text-[var(--ink-45)]">
                          {count} {count === 1 ? 'desk' : 'desks'}
                        </span>
                      </span>
                      {active && (
                        <Icon name="chevron_right" size={14} className="text-[var(--ink-40)] shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Desks column — the room you clicked opens out to the right. */}
              <div className="min-w-0 min-h-0 overflow-y-auto" data-testid="home-desks">
                {navDesks.length === 0 ? (
                  <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">
                    No desks in here yet.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {navDesks.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => openDesk(n)}
                        data-testid={`home-desk-${n.id}`}
                        className="flex items-center gap-2.5 fb-tile-lit fb-press px-2.5 py-2 text-left"
                      >
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500 shrink-0">
                          <Icon name="desk" size={16} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate fb-t-body text-[var(--ink-100)]">
                            {n.title || 'Untitled desk'}
                          </span>
                          <span className="block fb-t-caption">
                            Edited {relTime(n.updatedAt)}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => void onNewDesk()}
                  data-testid="home-desk-new"
                  className="fb-btn-surface mt-2 flex w-full items-center justify-center gap-1.5 border-dashed px-2.5 py-2 fb-t-label text-[var(--ink-60)] hover:text-[rgb(var(--accent))] fb-press transition-colors"
                >
                  <Icon name="add" size={15} />
                  New desk{navRoom !== TOP_LEVEL ? ' in this room' : ''}
                </button>
              </div>
            </div>
          </RailCard>
        )

      case 'continue':
        return (
          <RailCard
            fill
            title="Continue where you left off"
            icon="history"
            tone="accent"
            action={{ label: 'All documents', onClick: () => v.goDocuments() }}
          >
            {recentDocs.length === 0 ? (
              <EmptyState text="Nothing to pick up yet. Create a document and it will wait for you here." />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 auto-rows-fr flex-1 min-h-0 gap-3" data-testid="home-continue">
                {recentDocs.slice(0, size === 'md' ? 2 : 4).map((d) => {
                  const ti = DOC_TYPE_ICON[d.docType] ?? {
                    icon: 'draft',
                    tint: 'text-[var(--ink-40)]',
                    label: 'File'
                  }
                  return (
                    <button
                      key={d.id}
                      onClick={() => v.goDocument(d.id)}
                      data-testid={`home-continue-item-${d.id}`}
                      className="flex items-center gap-3 fb-tile-lit fb-press px-3 py-2.5 text-left"
                    >
                      <Icon name={ti.icon} size={20} className={`${ti.tint} shrink-0`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate fb-t-body text-[var(--ink-100)]">
                          {d.title || 'Untitled'}
                        </span>
                        <span className="block fb-t-caption">
                          {ti.label}, edited {relTime(d.updatedAt)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </RailCard>
        )

      case 'agenda':
        return <AgendaBlock variant="compact" />
      case 'pulse':
        return <AttentionPulseBlock variant="compact" />
      case 'quick':
        return (
          <RailCard title="Quick actions" icon="bolt" tone="emerald" fill>
            <div className={`grid auto-rows-fr flex-1 min-h-0 gap-2 ${size === 'md' ? 'grid-cols-4' : 'grid-cols-2'}`}>
              <QuickAction testid="home-quick-create" icon="add" tone="accent" title="Create" blurb="New document" onClick={() => void onCreate()} />
              <QuickAction testid="home-quick-plan" icon="checklist" tone="sky" title="Plan" blurb="Plans and tasks" onClick={() => v.goPlexiDesk('plans')} />
              <QuickAction testid="home-quick-collaborate" icon="group" tone="emerald" title="Collaborate" blurb="Shared work" onClick={() => v.goCollaborations()} />
              <QuickAction testid="home-quick-automate" icon="bolt" tone="violet" title="Automate" blurb="PlexiBrain flow" onClick={() => v.goPlexiBrain('flows')} />
            </div>
          </RailCard>
        )

      case 'activity':
        return <RecentActivityBlock variant="compact" />
      default:
        return null
    }
  }

  const dragging = drag !== null

  // Stagger only the very first paint: widgets cascade in once, then all
  // later layout changes are pure springs with no artificial delay.
  const firstPaintRef = useRef(true)
  useEffect(() => {
    firstPaintRef.current = false
  }, [])

  // Live grid metrics from the container. The container itself never animates,
  // so this is safe to read mid-drag; cell geometry comes from packGrid, never
  // from measuring (possibly mid-spring) widget DOM.
  const gridMetrics = (): GridMetrics | null => {
    const el = gridRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const subCols = cols * SUBDIV
    return {
      originX: r.left,
      originY: r.top,
      cellW: (r.width - GRID.gap * (subCols - 1)) / subCols,
      cellH: SUBROW_H,
      gap: GRID.gap,
      cols: subCols
    }
  }

  // End a drag: spring the lifted card into its slot (commit) or back into
  // the pre-drag order (cancel), then put the real widget back and persist.
  const settleSpring = reducedMotion ? { duration: 0.12 } : GRID.settleSpring
  const settleDrag = (commit: boolean): void => {
    const info = dragInfoRef.current
    if (!info) return
    dragInfoRef.current = null
    const list = commit ? flatRef.current : info.orig
    if (!commit) {
      flatRef.current = info.orig
      setFlat(info.orig)
    }
    const finish = (): void => {
      setDrag(null)
      if (commit) commitFlat(list)
    }
    const m = gridMetrics()
    const pos = m ? packGrid(list, m.cols).get(info.key) : undefined
    if (!m || !pos) {
      finish()
      return
    }
    setDrag({ key: info.key, settling: true })
    const r = cellRect(pos, info.size, m)
    void Promise.all([
      animate(dragX, r.left, settleSpring),
      animate(dragY, r.top, settleSpring),
      animate(dragScale, 1, settleSpring)
    ]).then(finish)
  }
  cancelDragRef.current = () => settleDrag(false)

  // Press on a card in customize mode. Below the activation distance it is a
  // click (swap selection, via onClick); beyond it the card lifts and follows
  // the pointer while the board reflows live underneath.
  const beginCardDrag = (e: React.PointerEvent<HTMLDivElement>, inst: SizedInstance): void => {
    if (!customize || drag || e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    const card = e.currentTarget
    const startX = e.clientX
    const startY = e.clientY
    movedRef.current = false

    const onMove = (ev: PointerEvent): void => {
      let info = dragInfoRef.current
      if (!info) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < GRID.dragActivationPx) return
        // Lift: freeze the card's rect, remember where inside it we grabbed.
        const r = card.getBoundingClientRect()
        movedRef.current = true
        info = {
          key: inst.key,
          size: inst.size,
          grabDX: startX - r.left,
          grabDY: startY - r.top,
          width: r.width,
          height: r.height,
          orig: flatRef.current,
          lastCell: null
        }
        dragInfoRef.current = info
        dragX.set(r.left)
        dragY.set(r.top)
        dragScale.set(1)
        void animate(dragScale, GRID.liftScale, settleSpring)
        setSwapKey(null)
        setDrag({ key: inst.key, settling: false })
      }
      dragX.set(ev.clientX - info.grabDX)
      dragY.set(ev.clientY - info.grabDY)
      const m = gridMetrics()
      if (!m) return
      // Retarget only when the pointer crosses into a new cell — the
      // hysteresis that keeps cell boundaries from jittering.
      const cell = pointerCell(ev.clientX, ev.clientY, m)
      if (info.lastCell && info.lastCell.col === cell.col && info.lastCell.row === cell.row) return
      info.lastCell = cell
      const cur = flatRef.current
      const draggedInst = cur.find((it) => it.key === info.key)
      if (!draggedInst) return
      const others = cur.filter((it) => it.key !== info.key)
      const idx = bestInsertionIndex(others, draggedInst, ev.clientX, ev.clientY, m)
      if (idx === cur.indexOf(draggedInst)) return
      const next = [...others.slice(0, idx), draggedInst, ...others.slice(idx)]
      flatRef.current = next
      setFlat(next)
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    const onUp = (): void => {
      cleanup()
      if (dragInfoRef.current) settleDrag(true)
    }
    const onCancel = (): void => {
      cleanup()
      if (dragInfoRef.current) settleDrag(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  const positions = useMemo(() => packGrid(flat, cols * SUBDIV), [flat, cols])
  const liftedInst = drag
    ? (flat.find((it) => it.key === drag.key) ??
      dragInfoRef.current?.orig.find((it) => it.key === drag.key) ??
      null)
    : null

  // The widget board: one packed grid. Cells take explicit positions from
  // packGrid, so the springs animate between spots the drag math already
  // agreed on.
  const renderGrid = (): JSX.Element => (
    <div
      ref={gridRef}
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${cols * SUBDIV}, minmax(0, 1fr))`,
        gridAutoRows: `${SUBROW_H}px`,
        gap: GRID.gap
      }}
      aria-label="Home widgets"
      data-testid="home-widget-grid"
    >
      <AnimatePresence>
        {flat.map((inst, i) => {
          const def = widgetDef(inst.widget)
          const selected = swapKey === inst.key
          const span = SIZE_SPAN[inst.size]
          const pos = positions.get(inst.key)
          const lifted = drag?.key === inst.key
          const isNew = justPlaced === inst.key
          const mountDelay = firstPaintRef.current ? i * 0.045 : 0
          return (
            <motion.div
              key={inst.key}
              layout
              initial={isNew ? { opacity: 0, scale: 0.72 } : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
              transition={{
                layout: reducedMotion ? { duration: 0.12 } : GRID.reflowSpring,
                opacity: { duration: 0.25, delay: reducedMotion ? 0 : mountDelay },
                scale: reducedMotion ? { duration: 0.12 } : { type: 'spring', stiffness: 340, damping: 26 },
                y: reducedMotion
                  ? { duration: 0.12 }
                  : { type: 'spring', stiffness: 420, damping: 34, delay: mountDelay }
              }}
              style={{
                gridColumn: `${(pos?.col ?? 0) + 1} / span ${Math.min(span.w, cols * SUBDIV)}`,
                gridRow: `${(pos?.row ?? 0) + 1} / span ${span.h}`
              }}
              className="relative group/slot min-w-0"
              data-widget-key={inst.key}
              data-widget-kind={inst.widget}
              onPointerDown={(e) => beginCardDrag(e, inst)}
            >
              {lifted ? (
                /* The gap: a soft slot marking exactly where the widget lands. */
                <div className="h-full rounded-2xl bg-[var(--surface-sunken)] ring-1 ring-inset ring-[var(--edge-soft)] opacity-70" />
              ) : (
                <>
                  <div
                    onClick={
                      customize
                        ? () => {
                            if (movedRef.current) {
                              movedRef.current = false
                              return
                            }
                            // Selecting a widget arms the swap; the picker
                            // honours it (Replace X) when opened via Add
                            // widget. It never opens itself: rearranging
                            // stays unblocked.
                            setSwapKey(selected ? null : inst.key)
                          }
                        : undefined
                    }
                    className={`h-full transition-all rounded-2xl ${
                      isNew ? 'ring-2 ring-[rgb(var(--accent))] shadow-[0_0_36px_rgb(var(--accent)/0.45)]' : ''
                    } ${
                      customize || dragging
                        ? `${customize ? 'cursor-pointer' : ''} scale-[0.985] ${
                            selected
                              ? 'ring-2 ring-[rgb(var(--accent))] shadow-[0_0_24px_rgb(var(--accent)/0.35)]'
                              : isNew
                                ? ''
                                : 'ring-2 ring-[rgb(var(--accent)/0.35)] shadow-[0_0_16px_rgb(var(--accent)/0.15)]'
                          }`
                        : ''
                    }`}
                  >
                    {/* In customize mode the widget is a target, not a control.
                        The tile owns the material: fb-widget-tile is the glass
                        + depth surface, [&>*]:h-full makes the widget fill its
                        cell, and the !bg/!shadow/!border overrides strip each
                        widget's own card chrome so nothing double-stacks. */}
                    <div
                      className={`h-full overflow-y-auto overflow-x-hidden rounded-2xl fb-widget-tile [&>*]:h-full [&>*]:!bg-transparent [&>*]:!shadow-none [&>*]:!border-0 ${customize ? 'pointer-events-none select-none' : ''}`}
                    >
                      {renderWidget(inst)}
                    </div>
                  </div>
                  {/* Customize chrome: size cycle, edit for configurable
                      widgets, remove. */}
                  {customize && (
                    <div className="absolute -top-2 -right-2 flex items-center gap-1">
                      {def.sizes.length > 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            const next = def.sizes[(def.sizes.indexOf(inst.size) + 1) % def.sizes.length]
                            commitFlat(flatRef.current.map((it) => (it.key === inst.key ? { ...it, size: next } : it)))
                          }}
                          title={`Size: ${inst.size}. Click for the next size`}
                          aria-label={`Change size of ${def.name}, currently ${inst.size}`}
                          data-testid={`home-slot-size-${inst.key}`}
                          className="h-6 px-1.5 rounded-full inline-flex items-center gap-0.5 bg-[var(--surface-raised)] text-[var(--ink-60)] hover:text-[var(--ink-100)] shadow"
                        >
                          <Icon name="open_in_full" size={11} />
                          <span className="text-[9.5px] font-semibold uppercase tracking-wide">{inst.size}</span>
                        </button>
                      )}
                      {def.config && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            editInstance(inst.key)
                          }}
                          title={`Edit ${def.name}`}
                          aria-label={`Edit ${def.name}`}
                          data-testid={`home-slot-edit-${inst.key}`}
                          className="h-6 w-6 rounded-full inline-flex items-center justify-center bg-[var(--surface-raised)] text-[var(--ink-60)] hover:text-[var(--ink-100)] shadow"
                        >
                          <Icon name="edit" size={12} />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          removeInstance(inst.key)
                        }}
                        title={`Remove ${def.name}`}
                        aria-label={`Remove ${def.name}`}
                        data-testid={`home-slot-remove-${inst.key}`}
                        className="h-6 w-6 rounded-full inline-flex items-center justify-center bg-[var(--surface-raised)] text-[var(--ink-60)] hover:text-rose-500 shadow"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  )}
                </>
              )}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )

  return (
    // paper-texture, deliberately NOT desk-paper: the dashboard gets the same
    // dot/grid paper as desks but skips desk-paper's custom-background
    // override and time-of-day overlay, which caused the mid-screen seam and
    // the light-background-in-dark-mode bug.
    <div className="relative h-full w-full text-[var(--ink-100)]" data-testid="home-dashboard">
      {/* No floating chrome on Home — Caleb removed the Home/Desks pill
          (2026-08-21); the sidebar carries navigation. */}
      <div className="h-full w-full overflow-auto paper-texture">
      {/* Wide board: the page uses the room it has instead of pooling empty
          margin left and right (Caleb's spacing ruling, 2026-08-21). */}
      <div className="max-w-[1440px] mx-auto px-8 pb-8 pt-8">
        {/* Greeting + focus-mode toggle. In customize (placement) mode the
            greeting and the non-editing controls recede behind a soft blur:
            the board is live, everything else steps back. */}
        <header className="flex items-start justify-between gap-4 flex-wrap mb-6">
          <motion.div
            animate={customize ? { opacity: 0.4, filter: 'blur(2px)' } : { opacity: 1, filter: 'blur(0px)' }}
            transition={{ duration: 0.25 }}
            className={`min-w-0 ${customize ? 'pointer-events-none select-none' : ''}`}
          >
            <h1
              className="fb-display-hero text-[24px] leading-tight text-[var(--ink-100)]"
              data-testid="home-greeting"
            >
              {timeOfDay(now)}, {name}
            </h1>
            <p className="mt-1 text-[13px] text-[var(--ink-50)]">
              Here is your workspace and what is happening across it.
            </p>
          </motion.div>
          <div className="flex items-center gap-2">
            {customize && !flatIsStock(surface, flat) && (
              <button
                onClick={resetLayout}
                data-testid="home-layout-reset"
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] text-[var(--ink-50)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
              >
                <Icon name="restart_alt" size={15} />
                Reset layout
              </button>
            )}
            {customize && (
              <button
                onClick={() => setGallery(true)}
                data-testid="home-add-widget"
                className="inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-80)]"
              >
                <Icon name="add" size={16} />
                Add widget
              </button>
            )}
            <button
              onClick={() => setWizard(true)}
              data-testid="home-wizard-open"
              title="Answer a few questions and let Plexii arrange this dashboard"
              className="inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-80)]"
            >
              <Icon name="auto_awesome" size={16} />
              Set up with Plexii
            </button>
            <button
              onClick={() => {
                if (customize) {
                  setCustomize(false)
                  setSwapKey(null)
                  setGallery(false)
                } else {
                  // Customize lands in edit mode: outlines, drag, size,
                  // remove. Adding is a deliberate second step via the Add
                  // widget button (Caleb's ruling, 2026-08-21).
                  setCustomize(true)
                }
              }}
              data-testid="home-customize-toggle"
              className={`inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-press ${
                customize
                  ? 'rounded-[10px] bg-[rgb(var(--accent))] text-white shadow-[0_1px_2px_rgb(var(--accent)/0.25),0_4px_12px_-2px_rgb(var(--accent)/0.30)]'
                  : 'fb-btn-surface text-[var(--ink-80)]'
              }`}
            >
              <Icon name={customize ? 'check' : 'dashboard_customize'} size={16} />
              {customize ? 'Done' : 'Customize'}
            </button>
            <motion.div
              animate={customize ? { opacity: 0.4, filter: 'blur(2px)' } : { opacity: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.25 }}
              className={`flex items-center gap-2 ${customize ? 'pointer-events-none select-none' : ''}`}
            >
            {/* The header's Ask Plexii door was removed on Caleb's ruling
                (2026-08-24): the omnibar's Ask Plexii pill is the one door
                from home, and a second button beside Customize duplicated it. */}
            <button
              onClick={() => void toggleFocus()}
              data-testid="home-focus-toggle"
              className={`inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-press ${
                focusActive
                  ? 'rounded-[10px] bg-violet-500/15 text-violet-500 shadow-[0_0_0_1px_rgb(139_92_246/0.35)]'
                  : 'fb-btn-surface text-[var(--ink-80)]'
              }`}
            >
              <Icon name={focusActive ? 'stop_circle' : 'bolt'} size={16} />
              {focusActive ? 'End focus mode' : 'Focus mode'}
            </button>
            </motion.div>
          </div>
        </header>

        {/* Hero — describe a goal, get a real desk with AI-proposed widgets and
            the assistant beside it (spec §4.1). Fixed position: this is the one
            piece of home that is not a re-slottable widget. Recedes with the
            rest of the page chrome in placement mode. */}
        <motion.div
          animate={customize ? { opacity: 0.4, filter: 'blur(2px)' } : { opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.25 }}
          className={customize ? 'pointer-events-none select-none' : ''}
        >
          <StartOrAskPlexi />
        </motion.div>

        {/* The widget board. In customize mode, press and move any card to
            lift it; the board reflows live underneath. */}
        {renderGrid()}
      </div>

      {/* The lifted card: rides the pointer via motion values in a body
          portal, springs into its slot on release. */}
      {drag && liftedInst && dragInfoRef.current !== null && (
        createPortal(
          <motion.div
            style={{
              x: dragX,
              y: dragY,
              scale: dragScale,
              width: dragInfoRef.current.width,
              height: dragInfoRef.current.height
            }}
            className="fixed left-0 top-0 z-[100] pointer-events-none"
            data-testid="home-drag-lift"
          >
            <div className="h-full overflow-hidden rounded-2xl fb-widget-tile [&>*]:h-full [&>*]:!bg-transparent [&>*]:!shadow-none [&>*]:!border-0 !shadow-[0_24px_60px_rgba(0,0,0,0.30),0_0_0_1px_rgba(0,0,0,0.06)]">
              {renderWidget(liftedInst)}
            </div>
          </motion.div>,
          document.body
        )
      )}

      {/* The center-screen picker: home blurred behind, live per-size
          previews of the real widgets inside. */}
      <AnimatePresence>
        {gallery && (
          <WidgetPickerOverlay
            surface={surface}
            isPlaced={isPlaced}
            swapTarget={swapKey ? findInstance(swapKey) : null}
            cellW={gridMetrics()?.cellW ?? 132}
            cellH={SUBROW_H}
            gap={GRID.gap}
            renderPreview={renderWidget}
            requestConfig={(id, apply) => {
              const def = widgetDef(id)
              if (!def.config) {
                apply(undefined)
                return
              }
              setPicker({ widget: id, kind: def.config, apply })
            }}
            onAdd={(id, size, config) => {
              placeWidget(id, size, config)
              setGallery(false)
            }}
            onSwap={(id) => {
              if (swapKey) swapWidget(swapKey, id)
              setGallery(false)
            }}
            onClearSwap={() => setSwapKey(null)}
            onClose={() => setGallery(false)}
          />
        )}
      </AnimatePresence>

      {/* The configuration wizard. Its preview renders the real widgets through
          the same renderer the board uses, so what it shows is what applying it
          produces -- not a mockup of it. */}
      <AnimatePresence>
        {wizard && (
          <DashboardWizardOverlay
            surface={surface}
            renderPreview={renderWidget}
            cellW={gridMetrics()?.cellW ?? 132}
            cellH={SUBROW_H}
            gap={GRID.gap}
            cols={cols * SUBDIV}
            onApply={(instances) => {
              commitFlat(instances)
              setWizard(false)
              setSwapKey(null)
            }}
            onClose={() => setWizard(false)}
          />
        )}
      </AnimatePresence>

      {/* The two embed pickers run their own flows (desk then object, or a
          document list), so they are separate components rather than two more
          branches in an already-crowded conditional. */}
      {picker?.kind === 'desk-widget' && (
        <DeskWidgetPicker
          onCancel={() => setPicker(null)}
          onConfirm={(cfg) => {
            picker.apply(cfg)
            setPicker(null)
          }}
        />
      )}
      {picker?.kind === 'document' && (
        <DocumentPicker
          onCancel={() => setPicker(null)}
          onConfirm={(cfg) => {
            picker.apply(cfg)
            setPicker(null)
          }}
        />
      )}
      {picker && picker.kind !== 'desk-widget' && picker.kind !== 'document' && (
        <WidgetConfigPicker
          widget={picker.widget}
          kind={picker.kind}
          initial={picker.initial}
          onCancel={() => setPicker(null)}
          onConfirm={(config) => {
            picker.apply(config)
            setPicker(null)
          }}
        />
      )}
      </div>
    </div>
  )
}

// ── The widget picker ────────────────────────────────────────────────────────
// Apple's widget-editing rhythm: a centered glass panel over the blurred home
// page. Browse by category or search; choosing a widget slides to its detail
// page, where every size it supports renders as a LIVE preview of the real
// widget (config collected first so previews show real content); Add drops
// back into placement mode. With a placed widget selected, the picker offers
// replacements instead.

const SIZE_LABEL: Record<WidgetSize, string> = {
  icon: 'Icon',
  sm: 'Small',
  md: 'Medium',
  lg: 'Large',
  stack: 'Stack'
}

function WidgetPickerOverlay({
  isPlaced,
  swapTarget,
  cellW,
  cellH,
  gap,
  renderPreview,
  requestConfig,
  onAdd,
  onSwap,
  onClearSwap,
  onClose,
  surface
}: {
  isPlaced: (id: HomeWidgetId) => boolean
  swapTarget: SizedInstance | null
  cellW: number
  cellH: number
  gap: number
  renderPreview: (inst: SizedInstance) => JSX.Element | null
  requestConfig: (id: HomeWidgetId, apply: (config?: HomeWidgetConfig) => void) => void
  onAdd: (id: HomeWidgetId, size: WidgetSize, config?: HomeWidgetConfig) => void
  onSwap: (id: HomeWidgetId) => void
  onClearSwap: () => void
  onClose: () => void
  surface: DashboardSurface
}): JSX.Element {
  const CATEGORIES = ['All', 'Navigation', 'Live', 'Smart', 'Actions', 'Communication'] as const
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('All')
  const [search, setSearch] = useState('')
  // The detail page: one widget, its config already collected, a size chosen.
  const [detail, setDetail] = useState<{ id: HomeWidgetId; config?: HomeWidgetConfig } | null>(null)
  const [sizeIx, setSizeIx] = useState(0)

  const q = search.trim().toLowerCase()
  const visible = HOME_WIDGET_DEFS.filter((d) => {
    if (d.retired) return false
    // A def with no `surfaces` belongs everywhere; one that names them is
    // offered only on those dashboards.
    if (d.surfaces && !d.surfaces.includes(surface)) return false
    if (category !== 'All' && d.category !== category) return false
    if (q && !`${d.name} ${d.blurb}`.toLowerCase().includes(q)) return false
    return true
  })

  const openDetail = (id: HomeWidgetId, config?: HomeWidgetConfig): void => {
    setDetail({ id, config })
    const def = widgetDef(id)
    setSizeIx(Math.max(0, def.sizes.indexOf(def.defaultSize)))
  }

  const pick = (id: HomeWidgetId): void => {
    if (swapTarget) {
      onSwap(id)
      return
    }
    const def = widgetDef(id)
    if (def.config) requestConfig(id, (config) => openDetail(id, config))
    else openDetail(id)
  }

  const def = detail ? widgetDef(detail.id) : null
  const size = def ? def.sizes[Math.min(sizeIx, def.sizes.length - 1)] : 'sm'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[80] flex items-center justify-center p-6"
      data-testid="home-widget-gallery"
    >
      {/* Scrim: home stays visible but recedes behind the blur. */}
      <div
        className="fb-scrim absolute inset-0"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.8 }}
        className="relative w-[720px] max-w-[94vw] max-h-[min(660px,88vh)] flex flex-col rounded-2xl fb-glass-panel ring-1 ring-black/[0.10] dark:ring-white/[0.10] overflow-hidden"
      >
        {def && detail ? (
          /* ── Detail: live previews at every size ── */
          <>
            <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-[var(--edge-soft)] shrink-0">
              <button
                onClick={() => setDetail(null)}
                data-testid="home-picker-back"
                title="Back to all widgets"
                className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors shrink-0"
              >
                <Icon name="arrow_back" size={17} />
              </button>
              <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg shrink-0 ${def.tint}`}>
                <Icon name={def.icon} size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold text-[var(--ink-100)] truncate">{def.name}</div>
                <div className="fb-t-caption truncate">{def.blurb}</div>
              </div>
              <button
                onClick={onClose}
                title="Close"
                className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors shrink-0"
              >
                <Icon name="close" size={17} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-6 flex flex-col items-center justify-center gap-5">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setSizeIx((i) => Math.max(0, i - 1))}
                  disabled={sizeIx === 0}
                  aria-label="Previous size"
                  className="h-9 w-9 rounded-full inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
                >
                  <Icon name="chevron_left" size={20} />
                </button>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={size}
                    initial={{ opacity: 0, x: 26, scale: 0.98 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: -26, scale: 0.98 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.8 }}
                    className="[filter:drop-shadow(0_16px_32px_rgba(0,0,0,0.18))]"
                  >
                    <SizePreview size={size} cellW={cellW} cellH={cellH} gap={gap}>
                      {renderPreview({ key: `preview:${detail.id}`, widget: detail.id, config: detail.config, size })}
                    </SizePreview>
                  </motion.div>
                </AnimatePresence>
                <button
                  onClick={() => setSizeIx((i) => Math.min(def.sizes.length - 1, i + 1))}
                  disabled={sizeIx >= def.sizes.length - 1}
                  aria-label="Next size"
                  className="h-9 w-9 rounded-full inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
                >
                  <Icon name="chevron_right" size={20} />
                </button>
              </div>

              {/* Size dots + label, Apple's pager */}
              {def.sizes.length > 1 && (
                <div className="flex items-center gap-2">
                  {def.sizes.map((s, i) => (
                    <button
                      key={s}
                      onClick={() => setSizeIx(i)}
                      aria-label={`${SIZE_LABEL[s]} size`}
                      data-testid={`home-picker-size-${s}`}
                      className={`h-2 w-2 rounded-full transition-colors ${
                        i === sizeIx ? 'bg-[rgb(var(--accent))]' : 'bg-[var(--ink-30)] hover:bg-[var(--ink-50)]'
                      }`}
                    />
                  ))}
                </div>
              )}
              <div className="fb-t-caption fb-tabular">{SIZE_LABEL[size]}</div>
            </div>

            <div className="px-5 py-4 border-t border-[var(--edge-soft)] flex justify-center shrink-0">
              <button
                onClick={() => onAdd(detail.id, size, detail.config)}
                data-testid="home-picker-add"
                className="inline-flex items-center justify-center gap-2 h-10 w-[240px] rounded-[10px] bg-[rgb(var(--accent))] text-white text-[13px] font-medium fb-press shadow-[0_1px_2px_rgb(var(--accent)/0.25),0_4px_12px_-2px_rgb(var(--accent)/0.30)] hover:bg-[rgb(var(--accent-hover))]"
              >
                <Icon name="add" size={16} />
                Add widget
              </button>
            </div>
          </>
        ) : (
          /* ── Browse: search, categories, the catalog ── */
          <>
            <div className="px-5 pt-4 pb-3 border-b border-[var(--edge-soft)] shrink-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[15px] font-semibold text-[var(--ink-100)] flex-1 min-w-0 truncate">
                  {swapTarget ? `Replace ${widgetDef(swapTarget.widget).name}` : 'Widgets'}
                </span>
                <button
                  onClick={onClose}
                  data-testid="home-widget-gallery-done"
                  className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-medium bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))]"
                >
                  <Icon name="check" size={14} />
                  Done
                </button>
              </div>
              {swapTarget ? (
                <div className="fb-t-caption">
                  Pick its replacement below, or{' '}
                  <button onClick={onClearSwap} className="text-[rgb(var(--accent))] underline-offset-2 hover:underline">
                    cancel the swap
                  </button>
                  .
                </div>
              ) : (
                <div className="fb-t-caption">Pick a widget, choose its size, then drag it into place.</div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <div className="relative flex-1">
                  <Icon name="search" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-40)]" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search widgets"
                    className="fb-field h-8 w-full pl-8 pr-2 text-[12px] text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
                  />
                </div>
                <div className="flex gap-1">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCategory(c)}
                      className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${
                        category === c
                          ? 'bg-[rgb(var(--accent))] text-white'
                          : 'bg-[var(--surface-sunken)] text-[var(--ink-60)] hover:text-[var(--ink-100)]'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {visible.map((d) => {
                  const placed = !d.multi && isPlaced(d.id)
                  const blocked = placed && !swapTarget
                  return (
                    <button
                      key={d.id}
                      onClick={() => !blocked && pick(d.id)}
                      disabled={blocked}
                      data-testid={`home-gallery-${d.id}`}
                      title={d.blurb}
                      className={`rounded-xl border p-3 text-left transition-colors ${
                        blocked
                          ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 cursor-default'
                          : 'border-transparent fb-tile-lit fb-press'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg shrink-0 ${d.tint}`}>
                          <Icon name={d.icon} size={15} />
                        </span>
                        <span className="fb-t-label font-semibold text-[var(--ink-100)] truncate">{d.name}</span>
                        {placed && (
                          <Icon name="check_circle" size={13} filled className="ml-auto text-emerald-600 dark:text-emerald-500 shrink-0" />
                        )}
                      </div>
                      <div className="fb-t-caption leading-snug line-clamp-2">
                        {placed && !swapTarget ? 'Already on your home' : d.blurb}
                      </div>
                    </button>
                  )
                })}
              </div>
              {visible.length === 0 && (
                <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">No widgets match.</p>
              )}
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}

// A live widget preview at its true grid footprint, scaled to fit the picker.
// The real component renders at real cell dimensions inside a scale transform,
// so the preview is exactly what lands on the board.
function SizePreview({
  size,
  cellW,
  cellH,
  gap,
  children
}: {
  size: WidgetSize
  cellW: number
  cellH: number
  gap: number
  children: ReactNode
}): JSX.Element {
  const span = SIZE_SPAN[size]
  const w = span.w * cellW + (span.w - 1) * gap
  const h = span.h * cellH + (span.h - 1) * gap
  const s = Math.min(1, 430 / w, 290 / h)
  return (
    <div style={{ width: w * s, height: h * s }} className="relative">
      <div
        style={{ width: w, height: h, transform: `scale(${s})`, transformOrigin: 'top left' }}
        className="absolute left-0 top-0 pointer-events-none select-none overflow-hidden rounded-2xl fb-widget-tile [&>*]:h-full [&>*]:!bg-transparent [&>*]:!shadow-none [&>*]:!border-0"
      >
        {children}
      </div>
    </div>
  )
}

// Skeleton loading — placeholder bars in the shape of the content, so a
// widget's data arriving feels like focus resolving, never like a fetch.

// ── Customize mode: config pickers ───────────────────────────────────────────
// Small choosers for the widgets that need a subject: which desk to pin, which
// room to open, which person or conversation to pin. (The links chooser retired
// with Quick links; Shortcuts carries its own composer.)
function WidgetConfigPicker({
  widget,
  kind,
  onCancel,
  onConfirm
}: {
  widget: HomeWidgetId
  kind: 'desk' | 'room' | 'conversation' | 'desk-widget' | 'document'
  initial?: HomeWidgetConfig
  onCancel: () => void
  onConfirm: (config: HomeWidgetConfig) => void
}): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const conversations = useMessagingStore((s) => s.conversations)
  const selfId = useAccountStore((s) => s.account?.id ?? null)
  const presencePeers = usePresenceStore((s) => s.peers)
  const presenceEnabled = useCapabilityEnabled('presence')
  const [query, setQuery] = useState('')

  const def = widgetDef(widget)
  const q = query.trim().toLowerCase()
  const candidates =
    kind === 'conversation'
      ? []
      : nodes
          .filter((n) => !n.archived && (kind === 'desk' ? n.kind === 'task' : n.kind === 'folder'))
          .filter((n) => !q || (n.title || '').toLowerCase().includes(q))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 30)

  // Conversation mode: people online now (presence-gated), then conversations.
  const people =
    kind === 'conversation' && presenceEnabled
      ? Object.values(presencePeers)
          .filter((p) => !q || personDisplayName(p, p.handle).toLowerCase().includes(q))
          .slice(0, 10)
      : []
  const convs =
    kind === 'conversation'
      ? conversations
          .filter((c) => !q || conversationName(c, selfId).toLowerCase().includes(q))
          .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
          .slice(0, 20)
      : []

  return (
    <Modal
      onClose={onCancel}
      label={`Set up ${def.name}`}
      z={260}
      className="fb-glass-pillow rounded-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[70vh]"
      testId="home-widget-config"
    >
      <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center gap-2">
        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${def.tint}`}>
          <Icon name={def.icon} size={15} />
        </span>
        <span className="text-[13.5px] font-semibold text-[var(--ink-100)]">
          {kind === 'desk' ? 'Pin which desk?' : kind === 'room' ? 'Open which room?' : 'Pin who, or which chat?'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            kind === 'desk' ? 'Search desks…' : kind === 'room' ? 'Search rooms…' : 'Search people and conversations…'
          }
          className="fb-field w-full mb-2 px-3 py-2 fb-t-body text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
        />
        {kind === 'conversation' ? (
          people.length === 0 && convs.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">
              {conversations.length === 0
                ? 'No conversations yet. Start one in Messages and pin it here.'
                : 'Nothing matches.'}
            </p>
          ) : (
            <div className="space-y-2">
              {people.length > 0 && (
                <div>
                  <p className="px-1 mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--ink-40)]">
                    Online now
                  </p>
                  <div className="space-y-0.5">
                    {people.map((p) => (
                      <button
                        key={p.accountId}
                        onClick={() =>
                          onConfirm({
                            personId: p.accountId,
                            personHandle: p.handle,
                            personName: personDisplayName(p, p.handle)
                          })
                        }
                        data-testid={`home-widget-config-person-${p.accountId}`}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-sunken)] transition-colors"
                      >
                        <Icon name="account_circle" size={15} className="text-[var(--ink-50)] shrink-0" />
                        <span className="flex-1 min-w-0 truncate fb-t-body text-[var(--ink-100)]">
                          {personDisplayName(p, p.handle)}
                        </span>
                        <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {convs.length > 0 && (
                <div>
                  <p className="px-1 mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--ink-40)]">
                    Conversations
                  </p>
                  <div className="space-y-0.5">
                    {convs.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => onConfirm({ conversationId: c.id })}
                        data-testid={`home-widget-config-conv-${c.id}`}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-sunken)] transition-colors"
                      >
                        <Icon name="plexii:chat" size={15} className="text-[var(--ink-50)] shrink-0" />
                        <span className="flex-1 min-w-0 truncate fb-t-body text-[var(--ink-100)]">
                          {conversationName(c, selfId)}
                        </span>
                        {c.unreadCount > 0 && (
                          <span className="shrink-0 text-[10.5px] font-semibold text-accent fb-tabular">
                            {c.unreadCount}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        ) : candidates.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-[var(--ink-50)]">
            {kind === 'desk' ? 'No desks match.' : 'No rooms match.'}
          </p>
        ) : (
          <div className="space-y-0.5">
            {candidates.map((n) => (
              <button
                key={n.id}
                onClick={() => onConfirm(kind === 'desk' ? { deskId: n.id } : { roomId: n.id })}
                data-testid={`home-widget-config-item-${n.id}`}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-sunken)] transition-colors"
              >
                <Icon
                  name={kind === 'desk' ? 'desk' : 'folder'}
                  size={15}
                  className="text-[var(--ink-50)] shrink-0"
                />
                <span className="flex-1 min-w-0 truncate fb-t-body text-[var(--ink-100)]">
                  {n.title || (kind === 'desk' ? 'Untitled desk' : 'Untitled room')}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex justify-end gap-2">
        <button onClick={onCancel} className="btn-ghost">
          Cancel
        </button>
      </div>
    </Modal>
  )
}

function EmptyState({ text }: { text: string }): JSX.Element {
  return <p className="my-auto py-4 text-center text-[12px] text-[var(--ink-50)]">{text}</p>
}

function QuickAction({
  testid,
  icon,
  tone,
  title,
  blurb,
  onClick
}: {
  testid: string
  icon: string
  tone: 'accent' | 'sky' | 'emerald' | 'violet'
  title: string
  blurb: string
  onClick: () => void
}): JSX.Element {
  const chip =
    tone === 'accent'
      ? 'bg-accent/10 text-accent'
      : tone === 'sky'
        ? 'bg-sky-500/10 text-sky-500'
        : tone === 'emerald'
          ? 'bg-emerald-500/10 text-emerald-500'
          : 'bg-violet-500/10 text-violet-500'
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className="flex items-center gap-2.5 fb-tile-lit fb-press px-2.5 py-2 text-left"
    >
      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg shrink-0 ${chip}`}>
        <Icon name={icon} size={15} />
      </span>
      <span className="min-w-0">
        <span className="block fb-t-label font-semibold text-[var(--ink-100)] truncate">{title}</span>
        <span className="block fb-t-caption truncate">{blurb}</span>
      </span>
    </button>
  )
}
