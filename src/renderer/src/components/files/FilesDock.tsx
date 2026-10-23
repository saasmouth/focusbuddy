// Files beside your work, on the LEFT, flying out of the side menu (owner,
// Q1: "Make it on the left, and fly out from the existing side menu so it's
// easy to drag and drop from Files to desk to documents, files, widgets or
// tools").
//
// Two pieces:
//
//   FilesDockSlot  sits right after whichever side menu is showing (the desk
//                  sidebar, the PlexiiOffice menu, a segment menu). It says
//                  where the flyout docks, and when the panel is PINNED it
//                  reserves the panel's width, so the content (the office
//                  shell's tool rail included) moves right.
//   FilesFlyout    the panel itself, rendered once for the whole app and
//                  positioned at the live slot. Unpinned it OVERLAYS the
//                  content with a clear edge and shadow, so nothing under it
//                  moves while you drag out of it. Pinned it sits in the space
//                  the slot reserved.
//
// The flyout is fixed-position below the 40px header, so none of its controls
// can sit in a window drag region; its root still carries titlebar-nodrag as a
// defence (memory: titlebar drag regions eat clicks).
//
// Too narrow to pin (the content would be under FILES_PANEL_MIN_CONTENT): it
// stays a flyout over the content, marked as a sheet, and while a drag leaves
// it the sheet goes see-through and click-through so the target beneath can
// take the drop. It is never unmounted mid-drag (Chromium loses dragend).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import FilesPanel from './FilesPanel'
import { useFilesPanelStore, isFilesFullScreen } from '../../stores/filesPanel'
import { useViewStore } from '../../stores/view'
import {
  FILES_PANEL_DEFAULT_W,
  FILES_PANEL_MAX_SHARE,
  FILES_PANEL_MAX_W,
  FILES_PANEL_MIN_CONTENT,
  FILES_PANEL_MIN_W,
  clampPanelWidth
} from '../../lib/filesPanelPrefs'

/** The gap between the panel and the content it pushes over when pinned. */
export const FILES_DOCK_GAP = 8
/** The inset from the top and bottom of the content row, matching the side menu's card. */
const INSET_Y = 10

let slotSeq = 0

/** The width a pinned panel reserves, given the room there is (0 = it cannot pin here). */
export function reservedWidth(s: {
  open: boolean
  mode: 'beside' | 'float'
  pinned: boolean
  width: number
  anchor: { left: number; contentRight: number } | null
}): number {
  if (!s.open || s.mode !== 'beside' || !s.pinned || !s.anchor) return 0
  const room = s.anchor.contentRight - s.anchor.left
  const w = clampPanelWidth(s.width, room)
  return room - (w + FILES_DOCK_GAP) >= FILES_PANEL_MIN_CONTENT ? w + FILES_DOCK_GAP : 0
}

export function FilesDockSlot({
  overCanvas = false,
  belowPill = false
}: {
  /** The full-bleed desk: the menu floats over the canvas, and so does the panel. */
  overCanvas?: boolean
  /** The side menu is minimised to its restore pill (top left): start below it. */
  belowPill?: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [id] = useState(() => ++slotSeq)
  const reserved = useFilesPanelStore((s) => reservedWidth(s))

  const publish = useCallback(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const parent = el.parentElement
    const row = parent?.getBoundingClientRect()
    // The row's content edge: a docked meeting or the assistant sidebar pads <main>.
    const padRight = parent ? parseFloat(getComputedStyle(parent).paddingRight) || 0 : 0
    useFilesPanelStore.getState().setAnchor({
      left: Math.round(r.left),
      top: Math.round(r.top) + (belowPill ? 44 : 0),
      bottom: Math.round(r.bottom),
      contentRight: Math.round((row?.right ?? window.innerWidth) - padRight),
      overCanvas
    })
    slotOwner = id
  }, [belowPill, overCanvas, id])

  useLayoutEffect(() => {
    publish()
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => publish())
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    if (el.previousElementSibling) ro.observe(el.previousElementSibling)
    window.addEventListener('resize', publish)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', publish)
      if (slotOwner === id) {
        slotOwner = null
        useFilesPanelStore.getState().setAnchor(null)
      }
    }
  }, [publish, id])

  // The side menu animates its width when collapsing; follow it to the end.
  useEffect(() => {
    let raf = 0
    let frames = 0
    const tick = (): void => {
      publish()
      if (++frames < 20) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [publish, reserved])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="files-dock-slot"
      data-reserved={reserved}
      className="shrink-0 h-full transition-[width] duration-150 ease-out motion-reduce:transition-none"
      style={{ width: reserved }}
    />
  )
}
let slotOwner: number | null = null

export function FilesFlyout(): JSX.Element | null {
  const open = useFilesPanelStore((s) => s.open)
  const fullScreen = useViewStore((s) => isFilesFullScreen(s.view as { kind: string; app?: string }))
  const mode = useFilesPanelStore((s) => s.mode)
  const pinnedPref = useFilesPanelStore((s) => s.pinned)
  const widthPref = useFilesPanelStore((s) => s.width)
  const anchor = useFilesPanelStore((s) => s.anchor)
  const dragging = useFilesPanelStore((s) => s.dragging)
  const reserved = useFilesPanelStore((s) => reservedWidth(s))
  const close = useFilesPanelStore((s) => s.close)
  const setWidth = useFilesPanelStore((s) => s.setWidth)
  const [liveW, setLiveW] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)

  if (fullScreen || !open || mode !== 'beside' || !anchor) return null

  const room = anchor.contentRight - anchor.left
  const maxW = Math.max(FILES_PANEL_MIN_W, Math.min(FILES_PANEL_MAX_W, Math.floor(room * FILES_PANEL_MAX_SHARE)))
  // Pinned but too narrow to reserve its width: a sheet over the content.
  const sheet = pinnedPref && reserved === 0
  const docked = reserved > 0
  const w = Math.min(liveW ?? clampPanelWidth(widthPref, room), sheet ? Math.max(FILES_PANEL_MIN_W, room - 16) : maxW)

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = w
    setResizing(true)
    const move = (ev: PointerEvent): void => setLiveW(Math.max(FILES_PANEL_MIN_W, Math.min(maxW, Math.round(startW + ev.clientX - startX))))
    const up = (ev: PointerEvent): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      setResizing(false)
      setLiveW(null)
      setWidth(Math.max(FILES_PANEL_MIN_W, Math.min(maxW, Math.round(startW + ev.clientX - startX))))
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const style: React.CSSProperties = {
    left: anchor.left + (docked ? 0 : 2),
    top: anchor.top + INSET_Y,
    height: Math.max(200, anchor.bottom - anchor.top - INSET_Y * 2),
    width: w,
    // The panel's own material: the menu's hairline + cast shadow when pinned;
    // unpinned it floats OVER content, so it gets a firmer edge and a deeper
    // shadow, and never reads as part of whatever it covers (the office rail).
    boxShadow: docked
      ? '0 0 0 1px var(--edge-hairline), var(--shadow-cast), var(--shadow-inset-highlight)'
      : '0 0 0 1px var(--edge-firm), 0 18px 48px -12px rgba(0,0,0,0.38), 0 6px 16px -6px rgba(0,0,0,0.22), var(--shadow-inset-highlight)'
  }

  return createPortal(
    <div
      className={`titlebar-nodrag fb-floating-chrome fixed z-[95] flex rounded-[var(--radius-card)] bg-[var(--surface-raised)] overflow-hidden transition-opacity duration-100 ${
        sheet && dragging ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
      style={style}
      data-testid="files-flyout"
      data-pinned={docked ? 'true' : 'false'}
      data-sheet={sheet ? 'true' : 'false'}
      data-over-canvas={anchor.overCanvas ? 'true' : 'false'}
      role="complementary"
      aria-label="Files"
    >
      <div className="flex-1 min-w-0 min-h-0">
        <FilesPanel host="flyout" onClose={close} />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Files"
        aria-valuemin={FILES_PANEL_MIN_W}
        aria-valuemax={maxW}
        aria-valuenow={w}
        aria-valuetext={`${w} pixels wide`}
        tabIndex={0}
        data-files-panel-control=""
        data-testid="files-panel-resize"
        title="Drag to resize. Double-click to reset."
        onPointerDown={onResizeStart}
        onDoubleClick={() => setWidth(FILES_PANEL_DEFAULT_W)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            setWidth(Math.max(FILES_PANEL_MIN_W, Math.min(maxW, w + (e.key === 'ArrowRight' ? 16 : -16))))
          } else if (e.key === 'Home') {
            e.preventDefault()
            setWidth(FILES_PANEL_MIN_W)
          } else if (e.key === 'End') {
            e.preventDefault()
            setWidth(maxW)
          }
        }}
        className="group absolute top-0 right-0 h-full w-2 flex items-center justify-center cursor-col-resize outline-none touch-none"
      >
        <span
          className={`h-10 w-[3px] rounded-full transition-colors ${
            resizing ? 'bg-[rgb(var(--accent))]' : 'bg-transparent group-hover:bg-[rgb(var(--accent)/0.5)] group-focus-visible:bg-[rgb(var(--accent))]'
          }`}
        />
      </div>
    </div>,
    document.body
  )
}
