import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useWidgetStore } from '../stores/widgets'
import { computeSectionFrame, effectiveLayout } from '../lib/sectionGeometry'
import { mappedBox, mappedScale, viewportIndicator } from '../lib/minimapGeometry'
import WidgetPreview from './WidgetPreview'
import DeskJumpList from './DeskJumpList'
import Icon from './Icon'

const PANEL_W = 160
const PANEL_H = 100
const PADDING = 5
const PANEL = { width: PANEL_W, height: PANEL_H, padding: PADDING }

// Always-present minimap button in the canvas bottom-right.
// Click the icon to pin the panel open; panel also auto-opens for 2.2s
// whenever the user pans or zooms. The icon hides while the panel is visible —
// panel and icon are mutually exclusive.
export default function CanvasMinimapFAB(): JSX.Element {
  const widgets = useWidgetStore((s) => s.widgets)
  const zoom = useWidgetStore((s) => s.zoom)
  const panX = useWidgetStore((s) => s.panX)
  const panY = useWidgetStore((s) => s.panY)
  const setPan = useWidgetStore((s) => s.setPan)

  // open = manually pinned open by user click
  const [open, setOpen] = useState(false)
  // navOpen = auto-opened by pan/zoom, auto-closes 2.2s after movement stops
  const [navOpen, setNavOpen] = useState(false)
  const navTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Respond to pan/zoom changes — open for 2.2s after last movement.
  // Two separate effects: one that reacts, one that cleans up on unmount.
  // (A single effect with cleanup would cancel its own timer on every pan frame.)
  const prevNavRef = useRef({ panX, panY, zoom })
  useEffect(() => {
    const prev = prevNavRef.current
    if (prev.panX === panX && prev.panY === panY && prev.zoom === zoom) return
    prevNavRef.current = { panX, panY, zoom }
    setNavOpen(true)
    if (navTimer.current !== undefined) clearTimeout(navTimer.current)
    navTimer.current = setTimeout(() => {
      setNavOpen(false)
      navTimer.current = undefined
    }, 2200)
  }, [panX, panY, zoom])

  useEffect(() => {
    return () => {
      if (navTimer.current !== undefined) clearTimeout(navTimer.current)
    }
  }, [])

  // Clicking anywhere on the canvas surface (outside the FAB) auto-closes navOpen.
  useEffect(() => {
    function handleCanvasClick(e: Event): void {
      const fab = document.querySelector('[data-minimap-fab]')
      if (fab?.contains(e.target as Node)) return
      if (navTimer.current !== undefined) {
        clearTimeout(navTimer.current)
        navTimer.current = undefined
      }
      setNavOpen(false)
    }
    const surface = document.querySelector('[data-canvas-surface="true"]')
    surface?.addEventListener('pointerdown', handleCanvasClick)
    return () => surface?.removeEventListener('pointerdown', handleCanvasClick)
  }, [])

  const isOpen = open || navOpen


  // Canvas viewport for viewport-rect calculation
  const [canvasViewport, setCanvasViewport] = useState<{ w: number; h: number }>({
    w: window.innerWidth,
    h: window.innerHeight
  })
  useEffect(() => {
    function measure(): void {
      const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
      if (el) {
        const r = el.getBoundingClientRect()
        setCanvasViewport({ w: r.width, h: r.height })
      } else {
        setCanvasViewport({ w: window.innerWidth, h: window.innerHeight })
      }
    }
    measure()
    window.addEventListener('resize', measure)
    const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
    let ro: ResizeObserver | null = null
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    return () => {
      window.removeEventListener('resize', measure)
      if (ro) ro.disconnect()
    }
  }, [])

  // Hovering the minimap reveals a named list of everything on the desk.
  // Delayed close, because the pointer has to cross a gap to reach the list —
  // closing on the first mouseleave would make it unreachable, the same trap
  // the tidy-modes menu documents.
  const [jumpOpen, setJumpOpen] = useState(false)
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function holdJump(): void {
    if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current)
    setJumpOpen(true)
  }
  function releaseJump(): void {
    if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current)
    jumpTimer.current = setTimeout(() => setJumpOpen(false), 220)
  }
  useEffect(() => () => {
    if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current)
  }, [])

  // Centre the camera on a widget — the same arithmetic panFromPoint uses, so
  // a click in the list lands exactly where a click on the map would.
  const jumpTo = useCallback(
    (w: { x: number; y: number; width: number; height: number; pinned: boolean }) => {
      // A pinned widget is fixed to the SCREEN, not the canvas: it is already
      // in view and has no canvas position to fly to. Moving the camera would
      // scroll the desk out from under something that did not move.
      if (w.pinned) return
      const cx = w.x + w.width / 2
      const cy = w.y + w.height / 2
      setPan(canvasViewport.w / 2 - cx * zoom, canvasViewport.h / 2 - cy * zoom)
    },
    [setPan, canvasViewport.w, canvasViewport.h, zoom]
  )

  const visible = useMemo(
    () => widgets.filter((w) => !w.archived && !w.pinned && w.parentSectionId === null && w.kind !== 'minimap'),
    [widgets]
  )

  // Children indexed once per widget change. The section frames below used to
  // scan the whole widget list per section, which is quadratic on exactly the
  // desks this panel is meant to help with.
  const childrenBySection = useMemo(() => {
    const byParent = new Map<string, typeof widgets>()
    for (const w of widgets) {
      if (w.parentSectionId === null) continue
      const list = byParent.get(w.parentSectionId)
      if (list) list.push(w)
      else byParent.set(w.parentSectionId, [w])
    }
    return byParent
  }, [widgets])

  const sizeOf = useCallback(
    (w: (typeof widgets)[number]): { width: number; height: number } => {
      if (w.kind !== 'section') return { width: w.width, height: w.height }
      const fr = computeSectionFrame(childrenBySection.get(w.id) ?? [], effectiveLayout(w.layout))
      return { width: fr.width, height: fr.height }
    },
    [childrenBySection]
  )

  // What the desk contains. Deliberately not a function of the camera, so
  // panning never re-walks the widget list.
  const contentBox = useMemo(() => {
    if (visible.length === 0) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const w of visible) {
      const { width, height } = sizeOf(w)
      minX = Math.min(minX, w.x); minY = Math.min(minY, w.y)
      maxX = Math.max(maxX, w.x + width); maxY = Math.max(maxY, w.y + height)
    }
    return { minX, minY, maxX, maxY }
  }, [visible, sizeOf])

  const camera = useMemo(
    () => ({
      panX, panY, zoom,
      viewportWidth: canvasViewport.w,
      viewportHeight: canvasViewport.h
    }),
    [panX, panY, zoom, canvasViewport]
  )

  const bbox = useMemo(() => mappedBox(contentBox, camera), [contentBox, camera])
  const scale = useMemo(() => mappedScale(bbox, PANEL), [bbox])
  const viewportRect = useMemo(
    () => viewportIndicator(bbox, camera, scale, PANEL),
    [bbox, camera, scale]
  )

  const draggingRef = useRef(false)
  useEffect(() => {
    function onUp(): void { draggingRef.current = false }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  function panFromPoint(e: React.MouseEvent<SVGSVGElement>): void {
    if (!bbox) return
    const rect = e.currentTarget.getBoundingClientRect()
    const lx = e.clientX - rect.left, ly = e.clientY - rect.top
    const wx = (lx - PADDING) / scale + bbox.minX
    const wy = (ly - PADDING) / scale + bbox.minY
    setPan(canvasViewport.w / 2 - wx * zoom, canvasViewport.h / 2 - wy * zoom)
  }

  function toggleOpen(): void {
    if (open) {
      // user is closing the manually-pinned panel
      setOpen(false)
    } else if (navOpen) {
      // nav opened it — user click pins it open
      if (navTimer.current !== undefined) clearTimeout(navTimer.current)
      navTimer.current = undefined
      setNavOpen(false)
      setOpen(true)
    } else {
      setOpen(true)
    }
  }

  return (
    <div
      className="fb-floating-chrome absolute bottom-3 right-3 z-[46] pointer-events-auto"
      data-minimap-fab
      data-floating-menu
      onMouseEnter={holdJump}
      onMouseLeave={releaseJump}
    >
      {/* The named list sits ABOVE the map, positioned ABSOLUTELY rather than
          as a flex sibling.
          
          This wrapper hosts an AnimatePresence with mode="popLayout", which
          takes the exiting child out of flow and animates the entering one
          into the space it measured. Making the wrapper a flex column — the
          first version of this list — gave popLayout a second child to measure
          against, and the map was then laid out mid-screen for the whole 2.2s
          auto-open window after any zoom change, drifting back to the corner
          once the animation finished. That is the "minimap floats weirdly mid
          screen when zoom is altered" report.
          
          Out of flow, the list cannot influence that measurement at all. */}
      {jumpOpen && (
        <div className="absolute bottom-full right-0 mb-1.5">
          <DeskJumpList widgets={widgets} onJump={jumpTo} />
        </div>
      )}
      {/* mode="popLayout": exiting element leaves layout immediately so entering
          element can grow from the same corner — creates the bloom/unravel effect. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {isOpen ? (
          // Panel — blooms open from the icon's corner
          <motion.div
            key="panel"
            data-testid="minimap-fab-panel"
            initial={{ scale: 0.45, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.45, opacity: 0, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: 0.22, ease: [0.34, 1.2, 0.64, 1] }}
            style={{ width: PANEL_W, height: PANEL_H, transformOrigin: 'bottom right', borderRadius: 10 }}
            className="overflow-hidden shadow-lg ring-1 ring-black/10 dark:ring-white/10 bg-[var(--surface-sunken)] relative select-none fb-glass-chrome"
          >
            {/* Close button — top-right of panel */}
            <button
              onClick={() => { setOpen(false); setNavOpen(false) }}
              className="absolute top-1 right-1 z-10 w-4 h-4 rounded-full flex items-center justify-center text-[var(--ink-30)] hover:text-[var(--ink-80)] transition-colors"
              title="Close minimap"
            >
              <Icon name="close" size={10} />
            </button>
            {/* Zoom badge */}
            <div className="absolute top-1 left-1.5 text-[9px] font-mono text-[var(--ink-35)] pointer-events-none">
              {Math.round(zoom * 100)}%
            </div>
            {visible.length === 0 ? (
              <div className="h-full w-full flex flex-col items-center justify-center gap-1 text-[var(--ink-40)]">
                <Icon name="map" size={16} />
                <div className="text-[9px] uppercase tracking-[0.12em]">Empty canvas</div>
              </div>
            ) : (
              <svg
                aria-label="Canvas overview"
                role="img"
                width={PANEL_W}
                height={PANEL_H}
                viewBox={`0 0 ${PANEL_W} ${PANEL_H}`}
                className="block cursor-crosshair"
                onMouseDown={(e) => { e.stopPropagation(); draggingRef.current = true; panFromPoint(e) }}
                onMouseMove={(e) => { if (draggingRef.current) panFromPoint(e) }}
              >
                {bbox && visible.map((w) => {
                  const { width, height } = sizeOf(w)
                  const x = PADDING + (w.x - bbox.minX) * scale
                  const y = PADDING + (w.y - bbox.minY) * scale
                  const ww = Math.max(2, width * scale)
                  const hh = Math.max(2, height * scale)
                  if (w.kind === 'section') {
                    return (
                      <rect key={w.id} x={x} y={y} width={ww} height={hh}
                        fill="rgb(var(--accent) / 0.06)" stroke="rgb(var(--accent) / 0.30)"
                        strokeWidth={0.75} rx={2} />
                    )
                  }
                  return (
                    <foreignObject key={w.id} x={x} y={y} width={ww} height={hh}
                      style={{ overflow: 'hidden' }}>
                      <div className="h-full w-full overflow-hidden rounded-[2px] ring-1 ring-black/10 dark:ring-white/10"
                        style={{ position: 'relative' }}>
                        <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: 'none' }}>
                          <WidgetPreview widget={w} />
                        </div>
                      </div>
                    </foreignObject>
                  )
                })}
                {viewportRect && (
                  <rect
                    x={viewportRect.x} y={viewportRect.y}
                    width={viewportRect.w} height={viewportRect.h}
                    fill="rgb(var(--accent) / 0.12)" stroke="rgb(var(--accent))"
                    strokeWidth={1.25} rx={2} pointerEvents="none" />
                )}
              </svg>
            )}
          </motion.div>
        ) : (
          // Icon — materializes from the same corner as the panel shrinks to
          <motion.button
            key="icon"
            data-testid="minimap-fab-toggle"
            initial={{ scale: 0.45, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.45, opacity: 0, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: 0.18, ease: [0.34, 1.2, 0.64, 1] }}
            style={{ transformOrigin: 'bottom right' }}
            onClick={toggleOpen}
            title="Show minimap"
            className="fb-glass-chrome w-8 h-8 rounded-full flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)] transition-colors shadow-md"
          >
            <Icon name="map" size={16} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
