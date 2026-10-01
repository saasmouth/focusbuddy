import { create } from 'zustand'
import type { PinZone, Widget, WidgetDraft, WidgetPatch } from '@shared/types'
import { recordTrail } from '../lib/trail'
import { nudgeSync } from '../lib/syncNudge'
import { sectionCreate, widgetOpen } from '../lib/audioBeep'
import { notifyWireSource } from '../lib/wireEngine'
import { notifyAgentInputChanged } from '../lib/deskAgentEngine'
import { recordSnapshotSoon } from '../lib/timeTravel'
import {
  crdtEmitGeom,
  crdtEmitMembership,
  crdtEmitWidgetCreate,
  crdtEmitWidgetDelete,
  crdtEmitWidgetFields
} from '../lib/crdtBridge'
import { recordAction, recordActionWithToast } from './actionHistory'
import { focusNavOrder, isFocusable } from '../lib/focusNavOrder'
import { clampZoom } from '../lib/deskCameraNav'
import { useAccountStore } from './account'
import { currentDeviceClass } from '../lib/deviceClass'
import type { DeskLayout } from '@shared/deskLayout'
import {
  isOverlayEligible,
  patchTouchesOverlayGeometry,
  splitOverlayPatch,
  applyOverlayGeometry,
  serializeOverlayObjects
} from '../lib/deskLayoutOverlay'

// Re-export the Focus-Mode nav helpers so consumers (WidgetFocusMode, the split
// surfaces) can import them from the store alongside useWidgetStore.
export { focusNavOrder, isFocusable }

// Set while a multi-widget group drag commits, so the per-widget update() calls
// don't each push their own undo entry — endGroupDrag records one combined entry.
let suppressWidgetUndo = false

// Geometry / colour / section-membership are the structural widget edits worth
// undoing. Text content + title have their own native editing undo, and
// internal fields (sync group, url, pin) aren't user "actions".
const UNDOABLE_WIDGET_KEYS: Array<keyof WidgetPatch> = ['x', 'y', 'width', 'height', 'color', 'status', 'parentSectionId']

interface WidgetStore {
  widgets: Widget[]
  loadingFor: string | null
  // The Desk whose saved camera + selection overlay has been restored this open
  // (PLX-APP-010 / UX-032). Gates the debounced save so the reset-to-origin and
  // the restore itself never persist a spurious layout before hydration.
  layoutHydratedFor: string | null
  // Monotonic token bumped on every non-refresh loadForTask. Every awaited write
  // in that call is gated on it, so a reentrant open for the SAME taskId (e.g.
  // reloadCanvasStores after an AI-undo, or a live-canvas rebuild) supersedes the
  // earlier call's late restore, which a taskId-string compare cannot detect.
  loadToken: number
  // Whether the active Desk is opted into per-device object-geometry customisation
  // (PLX-APP-010 Phase 2, ADR-0006). False for every Desk by default, which keeps
  // the mutation path unchanged; true only after the user opts this Desk in on
  // this device. Set from the loaded overlay on Desk open.
  customLayout: boolean
  // Toggle per-device layout customisation for the active Desk. Enabling captures
  // the current arrangement into the personal overlay; disabling clears it and
  // reloads the shared base.
  setDeskCustomLayout: (enabled: boolean) => Promise<void>
  focusedWidgetId: string | null
  activeWidgetId: string | null
  hoveredSectionId: string | null
  // Transient drag position — set by WidgetFrame on every onDrag tick so
  // anything that depends on live widget position (e.g. the inter-widget
  // links overlay) can read this instead of the committed widget.x/y while
  // a drag is in flight. Cleared on drop. Only one widget can be dragged at
  // a time so a single slot is sufficient.
  dragOverride: { widgetId: string; x: number; y: number } | null
  setDragOverride: (override: { widgetId: string; x: number; y: number } | null) => void
  layoutVersion: number
  centerToken: number
  zoom: number
  panX: number
  panY: number
  // Screen-space x of the VISIBLE canvas origin (Edges + Glass Phase 1b): the
  // dock column's width while the desk runs full-bleed beneath it, 0 otherwise.
  // panX is always the visual pan the DOM renders; persisted cameras are
  // stored WITHOUT the inset so a desk opens in the same place whatever the
  // dock is doing. Changing the inset shifts the pan by the delta so nothing
  // on screen moves.
  dockInset: number
  setDockInset: (px: number) => void
  loadForTask: (taskId: string, opts?: { refresh?: boolean }) => Promise<void>
  clear: () => void
  create: (draft: WidgetDraft) => Promise<Widget>
  /** Best-effort create for auto-spawned chrome; resolves null if the task is gone. */
  createOptional: (draft: WidgetDraft) => Promise<Widget | null>
  update: (id: string, patch: WidgetPatch) => Promise<void>
  remove: (id: string) => Promise<void>
  archive: (id: string) => Promise<void>
  restore: (id: string) => Promise<void>
  // Park every visible, non-pinned, non-section, top-level widget — optionally keeping the
  // currently-active widget. Returns the count of widgets parked.
  parkAll: (keepActive: boolean) => Promise<number>
  bringToFront: (id: string) => Promise<void>
  setFocused: (id: string | null) => void
  // Focus-mode navigation. focusNext/focusPrev cycle the focused widget through
  // the current desk's visible widgets in spatial reading order (see
  // focusNavOrder), wrapping at the ends. No-ops when nothing is focused or the
  // desk has a single widget. Drives the ←/→ keys + swipe in WidgetFocusMode.
  focusNext: () => void
  focusPrev: () => void
  setActive: (id: string | null) => void
  setHoveredSection: (id: string | null) => void
  // ── Multi-select ──────────────────────────────────────────────────────────
  // selectedIds holds every canvas widget the user has marqueed or shift-picked.
  // Group-drag lets one dragged widget carry the whole selection: beginGroupDrag
  // snapshots each selected widget's start position, setGroupDelta is pushed on
  // every drag tick (members follow imperatively — no per-frame IPC), and
  // endGroupDrag commits all final positions in one batch.
  selectedIds: string[]
  setSelection: (ids: string[]) => void
  toggleSelection: (id: string) => void
  clearSelection: () => void
  groupDrag: { leaderId: string; dx: number; dy: number } | null
  groupStart: Record<string, { x: number; y: number }> | null
  beginGroupDrag: (leaderId: string) => void
  setGroupDelta: (dx: number, dy: number) => void
  endGroupDrag: () => Promise<void>
  focusOn: (id: string) => void
  zoomToWidget: (id: string) => void
  requestCenter: () => void
  bumpLayoutVersion: () => void
  togglePin: (id: string) => Promise<void>
  // Pin a widget to one of the 4 zone corners. The pinned-layer auto-stacks
  // multiple widgets in the same zone with no overlap. Use this instead of
  // togglePin when you want zone docking instead of legacy free-position pin.
  pinToZone: (id: string, zone: PinZone) => Promise<void>
  // Unpin — returns to canvas at its prior canvas-space position (or the
  // current screen position translated to canvas-space, for legacy pins).
  unpinWidget: (id: string) => Promise<void>
  setZoom: (z: number) => void
  setPan: (x: number, y: number) => void
  panBy: (dx: number, dy: number) => void
  zoomTowardPoint: (newZoom: number, screenX: number, screenY: number) => void
  resetView: () => void
}

// Zoom bounds and the clamp live in lib/deskCameraNav, which is the pure module
// that also has to respect them when it picks a zoom to navigate at. They were
// defined here and, separately and WRONGLY, in ZoomControls -- see the note
// there.

export const useWidgetStore = create<WidgetStore>((set, get) => ({
  widgets: [],
  loadingFor: null,
  layoutHydratedFor: null,
  loadToken: 0,
  customLayout: false,
  focusedWidgetId: null,
  activeWidgetId: null,
  hoveredSectionId: null,
  dragOverride: null,
  setDragOverride: (override) => set({ dragOverride: override }),
  layoutVersion: 0,
  centerToken: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  dockInset: 0,
  setDockInset: (px) => {
    const prev = get().dockInset
    if (px === prev) return
    set({ dockInset: px, panX: get().panX + (px - prev) })
  },
  loadForTask: async (taskId, opts) => {
    if (opts?.refresh) {
      // In-place refresh (sync applied remote changes, etc.): keep the current
      // widget array, camera and selection mounted while the fresh list loads.
      // The old behaviour cleared everything first, which blanked the desk for
      // a frame and remounted every widget — each <webview> is its own process,
      // so that read as the whole desktop "blinking" every sync cycle.
      set({ loadingFor: taskId })
      const widgets = await window.api.widgets.listByTask(taskId)
      if (get().loadingFor === taskId) set({ widgets, loadingFor: null })
      return
    }
    // Per-call token: distinguishes a reentrant open for the SAME taskId from
    // this call itself, which the loadingFor string compare cannot. Every awaited
    // write below is gated on it, so a newer open always wins.
    const token = get().loadToken + 1
    set({
      loadToken: token,
      loadingFor: taskId,
      widgets: [],
      focusedWidgetId: null,
      activeWidgetId: null,
      selectedIds: [],
      groupDrag: null,
      groupStart: null,
      zoom: 1,
      panX: get().dockInset,
      panY: 0,
      layoutHydratedFor: null,
      customLayout: false
    })
    const widgets = await window.api.widgets.listByTask(taskId)
    if (get().loadToken !== token) return // superseded by a newer open (any taskId)
    set({ widgets, loadingFor: null })
    // Baseline snapshot for time-travel (dedup keeps it cheap on re-open).
    recordSnapshotSoon(taskId)
    // Restore this user's saved camera + selection overlay for this Desk and
    // device class (PLX-APP-010 Phase 1 / UX-032, ADR-0006). Absent overlay =
    // the reset origin above. Stale selected ids (deleted Objects) are dropped
    // so restoration degrades gracefully (UX-033).
    const userId = useAccountStore.getState().account?.id ?? 'local'
    try {
      const saved = await window.api.deskLayout.load(userId, taskId, currentDeviceClass())
      // Abandon if a newer open superseded this call while we awaited.
      if (get().loadToken !== token) return
      if (saved) {
        const present = new Set(get().widgets.map((w) => w.id))
        // Phase 2 (ADR-0006): when this Desk is opted into per-device layout,
        // the personal overlay wins for eligible top-level Objects. Applied over
        // the base widgets before they settle, so downstream consumers (render,
        // sections, links) read the effective geometry transparently.
        const custom = saved.customLayout === true
        set({
          widgets:
            custom && Array.isArray(saved.objects) && saved.objects.length
              ? applyOverlayGeometry(get().widgets, saved.objects)
              : get().widgets,
          customLayout: custom,
          zoom: clampZoom(typeof saved.zoom === 'number' ? saved.zoom : 1),
          panX: (saved.scroll?.x ?? 0) + get().dockInset,
          panY: saved.scroll?.y ?? 0,
          selectedIds: Array.isArray(saved.selectedObjectIds)
            ? saved.selectedObjectIds.filter((id) => present.has(id))
            : [],
          layoutHydratedFor: taskId
        })
      } else {
        set({ layoutHydratedFor: taskId })
      }
    } catch {
      // A missing bridge or a read error must not block the Desk from opening;
      // mark hydrated so saves can begin from the current (origin) camera, unless
      // a newer open already superseded this call.
      if (get().loadToken === token) set({ layoutHydratedFor: taskId })
    }
  },
  clear: () =>
    set({
      // Bump the token so an in-flight loadForTask cannot repopulate or restore a
      // Desk the user has already backed out of (the token-scheme equivalent of
      // the old loadingFor-null guard).
      loadToken: get().loadToken + 1,
      widgets: [],
      loadingFor: null,
      layoutHydratedFor: null,
      focusedWidgetId: null,
      activeWidgetId: null,
      selectedIds: [],
      groupDrag: null,
      groupStart: null,
      zoom: 1,
      panX: get().dockInset,
      panY: 0
    }),
  setFocused: (id) => set({ focusedWidgetId: id }),
  focusNext: () => {
    const order = focusNavOrder(get().widgets)
    if (order.length < 2) return
    const cur = get().focusedWidgetId
    const i = order.findIndex((w) => w.id === cur)
    const next = order[(i + 1 + order.length) % order.length]
    set({ focusedWidgetId: next.id, activeWidgetId: next.id })
  },
  focusPrev: () => {
    const order = focusNavOrder(get().widgets)
    if (order.length < 2) return
    const cur = get().focusedWidgetId
    const i = order.findIndex((w) => w.id === cur)
    const prev = order[(i - 1 + order.length) % order.length]
    set({ focusedWidgetId: prev.id, activeWidgetId: prev.id })
  },
  setActive: (id) => set({ activeWidgetId: id }),
  setHoveredSection: (id) => set({ hoveredSectionId: id }),
  selectedIds: [],
  groupDrag: null,
  groupStart: null,
  setSelection: (ids) => set({ selectedIds: ids }),
  toggleSelection: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id]
    })),
  clearSelection: () => set((s) => (s.selectedIds.length ? { selectedIds: [] } : {})),
  beginGroupDrag: (leaderId) => {
    const sel = new Set(get().selectedIds)
    const start: Record<string, { x: number; y: number }> = {}
    for (const w of get().widgets) {
      if (sel.has(w.id)) start[w.id] = { x: w.x, y: w.y }
    }
    set({ groupDrag: { leaderId, dx: 0, dy: 0 }, groupStart: start })
  },
  setGroupDelta: (dx, dy) =>
    set((s) => (s.groupDrag ? { groupDrag: { ...s.groupDrag, dx, dy } } : {})),
  endGroupDrag: async () => {
    const { groupDrag, groupStart } = get()
    set({ groupDrag: null, groupStart: null })
    if (!groupDrag || !groupStart) return
    const { dx, dy } = groupDrag
    if (dx === 0 && dy === 0) return
    const starts = { ...groupStart }
    const ends: Record<string, { x: number; y: number }> = {}
    for (const [id, sp] of Object.entries(starts)) ends[id] = { x: Math.round(sp.x + dx), y: Math.round(sp.y + dy) }
    // Commit the move without per-widget undo entries, then record one combined
    // entry so a single Cmd-Z reverses the whole group move.
    const applyPositions = async (positions: Record<string, { x: number; y: number }>): Promise<void> => {
      suppressWidgetUndo = true
      try {
        await Promise.all(Object.entries(positions).map(([id, p]) => get().update(id, p)))
      } finally {
        suppressWidgetUndo = false
      }
    }
    await applyPositions(ends)
    recordAction({
      label: `Move ${Object.keys(ends).length} widgets`,
      undo: () => applyPositions(starts),
      redo: () => applyPositions(ends)
    })
  },
  // focusOn = make this widget active AND pan the canvas to center it. Used
  // by BringMeBack + explicit "open in focus mode" actions where the widget
  // might be off-screen and we want to surface it. NOT used by widget clicks
  // anymore — clicking a widget you can already see shouldn't shift the
  // world under you.
  focusOn: (id) =>
    set({ activeWidgetId: id, centerToken: get().centerToken + 1 }),
  // zoomToWidget = jump to 100% zoom AND center this widget. Used by Cmd+click
  // on a widget while zoomed out — dive straight into it. The centerToken bump
  // drives the Canvas centering effect, which reads the (now 100%) zoom.
  zoomToWidget: (id) =>
    set({ zoom: 1, activeWidgetId: id, centerToken: get().centerToken + 1 }),
  requestCenter: () => set({ centerToken: get().centerToken + 1 }),
  bumpLayoutVersion: () => set({ layoutVersion: get().layoutVersion + 1 }),
  setZoom: (z) => set({ zoom: clampZoom(z) }),
  setPan: (x, y) => set({ panX: x, panY: y }),
  panBy: (dx, dy) => set({ panX: get().panX + dx, panY: get().panY + dy }),
  zoomTowardPoint: (newZoom, screenX, screenY) => {
    const z = clampZoom(newZoom)
    const { zoom: curZoom, panX, panY } = get()
    if (z === curZoom) return
    const canvasX = (screenX - panX) / curZoom
    const canvasY = (screenY - panY) / curZoom
    set({
      zoom: z,
      panX: screenX - canvasX * z,
      panY: screenY - canvasY * z
    })
  },
  // The origin is the VISIBLE origin: the dock's right edge while full-bleed.
  resetView: () => set({ zoom: 1, panX: get().dockInset, panY: 0 }),
  createOptional: async (draft) => {
    const widget = await window.api.widgets.createOptional(draft)
    if (!widget) return null // task vanished before the create landed; clean no-op
    set({ widgets: [...get().widgets, widget] })
    recordSnapshotSoon(widget.taskId)
    nudgeSync()
    return widget
  },
  create: async (draft) => {
    const widget = await window.api.widgets.create(draft)
    set({ widgets: [...get().widgets, widget] })
    nudgeSync()
    // Undo a freshly-added widget by trashing it; redo restores it (same id, so
    // its links survive). We re-add the captured object locally to avoid a fetch.
    recordAction({
      label: `Add ${widget.kind}`,
      undo: async () => {
        await window.api.widgets.delete(widget.id)
        set({ widgets: get().widgets.filter((w) => w.id !== widget.id) })
      },
      redo: async () => {
        await window.api.widgets.restore(widget.id)
        if (!get().widgets.some((w) => w.id === widget.id)) set({ widgets: [...get().widgets, widget] })
      }
    })
    recordSnapshotSoon(widget.taskId)
    recordTrail('widget_added', widget.taskId, {
      widgetId: widget.id,
      kind: widget.kind,
      title: widget.title,
      content: widget.content?.slice(0, 200) ?? ''
    })
    // Different chime for sections (the "container" event) vs other widgets
    if (widget.kind === 'section') sectionCreate()
    else widgetOpen()
    // WS01 sync substrate (flagged): emit the create so the widget materialises on
    // other devices with the same id. No-op until the engine registers (flag on).
    crdtEmitWidgetCreate(widget)
    return widget
  },
  update: async (id, patch) => {
    // Capture the prior values of any structural keys this patch touches, BEFORE
    // the optimistic set, so we can record an undo for move/resize/recolour/
    // section-membership. Suppressed during group-drag commit (one combined entry).
    const undoCapture = (() => {
      if (suppressWidgetUndo) return null
      const touched = UNDOABLE_WIDGET_KEYS.filter((k) => k in patch)
      if (!touched.length) return null
      const w = get().widgets.find((x) => x.id === id)
      if (!w) return null
      const prevPatch: WidgetPatch = {}
      const redoPatch: WidgetPatch = {}
      for (const k of touched) {
        ;(prevPatch as Record<string, unknown>)[k] = (w as unknown as Record<string, unknown>)[k]
        ;(redoPatch as Record<string, unknown>)[k] = (patch as unknown as Record<string, unknown>)[k]
      }
      const label = touched.includes('status')
        ? 'Change status'
        : touched.includes('color')
          ? 'Recolour widget'
          : touched.includes('width') || touched.includes('height')
            ? 'Resize widget'
            : 'Move widget'
      return { prevPatch, redoPatch, label }
    })()
    // Prior section, captured before the optimistic set, so a membership change can
    // be emitted to the CRDT change log with its from/to (WS01, flagged).
    const beforeSection = get().widgets.find((w) => w.id === id)?.parentSectionId ?? null
    // Optimistic local update — applies the patch immediately so consumers (Canvas,
    // focus mode, dashboard cards) re-render right away. Critical for the URL persistence
    // case where the user clicks "expand" within IPC roundtrip latency of the last nav.
    set({
      widgets: get().widgets.map((w) =>
        w.id === id ? { ...w, ...patch, updatedAt: Date.now() } : w
      )
    })
    // PLX-APP-010 Phase 2 (ADR-0006): when this Desk is opted into per-device
    // layout, route position/size changes for eligible top-level Objects to the
    // personal overlay (persisted by the Canvas overlay-save effect) instead of
    // the shared base, so they stay private and never sync. A patch that changes
    // section membership, or an ineligible/section/pinned Object, always writes to
    // the base as before. When customLayout is off (the default for every Desk)
    // routeGeom is false and the path below is byte-identical to the shipping code.
    const target = get().widgets.find((w) => w.id === id)
    const routeGeom =
      get().customLayout &&
      !!target &&
      isOverlayEligible(target) &&
      !('parentSectionId' in patch) &&
      patchTouchesOverlayGeometry(patch as Record<string, unknown>)
    const { geometry: overlayGeom, rest } = routeGeom
      ? splitOverlayPatch(patch as Record<string, unknown>)
      : { geometry: {}, rest: patch }
    const dbPatch = (routeGeom ? rest : patch) as WidgetPatch

    let updated: Widget | null = null
    if (Object.keys(dbPatch as Record<string, unknown>).length > 0) {
      updated = await window.api.widgets.update(id, dbPatch)
      if (!updated) return
      nudgeSync()
      const server = updated
      // Reconcile with the server copy, then re-assert any overlay-destined
      // geometry so the server's (unchanged) base geometry never clobbers the
      // optimistic move that was deliberately not written to the base.
      set({
        widgets: get().widgets.map((w) =>
          w.id === id ? (routeGeom ? { ...server, ...overlayGeom } : server) : w
        )
      })
      // WS01 sync substrate (flagged, off by default): mirror the base geometry and
      // any section-membership change into the one CRDT change log. Overlay-routed
      // geometry (routeGeom) is deliberately per-device and private, so it is never
      // emitted. Both calls are no-ops until the engine registers (flag on).
      if (!routeGeom && ['x', 'y', 'width', 'height'].some((k) => k in patch)) {
        crdtEmitGeom(server)
      }
      if ('parentSectionId' in patch) {
        crdtEmitMembership(id, beforeSection, (patch.parentSectionId as string | null) ?? null)
      }
      // The widget's own content fields as LWW registers (content/title/colour/
      // status), so a concurrent edit to a sticky's text or a card's title
      // converges instead of the poll's whole-row last-write-wins.
      if (
        patch.content !== undefined ||
        patch.title !== undefined ||
        patch.color !== undefined ||
        patch.status !== undefined ||
        patch.zIndex !== undefined
      ) {
        crdtEmitWidgetFields(id, {
          content: patch.content,
          title: patch.title,
          color: patch.color,
          status: patch.status as string | null | undefined,
          zIndex: patch.zIndex
        })
      }
      // Linked-duplicate live sync: mirror the synced fields (content / title /
      // colour) to any OTHER in-store copies that share this widget's syncGroupId,
      // so same-task copies update instantly. Cross-task copies are mirrored by the
      // main process (db/widgets.ts) and show when their task is opened.
      const sgid = server.syncGroupId
      if (
        sgid &&
        (patch.content !== undefined || patch.title !== undefined || patch.color !== undefined)
      ) {
        const mirror: Partial<Widget> = {}
        if (patch.content !== undefined) mirror.content = patch.content
        if (patch.title !== undefined) mirror.title = patch.title
        if (patch.color !== undefined) mirror.color = patch.color
        set({
          widgets: get().widgets.map((w) =>
            w.syncGroupId === sgid && w.id !== id ? { ...w, ...mirror } : w
          )
        })
      }
      // Live wires: a content change may drive reactive (transform / mirror)
      // wires leaving this widget, and may trigger any onChange desk agents this
      // widget is wired into. Both engines debounce + guard against loops.
      if (patch.content !== undefined) {
        void notifyWireSource(id)
        notifyAgentInputChanged(id)
      }
    }
    // else: a pure overlay-geometry update — nothing to persist to the base; the
    // optimistic set already applied it and the Canvas overlay-save effect writes
    // it to desk_layouts.
    if (undoCapture) {
      const { prevPatch, redoPatch, label } = undoCapture
      // For an overlay-routed move, reverse THROUGH update() so the reversal also
      // lands in the overlay; otherwise keep the original direct-to-base reversal.
      const reverse = (p: WidgetPatch): (() => Promise<void>) =>
        routeGeom
          ? async () => {
              suppressWidgetUndo = true
              try {
                await get().update(id, p)
              } finally {
                suppressWidgetUndo = false
              }
            }
          : async () => {
              await window.api.widgets.update(id, p)
              set({ widgets: get().widgets.map((w) => (w.id === id ? { ...w, ...p } : w)) })
            }
      recordAction({ label, undo: reverse(prevPatch), redo: reverse(redoPatch) })
    }
    const snapshotTaskId = updated?.taskId ?? target?.taskId
    if (snapshotTaskId) recordSnapshotSoon(snapshotTaskId)
  },
  setDeskCustomLayout: async (enabled) => {
    // Toggle per-device layout customisation for the active (hydrated) Desk
    // (PLX-APP-010 Phase 2, ADR-0006). Enabling snapshots the current arrangement
    // into the personal overlay so nothing moves, and flips routing on. Disabling
    // clears the overlay and reloads the shared base so the Desk reverts to the
    // collaborative arrangement, keeping the camera.
    const taskId = get().layoutHydratedFor
    if (!taskId) return
    const s = get()
    const layout: DeskLayout = {
      userId: useAccountStore.getState().account?.id ?? 'local',
      deskId: taskId,
      deviceClass: currentDeviceClass(),
      customLayout: enabled,
      objects: enabled ? serializeOverlayObjects(s.widgets) : [],
      scroll: { x: s.panX - s.dockInset, y: s.panY },
      selectedObjectIds: s.selectedIds,
      zoom: s.zoom
    }
    set({ customLayout: enabled })
    try {
      await window.api.deskLayout.save(layout)
    } catch {
      // A save failure must not leave the UI wedged; the flag reverts on next open.
    }
    if (!enabled) await get().loadForTask(taskId, { refresh: true })
  },
  remove: async (id) => {
    const widget = get().widgets.find((w) => w.id === id)
    const removedTaskId = widget?.taskId
    await window.api.widgets.delete(id) // soft-delete (trashed, recoverable)
    // WS01 sync substrate (flagged): emit a delete tombstone so the removal
    // converges on other devices (remove-wins). Emit BEFORE pruning the store so the
    // engine can still resolve the widget's task-shared-root (a shared-desk widget's
    // tombstone must route to the desk partition, not the account).
    crdtEmitWidgetDelete(id)
    set({ widgets: get().widgets.filter((w) => w.id !== id) })
    nudgeSync()
    // Don't prune links: they survive the soft-delete so they return on restore.
    // The overlay skips links whose endpoint widget isn't present, so a trashed
    // widget's lines simply hide until it's restored.
    if (widget) {
      recordActionWithToast({
        label: `Delete ${widget.kind}${widget.title ? ` “${widget.title}”` : ''}`,
        undo: async () => {
          await window.api.widgets.restore(id)
          if (!get().widgets.some((w) => w.id === id)) set({ widgets: [...get().widgets, widget] })
        },
        redo: async () => {
          await window.api.widgets.delete(id)
          set({ widgets: get().widgets.filter((w) => w.id !== id) })
        }
      })
    }
    recordSnapshotSoon(removedTaskId)
  },
  archive: async (id) => {
    await window.api.widgets.update(id, { archived: true })
    set({
      widgets: get().widgets.map((w) => (w.id === id ? { ...w, archived: true } : w))
    })
  },
  restore: async (id) => {
    await window.api.widgets.update(id, { archived: false })
    set({
      widgets: get().widgets.map((w) => (w.id === id ? { ...w, archived: false } : w))
    })
  },
  parkAll: async (keepActive) => {
    const activeId = get().activeWidgetId
    const eligible = get().widgets.filter(
      (w) =>
        !w.archived &&
        !w.pinned &&
        w.kind !== 'section' &&
        w.parentSectionId === null &&
        (!keepActive || w.id !== activeId)
    )
    if (eligible.length === 0) return 0
    await Promise.all(
      eligible.map((w) => window.api.widgets.update(w.id, { archived: true }))
    )
    const ids = new Set(eligible.map((w) => w.id))
    set({
      widgets: get().widgets.map((w) => (ids.has(w.id) ? { ...w, archived: true } : w))
    })
    return eligible.length
  },
  bringToFront: async (id) => {
    const updated = await window.api.widgets.bringToFront(id)
    if (!updated) return
    set({ widgets: get().widgets.map((w) => (w.id === id ? updated : w)) })
    // WS01 sync substrate (flagged): stacking order as an LWW register. No-op off.
    crdtEmitWidgetFields(id, { zIndex: updated.zIndex })
  },
  pinToZone: async (id, zone) => {
    // Zone pins don't need pinnedScreenX/Y — the pinned-layer computes
    // position from zone + neighbours. We do keep the widget's stored
    // width/height so the dock layout knows its size. Width/height are
    // expressed in screen pixels at scale=1 for zone-pinned widgets.
    const updated = await window.api.widgets.update(id, {
      pinned: true,
      pinnedZone: zone,
      pinnedScreenX: null,
      pinnedScreenY: null
    })
    if (updated) {
      set({
        widgets: get().widgets.map((x) => (x.id === id ? updated : x)),
        layoutVersion: get().layoutVersion + 1
      })
    }
  },
  unpinWidget: async (id) => {
    const w = get().widgets.find((x) => x.id === id)
    if (!w) return
    const { zoom, panX, panY } = get()
    // Legacy free-position pins still translate their screen pos back to
    // canvas-space. Zone pins just clear the pin flags — the widget
    // returns to wherever it was on the canvas before pinning.
    const patch: WidgetPatch = {
      pinned: false,
      pinnedZone: null,
      pinnedScreenX: null,
      pinnedScreenY: null
    }
    if (w.pinnedZone === null && w.pinnedScreenX !== null) {
      const canvasX = (w.pinnedScreenX - panX) / zoom
      const canvasY = ((w.pinnedScreenY ?? 0) - panY) / zoom
      patch.x = Math.round(canvasX)
      patch.y = Math.round(canvasY)
      patch.width = Math.round(w.width / zoom)
      patch.height = Math.round(w.height / zoom)
    }
    const updated = await window.api.widgets.update(id, patch)
    if (updated) {
      set({
        widgets: get().widgets.map((x) => (x.id === id ? updated : x)),
        layoutVersion: get().layoutVersion + 1
      })
    }
  },
  togglePin: async (id) => {
    const state = get()
    const w = state.widgets.find((x) => x.id === id)
    if (!w) return
    const { zoom, panX, panY } = state
    if (w.pinned) {
      // Unpin: convert screen-space pos+size back to canvas-space, so widget stays visually where it is.
      const sx = w.pinnedScreenX ?? 0
      const sy = w.pinnedScreenY ?? 0
      const canvasX = (sx - panX) / zoom
      const canvasY = (sy - panY) / zoom
      const canvasW = w.width / zoom
      const canvasH = w.height / zoom
      const updated = await window.api.widgets.update(id, {
        pinned: false,
        pinnedScreenX: null,
        pinnedScreenY: null,
        x: Math.round(canvasX),
        y: Math.round(canvasY),
        width: Math.round(canvasW),
        height: Math.round(canvasH)
      })
      if (updated) {
        set({
          widgets: get().widgets.map((x) => (x.id === id ? updated : x)),
          layoutVersion: get().layoutVersion + 1
        })
      }
    } else {
      // Pin: compute current on-screen position+size and store, so widget remains visually unchanged.
      const screenX = w.x * zoom + panX
      const screenY = w.y * zoom + panY
      const screenW = w.width * zoom
      const screenH = w.height * zoom
      const updated = await window.api.widgets.update(id, {
        pinned: true,
        pinnedScreenX: Math.round(screenX),
        pinnedScreenY: Math.round(screenY),
        width: Math.round(screenW),
        height: Math.round(screenH)
      })
      if (updated) {
        set({
          widgets: get().widgets.map((x) => (x.id === id ? updated : x)),
          layoutVersion: get().layoutVersion + 1
        })
      }
    }
  }
}))

// Expose the widget store on window so debugging sessions and e2e specs can drive
// it directly (mirrors __fbView in stores/view.ts). A thin handle to the real
// store, not a mock; it changes nothing about how the app behaves for users.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbWidgets?: typeof useWidgetStore }).__fbWidgets = useWidgetStore
}
