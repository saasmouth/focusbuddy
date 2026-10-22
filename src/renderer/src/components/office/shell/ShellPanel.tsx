import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
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
  /** Take the column's remaining height (a library or long list) instead of sizing to content. */
  fill?: boolean
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

/** The DOM id of a ShellPanel; controls that toggle it set aria-controls to this. */
export const shellPanelDomId = (id: string): string => `shell-panel-${id}`

export default function ShellPanel({ id, title, icon, open, onClose, width, fill, pinnable, pinned = false, onPinnedChange, onRectChange, returnFocus, ignoreOutside, children, testid }: ShellPanelProps): JSX.Element | null {
  const ref = useRef<HTMLElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const { sheetPanels, raise } = useShellSize()
  // Opening a panel brings the panels layer to the front (sheets, SPEC §2.6). A
  // LAYOUT effect, so the raise re-renders before the first paint: as a passive
  // effect there was a frame (longer under load) in which the new panel was
  // drawn under the side pane, and a click there landed on the pane.
  useLayoutEffect(() => {
    if (open) raise('panels')
  }, [open, raise])

  useEffect(() => {
    if (open) opener.current = document.activeElement as HTMLElement | null
  }, [open])

  // Report the rect while pinned (and nothing otherwise). The latest callback is
  // read through a ref, so a host passing an inline arrow does not re-run this
  // effect every render: its cleanup reports null, and a host that keeps the
  // inset in state would otherwise loop (null → re-render → rect → re-render).
  const rectCb = useRef(onRectChange)
  rectCb.current = onRectChange
  const reports = !!onRectChange
  useEffect(() => {
    if (!reports) return
    const el = ref.current
    if (!open || !pinned || !el) {
      rectCb.current?.(null)
      return
    }
    const report = (): void => rectCb.current?.(el.getBoundingClientRect())
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => {
      ro.disconnect()
      rectCb.current?.(null)
    }
  }, [open, pinned, reports])

  // Unpinned panels close on a pointer press outside them.
  useEffect(() => {
    if (!open || pinned) return
    const down = (e: PointerEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      // A control that toggles this panel (aria-controls) handles its own click;
      // closing here too would make that click reopen the panel.
      if ((t as Element).closest?.(`[aria-controls="${shellPanelDomId(id)}"]`)) return
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
      id={shellPanelDomId(id)}
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
      className={`pointer-events-auto fb-glass-panel rounded-[var(--radius-row)] shadow-lg flex flex-col min-h-0 ${sheetPanels || fill ? 'flex-1' : 'max-h-full'}`}
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
