import { patternOffset, patternScale } from '../lib/deskPattern'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { effectiveShortcutToKind } from '../lib/keymap'
import { quickAddAllowed, deepActiveElement } from '../lib/quickAddFocus'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import { useMessagingStore } from '../stores/messaging'
import { useConnectedAppsStore } from '../stores/connectedApps'
import { CONNECTED_APP_DRAG_MIME } from './Sidebar'
import DeskPresenceBar from './DeskPresenceBar'
import OfficeDocAddDialog from './widgets/OfficeDocAddDialog'
import WidgetFocusMode from './WidgetFocusMode'
import ExtensionPrompt from './ExtensionPrompt'
import AISetupDialog from './AISetupDialog'
import SaveTemplateDialog from './SaveTemplateDialog'
import AiBuilderDialog from './AiBuilderDialog'
import ViewSelector from './views/ViewSelector'
import type { AiBuildSuggestion } from '@shared/types'
import CanvasContextMenu, { type CtxMenuItem } from './CanvasContextMenu'
import AiAssistPreview from './contextMenu/AiAssistPreview'
import WidgetSetupPreview from './contextMenu/WidgetSetupPreview'
import BrowserContextMenu from './contextMenu/BrowserContextMenu'
// Side-effect import registers the core widget context-action providers (sticky
// checklist, living-doc regenerate, ...) for the unified context menu.
import '../lib/contextMenu'
import FloatingToolbar, { type ToolbarAction } from './FloatingToolbar'
import CanvasMinimapFAB from './CanvasMinimapFAB'
import AutomationsFAB from './AutomationsFAB'
import DeskSuggestionChip from './DeskSuggestionChip'
import DeskGallery from './DeskGallery'
import ColumnsView from './ColumnsView'
import DeskDataViews, { type DataLayout } from './views/DeskDataViews'
import { useDeskViewStore } from '../stores/deskView'
import ZoomControls from './ZoomControls'
import CanvasEdgeIndicators from './CanvasEdgeIndicators'
import { useEdgePan } from '../lib/useEdgePan'
import { useOverlayStore, selectAnyMenuOpen } from '../stores/overlay'
import { useNavPrefs, frictionFromGlide } from '../lib/navPrefs'
import { launchMeeting } from '../lib/startMeeting'
import Icon from './Icon'
import { useChatStore } from '../stores/chat'
import { useFocusSessionStore } from '../stores/focusSession'
import { chimeIn, futuristicPowerOn, sonarPing } from '../lib/audioBeep'
import type { WidgetSuggestion } from '@shared/types'
import {
  CATEGORIES,
  DRAG_MIME,
  WIDGET_CATALOG,
  catalogFor,
  entriesByCategory,
  isAdvancedKind,
  type WidgetCatalogEntry,
  type WidgetCategory
} from '../lib/widgetCatalog'
import { canCreateWidget } from '../lib/gating'
import { useCapabilityStore } from '../stores/capabilities'
import { promptUpgrade } from '../stores/upgradePrompt'
import { useActionHistory } from '../stores/actionHistory'
import { computeAlign, computeDistribute, type AlignMode, type DistributeAxis } from '../lib/canvasAlign'
import {
  computeSectionFrame,
  computeLayoutCells,
  effectiveLayout,
  SECTION_PADDING,
  SECTION_MIN_W,
  SECTION_MIN_H
} from '../lib/sectionGeometry'
import { spawnPositionFor } from '../lib/spawnPosition'
import { firstHttpUrl } from '../lib/dropUrl'
import { lookupWebview } from '../lib/webviewRegistry'
import {
  getOrigin,
  subscribeOrigins,
  isKitDismissed,
  dismissKit,
  type NodeCanvasOrigin
} from '../lib/nodeCanvasOrigin'
import MindmapStartingKit from './MindmapStartingKit'
import SyncWidgetPicker from './SyncWidgetPicker'
import HistoryPanel from './HistoryPanel'
import ResumeModal from './ResumeModal'
import CanvasBreadcrumb from './CanvasBreadcrumb'
import ContextHealthStrip from './ContextHealthStrip'
import CanvasLinearView from './CanvasLinearView'
import FloatingPill from './FloatingPill'
import { useFreeDesk } from '../hooks/useFreeDesk'
import type { StandardApp } from '../lib/standardApps'
import {
  PinLayoutContext,
  computeZonePinPositions,
  type ChromeInsets
} from '../lib/pinLayout'
import {
  AI_RAIL_BUTTON_SIZE,
  AI_RAIL_WIDTH,
  useAIRailCollapsed
} from '../lib/chromeState'
import LinkOverlay, { type PendingLinkPick } from './LinkOverlay'
import { tidyPositions, type TidyOptions } from '../lib/autoArrange'
import { useLinksStore } from '../stores/links'
import { useAccountStore } from '../stores/account'
import { currentDeviceClass } from '../lib/deviceClass'
import { serializeOverlayObjects } from '../lib/deskLayoutOverlay'
import { useContextHealthStore } from '../stores/contextHealth'
import { LinkDragContext } from '../lib/linkDragContext'
import { computeVisibleObjectIds, type VirtualizationBox } from '../lib/canvasVirtualization'
import type {
  ContextMenuPayload,
  SectionLayout,
  Widget,
  WidgetDraft,
  WidgetKind
} from '@shared/types'

const CATEGORY_ICON: Record<WidgetCategory, string> = {
  Notes: 'sticky_note_2',
  Web: 'public',
  Files: 'folder',
  Tools: 'build',
  Comms: 'mail',
  Layout: 'crop_free'
}

const CATEGORY_COLOR: Record<WidgetCategory, string> = {
  Notes: '#f59e0b',
  Web: '#3b82f6',
  Files: '#10b981',
  Tools: '#8b5cf6',
  Comms: '#ec4899',
  Layout: '#737373'
}

// Stable empty overlay-objects reference so the layout-save effect does not
// re-arm while a Desk is not opted into per-device layout (PLX-APP-010 Phase 2).
const EMPTY_OVERLAY_OBJECTS: never[] = []
const WEB_KINDS: WidgetKind[] = ['webview', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email']
const isWebKind = (k: WidgetKind): boolean => WEB_KINDS.includes(k)

import { renderWidget } from './widgets/renderWidget'


const STATUS_META: Record<
  'open' | 'in_progress' | 'done' | 'parked',
  { label: string; icon: string; next: 'open' | 'in_progress' | 'done' | 'parked' }
> = {
  open: { label: 'Start', icon: 'play_arrow', next: 'in_progress' },
  in_progress: { label: 'Done', icon: 'check', next: 'done' },
  done: { label: 'Reopen', icon: 'refresh', next: 'open' },
  parked: { label: 'Resume', icon: 'play_arrow', next: 'open' }
}

export default function Canvas(): JSX.Element {
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  // Capability gating for the right-click "Add object" menu, so it matches the
  // widget palette (core widgets first, an Advanced group, and Pro-gated kinds
  // prompt to upgrade rather than silently creating).
  const caps = useCapabilityStore((s) => s.capabilities)
  // Per-desk view mode: the infinite Canvas (default) or the Columns view.
  const deskViewModes = useDeskViewStore((s) => s.modes)
  const deskViewDefaults = useDeskViewStore((s) => s.defaults)
  // Resolution mirrors the store's get(): last-used wins, else the pinned default
  // for this desk, else Canvas.
  const deskViewMode = activeTaskId
    ? deskViewModes[activeTaskId] ?? deskViewDefaults[activeTaskId] ?? 'canvas'
    : 'canvas'
  // The spatial canvas renders only in 'canvas' mode; every other mode (columns +
  // the data views) mounts as its own overlay instead.
  const isCanvasMode = deskViewMode === 'canvas'
  const dataLayout: DataLayout | null =
    deskViewMode === 'list' || deskViewMode === 'table' || deskViewMode === 'gallery' || deskViewMode === 'compact'
      ? deskViewMode
      : null
  const nodes = useNodeStore((s) => s.nodes)
  const updateNode = useNodeStore((s) => s.update)
  const openObjectChannel = useMessagingStore((s) => s.openObjectChannel)
  const resolveObjectChannel = useMessagingStore((s) => s.resolveObjectChannel)
  const setActiveTask = useNodeStore((s) => s.setActive)
  // Breadcrumb origin: if this task's canvas was opened by exploring a mind-map
  // node, show a path back to the map. Re-read on task switch + origin changes.
  const [nodeOrigin, setNodeOrigin] = useState<NodeCanvasOrigin | null>(() =>
    getOrigin(activeTaskId)
  )
  useEffect(() => {
    const read = (): void => setNodeOrigin(getOrigin(activeTaskId))
    read()
    return subscribeOrigins(read)
  }, [activeTaskId])
  // Bumped when the user dismisses the starting kit, to re-evaluate visibility.
  const [kitDismissTick, setKitDismissTick] = useState(0)
  // Office-document add chooser (create / import / select-existing) + drop point.
  const [officeAdd, setOfficeAdd] = useState<{ entry: WidgetCatalogEntry; x: number; y: number } | null>(null)
  const [syncPickerOpen, setSyncPickerOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [showResume, setShowResume] = useState(false)
  const widgets = useWidgetStore((s) => s.widgets)
  // Auto-offer the starting kit on a freshly-explored, still-EMPTY node canvas.
  // "Empty" ignores the auto-created minimap + any pinned chrome.
  const showStartingKit =
    kitDismissTick >= 0 &&
    !!nodeOrigin &&
    !!activeTaskId &&
    widgets.filter((w) => w.kind !== 'minimap' && !w.pinned).length === 0 &&
    !isKitDismissed(activeTaskId)
  const focusedId = useWidgetStore((s) => s.focusedWidgetId)
  const activeId = useWidgetStore((s) => s.activeWidgetId)
  const setActive = useWidgetStore((s) => s.setActive)
  const focusOn = useWidgetStore((s) => s.focusOn)
  const centerToken = useWidgetStore((s) => s.centerToken)
  const zoom = useWidgetStore((s) => s.zoom)
  // The paper pattern scales with the camera exactly. It used to be quantised
  // to 5% steps to spare the paper a repaint on every zoom frame, but a cell
  // size is a geometry, not a shade: a 2.5% error is invisible on a single cell
  // and compounds with distance, so the whole dot field jumped ~70px across a
  // 1400px viewport each time the camera crossed a step. On a Mac trackpad a
  // pinch arrives as ctrl+wheel during ordinary two-finger scrolling, so those
  // steps were being crossed while the user believed they were only panning.
  // The repaint it was avoiding is now avoided by geometry instead: the layer's
  // inset is a constant, so a zoom changes only this layer's paint, never its
  // layout, and panning still moves nothing but a composited transform.
  const patternZoom = patternScale(zoom)
  const panX = useWidgetStore((s) => s.panX)
  const panY = useWidgetStore((s) => s.panY)
  const setZoom = useWidgetStore((s) => s.setZoom)
  const panBy = useWidgetStore((s) => s.panBy)
  const nav = useNavPrefs()
  const zoomTowardPoint = useWidgetStore((s) => s.zoomTowardPoint)
  const resetView = useWidgetStore((s) => s.resetView)
  const loadForTask = useWidgetStore((s) => s.loadForTask)
  const clearWidgets = useWidgetStore((s) => s.clear)
  const createWidget = useWidgetStore((s) => s.create)
  const updateWidget = useWidgetStore((s) => s.update)
  const bumpLayoutVersion = useWidgetStore((s) => s.bumpLayoutVersion)
  const selectedIds = useWidgetStore((s) => s.selectedIds)
  const setSelection = useWidgetStore((s) => s.setSelection)
  const clearSelection = useWidgetStore((s) => s.clearSelection)
  const removeWidget = useWidgetStore((s) => s.remove)
  const groupDragActive = useWidgetStore((s) => s.groupDrag !== null)
  const dropRef = useRef<HTMLDivElement | null>(null)
  // Space taken on the right of the viewport by the assistant panel, measured as
  // the gap between the canvas's right edge and the window edge. The floating
  // toolbar (position:fixed) uses this to dock beside the assistant instead of
  // sliding under it when it opens or is resized.
  const [toolbarRightInset, setToolbarRightInset] = useState(0)
  // Live canvas viewport size in screen px, tracked so off-viewport
  // virtualisation (PLX-APP-012) can recompute the mounted-Object set when the
  // window or side panels resize. Zero until first measure = "not measured yet".
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  useEffect(() => {
    const el = dropRef.current
    if (!el) return
    const measure = (): void => {
      const rect = el.getBoundingClientRect()
      setToolbarRightInset(Math.max(0, Math.round(window.innerWidth - rect.right)))
      setViewportSize((prev) => {
        const w = Math.round(rect.width)
        const h = Math.round(rect.height)
        return prev.w === w && prev.h === h ? prev : { w, h }
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])
  const setPan = useWidgetStore((s) => s.setPan)
  const dockInset = useWidgetStore((s) => s.dockInset)
  const [savingTemplate] = useState(false)
  // Controls the SaveTemplateDialog. context distinguishes the toolbar
  // entry point from the task-done auto-prompt so the dialog headline
  // and the skip-button copy can adapt.
  const [saveTemplateOpen, setSaveTemplateOpen] = useState<
    null | { context: 'toolbar' | 'task-done' }
  >(null)
  // Track tasks we've already prompted about on done so re-clicking
  // "Done → Reopen → Done" doesn't re-open the prompt in a loop. Reset
  // when the task changes.
  const promptedDoneRef = useRef<Set<string>>(new Set())
  // (palette state is local to WidgetPalette now — it manages its own
  // popover open/closed; we removed the canvas-level toggle.)
  const [animatingPan, setAnimatingPan] = useState(false)
  // (The minimap measures the canvas viewport itself via its own
  // ResizeObserver — see MinimapWidget — so Canvas no longer tracks a
  // separate, unread viewportSize here.)
  // Edge-pan / "infinite map" camera. The hook installs a rAF loop
  // that pans the canvas when the cursor enters a 80px margin near
  // any edge — closer to the edge = faster pan (quadratic ramp).
  // Disabled while a widget is active (the user is editing inside it),
  // while a zoom-to-fit animation is running, or when keyboard focus is
  // in a form input. Returns the live per-edge intensity (0-1) for the
  // visual indicators below.
  // Any open menu (the control pill's fly-out, a context menu, a dropdown)
  // stands edge-pan down completely while it is open, so reaching for a menu
  // that sits near a screen edge never scrolls the camera out from under it.
  const anyMenuOpen = useOverlayStore(selectAnyMenuOpen)
  const edgeIntensity = useEdgePan({
    containerRef: dropRef,
    // Only animatingPan disables edge-pan. We DELIBERATELY no longer
    // disable on `activeId !== null`. Reasoning: a user moving the
    // cursor to the canvas edge is unambiguously asking to navigate
    // the canvas — even with a widget currently active. The old gate
    // meant clicking any widget killed edge-pan until the user
    // remembered to press Escape or click on bare canvas to deselect.
    // Hiding canvas navigation behind a manual deselect step was the
    // root cause of "edge-pan stopped working" complaints — paired
    // with the form-focus gate (now scoped to canvas-internal forms),
    // any kind of widget interaction would silently kill it.
    disabled: animatingPan,
    // Hard-disable (full stop, even mid-drag) when edge-pan is turned off or
    // any menu is open. A menu being open means the user is interacting with
    // chrome, not dragging a widget, so the mid-drag pan invariant is not in
    // play here.
    hardDisabled: !nav.edgePanEnabled || anyMenuOpen,
    maxSpeedPerSecond: 1100 * nav.edgePanSpeed
  })
  const [, setNowTick] = useState(0) // for the running-task clock
  const [snoozeUntil, setSnoozeUntil] = useState<number>(0)
  const [showAISetup, setShowAISetup] = useState(false)
  // AI Builder: free-form "describe what you want" prompt that returns
  // suggested widgets (pages, tables, fields). Independent of the existing
  // AI Setup (which is task-context-driven and uses the older suggestion
  // format).
  const [showAiBuilder, setShowAiBuilder] = useState(false)
  const welcomedTasksRef = useRef<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{
    screenX: number
    screenY: number
    canvasX: number
    canvasY: number
  } | null>(null)

  const activeTask = activeTaskId ? nodes.find((n) => n.id === activeTaskId) ?? null : null
  const { assignToRoom, createRoomAndAssign } = useFreeDesk()
  const focusSessionActive = useFocusSessionStore((s) => !!activeTaskId && s.active?.taskId === activeTaskId)
  const startFocusSession = useFocusSessionStore((s) => s.start)

  // Spatial-link state — load per task, mirror the widgets pattern. The
  // overlay reads this store; Canvas owns the link-arm gesture.
  //
  // Gesture state is split into two pieces:
  //   - linkSourceId: the widget the user "armed" the link from. Only set
  //     on arm start / cleared on arm end. Drives the banner + the install
  //     of the global mouse/keyboard listeners.
  //   - ghostCursor: world-space cursor position. Updated on every
  //     mousemove. Only this triggers ghost-line re-renders, so the
  //     listener-install effect doesn't churn on every cursor frame.
  const loadLinksForTask = useLinksStore((s) => s.loadForTask)
  const clearLinks = useLinksStore((s) => s.clear)
  const createLink = useLinksStore((s) => s.create)
  const links = useLinksStore((s) => s.links)
  const dragOverride = useWidgetStore((s) => s.dragOverride)
  const layoutHydratedFor = useWidgetStore((s) => s.layoutHydratedFor)
  const customLayout = useWidgetStore((s) => s.customLayout)
  const setDeskCustomLayout = useWidgetStore((s) => s.setDeskCustomLayout)
  const accountId = useAccountStore((s) => s.account?.id ?? null)
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null)
  const [ghostCursor, setGhostCursor] = useState<{ x: number; y: number } | null>(null)
  // A freshly-drawn link awaiting the user's "how should this connect?" choice,
  // anchored at the drop point (raw viewport coords). See LinkOverlay's picker.
  const [pendingLinkPick, setPendingLinkPick] = useState<PendingLinkPick | null>(null)
  const clearPendingLinkPick = useCallback(() => setPendingLinkPick(null), [])

  // Off-viewport virtualisation (PLX-APP-012). `visibleObjectIds` is the set of
  // top-level Objects the render loop mounts this frame; null means "cull nothing"
  // (Columns view or before the viewport is measured). `visibleIdsRef` feeds the
  // previous-frame set back into the hysteresis + freeze logic, and the key ref
  // lets us commit a new set only when membership actually changes, mirroring the
  // marquee hit-test pattern so pans don't force a re-render every frame.
  const [visibleObjectIds, setVisibleObjectIds] = useState<Set<string> | null>(null)
  const visibleIdsRef = useRef<Set<string> | null>(null)
  const visibleKeyRef = useRef<string>('')

  useEffect(() => {
    if (activeTaskId) void loadForTask(activeTaskId)
    else clearWidgets()
  }, [activeTaskId, loadForTask, clearWidgets])

  // Per-widget Context Health frames (plexi-4.0, UX-022 at the Object level). Once
  // a desk's widgets have loaded, baseline each one's "changed since your last
  // visit" health so the frames reflect what moved while the user was away. Runs
  // once per desk open; the ref guards against re-running on later widget edits.
  const reviewedWidgetsForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeTaskId || layoutHydratedFor !== activeTaskId) return
    if (reviewedWidgetsForRef.current === activeTaskId) return
    reviewedWidgetsForRef.current = activeTaskId
    const ids = widgets
      .filter((w) => !w.archived && w.parentSectionId === null && w.kind !== 'section')
      .map((w) => w.id)
    void useContextHealthStore.getState().reviewWidgets(ids)
  }, [activeTaskId, layoutHydratedFor, widgets])

  // PLX-APP-010 Phase 1 / UX-032 — persist this user's camera + selection for the
  // active Desk and device class, debounced, on user action. Gated on
  // layoutHydratedFor so the reset-to-origin and the restore itself never save a
  // spurious layout before hydration. Object geometry stays in the shared base
  // (widgets) per ADR-0006, so objects is empty here; Phase 2 fills it. The last
  // sub-600ms camera nudge before a fast Desk switch may not persist, which
  // self-heals on the next visit.
  // PLX-APP-010 Phase 2 — when the Desk is opted into per-device layout, the
  // overlay carries eligible Objects' position/size too; otherwise it stays empty
  // and only camera + selection persist (Phase 1). Recomputed from widgets so a
  // geometry change re-arms the debounced save; a no-op stable value when off.
  const overlayObjects = useMemo(
    () => (customLayout ? serializeOverlayObjects(widgets) : EMPTY_OVERLAY_OBJECTS),
    [customLayout, widgets]
  )
  useEffect(() => {
    if (!activeTaskId || layoutHydratedFor !== activeTaskId) return
    const layout = {
      userId: accountId ?? 'local',
      deskId: activeTaskId,
      deviceClass: currentDeviceClass(),
      customLayout,
      objects: overlayObjects,
      scroll: { x: panX - dockInset, y: panY },
      selectedObjectIds: selectedIds,
      zoom
    }
    const t = window.setTimeout(() => void window.api.deskLayout.save(layout), 600)
    return () => window.clearTimeout(t)
  }, [activeTaskId, layoutHydratedFor, accountId, panX, panY, zoom, selectedIds, customLayout, overlayObjects, dockInset])

  // PLX-APP-012 — world-space bounding boxes for every top-level Object the two
  // render maps iterate. Camera-independent, so this recomputes only when the
  // Object set changes, never on a pan frame. Section children are excluded here
  // and mount through their parent section.
  const virtualizationBoxes = useMemo<VirtualizationBox[]>(() => {
    const boxes: VirtualizationBox[] = []
    for (const w of widgets) {
      if (w.archived || w.pinned) continue
      if (w.parentSectionId !== null) continue
      if (w.kind === 'section') {
        const children = widgets.filter((c) => c.parentSectionId === w.id)
        const frame = computeSectionFrame(children, effectiveLayout(w.layout))
        boxes.push({ id: w.id, x: w.x, y: w.y, width: frame.width, height: frame.height })
      } else {
        boxes.push({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height })
      }
    }
    return boxes
  }, [widgets])

  // PLX-APP-012 — ids that must never be culled regardless of geometry: the
  // active, focused and link-armed Object, the whole selection, every stateful
  // web-kind Object (unmounting a <webview> reloads it), and every link endpoint.
  // Any exempt Object that lives inside a section also keeps that section mounted,
  // so the child renders and its DOM node exists for LinkOverlay (linking to
  // section children is permitted today, so this promotion is load-bearing).
  // Camera-independent, and deliberately excludes the per-frame drag signal (see
  // dragExemptIds) so an active drag never rebuilds this Set every frame.
  const virtualizationExempt = useMemo<Set<string>>(() => {
    const exempt = new Set<string>()
    if (activeId) exempt.add(activeId)
    if (focusedId) exempt.add(focusedId)
    if (linkSourceId) exempt.add(linkSourceId)
    for (const id of selectedIds) exempt.add(id)
    for (const w of widgets) if (isWebKind(w.kind)) exempt.add(w.id)
    for (const l of links) {
      exempt.add(l.sourceWidgetId)
      exempt.add(l.targetWidgetId)
    }
    const byId = new Map(widgets.map((w) => [w.id, w]))
    for (const id of Array.from(exempt)) {
      const parent = byId.get(id)?.parentSectionId
      if (parent) exempt.add(parent)
    }
    return exempt
  }, [widgets, links, selectedIds, activeId, focusedId, linkSourceId])

  // PLX-APP-012 — the currently-dragged Object (and its parent section) as a tiny
  // side channel. `dragOverride` changes x/y every drag frame, but the dragged
  // *id* is stable for the whole drag, so keying on the id means this recomputes
  // once per drag rather than per frame, and the heavy exempt Set above is never
  // rebuilt mid-drag. Passed to computeVisibleObjectIds as extraExemptIds.
  const draggingId = dragOverride?.widgetId ?? null
  const dragExemptIds = useMemo<string[] | undefined>(() => {
    if (!draggingId) return undefined
    const w = widgets.find((x) => x.id === draggingId)
    return w?.parentSectionId ? [draggingId, w.parentSectionId] : [draggingId]
  }, [draggingId, widgets])

  // PLX-APP-012 — recompute the mounted-Object set when the camera or the derived
  // box/exempt inputs change. Per pan frame only the pure intersection runs, and
  // the set is committed only when membership actually changes (sorted-key compare,
  // the marquee hit-test pattern), so a pan that reveals nothing new never forces a
  // re-render. Hysteresis + the animation freeze come from the pure module.
  useEffect(() => {
    if (!isCanvasMode || viewportSize.w === 0 || viewportSize.h === 0) {
      // Non-canvas views mount through their own overlays, and before the first
      // measure we have no viewport to test against — render everything in both.
      if (visibleIdsRef.current !== null || visibleKeyRef.current !== '') {
        visibleIdsRef.current = null
        visibleKeyRef.current = ''
        setVisibleObjectIds(null)
      }
      return
    }
    const next = computeVisibleObjectIds(
      virtualizationBoxes,
      { panX, panY, zoom, viewportWidth: viewportSize.w, viewportHeight: viewportSize.h },
      {
        exemptIds: virtualizationExempt,
        extraExemptIds: dragExemptIds,
        previousVisible: visibleIdsRef.current ?? undefined,
        freezeUnmounts: animatingPan
      }
    )
    const key = Array.from(next).sort().join(',')
    if (key !== visibleKeyRef.current) {
      visibleKeyRef.current = key
      visibleIdsRef.current = next
      setVisibleObjectIds(next)
    }
  }, [
    virtualizationBoxes,
    virtualizationExempt,
    dragExemptIds,
    panX,
    panY,
    zoom,
    animatingPan,
    viewportSize,
    deskViewMode
  ])

  useEffect(() => {
    if (activeTaskId) void loadLinksForTask(activeTaskId)
    else clearLinks()
  }, [activeTaskId, loadLinksForTask, clearLinks])

  // Migrate: remove any legacy minimap widgets — the minimap is now a built-in
  // FAB. This runs on mount AND subscribes to the widget store, so a minimap
  // widget that loads or syncs in asynchronously (after this effect first ran)
  // is still caught. Scoped to any taskId, since the old per-task + on-desk-open
  // version raced widget loading and missed folder-desk minimaps (leaving one
  // rendering mid-canvas). Removing a widget converges: the store change re-runs
  // the sweep, which then finds none.
  useEffect(() => {
    const sweep = (): void => {
      const legacy = useWidgetStore.getState().widgets.filter((w) => w.kind === 'minimap')
      legacy.forEach((w) => void useWidgetStore.getState().remove(w.id))
    }
    sweep()
    return useWidgetStore.subscribe(sweep)
  }, [])

  // Imperative controller exposed via context to WidgetFrame / SectionWidget.
  // The .start() call is what arms the link gesture — it's invoked from a
  // widget header button's onClick handler. We keep this on a ref so the
  // identity is stable across renders.
  const linkDragController = useRef({
    start: (sourceWidgetId: string): void => {
      setLinkSourceId(sourceWidgetId)
      setGhostCursor(null) // appears on first mousemove
    }
  }).current

  // While armed: mousemove updates ghost cursor, click capture-phase
  // completes/cancels, Esc cancels. Listeners install ONCE per arm session
  // (deps key on linkSourceId, not on ghostCursor) so they don't churn on
  // every cursor frame.
  useEffect(() => {
    if (!linkSourceId) return
    // Stable reference for the duration of this arm session — TypeScript
    // can't narrow `linkSourceId` inside the nested handlers below, so we
    // pin it locally.
    const sourceId: string = linkSourceId
    function onMove(e: MouseEvent): void {
      // Raw viewport coords — the LinkOverlay SVG is now position: fixed
      // covering the viewport, so client coords ARE its coord space.
      // Previously this subtracted dropRef's left/top; that broke as soon
      // as the SVG's positioned ancestor diverged from dropRef, which
      // turned out to be the cause of the long-standing "ghost lines
      // float off in the middle of nowhere" bug.
      setGhostCursor({ x: e.clientX, y: e.clientY })
    }
    function endArm(): void {
      setLinkSourceId(null)
      setGhostCursor(null)
    }
    function onClickCapture(e: MouseEvent): void {
      const target = e.target as HTMLElement | null
      // The banner + its cancel button are tagged with data-link-skip so
      // their clicks don't complete the gesture.
      if (target?.closest('[data-link-skip]')) return
      const widgetEl = target?.closest('[data-widget-id]') as HTMLElement | null
      const toId = widgetEl?.dataset.widgetId ?? null
      // Click on the same source widget, on a pinned/child widget, or on
      // bare canvas → cancel without creating.
      if (!toId || toId === sourceId || !activeTaskId) {
        endArm()
        return
      }
      const ws = useWidgetStore.getState().widgets
      const from = ws.find((w) => w.id === sourceId)
      const to = ws.find((w) => w.id === toId)
      if (!from || !to) {
        endArm()
        return
      }
      // Pinned widgets are valid endpoints too (widget-link-owner invariant 5):
      // their rect is read in the same viewport coords as every other widget, so
      // a line to/from a screen-anchored pinned tool renders correctly.
      // Linking widgets inside sections — and to sections themselves — is
      // now permitted. The visual link is drawn between the actual
      // rendered widget rects (LinkOverlay reads getBoundingClientRect on
      // [data-widget-id]) so an in-section widget produces a line that
      // anchors to its visible position inside the section frame, and a
      // section produces a line that anchors to the section's outer
      // frame. The persisted row in widget_links stores source + target
      // widget ids regardless of section membership.
      //
      // The link is created immediately as a passive `context` wire (so the
      // gesture never silently produces nothing), then we offer the intent
      // picker at the drop point to upgrade its type. Capture the drop coords
      // BEFORE endArm resets gesture state (widget-link-owner design).
      const dropX = e.clientX
      const dropY = e.clientY
      endArm()
      void createLink(sourceId, toId, activeTaskId).then((link) => {
        if (link) setPendingLinkPick({ linkId: link.id, x: dropX, y: dropY })
      })
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') endArm()
    }
    window.addEventListener('mousemove', onMove)
    // Capture phase — fires BEFORE the widget's own onClick activator.
    // Otherwise the activation handler could swallow the click via
    // stopPropagation and the completion would never reach us.
    window.addEventListener('click', onClickCapture, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('click', onClickCapture, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [linkSourceId, panX, panY, zoom, activeTaskId, createLink])

  // Proactive welcome: when a task transitions to in_progress for the first time this session,
  // and the user hasn't already started a chat about it, the AI opens with a 1-2 sentence hello + first step.
  useEffect(() => {
    if (!activeTask) return
    if (activeTask.status !== 'in_progress') return
    if (welcomedTasksRef.current.has(activeTask.id)) return
    welcomedTasksRef.current.add(activeTask.id)
    void useChatStore.getState().sendProactiveWelcome(activeTask.id)
  }, [activeTask?.id, activeTask?.status])

  // Task-done auto-prompt: when an active task transitions to `done`,
  // ask whether to save its canvas as a template before the user moves
  // on. The thinking is: most templates the user would EVER want to
  // make are the ones for tasks they've JUST finished — they know what
  // worked. Catching them at that moment is the maximum-leverage prompt.
  //
  // Guards:
  //  - Only fire once per task per session (promptedDoneRef).
  //  - Only fire if the task has ≥1 widget — empty desks can't template.
  //  - Skip if another modal is already open (focus mode, AI setup, resume)
  //    so we don't stack dialogs.
  useEffect(() => {
    if (!activeTask) return
    if (activeTask.status !== 'done') return
    if (promptedDoneRef.current.has(activeTask.id)) return
    const haveWidgets = widgets.some(
      (w) => w.taskId === activeTask.id && !w.archived
    )
    if (!haveWidgets) return
    if (focusedId !== null || showAISetup || showAiBuilder) return
    promptedDoneRef.current.add(activeTask.id)
    setSaveTemplateOpen({ context: 'task-done' })
  }, [
    activeTask?.id,
    activeTask?.status,
    widgets,
    focusedId,
    showAISetup,
    showAiBuilder
  ])

  // Reset the "prompted on done" set when the active task changes — so
  // a future Done → Reopen → Done flow on the SAME task isn't re-prompted
  // this session, but a different task that gets done later still is.
  // (We don't clear when same id stays active.)
  useEffect(() => {
    // Effect intentionally empty besides the ref-clear behaviour below —
    // promptedDoneRef persists across re-renders by design.
  }, [activeTaskId])

  // Re-render every second while a task is in progress (drives the title-bar clock)
  useEffect(() => {
    if (!activeTask) return
    if (activeTask.status !== 'in_progress') return
    if (!activeTask.estimateMinutes) return
    const id = window.setInterval(() => setNowTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [activeTask?.status, activeTask?.estimateMinutes, activeTask?.id])

  // Receive context-menu actions from main process (right-click inside webview)
  useEffect(() => {
    const off = window.api.contextMenu.onAction((payload: ContextMenuPayload) => {
      void handleContextMenu(payload)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskId, panX, panY, zoom])

  async function handleContextMenu(payload: ContextMenuPayload): Promise<void> {
    if (!activeTaskId || !dropRef.current) return
    const entry = lookupWebview(payload.webContentsId)
    if (!entry) return
    const wvRect = entry.el.getBoundingClientRect()
    const canvasRect = dropRef.current.getBoundingClientRect()
    const screenX = wvRect.left + payload.x
    const screenY = wvRect.top + payload.y
    const canvasX = (screenX - canvasRect.left - panX) / zoom
    const canvasY = (screenY - canvasRect.top - panY) / zoom
    const baseX = Math.round(canvasX + 20)
    const baseY = Math.round(canvasY + 20)
    const common: Pick<WidgetDraft, 'taskId' | 'x' | 'y'> = {
      taskId: activeTaskId,
      x: baseX,
      y: baseY
    }
    switch (payload.action) {
      case 'createStickyFromSelection':
        if (!payload.selectionText) return
        await createWidget({
          ...common,
          kind: 'sticky',
          content: payload.selectionText,
          width: 280,
          height: 220,
          color: '#fef08a'
        })
        return
      case 'createNoteFromSelection':
        if (!payload.selectionText) return
        await createWidget({
          ...common,
          kind: 'note',
          content: payload.selectionText,
          width: 380,
          height: 300,
          color: null
        })
        return
      case 'openLinkInNewBrowser':
        if (!payload.linkURL) return
        await createWidget({
          ...common,
          kind: 'webview',
          content: payload.linkURL,
          width: 560,
          height: 400,
          color: null
        })
        return
      case 'saveImageToCanvas':
        if (!payload.srcURL) return
        await createWidget({
          ...common,
          kind: 'image',
          content: payload.srcURL,
          width: 360,
          height: 280,
          color: null
        })
        return
      case 'saveVideoToCanvas':
        if (!payload.srcURL) return
        await createWidget({
          ...common,
          kind: 'video',
          content: payload.srcURL,
          width: 480,
          height: 320,
          color: null
        })
        return
    }
  }

  // Auto-center on the active widget when a click triggers requestCenter()
  useEffect(() => {
    if (centerToken === 0) return
    if (!activeId || !dropRef.current) return
    const w = widgets.find((x) => x.id === activeId)
    if (!w) return

    let cx = w.x
    let cy = w.y
    let cw = w.width
    let ch = w.height

    if (w.parentSectionId) {
      // Child of a section: its stored x/y are relative. Translate to canvas coords.
      const parent = widgets.find((p) => p.id === w.parentSectionId)
      if (parent) {
        const parentLayout = effectiveLayout(parent.layout)
        if (parentLayout === 'free') {
          cx = parent.x + SECTION_PADDING + w.x
          cy = parent.y + SECTION_PADDING + w.y
        } else {
          // Non-free layouts (grid/stacks/icons/list): the child's stored x/y
          // are meaningless — its real position is computed by the layout.
          // Re-run the exact layout math to find this child's cell, so the
          // camera centres on the item itself, not the whole section.
          const siblings = widgets.filter((c) => c.parentSectionId === parent.id)
          const frame = computeSectionFrame(siblings, parentLayout)
          const contentW = frame.width - 2 * SECTION_PADDING
          const cells = computeLayoutCells(parentLayout, siblings, contentW)
          const idx = siblings.findIndex((c) => c.id === w.id)
          const cell = idx >= 0 ? cells[idx] : undefined
          if (cell) {
            cx = parent.x + SECTION_PADDING + cell.x
            cy = parent.y + SECTION_PADDING + cell.y
            cw = cell.width
            ch = cell.height
          } else {
            // Defensive fallback: centre the section if the child vanished.
            cx = parent.x
            cy = parent.y
            cw = frame.width
            ch = frame.height
          }
        }
      }
    } else if (w.kind === 'section') {
      // Sections: stored width/height can lag actual; use computed frame
      const children = widgets.filter((c) => c.parentSectionId === w.id)
      const frame = computeSectionFrame(children, effectiveLayout(w.layout))
      cw = frame.width
      ch = frame.height
    }

    const rect = dropRef.current.getBoundingClientRect()
    const targetX = dockInset + (rect.width - dockInset) / 2 - (cx + cw / 2) * zoom
    const targetY = rect.height / 2 - (cy + ch / 2) * zoom
    setAnimatingPan(true)
    setPan(targetX, targetY)
    const t = window.setTimeout(() => setAnimatingPan(false), 280)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerToken])

  function centerOnHome(): void {
    if (!dropRef.current) return
    const canvasItems = widgets.filter((w) => !w.pinned && !w.parentSectionId)
    if (canvasItems.length === 0) {
      resetView()
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const w of canvasItems) {
      let width = w.width
      let height = w.height
      if (w.kind === 'section') {
        const sChildren = widgets.filter((c) => c.parentSectionId === w.id)
        const frame = computeSectionFrame(sChildren, effectiveLayout(w.layout))
        width = frame.width
        height = frame.height
      }
      minX = Math.min(minX, w.x)
      minY = Math.min(minY, w.y)
      maxX = Math.max(maxX, w.x + width)
      maxY = Math.max(maxY, w.y + height)
    }
    const bbW = Math.max(1, maxX - minX)
    const bbH = Math.max(1, maxY - minY)
    const rect = dropRef.current.getBoundingClientRect()
    const PAD = 60
    const visibleW = rect.width - dockInset
    const zoomX = (visibleW - 2 * PAD) / bbW
    const zoomY = (rect.height - 2 * PAD) / bbH
    const newZoom = Math.max(0.25, Math.min(zoomX, zoomY, 1))
    const bbCenterX = minX + bbW / 2
    const bbCenterY = minY + bbH / 2
    const targetPanX = dockInset + visibleW / 2 - bbCenterX * newZoom
    const targetPanY = rect.height / 2 - bbCenterY * newZoom
    setAnimatingPan(true)
    setZoom(newZoom)
    setPan(targetPanX, targetPanY)
    window.setTimeout(() => setAnimatingPan(false), 280)
  }

  // Keyboard: Cmd+] zoom in, Cmd+[ zoom out, Cmd+0 reset, Cmd+H home, Esc deactivate widget
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && activeId !== null) {
        setActive(null)
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === ']') {
        e.preventDefault()
        setZoom(zoom + 0.1)
      } else if (e.key === '[') {
        e.preventDefault()
        setZoom(zoom - 0.1)
      } else if (e.key === '0') {
        e.preventDefault()
        resetView()
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault()
        centerOnHome()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, setZoom, resetView, activeId, setActive, widgets])

  const screenToCanvas = useCallback(
    (screenX: number, screenY: number): { x: number; y: number } => {
      return { x: (screenX - panX) / zoom, y: (screenY - panY) / zoom }
    },
    [panX, panY, zoom]
  )

  function handleWheel(e: React.WheelEvent<HTMLDivElement>): void {
    // If an active widget contains the wheel target, leave it alone — its content scrolls
    if (activeId !== null) {
      const target = e.target as HTMLElement
      if (target.closest(`[data-widget-id="${activeId}"]`)) return
    }
    // ⌘/Ctrl + wheel = zoom toward cursor; otherwise pan (works for trackpad swipe)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * 0.005 * nav.zoomSensitivity)
      const cursorX = e.clientX - rect.left
      const cursorY = e.clientY - rect.top
      zoomTowardPoint(zoom * factor, cursorX, cursorY)
    } else {
      e.preventDefault()
      panBy(-e.deltaX * nav.wheelSensitivity, -e.deltaY * nav.wheelSensitivity)
    }
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLDivElement>): void {
    // Clicks on bare-canvas areas (not on a widget) deactivate the active widget
    const target = e.target as HTMLElement
    if (target.dataset.bareCanvas !== undefined && activeId !== null) {
      setActive(null)
    }
  }

  // ── Click-drag canvas panning ──────────────────────────────────────────────
  // Press on bare canvas → a sonar ping + a pulsing ring confirm the grab; hold
  // and move and the camera pans 1:1 with the cursor (panX/panY are screen-space
  // translations, so the delta maps directly). A press without a drag still acts
  // as a click (deactivate the active widget).
  const panDragRef = useRef<{
    startX: number
    startY: number
    startPanX: number
    startPanY: number
    moved: boolean
    pointerId: number
  } | null>(null)
  const [grabbing, setGrabbing] = useState(false)
  const [panPing, setPanPing] = useState<{ x: number; y: number } | null>(null)
  // Space-as-pan-modifier (Figma-style): while Space is held over the canvas, a
  // left-drag pans instead of marquee-selecting. `spaceReady` only drives the
  // grab cursor; the gesture itself reads the ref so it's always current.
  const spaceHeldRef = useRef(false)
  const [spaceReady, setSpaceReady] = useState(false)
  // ── Rubber-band (marquee) selection ────────────────────────────────────────
  // rubberRef holds the canvas-space anchor while a Shift+drag is in flight;
  // rubberRect is the live canvas-space rectangle (rendered as a screen-space
  // overlay so the dashed border stays crisp at any zoom).
  const rubberRef = useRef<{ startX: number; startY: number; pointerId: number } | null>(null)
  const [rubberRect, setRubberRect] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null
  )
  // Last hit-set (sorted, joined) so we only push a new selection when the set
  // of overlapped widgets actually changes — avoids a re-render every mousemove.
  const lastHitsRef = useRef<string>('')
  // Widgets eligible for marquee/selection: top-level, non-pinned, not the
  // minimap, and not a section (sections can be moved but aren't multi-selected
  // in v1). Their x/y/width/height are absolute canvas coords.
  const selectableWidgets = useCallback(
    () =>
      useWidgetStore
        .getState()
        .widgets.filter(
          (w) =>
            w.parentSectionId === null &&
            !w.pinned &&
            w.kind !== 'section' &&
            w.kind !== 'minimap'
        ),
    []
  )

  // Screen-space bounding box of the current selection (for the floating
  // selection toolbar). Recomputed when the selection or any widget moves.
  const selectionBBox = useMemo(() => {
    if (selectedIds.length === 0) return null
    const sel = widgets.filter((w) => selectedIds.includes(w.id))
    if (sel.length === 0) return null
    const minX = Math.min(...sel.map((w) => w.x))
    const minY = Math.min(...sel.map((w) => w.y))
    const maxX = Math.max(...sel.map((w) => w.x + w.width))
    const maxY = Math.max(...sel.map((w) => w.y + w.height))
    return { minX, minY, maxX, maxY, count: sel.length }
  }, [selectedIds, widgets])

  // Wrap the selected widgets in a new section that encloses them. The section
  // is sized to their bounding box (+ padding); each child's absolute canvas
  // x/y becomes section-local. Free layout preserves their relative positions.
  const groupIntoSection = useCallback(async (): Promise<void> => {
    const all = useWidgetStore.getState().widgets
    const sel = all.filter(
      (w) =>
        selectedIds.includes(w.id) &&
        w.parentSectionId === null &&
        !w.pinned &&
        w.kind !== 'section' &&
        w.kind !== 'minimap'
    )
    if (sel.length < 1) return
    const minX = Math.min(...sel.map((w) => w.x))
    const minY = Math.min(...sel.map((w) => w.y))
    const maxX = Math.max(...sel.map((w) => w.x + w.width))
    const maxY = Math.max(...sel.map((w) => w.y + w.height))
    const sectionX = minX - SECTION_PADDING
    const sectionY = minY - SECTION_PADDING
    const sectionW = Math.max(maxX - minX + 2 * SECTION_PADDING, SECTION_MIN_W)
    const sectionH = Math.max(maxY - minY + 2 * SECTION_PADDING, SECTION_MIN_H)
    const section = await createWidget({
      taskId: sel[0].taskId,
      kind: 'section',
      title: 'Group',
      content: '',
      x: sectionX,
      y: sectionY,
      width: sectionW,
      height: sectionH
    })
    chimeIn()
    await Promise.all(
      sel.map((w) =>
        updateWidget(w.id, {
          parentSectionId: section.id,
          x: Math.round(w.x - sectionX - SECTION_PADDING),
          y: Math.round(w.y - sectionY - SECTION_PADDING)
        })
      )
    )
    bumpLayoutVersion()
    clearSelection()
  }, [selectedIds, createWidget, updateWidget, bumpLayoutVersion, clearSelection])

  // Duplicate every selected widget as an independent copy, offset slightly,
  // then select the new copies so the user can immediately reposition them.
  const duplicateSelection = useCallback(async (): Promise<void> => {
    const all = useWidgetStore.getState().widgets
    const sel = all.filter((w) => selectedIds.includes(w.id))
    if (sel.length === 0) return
    const created = await Promise.all(
      sel.map((w) =>
        createWidget({
          taskId: w.taskId,
          kind: w.kind,
          title: w.title,
          content: w.content,
          x: w.x + 28,
          y: w.y + 28,
          width: w.width,
          height: w.height,
          color: w.color,
          sourceAppId: w.sourceAppId,
          mode: w.mode
        })
      )
    )
    setSelection(created.map((w) => w.id))
  }, [selectedIds, createWidget, setSelection])

  const deleteSelection = useCallback(async (): Promise<void> => {
    const ids = useWidgetStore.getState().selectedIds.slice()
    clearSelection()
    await Promise.all(ids.map((id) => removeWidget(id)))
  }, [clearSelection, removeWidget])

  // Selected, free, top-level widgets eligible for align/distribute (excludes
  // pinned, section children, sections themselves, and the minimap — same set
  // selectableWidgets uses).
  const alignableSelection = useCallback(() => {
    const ids = useWidgetStore.getState().selectedIds
    return selectableWidgets().filter((w) => ids.includes(w.id))
  }, [selectableWidgets])

  // Apply a map of id -> position delta in ONE undo step, then let the canvas
  // re-read positions (same commit shape as Tidy).
  const applyPositions = useCallback(
    async (targets: Record<string, { x?: number; y?: number }>, label: string): Promise<void> => {
      const ids = Object.keys(targets)
      if (ids.length === 0) return
      const st = useWidgetStore.getState()
      const hist = useActionHistory.getState()
      hist.beginBatch()
      try {
        await Promise.all(ids.map((id) => st.update(id, targets[id])))
      } finally {
        hist.endBatch(label)
      }
      bumpLayoutVersion()
    },
    [bumpLayoutVersion]
  )

  const alignSelection = useCallback(
    (mode: AlignMode): void => {
      void applyPositions(computeAlign(alignableSelection(), mode), `Align ${mode}`)
    },
    [alignableSelection, applyPositions]
  )
  const distributeSelection = useCallback(
    (axis: DistributeAxis): void => {
      void applyPositions(computeDistribute(alignableSelection(), axis), `Distribute ${axis}`)
    },
    [alignableSelection, applyPositions]
  )

  // Keyboard: Esc clears the selection; Cmd/Ctrl+A selects every selectable
  // widget on the desk (ignored while typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const el = document.activeElement as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === 'Escape' && useWidgetStore.getState().selectedIds.length > 0) {
        clearSelection()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A') && !typing) {
        const ids = selectableWidgets().map((w) => w.id)
        if (ids.length > 0) {
          e.preventDefault()
          setSelection(ids)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearSelection, selectableWidgets, setSelection])

  // Track the Space bar as a transient pan modifier. Engages only when focus is
  // on the bare canvas / body (never while typing in a field or interacting with
  // a widget), so it can't swallow a Space the user meant for something else. We
  // preventDefault while engaged so the page doesn't scroll.
  useEffect(() => {
    function isSafeTarget(): boolean {
      const ae = document.activeElement as HTMLElement | null
      if (!ae || ae === document.body) return true
      if (ae.dataset && ae.dataset.bareCanvas !== undefined) return true
      const tag = ae.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return false
      // Buttons/links/selects/webviews keep their own Space behaviour.
      return false
    }
    function down(e: KeyboardEvent): void {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.repeat) return
      if (!isSafeTarget()) return
      spaceHeldRef.current = true
      setSpaceReady(true)
      e.preventDefault()
    }
    function up(e: KeyboardEvent): void {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (!spaceHeldRef.current) return
      spaceHeldRef.current = false
      setSpaceReady(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // Single-key widget quick-add (S=sticky, N=note, T=table, …). Fires only on a
  // task canvas, with no modifier, when not typing. Reuses the exact same spawn
  // path as the palette/picker via a ref so position + gating stay consistent.
  const quickAddRef = useRef<(kind: WidgetKind) => void>(() => {})
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key.length !== 1) return
      const kind = effectiveShortcutToKind()[e.key.toUpperCase()]
      if (!kind) return
      // Confirmed-focus gate. The old check asked only whether activeElement was
      // an input/textarea/contenteditable, which is blind to the window between
      // clicking into a sticky and its editor actually taking focus -- typing in
      // that window created objects instead of text.
      const ws = useWidgetStore.getState()
      if (
        !quickAddAllowed({
          activeTaskId: useNodeStore.getState().activeTaskId,
          activeWidgetId: ws.activeWidgetId,
          focusedWidgetId: ws.focusedWidgetId,
          focusedElement: deepActiveElement()
        })
      ) {
        return
      }
      e.preventDefault()
      quickAddRef.current(kind)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const panPingTimer = useRef<number | null>(null)
  // Release-inertia state: smoothed velocity (px/frame), last sample, and the
  // running glide animation frame.
  const panVelocityRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 })
  const panLastMoveRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const panInertiaRaf = useRef<number | null>(null)

  function cancelPanInertia(): void {
    if (panInertiaRaf.current !== null) {
      cancelAnimationFrame(panInertiaRaf.current)
      panInertiaRaf.current = null
    }
  }
  useEffect(() => cancelPanInertia, [])

  function handleCanvasPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    const target = e.target as HTMLElement
    if (target.dataset.bareCanvas === undefined) return // only on bare canvas
    const middle = e.button === 1
    if (!middle && e.button !== 0) return // left or middle button only
    cancelPanInertia() // a fresh grab stops any in-flight glide
    panVelocityRef.current = { vx: 0, vy: 0 }
    const spacePan = e.button === 0 && spaceHeldRef.current
    // Gesture model: a PAN is middle-mouse, Space+left, or a plain left-drag
    // when drag-pan is enabled in settings (and Shift isn't held). Anything
    // else on the bare canvas — Shift+left, or a plain left-drag when drag-pan
    // is off — draws a rubber-band (marquee) selection. So marquee is always
    // reachable via Shift, and is the default plain-drag when the user hasn't
    // opted into drag-pan; pan is always reachable via Space or middle-mouse.
    const panGesture =
      middle || spacePan || (e.button === 0 && nav.dragPanEnabled && !e.shiftKey)
    if (!panGesture) {
      const rect = e.currentTarget.getBoundingClientRect()
      const pt = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)
      rubberRef.current = { startX: pt.x, startY: pt.y, pointerId: e.pointerId }
      lastHitsRef.current = ''
      setRubberRect({ x: pt.x, y: pt.y, w: 0, h: 0 })
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // pointer capture unsupported — marquee still works while over the surface
      }
      return
    }
    if (middle || spacePan) e.preventDefault() // pan via middle/space: stop autoscroll + page scroll
    panLastMoveRef.current = { x: e.clientX, y: e.clientY, t: performance.now() }
    panDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: panX,
      startPanY: panY,
      moved: false,
      pointerId: e.pointerId
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // pointer capture unsupported — drag still works while over the surface
    }
    setGrabbing(true)
    if (nav.sonarOnGrab) {
      sonarPing()
      // Surface-relative coords so the ring positions correctly regardless of
      // any transformed ancestor (position:absolute inside dropRef).
      const rect = e.currentTarget.getBoundingClientRect()
      setPanPing({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      if (panPingTimer.current !== null) window.clearTimeout(panPingTimer.current)
      panPingTimer.current = window.setTimeout(() => setPanPing(null), 650)
    }
  }

  function handleCanvasPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const rub = rubberRef.current
    if (rub) {
      const rect = e.currentTarget.getBoundingClientRect()
      const pt = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)
      const x = Math.min(rub.startX, pt.x)
      const y = Math.min(rub.startY, pt.y)
      const w = Math.abs(pt.x - rub.startX)
      const h = Math.abs(pt.y - rub.startY)
      setRubberRect({ x, y, w, h })
      // Live hit-test in canvas space — highlight everything the box overlaps.
      const hits = selectableWidgets()
        .filter(
          (wd) => x < wd.x + wd.width && x + w > wd.x && y < wd.y + wd.height && y + h > wd.y
        )
        .map((wd) => wd.id)
      const key = hits.slice().sort().join(',')
      if (key !== lastHitsRef.current) {
        lastHitsRef.current = key
        setSelection(hits)
      }
      return
    }
    const d = panDragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true
    setPan(d.startPanX + dx * nav.dragSensitivity, d.startPanY + dy * nav.dragSensitivity)
    // Track smoothed velocity (normalised to ~16ms frames) for release inertia.
    const last = panLastMoveRef.current
    const now = performance.now()
    if (last) {
      const mdt = Math.max(1, now - last.t)
      const fvx = ((e.clientX - last.x) / mdt) * 16
      const fvy = ((e.clientY - last.y) / mdt) * 16
      // Weight the most-recent sample heavily so a fast flick's peak speed
      // carries into the release (less smoothing = punchier slingshot).
      panVelocityRef.current = {
        vx: panVelocityRef.current.vx * 0.35 + fvx * 0.65,
        vy: panVelocityRef.current.vy * 0.35 + fvy * 0.65
      }
    }
    panLastMoveRef.current = { x: e.clientX, y: e.clientY, t: now }
  }

  function handleCanvasPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const rub = rubberRef.current
    if (rub) {
      try {
        e.currentTarget.releasePointerCapture(rub.pointerId)
      } catch {
        // ignore
      }
      rubberRef.current = null
      setRubberRect(null)
      // Selection was set live during the move. A shift-click that never moved
      // leaves the (empty) selection as-is.
      return
    }
    const d = panDragRef.current
    if (!d) return
    panDragRef.current = null
    setGrabbing(false)
    try {
      e.currentTarget.releasePointerCapture(d.pointerId)
    } catch {
      // ignore
    }
    // A press with no drag behaves like a bare-canvas click (idempotent with
    // onClick, which may not fire reliably after a pointer-capture sequence).
    if (!d.moved) {
      const target = e.target as HTMLElement
      if (target.dataset.bareCanvas !== undefined) {
        if (activeId !== null) setActive(null)
        clearSelection() // click empty space → drop the selection
      }
      return
    }
    // Release inertia: slingshot in the drag direction, then decelerate to a
    // stop. slingshot × sensitivity multiply the release speed so a flick
    // coasts past the cursor; glide (friction) sets how long it keeps moving.
    // All user-configurable in Settings → Navigation.
    if (!nav.momentumEnabled) return
    const launch = nav.slingshot * nav.dragSensitivity
    const MAX_LAUNCH = 160 // px/frame
    let vx = Math.max(-MAX_LAUNCH, Math.min(MAX_LAUNCH, panVelocityRef.current.vx * launch))
    let vy = Math.max(-MAX_LAUNCH, Math.min(MAX_LAUNCH, panVelocityRef.current.vy * launch))
    if (Math.hypot(vx, vy) > 1.2) {
      const friction = frictionFromGlide(nav.glide)
      const step = (): void => {
        panBy(vx, vy)
        vx *= friction
        vy *= friction
        if (Math.hypot(vx, vy) > 0.4) {
          panInertiaRaf.current = requestAnimationFrame(step)
        } else {
          panInertiaRaf.current = null
        }
      }
      panInertiaRaf.current = requestAnimationFrame(step)
    }
  }

  function handleCanvasContextMenu(e: React.MouseEvent<HTMLDivElement>): void {
    const target = e.target as HTMLElement
    // Only open our menu on bare-canvas clicks; widgets/webviews handle their own context menus
    if (target.dataset.bareCanvas === undefined) return
    e.preventDefault()
    const rect = dropRef.current?.getBoundingClientRect()
    if (!rect) return
    const canvasPt = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)
    setCtxMenu({
      screenX: e.clientX,
      screenY: e.clientY,
      canvasX: canvasPt.x,
      canvasY: canvasPt.y
    })
  }

  async function placeWidgetAtCanvas(
    entry: WidgetCatalogEntry,
    canvasX: number,
    canvasY: number
  ): Promise<void> {
    if (!activeTaskId) return
    // Office documents go through a chooser (create new / import a real Office
    // file / place an existing one) rather than dropping a blank widget.
    if (entry.kind === 'doc' || entry.kind === 'sheet' || entry.kind === 'slides') {
      setOfficeAdd({ entry, x: canvasX, y: canvasY })
      return
    }
    await createWidget({
      taskId: activeTaskId,
      kind: entry.kind,
      content: entry.defaultContent,
      x: Math.round(canvasX - entry.defaultWidth / 2),
      y: Math.round(canvasY - 20),
      width: entry.defaultWidth,
      height: entry.defaultHeight,
      color: entry.kind === 'sticky' ? '#fef08a' : null
    })
  }

  // Create an office-document widget pointing at an already-resolved document id
  // (from create-new / import / select-existing in the add dialog).
  async function createOfficeWidget(documentId: string): Promise<void> {
    const add = officeAdd
    if (!activeTaskId || !add) return
    setOfficeAdd(null)
    await createWidget({
      taskId: activeTaskId,
      kind: add.entry.kind,
      content: documentId,
      x: Math.round(add.x - add.entry.defaultWidth / 2),
      y: Math.round(add.y - 20),
      width: add.entry.defaultWidth,
      height: add.entry.defaultHeight,
      color: null
    })
  }

  async function groupByType(useStacks: boolean): Promise<void> {
    if (!activeTaskId) return
    const topLevel = widgets.filter(
      (w) => !w.parentSectionId && w.kind !== 'section' && !w.pinned
    )
    if (topLevel.length === 0) return
    const byKind = new Map<WidgetKind, Widget[]>()
    for (const w of topLevel) {
      const list = byKind.get(w.kind) ?? []
      list.push(w)
      byKind.set(w.kind, list)
    }
    const layout: SectionLayout = useStacks ? 'stacks' : 'grid'
    const PADDING = 80
    const GAP = 40

    // Pre-compute frames for each new section
    const newSections: Array<{
      items: Widget[]
      frame: { width: number; height: number }
      color: string
      title: string
    }> = []
    for (const [kind, items] of byKind) {
      if (items.length === 0) continue
      const entry = catalogFor(kind)
      const cat: WidgetCategory = entry?.category ?? 'Notes'
      const synthetic: Widget[] = items.map((w) => ({
        ...w,
        parentSectionId: 'tmp',
        x: 0,
        y: 0
      }))
      const frame = computeSectionFrame(synthetic, layout)
      newSections.push({
        items,
        frame,
        color: CATEGORY_COLOR[cat],
        title: entry?.label ?? kind
      })
    }
    if (newSections.length === 0) return

    // Place new sections BELOW existing sections (avoid overlap with anything already on canvas)
    const existingSections = widgets.filter((w) => w.kind === 'section' && !w.pinned)
    let startY = PADDING
    if (existingSections.length > 0) {
      const existingBottom = existingSections.reduce((maxY, s) => {
        const sChildren = widgets.filter((c) => c.parentSectionId === s.id)
        const sFrame = computeSectionFrame(sChildren, effectiveLayout(s.layout))
        return Math.max(maxY, s.y + sFrame.height)
      }, 0)
      startY = existingBottom + GAP
    }

    // Flex-wrap using visible canvas width as the row limit
    const rect = dropRef.current?.getBoundingClientRect()
    const visibleW = rect ? rect.width / zoom : 1800
    const ROW_LIMIT_X = PADDING + visibleW
    let cursorX = PADDING
    let cursorY = startY
    let rowMaxH = 0

    for (const ns of newSections) {
      if (cursorX !== PADDING && cursorX + ns.frame.width > ROW_LIMIT_X) {
        cursorX = PADDING
        cursorY += rowMaxH + GAP
        rowMaxH = 0
      }
      const section = await createWidget({
        taskId: activeTaskId,
        kind: 'section',
        title: ns.title,
        content: '',
        x: cursorX,
        y: cursorY,
        width: ns.frame.width,
        height: ns.frame.height,
        color: ns.color
      })
      await updateWidget(section.id, { layout })
      for (const w of ns.items) {
        await updateWidget(w.id, { parentSectionId: section.id, x: 0, y: 0 })
      }
      cursorX += ns.frame.width + GAP
      rowMaxH = Math.max(rowMaxH, ns.frame.height)
    }
    bumpLayoutVersion()
  }

  function buildCtxMenu(): CtxMenuItem[] {
    if (!ctxMenu || !activeTaskId) return []
    const cx = ctxMenu.canvasX
    const cy = ctxMenu.canvasY
    // Consolidated to match the widget palette: core widgets grouped by category,
    // then a single "Advanced" group for the powerful-but-intimidating kinds
    // (agents, webhooks, diagram, mindmap, …), instead of the old flat everything-
    // per-category list. Each item is capability-gated the same way the palette is:
    // a Pro-locked kind prompts to upgrade rather than silently creating.
    const grouped = entriesByCategory()
    const addObject = (entry: WidgetCatalogEntry): void => {
      if (!canCreateWidget(caps, entry.kind)) {
        promptUpgrade(`The ${entry.label} widget is a Pro feature.`)
        return
      }
      void placeWidgetAtCanvas(entry, cx, cy)
    }
    const toItem = (entry: WidgetCatalogEntry): CtxMenuItem => ({
      label: entry.label,
      icon: entry.icon,
      onClick: () => addObject(entry)
    })
    const coreGroups: CtxMenuItem[] = CATEGORIES.map((cat) => ({
      label: cat,
      icon: CATEGORY_ICON[cat],
      children: grouped[cat].filter((e) => !isAdvancedKind(e.kind)).map(toItem)
    })).filter((group) => (group.children?.length ?? 0) > 0)
    // Advanced kinds across every category, kept individually selectable (diagram +
    // mindmap must stay distinct from the base Map, per the catalog rationale).
    const advancedEntries = CATEGORIES.flatMap((cat) =>
      grouped[cat].filter((e) => isAdvancedKind(e.kind))
    )
    const advancedGroup: CtxMenuItem[] =
      advancedEntries.length > 0
        ? [{ label: 'Advanced', icon: 'tune', children: advancedEntries.map(toItem) }]
        : []
    const addWidget: CtxMenuItem = {
      label: 'Add object',
      icon: 'add',
      children: [...coreGroups, ...advancedGroup]
    }
    const arrange: CtxMenuItem = {
      label: 'Auto-arrange',
      icon: 'view_module',
      children: [
        {
          label: 'Group by type',
          icon: 'workspaces',
          onClick: () => void groupByType(false)
        },
        {
          label: 'Stack by type',
          icon: 'layers',
          onClick: () => void groupByType(true)
        }
        // DEC-038: the Tidy submenu used to live here. It now exists ONLY in
        // the top pill, where its modes are offered as icons — one home for
        // one concept, instead of the same list in two places.
      ]
    }
    return [
      addWidget,
      { separator: true },
      arrange,
      { separator: true },
      {
        label: 'Home — fit all to view',
        icon: 'home',
        shortcut: '⌘H',
        onClick: () => centerOnHome()
      },
      {
        label: 'Reset view',
        icon: 'center_focus_strong',
        shortcut: '⌘0',
        onClick: () => resetView()
      },
      { separator: true },
      {
        // Per-device layout customisation (PLX-APP-010 Phase 2, ADR-0006). Off by
        // default: the Desk follows the shared arrangement. On: this device keeps
        // its own object positions and sizes, private to this user, and they are
        // restored on reopen. A checkbox icon signals the toggle state.
        label: customLayout
          ? "Stop customising this device's layout"
          : "Customise this device's layout",
        icon: customLayout ? 'check_box' : 'check_box_outline_blank',
        onClick: () => void setDeskCustomLayout(!customLayout)
      }
    ]
  }

  async function placeWidget(entry: WidgetCatalogEntry, x: number, y: number): Promise<void> {
    if (!activeTaskId) return
    await createWidget({
      taskId: activeTaskId,
      kind: entry.kind,
      content: entry.defaultContent,
      x: Math.round(x),
      y: Math.round(y),
      width: entry.defaultWidth,
      height: entry.defaultHeight,
      color: entry.kind === 'sticky' ? '#fef08a' : null
    })
  }

  function handleClickAdd(entry: WidgetCatalogEntry): void {
    // Snap the new widget beside the last-touched widget (right, else left),
    // falling back to the centre of the current viewport. Replaces the old
    // centre-plus-jitter drop that often landed off-screen.
    const { x, y } = spawnPositionFor(entry.defaultWidth, entry.defaultHeight)
    // Office documents go through the chooser (create new / import / place an
    // existing one) rather than dropping a blank widget — same as the right-click
    // add path. Convert the top-left spawn point to the centre point the chooser
    // expects (createOfficeWidget subtracts width/2 and 20).
    if (activeTaskId && (entry.kind === 'doc' || entry.kind === 'sheet' || entry.kind === 'slides')) {
      setOfficeAdd({ entry, x: x + entry.defaultWidth / 2, y: y + 20 })
      return
    }
    void placeWidget(entry, x, y)
  }

  // Keep the quick-add keyboard shortcut pointed at the live add handler, so a
  // single key (S, N, T, …) spawns through the exact same path as the picker.
  quickAddRef.current = (kind: WidgetKind): void => {
    const entry = catalogFor(kind)
    if (entry) handleClickAdd(entry)
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>): void {
    const types = Array.from(e.dataTransfer.types)
    if (
      types.includes(DRAG_MIME) ||
      types.includes('text/fb-task-link') ||
      types.includes(CONNECTED_APP_DRAG_MIME) ||
      types.includes('Files') ||
      // A tab or link dragged from an external browser. text/uri-list is the
      // precise signal; text/plain is the fallback some browsers use. Accepting
      // the drag here (preventDefault) is what stops the OS default of trying
      // to navigate the app window to the dropped URL.
      types.includes('text/uri-list') ||
      types.includes('text/plain')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>): Promise<void> {
    // OS file drop (drag from Finder) — spawn one file widget per dropped file.
    // We use ingestBuffer because Electron 32+ stripped File.path; reading via
    // arrayBuffer is the supported path and works for any file size up to the
    // renderer's memory budget.
    if (e.dataTransfer.files.length > 0 && activeTaskId) {
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const cursor = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)
      const entry = catalogFor('file')
      const width = entry?.defaultWidth ?? 360
      const height = entry?.defaultHeight ?? 280
      let offset = 0
      const filesArray = Array.from(e.dataTransfer.files)
      for (const f of filesArray) {
        const buffer = await f.arrayBuffer()
        const ingested = await window.api.files.ingestBuffer({
          buffer,
          originalName: f.name,
          mimeType: f.type || 'application/octet-stream'
        })
        await createWidget({
          taskId: activeTaskId,
          kind: 'file',
          title: f.name,
          content: ingested.id,
          x: Math.round(cursor.x - width / 2 + offset),
          y: Math.round(cursor.y - 20 + offset),
          width,
          height,
          color: null
        })
        offset += 24 // cascade subsequent drops slightly so they don't stack exactly
      }
      return
    }
    // Dragged Connected App from sidebar → spawn a webview widget bound to it.
    // Bound widgets share the app's session partition (so logged-in cookies
    // persist between full-pane view and canvas widget) and inherit its vault
    // auto-fill binding. This MUST be checked before the generic URL branch
    // below: a connected-app drag also carries the app's URL on text/plain /
    // text/uri-list as a fallback, so if the URL branch ran first it would
    // consume the drop and spawn an unbound webview (losing sourceAppId).
    const connectedAppId = e.dataTransfer.getData(CONNECTED_APP_DRAG_MIME)
    if (connectedAppId && activeTaskId) {
      e.preventDefault()
      const appsState = useConnectedAppsStore.getState()
      const app = appsState.apps.find((a) => a.id === connectedAppId) ?? null
      if (!app) return
      // Local apps can't render inside a <webview> — spawn a launcher tile
      // instead. Web apps get the existing webview widget with session sharing.
      const kind = app.kind === 'local' ? 'local-app-launcher' : 'webview'
      const entry = catalogFor(kind)
      const width = entry?.defaultWidth ?? (kind === 'local-app-launcher' ? 200 : 560)
      const height = entry?.defaultHeight ?? (kind === 'local-app-launcher' ? 120 : 400)
      const rect = e.currentTarget.getBoundingClientRect()
      const cursor = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)
      await createWidget({
        taskId: activeTaskId,
        kind,
        title: app.title,
        content: kind === 'webview' ? app.url : '',
        x: Math.round(cursor.x - width / 2),
        y: Math.round(cursor.y - 20),
        width,
        height,
        color: null,
        sourceAppId: app.id
      })
      void appsState.touch(app.id)
      return
    }
    // External browser tab or link drop. Dragging a tab out of Chrome / Edge /
    // Safari (or a link) puts the URL on text/uri-list, with text/plain as a
    // fallback. Open it as a browser (webview) widget at the cursor, mirroring
    // the file-drop behaviour. Read uri-list first because that is the precise
    // type a dragged tab provides, and only accept real http(s) URLs so a stray
    // text drag does nothing. This is the GENERIC fallback, so it runs after the
    // specific connected-app branch above (which also carries a URL fallback).
    if (activeTaskId) {
      const droppedUrl =
        firstHttpUrl(e.dataTransfer.getData('text/uri-list')) ??
        firstHttpUrl(e.dataTransfer.getData('text/plain'))
      if (droppedUrl) {
        e.preventDefault()
        const entry = catalogFor('webview')
        const width = entry?.defaultWidth ?? 560
        const height = entry?.defaultHeight ?? 400
        const rect = e.currentTarget.getBoundingClientRect()
        const cursor = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)
        await createWidget({
          taskId: activeTaskId,
          kind: 'webview',
          title: '',
          content: droppedUrl,
          x: Math.round(cursor.x - width / 2),
          y: Math.round(cursor.y - 20),
          width,
          height,
          color: null
        })
        return
      }
    }
    // Dragged task from sidebar → spawn a task-link widget
    const taskId = e.dataTransfer.getData('text/fb-task-link')
    if (taskId && activeTaskId && taskId !== activeTaskId) {
      e.preventDefault()
      const entry = catalogFor('task-link')
      if (!entry) return
      const rect = e.currentTarget.getBoundingClientRect()
      const cursor = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)
      await createWidget({
        taskId: activeTaskId,
        kind: 'task-link',
        title: '',
        content: taskId,
        x: Math.round(cursor.x - entry.defaultWidth / 2),
        y: Math.round(cursor.y - 20),
        width: entry.defaultWidth,
        height: entry.defaultHeight,
        color: null
      })
      return
    }
    // Standard palette → widget drop
    const kind = e.dataTransfer.getData(DRAG_MIME) as WidgetKind
    if (!kind) return
    e.preventDefault()
    const entry = catalogFor(kind)
    if (!entry) return
    const rect = e.currentTarget.getBoundingClientRect()
    const cursor = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top)
    void placeWidget(entry, cursor.x - entry.defaultWidth / 2, cursor.y - 20)
  }

  // Spawn a browser (webview) widget for a standard app — used by the starting
  // kit's "open a browser" quick-adds. Staggered so multiple don't stack.
  async function addBrowserApp(app: StandardApp): Promise<void> {
    if (!activeTaskId) return
    const entry = catalogFor('webview')
    const n = useWidgetStore.getState().widgets.filter((w) => !w.pinned).length
    await createWidget({
      taskId: activeTaskId,
      kind: 'webview',
      title: app.title,
      content: app.url,
      x: 60 + (n % 5) * 36,
      y: 60 + (n % 5) * 36,
      width: entry?.defaultWidth ?? 520,
      height: entry?.defaultHeight ?? 360
    })
  }

  // AI Builder accept path. Distinct from handleAISetupAccept because each
  // suggestion can carry a richer payload (table schema, Tiptap doc, field
  // def) that needs translating into the corresponding storage layer before
  // the widget can be spawned.
  async function handleAiBuilderAccept(suggestions: AiBuildSuggestion[]): Promise<void> {
    if (!activeTaskId || !dropRef.current) return
    const rect = dropRef.current.getBoundingClientRect()
    const visibleW = rect.width / zoom
    const PADDING = 60
    const GAP = 24
    const existing = widgets.filter((w) => !w.pinned && !w.parentSectionId)
    const startBelow = existing.reduce((maxY, w) => {
      let h = w.height
      if (w.kind === 'section') {
        const ch = widgets.filter((c) => c.parentSectionId === w.id)
        const fr = computeSectionFrame(ch, effectiveLayout(w.layout))
        h = fr.height
      }
      return Math.max(maxY, w.y + h)
    }, 0)
    let cursorX = PADDING
    let cursorY = existing.length > 0 ? startBelow + 40 : PADDING
    let rowMaxH = 0
    // Undo parity: wrap the AI-spawned build in one action-history batch so it
    // reverses with a single Cmd+Z, like a ProposalCards "Apply all" (createWidget
    // records into the active batch). Was previously un-undoable.
    const hist = useActionHistory.getState()
    hist.beginBatch()
    try {
    for (const s of suggestions) {
      const entry = catalogFor(s.kind)
      const w = entry?.defaultWidth ?? 300
      const h = entry?.defaultHeight ?? 200
      if (cursorX !== PADDING && cursorX + w > PADDING + visibleW) {
        cursorX = PADDING
        cursorY += rowMaxH + GAP
        rowMaxH = 0
      }
      // Per-kind translation: turn the suggestion's payload into the
      // widget.content + any backing entity (e.g. fb_tables row).
      let content = s.content ?? ''
      let title = s.title || ''
      if (s.kind === 'table' && s.tableSchema) {
        // Provision the backing table now so widget.content is the table id.
        // The AI returned columns in the shared FieldDefinition shape; we
        // trust the structure but the IPC layer would defensively reject
        // unknown column types.
        try {
          const created = await window.api.tables.create({
            taskId: activeTaskId,
            title: s.title || 'Untitled',
            schema: {
              columns: s.tableSchema.columns.map((c) => ({
                id: c.id,
                type: c.type,
                label: c.label,
                config: c.config
              })) as never
            }
          })
          content = created.id
        } catch {
          // Fall through: spawn an empty table widget that will auto-
          // provision its own schema on first render.
          content = ''
        }
      } else if (s.kind === 'page' && s.pageContent) {
        // Tiptap stores its content as a JSON object; we serialize so the
        // existing widget.content string field can carry it.
        content = JSON.stringify(s.pageContent)
      } else if (s.kind === 'field' && s.fieldDef) {
        // The FieldWidget reads content as `{ def, value }` JSON; we wrap
        // the AI-provided def with a defaultValue for its type. Type isn't
        // fully validated here — the FieldWidget's switch will gracefully
        // show "unsupported field" if the AI returns a type we don't render.
        content = JSON.stringify({
          def: s.fieldDef,
          // We can't import defaultValue from @shared/fields without making
          // Canvas.tsx aware of every field type — but the FieldWidget
          // handles a null/missing value by substituting the default itself.
          value: null
        })
        title = s.fieldDef.label || s.title
      }
      await createWidget({
        taskId: activeTaskId,
        kind: s.kind,
        title,
        content,
        x: Math.round(cursorX),
        y: Math.round(cursorY),
        width: w,
        height: h,
        color: s.kind === 'sticky' ? '#fef08a' : null
      })
      cursorX += w + GAP
      rowMaxH = Math.max(rowMaxH, h)
    }
    } finally {
      hist.endBatch(`Add ${suggestions.length} object${suggestions.length === 1 ? '' : 's'} from Build with AI`)
    }
    chimeIn()
    bumpLayoutVersion()
    setTimeout(() => centerOnHome(), 100)
  }

  async function handleAISetupAccept(suggestions: WidgetSuggestion[]): Promise<void> {
    if (!activeTaskId || !dropRef.current) return
    const rect = dropRef.current.getBoundingClientRect()
    const visibleW = rect.width / zoom
    const PADDING = 60
    const GAP = 24
    // Find a starting Y below existing canvas content so we don't overlap
    const existing = widgets.filter((w) => !w.pinned && !w.parentSectionId)
    const startBelow = existing.reduce((maxY, w) => {
      let h = w.height
      if (w.kind === 'section') {
        const ch = widgets.filter((c) => c.parentSectionId === w.id)
        const fr = computeSectionFrame(ch, effectiveLayout(w.layout))
        h = fr.height
      }
      return Math.max(maxY, w.y + h)
    }, 0)
    let cursorX = PADDING
    let cursorY = existing.length > 0 ? startBelow + 40 : PADDING
    let rowMaxH = 0
    // Undo parity: wrap the AI-spawned build in one action-history batch so it
    // reverses with a single Cmd+Z, like a ProposalCards "Apply all" (createWidget
    // records into the active batch). Was previously un-undoable.
    const hist = useActionHistory.getState()
    hist.beginBatch()
    try {
    for (const s of suggestions) {
      const entry = catalogFor(s.kind)
      const w = entry?.defaultWidth ?? 300
      const h = entry?.defaultHeight ?? 200
      if (cursorX !== PADDING && cursorX + w > PADDING + visibleW) {
        cursorX = PADDING
        cursorY += rowMaxH + GAP
        rowMaxH = 0
      }
      await createWidget({
        taskId: activeTaskId,
        kind: s.kind,
        title: s.title || '',
        content: s.content || (entry?.defaultContent ?? ''),
        x: Math.round(cursorX),
        y: Math.round(cursorY),
        width: w,
        height: h,
        color: s.kind === 'sticky' ? '#fef08a' : null
      })
      cursorX += w + GAP
      rowMaxH = Math.max(rowMaxH, h)
    }
    } finally {
      hist.endBatch(`Add ${suggestions.length} object${suggestions.length === 1 ? '' : 's'} from AI Setup`)
    }
    chimeIn()
    bumpLayoutVersion()
    // Pan/zoom so the freshly spawned widgets land in view
    setTimeout(() => centerOnHome(), 100)
  }

  async function handleAutoArrange(opts: TidyOptions = { mode: 'flow' }): Promise<void> {
    if (widgets.length === 0 || !dropRef.current) return
    const rect = dropRef.current.getBoundingClientRect()
    const visibleW = rect.width / zoom
    const PADDING = 60
    const GAP = 40
    const catOrder: Record<WidgetCategory, number> = {
      Notes: 0,
      Web: 1,
      Files: 2,
      Tools: 3,
      Comms: 4,
      Layout: 5
    }

    type LayoutItem = {
      id: string
      w: number
      h: number
      catRank: number
      createdAt: number
    }
    const items: LayoutItem[] = []
    for (const w of widgets) {
      if (w.pinned) continue
      if (w.parentSectionId) continue
      let width = w.width
      let height = w.height
      if (w.kind === 'section') {
        const sChildren = widgets.filter((c) => c.parentSectionId === w.id)
        const frame = computeSectionFrame(sChildren, effectiveLayout(w.layout))
        width = frame.width
        height = frame.height
      }
      items.push({
        id: w.id,
        w: width,
        h: height,
        catRank: catOrder[catalogFor(w.kind)?.category ?? 'Notes'],
        createdAt: w.createdAt
      })
    }
    if (items.length === 0) return

    // Baseline ordering: by category, then creation time.
    const composite = (it: LayoutItem): number => it.catRank * 1e16 + it.createdAt

    // Cluster linked widgets: widgets joined by connector lines should land next
    // to each other so the wires stay short and local instead of arcing across
    // the canvas over unrelated widgets. Compute connected components over the
    // link graph (union-find), then order so each component's members are
    // contiguous, components ordered by their earliest baseline member.
    const idIndex = new Map(items.map((it, i) => [it.id, i]))
    const parent = items.map((_, i) => i)
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]]
        i = parent[i]
      }
      return i
    }
    const union = (a: number, b: number): void => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent[ra] = rb
    }
    for (const l of useLinksStore.getState().links) {
      const ai = idIndex.get(l.sourceWidgetId)
      const bi = idIndex.get(l.targetWidgetId)
      if (ai !== undefined && bi !== undefined) union(ai, bi)
    }
    // Each component's sort key is the smallest composite among its members, so
    // a cluster sits where its earliest member would have gone.
    const compKey = new Map<number, number>()
    items.forEach((it, i) => {
      const root = find(i)
      const c = composite(it)
      const prev = compKey.get(root)
      if (prev === undefined || c < prev) compKey.set(root, c)
    })
    items.sort((a, b) => {
      const ia = idIndex.get(a.id)!
      const ib = idIndex.get(b.id)!
      const ka = compKey.get(find(ia))!
      const kb = compKey.get(find(ib))!
      if (ka !== kb) return ka - kb // different cluster → order by cluster
      return composite(a) - composite(b) // same cluster → baseline order within
    })

    // `items` is already ordered (category baseline + linked-cluster contiguity);
    // the chosen mode only decides the geometry. Linked widgets therefore stay
    // adjacent in every mode, so wires stay short.
    const placed = tidyPositions(
      items.map((it) => ({ id: it.id, w: it.w, h: it.h })),
      opts,
      visibleW,
      GAP,
      PADDING
    )
    // Tidy also resizes widgets to fill the gaps its layout leaves, so there is
    // no wasted space. A section is never resized here — it auto-sizes to its
    // children, so forcing a cell size on it would fight that.
    const sectionIds = new Set(widgets.filter((w) => w.kind === 'section').map((w) => w.id))
    for (const p of placed) {
      const patch: { x: number; y: number; width?: number; height?: number } = { x: p.x, y: p.y }
      if (!sectionIds.has(p.id)) {
        if (typeof p.w === 'number') patch.width = p.w
        if (typeof p.h === 'number') patch.height = p.h
      }
      await updateWidget(p.id, patch)
    }
    bumpLayoutVersion()
  }

  if (!activeTask) {
    // No desk open: show a gallery of the org's desks (each a canvas) to open,
    // rather than a singular "your desk is clear" dead-end.
    return (
      <>
        <DeskGallery />
        <WidgetFocusMode />
      </>
    )
  }

  const status = STATUS_META[activeTask.status]

  // Task time tracking
  const totalEstimateMin =
    (activeTask.estimateMinutes ?? 0) + (activeTask.extensionsMinutes ?? 0)
  const isTracked =
    activeTask.status === 'in_progress' &&
    !!activeTask.estimateMinutes &&
    !!activeTask.startedAt
  const elapsedMs =
    isTracked && activeTask.startedAt ? Date.now() - activeTask.startedAt : 0
  const elapsedMin = elapsedMs / 60000
  const remainingMin = isTracked ? totalEstimateMin - elapsedMin : 0
  const isOverdue = isTracked && remainingMin < 0
  const showExtensionPrompt = isOverdue && Date.now() > snoozeUntil

  function fmtMin(min: number): string {
    const abs = Math.abs(min)
    const m = Math.floor(abs)
    const s = Math.floor((abs - m) * 60)
    const sign = min < 0 ? '-' : ''
    return `${sign}${m}:${s.toString().padStart(2, '0')}`
  }

  const timerText = isTracked ? fmtMin(remainingMin) : null

  async function handleDeskChat(): Promise<void> {
    if (!activeTask) return
    const convId = await resolveObjectChannel('desk', activeTask.id, activeTask.title || 'Desk')
    if (!convId) {
      void openObjectChannel('desk', activeTask.id, activeTask.title || 'Desk')
      return
    }
    const existing = widgets.find((w) => {
      if (w.kind !== 'chat-thread') return false
      try {
        return (JSON.parse(w.content || '{}') as { conversationId?: string }).conversationId === convId
      } catch {
        return false
      }
    })
    if (existing) {
      focusOn(existing.id)
      return
    }
    const entry = catalogFor('chat-thread')
    const pos = spawnPositionFor(entry?.defaultWidth ?? 340, entry?.defaultHeight ?? 460)
    await createWidget({
      taskId: activeTask.id,
      kind: 'chat-thread',
      title: activeTask.title || 'Desk chat',
      content: JSON.stringify({ conversationId: convId, channelName: activeTask.title || 'Desk' }),
      x: pos.x,
      y: pos.y,
      width: entry?.defaultWidth ?? 340,
      height: entry?.defaultHeight ?? 460,
      color: null
    })
  }

  return (
    <>
      <div className="h-full flex flex-col">
        <div
          ref={dropRef}
          data-bare-canvas
          data-canvas-surface="true"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onWheel={handleWheel}
          onClick={handleCanvasClick}
          onContextMenu={handleCanvasContextMenu}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          className="flex-1 relative overflow-hidden desk-paper no-static-pattern"
          style={
            {
              overscrollBehavior: 'none',
              cursor: grabbing ? 'grabbing' : spaceReady ? 'grab' : undefined,
              // Cell size for the .desk-pattern-layer child. Its coverage
              // inset is a constant in the stylesheet (one super-tile at
              // maximum zoom), so this variable changes a paint and never a
              // layout.
              '--fb-desk-zoom': patternZoom
            } as React.CSSProperties
          }
        >
          {/* Paper pattern on its own compositor layer. Panning only moves
              this div's transform (composited, no repaint); a zoom change is
              the only thing that re-rasterises the pattern at a new cell
              size. The offset wraps modulo one super-tile so it stays small.
              The container's own static pattern is suppressed via
              .no-static-pattern — static desk-paper surfaces (gallery,
              dialogs) keep their built-in pattern. */}
          <div
            aria-hidden
            className="desk-pattern-layer"
            style={{
              transform: `translate(${patternOffset(panX, zoom)}px, ${patternOffset(panY, zoom)}px)`
            }}
          />

          {/* Breadcrumb — floated top-left of the canvas surface so it
              sits on the desk itself rather than in a header bar above it. */}
          <div data-floating-menu className="fb-floating-chrome absolute top-4 left-[calc(var(--fb-dock-inset,0px)+1rem)] z-[45] flex items-center gap-2">
            <CanvasBreadcrumb
              activeTask={activeTask}
              trailing={activeTaskId && isCanvasMode ? <ViewSelector taskId={activeTaskId} /> : undefined}
              nodes={nodes}
              onOpenTask={(id) => setActiveTask(id)}
              onHome={() => setActiveTask(null)}
              fromMindmap={!!nodeOrigin}
              onRenameTask={(id, title) => void updateNode(id, { title })}
              onAssignToRoom={(deskId, roomId) => void assignToRoom(deskId, roomId)}
              onCreateRoomFromDesk={(deskId) => void createRoomAndAssign(deskId)}
            />
            {/* The breadcrumb selector shows only in canvas mode; every overlay
                view (columns + data views) carries its own in-view selector, so
                exactly one is present at a time (no duplicate testid). */}

          </div>
          {/* Context Health (plexi-4.0): floats just under the breadcrumb, showing
              what changed since last visit and related desks needing attention.
              Renders nothing when the desk is calm. */}
          {activeTask && (
            <div className="absolute top-16 left-4 z-[45]">
              <ContextHealthStrip deskId={activeTask.id} variant="chrome" />
            </div>
          )}
          {/* Screen-reader linear representation of the spatial canvas (PLX-A11Y-003):
              visually hidden, fully navigable, opens each object. */}
          <CanvasLinearView widgets={widgets} onOpen={(id) => focusOn(id)} deskTitle={activeTask?.title ?? null} />
          {panPing && (
            <div
              className="absolute pointer-events-none z-[200]"
              style={{ left: panPing.x, top: panPing.y, transform: 'translate(-50%, -50%)' }}
            >
              <span className="block h-10 w-10 rounded-full border-2 border-accent/70 animate-ping" />
              <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-accent shadow" />
            </div>
          )}
          {showStartingKit && nodeOrigin && activeTaskId && (
            <MindmapStartingKit
              taskId={activeTaskId}
              nodeLabel={nodeOrigin.nodeLabel}
              nodePath={nodeOrigin.nodePath}
              onAddWidgets={handleAiBuilderAccept}
              onAddBrowser={addBrowserApp}
              onDismiss={() => {
                if (activeTaskId) dismissKit(activeTaskId)
                setKitDismissTick((t) => t + 1)
              }}
            />
          )}
          {/* Marquee selection box — screen-space projection of the canvas-space
              rubber-band rect, so the marching ants stay 1px crisp at any zoom. */}
          {rubberRect && (
            <div
              className="fb-marquee absolute pointer-events-none z-[150]"
              style={{
                left: rubberRect.x * zoom + panX,
                top: rubberRect.y * zoom + panY,
                width: rubberRect.w * zoom,
                height: rubberRect.h * zoom
              }}
            />
          )}
          {/* Floating selection toolbar — appears above the selection's bounding
              box. Hidden mid-marquee and during a group drag (positions in flux). */}
          {selectionBBox && !rubberRect && !groupDragActive && (
            <div
              className="absolute z-[210]"
              style={{
                left: ((selectionBBox.minX + selectionBBox.maxX) / 2) * zoom + panX,
                top: selectionBBox.minY * zoom + panY - 12,
                transform: 'translate(-50%, -100%)'
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-0.5 rounded-full fb-glass-chrome border px-1.5 py-1 shadow-[var(--shadow-cast)] text-[var(--ink-100)]">
                <span className="px-2 text-[11px] font-medium tabular-nums whitespace-nowrap">
                  {selectionBBox.count} selected
                </span>
                <div className="h-4 w-px bg-[var(--edge-firm)]" />
                <button
                  onClick={() => void groupIntoSection()}
                  title="Group into a section"
                  className="h-7 px-2 inline-flex items-center gap-1 rounded-full hover:bg-[var(--surface-sunken)] text-[11px]"
                >
                  <Icon name="dashboard" size={13} />
                  <span>Group</span>
                </button>
                <button
                  onClick={() => void duplicateSelection()}
                  title="Duplicate all selected"
                  aria-label="Duplicate selected"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-[var(--surface-sunken)]"
                >
                  <Icon name="content_copy" size={13} />
                </button>
                <button
                  onClick={() => void deleteSelection()}
                  title="Delete all selected"
                  aria-label="Delete selected"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-rose-500/15 text-rose-500"
                >
                  <Icon name="delete" size={13} />
                </button>
                {/* Align + distribute the selection (needs 2+ to align, 3+ to
                    distribute). Each is a single undo step. */}
                {selectionBBox.count >= 2 && (
                  <>
                    <div className="h-4 w-px bg-[var(--edge-firm)]" />
                    {(
                      [
                        ['left', 'align_horizontal_left', 'Align left'],
                        ['center-h', 'align_horizontal_center', 'Align centre (horizontal)'],
                        ['right', 'align_horizontal_right', 'Align right'],
                        ['top', 'align_vertical_top', 'Align top'],
                        ['center-v', 'align_vertical_center', 'Align centre (vertical)'],
                        ['bottom', 'align_vertical_bottom', 'Align bottom']
                      ] as Array<[AlignMode, string, string]>
                    ).map(([mode, icon, label]) => (
                      <button
                        key={mode}
                        onClick={() => alignSelection(mode)}
                        title={label}
                        aria-label={label}
                        className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-[var(--surface-sunken)]"
                      >
                        <Icon name={icon} size={13} />
                      </button>
                    ))}
                    {selectionBBox.count >= 3 && (
                      <>
                        <button
                          onClick={() => distributeSelection('horizontal')}
                          title="Distribute horizontally (equal gaps)"
                          aria-label="Distribute horizontally"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-[var(--surface-sunken)]"
                        >
                          <Icon name="horizontal_distribute" size={13} />
                        </button>
                        <button
                          onClick={() => distributeSelection('vertical')}
                          title="Distribute vertically (equal gaps)"
                          aria-label="Distribute vertically"
                          className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-[var(--surface-sunken)]"
                        >
                          <Icon name="vertical_distribute" size={13} />
                        </button>
                      </>
                    )}
                  </>
                )}
                <div className="h-4 w-px bg-[var(--edge-firm)]" />
                <button
                  onClick={() => clearSelection()}
                  title="Clear selection (Esc)"
                  aria-label="Clear selection"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-[var(--surface-sunken)]"
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          )}
          {widgets.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="fb-glass-panel rounded-full px-4 py-2 inline-flex items-center gap-2 text-[var(--ink-50)]">
                <Icon name="widgets" size={16} />
                <p className="text-sm">Drag an object from the palette onto the desk.</p>
              </div>
            </div>
          )}
          <LinkDragContext.Provider value={linkDragController}>
          <div
            data-bare-canvas
            className={`absolute top-0 left-0 will-change-transform ${
              animatingPan ? 'transition-transform duration-[280ms] ease-out' : ''
            }`}
            style={{
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
              transformOrigin: '0 0'
            }}
          >
            {/* Sections first (render behind non-section widgets). Sections render their own children.
                Skipped entirely in Columns view so canvas widgets (and their webviews) don't mount
                under the overlay. */}
            {isCanvasMode && widgets.map((w) => {
              if (w.archived) return null
              if (w.pinned || w.kind !== 'section') return null
              // PLX-APP-012: skip sections fully outside the viewport (a section is
              // exempt when it holds a linked child, so its children's links hold).
              if (visibleObjectIds && !visibleObjectIds.has(w.id)) return null
              return (
                <div key={w.id}>{renderWidget(w)}</div>
              )
            })}
            {isCanvasMode && widgets.map((w) => {
              if (w.archived) return null
              if (w.pinned || w.kind === 'section') return null
              if (w.parentSectionId !== null) return null // owned by a section, rendered inside it
              // For web kinds, fully UNMOUNT the focused widget so its unmount-flush
              // commits the latest URL before focus mode's separate WebViewWidget mounts.
              if (focusedId === w.id && isWebKind(w.kind)) return null
              // PLX-APP-012: skip Objects fully outside the viewport. Web kinds and
              // link/active/selected Objects are exempt (kept in visibleObjectIds),
              // so this only ever culls cheap, off-screen, unconnected Objects.
              if (visibleObjectIds && !visibleObjectIds.has(w.id)) return null
              return (
                <div key={w.id}>
                  {renderWidget(w)}
                </div>
              )
            })}
          </div>
          {deskViewMode === 'columns' && activeTaskId && (
            <div className="absolute inset-0 z-[60]">
              <ColumnsView taskId={activeTaskId} widgets={widgets} />
            </div>
          )}
          {dataLayout && activeTaskId && (
            <DeskDataViews taskId={activeTaskId} widgets={widgets} layout={dataLayout} />
          )}
          {/* Spatial-link overlay renders in screen-space, OUTSIDE the
              transformed container. It reads each linked widget's actual
              rendered position via getBoundingClientRect on every frame
              during a drag, so lines can never visually detach from the
              widget they're attached to. Widgets in sections, sections
              themselves, and pinned widgets are all valid link endpoints;
              arming from a section child is the one remaining exception. */}
          <LinkOverlay
            ghost={
              linkSourceId && ghostCursor
                ? {
                    fromWidgetId: linkSourceId,
                    cursorScreenX: ghostCursor.x,
                    cursorScreenY: ghostCursor.y
                  }
                : null
            }
            pendingPick={pendingLinkPick}
            onPendingPickDone={clearPendingLinkPick}
          />
          </LinkDragContext.Provider>
          {/* Pinned-widget layer: screen-space, in front of the transformed canvas.
              Zone-pinned widgets have their position computed here and provided
              via PinLayoutContext so any nested WidgetFrame can look up its
              docked rect without prop-drilling through every widget kind.
              It renders OUTSIDE the canvas's LinkDragContext.Provider (it's a
              screen-space sibling), so it needs its own provider wired to the
              same controller — otherwise pinned WidgetFrames read a null
              linkDrag and their "connect" hub button never appears, and a pinned
              widget can't be a link source (dropping onto one already works). */}
          <LinkDragContext.Provider value={linkDragController}>
            <PinnedLayer widgets={widgets} focusedId={focusedId} renderWidget={renderWidget} />
          </LinkDragContext.Provider>
          <FloatingToolbar
            onAddWidget={handleClickAdd}
            onImport={() => setSyncPickerOpen(true)}
            paletteDisabled={!activeTaskId}
            onHistory={() => setHistoryOpen(true)}
            historyDisabled={!activeTaskId}
            rightInset={toolbarRightInset}
            actions={(() => {
              // Quick-jump buttons for every section currently on the canvas
              const sections = widgets.filter((w) => w.kind === 'section' && !w.pinned)
              const sectionJumps: ToolbarAction[] = sections.map((s, idx) => {
                const entry = WIDGET_CATALOG.find((e) => e.label === s.title)
                return {
                  icon: entry?.icon ?? 'crop_free',
                  label: s.title || 'Section',
                  color: s.color ?? undefined,
                  onClick: () => focusOn(s.id),
                  separatorAfter: idx === sections.length - 1
                }
              })
              const staticActions: ToolbarAction[] = [
                {
                  icon: 'layers',
                  label: 'Stack by type',
                  onClick: () => void groupByType(true)
                },
                {
                  icon: 'grid_view',
                  label: 'Tile by type',
                  onClick: () => void groupByType(false),
                  separatorAfter: true
                },
                {
                  icon: 'auto_awesome',
                  label: 'Clean up',
                  onClick: () => void handleAutoArrange(),
                  separatorAfter: true
                },
                {
                  icon: 'home',
                  label: 'Home',
                  shortcut: '⌘H',
                  onClick: () => centerOnHome()
                },
                {
                  icon: 'center_focus_strong',
                  label: 'Reset view',
                  shortcut: '⌘0',
                  onClick: () => resetView()
                }
              ]
              return [...sectionJumps, ...staticActions]
            })()}
          />
          {/* Floating pill — draggable hub with desk state + quick actions +
              cognitive-load ring + canvas tools. Uses fixed positioning internally. */}
          {activeTaskId && (
            <FloatingPill
              onTidy={(opts) => void handleAutoArrange(opts)}
              tidyDisabled={!activeTaskId}
              onBuild={() => setShowAiBuilder(true)}
              onSaveTemplate={() => setSaveTemplateOpen({ context: 'toolbar' })}
              saveDisabled={!activeTaskId || savingTemplate}
              savingTemplate={savingTemplate}
              onResume={() => setShowResume(true)}
              onStatus={() => void updateNode(activeTask.id, { status: status.next })}
              statusLabel={status.label}
              statusIcon={status.icon}
              onFocus={() => {
                futuristicPowerOn()
                void startFocusSession(activeTask.id, 5 * 60, '5min')
              }}
              focusActive={focusSessionActive}
              onChat={() => void handleDeskChat()}
              onMeeting={() => void launchMeeting({ kind: 'desk', nodeId: activeTask.id, title: activeTask.title })}
              timerText={timerText}
              timerOverdue={isOverdue}
            />
          )}
          {/* Desk presence — who else is on this desk, floated top-right of canvas surface */}
          <div data-floating-menu className="fb-floating-chrome absolute top-3 right-3 z-[45] pointer-events-auto">
            <DeskPresenceBar taskId={activeTask.id} />
          </div>
          {activeId && !linkSourceId && (
            <div className="absolute bottom-3 left-[calc(50%+var(--fb-dock-inset,0px)/2)] -translate-x-1/2 px-2.5 py-1 rounded-full fb-glass-chrome border text-[11px] text-[var(--ink-90)] shadow-[var(--shadow-soft)] flex items-center gap-1.5 pointer-events-none">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
              <span>Widget active · click outside or press Esc to pan canvas</span>
            </div>
          )}
          {/* Edge-pan boundary indicators — subtle violet glow hugging
              each edge. Idle: faint breathing hairline so the user
              discovers the affordance. Active: brighter halo that
              matches the live mouse intensity from useEdgePan. Hidden
              while a widget is being edited (so editing UI isn't
              competing with ambient motion) — but EXPLICITLY shown
              again while the user is mid-drag, which is exactly when
              edge-pan matters most. */}
          <CanvasEdgeIndicators
            intensity={edgeIntensity}
            visible={!animatingPan}
          />
          {/* Minimap FAB — always-present in the canvas bottom-right. */}
          {activeTaskId && <CanvasMinimapFAB />}
          {/* Automations FAB — stacked above the minimap: the desk's "what runs
              on its own" list (reactive wires + agents) with on/off + jump-to. */}
          {activeTaskId && <AutomationsFAB />}
          {activeTaskId && <DeskSuggestionChip />}
          {/* Zoom + pan controls — bottom-left. Mirrors the 2.0 mockup. */}
          <ZoomControls />
          {/* The desk-scoped AI rail used to live here, which meant two AI panels
              showed at once (this one + the app-level Assistant). The assistant is
              now a single context-aware panel (ChatPanel in App.tsx) that adapts
              to the desk, so the duplicate canvas rail is removed. */}
          {linkSourceId && (() => {
            const src = widgets.find((w) => w.id === linkSourceId)
            const label = src?.title || src?.kind || 'widget'
            return (
              <div
                data-link-skip
                className="absolute top-3 left-[calc(50%+var(--fb-dock-inset,0px)/2)] -translate-x-1/2 px-3 py-1.5 rounded-full text-[11px] shadow-lg flex items-center gap-2 z-40"
                style={{
                  backgroundColor: 'rgb(var(--accent))',
                  color: 'white'
                }}
              >
                <Icon name="hub" size={13} />
                <span>
                  Linking from <strong className="font-semibold">{label}</strong> · click another widget to connect
                </span>
                <button
                  data-link-skip
                  onClick={(e) => {
                    e.stopPropagation()
                    setLinkSourceId(null)
                    setGhostCursor(null)
                  }}
                  className="ml-1 inline-flex items-center justify-center h-4 w-4 rounded-full hover:bg-white/20"
                  aria-label="Cancel linking"
                  title="Cancel (Esc)"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            )
          })()}
        </div>

      </div>
      <WidgetFocusMode />
      {saveTemplateOpen && activeTask && (
        <SaveTemplateDialog
          task={activeTask}
          context={saveTemplateOpen.context}
          onClose={() => setSaveTemplateOpen(null)}
        />
      )}
      {showAISetup && activeTask && (
        <AISetupDialog
          task={activeTask}
          onClose={() => setShowAISetup(false)}
          onAccept={handleAISetupAccept}
        />
      )}
      {showAiBuilder && (
        <AiBuilderDialog
          taskId={activeTaskId ?? null}
          onClose={() => setShowAiBuilder(false)}
          onAccept={handleAiBuilderAccept}
        />
      )}
      {syncPickerOpen && activeTaskId && (
        <SyncWidgetPicker targetTaskId={activeTaskId} onClose={() => setSyncPickerOpen(false)} />
      )}
      {historyOpen && activeTaskId && (
        <HistoryPanel taskId={activeTaskId} onClose={() => setHistoryOpen(false)} />
      )}
      {showResume && activeTask && (
        <ResumeModal task={activeTask} onClose={() => setShowResume(false)} />
      )}
      {officeAdd && (
        <OfficeDocAddDialog
          docType={officeAdd.entry.kind as 'doc' | 'sheet' | 'slides'}
          onPicked={(id) => void createOfficeWidget(id)}
          onClose={() => setOfficeAdd(null)}
        />
      )}
      {ctxMenu && (
        <CanvasContextMenu
          x={ctxMenu.screenX}
          y={ctxMenu.screenY}
          items={buildCtxMenu()}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {/* The single AI Assist preview for the unified context menu. Portals to
          body, so its placement in the tree does not matter. */}
      <AiAssistPreview />
      {/* The per-widget AI setup preview (Build with AI). Also body-portalled. */}
      <WidgetSetupPreview />
      {/* The unified menu for non-editable right-clicks inside browser widgets. */}
      <BrowserContextMenu />
      {showExtensionPrompt && (
        <ExtensionPrompt
          task={activeTask}
          elapsedMin={elapsedMin}
          totalEstimateMin={totalEstimateMin}
          onExtend={(min) => {
            void updateNode(activeTask.id, {
              extensionsMinutes: (activeTask.extensionsMinutes ?? 0) + min
            })
            setSnoozeUntil(0)
          }}
          onMarkDone={() => {
            void updateNode(activeTask.id, { status: 'done' })
            setSnoozeUntil(0)
          }}
          onSnooze={() => setSnoozeUntil(Date.now() + 5 * 60 * 1000)}
        />
      )}
    </>
  )
}

// ── Pinned-widget layer ─────────────────────────────────────────────────────
// Lives screen-space above the transformed canvas. Tracks its own bounding
// box (the main pane minus the canvas chrome) via ResizeObserver, then
// computes zone-pin positions for any widget with a pinnedZone set. The
// computed positions are dropped into a Map provided via PinLayoutContext so
// the deeply-nested WidgetFrame inside each pinned widget can read its own
// zone rect without prop-drilling through every widget kind.

function PinnedLayer({
  widgets,
  focusedId,
  renderWidget
}: {
  widgets: Widget[]
  focusedId: string | null
  renderWidget: (w: Widget) => JSX.Element | null
}): JSX.Element {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  // Subscribe to the AI rail's collapsed state so any change re-runs the
  // pin-position memo. When the rail opens, BR/TR widgets glide left by
  // AI_RAIL_WIDTH + gap; when it collapses to the small icon, they glide
  // back. ChromeInsets is the single point where rail width + (later)
  // dock height + zoom-controls inset get composed.
  const railCollapsed = useAIRailCollapsed()
  const insets: ChromeInsets = useMemo(
    () => ({
      top: 0,
      right: railCollapsed ? AI_RAIL_BUTTON_SIZE + 8 : AI_RAIL_WIDTH + 12,
      bottom: 0,
      left: 0
    }),
    [railCollapsed]
  )

  useEffect(() => {
    const el = layerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setBounds({ width: r.width, height: r.height })
    })
    ro.observe(el)
    const rect = el.getBoundingClientRect()
    setBounds({ width: rect.width, height: rect.height })
    return () => ro.disconnect()
  }, [])

  const zonePositions = useMemo(
    () => computeZonePinPositions(widgets, bounds, insets),
    [widgets, bounds, insets]
  )

  return (
    <PinLayoutContext.Provider value={zonePositions}>
      <div
        ref={layerRef}
        className="absolute inset-0 z-30 pointer-events-none"
        data-pinned-layer
      >
        {widgets.map((w) => {
          if (w.archived) return null
          if (!w.pinned || w.kind !== 'section') return null
          return (
            <div key={`${w.id}-pin`}>{renderWidget(w)}</div>
          )
        })}
        {widgets.map((w) => {
          if (w.archived) return null
          if (!w.pinned || w.kind === 'section') return null
          if (w.parentSectionId !== null) return null
          if (focusedId === w.id && isWebKind(w.kind)) return null
          return (
            <div key={`${w.id}-pin`}>{renderWidget(w)}</div>
          )
        })}
      </div>
    </PinLayoutContext.Provider>
  )
}
