// Files as a floating panel inside the window (owner, Q5: in-app now, a real
// separate window later).
//
// - Portalled to the END of document.body: Electron folds drag regions in
//   document order and the last one wins, so the panel's no-drag must come
//   after the header's. Its root is titlebar-nodrag.
// - Moved by its header with pointer events; its top edge is clamped below the
//   40px header, so it can never sit in the titlebar drag region.
// - Resizable from its edges and corners, min 260 × 280.
// - Dock button, and dragging the header to within 24px of the left edge
//   offers the dock (a snap preview) and docks on release.
// - Default position: top right, under the header, away from the bottom
//   corners where the feature-spotlight and local-AI cards take clicks.
// - z-index 215: above desk chrome, below dialogs, the notice toast and the
//   onboarding cards.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import FilesPanel from './FilesPanel'
import { useFilesPanelStore, isFilesFullScreen } from '../../stores/filesPanel'
import { useViewStore } from '../../stores/view'
import { FLOAT_MIN_H, FLOAT_MIN_W, type FloatRect } from '../../lib/filesPanelPrefs'

export const HEADER_BOTTOM = 40
const MARGIN = 8
const SNAP_PX = 24

/** Keep the float on screen and out of the title bar. */
export function clampFloatRect(r: FloatRect, vw: number, vh: number): FloatRect {
  const w = Math.max(FLOAT_MIN_W, Math.min(r.w, vw - MARGIN * 2))
  const h = Math.max(FLOAT_MIN_H, Math.min(r.h, vh - HEADER_BOTTOM - MARGIN * 2))
  const x = Math.max(MARGIN, Math.min(r.x, vw - w - MARGIN))
  const y = Math.max(HEADER_BOTTOM + MARGIN, Math.min(r.y, vh - h - MARGIN))
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

export function defaultFloatRect(vw: number, vh: number): FloatRect {
  const w = 320
  const h = Math.min(520, vh - HEADER_BOTTOM - 120)
  return clampFloatRect({ x: vw - w - 24, y: HEADER_BOTTOM + 16, w, h }, vw, vh)
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export default function FilesFloat(): JSX.Element | null {
  const open = useFilesPanelStore((s) => s.open)
  const fullScreen = useViewStore((s) => isFilesFullScreen(s.view as { kind: string; app?: string }))
  const mode = useFilesPanelStore((s) => s.mode)
  const saved = useFilesPanelStore((s) => s.float)
  const setFloatRect = useFilesPanelStore((s) => s.setFloatRect)
  const openBeside = useFilesPanelStore((s) => s.openBeside)
  const close = useFilesPanelStore((s) => s.close)
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [live, setLive] = useState<FloatRect | null>(null)
  const [snap, setSnap] = useState(false)
  const gesture = useRef<{ kind: 'move' | Edge; sx: number; sy: number; start: FloatRect } | null>(null)

  useEffect(() => {
    const onResize = (): void => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (fullScreen || !open || mode !== 'float') return null

  const rect = clampFloatRect(live ?? saved ?? defaultFloatRect(vp.w, vp.h), vp.w, vp.h)

  const begin = (kind: 'move' | Edge) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('input, [role="menu"]')) return
    const el = e.currentTarget
    // The header is mostly buttons (the folder path fills it). A press there
    // stays a click until the pointer travels 4px; only then does it become a
    // move, so every header button still clicks.
    if (kind === 'move' && target.closest('button')) {
      const sx = e.clientX
      const sy = e.clientY
      const pid = e.pointerId
      const watch = (ev: PointerEvent): void => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
        cancel()
        el.setPointerCapture(pid)
        start(sx, sy)
      }
      const cancel = (): void => {
        window.removeEventListener('pointermove', watch)
        window.removeEventListener('pointerup', cancel)
      }
      window.addEventListener('pointermove', watch)
      window.addEventListener('pointerup', cancel)
      return
    }
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    start(e.clientX, e.clientY)
    function start(sx: number, sy: number): void {
      gesture.current = { kind, sx, sy, start: rect }
      arm()
    }
    function arm(): void {
    const move = (ev: PointerEvent): void => {
      const g = gesture.current
      if (!g) return
      const dx = ev.clientX - g.sx
      const dy = ev.clientY - g.sy
      const s = g.start
      let next: FloatRect
      if (g.kind === 'move') {
        next = { ...s, x: s.x + dx, y: s.y + dy }
        setSnap(ev.clientX <= SNAP_PX)
      } else {
        let { x, y, w, h } = s
        if (g.kind.includes('e')) w = s.w + dx
        if (g.kind.includes('s')) h = s.h + dy
        if (g.kind.includes('w')) {
          w = Math.max(FLOAT_MIN_W, s.w - dx)
          x = s.x + (s.w - w)
        }
        if (g.kind.includes('n')) {
          h = Math.max(FLOAT_MIN_H, s.h - dy)
          y = s.y + (s.h - h)
        }
        next = { x, y, w, h }
      }
      setLive(clampFloatRect(next, window.innerWidth, window.innerHeight))
    }
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      const g = gesture.current
      gesture.current = null
      setLive((cur) => {
        if (cur) setFloatRect(cur)
        return null
      })
      setSnap(false)
      if (g?.kind === 'move' && ev.clientX <= SNAP_PX) openBeside()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    }
  }

  const handle = (edge: Edge, cls: string, cursor: string): JSX.Element => (
    <div
      key={edge}
      onPointerDown={begin(edge)}
      data-testid={`files-float-resize-${edge}`}
      className={`absolute ${cls} touch-none`}
      style={{ cursor }}
    />
  )

  return createPortal(
    <>
      {snap && (
        <div
          aria-hidden="true"
          data-testid="files-float-snap"
          className="fixed z-[214] left-[10px] w-[320px] rounded-[var(--radius-card)] border-2 border-dashed border-[rgb(var(--accent)/0.6)] bg-[rgb(var(--accent)/0.08)] pointer-events-none"
          style={{ top: HEADER_BOTTOM + 10, bottom: 10 }}
        />
      )}
      <div
        className="titlebar-nodrag fb-floating-chrome fixed z-[215] flex flex-col rounded-[var(--radius-card)] bg-[var(--surface-raised)] overflow-hidden"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          boxShadow: '0 0 0 1px var(--edge-soft), 0 22px 56px -14px rgba(0,0,0,0.42), 0 6px 18px -6px rgba(0,0,0,0.24), var(--shadow-inset-highlight)'
        }}
        data-testid="files-float"
        role="dialog"
        aria-modal="false"
        aria-label="Files"
      >
        <FilesPanel
          host="float"
          onClose={close}
          headerProps={{ onPointerDown: begin('move'), className: 'cursor-grab active:cursor-grabbing', title: 'Drag to move. Drag to the left edge to dock.' }}
        />
        {handle('e', 'top-2 right-0 bottom-2 w-1.5', 'ew-resize')}
        {handle('w', 'top-2 left-0 bottom-2 w-1.5', 'ew-resize')}
        {handle('s', 'left-2 right-2 bottom-0 h-1.5', 'ns-resize')}
        {handle('n', 'left-2 right-2 top-0 h-1', 'ns-resize')}
        {handle('se', 'right-0 bottom-0 w-3 h-3', 'nwse-resize')}
        {handle('sw', 'left-0 bottom-0 w-3 h-3', 'nesw-resize')}
        {handle('ne', 'right-0 top-0 w-3 h-2', 'nesw-resize')}
        {handle('nw', 'left-0 top-0 w-3 h-2', 'nwse-resize')}
      </div>
    </>,
    document.body
  )
}
