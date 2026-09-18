import { useCallback, useEffect, useRef, useState } from 'react'
import { initialMinimized } from '../../lib/floatingChrome'
import Icon from '../Icon'

// ── Floating menu chrome ─────────────────────────────────────────────────────
// The shared look-and-behaviour for every primary side menu in the app: the
// global Desk sidebar, the segment (Desk / People / Brain) menus, and the
// PlexiOffice menu. Instead of a full-height docked panel welded to the window
// edge with a right border, each menu is a rounded card that floats above the
// desk surface with a small inset margin and a soft elevation, and each can be
// minimised to free the whole surface for the content beside it.
//
// Everything here is token-driven (var(--surface-raised), var(--edge-soft), the
// --shadow-cast elevation, the --radius-lg corner) so the menus adapt to light,
// dark, futuristic and atelier themes without per-theme styling.

// The floating card itself. Rounded on every corner, hairline edge all round
// (no more one-sided right border), and it clips its own content so the rounded
// corners read cleanly. Callers add the elevation via FLOATING_MENU_STYLE.
// The `fb-floating-chrome` marker is a stable, non-Tailwind class used purely as
// a hit-test hook: the canvas edge-pan (useEdgePan) suppresses panning when the
// pointer is over any floating menu, so hovering a menu that overlays the canvas
// no longer pushes the desk. Keep this class on every floating chrome surface.
// The material vocabulary lives in floatingMenuStyle.ts (a plain module) so
// saving THIS file cannot force a full reload for constant consumers.
// Re-exported for existing import sites; new code imports the .ts directly.
export {
  FLOATING_MENU_ASIDE,
  FLOATING_MENU_ASIDE_SCROLL,
  FLOATING_MENU_ASIDE_GLASS,
  FLOATING_MENU_STYLE,
  FLOATING_MENU_GLASS_STYLE,
  FLOATING_MENU_INSET,
  FLOATING_MENU_INSET_RIGHT,
  SIDEBAR_MIN,
  SIDEBAR_MAX
} from './floatingMenuStyle'
import { SIDEBAR_MIN, SIDEBAR_MAX } from './floatingMenuStyle'

// Resizable main sidebar width bounds, in px, measured on the dock column
// (card + inset). The MIN is deliberately generous so a narrowed menu still has
// room for a two-line label and can never be dragged down to where text clips
export const SIDEBAR_DEFAULT = 272

const WIDTH_KEY = 'fb.sidebar.width'

function clampWidth(px: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px))
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    if (raw) {
      const n = Number(raw)
      if (Number.isFinite(n)) return clampWidth(n)
    }
  } catch {
    /* ignore */
  }
  return SIDEBAR_DEFAULT
}

// Drag-to-resize for the main sidebar. Returns the current column width, a
// setter used only by the drag handler, and a pointer-down handler to attach to
// the resize grip. The width is clamped to [MIN, MAX] and persisted so it
// survives reload. Uses pointer capture so the drag keeps tracking even when the
// cursor outruns the thin grip.
export function useSidebarWidth(): {
  width: number
  onResizeStart: (e: React.PointerEvent) => void
  nudge: (delta: number) => void
  resizing: boolean
} {
  const [width, setWidth] = useState<number>(() => loadWidth())
  const [resizing, setResizing] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      startX.current = e.clientX
      startW.current = width
      setResizing(true)
      const target = e.currentTarget as HTMLElement
      try {
        target.setPointerCapture(e.pointerId)
      } catch {
        /* not fatal — falls back to window listeners below */
      }
    },
    [width]
  )

  useEffect(() => {
    if (!resizing) return
    function onMove(e: PointerEvent): void {
      const next = clampWidth(startW.current + (e.clientX - startX.current))
      setWidth(next)
    }
    function onUp(): void {
      setResizing(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [resizing])

  // Persist whenever a drag settles.
  useEffect(() => {
    if (resizing) return
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      /* ignore */
    }
  }, [resizing, width])

  // Keyboard resize: arrow keys on the focused grip nudge the width. Persisted
  // by the effect above once the value settles.
  const nudge = useCallback((delta: number) => {
    setWidth((w) => clampWidth(w + delta))
  }, [])

  return { width, onResizeStart, nudge, resizing }
}

// Minimise / restore state for a menu, persisted per menu key so each surface
// remembers its own preference across reloads. When there is no stored
// preference the menu starts minimised on a small window so it does not cover
// the content, and open otherwise.
export function useMinimizable(
  key: string,
  opts: { responsiveBreakpoint?: number; defaultMinimized?: boolean } = {}
): { minimized: boolean; minimize: () => void; restore: () => void; toggle: () => void } {
  const breakpoint = opts.responsiveBreakpoint ?? 860
  const [minimized, setMinimized] = useState<boolean>(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(key)
    } catch {
      /* ignore */
    }
    return initialMinimized(stored, {
      breakpoint,
      defaultMinimized: opts.defaultMinimized,
      innerWidth: typeof window !== 'undefined' ? window.innerWidth : breakpoint
    })
  })

  const persist = useCallback(
    (v: boolean) => {
      setMinimized(v)
      try {
        localStorage.setItem(key, v ? '1' : '0')
      } catch {
        /* ignore */
      }
    },
    [key]
  )

  return {
    minimized,
    minimize: () => persist(true),
    restore: () => persist(false),
    toggle: () => persist(!minimized)
  }
}

// The always-visible affordance shown when a menu is minimised. A small rounded
// pill that floats over the top-left of the content area; clicking it brings the
// menu back. Positioned absolutely, so its container must be relative.
export function MenuRestorePill({
  onClick,
  label = 'Menu',
  title = 'Show the menu'
}: {
  onClick: () => void
  label?: string
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      data-testid="menu-restore-pill"
      className="fb-floating-chrome absolute top-[12px] left-[12px] z-20 inline-flex items-center gap-1.5 h-8 pl-2 pr-2.5 fb-btn-surface fb-press text-[12px] font-medium text-[var(--ink-80)] hover:text-[var(--ink-100)]"
    >
      <Icon name="menu" size={16} />
      <span>{label}</span>
    </button>
  )
}

// The minimise control that lives in a menu's header. A quiet icon button that
// collapses the menu to the restore pill.
export function MenuMinimizeButton({
  onClick,
  title = 'Minimise the menu'
}: {
  onClick: () => void
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      data-testid="menu-minimize"
      className="h-7 w-7 rounded-lg inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
    >
      <Icon name="left_panel_close" size={16} />
    </button>
  )
}
