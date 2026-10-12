import { useContext, useEffect, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import CanvasContextMenu, { type CtxMenuItem } from '../CanvasContextMenu'
import MakeTaskDialog from '../MakeTaskDialog'
import ShareDialog from '../ShareDialog'
import type { SectionLayout, Widget } from '@shared/types'
import { useWidgetStore } from '../../stores/widgets'
import { LinkDragContext } from '../../lib/linkDragContext'
import {
  computeLayoutCells,
  computeSectionFrame,
  effectiveLayout,
  findNonOverlapPosition,
  SECTION_PADDING,
  type LayoutCell
} from '../../lib/sectionGeometry'
import { catalogFor } from '../../lib/widgetCatalog'
import { chimeOut } from '../../lib/audioBeep'
import Icon from '../Icon'
import AgeHalo from '../AgeHalo'
import { SectionLayoutContext } from './sectionLayoutContext'
import { confirmDialog } from '../plexi/PromptDialog'

const SECTION_COLORS = [
  '#737373',
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6'
]

const LAYOUT_OPTIONS: Array<{ value: SectionLayout; icon: string; label: string }> = [
  { value: 'free', icon: 'open_with', label: 'Free' },
  { value: 'grid', icon: 'grid_view', label: 'Grid' },
  { value: 'stacks', icon: 'layers', label: 'Stacks' },
  { value: 'icons', icon: 'apps', label: 'Icons' },
  { value: 'list', icon: 'view_list', label: 'List' }
]

interface Props {
  widget: Widget
  inline?: boolean
  renderChild?: (child: Widget) => JSX.Element | null
}

export default function SectionWidget({
  widget,
  inline = false,
  renderChild
}: Props): JSX.Element | null {
  const update = useWidgetStore((s) => s.update)
  const remove = useWidgetStore((s) => s.remove)
  const setActive = useWidgetStore((s) => s.setActive)
  const focusOn = useWidgetStore((s) => s.focusOn)
  const setDragOverride = useWidgetStore((s) => s.setDragOverride)
  const linkDrag = useContext(LinkDragContext)
  // Suppress the click that browser dispatches immediately after a drag —
  // dragging the section-handle ends in mouseup → click on the body. We
  // don't want that click to fire focusOn (camera pan), which would
  // immediately re-centre on the section the user just placed.
  const dragJustEnded = useRef(0)
  const setFocused = useWidgetStore((s) => s.setFocused)
  const togglePin = useWidgetStore((s) => s.togglePin)
  const archive = useWidgetStore((s) => s.archive)
  const createWidget = useWidgetStore((s) => s.create)
  const bringToFront = useWidgetStore((s) => s.bringToFront)
  const bumpLayout = useWidgetStore((s) => s.bumpLayoutVersion)
  const zoom = useWidgetStore((s) => s.zoom)
  const allWidgets = useWidgetStore((s) => s.widgets)
  const isActive = useWidgetStore((s) => s.activeWidgetId === widget.id)
  const isHovered = useWidgetStore((s) => s.hoveredSectionId === widget.id)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(widget.title || 'Section')
  const [receivedPulse, setReceivedPulse] = useState(false)
  // Right-click on the section header opens "Make this a task" — same
  // pattern as WidgetFrame so promoting a section to a task is reachable
  // wherever the header is visible.
  const [headerCtxMenu, setHeaderCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [makeTaskOpen, setMakeTaskOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const rndRef = useRef<Rnd | null>(null)
  const prevChildCountRef = useRef(0)
  const lastAppliedSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 })

  useEffect(() => {
    setDraft(widget.title || 'Section')
  }, [widget.id, widget.title])

  const children = allWidgets.filter((w) => w.parentSectionId === widget.id)
  const layout = effectiveLayout(widget.layout)
  const frame = computeSectionFrame(children, layout)
  const contentW = frame.width - 2 * SECTION_PADDING

  useEffect(() => {
    if (children.length > prevChildCountRef.current) {
      setReceivedPulse(true)
      const t = window.setTimeout(() => setReceivedPulse(false), 460)
      prevChildCountRef.current = children.length
      return () => window.clearTimeout(t)
    }
    prevChildCountRef.current = children.length
    return undefined
  }, [children.length])

  useEffect(() => {
    const r = rndRef.current
    if (!r) return
    if (
      lastAppliedSize.current.w !== frame.width ||
      lastAppliedSize.current.h !== frame.height
    ) {
      lastAppliedSize.current = { w: frame.width, h: frame.height }
      const updateSize = (r as unknown as { updateSize?: (s: { width: number; height: number }) => void }).updateSize
      if (typeof updateSize === 'function') {
        updateSize.call(r, { width: frame.width, height: frame.height })
      }
    }
  }, [frame.width, frame.height])

  if (inline) return null

  const color = widget.color ?? SECTION_COLORS[0]
  const isPinned = widget.pinned
  const posX = isPinned ? widget.pinnedScreenX ?? widget.x : widget.x
  const posY = isPinned ? widget.pinnedScreenY ?? widget.y : widget.y

  const showSolid = isActive || isHovered || receivedPulse
  const showHoverGlow = isHovered

  function commitTitle(): void {
    const next = draft.trim() || 'Section'
    if (next !== widget.title) void update(widget.id, { title: next })
    setEditing(false)
  }

  // A compact (icons/list) child was dragged. If it was released OUTSIDE the
  // section card, eject it onto the desk at the drop point; if released inside,
  // it snaps back into the layout (no-op). This is the drag-out gesture the
  // user asked for — an alternative to the right-click "Move out of section".
  function handleChildDragRelease(
    child: Widget,
    cell: LayoutCell,
    clientX: number,
    clientY: number,
    startX: number,
    startY: number
  ): void {
    const sectionEl = document.querySelector(`[data-widget-id="${widget.id}"]`)
    const r = sectionEl?.getBoundingClientRect()
    const inside =
      !!r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
    if (inside) return
    const z = useWidgetStore.getState().zoom || 1
    // The child started at this canvas position; translate the cursor's screen
    // delta into canvas px to find where on the desk to drop it.
    const childCanvasX = widget.x + SECTION_PADDING + cell.x
    const childCanvasY = widget.y + SECTION_PADDING + cell.y
    const dropX = Math.round(childCanvasX + (clientX - startX) / z)
    const dropY = Math.round(childCanvasY + (clientY - startY) / z)
    chimeOut()
    void update(child.id, { parentSectionId: null, x: dropX, y: dropY }).then(() => bumpLayout())
  }

  const cells = computeLayoutCells(layout, children, contentW)

  return (
    <Rnd
      ref={(r) => {
        rndRef.current = r as Rnd | null
      }}
      position={{ x: posX, y: posY }}
      size={{ width: frame.width, height: frame.height }}
      scale={isPinned ? 1 : zoom}
      style={{ zIndex: 0, position: 'absolute', pointerEvents: 'auto' }}
      enableResizing={false}
      dragHandleClassName="section-handle"
      onDragStart={() => setActive(widget.id)}
      onDrag={(_, d) => {
        // Mirror WidgetFrame's behaviour — push the live position into the
        // shared drag-override slot so the link overlay endpoints follow
        // the section as it's dragged. Skipped for pinned sections (which
        // don't participate in linking).
        if (!isPinned) {
          setDragOverride({ widgetId: widget.id, x: d.x, y: d.y })
        }
      }}
      onDragStop={(_, d) => {
        setDragOverride(null)
        if (isPinned) {
          void update(widget.id, {
            pinnedScreenX: Math.round(d.x),
            pinnedScreenY: Math.round(d.y)
          })
          return
        }
        // Sections don't go through WidgetFrame's commitDrop — they have
        // their own Rnd. So we duplicate the overlap-avoidance logic here
        // so sections also respect the reverse-magnetic rule against free
        // widgets and other sections on the canvas.
        const latestWidgets = useWidgetStore.getState().widgets
        const rawX = Math.round(d.x)
        const rawY = Math.round(d.y)
        const siblings = latestWidgets.filter(
          (w) => w.id !== widget.id && !w.pinned && !w.parentSectionId
        )
        const effSiblings = siblings.map((s) => {
          if (s.kind !== 'section') return s
          const sChildren = latestWidgets.filter((c) => c.parentSectionId === s.id)
          const sFrame = computeSectionFrame(sChildren, effectiveLayout(s.layout))
          return { ...s, width: sFrame.width, height: sFrame.height }
        })
        const placed = findNonOverlapPosition(
          { x: rawX, y: rawY, width: frame.width, height: frame.height },
          effSiblings
        )
        void update(widget.id, { x: placed.x, y: placed.y })
        // SectionWidget's Rnd is controlled (position prop) — the section
        // and its children visually follow the store update automatically
        // when widget.x/y change. We deliberately do NOT call bumpLayout
        // here: that would change every widget's React key in the canvas,
        // forcing all widgets (including any <webview>) to unmount and
        // remount — every Electron webview would fully reload its URL.
        // Mark the drag-end timestamp so the click event that follows
        // doesn't run our onClick focusOn logic.
        dragJustEnded.current = performance.now()
      }}
    >
      <AgeHalo createdAt={widget.createdAt} variant="section" />
      <div
        data-widget-id={widget.id}
        onClick={(e) => {
          e.stopPropagation()
          // Suppress the synthetic click that fires immediately after a
          // drag-end — otherwise dragging a section would re-centre the
          // camera right after dropping it.
          if (performance.now() - dragJustEnded.current < 250) return
          // Deliberate click → bring the section into the centre. Pinned
          // sections are docked to a corner and are always visible, so
          // centering would jump to a stale world-space coord — just
          // activate them.
          if (isPinned) {
            setActive(widget.id)
          } else {
            focusOn(widget.id)
          }
        }}
        className={`h-full w-full relative ${receivedPulse ? 'section-receive-pulse' : ''}`}
      >
        <div
          className={`absolute inset-0 rounded-md pointer-events-none transition-all duration-150 ${
            showSolid ? 'border-[3px] border-solid' : 'border-2 border-dashed'
          }`}
          style={{
            borderColor: color,
            backgroundColor: `${color}${showHoverGlow ? '22' : '10'}`,
            boxShadow: showHoverGlow ? `0 0 24px ${color}55, inset 0 0 0 1px ${color}33` : undefined
          }}
        />

        <div
          className="section-handle absolute top-0 left-3 -translate-y-1/2 px-2 py-0.5 rounded-md shadow flex items-center gap-1.5 cursor-move select-none flex-wrap max-w-[calc(100%-24px)]"
          style={{ backgroundColor: color }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setHeaderCtxMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitTitle}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  setDraft(widget.title || 'Section')
                  setEditing(false)
                }
              }}
              className="bg-[color-mix(in_oklab,var(--surface-raised)_95%,transparent)] text-[var(--ink-100)] px-1.5 py-0.5 rounded text-xs w-40"
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
              className="text-xs font-medium text-white tracking-wide px-0.5"
              title="Double-click to rename"
            >
              {widget.title || 'Section'}
            </span>
          )}

          <span
            className="text-[10px] text-white/70 ml-0.5"
            title="Children in this section"
          >
            {children.length}
          </span>

          {/* Section header chrome sits on the user's own colour; white literals are relative to it. */}
          <div
            className="flex items-center gap-0.5 pl-1.5 border-l border-white/30"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {LAYOUT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={(e) => {
                  e.stopPropagation()
                  void update(widget.id, { layout: opt.value })
                  bumpLayout()
                }}
                title={`Layout: ${opt.label}`}
                className={`h-4 w-4 inline-flex items-center justify-center rounded ${
                  opt.value === layout ? 'bg-[color-mix(in_oklab,var(--surface-raised)_30%,transparent)]' : 'hover:bg-[color-mix(in_oklab,var(--surface-raised)_15%,transparent)]'
                }`}
              >
                <Icon name={opt.icon} size={11} className="text-white" />
              </button>
            ))}
          </div>

          <div
            className="flex items-center gap-0.5 pl-1.5 border-l border-white/30"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {SECTION_COLORS.map((c) => (
              <button
                key={c}
                onClick={(e) => {
                  e.stopPropagation()
                  void update(widget.id, { color: c })
                }}
                title={`Color ${c}`}
                className={`h-2.5 w-2.5 rounded-full border transition-transform ${
                  c === color ? 'border-white scale-125' : 'border-white/40 hover:scale-125'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          {!isPinned && linkDrag && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                linkDrag.start(widget.id)
              }}
              className="h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[color-mix(in_oklab,var(--surface-raised)_20%,transparent)] cursor-cell"
              title="Click, then click another widget to connect them"
              aria-label="Link from this section"
            >
              <Icon name="hub" size={11} className="text-white" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              void togglePin(widget.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[color-mix(in_oklab,var(--surface-raised)_20%,transparent)]"
            title={isPinned ? 'Unpin from screen' : 'Pin to screen'}
            aria-label={isPinned ? 'Unpin' : 'Pin'}
          >
            <Icon name="push_pin" size={11} filled={isPinned} className="text-white" />
          </button>
          <button
            onClick={async (e) => {
              e.stopPropagation()
              const body =
                children.length > 0
                  ? `Its ${children.length} widget${children.length === 1 ? '' : 's'} will remain on the canvas.`
                  : undefined
              const confirmed = await confirmDialog({
                title: `Remove section “${widget.title || 'Section'}”?`,
                body,
                confirmLabel: 'Remove section',
                danger: true
              })
              if (confirmed) {
                for (const c of children) {
                  void update(c.id, {
                    parentSectionId: null,
                    x: Math.round(widget.x + SECTION_PADDING + c.x),
                    y: Math.round(widget.y + SECTION_PADDING + c.y)
                  })
                }
                void remove(widget.id)
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="h-4 w-4 inline-flex items-center justify-center rounded hover:bg-[color-mix(in_oklab,var(--surface-raised)_20%,transparent)]"
            title="Remove section"
            aria-label="Remove"
          >
            <Icon name="close" size={11} className="text-white" />
          </button>
        </div>

        {/* Children content area */}
        <div
          className="absolute"
          style={{
            top: SECTION_PADDING,
            left: SECTION_PADDING,
            right: SECTION_PADDING,
            bottom: SECTION_PADDING,
            pointerEvents: 'none'
          }}
        >
          <div className="relative w-full h-full">
            {layout === 'icons' || layout === 'list' ? (
              children.map((c, i) => (
                <CompactChildView
                  key={c.id}
                  child={c}
                  cell={cells[i]}
                  layout={layout}
                  color={color}
                  onOpen={() => setFocused(c.id)}
                  onEject={() => {
                    chimeOut()
                    // Eject button: drop just below the section so it doesn't
                    // land under the section card.
                    const canvasX = Math.round(widget.x + SECTION_PADDING + cells[i].x)
                    const canvasY = Math.round(widget.y + SECTION_PADDING + cells[i].y)
                    void update(c.id, {
                      parentSectionId: null,
                      x: canvasX,
                      y: canvasY
                    }).then(() => bumpLayout())
                  }}
                  onDragRelease={(cx, cy, sx, sy) =>
                    handleChildDragRelease(c, cells[i], cx, cy, sx, sy)
                  }
                />
              ))
            ) : (
              renderChild &&
              children.map((c, i) => (
                <SectionLayoutContext.Provider
                  key={c.id}
                  value={{
                    layout,
                    position: { x: cells[i].x, y: cells[i].y },
                    size: { width: cells[i].width, height: cells[i].height }
                  }}
                >
                  <div style={{ pointerEvents: 'auto' }}>{renderChild(c)}</div>
                </SectionLayoutContext.Provider>
              ))
            )}

            {isHovered && children.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div
                  className="px-2.5 py-1 rounded-full text-[11px] font-medium text-white shadow"
                  style={{ backgroundColor: color }}
                >
                  Drop to add to section
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {headerCtxMenu && (
        <CanvasContextMenu
          x={headerCtxMenu.x}
          y={headerCtxMenu.y}
          items={(() => {
            const items: CtxMenuItem[] = []
            items.push({
              label: 'Share section…',
              icon: 'share',
              onClick: () => setShareOpen(true)
            })
            items.push({
              label: 'Make this a task…',
              icon: 'task_alt',
              onClick: () => setMakeTaskOpen(true)
            })
            items.push({ separator: true })
            items.push({
              label: 'Duplicate (empty)',
              icon: 'content_copy',
              onClick: () => {
                // Duplicate the section container only — children stay in
                // the original. Cloning children would imply moving them
                // (children belong to one parent at a time) which is not
                // what "duplicate" usually means. The new section opens
                // empty so the user can drop different content into it.
                void createWidget({
                  taskId: widget.taskId,
                  kind: 'section',
                  title: widget.title ? `${widget.title} (copy)` : 'Section',
                  content: '',
                  x: widget.x + 30,
                  y: widget.y + 30,
                  width: widget.width,
                  height: widget.height,
                  color: widget.color
                })
              }
            })
            items.push({
              label: 'Section layout',
              icon: 'dashboard_customize',
              children: LAYOUT_OPTIONS.map((opt) => ({
                label: opt.value === layout ? `${opt.label} ✓` : opt.label,
                icon: opt.icon,
                onClick: () => {
                  void update(widget.id, { layout: opt.value })
                  bumpLayout()
                }
              }))
            })
            items.push({
              label: 'Bring to front',
              icon: 'flip_to_front',
              onClick: () => {
                void bringToFront(widget.id)
              }
            })
            items.push({ separator: true })
            items.push({
              label: 'Archive (keep children on desk)',
              icon: 'inventory_2',
              onClick: () => {
                // Eject children back to the canvas first, then archive
                // the section. Otherwise archiving would also "lose" the
                // children (they'd be invisible because their parent is
                // archived, not because they were intentionally removed).
                const childs = allWidgets.filter((c) => c.parentSectionId === widget.id)
                for (const c of childs) {
                  void update(c.id, {
                    parentSectionId: null,
                    x: Math.round(widget.x + SECTION_PADDING + c.x),
                    y: Math.round(widget.y + SECTION_PADDING + c.y)
                  })
                }
                void archive(widget.id)
              }
            })
            return items
          })()}
          onClose={() => setHeaderCtxMenu(null)}
        />
      )}
      {makeTaskOpen && (
        <MakeTaskDialog
          seedTitle={widget.title || 'Section'}
          sourceWidget={widget}
          onClose={() => setMakeTaskOpen(false)}
        />
      )}
      {shareOpen && (
        <ShareDialog
          kind="widget"
          entityId={widget.id}
          label={widget.title || 'Section'}
          onClose={() => setShareOpen(false)}
        />
      )}
    </Rnd>
  )
}

// Pointer-drag gesture that lets a section child be dragged out onto the open
// canvas. We use document-level listeners (NOT setPointerCapture) so a plain
// tap still reaches the element's own onClick — only a real drag past the
// threshold is treated as a drag-out. `onRelease` fires with the final +
// starting cursor positions so the caller can decide inside-vs-outside and
// translate to canvas coords. `suppressClickRef` lets the caller swallow the
// click that the browser fires right after a drag.
function useEjectDrag(
  onRelease: (clientX: number, clientY: number, startX: number, startY: number) => void
): {
  onPointerDown: (e: React.PointerEvent) => void
  offset: { x: number; y: number } | null
  suppressClickRef: React.MutableRefObject<boolean>
} {
  const movedRef = useRef(false)
  const suppressClickRef = useRef(false)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const start = { x: e.clientX, y: e.clientY }
    movedRef.current = false
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!movedRef.current && Math.hypot(dx, dy) < 6) return
      movedRef.current = true
      setOffset({ x: dx, y: dy })
    }
    const up = (ev: PointerEvent): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      if (movedRef.current) {
        suppressClickRef.current = true
        onRelease(ev.clientX, ev.clientY, start.x, start.y)
      }
      setOffset(null)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  return { onPointerDown, offset, suppressClickRef }
}

interface CompactProps {
  child: Widget
  cell: LayoutCell
  layout: SectionLayout
  color: string
  onOpen: () => void
  onEject: () => void
  onDragRelease: (clientX: number, clientY: number, startX: number, startY: number) => void
}

function CompactChildView({
  child,
  cell,
  layout,
  color,
  onOpen,
  onEject,
  onDragRelease
}: CompactProps): JSX.Element {
  const entry = catalogFor(child.kind)
  const { onPointerDown, offset, suppressClickRef } = useEjectDrag(onDragRelease)
  const dragging = offset !== null

  // Click handler shared by the list row and the icon tile. ⌘/Ctrl-click while
  // zoomed out dives into the child (100% + centred) exactly like every other
  // canvas item — compact section children render as plain divs (not
  // WidgetFrame), so they'd otherwise be the one place the gesture is missing.
  const handleOpen = (e: React.MouseEvent): void => {
    e.stopPropagation()
    // Swallow the click the browser fires right after a drag-out gesture.
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const store = useWidgetStore.getState()
    if ((e.metaKey || e.ctrlKey) && store.zoom < 0.8) {
      store.zoomToWidget(child.id)
      return
    }
    onOpen()
  }

  // Visual feedback while dragging a child out of the section.
  const dragStyle: React.CSSProperties = dragging
    ? {
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        zIndex: 50,
        opacity: 0.9,
        cursor: 'grabbing',
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)'
      }
    : {}
  const title =
    child.title ||
    (child.content
      ? layout === 'list'
        ? child.content.slice(0, 80)
        : entry?.label ?? child.kind
      : entry?.label ?? child.kind)

  if (layout === 'list') {
    return (
      <div
        data-widget-id={child.id}
        data-widget-kind={child.kind}
        style={{
          position: 'absolute',
          left: cell.x,
          top: cell.y,
          width: cell.width,
          height: cell.height,
          pointerEvents: 'auto',
          ...dragStyle
        }}
        className="fb-card fb-press group flex items-center gap-2 px-3 hover:border-[var(--edge-firm)] hover:shadow-sm cursor-pointer transition-colors"
        onPointerDown={onPointerDown}
        onClick={handleOpen}
        title="Drag out of the section to move it back to the desk"
      >
        <span
          className="h-7 w-7 rounded inline-flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${color}22`, color }}
        >
          <Icon name={entry?.icon ?? 'apps'} size={16} className="" style={{ color }} />
        </span>
        <span className="text-sm text-[var(--ink-100)] truncate flex-1 min-w-0">{title}</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onEject()
          }}
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-50)] hover:text-amber-700 transition-opacity"
          title="Remove from section"
        >
          <Icon name="layers_clear" size={14} />
        </button>
      </div>
    )
  }

  // icons mode — use the computed cell so section frame and child positions always agree
  return (
    <div
      data-widget-id={child.id}
      data-widget-kind={child.kind}
      style={{
        position: 'absolute',
        left: cell.x,
        top: cell.y,
        width: cell.width,
        height: cell.height,
        pointerEvents: 'auto',
        ...dragStyle
      }}
      className="group"
      onPointerDown={onPointerDown}
      title="Drag out of the section to move it back to the desk"
    >
      <button
        onClick={handleOpen}
        className="fb-btn-surface w-full h-full flex flex-col items-center justify-center gap-1 hover:border-[var(--edge-firm)] hover:shadow-md transition-colors p-2"
        title={title}
      >
        <span
          className="h-10 w-10 rounded inline-flex items-center justify-center"
          style={{ backgroundColor: `${color}22`, color }}
        >
          <Icon name={entry?.icon ?? 'apps'} size={22} style={{ color }} />
        </span>
        <span className="text-[10px] text-[var(--ink-70)] truncate w-full text-center">{title}</span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onEject()
        }}
        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 absolute -top-1 -right-1 h-4 w-4 rounded-full bg-[var(--surface-raised)] border border-[var(--edge-firm)] text-[var(--ink-50)] hover:text-amber-700 inline-flex items-center justify-center transition-opacity"
        title="Remove from section"
      >
        <Icon name="layers_clear" size={9} />
      </button>
    </div>
  )
}
