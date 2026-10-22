import { useEffect, useRef, type ReactNode } from 'react'
import Icon from '../../Icon'
import { useShellSize } from './OfficeShellLayout'

// An overlay panel (spec §2.4): Layers, Library, Swatches, AI, data forms. It
// replaces every right column (owner D1). It lives in the shell's panel column
// beside the rail, floats over the canvas, and is pinnable. While pinned it
// reports its rect so the host can inset the viewport (Fit, zoom-to-selection).
// Esc while focus is inside closes an unpinned panel and returns focus (to the
// canvas, via returnFocus, or the opener). No global key listener: the only
// document listener is a pointer-outside close, present only while an
// UNPINNED panel is open.

export interface ShellPanelProps {
  id: string
  title: string
  icon?: string
  open: boolean
  onClose: () => void
  width?: number
  pinnable?: boolean
  pinned?: boolean
  onPinnedChange?: (v: boolean) => void
  onRectChange?: (rect: DOMRect | null) => void
  returnFocus?: () => void
  /** Elements that must not count as "outside" (e.g. the rail button that toggles this panel). */
  ignoreOutside?: () => (HTMLElement | null)[]
  children: ReactNode
  testid: string
}

export default function ShellPanel({ id, title, icon, open, onClose, width, pinnable, pinned = false, onPinnedChange, onRectChange, returnFocus, ignoreOutside, children, testid }: ShellPanelProps): JSX.Element | null {
  const ref = useRef<HTMLElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const { sheetPanels } = useShellSize()

  useEffect(() => {
    if (open) opener.current = document.activeElement as HTMLElement | null
  }, [open])

  // Report the rect while pinned (and nothing otherwise).
  useEffect(() => {
    if (!onRectChange) return
    const el = ref.current
    if (!open || !pinned || !el) {
      onRectChange(null)
      return
    }
    const report = (): void => onRectChange(el.getBoundingClientRect())
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => {
      ro.disconnect()
      onRectChange(null)
    }
  }, [open, pinned, onRectChange])

  // Unpinned panels close on a pointer press outside them.
  useEffect(() => {
    if (!open || pinned) return
    const down = (e: PointerEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (ignoreOutside?.().some((el) => el?.contains(t))) return
      onClose()
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [open, pinned, onClose, ignoreOutside])

  if (!open) return null
  const close = (): void => {
    onClose()
    if (returnFocus) returnFocus()
    else opener.current?.focus?.()
  }
  return (
    <section
      ref={ref}
      role="dialog"
      aria-modal={false}
      aria-label={title}
      data-testid={testid}
      data-panel-id={id}
      data-pinned={pinned ? 'true' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pinned) {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
      className={`pointer-events-auto fb-glass-panel rounded-[var(--radius-row)] shadow-lg flex flex-col min-h-0 ${sheetPanels ? 'flex-1' : 'max-h-full'}`}
      style={!sheetPanels && width ? { width } : undefined}
    >
      <header className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--edge-soft)]">
        {icon && <Icon name={icon} size={15} className="text-[var(--ink-60)]" />}
        <span className="flex-1 min-w-0 text-[12px] font-semibold text-[var(--ink-90)] truncate">{title}</span>
        {pinnable && (
          <button
            type="button"
            aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
            aria-pressed={pinned}
            data-testid={`${testid}-pin`}
            onClick={() => onPinnedChange?.(!pinned)}
            className={`icon-btn !h-6 !w-6 ${pinned ? 'text-accent' : ''}`}
          >
            <Icon name="push_pin" size={14} filled={pinned} />
          </button>
        )}
        <button type="button" aria-label={`Close ${title}`} data-testid={`${testid}-close`} onClick={close} className="icon-btn !h-6 !w-6">
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  )
}
