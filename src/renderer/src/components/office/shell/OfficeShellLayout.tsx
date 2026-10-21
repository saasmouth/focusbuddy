import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import Icon from '../../Icon'
import { ASIDE_COLLAPSE_BELOW, PANEL_SHEET_BELOW, PANEL_WIDTH } from './layout'

// The office shell frame (spec §1, §2.4, §2.6): ContextBar on top, ToolRail on
// the left, an optional navigator (Deck thumbnails), the canvas, an optional
// bottom strip, and the overlay-panel column that floats over the canvas's left
// edge. No right column exists (owner D1). The frame measures ITSELF (never the
// window), so a desk widget gets the same narrow behaviour as a full editor.

interface ShellSize {
  width: number
  height: number
  sheetPanels: boolean
}
const ShellSizeContext = createContext<ShellSize>({ width: Infinity, height: Infinity, sheetPanels: false })
export const useShellSize = (): ShellSize => useContext(ShellSizeContext)

export interface OfficeShellLayoutProps {
  bar: ReactNode
  rail: ReactNode
  children: ReactNode
  leftAside?: ReactNode
  asideLabel?: string
  bottom?: ReactNode
  panels?: ReactNode
  testid: string
}

export default function OfficeShellLayout({ bar, rail, children, leftAside, asideLabel = 'Navigator', bottom, panels, testid }: OfficeShellLayoutProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: Infinity, height: Infinity })
  const [asideOpen, setAsideOpen] = useState(false)
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]!.contentRect
      setSize({ width: r.width, height: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const asideCollapsed = !!leftAside && size.width < ASIDE_COLLAPSE_BELOW
  const ctx: ShellSize = { ...size, sheetPanels: size.width < PANEL_SHEET_BELOW }
  return (
    <ShellSizeContext.Provider value={ctx}>
      <div ref={root} data-testid={testid} className="h-full min-h-0 flex flex-col">
        {bar}
        <div className="flex-1 min-h-0 flex">
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
            {bottom}
            {/* Overlay panels: one column beside the rail (spec §2.4). Pointer
                events only on the panels themselves, so the canvas stays usable. */}
            {panels && (
              <div
                data-testid={`${testid}-panels`}
                className={`absolute z-30 pointer-events-none flex flex-col gap-2 ${ctx.sheetPanels ? 'inset-0' : 'top-2 left-2 bottom-2'}`}
                style={ctx.sheetPanels ? undefined : { width: `min(${PANEL_WIDTH}px, calc(100% - 16px))` }}
              >
                {panels}
              </div>
            )}
          </div>
        </div>
      </div>
    </ShellSizeContext.Provider>
  )
}
