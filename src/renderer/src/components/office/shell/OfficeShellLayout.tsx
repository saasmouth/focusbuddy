import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import Icon from '../../Icon'
import { ASIDE_COLLAPSE_BELOW, PANEL_SHEET_BELOW, PANEL_WIDTH } from './layout'

// The office shell frame (spec §1, §2.4, §2.6): ContextBar on top, ToolRail on
// the left, an optional navigator (Deck thumbnails), the canvas, an optional
// bottom strip, the overlay-panel column that floats over the canvas's left
// edge, and the ONE right content pane (ShellSidePane: comments, outline, AI;
// never a property inspector, owner D1 as amended). The frame measures ITSELF
// (never the window), so a desk widget gets the same narrow behaviour as a full
// editor.

interface ShellSize {
  width: number
  height: number
  sheetPanels: boolean
  /** The shell reaches the window's bottom-right corner, where the Plexii pill floats; corner content keeps clear of it. */
  pillCorner: boolean
  /**
   * Below PANEL_SHEET_BELOW an overlay panel and the side pane both cover the
   * canvas as sheets. Whichever opened last is on top, so its close button is
   * reachable (a side pane over a panel left the panel's close unclickable in a
   * 480px widget). Panels and the side pane call this when they open.
   */
  raise: (layer: 'panels' | 'side') => void
}
const ShellSizeContext = createContext<ShellSize>({ width: Infinity, height: Infinity, sheetPanels: false, pillCorner: false, raise: () => {} })

// The Plexii pill (AssistantOverlay) floats 14px right of the window edge and
// within ~120px of its bottom. It publishes --fb-pill-clear-right and
// --fb-corner-stack-bottom only while it shows, so padding with them is zero
// when it is hidden. A shell whose box ends there (a full editor, not a desk
// widget) pads its bottom strip and side pane by those variables.
const PILL_CORNER_REACH = 160
const reachesPillCorner = (el: HTMLElement): boolean => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.right >= window.innerWidth - 2 && r.bottom >= window.innerHeight - PILL_CORNER_REACH
}
export const useShellSize = (): ShellSize => useContext(ShellSizeContext)

export interface OfficeShellLayoutProps {
  bar: ReactNode
  rail: ReactNode
  children: ReactNode
  leftAside?: ReactNode
  asideLabel?: string
  bottom?: ReactNode
  panels?: ReactNode
  /** The ONE right content pane (<ShellSidePane>): comments, outline, AI. Never a property inspector. */
  rightPane?: ReactNode
  testid: string
}

export default function OfficeShellLayout({ bar, rail, children, leftAside, asideLabel = 'Navigator', bottom, panels, rightPane, testid }: OfficeShellLayoutProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number; pillCorner: boolean }>({ width: Infinity, height: Infinity, pillCorner: false })
  const [asideOpen, setAsideOpen] = useState(false)
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]!.contentRect
      setSize({ width: r.width, height: r.height, pillCorner: reachesPillCorner(el) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [front, setFront] = useState<'panels' | 'side' | null>(null)
  const raise = useCallback((layer: 'panels' | 'side') => setFront((f) => (f === layer ? f : layer)), [])
  const asideCollapsed = !!leftAside && size.width < ASIDE_COLLAPSE_BELOW
  const ctx: ShellSize = { ...size, sheetPanels: size.width < PANEL_SHEET_BELOW, raise }
  return (
    <ShellSizeContext.Provider value={ctx}>
      <div ref={root} data-testid={testid} className="h-full min-h-0 flex flex-col">
        {bar}
        <div className="relative flex-1 min-h-0 flex">
          {rail}
          {leftAside && !asideCollapsed && <div className="shrink-0 h-full min-h-0 border-r border-[var(--edge-soft)]">{leftAside}</div>}
          <div className="relative flex-1 min-w-0 min-h-0 flex flex-col" data-testid={`${testid}-main`}>
            {asideCollapsed && (
              <button
                type="button"
                aria-label={asideOpen ? `Hide ${asideLabel}` : `Show ${asideLabel}`}
                aria-expanded={asideOpen}
                data-testid={`${testid}-aside-toggle`}
                onClick={() => setAsideOpen((v) => !v)}
                className="absolute top-2 left-2 z-20 icon-btn !h-7 !w-7 fb-glass-panel"
              >
                <Icon name="view_sidebar" size={16} />
              </button>
            )}
            {asideCollapsed && asideOpen && <div className="absolute inset-y-0 left-0 z-20 fb-glass-panel border-r border-[var(--edge-soft)]">{leftAside}</div>}
            <div className="relative flex-1 min-h-0">{children}</div>
            {bottom && (
              <div className="shrink-0" data-pill-clear={size.pillCorner || undefined} style={size.pillCorner ? { paddingRight: 'var(--fb-pill-clear-right, 0px)' } : undefined}>
                {bottom}
              </div>
            )}
            {/* Overlay panels: one column beside the rail (spec §2.4). Pointer
                events only on the panels themselves, so the canvas stays usable. */}
            {panels && (
              <div
                data-testid={`${testid}-panels`}
                data-front={ctx.sheetPanels && front === 'panels' ? 'true' : undefined}
                // As sheets, a panel opened after the side pane sits above it (the pane is z-40).
                className={`absolute ${ctx.sheetPanels && front === 'panels' ? 'z-50' : 'z-30'} pointer-events-none flex flex-col gap-2 ${ctx.sheetPanels ? 'inset-0' : 'top-2 left-2 bottom-2'}`}
                style={ctx.sheetPanels ? undefined : { width: `min(${PANEL_WIDTH}px, calc(100% - 16px))` }}
              >
                {panels}
              </div>
            )}
          </div>
          {rightPane}
        </div>
      </div>
    </ShellSizeContext.Provider>
  )
}
