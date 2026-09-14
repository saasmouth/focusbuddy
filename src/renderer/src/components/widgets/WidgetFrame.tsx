import { WIDGET_CATALOG } from '../../lib/widgetCatalog'
import { GRID } from '../../lib/canvasGrid'
import { snapEnabled } from '../../lib/gridPref'
import { useContext, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Rnd } from 'react-rnd'
import { useWidgetSurface } from '../../lib/widgetSurface'
import { type CtxMenuItem } from '../CanvasContextMenu'
import UnifiedWidgetMenu from '../contextMenu/UnifiedWidgetMenu'
import WidgetSetupAffordance from './WidgetSetupAffordance'
import { useAutoGrowHeight } from '../../lib/useAutoGrowHeight'
import { getNavPrefs } from '../../lib/navPrefs'
import { useContextHealthStore } from '../../stores/contextHealth'
import { healthFrameStyle } from '../../lib/healthFrame'
import { buildContextForWidget, buildContextForMulti } from '../../lib/contextMenu/buildContext'
import type { FrameCallbacks } from '../../lib/contextMenu/types'
import { FrameCallbacksProvider } from '../../lib/contextMenu/frameContext'
import MakeTaskDialog from '../MakeTaskDialog'
import ShareDialog from '../ShareDialog'
import type { PinZone, Widget } from '@shared/types'
import { PIN_ZONE_ICONS, PIN_ZONE_LABELS } from '../../lib/pinLayout'
import { useWidgetStore } from '../../stores/widgets'
import {
  computeSectionFrame,
  effectiveLayout,
  findNonOverlapPosition,
  resolvePushFromAnchor,
  SECTION_PADDING
} from '../../lib/sectionGeometry'

// Registry of imperative Rnd position setters, keyed by widget id. A drop that
// pushes neighbours out of the way uses this to slide each neighbour's Rnd in
// place WITHOUT a remount, so their children (webviews especially) stay mounted.
// Each free-widget frame registers its own setter while mounted.
const rndPositioners = new Map<string, (x: number, y: number) => void>()
import { chimeIn, chimeOut } from '../../lib/audioBeep'
import { useZonePosition } from '../../lib/pinLayout'
import { LinkDragContext } from '../../lib/linkDragContext'
import { widgetDisplayName } from '../../lib/widgetDisplayName'
import { useWorkItemStore } from '../../stores/workItems'
import { useViewStore } from '../../stores/view'
import { liveItemForWidget } from '../../lib/widgetAttention'
import { workItemsEnabled } from '../../lib/workItemsCapability'
import { presetForWidget, browserMarkUrl } from '../../lib/attentionPresets'
import { PRIMARY_ACTION, queueOf } from '../../lib/attentionQueues'
import { useCloseWorkItem } from '../attention/useCloseWorkItem'
import BellIcon from '../attention/BellIcon'
import CompleteCircle from '../attention/CompleteCircle'
import Icon from '../Icon'
import AgeHalo from '../AgeHalo'
import { SectionLayoutContext } from './sectionLayoutContext'

const EJECT_THRESHOLD = 40
const HOVER_THROTTLE_MS = 60

interface Props {
  widget: Widget
  children: React.ReactNode
  headerLabel: string
  headerAccent?: string
  draggableHandleClass?: string
  // When this widget is zone-pinned (pinnedZone !== null), Canvas computes
  // the screen-space position based on the zone + neighbouring same-zone
  // pins and passes it down. Overrides the legacy pinnedScreenX/Y path.
  zonePosition?: { x: number; y: number; width: number; height: number }
  // Extra context-menu items injected by the wrapping widget (e.g. the
  // WebViewWidget passes "Pin to apps" here). Inserted at the top of the
  // generic items so kind-specific actions are immediately discoverable.
  headerMenuExtras?: CtxMenuItem[]
}

export default function WidgetFrame({
  widget,
  children,
  headerLabel,
  headerAccent = 'bg-stone-200/70 dark:bg-white/[0.07]',
  draggableHandleClass = 'widget-handle',
  zonePosition: zonePositionProp,
  headerMenuExtras
}: Props): JSX.Element {
  // Pull from the prop first (escape hatch for callers that want to drive
  // position explicitly), then fall back to the PinLayoutContext provided
  // by Canvas's pinned-layer. The context approach avoids prop-drilling
  // through every kind-specific widget component.
  // A dashboard renders the same object with the same component; it just has to
  // fill its card instead of sitting at its desk coordinates.
  const catalogIcon = useMemo(
    () => WIDGET_CATALOG.find((e) => e.kind === widget.kind)?.icon ?? 'widgets',
    [widget.kind]
  )
  const embedded = useWidgetSurface() === 'embedded'
  const contextZonePosition = useZonePosition(widget.id)
  const zonePosition = zonePositionProp ?? contextZonePosition
  const update = useWidgetStore((s) => s.update)
  const remove = useWidgetStore((s) => s.remove)
  const bringToFront = useWidgetStore((s) => s.bringToFront)
  const createWidget = useWidgetStore((s) => s.create)
  const setFocused = useWidgetStore((s) => s.setFocused)
  const setActive = useWidgetStore((s) => s.setActive)
  const togglePin = useWidgetStore((s) => s.togglePin)
  const pinToZone = useWidgetStore((s) => s.pinToZone)
  const unpinWidget = useWidgetStore((s) => s.unpinWidget)
  const setHoveredSection = useWidgetStore((s) => s.setHoveredSection)
  const setDragOverride = useWidgetStore((s) => s.setDragOverride)
  // ── Multi-select ────────────────────────────────────────────────────────
  const selected = useWidgetStore((s) => s.selectedIds.includes(widget.id))
  const toggleSelection = useWidgetStore((s) => s.toggleSelection)
  const clearSelection = useWidgetStore((s) => s.clearSelection)
  const beginGroupDrag = useWidgetStore((s) => s.beginGroupDrag)
  const setGroupDelta = useWidgetStore((s) => s.setGroupDelta)
  // ── Rename ────────────────────────────────────────────────────────────────
  // Every widget can be named. Until the user types a name, the header shows a
  // name inherited from the widget's own content (first line of a note, a
  // browser's hostname); double-click the header label to set a manual name.
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  // Manual double-click detection. The native `dblclick` event is unreliable on
  // the header because the first click re-renders the frame (active-state change)
  // and swaps the label node, so the browser never pairs the two clicks. A ref
  // timestamp survives the re-render where a node-bound listener wouldn't.
  const lastTitleClickRef = useRef(0)
  function beginRename(): void {
    setTitleDraft(widget.title?.trim() ?? '')
    setTitleEditing(true)
  }
  function commitTitle(): void {
    const next = titleDraft.trim()
    if (next !== (widget.title || '')) void update(widget.id, { title: next })
    setTitleEditing(false)
  }
  const endGroupDrag = useWidgetStore((s) => s.endGroupDrag)
  // groupDrag is read live in the member-follow effect below; subscribe so the
  // effect re-runs on every delta tick.
  const groupDrag = useWidgetStore((s) => s.groupDrag)
  // True while THIS widget is the leader of an in-flight group drag — gates the
  // onDrag/onDragStop branches without re-subscribing to selection on every tick.
  const groupLeadRef = useRef(false)
  // One-shot guard so a non-lead drag drops the selection at most once, on the
  // FIRST real movement (never on a click — react-rnd fires onDragStart on a
  // plain mousedown too, so selection-clearing must wait for actual motion).
  const groupClearedRef = useRef(false)
  // Shift-select fires from TWO places depending on where you click: the body
  // routes through onMouseDownCapture, but the header IS react-rnd's drag handle
  // and only reaches onDragStart. shiftToggle() dedupes so a header click (which
  // can hit both) toggles exactly once. shiftGestureRef tells onDrag to skip its
  // "dragging an unselected widget clears the selection" branch for a shift gesture.
  const lastShiftToggleRef = useRef(0)
  const shiftGestureRef = useRef(false)
  function shiftToggle(): void {
    const now = performance.now()
    if (now - lastShiftToggleRef.current < 250) return
    lastShiftToggleRef.current = now
    toggleSelection(widget.id)
  }
  const [pinPickerOpen, setPinPickerOpen] = useState(false)
  const [expandPickerOpen, setExpandPickerOpen] = useState(false)
  // Right-click on the widget header opens a small context menu with a
  // "Make this a task" option. The menu is positioned at the cursor and
  // closes on outside-click / Esc (handled by CanvasContextMenu).
  const [headerCtxMenu, setHeaderCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [makeTaskOpen, setMakeTaskOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const isActive = useWidgetStore((s) => s.activeWidgetId === widget.id)
  const zoom = useWidgetStore((s) => s.zoom)
  // DEC-076 — the header bell. Outlined = not in Attention; filled = a LIVE
  // work item points at this widget (derived from the queue's own rows via
  // liveItemForWidget, so the two surfaces cannot disagree). Clicking an
  // outlined bell runs the SAME flow as the menu's "Add to Attention…" —
  // the preset text into the standard confirm console, item POINTS at the
  // widget (sourceType/sourceRef), nothing files without the person's Enter.
  // A filled bell opens the queue. The check beside it closes the item with
  // its own queue verb through the one close path.
  const attentionOn = workItemsEnabled()
  const workItems = useWorkItemStore((s) => s.items)
  const wiLoaded = useWorkItemStore((s) => s.loaded)
  const refreshWorkItems = useWorkItemStore((s) => s.refresh)
  useEffect(() => {
    if (attentionOn && !wiLoaded) void refreshWorkItems()
  }, [attentionOn, wiLoaded, refreshWorkItems])
  const attentionItem = attentionOn ? liveItemForWidget(workItems, widget.id) : null
  const goAttention = useViewStore((s) => s.goAttention)
  const closeWorkItem = useCloseWorkItem()
  function markWidgetForAttention(): void {
    const p = presetForWidget(widget.kind, widget.title ?? '', widget.content ?? '')
    window.dispatchEvent(
      new CustomEvent('fb:command-new-work-item', {
        detail: {
          captureText: p.text,
          source: {
            sourceType: 'widget',
            sourceRef: widget.id,
            intentClass: p.intentClass,
            deskId: widget.taskId,
            // DEC-091 — a browser widget's content IS its current URL
            // (persistNavUrl); freeze it on the item so the queue can return
            // to the exact page (the Slack thread, the ticket) even after
            // the widget browses elsewhere.
            sourceUrl: browserMarkUrl(widget.kind, widget.content)
          }
        }
      })
    )
  }
  // Per-widget Context Health frame (plexi-4.0, UX-022). Reads the pre-review
  // "since your last visit" snapshot captured on desk open; `current` -> no frame.
  const health = useContextHealthStore((s) => s.lastVisit[widget.id])
  const healthStyle = health
    ? healthFrameStyle(health.state, (health.decisionsAtRisk ?? []).map((d) => d.title))
    : null
  const zoomToWidget = useWidgetStore((s) => s.zoomToWidget)
  const allWidgets = useWidgetStore((s) => s.widgets)
  const bumpLayout = useWidgetStore((s) => s.bumpLayoutVersion)
  const lastHoverCheck = useRef(0)
  // Track recent drag-end so the click event that fires on mouseup at the end
  // of a drag doesn't trigger any click handlers (which would, among other
  // things, cause the canvas to pan-center on the widget — making it look
  // like "the screen tracks away from where I dropped").
  const dragJustEnded = useRef(0)
  // Ref into the Rnd instance — we use this to imperatively update Rnd's
  // internal size + position state after a snap, instead of relying on a
  // key-change re-mount. Re-mounting is fatal for <webview> children
  // because Electron creates a fresh process and the URL fully reloads.
  const rndRef = useRef<Rnd | null>(null)
  // Read live rather than once: the toggle is a global, and a desk already open
  // should start snapping the moment it is turned on.
  const [snapOn, setSnapOn] = useState(snapEnabled)
  useEffect(() => {
    const sync = (): void => setSnapOn(snapEnabled())
    window.addEventListener('fb:snap-changed', sync)
    return () => window.removeEventListener('fb:snap-changed', sync)
  }, [])
  // Auto-grow: the body's content height drives the widget height for kinds that
  // grow (everything except long-form text, the browser, and the geometry-
  // computed kinds). Self-gates by kind / section-child / pinned.
  const bodyRef = useRef<HTMLDivElement>(null)
  useAutoGrowHeight(widget, bodyRef)

  // Scale the widget by a multiplicative factor (1.5 = +50%, 1/1.5 = -50%
  // symmetric inverse). Used by the header +/− buttons and the legacy
  // enlarge-on-desk popover. Capped at [minWidth, MAX_W] × [minHeight, MAX_H]
  // so the user can't shrink past Rnd's drag-handle threshold or grow off
  // the screen. Skips section children — those are auto-arranged.
  //
  // Like onEnlargeOnDesk before it, this uses the imperative Rnd update path
  // (applyRndSizeAndPosition) — NOT bumpLayoutVersion. A key-change re-mount
  // tears down every <webview> child (each Electron webview is its own
  // process; remount = full URL reload + lost logged-in state). Same logic
  // applies to ProseMirror editors and any component with internal state.
  function scaleWidgetBy(factor: number): void {
    if (isChildOfSection) return
    const MAX_W = 1400
    const MAX_H = 900
    const MIN_W = 180
    const MIN_H = 120
    const newW = Math.max(MIN_W, Math.min(MAX_W, Math.round(widget.width * factor)))
    const newH = Math.max(MIN_H, Math.min(MAX_H, Math.round(widget.height * factor)))
    if (newW === widget.width && newH === widget.height) return
    if (isPinned) {
      // Pinned widgets are screen-anchored — no overlap-detection needed
      // because their position is computed by pinLayout. Just resize.
      void update(widget.id, { width: newW, height: newH })
      applyRndSizeAndPosition(newW, newH, defaultX, defaultY)
      return
    }
    const latest = useWidgetStore.getState().widgets
    const siblings = latest.filter(
      (w) => w.id !== widget.id && !w.pinned && !w.parentSectionId
    )
    const placed = findNonOverlapPosition(
      { x: widget.x, y: widget.y, width: newW, height: newH },
      effectiveSiblingsForCheck(siblings, latest)
    )
    void update(widget.id, {
      width: newW,
      height: newH,
      x: placed.x,
      y: placed.y
    })
    applyRndSizeAndPosition(newW, newH, placed.x, placed.y)
  }

  // Imperatively push a new size + position into Rnd's internal state.
  // Equivalent to what a key-change re-mount would do via the `default`
  // prop, but without unmounting any children. This is the bridge that
  // keeps webview state intact when a free widget snaps after drop /
  // resize / enlarge.
  function applyRndSizeAndPosition(w: number, h: number, x: number, y: number): void {
    const rnd = rndRef.current
    if (!rnd) return
    type RndImperative = {
      updateSize?: (s: { width: number; height: number }) => void
      updatePosition?: (p: { x: number; y: number }) => void
    }
    const r = rnd as unknown as RndImperative
    if (typeof r.updateSize === 'function') {
      r.updateSize.call(rnd, { width: w, height: h })
    }
    if (typeof r.updatePosition === 'function') {
      r.updatePosition.call(rnd, { x, y })
    }
  }

  // Register this frame's imperative positioner so a neighbouring widget's drop
  // can push us aside in place (no remount). Re-registers when our size changes
  // so the setter always moves us at our current dimensions.
  useEffect(() => {
    rndPositioners.set(widget.id, (x, y) => applyRndSizeAndPosition(widget.width, widget.height, x, y))
    return () => {
      rndPositioners.delete(widget.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id, widget.width, widget.height])

  const layoutCtx = useContext(SectionLayoutContext)
  const sectionLayout = layoutCtx ? layoutCtx.layout : 'free'
  const isInControlledLayout = layoutCtx !== null && sectionLayout !== 'free'
  const linkDrag = useContext(LinkDragContext)

  const parent =
    widget.parentSectionId !== null
      ? allWidgets.find((w) => w.id === widget.parentSectionId) ?? null
      : null
  const isChildOfSection = parent !== null
  const isPinned = widget.pinned && !isChildOfSection
  const isSection = widget.kind === 'section'

  const effectiveScale = isChildOfSection ? (parent?.pinned ? 1 : zoom) : isPinned ? 1 : zoom

  const defaultX = isPinned ? widget.pinnedScreenX ?? widget.x : widget.x
  const defaultY = isPinned ? widget.pinnedScreenY ?? widget.y : widget.y

  function findHoveredSection(canvasX: number, canvasY: number): string | null {
    if (isChildOfSection || isPinned || isSection) return null
    const sections = allWidgets.filter((w) => w.kind === 'section' && !w.pinned)
    for (const s of sections) {
      const sChildren = allWidgets.filter((w) => w.parentSectionId === s.id)
      const sFrame = computeSectionFrame(sChildren, effectiveLayout(s.layout))
      if (
        canvasX >= s.x &&
        canvasX <= s.x + sFrame.width &&
        canvasY >= s.y &&
        canvasY <= s.y + sFrame.height
      ) {
        return s.id
      }
    }
    return null
  }

  // Compute a widget's EFFECTIVE bounds for overlap-detection. Sections store
  // a base width/height but their visual bounds extend to fit their children,
  // so we use computeSectionFrame for them. For everything else, the stored
  // width/height is the visual size.
  function effectiveBounds(
    w: Widget,
    all: Widget[]
  ): { x: number; y: number; width: number; height: number } {
    if (w.kind === 'section') {
      const children = all.filter((c) => c.parentSectionId === w.id)
      const frame = computeSectionFrame(children, effectiveLayout(w.layout))
      return { x: w.x, y: w.y, width: frame.width, height: frame.height }
    }
    return { x: w.x, y: w.y, width: w.width, height: w.height }
  }

  // findNonOverlapPosition expects an array of Widget for the "existing" set,
  // but we need to feed it effective bounds (sections especially). Wrap each
  // sibling in a synthetic Widget-shaped object whose w/h are the effective
  // ones — the helper only reads x/y/width/height so this is safe.
  function effectiveSiblingsForCheck(siblings: Widget[], all: Widget[]): Widget[] {
    return siblings.map((s) => {
      if (s.kind !== 'section') return s
      const eb = effectiveBounds(s, all)
      return { ...s, width: eb.width, height: eb.height }
    })
  }

  // Duplicate the widget. SYNCED copies share a syncGroupId so content / title /
  // colour mirror across every copy; INDEPENDENT copies are a one-time snapshot.
  // Extracted from the old header menu verbatim so the unified menu drives the
  // exact same behaviour.
  function duplicateWidgetCopy(synced: boolean): void {
    void (async () => {
      let groupId: string | undefined
      if (synced) {
        groupId = widget.syncGroupId ?? crypto.randomUUID()
        if (!widget.syncGroupId) await update(widget.id, { syncGroupId: groupId })
      }
      await createWidget({
        taskId: widget.taskId,
        kind: widget.kind,
        title: widget.title,
        content: widget.content,
        x: widget.x + 30,
        y: widget.y + 30,
        width: widget.width,
        height: widget.height,
        color: widget.color,
        sourceAppId: widget.sourceAppId,
        mode: widget.mode,
        syncGroupId: groupId
      })
    })()
  }

  // Move the widget out of its parent section, dropping it directly below the
  // section and de-overlapping against top-level siblings.
  function ejectFromSectionFrame(): void {
    if (!isChildOfSection || !parent) return
    const ws = useWidgetStore.getState().widgets
    const canvasX = Math.round(parent.x + SECTION_PADDING + widget.x)
    const canvasY = Math.round(parent.y + parent.height + 24)
    const topLevelSiblings = ws.filter((w) => w.id !== widget.id && !w.pinned && !w.parentSectionId)
    const placed = findNonOverlapPosition(
      { x: canvasX, y: canvasY, width: widget.width, height: widget.height },
      effectiveSiblingsForCheck(topLevelSiblings, ws)
    )
    void update(widget.id, { parentSectionId: null, x: placed.x, y: placed.y })
    bumpLayout()
  }

  // The frame management actions the unified context menu offers. Each is
  // present only when it applies to this widget.
  const frameCallbacks: FrameCallbacks = {
    onMakeTask: () => setMakeTaskOpen(true),
    onShare: () => setShareOpen(true),
    onDuplicateSynced: () => duplicateWidgetCopy(true),
    onDuplicateIndependent: () => duplicateWidgetCopy(false),
    onDuplicateToFolder: !isChildOfSection && !isSection ? () => setMakeTaskOpen(true) : undefined,
    onEjectFromSection: isChildOfSection && parent ? ejectFromSectionFrame : undefined,
    onUnlinkSynced: widget.syncGroupId
      ? () => void update(widget.id, { syncGroupId: null })
      : undefined
  }

  function commitDrop(newX: number, newY: number): void {
    // Read the LATEST store state — `allWidgets` from useWidgetStore is the
    // last-render snapshot. Two rapid drops on a fresh section both saw an
    // empty children list and landed on top of each other; reading
    // .getState() here closes that race.
    const latestWidgets = useWidgetStore.getState().widgets

    // Whether the snap relocated the widget far enough that Rnd's internal
    // drag-end position no longer matches the store. Used to bump
    // layoutVersion so Rnd re-mounts at the snapped position. Raised from
    // 4 → 12 so sub-pixel rounding doesn't trigger unnecessary remounts.
    // We deliberately do NOT pan the camera on snap any more — that was
    // hostile UX (the canvas would fly to centre on the widget you just
    // dropped, defeating the user's spatial intuition). The widget's own
    // `setActive` glow already signals "your widget landed here."
    const SNAP_THRESHOLD = 12
    const snappedAway = (rawX: number, rawY: number, placedX: number, placedY: number): boolean =>
      Math.abs(rawX - placedX) > SNAP_THRESHOLD || Math.abs(rawY - placedY) > SNAP_THRESHOLD

    if (isChildOfSection && parent) {
      const parentChildren = latestWidgets.filter((w) => w.parentSectionId === parent.id)
      const parentLayout = effectiveLayout(parent.layout)
      const parentFrame = computeSectionFrame(parentChildren, parentLayout)
      const contentW = parentFrame.width - 2 * SECTION_PADDING
      const contentH = parentFrame.height - 2 * SECTION_PADDING
      const ejected =
        newX < -EJECT_THRESHOLD ||
        newY < -EJECT_THRESHOLD ||
        newX > contentW + EJECT_THRESHOLD ||
        newY > contentH + EJECT_THRESHOLD
      if (ejected) {
        // Ejecting back to canvas — push away from any top-level overlap.
        const canvasX = Math.round(parent.x + SECTION_PADDING + newX)
        const canvasY = Math.round(parent.y + SECTION_PADDING + newY)
        const topLevelSiblings = latestWidgets.filter(
          (w) => w.id !== widget.id && !w.pinned && !w.parentSectionId
        )
        const placed = findNonOverlapPosition(
          { x: canvasX, y: canvasY, width: widget.width, height: widget.height },
          effectiveSiblingsForCheck(topLevelSiblings, latestWidgets)
        )
        chimeOut()
        // The store's `update` does an optimistic synchronous `set` first,
        // then awaits the IPC. Calling bumpLayout() synchronously right
        // after means the new render cycle picks up BOTH the snapped
        // position AND the new key — so Rnd remounts at placed.x/y without
        // a flicker. Awaiting the IPC (.then) is too late: the widget is
        // visually stuck at the drop point for that 50-200ms window.
        void update(widget.id, {
          parentSectionId: null,
          x: placed.x,
          y: placed.y
        })
        bumpLayout()
      } else if (isInControlledLayout && layoutCtx) {
        // Auto-arranged layout (grid/stacks): a drop that stayed inside the
        // section does NOT reposition — the layout owns placement. The user
        // was dragging to eject but released inside, so snap Rnd back to the
        // computed cell (the controlled `position` prop won't reset on its
        // own when its value is unchanged).
        applyRndSizeAndPosition(
          layoutCtx.size.width,
          layoutCtx.size.height,
          layoutCtx.position.x,
          layoutCtx.position.y
        )
      } else {
        // Moving within the same section. In free layout, snap away from
        // siblings (excluding self). In stack mode, allow overlap — that's
        // the whole point of stacks. Other layouts are auto-arranged so we
        // never reach here.
        const siblings = parentChildren.filter((w) => w.id !== widget.id)
        const rawX = Math.max(0, Math.round(newX))
        const rawY = Math.max(0, Math.round(newY))
        const placed =
          parentLayout === 'free'
            ? findNonOverlapPosition(
                { x: rawX, y: rawY, width: widget.width, height: widget.height },
                siblings
              )
            : { x: rawX, y: rawY }
        const moved = snappedAway(rawX, rawY, placed.x, placed.y)
        void update(widget.id, { x: placed.x, y: placed.y })
        if (moved) {
          // Imperative update — no key change, no re-mount, so any
          // webview child stays mounted with its current URL.
          applyRndSizeAndPosition(widget.width, widget.height, placed.x, placed.y)
        }
      }
      return
    }

    if (isPinned) {
      void update(widget.id, {
        pinnedScreenX: Math.round(newX),
        pinnedScreenY: Math.round(newY)
      })
      return
    }

    const targetSectionId = findHoveredSection(newX, newY)
    if (targetSectionId) {
      const s = latestWidgets.find((w) => w.id === targetSectionId)
      if (s) {
        const sChildren = latestWidgets.filter((w) => w.parentSectionId === s.id)
        const sLayout = effectiveLayout(s.layout)
        const rawX = Math.max(0, Math.round(newX - s.x - SECTION_PADDING))
        const rawY = Math.max(0, Math.round(newY - s.y - SECTION_PADDING))
        // Free + stacks both allow manual positioning, but only Free rejects
        // overlap. Stacks deliberately permit overlap (it's a stack).
        const placed =
          sLayout === 'free'
            ? findNonOverlapPosition(
                { x: rawX, y: rawY, width: widget.width, height: widget.height },
                sChildren.filter((c) => c.id !== widget.id)
              )
            : { x: rawX, y: rawY }
        chimeIn()
        void update(widget.id, {
          parentSectionId: s.id,
          x: placed.x,
          y: placed.y
        })
        bumpLayout()
        return
      }
    }

    // Canvas-level drop. Priority goes to the object the user is moving: it
    // STAYS exactly where dropped, and any top-level widgets it now overlaps
    // flow out of its way to the nearest clear spot (cascading, so pushed
    // widgets never land on each other). Previously we relocated the DROPPED
    // widget instead, which fought the user's deliberate placement — the
    // opposite of what "I put it there" should mean. Sections are treated as
    // immovable blockers (pushed widgets avoid them; a section itself doesn't
    // shuffle when a small widget lands near it). Optional snap-to-grid rounds
    // the drop to an 8px grid first.
    const grid = getNavPrefs().snapToGridEnabled ? 8 : 1
    const rawX = Math.round(newX / grid) * grid
    const rawY = Math.round(newY / grid) * grid
    const topLevelSiblings = latestWidgets.filter(
      (w) => w.id !== widget.id && !w.pinned && !w.parentSectionId && !w.archived && w.kind !== 'minimap'
    )
    const anchor = { x: rawX, y: rawY, width: widget.width, height: widget.height }
    // Movable = free (non-section) neighbours; blockers = section frames.
    const movable = topLevelSiblings
      .filter((w) => w.kind !== 'section')
      .map((w) => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
    const blockers = effectiveSiblingsForCheck(
      topLevelSiblings.filter((w) => w.kind === 'section'),
      latestWidgets
    ).map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height }))

    // The moved widget commits to its drop point. Only nudge Rnd if grid-snap
    // actually shifted it (avoids a needless imperative update on a clean drop).
    void update(widget.id, { x: rawX, y: rawY })
    if (snappedAway(newX, newY, rawX, rawY)) {
      applyRndSizeAndPosition(widget.width, widget.height, rawX, rawY)
    }

    // Push the overlapping neighbours away and slide each imperatively so no
    // webview reloads. Store stays the source of truth via update().
    const pushes = resolvePushFromAnchor(anchor, movable, blockers)
    for (const [id, pos] of pushes) {
      void update(id, { x: pos.x, y: pos.y })
      rndPositioners.get(id)?.(pos.x, pos.y)
    }
  }

  // Zone-pinned widgets are controlled too — their position+size come from
  // the pinLayout computation, not from Rnd's internal drag state. This
  // means dragging a zone-pinned widget is a no-op (you can't drag a zone
  // pin — it'd defeat the auto-dock); to move it the user picks a different
  // zone or unpins.
  // A widget with pinned + pinnedZone set is ALWAYS treated as zone-pinned, even
  // if the PinLayoutContext map hasn't resolved its position yet — which happens
  // for a frame after a layoutVersion-keyed remount, after an async widget reload,
  // or before PinnedLayer's ResizeObserver has measured non-zero bounds. Without
  // this, a missing zonePosition dropped the widget out of controlled mode and
  // Rnd fell back to the stored canvas x/y, so the minimap detached to (0,0) and
  // then drifted with the canvas content as more widgets were added. Falling back
  // to an off-screen rect keeps Rnd controlled; the next render with a resolved
  // position snaps it into its corner (invisible in practice).
  const isZonePinned = widget.pinned && widget.pinnedZone !== null
  const resolvedZone = zonePosition ?? { x: -9999, y: -9999, width: widget.width, height: widget.height }
  const useControlled = isInControlledLayout || isZonePinned
  const controlledPos = isZonePinned
    ? { x: resolvedZone.x, y: resolvedZone.y }
    : isInControlledLayout
      ? layoutCtx?.position
      : undefined
  const controlledSize = isZonePinned
    ? { width: resolvedZone.width, height: resolvedZone.height }
    : isInControlledLayout
      ? layoutCtx?.size
      : undefined
  // Keep the live (uncontrolled) Rnd in sync when a free widget's size OR
  // position is changed from OUTSIDE its own drag/resize gesture — e.g. the
  // browser resolution presets (size) or a group-move commit (position). A free
  // widget's Rnd only reads `default` at mount, so without this the store
  // updates but the element keeps its mounted size/position until a remount —
  // and a <webview> can't be remounted (it would reload the page + lose login).
  // applyRndSizeAndPosition pushes the new geometry imperatively. The store's
  // x/y/w/h only change on drag/resize STOP (or a group commit), never mid-
  // gesture for THIS widget, so re-applying the committed value is a harmless
  // no-op and never fights a live drag. Controlled widgets track geometry via
  // props, so they're skipped.
  useLayoutEffect(() => {
    if (useControlled) return
    applyRndSizeAndPosition(widget.width, widget.height, widget.x, widget.y)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.width, widget.height, widget.x, widget.y, useControlled])

  // Group-move follower: while another selected widget is being dragged, move
  // THIS widget's Rnd imperatively by the live delta (no per-frame store/IPC
  // write — positions are committed once on drop by endGroupDrag). Only members
  // that aren't the drag leader follow; the leader is moved by Rnd itself.
  useLayoutEffect(() => {
    if (useControlled || !groupDrag || groupDrag.leaderId === widget.id) return
    const start = useWidgetStore.getState().groupStart?.[widget.id]
    if (!start) return
    applyRndSizeAndPosition(
      widget.width,
      widget.height,
      Math.round(start.x + groupDrag.dx),
      Math.round(start.y + groupDrag.dy)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupDrag])

  // Zone-pins can't be dragged (they auto-dock). Controlled SECTION children
  // (grid/stacks), however, ARE draggable — that's how the user drags an item
  // out of a section onto the desk. Their position is still controlled by the
  // layout, so a non-eject drop snaps them back to their cell (see commitDrop).
  const dragDisabled = Boolean(isZonePinned)

  return (
    <Rnd
      ref={(r) => {
        rndRef.current = r as Rnd | null
      }}
      default={
        useControlled
          ? undefined
          : {
              x: defaultX,
              y: defaultY,
              width: widget.width,
              height: widget.height
            }
      }
      position={embedded ? { x: 0, y: 0 } : controlledPos}
      size={embedded ? { width: '100%', height: '100%' } : controlledSize}
      scale={effectiveScale}
      style={
        embedded
          ? { position: 'relative', width: '100%', height: '100%', pointerEvents: 'auto' }
          : { zIndex: widget.zIndex, position: 'absolute', pointerEvents: 'auto' }
      }
      minWidth={180}
      minHeight={120}
      // Snap while dragging and while resizing. Rnd does this natively, which
      // keeps the rounding in one place instead of correcting a position after
      // the fact -- correcting afterwards is what makes a widget appear to
      // jump out from under the cursor on release.
      dragGrid={snapOn ? [GRID, GRID] : undefined}
      resizeGrid={snapOn ? [GRID, GRID] : undefined}
      dragHandleClassName={draggableHandleClass}
      // The header label is a drag handle, but the rename affordance inside it
      // must NOT start a drag — otherwise react-draggable swallows the
      // double-click that opens the editor. `cancel` excludes it from dragging.
      cancel=".widget-nodrag"
      disableDragging={embedded || dragDisabled}
      enableResizing={
        // Resizing on a dashboard would write a size back to the desk the
        // object still lives on.
        embedded || useControlled
          ? false
          : {
              top: true,
              right: true,
              bottom: true,
              left: true,
              topRight: true,
              bottomRight: true,
              bottomLeft: true,
              topLeft: true
            }
      }
      onDragStart={(e) => {
        // Shift+click on the header is a SELECTION toggle, not a drag — but
        // react-rnd still fires onDragStart on the mousedown. Bail out before
        // touching active/selection state so the onClick handler's shift-toggle
        // can build a multi-selection without this wiping it each click.
        if ((e as MouseEvent).shiftKey) {
          groupLeadRef.current = false
          shiftGestureRef.current = true
          // Header shift-click reaches us here (onMouseDownCapture doesn't fire
          // for the drag handle). shiftToggle() dedupes against the body path.
          if (!isChildOfSection && !isPinned && !isSection) shiftToggle()
          return
        }
        shiftGestureRef.current = false
        void bringToFront(widget.id)
        setActive(widget.id)
        groupClearedRef.current = false
        // Multi-select interplay: if this widget is part of a 2+ selection,
        // become the GROUP-DRAG leader — every selected widget rides along.
        // (Dropping the selection when you grab an UNSELECTED widget is deferred
        // to the first real movement in onDrag — never on a click.)
        // Sections/section-children/pins never lead a group drag.
        const st = useWidgetStore.getState()
        const canLead = !isChildOfSection && !isPinned && !isSection
        if (canLead && st.selectedIds.includes(widget.id) && st.selectedIds.length > 1) {
          groupLeadRef.current = true
          beginGroupDrag(widget.id)
        } else {
          groupLeadRef.current = false
        }
        // Toggle a root-level class so the desk surface can render the
        // snap-to-grid hint while the user is actively positioning an
        // object. Removed on dragstop. Cheap to add/remove; CSS does the
        // heavy lifting.
        document.documentElement.classList.add('fb-canvas-dragging')
      }}
      onDrag={(_, d) => {
        // Group-drag leader: push the live delta so co-selected members follow
        // imperatively (their effect moves their own Rnd — no per-frame IPC).
        if (groupLeadRef.current) {
          const start = useWidgetStore.getState().groupStart?.[widget.id]
          if (start) setGroupDelta(d.x - start.x, d.y - start.y)
        } else if (
          !groupClearedRef.current &&
          !shiftGestureRef.current &&
          !isChildOfSection &&
          !isPinned
        ) {
          // First real movement of a non-lead, non-shift drag: if we grabbed a
          // widget that ISN'T in the current selection, drop the selection now
          // (on motion, never on a click — so shift-clicking builds a selection).
          groupClearedRef.current = true
          const st = useWidgetStore.getState()
          if (st.selectedIds.length && !st.selectedIds.includes(widget.id)) clearSelection()
        }
        // Live-track the dragging widget's position so the inter-widget
        // links overlay can keep its endpoints attached to the widget in
        // real time (rather than only updating on drop, which would let
        // the user drag a widget across the canvas while its links
        // visually trail behind). Free-positioned widgets only — section
        // children and pinned widgets don't make sense here.
        if (!isChildOfSection && !isPinned) {
          setDragOverride({ widgetId: widget.id, x: d.x, y: d.y })
        }
        const now = performance.now()
        if (now - lastHoverCheck.current < HOVER_THROTTLE_MS) return
        lastHoverCheck.current = now
        // Don't hover-target a section while group-dragging — the group commits
        // as free widgets, not into a section.
        if (isChildOfSection || isPinned || isSection || groupLeadRef.current) return
        const target = findHoveredSection(d.x, d.y)
        setHoveredSection(target)
      }}
      onDragStop={(_, d) => {
        setHoveredSection(null)
        setDragOverride(null)
        if (groupLeadRef.current) {
          // Commit every selected widget's final position in one batch; skip the
          // normal single-widget commitDrop (which would snap/overlap-resolve and
          // fight the group's relative layout).
          groupLeadRef.current = false
          void endGroupDrag()
        } else {
          commitDrop(d.x, d.y)
        }
        document.documentElement.classList.remove('fb-canvas-dragging')
        shiftGestureRef.current = false
        // Mark the mouseup as drag-end so the click event that follows
        // doesn't run our onClick activation logic.
        dragJustEnded.current = performance.now()
      }}
      onResizeStart={() => setActive(widget.id)}
      onResizeStop={(_, __, ref, ___, pos) => {
        const newW = ref.offsetWidth
        const newH = ref.offsetHeight
        if (isChildOfSection) {
          // Inside a section's free layout — snap the resized rect away
          // from siblings the same way commitDrop does. Stack/grid/icons/
          // list layouts auto-arrange children so resize either isn't
          // permitted or the layout normalises afterwards.
          const latestWidgets = useWidgetStore.getState().widgets
          const siblings = latestWidgets.filter(
            (w) => w.id !== widget.id && w.parentSectionId === widget.parentSectionId
          )
          const rawX = Math.max(0, Math.round(pos.x))
          const rawY = Math.max(0, Math.round(pos.y))
          const placed = findNonOverlapPosition(
            { x: rawX, y: rawY, width: newW, height: newH },
            siblings
          )
          void update(widget.id, {
            width: newW,
            height: newH,
            x: placed.x,
            y: placed.y
          })
          if (Math.abs(rawX - placed.x) > 12 || Math.abs(rawY - placed.y) > 12) {
            // Imperative — no re-mount, no webview reload.
            applyRndSizeAndPosition(newW, newH, placed.x, placed.y)
          }
        } else if (isPinned) {
          // Pinned widgets live in screen-space and the pinned-layer auto-
          // stacks zone-pinned siblings; free-position pins don't need
          // overlap detection (the user explicitly chose the spot).
          void update(widget.id, {
            width: newW,
            height: newH,
            pinnedScreenX: Math.round(pos.x),
            pinnedScreenY: Math.round(pos.y)
          })
        } else {
          // Canvas-level resize. Same reverse-magnetic snap as a drop, so
          // a resize that grows into another widget pushes off it instead
          // of overlapping silently.
          const latestWidgets = useWidgetStore.getState().widgets
          const topLevelSiblings = latestWidgets.filter(
            (w) => w.id !== widget.id && !w.pinned && !w.parentSectionId
          )
          const rawX = Math.round(pos.x)
          const rawY = Math.round(pos.y)
          const placed = findNonOverlapPosition(
            { x: rawX, y: rawY, width: newW, height: newH },
            effectiveSiblingsForCheck(topLevelSiblings, latestWidgets)
          )
          void update(widget.id, {
            width: newW,
            height: newH,
            x: placed.x,
            y: placed.y
          })
          if (Math.abs(rawX - placed.x) > 12 || Math.abs(rawY - placed.y) > 12) {
            // Imperative — Rnd's internal state updates without a re-
            // mount, so the webview child keeps its session + URL.
            applyRndSizeAndPosition(newW, newH, placed.x, placed.y)
          }
        }
      }}
    >
      <AgeHalo createdAt={widget.createdAt} variant="widget" />
      <div
        data-widget-id={widget.id}
        data-widget-kind={widget.kind}
        // Shift-select is handled on mousedown (CAPTURE phase) — not onClick —
        // because the header IS react-rnd's drag handle: react-draggable's
        // bubble-phase mousedown consumes the gesture and onClick never fires on
        // the header. Catching it in capture (before the drag machinery) and
        // stopPropagation lets us toggle the selection AND suppress the drag.
        // Shift-only, so a normal mousedown is untouched (the WebView overlay
        // relies on NOT setting `active` early here, which we preserve).
        onMouseDownCapture={(e) => {
          // Shift / ⌘-dive must be handled on mousedown (CAPTURE phase): the
          // header is react-rnd's drag handle, so a normal mousedown is consumed
          // by the drag machinery and onClick never fires on the header. Catching
          // it here (before react-rnd) + stopPropagation toggles/dives AND
          // suppresses the drag. Body clicks fall through to onClick as before.
          if (e.shiftKey && !isChildOfSection && !isPinned) {
            e.stopPropagation()
            shiftToggle()
            return
          }
          if ((e.metaKey || e.ctrlKey) && zoom < 0.8 && !isChildOfSection) {
            e.stopPropagation()
            zoomToWidget(widget.id)
          }
        }}
        onClick={(e) => {
          e.stopPropagation()
          // Shift handled on mousedown above — just swallow the click so it
          // doesn't fall through to centre/zoom.
          if (e.shiftKey && !isChildOfSection && !isPinned) {
            e.preventDefault()
            return
          }
          // Cmd/⌘-click while zoomed out (< 80%) → dive into this widget: jump
          // to 100% with it centred. A fast way to go from an overview to one
          // thing without reaching for the zoom controls.
          if ((e.metaKey || e.ctrlKey) && zoom < 0.8) {
            e.preventDefault()
            zoomToWidget(widget.id)
            return
          }
          // Suppress the click that fires immediately after a drag-end —
          // react-rnd doesn't natively distinguish them.
          if (performance.now() - dragJustEnded.current < 250) return
          // A single click only ACTIVATES the widget — it never shifts the
          // world under you. Centring is a deliberate double-click (below).
          // This is what fixes "the camera drifts after I move it": a click
          // after a pan used to re-centre the camera on the clicked widget.
          setActive(widget.id)
        }}
        onDoubleClick={(e) => {
          // Double-click → enter Focus Mode on this widget (full-screen overlay).
          // Pinned widgets are screen-docked; just activate them instead.
          e.stopPropagation()
          if (isPinned) setActive(widget.id)
          else setFocused(widget.id)
        }}
        className={`relative h-full w-full flex flex-col rounded-[var(--radius-card)] overflow-hidden border bg-[var(--surface-raised)] fb-spring-snap ${
          // Edges + Glass (2026-08-23): the widget is a material card. At rest
          // its edge comes from light (the hairline ring, cast shadow and inset
          // top highlight in the box-shadow below), not from a 1px outline; the
          // 1px border stays in the box as transparent so a state stroke never
          // shifts the content. Colour means state (R5.2): one concentric accent
          // ring when selected (R6.4, not a border plus a ring plus an offset),
          // the glow when active, amber when pinned.
          selected
            ? 'border-transparent ring-2 ring-[rgb(var(--accent)/0.75)] ring-offset-2 ring-offset-transparent'
            : isActive
              ? 'border-transparent widget-glow'
              : isPinned
                ? 'border-amber-400/60'
                : // DEC-089 — in dark mode the resting hairline (9% white)
                  // melts into the desk canvas; the reserved 1px border slot
                  // carries a real edge there. Light mode keeps hairline-only.
                  'border-transparent dark:border-[color:var(--edge-firm)]'
        }`}
        style={{
          // The fb-card recipe: hairline ring so the card never melts into a
          // same-luminance surface, a light-aware cast shadow, and the inset
          // highlight on the top edge. Softer inside a section (the section
          // already lifts it), fuller on the open canvas.
          boxShadow: isActive
            ? undefined // .widget-glow owns the active state
            : isChildOfSection
              ? '0 0 0 1px var(--edge-hairline), var(--shadow-soft), var(--shadow-inset-highlight)'
              : '0 0 0 1px var(--edge-hairline), var(--shadow-cast), var(--shadow-inset-highlight)',
          transitionProperty: 'box-shadow, transform, border-color'
        }}
      >
        {/* Context Health frame (plexi-4.0, UX-022): a coloured inner ring plus a
            labelled corner dot, so the state reads without relying on colour
            (A11Y-004). Rendered above content but click-through. */}
        {healthStyle && (
          <div
            className={`pointer-events-none absolute inset-0 z-[6] rounded-[var(--radius-card)] border-2 ${healthStyle.border}`}
            aria-hidden="true"
          />
        )}
        {healthStyle && (
          <span
            className="pointer-events-none absolute right-1.5 top-1.5 z-[7] inline-flex h-2.5 w-2.5 items-center justify-center"
            role="img"
            aria-label={healthStyle.label}
            title={healthStyle.label}
            data-testid="widget-health-dot"
            data-health-state={health!.state}
          >
            <span className={`h-2.5 w-2.5 rounded-full ring-2 ring-[var(--surface-raised)] ${healthStyle.dot}`} />
          </span>
        )}
        <div
          data-widget-header
          className={`${draggableHandleClass} ${headerAccent} fb-widget-header flex items-center justify-between px-2 py-1 cursor-move select-none border-b border-[color:var(--edge-soft)] backdrop-blur-sm`}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setHeaderCtxMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          <span className="fb-widget-title text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ink-70)] truncate flex items-center gap-1.5">
            {/* The kind's own icon, in a tinted chip. Hidden in the classic
                skin, which identifies a widget by its label alone. */}
            <span className="fb-widget-chip" aria-hidden>
              <Icon name={catalogIcon} size={11} />
            </span>
            {isActive && (
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500"
                title="Active — wheel scrolls this widget"
              />
            )}
            {isPinned && (
              <Icon name="push_pin" size={11} filled className="text-amber-600" />
            )}
            {isChildOfSection && (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!parent) return
                  // Eject: convert relative position to canvas coords
                  const canvasX = Math.round(parent.x + SECTION_PADDING + widget.x)
                  const canvasY = Math.round(parent.y + SECTION_PADDING + widget.y)
                  chimeOut()
                  void update(widget.id, {
                    parentSectionId: null,
                    x: canvasX,
                    y: canvasY
                  }).then(() => bumpLayout())
                }}
                title="Remove from section (eject to canvas)"
                className="text-[var(--ink-50)] hover:text-amber-700 transition-colors"
              >
                <Icon name="layers_clear" size={11} />
              </button>
            )}
            {widget.syncGroupId && (
              <span
                title="Synced copy — content, title and colour mirror across all linked copies (even in other tasks). Right-click → ‘Unlink from synced copies’ to make this one independent."
                className="inline-flex items-center text-accent shrink-0"
              >
                <Icon name="link" size={11} />
              </span>
            )}
            {titleEditing ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTitle()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setTitleEditing(false)
                  }
                }}
                placeholder={widgetDisplayName(widget, headerLabel)}
                aria-label="Widget name"
                className="widget-nodrag min-w-0 flex-1 bg-transparent border-b border-accent/60 text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ink-90)] placeholder:text-[var(--ink-40)] placeholder:normal-case"
              />
            ) : (
              <span
                data-testid={`widget-title-${widget.id}`}
                onClick={(e) => {
                  // Two clicks within 350ms = rename. The first click still
                  // propagates so the widget activates normally.
                  const now = Date.now()
                  if (now - lastTitleClickRef.current < 350) {
                    e.stopPropagation()
                    lastTitleClickRef.current = 0
                    beginRename()
                  } else {
                    lastTitleClickRef.current = now
                  }
                }}
                title="Double-click to rename"
                className="widget-nodrag truncate cursor-text"
              >
                {widgetDisplayName(widget, headerLabel)}
              </span>
            )}
            {/* DEC-076/077 — bell + completion, ADJACENT TO THE TITLE, away
                from the right-side control array where they got lost. The
                bell fills SOLID when a live item points at this widget (the
                brand icon is a line SVG whose `filled` prop is a no-op — it
                fills here explicitly); the circle is the one completion
                form factor every surface shares. */}
            {attentionOn && !titleEditing && (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  if (attentionItem) goAttention()
                  else markWidgetForAttention()
                }}
                className={`widget-nodrag ml-1 h-5 w-5 rounded inline-flex items-center justify-center shrink-0 transition-colors ${
                  attentionItem
                    ? 'text-accent hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]'
                    : // DEC-089 — was ink-40 at 60%: tuned for the light
                      // stone bar, invisible on the dark one. Quiet, not gone.
                      'text-[var(--ink-50)] opacity-80 hover:opacity-100 hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] hover:text-accent'
                }`}
                aria-label={attentionItem ? 'In Attention — open the queue' : 'Add to Attention'}
                title={
                  attentionItem
                    ? `In Attention: “${attentionItem.title || 'this widget'}” — click to open the queue`
                    : 'Add to Attention'
                }
                data-testid={`widget-bell-${widget.id}`}
              >
                <BellIcon size={13} active={!!attentionItem} />
              </button>
            )}
            {attentionOn && attentionItem && !titleEditing && (
              <CompleteCircle
                size={14}
                className="widget-nodrag shrink-0"
                onClick={() =>
                  void closeWorkItem(
                    attentionItem,
                    (PRIMARY_ACTION[queueOf(attentionItem)] ?? PRIMARY_ACTION.to_do).state
                  )
                }
                title={`${(PRIMARY_ACTION[queueOf(attentionItem)] ?? PRIMARY_ACTION.to_do).label} — complete “${attentionItem.title || 'this item'}”`}
                dataTestId={`widget-attn-complete-${widget.id}`}
              />
            )}
          </span>
          <div className="fb-widget-actions flex items-center gap-0.5">
            {!titleEditing && (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  beginRename()
                }}
                className="widget-nodrag h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-50)] opacity-75 hover:opacity-100 hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] hover:text-accent transition-opacity"
                aria-label="Rename widget"
                title="Rename"
              >
                <Icon name="edit" size={12} />
              </button>
            )}
            {linkDrag && (
              <button
                // Any widget with a header is a valid link SOURCE — top-level,
                // pinned, or a section child (widget-link-owner: sections/children/
                // pinned are all valid endpoints). No child gate is needed: icons/
                // list children never mount WidgetFrame (they use CompactChildView,
                // no header), so the hub only appears where a header exists (free/
                // grid/stacks). Rects are read in viewport coords like any widget,
                // so the line anchors to the child's visible edge inside the frame.
                // mousedown stopPropagation prevents react-rnd from
                // treating this click as a drag-handle press (the button
                // lives inside the .widget-handle div). The actual arming
                // happens on click so we don't fight the browser's natural
                // click-vs-drag detection.
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  linkDrag.start(widget.id)
                }}
                className="h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-50)] hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] hover:text-accent cursor-cell"
                aria-label="Link to another widget"
                title="Click, then click another widget to connect them"
              >
                <Icon name="add_link" size={14} />
              </button>
            )}
            {!isChildOfSection && (
              <PinControl
                isPinned={isPinned}
                pinnedZone={widget.pinnedZone}
                onPickZone={(zone) => {
                  void pinToZone(widget.id, zone)
                }}
                onUnpin={() => {
                  // Legacy free-pin widgets fall through to togglePin (which
                  // knows how to convert screen-pos → canvas-pos). Zone pins
                  // use unpinWidget which clears the flags cleanly.
                  if (widget.pinnedZone !== null) {
                    void unpinWidget(widget.id)
                  } else {
                    void togglePin(widget.id)
                  }
                }}
                open={pinPickerOpen}
                setOpen={setPinPickerOpen}
              />
            )}
            {!isChildOfSection && (
              <>
                <ResizeStepButton
                  direction="shrink"
                  widgetId={widget.id}
                  onClick={() => scaleWidgetBy(1 / 1.5)}
                />
                <ResizeStepButton
                  direction="grow"
                  widgetId={widget.id}
                  onClick={() => scaleWidgetBy(1.5)}
                />
              </>
            )}
            <ExpandControl
              open={expandPickerOpen}
              setOpen={setExpandPickerOpen}
              onFocusMode={() => setFocused(widget.id)}
              onEnlargeOnDesk={() => scaleWidgetBy(1.3)}
            />
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                if (confirm('Remove from the desk?')) void remove(widget.id)
              }}
              className="h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-50)] hover:bg-red-100 hover:text-red-700"
              aria-label="Remove widget"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        </div>
        <div
          ref={bodyRef}
          // Auto-grow widgets size to their content, but cap out (e.g. a very
          // long sticky) or sit in a fixed slot when pinned / inside a section.
          // DEC-133 (operator: the home tiles' rule, for desk widgets too) —
          // EVERY widget body scrolls vertically rather than clipping, so the
          // content stays reachable whenever the frame cannot grow to fit it.
          // A widget whose root fills the frame never shows a bar.
          className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        >
          <FrameCallbacksProvider value={frameCallbacks}>{children}</FrameCallbacksProvider>
          <WidgetSetupAffordance widget={widget} />
        </div>
      </div>
      {headerCtxMenu && (
        // Every widget's header right-click now resolves through the one unified
        // menu. When this widget is part of a 2+ selection, the menu shows the
        // bulk multi-selection actions instead of the single-widget menu. The
        // frame management actions (make-task, share, synced / independent
        // duplicate, eject, unlink, archive) are supplied as callbacks so their
        // behaviour is identical to the old header menu, and any kind-specific
        // rows ride in as headerExtras.
        <UnifiedWidgetMenu
          menuContext={(() => {
            const selIds = useWidgetStore.getState().selectedIds
            if (selIds.length > 1 && selIds.includes(widget.id)) {
              const sel = allWidgets.filter((w) => selIds.includes(w.id))
              return buildContextForMulti(sel, { clientX: headerCtxMenu.x, clientY: headerCtxMenu.y })
            }
            return buildContextForWidget(
              widget,
              { clientX: headerCtxMenu.x, clientY: headerCtxMenu.y },
              { frame: frameCallbacks, headerExtras: headerMenuExtras }
            )
          })()}
          onClose={() => setHeaderCtxMenu(null)}
        />
      )}
      {makeTaskOpen && (
        <MakeTaskDialog
          // Seed the task title from whatever the widget already has —
          // its display title first, then a snippet of content if the
          // title is blank, then the kind as a last resort.
          seedTitle={
            widget.title ||
            (widget.content ? widget.content.replace(/\s+/g, ' ').slice(0, 80) : '') ||
            widget.kind
          }
          // Pass the widget so the dialog can offer to clone it into the
          // new task — a common follow-on intent ("I want to keep working
          // on the same thing but as its own task").
          sourceWidget={widget}
          onClose={() => setMakeTaskOpen(false)}
        />
      )}
      {shareOpen && (
        <ShareDialog
          kind="widget"
          entityId={widget.id}
          label={widget.title || widget.kind}
          onClose={() => setShareOpen(false)}
        />
      )}
    </Rnd>
  )
}

// ── Resize step button — small +/− in the header for quick scaling ──────────
//
// One-click ratchet: every press grows or shrinks the widget by 50%, capped
// at the same [180×120, 1400×900] envelope as enlarge-on-desk. Used in
// pairs so the user gets symmetric grow/shrink ergonomics without opening
// the expand popover. We deliberately use the inverse factor (×1.5 grow,
// ÷1.5 shrink) so the two operations cancel — pressing + then − returns
// the widget to its original size within a pixel.

function ResizeStepButton({
  direction,
  widgetId,
  onClick
}: {
  direction: 'grow' | 'shrink'
  widgetId: string
  onClick: () => void
}): JSX.Element {
  const isGrow = direction === 'grow'
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-50)] hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] hover:text-[var(--ink-100)] transition-colors"
      aria-label={isGrow ? 'Grow widget' : 'Shrink widget'}
      data-testid={isGrow ? `widget-grow-${widgetId}` : `widget-shrink-${widgetId}`}
      title={
        isGrow
          ? 'Grow this widget by 50% (max 1400 × 900)'
          : 'Shrink this widget by ~33% (min 180 × 120) — inverse of grow so + then − returns to the original size'
      }
    >
      <Icon name={isGrow ? 'add' : 'remove'} size={13} />
    </button>
  )
}

// ── Pin control — button + zone picker popover ──────────────────────────────
//
// Closed state: a pin icon — amber-filled if currently pinned, stone outline
// if not. Click toggles the popover open.
//
// Open state: a 2x2 grid of zone targets (TL/TR/BL/BR). Each cell shows a
// small corner glyph. Picking a zone pins the widget there (auto-stacks
// with same-zone neighbours). When already pinned, an extra "Unpin" button
// appears at the bottom.
//
// Closes on click-outside via a mousedown listener on document. Stops
// propagation up so the canvas pan / widget click logic doesn't fire when
// the popover is open.

interface PinControlProps {
  isPinned: boolean
  pinnedZone: PinZone | null
  open: boolean
  setOpen: (v: boolean) => void
  onPickZone: (zone: PinZone) => void
  onUnpin: () => void
}

function PinControl({
  isPinned,
  pinnedZone,
  open,
  setOpen,
  onPickZone,
  onUnpin
}: PinControlProps): JSX.Element {
  // The popover is rendered via createPortal into document.body to escape
  // the widget's stacking context — Rnd's outer div has a zIndex (set per-
  // widget) which creates a stacking context that traps any in-tree popover
  // behind sibling widgets with higher zIndex. The transform on the canvas
  // parent traps it further. Portalling is the only fix; bumping z-index
  // inside the widget's context never wins.
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      // Click-outside closes — but the popover is in a portal, so we have
      // to check both the trigger button AND the portalled popover.
      const inButton = buttonRef.current?.contains(e.target as Node)
      const inPopover = popoverRef.current?.contains(e.target as Node)
      if (!inButton && !inPopover) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    // Close on scroll/resize too — the popover position is computed from
    // the button's screen rect at open time, so any view change would
    // visually detach it from the trigger. Cheaper than tracking the
    // button position via rAF.
    function onViewChange(): void {
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onViewChange)
    window.addEventListener('scroll', onViewChange, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onViewChange)
      window.removeEventListener('scroll', onViewChange, true)
    }
  }, [open, setOpen])

  // Anchor the popover under the button's right edge. useLayoutEffect so the
  // measurement happens after DOM mount but before paint — no flash at the
  // wrong position.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      setPopoverPos(null)
      return
    }
    const r = buttonRef.current.getBoundingClientRect()
    setPopoverPos({
      top: r.bottom + 6,
      right: window.innerWidth - r.right
    })
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className={`h-6 w-6 rounded inline-flex items-center justify-center transition-colors ${
          isPinned
            ? 'text-amber-600 hover:bg-amber-100'
            : 'text-[var(--ink-50)] hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] hover:text-[var(--ink-100)]'
        }`}
        aria-label={isPinned ? 'Pin options' : 'Pin to screen'}
        title={
          isPinned
            ? pinnedZone
              ? `Pinned to ${PIN_ZONE_LABELS[pinnedZone]} — click to change`
              : 'Pinned (legacy) — click to change'
            : 'Pin to screen — pick a corner zone'
        }
      >
        <Icon name="push_pin" size={13} filled={isPinned} />
      </button>
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          onMouseDown={(e) => e.stopPropagation()}
          // Fixed positioning + portalled into document.body means stacking
          // contexts of the canvas + widget tree no longer apply. z-[200]
          // sits above pinned-layer (z-30), floating toolbar (z-20), and
          // anything else in the canvas chrome, but below modal dialogs
          // (typically z-[300]+).
          className="fixed z-[200] w-44 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-2 cursor-default"
          style={{ top: popoverPos.top, right: popoverPos.right }}
        >
          <div className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] mb-1.5">
            Pin to zone
          </div>
          <div className="grid grid-cols-2 gap-1">
            {(['tl', 'tr', 'bl', 'br'] as PinZone[]).map((z) => {
              const active = isPinned && pinnedZone === z
              return (
                <button
                  key={z}
                  onClick={(e) => {
                    e.stopPropagation()
                    onPickZone(z)
                    setOpen(false)
                  }}
                  className={`flex flex-col items-center gap-0.5 py-2 rounded border text-[10px] transition-colors ${
                    active
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
                      : 'border-[var(--edge-soft)] hover:border-amber-400 hover:bg-amber-50/50 dark:hover:bg-amber-950/20 text-[var(--ink-70)]'
                  }`}
                >
                  <Icon name={PIN_ZONE_ICONS[z]} size={14} />
                  <span>{PIN_ZONE_LABELS[z]}</span>
                </button>
              )
            })}
          </div>
          {isPinned && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onUnpin()
                setOpen(false)
              }}
              className="w-full mt-1.5 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] rounded px-2 py-1 text-left inline-flex items-center gap-1"
            >
              <Icon name="close" size={11} />
              <span>Unpin — return to canvas</span>
            </button>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

// ── Expand control — open-in-focus-mode + enlarge-on-desk popover ──────────
//
// Closed state: a standard "open in full" icon. Click toggles a small
// portalled popover with two options:
//   1. "Larger on desk" — grows the widget in place via the parent's
//      onEnlargeOnDesk callback. Useful when you want a roomier surface
//      without losing canvas context.
//   2. "Focus mode" — pushes the widget into the full-pane focus view
//      via the parent's onFocusMode callback.
//
// Portalled into document.body to escape the widget's stacking context
// (same reason as PinControl — sibling widgets with higher zIndex would
// otherwise overlay the popover and swallow its clicks).

interface ExpandControlProps {
  open: boolean
  setOpen: (v: boolean) => void
  onFocusMode: () => void
  onEnlargeOnDesk: () => void
}

function ExpandControl({
  open,
  setOpen,
  onFocusMode,
  onEnlargeOnDesk
}: ExpandControlProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const inButton = buttonRef.current?.contains(e.target as Node)
      const inPopover = popoverRef.current?.contains(e.target as Node)
      if (!inButton && !inPopover) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    function onViewChange(): void {
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onViewChange)
    window.addEventListener('scroll', onViewChange, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onViewChange)
      window.removeEventListener('scroll', onViewChange, true)
    }
  }, [open, setOpen])

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      setPopoverPos(null)
      return
    }
    const r = buttonRef.current.getBoundingClientRect()
    setPopoverPos({
      top: r.bottom + 6,
      right: window.innerWidth - r.right
    })
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-50)] hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] hover:text-[var(--ink-100)]"
        aria-label="Expand options"
        title="Expand — bigger on desk or full focus mode"
      >
        <Icon name="open_in_full" size={13} />
      </button>
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[200] w-48 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1 cursor-default"
          style={{ top: popoverPos.top, right: popoverPos.right }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation()
              onEnlargeOnDesk()
              setOpen(false)
            }}
            className="w-full flex items-start gap-2 px-2 py-1.5 rounded hover:bg-[var(--surface-sunken)] text-left"
          >
            <Icon name="zoom_out_map" size={14} className="text-[var(--ink-50)] mt-[1px] shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-[var(--ink-90)]">Larger on desk</div>
              <div className="text-[10px] text-[var(--ink-50)] leading-tight">
                Grow in place — keep canvas context
              </div>
            </div>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onFocusMode()
              setOpen(false)
            }}
            className="w-full flex items-start gap-2 px-2 py-1.5 rounded hover:bg-[var(--surface-sunken)] text-left"
          >
            <Icon name="open_in_full" size={14} className="text-[var(--ink-50)] mt-[1px] shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-[var(--ink-90)]">Focus mode</div>
              <div className="text-[10px] text-[var(--ink-50)] leading-tight">
                Full pane — hide everything else
              </div>
            </div>
          </button>
        </div>,
        document.body
      )}
    </>
  )
}
