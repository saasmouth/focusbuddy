import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useWidgetStore, focusNavOrder } from '../stores/widgets'
import { useFocusSplitStore } from '../stores/focusSplit'
import { useFocusClustersStore, clusterDraftFrom } from '../stores/focusClusters'
import { useNodeStore } from '../stores/nodes'
import { catalogFor } from '../lib/widgetCatalog'
import WidgetFocusDock, { type ChromeTab } from './WidgetFocusDock'
import FocusAddSurface from './focus/FocusAddSurface'
import FocusChatSurface from './focus/FocusChatSurface'
import SplitGrid from './focus/SplitGrid'
import { widgetOpen } from '../lib/audioBeep'
import { renderWidgetInline } from '../lib/renderWidgetInline'
import { SplitDragProvider, useSplitDrag } from '../lib/focusSplitDrag'
import { useSplitDropTarget } from '../lib/useSplitDropTarget'
import Icon from './Icon'
import type { FocusCluster, PaneCell, PaneSource } from '@shared/types'

// The canonical inline-widget renderer now lives in ../lib/renderWidgetInline so
// the split-view panes and this classic single card render widgets identically.
const renderInline = renderWidgetInline

// Is `el` an interactive / content surface that a "click empty space to exit"
// press must NOT close on? Used by the interior-exit walk. Deliberately broad
// and conservative — when in doubt, treat as interactive so we DON'T close.
// Grounded in a per-widget audit of every focusable inline widget: the editors
// (ProseMirror/Tiptap, react-flow, office sheet grid), draw canvas, media,
// embedded browser, all form controls, and any element that advertises its own
// click affordance (a control data-testid, or a text/pointer cursor).
function isInteractiveForFocusExit(el: HTMLElement): boolean {
  const tag = el.tagName
  // Native interactive elements + media/embeds/scrollable data surfaces.
  if (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    tag === 'A' ||
    tag === 'LABEL' ||
    tag === 'CANVAS' ||
    tag === 'VIDEO' ||
    tag === 'AUDIO' ||
    tag === 'IMG' ||
    tag === 'IFRAME' ||
    tag === 'WEBVIEW' ||
    tag === 'TABLE' ||
    tag === 'TH' ||
    tag === 'TD' ||
    tag === 'SVG' ||
    tag === 'PATH'
  ) {
    return true
  }
  if (el.isContentEditable) return true
  const role = el.getAttribute('role')
  if (role === 'button' || role === 'link' || role === 'textbox' || role === 'menuitem' || role === 'tab') {
    return true
  }
  // Known editor / interactive-surface class or attribute hooks (from the audit):
  // Tiptap/ProseMirror (page, doc, markdown, note-rendered), react-flow (diagram,
  // map, mindmap), office grid cells, sticky/scratchpad/speeddeck surfaces.
  const cls = el.classList
  if (
    cls.contains('ProseMirror') ||
    cls.contains('tiptap') ||
    cls.contains('react-flow') ||
    cls.contains('react-flow__pane') ||
    cls.contains('react-flow__renderer') ||
    cls.contains('fb-sticky-rendered') ||
    cls.contains('fb-sticky-textarea') ||
    cls.contains('fb-note-rendered')
  ) {
    return true
  }
  // Any element the widget marked as a control/cell/interactive surface with a
  // data-testid, or its own click cursor, is off-limits. A plain background div
  // has neither, so it stays a valid exit target.
  if (el.hasAttribute('data-testid')) return true
  if (el.hasAttribute('data-sticky-check') || el.hasAttribute('data-col-index')) return true
  const cursor = el.style.cursor
  if (cursor === 'text' || cursor === 'pointer') return true
  return false
}

// Horizontal-swipe threshold (px of accumulated trackpad delta) before we step
// to the next/prev widget. High enough that a normal two-finger scroll inside a
// widget doesn't accidentally navigate.
const SWIPE_STEP = 120
// Mouse scroll-wheel over the backdrop navigates faster than the trackpad
// swipe: a low threshold (any real notch clears it → one widget per notch) and
// a short cooldown so brisk scrolling pages through quickly.
const WHEEL_STEP = 20
const WHEEL_COOLDOWN_MS = 70
// Slide/fade transition between widgets. `dir` is +1 (going next/right) or -1
// (prev/left) so the incoming card slides in from the correct side.
const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 48 : -48, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -48 : 48, opacity: 0 })
}
// Split cards never slide — they appear in place so the make-room grid reflow is
// the only motion. The single→split re-key at drag-start is made invisible here:
// the incoming grid card is already at full opacity (enter=center), and the
// outgoing single card vanishes in one frame (exit opacity 0, ~0 duration) so
// there's no slide-out and no lingering ghost.
const splitVariants = {
  enter: { x: 0, opacity: 1 },
  center: { x: 0, opacity: 1 },
  exit: { x: 0, opacity: 0, transition: { duration: 0 } }
}

// Thin wrapper: provides the split-drag context so the inner component (and the
// dock it renders) can share one drag session. Keeping the provider OUTSIDE the
// inner component lets the whole inner body call useSplitDrag/useSplitDropTarget.
export default function WidgetFocusMode(): JSX.Element | null {
  return (
    <SplitDragProvider>
      <FocusModeInner />
    </SplitDragProvider>
  )
}

function FocusModeInner(): JSX.Element | null {
  const focusedId = useWidgetStore((s) => s.focusedWidgetId)
  const widgets = useWidgetStore((s) => s.widgets)
  const setFocused = useWidgetStore((s) => s.setFocused)
  const focusNext = useWidgetStore((s) => s.focusNext)
  const focusPrev = useWidgetStore((s) => s.focusPrev)
  const setActive = useWidgetStore((s) => s.setActive)
  const widget = focusedId ? widgets.find((w) => w.id === focusedId) ?? null : null
  const entry = widget ? catalogFor(widget.kind) : null
  // Which permanent action tab (Add / AI Chat) is showing full-size, if any.
  // These are Focus-Mode chrome, not widgets, so their selection lives here in
  // local state rather than in the widget store. A non-null value overrides what
  // the card body + header render, while the underlying focused widget stays put
  // (so exiting the chrome tab returns you to the widget you were on).
  const [chromeTab, setChromeTab] = useState<ChromeTab | null>(null)
  const [maximized, setMaximized] = useState(false)
  // +1 when we advance right, -1 when left — drives the slide direction.
  const [dir, setDir] = useState(1)

  // Split / fill view (spec: docs/FOCUS-SPLIT-VIEW-SPEC.md). Session-local. When
  // `splitEngaged` is true (≥2 panes) the view region renders the tiled SplitGrid
  // instead of the classic single card; until then everything below is unchanged.
  const splitState = useFocusSplitStore((s) => s.state)
  const splitEngaged = useFocusSplitStore((s) => s.engaged)
  const splitInitFromSource = useFocusSplitStore((s) => s.initFromSource)
  const splitAddPane = useFocusSplitStore((s) => s.addPane)
  const splitRemovePane = useFocusSplitStore((s) => s.removePane)
  const splitSetActivePane = useFocusSplitStore((s) => s.setActivePane)
  const splitLoadState = useFocusSplitStore((s) => s.loadState)
  const splitReset = useFocusSplitStore((s) => s.reset)

  // ── Cluster persistence (C1) ────────────────────────────────────────────────
  // A split "group" is auto-saved per desk: the moment it engages (≥2 panes) we
  // create a focus_clusters row; every grow/shrink/reorder updates it; collapsing
  // back to a single pane deletes it. `liveClusterId` remembers which row the
  // current split maps to so updates target it instead of piling up new rows.
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  // The active desk's identity and objective, so both stay reachable even in a
  // full-screen widget view (PLX-UX-010 / PLX-UX-011).
  const activeDeskTitle = useNodeStore((s) => s.nodes.find((n) => n.id === s.activeTaskId)?.title ?? null)
  const activeDeskObjective = useNodeStore((s) => s.nodes.find((n) => n.id === s.activeTaskId)?.description ?? null)
  const clusters = useFocusClustersStore((s) => s.clusters)
  const saveCluster = useFocusClustersStore((s) => s.save)
  const removeCluster = useFocusClustersStore((s) => s.remove)
  const loadClustersForTask = useFocusClustersStore((s) => s.loadForTask)
  const clusterContaining = useFocusClustersStore((s) => s.clusterContaining)
  const evictFromOtherClusters = useFocusClustersStore((s) => s.evictFromOtherClusters)
  const liveClusterId = useRef<string | null>(null)
  // Re-render trigger for the active-cluster ring: liveClusterId is a ref (so the
  // reconcile effect can read/write it without re-render churn), but the dock needs
  // to know which cluster is open to accent-ring it. This mirrors the ref into
  // state whenever the split identity changes.
  const [activeClusterId, setActiveClusterId] = useState<string | null>(null)

  // Load this desk's saved clusters so the dock (C2) and cluster-aware entry (C3)
  // have them. Keyed on the active desk; reloads when the desk changes.
  useEffect(() => {
    if (activeTaskId) void loadClustersForTask(activeTaskId)
  }, [activeTaskId, loadClustersForTask])

  // Prune dead widget references (C4): if a member widget was deleted from the desk,
  // drop its pane from any saved cluster (deleting a cluster left with <2 members).
  // Runs when the widget set or the cluster list changes; never touches the cluster
  // currently open in a split (liveClusterId), so an in-use group isn't reshaped
  // under the user. A deleted member still renders a calm placeholder in the split
  // and dock tab until this runs — no crash either way.
  const prunePlaceholders = useFocusClustersStore((s) => s.prunePlaceholders)
  useEffect(() => {
    if (!activeTaskId || clusters.length === 0) return
    const liveIds = new Set(widgets.map((w) => w.id))
    void prunePlaceholders(activeTaskId, liveIds, liveClusterId.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets, clusters, activeTaskId])

  // ── Make-room reflow (redesign — docs/FOCUS-SPLIT-REDESIGN-SPEC.md) ────────
  // Drop a dragged dock source into a split cell. Dragging the FIRST extra tab in
  // creates the split; subsequent drops grow it 3→4. The store dedup turns a drop
  // of an already-shown source into a move.
  const onSplitDrop = (source: PaneSource, cell: PaneCell): void => {
    splitAddPane(source, cell)
    if (source.kind === 'widget') setActive(source.widgetId)
    // Exclusive membership (C4): this source now lives in the cluster being built
    // here, so pull it out of any OTHER cluster it belonged to. keepClusterId is the
    // live cluster (may be null if this drop is the one creating it — then it's
    // evicted from all others, which is correct). The reconcile effect persists the
    // new/updated live cluster right after.
    if (activeTaskId) void evictFromOtherClusters(activeTaskId, source, liveClusterId.current)
    widgetOpen()
  }

  // Leave the currently-open cluster WITHOUT deleting it (the group stays saved).
  // Tears down the live split so `useGrid` goes false and the dock's other tabs
  // (Add / AI Chat / ungrouped widgets) become reachable again. This is the "get
  // out of the group" escape hatch — picking any other dock tab calls it first.
  const leaveCluster = (): void => {
    liveClusterId.current = null
    setActiveClusterId(null)
    splitReset()
  }

  // Open a saved cluster's split (C2 dock click + C3 canvas-entry share this).
  // Hydrates the layout (resolving live content by id), marks the cluster live so
  // grow/shrink targets THIS row, and — when entered via a specific member widget
  // — makes that widget's pane the active one so you land where you clicked.
  const openCluster = (cluster: FocusCluster, activeWidgetId?: string): void => {
    setChromeTab(null)
    splitLoadState(cluster.shape, cluster.panes, cluster.ratios)
    if (activeWidgetId) {
      const pane = cluster.panes.find(
        (p) => p.source.kind === 'widget' && p.source.widgetId === activeWidgetId
      )
      if (pane) splitSetActivePane(pane.id)
    }
    liveClusterId.current = cluster.id
    setActiveClusterId(cluster.id)
    widgetOpen()
    reclaimFocus()
  }
  // The body region physically shrinks its content to make room while a tab is
  // dragged in. The make-room animation is owned by CSS: SplitGrid sets the grid
  // tracks declaratively per render and the .fb-split-cluster class springs them
  // between layouts (ported from split-mock.html). No JS scalar drives the tracks
  // — the old reflow-MotionValue desynced from React on commit and stranded the
  // 3rd/4th pane's track; CSS owning the tween has nothing to desync.
  const { drag } = useSplitDrag()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const { insideBody, hoveredCell, preview } = useSplitDropTarget(bodyRef, splitState, onSplitDrop)
  // A make-room preview is active while dragging inside the body AND a well exists.
  const reflowActive = drag.active && insideBody && preview.wells.length > 0
  // The view routes through SplitGrid whenever engaged OR previewing (the 1-pane
  // seam fix — even a single pane renders via the grid during a drag so it can
  // shrink to make room).
  const useGrid = splitEngaged || reflowActive

  // Reconcile the persisted cluster with the live split (C1). Declarative +
  // idempotent: whatever mutation path changed the split (drop, close-pane,
  // resize, reorder), this brings the saved row in line. Engaged (≥2 panes) →
  // create-or-update; collapsed (≤1 pane) → delete. Keyed on a stringified
  // snapshot of the persist-relevant fields so it fires once per real change,
  // not on every render. saveCluster/removeCluster don't touch splitState, so
  // there's no feedback loop.
  const clusterSnapshot = JSON.stringify({
    engaged: splitEngaged,
    shape: splitState.shape,
    panes: splitState.panes,
    ratios: splitState.ratios,
    active: splitState.activePaneId
  })
  useEffect(() => {
    // Only reconcile while focus mode is OPEN. When it closes, `widget` goes null
    // and the exit effect calls splitReset() → engaged flips false; we must NOT
    // read that as "user dissolved the group" and delete the row — the cluster is
    // meant to survive exit. The exit effect clears liveClusterId without deleting.
    if (!activeTaskId || !widget) return
    let cancelled = false
    if (splitEngaged) {
      const draft = clusterDraftFrom(
        activeTaskId,
        splitState.shape,
        splitState.panes,
        splitState.ratios,
        splitState.activePaneId,
        liveClusterId.current ?? undefined
      )
      void saveCluster(draft).then((saved) => {
        if (!cancelled && saved) {
          liveClusterId.current = saved.id
          setActiveClusterId(saved.id)
        }
      })
    } else if (liveClusterId.current) {
      // Collapsed back to a single pane by the USER (closed panes down to 1) while
      // still in focus mode → the group is genuinely gone; delete it.
      const id = liveClusterId.current
      liveClusterId.current = null
      setActiveClusterId(null)
      void removeCluster(id)
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterSnapshot, activeTaskId, widget])

  // The desk's focusable widgets in spatial reading order — the same order the
  // store's focusNext/focusPrev walk, and what the dock shows. Recomputed as
  // widgets move so navigation always reflects the current layout.
  const deck = useMemo(() => focusNavOrder(widgets), [widgets])
  const activeIndex = widget ? deck.findIndex((w) => w.id === widget.id) : -1

  // The overlay owns keyboard focus so ←/→ reach us no matter what the widget
  // renders. Without this, a widget that auto-focuses a textarea (sticky/note)
  // or an embedded <webview> (a browser tab) swallows the arrow keys and nav
  // "works half the time" depending on what stole focus. We reclaim focus to
  // this element on mount and after every navigation.
  const overlayRef = useRef<HTMLDivElement | null>(null)

  // Blur whatever currently holds focus INSIDE this overlay — a text field a
  // widget auto-focused, or a <webview> guest page — and hand focus back to the
  // overlay so the next keypress lands here. Webviews are separate render
  // processes; blurring the host element returns key handling to the app.
  const reclaimFocus = (): void => {
    const active = document.activeElement as HTMLElement | null
    if (active && active !== overlayRef.current && overlayRef.current?.contains(active)) {
      active.blur?.()
    }
    overlayRef.current?.focus({ preventScroll: true })
  }

  const goNext = (): void => {
    setDir(1)
    setChromeTab(null) // arrows return to browsing widgets, off any action tab
    if (liveClusterId.current) leaveCluster() // arrows exit the current group
    focusNext()
    widgetOpen()
    reclaimFocus()
  }
  const goPrev = (): void => {
    setDir(-1)
    setChromeTab(null)
    if (liveClusterId.current) leaveCluster()
    focusPrev()
    widgetOpen()
    reclaimFocus()
  }

  // Reset maximize + any active chrome tab when the modal closes / a different
  // widget opens, so re-entering focus mode always starts on the widget itself.
  useEffect(() => {
    if (!widget) {
      setMaximized(false)
      setChromeTab(null)
      // Forget which persisted cluster the split mapped to WITHOUT deleting it —
      // the group is saved and must survive exit (C1). Clearing the ref first means
      // the reset below (which flips engaged→false) can't be misread as a dissolve.
      liveClusterId.current = null
      setActiveClusterId(null)
      splitReset() // tear down the LIVE split arrangement; the saved cluster stays
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget])

  // Cluster-on-entry (C3): a widget that belongs to a saved cluster is never seen
  // ALONE — focusing it (canvas double-click, arrow nav, dock pick) opens the whole
  // group with that widget's pane active. Runs before the single-pane seeding below
  // and short-circuits it (seeding skips grouped widgets), so a member never briefly
  // renders solo. Guarded to fire once per entry: only when not already showing this
  // exact cluster. Keyed on the focused widget id (the entry signal) + the loaded
  // clusters (so it also fires once clusters finish loading right after open).
  useEffect(() => {
    if (!widget || chromeTab) return
    const cluster = clusterContaining({ kind: 'widget', widgetId: widget.id })
    if (!cluster) return
    if (liveClusterId.current !== cluster.id) {
      // Entering this cluster for the first time (from canvas / a different group /
      // solo) → hydrate it with the entered widget's pane active.
      openCluster(cluster, widget.id)
    } else {
      // Already in this cluster and navigation landed on another of its members →
      // just make that member's pane active; don't re-hydrate.
      const pane = splitState.panes.find(
        (p) => p.source.kind === 'widget' && p.source.widgetId === widget.id
      )
      if (pane && pane.id !== splitState.activePaneId) splitSetActivePane(pane.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget, chromeTab, clusters])

  // While NOT in split, keep the split store's pane 0 mirroring the focused
  // widget (or the active chrome tab), so the moment the user adds a 2nd pane the
  // first pane already holds exactly what they were looking at. Once engaged
  // (≥2 panes) we stop syncing so navigation/arrows don't disturb the layout.
  // Grouped widgets are handled by the cluster-on-entry effect above, so we skip
  // seeding them solo (that would flash a single pane before the cluster hydrates).
  useEffect(() => {
    if (splitEngaged) return
    if (chromeTab) {
      splitInitFromSource({ kind: 'chrome', tab: chromeTab })
    } else if (widget) {
      // Skip if this widget belongs to a cluster — the entry effect opens the group.
      if (clusterContaining({ kind: 'widget', widgetId: widget.id })) return
      splitInitFromSource({ kind: 'widget', widgetId: widget.id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget, chromeTab, splitEngaged])

  // Grab keyboard focus when focus mode opens (and whenever the focused widget
  // changes) so arrows work immediately, before the user clicks anything. A
  // widget that auto-focuses an EMPTY field on mount (sticky/note) may focus
  // itself a frame or two after we do, so we reclaim across the next few frames
  // — but only while the field the widget grabbed is still empty (if the user
  // has started typing, we leave their caret alone). This makes nav
  // timing-independent instead of racing a single rAF.
  const focusWidgetId = widget?.id
  useEffect(() => {
    if (!focusWidgetId) return
    let frame = 0
    let raf = 0
    const tick = (): void => {
      const active = document.activeElement as HTMLElement | null
      const overlay = overlayRef.current
      if (overlay) {
        const isField =
          active &&
          overlay.contains(active) &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable)
        const fieldEmpty =
          !isField ||
          ((active as HTMLInputElement).value ?? active!.textContent ?? '').trim().length === 0
        // Reclaim only when focus is nowhere useful or on an empty auto-focused
        // field; never yank focus out of a field the user is typing into.
        if (!active || active === document.body || (isField && fieldEmpty)) {
          if (isField) active!.blur?.()
          overlay.focus({ preventScroll: true })
        }
      }
      frame += 1
      if (frame < 4) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [focusWidgetId])

  // Keyboard: Esc closes; ←/→ walk the deck. Registered in the CAPTURE phase so
  // the focus-mode handler sees the key before any bubbling widget handler. We
  // only defer to a field when the user is DELIBERATELY editing text inside the
  // focus card (an editable element that is the active element) — not for
  // webviews and not for a widget that merely auto-focused on mount, because we
  // reclaim focus to the overlay on entry/navigation.
  useEffect(() => {
    if (!widget) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        setFocused(null)
        return
      }
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
      // Defer to a text field ONLY when the user is genuinely mid-edit — an
      // editable element inside the card that actually HAS content the caret
      // could move through. A widget that merely auto-focused an EMPTY textarea
      // on mount (sticky/note) must NOT swallow the arrow: that auto-focus can
      // win a timing race against our reclaim, which is what made nav feel like
      // it "worked half the time". Empty field → navigate; non-empty → let the
      // caret move. The <webview> case isn't excluded here — its guest page
      // handles keys only when it truly has focus. */
      const el = document.activeElement as HTMLElement | null
      const tag = (el?.tagName ?? '').toLowerCase()
      const isTextField = tag === 'input' || tag === 'textarea' || !!el?.isContentEditable
      const card = overlayRef.current?.querySelector('[data-focus-card]')
      if (isTextField && card && el && card.contains(el)) {
        const value =
          tag === 'input' || tag === 'textarea'
            ? (el as HTMLInputElement | HTMLTextAreaElement).value
            : (el.textContent ?? '')
        // Only yield the arrow to a field the user is actually editing (has text).
        if (value.trim().length > 0) return
        // Empty auto-focused field: take focus back to the overlay, then navigate.
        el.blur?.()
        overlayRef.current?.focus({ preventScroll: true })
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'ArrowRight') goNext()
      else goPrev()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget, setFocused])

  // Wheel/trackpad navigation on the empty backdrop → step through the deck.
  // Two intents both navigate ONE widget per flick, with a short cooldown:
  //   • Trackpad horizontal swipe — anywhere over the overlay (deltaX dominant).
  //   • Mouse scroll wheel (vertical, deltaY) — but ONLY when the cursor is over
  //     the empty space around the card, so scrolling INSIDE a widget still
  //     scrolls the widget's own content. "Over the card" is detected by walking
  //     the wheel target up to the card element.
  const swipeAccum = useRef(0)
  const swipeCooldown = useRef(0)
  const onWheelNav = (e: React.WheelEvent): void => {
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
    // For a vertical scroll wheel, only navigate when the pointer is over the
    // backdrop (not the card). Horizontal swipes navigate anywhere.
    let delta: number
    // The scroll wheel gets a lower threshold + shorter cooldown than the
    // trackpad swipe so it steps briskly (roughly one widget per notch) without
    // making a two-finger trackpad swipe hair-trigger.
    let step = SWIPE_STEP
    let cooldownMs = 350
    if (horizontal) {
      delta = e.deltaX
    } else {
      const overCard = !!(e.target as HTMLElement).closest?.('[data-focus-card]')
      if (overCard) return // let the widget's own content scroll
      // Normalise line-mode wheels (deltaMode 1) to pixels so a mouse notch and
      // a trackpad scroll accumulate against the threshold at a comparable rate.
      delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      step = WHEEL_STEP
      cooldownMs = WHEEL_COOLDOWN_MS
    }
    const now = performance.now()
    if (now < swipeCooldown.current) return
    swipeAccum.current += delta
    if (Math.abs(swipeAccum.current) < step) return
    if (swipeAccum.current > 0) goNext()
    else goPrev()
    swipeAccum.current = 0
    swipeCooldown.current = now + cooldownMs
  }

  if (!widget) return null

  const canNavigate = deck.length > 1

  // When a chrome tab is active, it overrides the card's header + body while the
  // underlying focused widget stays selected in the store (so closing the tab or
  // arrowing returns you to that widget). The card animates keyed on this so the
  // slide transition fires when switching between a widget and an action tab.
  //
  // SEAMLESS SPLIT ENTRY (fixes the "swipe out" flash): entering/leaving a split
  // must NOT change the card key, or AnimatePresence(mode="wait") tears the card
  // out with a slide. The key therefore depends ONLY on what the card fundamentally
  // is at rest — a genuine ≥2 split ('split'), an action tab, or the focused
  // widget — and NOT on the transient make-room preview. When a 1-pane view
  // previews single→halves during a drag, the key stays the widget's id (the
  // preview grid renders that same widget via renderWidgetInline, so it reconciles
  // in place — no remount, no swipe). When the drag commits to a real split,
  // splitEngaged flips true and the key becomes 'split' on the SAME already-mounted
  // card. Result: the layout just makes room; nothing ever slides out.
  // The card key is chosen so NO re-key happens during a drag-into-split gesture
  // (a re-key = AnimatePresence remount = the "swipe out" flash):
  //   • resting single widget A → its 1→2 PREVIEW: both keyed by widget.id (the
  //     preview grid renders that same widget), so drag-start does NOT re-key.
  //   • preview → COMMITTED ≥2 split: key changes A→'split', but only once the
  //     card is already the transparent, borderless floating-grid — so any presence
  //     transition there is invisible (nothing to slide).
  // A committed split stays 'split' (stable across add/remove panes). Chrome tabs
  // and widget↔widget nav keep distinct keys so their directional slide still fires.
  const cardKey = splitEngaged
    ? 'split'
    : chromeTab
      ? `chrome-${chromeTab}`
      : widget.id
  const headerIcon = useGrid
    ? 'grid_view'
    : chromeTab
      ? chromeTab === 'add'
        ? 'add'
        : 'smart_toy'
      : entry?.icon ?? 'apps'
  const headerTitle = splitEngaged
    ? `Split · ${splitState.panes.length} panes`
    : reflowActive
      ? 'Split'
      : chromeTab
        ? chromeTab === 'add'
          ? 'Add'
          : 'AI Chat'
        : widget.title || entry?.label || 'Work widget'
  // Add tab → focus the freshly created/opened widget: leave the chrome tab,
  // select the new widget, and slide the deck to it so it reads as "you just
  // opened this document." The widget list updates via the store, so setFocused
  // alone is enough — the deck memo picks it up on the next render.
  const openWidgetFromAdd = (widgetId: string): void => {
    setChromeTab(null)
    setDir(1)
    setFocused(widgetId)
    setActive(widgetId)
    widgetOpen()
  }
  // In split mode, opening a widget from an Add pane fills a pane with it (as a
  // new pane if there's room, else it just focuses it in the store) rather than
  // collapsing back to a single card.
  const openWidgetFromAddSplit = (widgetId: string): void => {
    splitAddPane({ kind: 'widget', widgetId })
    setActive(widgetId)
    widgetOpen()
  }

  // The view region routes through SplitGrid whenever `useGrid` (engaged OR a
  // make-room preview is active) — the "1-pane seam" fix: even a single pane is
  // rendered THROUGH the grid during a drag so the existing content can physically
  // shrink to make room. The pane body uses renderWidgetInline (the SAME component
  // as the classic renderInline), so moving the widget from the plain card into a
  // one-cell grid does NOT remount it (keeps a live webview's page + a doc's editor
  // state alive). Off a drag with a single pane, it's the classic card.
  const cardBody: JSX.Element | null = useGrid ? (
    <SplitGrid
      state={splitState}
      widgets={widgets}
      onActivatePane={splitSetActivePane}
      onClosePane={splitRemovePane}
      onOpenWidget={openWidgetFromAddSplit}
      preview={reflowActive ? preview : null}
      hoveredCell={hoveredCell}
    />
  ) : chromeTab ? (
    chromeTab === 'add' ? (
      <FocusAddSurface onOpenWidget={openWidgetFromAdd} />
    ) : (
      <FocusChatSurface onOpenWidget={openWidgetFromAdd} />
    )
  ) : (
    renderInline(widget)
  )

  // Close focus mode when the user presses on the empty backdrop (the overlay
  // or the padding region around the card) — NOT on the card or any control.
  // We use onMouseDown, not onClick, so a single press exits IMMEDIATELY: a
  // `click` needs a matching mousedown+mouseup on the same element, which the
  // entry animation + focus-reclaim rAF could disrupt, making the first click
  // "not take". mousedown fires on the press itself, so one click always exits.
  // `data-focus-backdrop` marks the two elements that count as empty space; the
  // card and the chevrons stopPropagation / are not marked, so pressing them
  // never closes.
  // Single, unified exit rule for the ENTIRE overlay (backdrop margins, the
  // card's inert background, AND the empty space around the card). One press
  // exits UNLESS it landed on something the user meant to interact with. This
  // replaces the old exact-target `data-focus-backdrop` check, which only fired
  // on precisely two elements and left the corners/edges feeling dead.
  //
  // "Don't exit" cases, in order:
  //   1. Non-primary button.
  //   2. The press is on an interactive control OR live widget content — a nav
  //      chevron, the header buttons, a textarea/editor/canvas/table/button, or
  //      anything with a text/pointer/grab cursor. Detected by walking up from
  //      the target: a control/no-exit zone (data-focus-no-exit) or an
  //      interactive element (isInteractiveForFocusExit) anywhere in the chain
  //      cancels the exit.
  // Everything else — outer backdrop, card padding, a widget's inert coloured
  // background — exits on the first press. Erring toward NOT closing keeps live
  // content safe; the whole rest of the overlay is a one-click exit target.
  const onOverlayMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return // primary button only
    const overlay = e.currentTarget as HTMLElement
    const startCursor = window.getComputedStyle(e.target as HTMLElement).cursor
    if (
      startCursor === 'text' ||
      startCursor === 'pointer' ||
      startCursor === 'grab' ||
      startCursor === 'grabbing'
    ) {
      return
    }
    let el: HTMLElement | null = e.target as HTMLElement
    while (el && el !== overlay) {
      if (el.hasAttribute('data-focus-no-exit')) return
      if (isInteractiveForFocusExit(el)) return
      el = el.parentElement
    }
    e.preventDefault()
    setFocused(null)
  }

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      // z-[90]: a full-screen focus takeover must sit above the desk Columns
      // overlay (z-[60]) so focusing an object from column mode shows the pane
      // rather than staying hidden behind the columns; still below the dialog /
      // popover layer (z-100+). Was z-50 (fine on the canvas, too low for columns).
      // Starts at top-10, below the h-10 title bar (z-[195]), like the
      // assistant's panels: at inset-0 the top 40px — where the desk identity
      // and its objective tooltip sit (PLX-UX-010/011) — were under the bar.
      className="fb-scrim fixed inset-x-0 bottom-0 top-10 z-[90] flex flex-col"
      data-testid="widget-focus-mode"
      onMouseDown={onOverlayMouseDown}
      onWheel={onWheelNav}
    >
      {/* Desk identity stays visible even in a full-screen widget view, so the user
          always knows which desk they are in; its tooltip carries the desk's current
          objective, retrievable in one interaction (PLX-UX-010 / PLX-UX-011). Shown
          in the single-widget case; the grid header below carries it in grid mode. */}
      {!useGrid && activeDeskTitle && (
        <div
          className="absolute top-3 left-4 z-30 flex items-center gap-1.5 pointer-events-auto text-[var(--ink-60)]"
          data-testid="focus-desk-identity"
          data-focus-no-exit
          title={activeDeskObjective ? `Objective: ${activeDeskObjective}` : activeDeskTitle}
        >
          <Icon name="desk" size={14} />
          <span className="text-xs font-semibold">{activeDeskTitle}</span>
        </div>
      )}
      {/* Generous padding gives an obvious empty margin on every side to click
          for a one-press exit (see onOverlayMouseDown — the whole overlay is an
          exit target except live content / controls). The card keeps its size;
          only the breathing room grows. Clamped with vw/vh so it scales but
          never eats the card on a small screen. */}
      <div
        // The STABLE stage region — anchors the drop-target hit-testing. It is
        // OUTSIDE the AnimatePresence card (which remounts when cardKey flips
        // widget.id→'split' on the first commit), so bodyRef never goes null
        // mid-gesture. That remount was the 2→3→4 stale-drop bug: the resolver
        // fired with a detached body. Measuring this always-mounted wrapper — and
        // finding [data-split-cell] within it — keeps every drop landing, exactly
        // like the mock's persistent `.stage`. `data-fb-dragging` here also scopes
        // the webview-inert rule to the whole stage for the drag's duration.
        ref={bodyRef}
        className="relative flex-1 min-h-0 flex items-center justify-center"
        style={{
          // Generous card, small visible margin. 4vh/3.5vw keeps proportions on any
          // screen size — on 13" MBP (~800px tall) this is ~32px top/bottom; on 27"
          // (~1080px) it's ~43px. Clamp floor (20/24px) ensures the blurred canvas
          // backdrop is always visible at the edges without eating card real-estate.
          padding: maximized
            ? 0
            : 'clamp(20px, 4vh, 56px) clamp(24px, 3.5vw, 64px)'
        }}
        {...(drag.active ? { 'data-fb-dragging': true } : {})}
      >
        {/* When split, the outer card header is gone — a minimal chrome floats at
            the top over the backdrop: the "Split · N panes" title (left) and the
            maximize / close controls (right). Kept subtle so the floating panes
            stay the focus. */}
        {useGrid && (
          <div
            className="absolute top-3 inset-x-4 flex items-center gap-2 z-20 pointer-events-none"
            data-focus-no-exit
          >
            <div className="flex items-center gap-2 pointer-events-auto text-[var(--ink-60)]" data-testid="focus-desk-identity">
              {activeDeskTitle && (
                <span className="flex items-center gap-1.5" title={activeDeskObjective ? `Objective: ${activeDeskObjective}` : activeDeskTitle}>
                  <Icon name="desk" size={14} />
                  <span className="text-xs font-semibold">{activeDeskTitle}</span>
                  <span className="text-[var(--ink-40)]">/</span>
                </span>
              )}
              <Icon name="grid_view" size={16} />
              <span className="text-xs font-semibold">{headerTitle}</span>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-1 pointer-events-auto" data-focus-no-exit>
              <button
                onClick={() => setMaximized((v) => !v)}
                className="icon-btn"
                aria-label={maximized ? 'Restore window padding' : 'Maximize to full window'}
                title={maximized ? 'Restore' : 'Maximize'}
              >
                <Icon name={maximized ? 'fullscreen_exit' : 'fullscreen'} size={16} />
              </button>
              <button
                onClick={() => setFocused(null)}
                className="icon-btn"
                aria-label="Close full view"
                title="Close (Esc)"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Prev chevron — floats at the left edge, out of the card. */}
        {canNavigate && (
          <button
            onClick={(e) => { e.stopPropagation(); goPrev() }}
            className="fb-focus-nav-btn left-3"
            aria-label="Previous work widget (←)"
            title="Previous (←)"
            data-testid="focus-nav-prev"
          >
            <Icon name="chevron_left" size={22} />
          </button>
        )}

        {/* mode="wait": the exiting card finishes its slide-out BEFORE the
            incoming card mounts, so two cards never occupy the same cell at once.
            popLayout cross-faded them, which looked fine for a widget→widget
            slide but flashed overlapping text/content when switching between a
            widget and an action tab (their bodies differ completely). Sequential
            is marginally longer but always clean. */}
        {/* mode="popLayout" so a card entering split does NOT wait for the old one
            to slide out — combined with the no-slide variant below, entering split
            is seamless (the content just makes room; nothing swipes out). */}
        <AnimatePresence initial={false} custom={dir} mode="popLayout">
          <motion.div
            key={cardKey}
            data-focus-card
            custom={dir}
            // Split cards DON'T slide (that caused the "swipe out" flash on drag-in);
            // they just appear in place so the make-room reflow is the only motion.
            // Single widget/chrome cards keep the directional slide.
            variants={useGrid ? splitVariants : slideVariants}
            initial={useGrid ? 'center' : 'enter'}
            animate="center"
            exit={useGrid ? 'center' : 'exit'}
            transition={{ type: 'spring', stiffness: 320, damping: 32, mass: 0.9 }}
            // When SPLIT, the outer card DISSOLVES: no bg / border / shadow / radius
            // and no header bar — the pane grid fills the padded overlay and each
            // pane floats as its own tile on the blurred desk backdrop (the mock's
            // "floating tabs" feel). Single-pane keeps the classic focus card.
            className={
              useGrid
                ? 'w-full h-full flex flex-col overflow-visible bg-transparent'
                : `fb-card w-full h-full flex flex-col overflow-hidden ${
                    maximized ? '' : 'rounded-lg'
                  }`
            }
          >
            {/* Header bar is chrome, not "empty space to leave" — pressing its
                title/empty area must not exit (the × button does that). HIDDEN when
                split: each floating pane carries its own header, and a shared close/
                maximize floats over the backdrop instead (below). */}
            {!useGrid && (
            <div
              className="px-4 py-2.5 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex items-center gap-2 shrink-0"
              data-focus-no-exit
            >
              <Icon name={headerIcon} size={18} className="text-[var(--ink-70)]" />
              <h3 className="text-sm font-semibold text-[var(--ink-100)] flex-1 min-w-0 truncate">
                {headerTitle}
              </h3>
              {canNavigate && !chromeTab && (
                <span className="fb-tabular text-[11px] text-[var(--ink-40)] hidden sm:inline mr-1">
                  {activeIndex + 1} / {deck.length}
                </span>
              )}
              <span className="text-[11px] text-[var(--ink-50)] hidden md:inline">
                <kbd className="px-1 py-0.5 rounded bg-[var(--surface-sunken)] text-[var(--ink-70)]">←</kbd>
                <kbd className="px-1 py-0.5 rounded bg-[var(--surface-sunken)] text-[var(--ink-70)] ml-0.5">→</kbd>
                <span className="mx-1.5 text-[var(--ink-30)]">·</span>
                <kbd className="px-1 py-0.5 rounded bg-[var(--surface-sunken)] text-[var(--ink-70)]">Esc</kbd>
              </span>
              {/* Split hint — a quiet affordance telling the user the interaction
                  exists ("drag a tab up here"). Only shown while NOT yet split, so
                  it teaches once then gets out of the way. */}
              {!splitEngaged && (
                <span className="hidden lg:inline text-[10px] text-[var(--ink-40)] mr-1 select-none">
                  Drag a dock tab up to split
                </span>
              )}
              <button
                onClick={() => setMaximized((v) => !v)}
                className="icon-btn"
                aria-label={maximized ? 'Restore window padding' : 'Maximize to full window'}
                title={maximized ? 'Restore (1cm padding)' : 'Maximize (full window)'}
              >
                <Icon name={maximized ? 'fullscreen_exit' : 'fullscreen'} size={16} />
              </button>
              <button
                onClick={() => setFocused(null)}
                className="icon-btn"
                aria-label="Close full view"
                title="Close (Esc)"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            )}
            {/* Chrome tabs (Add / AI Chat) and the split grid are full interactive
                surfaces, not "empty space to leave" — mark them no-exit so a click
                inside (or in the gap between split panes) doesn't dismiss focus
                mode. Widget bodies manage their own exit via isInteractiveForFocusExit.
                The stable stage wrapper above carries bodyRef (drop hit-testing)
                and `data-fb-dragging` (which scopes the webview-inert globals.css
                rule for the drag). When split, overflow is visible so each floating
                pane's shadow isn't clipped. */}
            <div
              className={`relative flex-1 min-h-0 ${useGrid ? 'overflow-visible' : 'overflow-hidden'}`}
              {...(chromeTab || useGrid ? { 'data-focus-no-exit': true } : {})}
            >
              {cardBody}
              {/* Transparent capture veil while dragging: guarantees nothing beneath
                  it (a webview) can grab or repaint on the moving pointer. Hit-testing
                  is done from window pointer coords in useSplitDropTarget, so the veil
                  is purely a shield. */}
              {drag.active && (
                <div
                  className="absolute inset-0 z-30"
                  aria-hidden
                  data-focus-no-exit
                  style={{ background: 'transparent' }}
                />
              )}
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Next chevron — floats at the right edge, out of the card. */}
        {canNavigate && (
          <button
            onClick={(e) => { e.stopPropagation(); goNext() }}
            className="fb-focus-nav-btn right-3"
            aria-label="Next work widget (→)"
            title="Next (→)"
            data-testid="focus-nav-next"
          >
            <Icon name="chevron_right" size={22} />
          </button>
        )}
      </div>

      {/* The Stage-Manager-style dock/filmstrip along the bottom. */}
      <WidgetFocusDock
        widgets={deck}
        // Empty while a chrome tab OR a cluster is active so no widget tile reads
        // as selected.
        activeId={chromeTab || activeClusterId ? '' : widget.id}
        onPick={(id) => {
          const to = deck.findIndex((w) => w.id === id)
          setDir(to >= activeIndex ? 1 : -1)
          setChromeTab(null) // picking a widget leaves any action tab
          // Leave the open cluster first so the split tears down; if the picked
          // widget belongs to ANOTHER cluster, the cluster-on-entry effect re-opens
          // that one, otherwise it shows solo. Without this the still-engaged grid
          // would override the pick and trap you in the current group.
          if (liveClusterId.current) leaveCluster()
          setFocused(id)
          setActive(id)
          widgetOpen()
        }}
        activeChromeTab={chromeTab}
        onPickChrome={(tab) => {
          // Slide in from the right — the action tabs live at the end of the strip.
          setDir(1)
          // Leave any open cluster so useGrid drops and the chrome surface renders
          // (otherwise the engaged split grid keeps winning over the chrome tab).
          if (liveClusterId.current) leaveCluster()
          setChromeTab(tab)
          widgetOpen()
          reclaimFocus()
        }}
        clusters={clusters}
        activeClusterId={activeClusterId}
        onOpenCluster={(cluster) => openCluster(cluster)}
      />

      {/* The tile that follows the cursor while dragging a dock tab into a pane. */}
      <FocusDragGhost />
    </div>
  )
}

// A small labelled chip that follows the pointer while a dock tile is being
// dragged into the split view — the "you're carrying this" affordance. Rendered
// inside the SplitDragProvider so it can read the live drag state.
function FocusDragGhost(): JSX.Element | null {
  const { drag } = useSplitDrag()
  if (!drag.active || !drag.source) return null
  const glyph =
    drag.source.kind === 'widget'
      ? 'drag_indicator'
      : drag.source.kind === 'chrome'
        ? drag.source.tab === 'add'
          ? 'add'
          : 'smart_toy'
        : 'videocam'
  return (
    <div
      className="fixed z-[60] pointer-events-none -translate-x-1/2 -translate-y-1/2"
      style={{ left: drag.x, top: drag.y }}
      aria-hidden
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--surface-raised)] border border-[rgb(var(--accent))] shadow-xl">
        <Icon name={glyph} size={14} className="text-[rgb(var(--accent))]" />
        <span className="text-xs font-medium text-[var(--ink-90)] max-w-[160px] truncate">
          {drag.label}
        </span>
      </div>
    </div>
  )
}
