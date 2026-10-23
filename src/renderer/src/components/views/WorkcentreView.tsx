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
  fromTiles,
  gridRows,
  moveTile,
  resizeTile,
  syncLayout,
  toTiles,
  unitsFromPx,
  type Mins,
  type Tile
} from '../../lib/workcentreLayout'
import { currentDeviceClass } from '../../lib/deviceClass'
import { useWidgetStore } from '../../stores/widgets'
import { useAccountStore } from '../../stores/account'
import { useDeskViewStore } from '../../stores/deskView'
import ViewSelector from './ViewSelector'
import Icon from '../Icon'

// The Workcentre desk view (owner, 4.3.41): the Desk as a dashboard. Every work
// widget, file and tool is a tile on a snapping grid that never overlaps, can be
// moved and resized freely, and shows its FULL content — an office document shows
// its live editor (the same renderWidgetInline path as full view), not a
// thumbnail. Tile geometry is the view's own (lib/workcentreLayout): sizing a tile
// never moves or resizes the object on the canvas, and the reverse. It is stored
// per (user, Desk, device class) in desk_layouts: device-local, like the canvas's
// own custom layout. Sections stay a canvas concept; the work inside them tiles.
//
// Gestures are pointer-based (as in Columns): HTML5 drag-and-drop is unreliable
// over live bodies in Electron. A tile body is pointer-transparent during a
// gesture so an editor never swallows it.

/** Objects that tile: everything a person works with, not the canvas's own furniture. */
export function workcentreEligible(widgets: Widget[]): Widget[] {
  return widgets.filter((w) => !w.archived && w.kind !== 'section' && w.kind !== 'minimap')
}

type Gesture = { id: string; kind: 'move' | 'resize'; edge: 'r' | 'b' | 'rb'; startX: number; startY: number; tile: Tile; tiles: Tile[] }

export default function WorkcentreView({ taskId, widgets }: { taskId: string; widgets: Widget[] }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [stored, setStored] = useState<WorkcentreLayout | null | undefined>(undefined) // undefined = loading
  const [preview, setPreview] = useState<Tile[] | null>(null) // live tiles during a gesture
  const gesture = useRef<Gesture | null>(null)
  const setActive = useWidgetStore((s) => s.setActive)
  const setFocused = useWidgetStore((s) => s.setFocused)
  const setViewMode = useDeskViewStore((s) => s.set)
  const userId = useAccountStore((s) => s.account?.id ?? 'local')

  // The view measures itself: the column count follows its own width (a desk widget, a menu at 480px).
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => setWidth(entries[0]!.contentRect.width))
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  // Load this Desk's dashboard (device-local, per device class).
  useEffect(() => {
    let live = true
    setStored(undefined)
    void window.api.deskLayout
      .load(userId, taskId, currentDeviceClass())
      .then((l) => live && setStored(l?.workcentre ?? null))
      .catch(() => live && setStored(null))
    return () => {
      live = false
    }
  }, [taskId, userId])

  const items = useMemo(() => workcentreEligible(widgets), [widgets])
  const pad = 16
  const innerW = Math.max(0, width - pad * 2)
  const cols = colsForWidth(innerW)
  const colPx = colWidthPx(innerW, cols)
  const mins: Mins = useMemo(() => Object.fromEntries(items.map((w) => [w.id, unitsFromPx(minSizeFor(w.kind), colPx)])), [items, colPx])

  // The layout reconciled with the objects now on the Desk (new ones tiled, gone ones dropped).
  const layout: WorkcentreLayout | null = useMemo(() => {
    if (stored === undefined || !width) return null
    const objects = items.map((w) => ({ id: w.id, preferred: unitsFromPx({ w: w.width, h: w.height }, colPx) }))
    return syncLayout(stored, objects, cols, mins)
  }, [stored, items, cols, colPx, mins, width])

  const persist = useCallback(
    (l: WorkcentreLayout) => {
      setStored(l)
      void window.api.deskLayout.saveWorkcentre(userId, taskId, currentDeviceClass(), l).catch(() => undefined)
    },
    [taskId, userId]
  )

  // Keep the stored layout in step when the reconciled one differs (first open, objects added or removed).
  useEffect(() => {
    if (!layout || stored === undefined) return
    if (JSON.stringify(layout) !== JSON.stringify(stored)) persist(layout)
  }, [layout, stored, persist])

  const tiles = preview ?? (layout ? toTiles(layout) : [])
  const unitX = colPx + GAP_PX
  const unitY = ROW_PX + GAP_PX

  function begin(e: React.PointerEvent, id: string, kind: Gesture['kind'], edge: Gesture['edge'] = 'rb'): void {
    if (e.button !== 0 || !layout) return
    e.preventDefault()
    e.stopPropagation()
    const all = toTiles(layout)
    const tile = all.find((t) => t.id === id)
    if (!tile) return
    gesture.current = { id, kind, edge, startX: e.clientX, startY: e.clientY, tile, tiles: all }
    setPreview(all)
    const onMove = (ev: PointerEvent): void => {
      const g = gesture.current
      if (!g) return
      const dx = Math.round((ev.clientX - g.startX) / unitX)
      const dy = Math.round((ev.clientY - g.startY) / unitY)
      setPreview(
        g.kind === 'move'
          ? moveTile(g.tiles, g.id, { x: g.tile.x + dx, y: g.tile.y + dy }, cols, mins)
          : resizeTile(g.tiles, g.id, { w: g.tile.w + (g.edge === 'b' ? 0 : dx), h: g.tile.h + (g.edge === 'r' ? 0 : dy) }, cols, mins)
      )
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      gesture.current = null
      setPreview((p) => {
        if (p) persist(fromTiles(cols, p))
        return null
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Keyboard, on a focused tile: Alt+arrows move it one cell, Shift+Alt+arrows resize it.
  function onTileKey(e: React.KeyboardEvent, id: string): void {
    if (!e.altKey || !layout) return
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] as [number, number] | undefined
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    const all = toTiles(layout)
    const t = all.find((x) => x.id === id)!
    const next = e.shiftKey ? resizeTile(all, id, { w: t.w + d[0], h: t.h + d[1] }, cols, mins) : moveTile(all, id, { x: t.x + d[0], y: t.y + d[1] }, cols, mins)
    persist(fromTiles(cols, next))
  }

  const byId = new Map(items.map((w) => [w.id, w]))
  const rows = gridRows(tiles)

  return (
    <div className={`absolute inset-0 flex flex-col bg-[var(--surface-sunken)] ${preview ? 'select-none' : ''}`} data-testid="workcentre-view" data-desk-view="workcentre">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--edge-soft)] bg-[var(--surface-raised)] min-w-0">
        <Icon name="space_dashboard" size={16} className="text-[var(--ink-50)]" />
        <span className="text-[13px] font-medium text-[var(--ink-90)]">Workcentre</span>
        <span className="flex-1 min-w-0 truncate text-[11px] text-[var(--ink-50)]" data-testid="workcentre-hint">
          Drag a tile by its title to move it; drag an edge or corner to resize. Alt+arrows move, Shift+Alt+arrows resize. Saved on this device.
        </span>
        <ViewSelector taskId={taskId} />
      </div>
      <div ref={hostRef} className="flex-1 min-h-0 min-w-0 overflow-auto" data-testid="workcentre-scroll">
        {!layout ? (
          <div className="p-6 text-[12px] text-[var(--ink-50)]" role="status">
            Laying out the Workcentre…
          </div>
        ) : !items.length ? (
          <div className="p-10 text-center text-[13px] text-[var(--ink-50)]" data-testid="workcentre-empty">
            Nothing on this desk yet. Add work widgets, files or tools and they tile here.
          </div>
        ) : (
          <div
            className="relative grid"
            data-testid="workcentre-grid"
            data-cols={cols}
            style={{
              margin: pad,
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridAutoRows: `${ROW_PX}px`,
              gap: `${GAP_PX}px`,
              minHeight: rows * unitY
            }}
          >
            {tiles.map((t) => {
              const w = byId.get(t.id)
              if (!w) return null
              const active = preview && gesture.current?.id === t.id
              return (
                <section
                  key={t.id}
                  tabIndex={0}
                  aria-label={widgetDisplayName(w)}
                  onKeyDown={(e) => onTileKey(e, t.id)}
                  data-testid={`workcentre-tile-${t.id}`}
                  data-x={t.x}
                  data-y={t.y}
                  data-w={t.w}
                  data-h={t.h}
                  className={`relative fb-card overflow-hidden flex flex-col min-w-0 min-h-0 outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent))] ${active ? 'ring-2 ring-[rgb(var(--accent))] z-10' : ''}`}
                  style={{ gridColumn: `${t.x + 1} / span ${t.w}`, gridRow: `${t.y + 1} / span ${t.h}` }}
                >
                  <header
                    onPointerDown={(e) => begin(e, t.id, 'move')}
                    className="shrink-0 flex items-center gap-1.5 px-2.5 h-8 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)] cursor-grab active:cursor-grabbing min-w-0"
                    title="Drag to move"
                    data-testid={`workcentre-move-${t.id}`}
                  >
                    <Icon name="drag_indicator" size={14} className="shrink-0 text-[var(--ink-30)]" />
                    {w.color && <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: w.color }} />}
                    <span className="flex-1 min-w-0 truncate text-[12px] font-medium text-[var(--ink-90)]">{widgetDisplayName(w)}</span>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setActive(w.id)
                        setFocused(w.id)
                      }}
                      title="Open in full view"
                      aria-label={`Open ${widgetDisplayName(w)} in full view`}
                      data-testid={`workcentre-focus-${t.id}`}
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
                      data-testid={`workcentre-reveal-${t.id}`}
                      className="icon-btn h-6 w-6 shrink-0 text-[var(--ink-40)] hover:text-[rgb(var(--accent))]"
                    >
                      <Icon name="my_location" size={13} />
                    </button>
                  </header>
                  {/* The full content, filling the tile. Pointer-transparent during a gesture. */}
                  <div className={`flex-1 min-h-0 min-w-0 relative ${preview ? 'pointer-events-none' : ''}`} data-testid={`workcentre-body-${t.id}`}>
                    {renderWidgetInline(w)}
                  </div>
                  <div onPointerDown={(e) => begin(e, t.id, 'resize', 'r')} className="absolute top-8 right-0 bottom-3 w-1.5 cursor-ew-resize hover:bg-[rgb(var(--accent)/0.35)]" data-testid={`workcentre-resize-r-${t.id}`} title="Drag to resize" />
                  <div onPointerDown={(e) => begin(e, t.id, 'resize', 'b')} className="absolute left-0 right-3 bottom-0 h-1.5 cursor-ns-resize hover:bg-[rgb(var(--accent)/0.35)]" data-testid={`workcentre-resize-b-${t.id}`} title="Drag to resize" />
                  <div
                    onPointerDown={(e) => begin(e, t.id, 'resize', 'rb')}
                    className="absolute right-0 bottom-0 w-3.5 h-3.5 cursor-nwse-resize text-[var(--ink-30)] hover:text-[rgb(var(--accent))]"
                    data-testid={`workcentre-resize-${t.id}`}
                    title="Drag to resize"
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
