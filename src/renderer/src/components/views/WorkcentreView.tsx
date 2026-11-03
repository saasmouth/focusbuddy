import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import type { WorkcentreLayout } from '@shared/deskLayout'
import { renderWidgetInline } from '../../lib/renderWidgetInline'
import { widgetDisplayName } from '../../lib/widgetDisplayName'
import { minSizeFor } from '../../lib/widgetSizing'
import {
  GAP_PX,
  ROW_PX,
  colWidthPx,
  colsForWidth,
  fillWithCornerKeepOut,
  fitAgain,
  fromTiles,
  gridRows,
  moveTile,
  placeAt,
  resizeFromShown,
  rowsForHeight,
  syncLayout,
  tileRectPx,
  toTiles,
  unitsFromPx,
  type Mins,
  type Tile
} from '../../lib/workcentreLayout'
import { armArrivals, claimArrivals, dropCellFor, dropSizeFor, type Arrivals } from '../../lib/workcentreDrop'
import { currentDeviceClass } from '../../lib/deviceClass'
import { useWidgetStore } from '../../stores/widgets'
import { useAccountStore } from '../../stores/account'
import { useDeskViewStore } from '../../stores/deskView'
import ViewSelector from './ViewSelector'
import { attachDragGlide } from '../../lib/dragGlide'
import Icon from '../Icon'
import { FILES_DRAG_MIME, readFilesDrag } from '../../lib/filesDrag'
import { placeFilesOnDesk } from '../../lib/filesDrop'
import { spawnPositionFor } from '../../lib/spawnPosition'
import { useNoticeStore } from '../../stores/notice'

// The Workcentre desk view (owner, 4.3.41): the Desk as a dashboard. Every work
// widget, file and tool is a tile on a snapping grid that never overlaps, can be
// moved and resized freely, and shows its FULL content — an office document shows
// its live editor (the same renderWidgetInline path as full view), not a
// thumbnail. Tile geometry is the view's own (lib/workcentreLayout): sizing a tile
// never moves or resizes the object on the canvas, and the reverse. It is stored
// per (user, Desk, device class) in desk_layouts: device-local, like the canvas's
// own custom layout. Sections stay a canvas concept; the work inside them tiles.
//
// Fill and snap (owner, 2026-11-03: "widgets auto grow to fill dead space … in
// any direction … snaps in place, more like the multi-app focus view … show
// where things will move if the mouse button is released"):
//   • What is shown is the stored layout FILLED (fillLayout): every tile grows
//     into the space around it, down to the bottom of the view. Display-only —
//     an edge dragged by hand fixes that axis (fixW / fixH) so its room goes to
//     the neighbours; double-click the corner, or "Fit", to hand it back.
//   • A dragged tile follows the pointer; a drop well shows the slot it will
//     take, and the neighbours slide aside to make room (left/top transitions,
//     never transforms: a transform would trap position:fixed menus inside an
//     editor). Animation runs only while something is moving, so a window
//     resize stays crisp.
//   • Anything the desk accepts can be dragged in (lib/workcentreDrop): the same
//     well previews where it lands, and it lands there.
//
// Gestures are pointer-based (as in Columns): HTML5 drag-and-drop is unreliable
// over live bodies in Electron. A tile body is pointer-transparent during a
// gesture, and during a drag-in preview, so an editor never swallows it.
// Tiles render in a STABLE order (the desk's), never the layout's: moving a DOM
// node reloads any web page or iframe inside it.

/** Objects that tile: everything a person works with, not the canvas's own furniture. */
export function workcentreEligible(widgets: Widget[]): Widget[] {
  return widgets.filter((w) => !w.archived && w.kind !== 'section' && w.kind !== 'minimap')
}

/** The placeholder tile a drag-in preview occupies. */
const PHANTOM = '__workcentre-drop__'
/** Movement (px) before a press on a title becomes a move; below it, a click. */
const DRAG_THRESHOLD_PX = 4
/** How long tiles keep easing into place after a gesture, a key move or a drop. */
const SETTLE_MS = 320
/** Hold a dragged tile this close to the top or bottom of the view and it scrolls. */
const EDGE_SCROLL_PX = 48

type Gesture = {
  id: string
  kind: 'move' | 'resize'
  edge: 'r' | 'b' | 'rb'
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** Stored tiles, and the tiles as shown, when the gesture began. */
  base: Tile[]
  shown: Tile[]
  /** The tile as shown when the gesture began. */
  tile: Tile
  /** Where the pointer held the tile, from its top-left (moves). */
  offX: number
  offY: number
  started: boolean
}
type Float = { id: string; left: number; top: number; width: number; height: number }
type Live = { base: Tile[]; float: Float | null }

export default function WorkcentreView({ taskId, widgets }: { taskId: string; widgets: Widget[] }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ w: 0, h: 0 })
  const [stored, setStored] = useState<WorkcentreLayout | null | undefined>(undefined) // undefined = loading
  const [live, setLive] = useState<Live | null>(null) // a move or resize in progress
  const liveRef = useRef<Live | null>(null)
  liveRef.current = live
  const [held, setHeld] = useState<{ cell: { x: number; y: number }; size: { w: number; h: number } } | null>(null) // a drag-in held over the view
  const [settling, setSettling] = useState(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const arrivals = useRef<Arrivals | null>(null)
  const setActive = useWidgetStore((s) => s.setActive)
  const setFocused = useWidgetStore((s) => s.setFocused)
  const setViewMode = useDeskViewStore((s) => s.set)
  const userId = useAccountStore((s) => s.account?.id ?? 'local')
  const pendingTileAt = useDeskViewStore((s) => s.pendingTileAt)
  const gridRef = useRef<HTMLDivElement>(null)

  // The view measures itself: the column count follows its width (a desk widget,
  // a menu at 480px), and fill reaches down to the bottom of what is visible.
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]!.contentRect
      setView((p) => (p.w === r.width && p.h === r.height ? p : { w: r.width, h: r.height }))
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setView({ w: r.width, h: r.height })
    return () => ro.disconnect()
  }, [])

  // The Plexii pill floats in the window's bottom-right corner. Filled tiles reach
  // that corner, so without room kept for it the last tile's resize handle sits
  // under the pill and cannot be grabbed (WC-6). The pill publishes
  // --fb-corner-stack-bottom on <html> exactly while it shows (pillGeometry.ts),
  // as the office shell reads it: the tile fill puts in the corner stops that
  // much short, leaving a strip under it for the pill (fillWithCornerKeepOut);
  // every other tile still reaches the bottom. Zero when the pill is hidden.
  const [cornerPx, setCornerPx] = useState(0)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const read = (): void => {
      const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-corner-stack-bottom')) || 0
      setCornerPx((p) => (p === v ? p : v))
    }
    read()
    const mo = new MutationObserver(read)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => mo.disconnect()
  }, [])

  // Load this Desk's dashboard (device-local, per device class).
  useEffect(() => {
    let alive = true
    setStored(undefined)
    void window.api.deskLayout
      .load(userId, taskId, currentDeviceClass())
      .then((l) => alive && setStored(l?.workcentre ?? null))
      .catch(() => alive && setStored(null))
    return () => {
      alive = false
    }
  }, [taskId, userId])

  const width = view.w
  const hidden = useMemo(() => stored?.hidden ?? [], [stored])
  const items = useMemo(() => workcentreEligible(widgets).filter((w) => !hidden.includes(w.id)), [widgets, hidden])
  const pad = 16
  const innerW = Math.max(0, width - pad * 2)
  const cols = colsForWidth(innerW)
  const colPx = colWidthPx(innerW, cols)
  const viewRows = rowsForHeight(view.h - pad * 2)
  const mins: Mins = useMemo(() => Object.fromEntries(items.map((w) => [w.id, unitsFromPx(minSizeFor(w.kind), colPx)])), [items, colPx])

  // The layout reconciled with the objects now on the Desk (new ones tiled, gone ones dropped).
  const layout: WorkcentreLayout | null = useMemo(() => {
    if (stored === undefined || !width) return null
    const objects = items.map((w) => ({ id: w.id, preferred: unitsFromPx({ w: w.width, h: w.height }, colPx) }))
    const synced = syncLayout(stored, objects, cols, mins, pendingTileAt)
    // Carried through, so the reconciled layout and the stored one compare
    // equal and a hidden list never sets off a save loop.
    return stored?.hidden ? { ...synced, hidden: stored.hidden } : synced
  }, [stored, items, cols, colPx, mins, width, pendingTileAt])

  const hiddenRef = useRef<string[] | undefined>(undefined)
  hiddenRef.current = stored?.hidden
  const persist = useCallback(
    (raw: WorkcentreLayout) => {
      // fromTiles knows nothing of the hidden list; keep it on every save.
      const l = raw.hidden === undefined && hiddenRef.current ? { ...raw, hidden: hiddenRef.current } : raw
      setStored(l)
      void window.api.deskLayout.saveWorkcentre(userId, taskId, currentDeviceClass(), l).catch(() => undefined)
    },
    [taskId, userId]
  )

  // Keep the stored layout in step when the reconciled one differs (first open, objects added or removed).
  useEffect(() => {
    if (!layout || stored === undefined) return
    if (JSON.stringify(layout) !== JSON.stringify(stored)) persist(layout)
    // A dropped tile's request is done once the STORED layout holds it in its
    // column (clamped to fit). Clearing any earlier loses it: the view can
    // re-mount between the drop and the save and re-load the older layout.
    const done = Object.keys(pendingTileAt).filter((id) => {
      const t = stored?.items[id]
      return !!t && t.x === Math.max(0, Math.min(pendingTileAt[id]!.x, cols - t.w))
    })
    if (done.length) useDeskViewStore.getState().clearPendingTiles(done)
  }, [layout, stored, persist, pendingTileAt, cols])

  // Ease tiles into their new places for a moment (after a gesture, a key move, a drop).
  const pulse = useCallback(() => {
    setSettling(true)
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => setSettling(false), SETTLE_MS)
  }, [])
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
    },
    []
  )

  const unitX = colPx + GAP_PX
  const unitY = ROW_PX + GAP_PX
  const storedTiles = useMemo(() => (layout ? toTiles(layout) : []), [layout])
  const baseTiles = live?.base ?? storedTiles
  // A drag-in held over the view claims its cell, exactly as the drop will.
  const previewBase = useMemo(
    () => (held ? placeAt(baseTiles, { id: PHANTOM, x: 0, y: 0, w: held.size.w, h: held.size.h }, held.cell, cols) : baseTiles),
    [held, baseTiles, cols]
  )
  // The pill's height above the view's bottom edge, in grid rows past the padding.
  const keepRows = cornerPx > pad ? Math.ceil((cornerPx - pad) / (ROW_PX + GAP_PX)) : 0
  const filled = useMemo(() => fillWithCornerKeepOut(previewBase, cols, viewRows, keepRows), [previewBase, cols, viewRows, keepRows])
  const shown = filled.shown
  const keepOut = filled.keep
  const shownById = useMemo(() => new Map(shown.map((t) => [t.id, t])), [shown])
  const baseById = useMemo(() => new Map(previewBase.map((t) => [t.id, t])), [previewBase])
  const animate = !!live || !!held || settling
  // The slot a moved tile or a dropped thing will take when the button is released.
  const wellTile = held ? shownById.get(PHANTOM) : live?.float ? shownById.get(live.float.id) : undefined

  function begin(e: React.PointerEvent, id: string, kind: Gesture['kind'], edge: Gesture['edge'] = 'rb'): void {
    if (e.button !== 0 || !layout) return
    e.preventDefault()
    e.stopPropagation()
    const base = toTiles(layout)
    const shownNow = fillWithCornerKeepOut(base, cols, viewRows, keepRows).shown
    const tile = shownNow.find((t) => t.id === id)
    if (!tile) return
    const grid = gridRef.current?.getBoundingClientRect()
    const r = tileRectPx(tile, colPx)
    gesture.current = {
      id,
      kind,
      edge,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      base,
      shown: shownNow,
      tile,
      offX: e.clientX - ((grid?.left ?? 0) + r.left),
      offY: e.clientY - ((grid?.top ?? 0) + r.top),
      started: kind === 'resize'
    }
    if (kind === 'resize') setLive({ base, float: null })
    // Bound once per gesture: the grid's pitch and minimums as they were when it began.
    const update = (): void => {
      const g = gesture.current
      const gr = gridRef.current?.getBoundingClientRect()
      if (!g || !gr) return
      if (g.kind === 'move') {
        const left = g.lastX - gr.left - g.offX
        const top = g.lastY - gr.top - g.offY
        const x = Math.max(0, Math.min(cols - 1, Math.round(left / unitX)))
        const y = Math.max(0, Math.round(top / unitY))
        const box = tileRectPx(g.tile, colPx)
        setLive({ base: moveTile(g.base, g.id, { x, y }, cols, mins), float: { id: g.id, left, top, width: box.width, height: box.height } })
      } else {
        const dx = Math.round((g.lastX - g.startX) / unitX)
        const dy = Math.round((g.lastY - g.startY) / unitY)
        const size = { w: g.tile.w + (g.edge === 'b' ? 0 : dx), h: g.tile.h + (g.edge === 'r' ? 0 : dy) }
        setLive({ base: resizeFromShown(g.base, g.shown, g.id, size, g.edge, cols, mins), float: null })
      }
    }
    let raf = 0
    // Hold a dragged tile near the top or bottom edge and the view scrolls under it.
    const tick = (): void => {
      const g = gesture.current
      const host = hostRef.current
      if (!g) return
      if (host && g.started && g.kind === 'move') {
        const hr = host.getBoundingClientRect()
        const v = g.lastY < hr.top + EDGE_SCROLL_PX ? -(hr.top + EDGE_SCROLL_PX - g.lastY) / 3 : g.lastY > hr.bottom - EDGE_SCROLL_PX ? (g.lastY - (hr.bottom - EDGE_SCROLL_PX)) / 3 : 0
        if (v) {
          const before = host.scrollTop
          host.scrollTop += v
          if (host.scrollTop !== before) update()
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const onMove = (ev: PointerEvent): void => {
      const g = gesture.current
      if (!g) return
      g.lastX = ev.clientX
      g.lastY = ev.clientY
      if (!g.started) {
        if (Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY) < DRAG_THRESHOLD_PX) return
        g.started = true
      }
      update()
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      cancelAnimationFrame(raf)
      const g = gesture.current
      gesture.current = null
      const p = liveRef.current
      if (g?.started && p) persist(fromTiles(cols, p.base))
      setLive(null)
      pulse() // the floating tile glides into its well
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Keyboard, on a focused tile: Alt+arrows move it one cell, Shift+Alt+arrows
  // resize it from its shown size (which fixes that axis, as a drag does).
  function onTileKey(e: React.KeyboardEvent, id: string): void {
    if (!e.altKey || !layout) return
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] as [number, number] | undefined
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    const base = toTiles(layout)
    const shownNow = fillWithCornerKeepOut(base, cols, viewRows, keepRows).shown
    const s = shownNow.find((x) => x.id === id)
    const b = base.find((x) => x.id === id)
    if (!s || !b) return
    const next = e.shiftKey
      ? resizeFromShown(base, shownNow, id, { w: s.w + d[0], h: s.h + d[1] }, d[0] !== 0 ? 'r' : 'b', cols, mins)
      : moveTile(base, id, { x: b.x + d[0], y: b.y + d[1] }, cols, mins)
    persist(fromTiles(cols, next))
    pulse()
  }

  function fitTile(id: string): void {
    if (!layout) return
    persist(fromTiles(cols, fitAgain(toTiles(layout), id)))
    pulse()
  }

  const rows = Math.max(gridRows(shown), keepOut ? keepOut.y + keepOut.h : 0, viewRows, 1)

  /** The grid cell under the pointer (clamped to the grid). */
  function cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const g = gridRef.current
    if (!g) return { x: 0, y: 0 }
    const r = g.getBoundingClientRect()
    const x = Math.max(0, Math.min(cols - 1, Math.floor((clientX - r.left) / unitX)))
    const y = Math.max(0, Math.floor((clientY - r.top) / unitY))
    return { x, y }
  }

  // ── Dragging things in ─────────────────────────────────────────────────────
  // Anything the desk accepts. While it is held over the grid, a well shows the
  // tile it will become and the neighbours make room. A drop on a tile's live
  // body (entered directly, before any preview) belongs to that body: an editor
  // takes it and calls preventDefault. Otherwise the drop makes a tile in the
  // well: Files-panel drops are placed here directly; everything else is made
  // by the canvas's own drop handler underneath, and claimed for this cell.
  function heldSize(types: readonly string[]): { w: number; h: number } | null {
    const px = dropSizeFor(types)
    if (!px) return null
    const u = unitsFromPx(px, colPx)
    return { w: Math.min(cols, u.w), h: u.h }
  }
  function onDragOver(e: React.DragEvent): void {
    if (e.defaultPrevented) {
      if (held) setHeld(null) // an editor is taking it
      return
    }
    const size = heldSize(Array.from(e.dataTransfer.types))
    if (!size) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const cell = dropCellFor(cellAt(e.clientX, e.clientY), size, cols)
    setHeld((p) => (p && p.cell.x === cell.x && p.cell.y === cell.y && p.size.w === size.w && p.size.h === size.h ? p : { cell, size }))
  }
  // A drag cancelled with Esc, or released outside the window, ends the preview too.
  useEffect(() => {
    if (!held) return
    const end = (): void => setHeld(null)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [held])
  async function onDrop(e: React.DragEvent): Promise<void> {
    const was = held
    setHeld(null)
    if (e.defaultPrevented) return
    const types = Array.from(e.dataTransfer.types)
    const size = heldSize(types) ?? { w: 4, h: 6 }
    const cell = was?.cell ?? dropCellFor(cellAt(e.clientX, e.clientY), size, cols)
    pulse()
    if (!types.includes(FILES_DRAG_MIME)) {
      // The canvas underneath makes the object(s); every one this drop creates lands here.
      arrivals.current = armArrivals(
        cell,
        widgets.map((w) => w.id),
        Date.now()
      )
      return
    }
    // From Files: the same references a desk drop makes, each with a tile AT the
    // drop cell. Stops here, so the canvas underneath never places a second copy.
    e.stopPropagation()
    const read = readFilesDrag(e.dataTransfer)
    if (!read.ok) {
      if (read.reason) {
        e.preventDefault()
        useNoticeStore.getState().show({ text: read.reason, icon: 'info' })
      }
      return
    }
    e.preventDefault()
    // The objects also need a place on the free canvas; where the desk would put a new one.
    const pos = spawnPositionFor(360, 280)
    const res = await placeFilesOnDesk(read.payload.refs, { taskId, target: 'workcentre', at: { x: pos.x + 180, y: pos.y + 20 } })
    for (const w of res.created) useDeskViewStore.getState().setPendingTile(w.id, cell)
  }
  // Objects a drop made (through the canvas) arrive in `widgets`: claim them for its cell.
  useEffect(() => {
    const a = arrivals.current
    if (!a) return
    const { claimed, next } = claimArrivals(
      a,
      widgets.map((w) => w.id),
      Date.now()
    )
    arrivals.current = next
    const tiled = new Set(workcentreEligible(widgets).map((w) => w.id))
    for (const id of claimed) if (tiled.has(id)) useDeskViewStore.getState().setPendingTile(id, a.cell)
  }, [widgets])

  // Grab the empty grid and drag to scroll; let go and it glides on. Tiles,
  // their controls and anything editable keep their own press.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    return attachDragGlide(
      el,
      (t) => !t.closest('[data-testid^="workcentre-tile-"], button, a, input, textarea, select, [contenteditable="true"], [role="slider"]')
    )
  }, [])

  const box = (t: Tile): React.CSSProperties => {
    const r = tileRectPx(t, colPx)
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }

  return (
    <div
      className={`absolute inset-0 flex flex-col bg-[var(--surface-sunken)] ${live ? 'select-none' : ''}`}
      data-testid="workcentre-view"
      data-desk-view="workcentre"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(null)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--edge-soft)] bg-[var(--surface-raised)] min-w-0">
        <Icon name="space_dashboard" size={16} className="text-[var(--ink-50)]" />
        <span className="text-[13px] font-medium text-[var(--ink-90)]">Workcentre</span>
        <span className="flex-1 min-w-0 truncate text-[11px] text-[var(--ink-50)]" data-testid="workcentre-hint">
          Tiles grow to fill the space. Drag a title to move — the outline shows where it lands; drag in files, links or apps the same way. Drag an edge to set a size; double-click the corner to fit again. Saved on this device.
        </span>
        {hidden.length > 0 && layout && (
          <button
            type="button"
            className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 h-7 text-[12px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
            onClick={() => persist({ ...layout, hidden: [] })}
            title="Show every hidden work widget in the Workcentre again"
            data-testid="workcentre-show-hidden"
          >
            <Icon name="visibility" size={14} />
            {hidden.length} hidden · Show all
          </button>
        )}
        <ViewSelector taskId={taskId} />
      </div>
      <div ref={hostRef} className="flex-1 min-h-0 min-w-0 overflow-auto cursor-grab" data-testid="workcentre-scroll">
        {!layout ? (
          <div className="p-6 text-[12px] text-[var(--ink-50)]" role="status">
            Laying out the Workcentre…
          </div>
        ) : !items.length && !held ? (
          <div className="p-10 text-center text-[13px] text-[var(--ink-50)]" data-testid="workcentre-empty">
            Nothing on this desk yet. Add work widgets, files or tools — or drag them in — and they tile here.
          </div>
        ) : (
          <div
            ref={gridRef}
            className={`relative ${animate ? 'fb-wc-animate' : ''}`}
            data-testid="workcentre-grid"
            data-cols={cols}
            data-rows={rows}
            style={{ margin: pad, width: innerW, height: rows * unitY - GAP_PX }}
          >
            {keepOut && (
              <div
                aria-hidden="true"
                data-testid="workcentre-corner-keepout"
                data-x={keepOut.x}
                data-y={keepOut.y}
                data-w={keepOut.w}
                data-h={keepOut.h}
                className="absolute pointer-events-none"
                style={box(keepOut)}
              />
            )}
            {wellTile && (
              <div
                aria-hidden="true"
                data-testid="workcentre-drop-well"
                data-x={wellTile.x}
                data-y={wellTile.y}
                data-w={wellTile.w}
                data-h={wellTile.h}
                className="fb-wc-well absolute pointer-events-none rounded-lg border-2 border-dashed border-[rgb(var(--accent)/0.6)] bg-[rgb(var(--accent)/0.08)]"
                style={box(wellTile)}
              />
            )}
            {items.map((w) => {
              const t = shownById.get(w.id)
              if (!t) return null
              const base = baseById.get(w.id)
              const floating = live?.float?.id === w.id ? live.float : null
              const resizing = !!live && !live.float && gesture.current?.id === w.id
              const fixed = !!(base?.fixW || base?.fixH)
              const style: React.CSSProperties = floating ? { left: floating.left, top: floating.top, width: floating.width, height: floating.height } : box(t)
              return (
                <section
                  key={w.id}
                  tabIndex={0}
                  aria-label={widgetDisplayName(w)}
                  onKeyDown={(e) => onTileKey(e, w.id)}
                  data-testid={`workcentre-tile-${w.id}`}
                  data-x={t.x}
                  data-y={t.y}
                  data-w={t.w}
                  data-h={t.h}
                  data-base-w={base?.w}
                  data-base-h={base?.h}
                  data-fix={base?.fixW ? (base.fixH ? 'wh' : 'w') : base?.fixH ? 'h' : undefined}
                  data-floating={floating ? 'true' : undefined}
                  className={`fb-wc-tile absolute fb-card overflow-hidden flex flex-col min-w-0 min-h-0 outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent))] ${
                    floating ? 'z-30 shadow-2xl ring-2 ring-[rgb(var(--accent))] opacity-95' : resizing ? 'ring-2 ring-[rgb(var(--accent))] z-10' : ''
                  }`}
                  style={style}
                >
                  <header
                    onPointerDown={(e) => begin(e, w.id, 'move')}
                    className={`shrink-0 flex items-center gap-1.5 px-2.5 h-8 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)] min-w-0 ${floating ? 'cursor-grabbing' : 'cursor-grab'}`}
                    title="Drag to move"
                    data-testid={`workcentre-move-${w.id}`}
                  >
                    <Icon name="drag_indicator" size={14} className="shrink-0 text-[var(--ink-30)]" />
                    {w.color && <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: w.color }} />}
                    <span className="flex-1 min-w-0 truncate text-[12px] font-medium text-[var(--ink-90)]">{widgetDisplayName(w)}</span>
                    {fixed && (
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => fitTile(w.id)}
                        title="Fit the space again (grow with the free room around it)"
                        aria-label={`Fit ${widgetDisplayName(w)} to the space again`}
                        data-testid={`workcentre-fit-${w.id}`}
                        className="icon-btn h-6 w-6 shrink-0 text-[var(--ink-40)] hover:text-[rgb(var(--accent))]"
                      >
                        <Icon name="fit_screen" size={13} />
                      </button>
                    )}
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setActive(w.id)
                        setFocused(w.id)
                      }}
                      title="Open in full view"
                      aria-label={`Open ${widgetDisplayName(w)} in full view`}
                      data-testid={`workcentre-focus-${w.id}`}
                      className="icon-btn h-6 w-6 shrink-0 text-[var(--ink-40)] hover:text-[rgb(var(--accent))]"
                    >
                      <Icon name="open_in_full" size={13} />
                    </button>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setActive(w.id)
                        setViewMode(taskId, 'canvas')
                      }}
                      title="Show on the canvas"
                      aria-label={`Show ${widgetDisplayName(w)} on the canvas`}
                      data-testid={`workcentre-reveal-${w.id}`}
                      className="icon-btn h-6 w-6 shrink-0 text-[var(--ink-40)] hover:text-[rgb(var(--accent))]"
                    >
                      <Icon name="my_location" size={13} />
                    </button>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        if (!layout) return
                        const kept = { ...layout.items }
                        delete kept[w.id]
                        persist({ ...layout, items: kept, hidden: [...hidden, w.id] })
                      }}
                      title="Hide from the Workcentre (it stays on the desk)"
                      aria-label={`Hide ${widgetDisplayName(w)} from the Workcentre`}
                      data-testid={`workcentre-hide-${w.id}`}
                      className="icon-btn h-6 w-6 shrink-0 text-[var(--ink-40)] hover:text-[rgb(var(--accent))]"
                    >
                      <Icon name="visibility_off" size={13} />
                    </button>
                  </header>
                  {/* The full content, filling the tile. Pointer-transparent during a gesture or a drag-in preview. */}
                  <div className={`flex-1 min-h-0 min-w-0 relative ${live || held ? 'pointer-events-none' : ''}`} data-testid={`workcentre-body-${w.id}`}>
                    {renderWidgetInline(w)}
                  </div>
                  <div onPointerDown={(e) => begin(e, w.id, 'resize', 'r')} className="absolute top-8 right-0 bottom-3 w-1.5 cursor-ew-resize hover:bg-[rgb(var(--accent)/0.35)]" data-testid={`workcentre-resize-r-${w.id}`} title="Drag to set the width" />
                  <div onPointerDown={(e) => begin(e, w.id, 'resize', 'b')} className="absolute left-0 right-3 bottom-0 h-1.5 cursor-ns-resize hover:bg-[rgb(var(--accent)/0.35)]" data-testid={`workcentre-resize-b-${w.id}`} title="Drag to set the height" />
                  <div
                    onPointerDown={(e) => begin(e, w.id, 'resize', 'rb')}
                    onDoubleClick={() => fitTile(w.id)}
                    className="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-nwse-resize text-[var(--ink-30)] hover:text-[rgb(var(--accent))]"
                    data-testid={`workcentre-resize-${w.id}`}
                    title="Drag to set the size; double-click to fit the space again"
                  >
                    <Icon name="drag_handle" size={12} className="rotate-[-45deg]" />
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
