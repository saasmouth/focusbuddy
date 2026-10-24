import { useEffect, useMemo, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import { contentToPlainText } from '@shared/widgetText'
import { renderWidgetInline } from '../lib/renderWidgetInline'
import { widgetDisplayName } from '../lib/widgetDisplayName'
import ViewSelector from './views/ViewSelector'
import {
  buildColumns,
  columnsEligible,
  itemCardHeight,
  loadColumnsConfig,
  saveColumnsConfig,
  reorderColumns,
  COLUMN_MIN_W,
  COLUMN_MAX_W,
  type DeskColumnsConfig,
  type GroupBy
} from '../lib/deskColumns'
import { useWidgetStore } from '../stores/widgets'
import { useLinksStore } from '../stores/links'
import { useDeskViewStore } from '../stores/deskView'
import Icon from './Icon'
import CanvasContextMenu, { type CtxMenuItem } from './CanvasContextMenu'
import UnifiedWidgetMenu from './contextMenu/UnifiedWidgetMenu'
import { columnCardContext } from '../lib/contextMenu/buildContext'
import type { MenuContext } from '../lib/contextMenu/types'

// The desk Columns view: the same desk objects laid out as vertical, independently
// scrolling walls, the whole set scrolling horizontally. Columns are hand-made
// (Freeform), a real status board (drag a card to change its status), or derived
// from a grouping key (Type, Colour, Connections, Sections, Recency, AI Topic).
//
// Card dragging is POINTER-based (mousedown/move/up), not HTML5 drag-and-drop:
// DnD is unreliable in Electron over live widget bodies (drops silently fail), so
// this mirrors how the canvas drags widgets — and it's genuinely testable. While
// dragging, the view edge-scrolls (like the canvas edge-pan) so off-screen columns
// and cards are reachable. Columns are manually resizable and cards fill the column
// width, growing and shrinking with it.

const GROUPS: Array<{ value: GroupBy; label: string; icon: string }> = [
  { value: 'freeform', label: 'Freeform', icon: 'view_column' },
  { value: 'status', label: 'Status', icon: 'checklist' },
  { value: 'kind', label: 'Type', icon: 'category' },
  { value: 'color', label: 'Colour', icon: 'palette' },
  { value: 'connections', label: 'Connections', icon: 'hub' },
  { value: 'section', label: 'Sections', icon: 'dashboard' },
  { value: 'recency', label: 'Recency', icon: 'schedule' },
  { value: 'topic', label: 'Topic', icon: 'auto_awesome' }
]

interface TopicState {
  map: Record<string, string>
  loading: boolean
  error: string | null
  needsKey: boolean
  ranForSignature: string | null
}

export default function ColumnsView({ taskId, widgets }: { taskId: string; widgets: Widget[] }): JSX.Element {
  const [cfg, setCfgState] = useState<DeskColumnsConfig>(() => loadColumnsConfig(taskId))
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  // Freeform column reorder (spec §3.3) — drag a column by its header handle.
  const [colDragId, setColDragId] = useState<string | null>(null)
  const [colDragOverId, setColDragOverId] = useState<string | null>(null)
  // A floating label that follows the cursor during a card drag (pointer-based
  // dragging has no native drag image).
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string } | null>(null)
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; widgetId: string; fromCol: string } | null>(null)
  // Right-click on a card's header: the same work widget menu as its canvas
  // header, with this view's own rows (open, find on the canvas, move to a
  // column) as the object rows. The card body keeps its widget's own menus.
  const [cardMenu, setCardMenu] = useState<MenuContext | null>(null)
  const setActive = useWidgetStore((s) => s.setActive)
  const setFocused = useWidgetStore((s) => s.setFocused)
  const updateWidget = useWidgetStore((s) => s.update)
  const setViewMode = useDeskViewStore((s) => s.set)

  const links = useLinksStore((s) => s.links)
  const loadLinks = useLinksStore((s) => s.loadForTask)
  useEffect(() => {
    if (cfg.groupBy === 'connections') void loadLinks(taskId)
  }, [cfg.groupBy, taskId, loadLinks])

  const [topic, setTopic] = useState<TopicState>({ map: {}, loading: false, error: null, needsKey: false, ranForSignature: null })
  const eligible = useMemo(() => columnsEligible(widgets), [widgets])
  const topicSignature = useMemo(
    () => eligible.map((w) => `${w.id}:${(w.title || '').length}:${(w.content || '').length}`).sort().join('|'),
    [eligible]
  )

  async function runTopic(): Promise<void> {
    const items = eligible.map((w) => ({
      id: w.id,
      title: widgetDisplayName(w),
      text: contentToPlainText(w.content).slice(0, 400)
    }))
    if (items.length === 0) {
      setTopic({ map: {}, loading: false, error: null, needsKey: false, ranForSignature: topicSignature })
      return
    }
    setTopic((t) => ({ ...t, loading: true, error: null, needsKey: false }))
    const res = await window.api.ai.groupByTopic(items)
    if (res.ok) {
      setTopic({ map: res.topicByWidget ?? {}, loading: false, error: null, needsKey: false, ranForSignature: topicSignature })
    } else {
      setTopic({ map: {}, loading: false, error: res.error ?? 'Could not group by topic.', needsKey: !!res.needsApiKey, ranForSignature: topicSignature })
    }
  }

  useEffect(() => {
    if (cfg.groupBy !== 'topic') return
    if (topic.loading) return
    if (topic.ranForSignature === topicSignature) return
    void runTopic()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.groupBy, topicSignature])

  function update(next: DeskColumnsConfig): void {
    setCfgState(next)
    saveColumnsConfig(taskId, next)
  }

  const columns = useMemo(
    () => buildColumns(widgets, cfg, { links, topicByWidget: topic.map }),
    [widgets, cfg, links, topic.map]
  )
  const isFreeform = cfg.groupBy === 'freeform'
  const isStatus = cfg.groupBy === 'status'
  const canDrag = isFreeform || isStatus

  function assignTo(widgetId: string, columnId: string): void {
    const maxOrder = Object.entries(cfg.order)
      .filter(([id]) => cfg.assign[id] === columnId)
      .reduce((m, [, o]) => Math.max(m, o), 0)
    update({
      ...cfg,
      assign: { ...cfg.assign, [widgetId]: columnId },
      order: { ...cfg.order, [widgetId]: maxOrder + 1 }
    })
  }

  function dropOn(columnId: string, widgetId: string): void {
    if (isStatus) void updateWidget(widgetId, { status: columnId })
    else if (isFreeform) assignTo(widgetId, columnId)
  }

  // ── Edge navigation during a card drag (canvas-style edge-pan) ───────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const edgeRafRef = useRef<number | null>(null)
  const dragSrcRef = useRef<string | null>(null)

  function startEdgeScroll(): void {
    if (edgeRafRef.current != null) return
    const EDGE = 64
    const MAX = 22
    const step = (): void => {
      const cont = scrollRef.current
      const p = pointerRef.current
      if (cont && p) {
        const r = cont.getBoundingClientRect()
        if (p.x < r.left + EDGE) cont.scrollLeft -= MAX * Math.min(1, (r.left + EDGE - p.x) / EDGE)
        else if (p.x > r.right - EDGE) cont.scrollLeft += MAX * Math.min(1, (p.x - (r.right - EDGE)) / EDGE)
        const bodies = cont.querySelectorAll<HTMLElement>('[data-col-scroll]')
        for (const b of bodies) {
          const br = b.getBoundingClientRect()
          if (p.x >= br.left && p.x <= br.right && p.y >= br.top && p.y <= br.bottom) {
            if (p.y < br.top + EDGE) b.scrollTop -= MAX * Math.min(1, (br.top + EDGE - p.y) / EDGE)
            else if (p.y > br.bottom - EDGE) b.scrollTop += MAX * Math.min(1, (p.y - (br.bottom - EDGE)) / EDGE)
            break
          }
        }
      }
      edgeRafRef.current = requestAnimationFrame(step)
    }
    edgeRafRef.current = requestAnimationFrame(step)
  }
  function stopEdgeScroll(): void {
    if (edgeRafRef.current != null) {
      cancelAnimationFrame(edgeRafRef.current)
      edgeRafRef.current = null
    }
    pointerRef.current = null
  }

  // Which column's box contains a screen point (rect-based, so it works even with
  // the card bodies made pointer-transparent during a drag).
  function columnAtPoint(x: number, y: number): string | null {
    const cont = scrollRef.current
    if (!cont) return null
    for (const s of cont.querySelectorAll<HTMLElement>('[data-col-id]')) {
      const r = s.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return s.getAttribute('data-col-id')
    }
    return null
  }

  // Pointer-based card drag. Reliable where HTML5 DnD is not, and drives the same
  // dropOn() commit path (status field / freeform assignment).
  function beginCardDrag(w: Widget, e: React.MouseEvent): void {
    if (!canDrag || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragSrcRef.current = w.id
    setDragId(w.id)
    pointerRef.current = { x: e.clientX, y: e.clientY }
    setGhost({ x: e.clientX, y: e.clientY, name: widgetDisplayName(w) })
    setDragOverCol(columnAtPoint(e.clientX, e.clientY))
    startEdgeScroll()
    const onMove = (ev: MouseEvent): void => {
      pointerRef.current = { x: ev.clientX, y: ev.clientY }
      setGhost({ x: ev.clientX, y: ev.clientY, name: widgetDisplayName(w) })
      setDragOverCol(columnAtPoint(ev.clientX, ev.clientY))
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      const target = columnAtPoint(ev.clientX, ev.clientY)
      const src = dragSrcRef.current
      if (src && target) dropOn(target, src)
      dragSrcRef.current = null
      setDragId(null)
      setDragOverCol(null)
      setGhost(null)
      stopEdgeScroll()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp, { once: true })
  }

  // Pointer-based column resize (drag the right edge). Persists on release.
  function beginResize(colId: string, startWidth: number, e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const onMove = (ev: MouseEvent): void => {
      const next = Math.max(COLUMN_MIN_W, Math.min(COLUMN_MAX_W, Math.round(startWidth + (ev.clientX - startX))))
      setCfgState((c) => ({ ...c, widths: { ...(c.widths ?? {}), [colId]: next } }))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      setCfgState((c) => {
        saveColumnsConfig(taskId, c)
        return c
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp, { once: true })
  }

  // Pointer-based freeform column reorder — drag a column by its header handle
  // onto another column to drop it just before that one. Same reliable pointer
  // approach as the card drag; commits + persists on release.
  function beginColumnDrag(colId: string, e: React.MouseEvent): void {
    if (!isFreeform || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setColDragId(colId)
    setColDragOverId(colId)
    const onMove = (ev: MouseEvent): void => {
      setColDragOverId(columnAtPoint(ev.clientX, ev.clientY))
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      const target = columnAtPoint(ev.clientX, ev.clientY)
      if (target && target !== colId) update({ ...cfg, columns: reorderColumns(cfg.columns, colId, target) })
      setColDragId(null)
      setColDragOverId(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp, { once: true })
  }

  // Stop any active drag loop if the component unmounts mid-gesture.
  useEffect(() => () => stopEdgeScroll(), [])

  function focusObject(w: Widget): void {
    setActive(w.id)
    setFocused(w.id)
  }
  function openOnCanvas(w: Widget): void {
    setActive(w.id)
    setViewMode(taskId, 'canvas')
  }

  function addColumn(): void {
    const id = 'col-' + Math.random().toString(36).slice(2, 8)
    update({ ...cfg, columns: [...cfg.columns, { id, title: 'New column' }] })
  }
  function renameColumn(id: string, title: string): void {
    update({ ...cfg, columns: cfg.columns.map((c) => (c.id === id ? { ...c, title } : c)) })
  }
  function removeColumn(id: string): void {
    if (cfg.columns.length <= 1) return
    const firstId = cfg.columns.find((c) => c.id !== id)?.id
    const assign = { ...cfg.assign }
    for (const w of Object.keys(assign)) if (assign[w] === id && firstId) assign[w] = firstId
    update({ ...cfg, columns: cfg.columns.filter((c) => c.id !== id), assign })
  }

  const modeHint = isFreeform
    ? 'Drag cards between columns; rename a column, or add and remove your own. Drag a column edge to resize.'
    : isStatus
      ? 'Drag a card into a lane to set its status. Drag a column edge to resize.'
      : cfg.groupBy === 'topic'
        ? 'Columns proposed by AI from each object’s content.'
        : 'Grouped automatically. Switch to Freeform or Status to arrange by hand.'

  return (
    <div
      className={`absolute inset-0 flex flex-col bg-[var(--surface-sunken)] ${dragId ? 'cursor-grabbing select-none' : ''}`}
      data-testid="columns-view"
      data-desk-view="columns"
    >
      {/* Control bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--edge-soft)] bg-[var(--surface-raised)]">
        <Icon name="view_column" size={16} className="text-[var(--ink-50)]" />
        <span className="text-[13px] font-medium text-[var(--ink-90)]">Columns</span>
        <div className="ml-2 inline-flex rounded-lg bg-[var(--surface-sunken)] overflow-hidden">
          {GROUPS.map((g) => (
            <button
              key={g.value}
              onClick={() => update({ ...cfg, groupBy: g.value })}
              data-testid={`columns-groupby-${g.value}`}
              className={`inline-flex items-center gap-1 px-2.5 h-7 text-[12px] whitespace-nowrap ${
                cfg.groupBy === g.value
                  ? 'bg-[rgb(var(--accent))] text-white'
                  : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
              }`}
            >
              <Icon name={g.icon} size={13} />
              {g.label}
            </button>
          ))}
        </div>
        {isFreeform && (
          <button
            onClick={addColumn}
            data-testid="columns-add"
            className="fb-btn-surface ml-2 inline-flex items-center gap-1 h-7 px-2.5 border-dashed text-[12px] text-[var(--ink-70)] hover:text-[rgb(var(--accent))] hover:border-[rgb(var(--accent)/0.5)]"
          >
            <Icon name="add" size={14} /> Add column
          </button>
        )}
        {cfg.groupBy === 'topic' && (
          <button
            onClick={() => void runTopic()}
            disabled={topic.loading}
            data-testid="columns-topic-regroup"
            className="fb-btn-surface ml-2 inline-flex items-center gap-1 h-7 px-2.5 text-[12px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
          >
            <Icon name={topic.loading ? 'autorenew' : 'auto_awesome'} size={13} className={topic.loading ? 'animate-spin' : ''} />
            {topic.loading ? 'Grouping…' : 'Regroup'}
          </button>
        )}
        <span className="ml-2 text-[11px] text-[var(--ink-40)] hidden md:inline">{modeHint}</span>
        <div className="ml-auto flex items-center gap-2">
          {/* In-view selector so you can jump to any other view (or back to the
              canvas) without the breadcrumb selector, which this overlay covers. */}
          <ViewSelector taskId={taskId} />
          <button
            onClick={() => setViewMode(taskId, 'canvas')}
            data-testid="columns-to-canvas"
            className="fb-btn-surface inline-flex items-center gap-1 h-7 px-2.5 text-[12px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
            title="Back to the canvas"
          >
            <Icon name="grid_view" size={14} /> Canvas
          </button>
        </div>
      </div>

      {cfg.groupBy === 'topic' && (topic.needsKey || topic.error) && (
        <div className="shrink-0 px-4 py-2 text-[12px] border-b border-[var(--edge-soft)] bg-[var(--surface-raised)] text-[var(--ink-60)]">
          {topic.needsKey
            ? 'Topic grouping needs AI. Add an Anthropic key in Settings → AI, then press Regroup.'
            : topic.error}
        </div>
      )}

      {/* Horizontally scrolling set of columns */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className="h-full flex gap-4 p-4 items-stretch">
          {columns.map((col) => (
            <section
              key={col.id}
              data-testid={`column-${col.id}`}
              data-col-id={col.id}
              style={{ width: col.width }}
              className={`relative shrink-0 h-full flex flex-col rounded-xl border bg-[var(--surface-raised)] overflow-hidden transition-[border-color,box-shadow,opacity] ${
                (dragOverCol === col.id && dragId) || (colDragId && colDragOverId === col.id && colDragId !== col.id)
                  ? 'border-[rgb(var(--accent))] ring-2 ring-[rgb(var(--accent)/0.35)]'
                  : 'border-[var(--edge-soft)]'
              } ${colDragId === col.id ? 'opacity-50' : ''}`}
            >
              {/* Column header */}
              <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--edge-soft)]">
                {col.swatch && <span className="h-3 w-3 rounded-full shrink-0" style={{ background: col.swatch }} />}
                {isFreeform && (
                  <span
                    onMouseDown={(e) => beginColumnDrag(col.id, e)}
                    title="Drag to reorder this column"
                    data-testid={`column-move-${col.id}`}
                    className="shrink-0 -ml-0.5 px-0.5 cursor-grab active:cursor-grabbing text-[var(--ink-30)] hover:text-[var(--ink-60)]"
                  >
                    <Icon name="drag_indicator" size={14} />
                  </span>
                )}
                {isFreeform ? (
                  <input
                    defaultValue={col.title}
                    onBlur={(e) => e.target.value.trim() && renameColumn(col.id, e.target.value.trim())}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    className="flex-1 min-w-0 bg-transparent text-[13px] font-semibold text-[var(--ink-100)]"
                  />
                ) : (
                  <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-[var(--ink-100)]">{col.title}</span>
                )}
                <span className="text-[11px] text-[var(--ink-40)] fb-tabular shrink-0">{col.items.length}</span>
                {isFreeform && cfg.columns.length > 1 && (
                  <button
                    onClick={() => removeColumn(col.id)}
                    title="Remove column (items move to the first column)"
                    className="icon-btn h-6 w-6 text-[var(--ink-40)] hover:text-red-500"
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>

              {/* Independently scrolling stack of cards. Tagged so the drag
                  edge-scroll can auto-pan this column vertically. */}
              <div data-col-scroll className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
                {col.items.length === 0 ? (
                  <div className="text-[11px] text-[var(--ink-40)] text-center py-6">
                    {canDrag ? 'Drag objects here' : 'Empty'}
                  </div>
                ) : (
                  col.items.map((w) => (
                    <div
                      key={w.id}
                      className={`fb-card w-full shrink-0 overflow-hidden ${
                        dragId === w.id ? 'opacity-40' : ''
                      }`}
                      data-testid={`column-card-${w.id}`}
                    >
                      <div
                        className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)]"
                        data-testid={`columns-card-header-${w.id}`}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          const moves = canDrag ? columns.filter((c) => c.id !== col.id) : []
                          setCardMenu(
                            columnCardContext(w, { clientX: e.clientX, clientY: e.clientY }, {
                              onOpen: () => focusObject(w),
                              onReveal: () => openOnCanvas(w),
                              moveTo: moves.map((c) => ({ title: c.title, onMove: () => dropOn(c.id, w.id) }))
                            })
                          )
                        }}
                      >
                        {canDrag && (
                          <span
                            onMouseDown={(e) => beginCardDrag(w, e)}
                            title="Drag to move"
                            className="shrink-0 -ml-1 px-0.5 cursor-grab active:cursor-grabbing text-[var(--ink-30)] hover:text-[var(--ink-60)]"
                            data-testid={`column-drag-${w.id}`}
                          >
                            <Icon name="drag_indicator" size={14} />
                          </span>
                        )}
                        {w.color && <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: w.color }} />}
                        <span className="flex-1 min-w-0 truncate text-[12px] font-medium text-[var(--ink-90)]">
                          {widgetDisplayName(w)}
                        </span>
                        {canDrag && columns.length > 1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setMoveMenu({ x: e.clientX, y: e.clientY, widgetId: w.id, fromCol: col.id })
                            }}
                            title={isStatus ? 'Move to another lane' : 'Move to another column'}
                            data-testid={`column-move-${w.id}`}
                            className="icon-btn h-6 w-6 text-[var(--ink-40)] hover:text-[rgb(var(--accent))]"
                          >
                            <Icon name="drive_file_move" size={13} />
                          </button>
                        )}
                        <button
                          onClick={() => focusObject(w)}
                          title="Open in full view"
                          data-testid={`column-focus-${w.id}`}
                          className="icon-btn h-6 w-6 text-[var(--ink-40)] hover:text-[rgb(var(--accent))]"
                        >
                          <Icon name="open_in_full" size={13} />
                        </button>
                        <button
                          onClick={() => openOnCanvas(w)}
                          title="Show on the canvas"
                          data-testid={`column-reveal-${w.id}`}
                          className="icon-btn h-6 w-6 text-[var(--ink-40)] hover:text-[rgb(var(--accent))]"
                        >
                          <Icon name="my_location" size={13} />
                        </button>
                      </div>
                      {/* Card body fills the column width and is made pointer-transparent
                          during a drag so it never intercepts the gesture. */}
                      <div
                        style={{ height: itemCardHeight(w) }}
                        className={`overflow-hidden relative ${dragId ? 'pointer-events-none' : ''}`}
                      >
                        {renderWidgetInline(w)}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Resize handle on the right edge — drag to set this column's width. */}
              <div
                onMouseDown={(e) => beginResize(col.id, col.width, e)}
                title="Drag to resize this column"
                data-testid={`column-resize-${col.id}`}
                className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-[rgb(var(--accent)/0.4)]"
              />
            </section>
          ))}
        </div>
      </div>

      {/* Floating drag label (pointer drag has no native drag image). */}
      {ghost && (
        <div
          className="fixed z-[80] pointer-events-none px-2 py-1 rounded-md bg-[rgb(var(--accent))] text-white text-[11px] font-medium shadow-lg max-w-[220px] truncate"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
        >
          {ghost.name}
        </div>
      )}

      {cardMenu && <UnifiedWidgetMenu menuContext={cardMenu} onClose={() => setCardMenu(null)} />}
      {moveMenu && (
        <CanvasContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          items={columns
            .filter((c) => c.id !== moveMenu.fromCol)
            .map(
              (c): CtxMenuItem => ({
                label: `Move to ${c.title}`,
                icon: 'arrow_forward',
                onClick: () => dropOn(c.id, moveMenu.widgetId)
              })
            )}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  )
}
