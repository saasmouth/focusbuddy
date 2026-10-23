// The "…" at the end of a narrow work widget's header (lib/widgetHeaderActions).
//
// It carries the header tools that did not fit, with the same labels, icons and
// handlers as their header buttons. Like the pin and expand pickers it is
// portalled into document.body so a neighbouring widget's z-index cannot cover
// it; React still routes its events through WidgetFrame's tree, which is how
// the frame's one modifier-click guard covers these items too.
//
// A menu in the WAI-ARIA sense: the trigger says it has one and whether it is
// open, opening it moves focus to the first item, arrow keys / Home / End move
// between items, Escape closes it and gives focus back to the trigger, and Tab
// closes it.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon'

export interface OverflowItem {
  id: string
  /** Visible text — the header button's label. */
  label: string
  /** Accessible name when it says more than the visible text (it always contains it). */
  ariaLabel?: string
  title?: string
  icon: string
  iconFilled?: boolean
  /** The header button's own handler. Pickers (pin, expand) open anchored to "…". */
  onSelect: () => void
  testId?: string
}

interface Props {
  widgetId: string
  items: OverflowItem[]
  open: boolean
  setOpen: (v: boolean) => void
  /** Shared with the pickers, which anchor to "…" when their own button is folded. */
  triggerRef: RefObject<HTMLButtonElement>
  /** Called before toggling, so another open picker closes first. */
  onBeforeToggle?: () => void
}

export default function WidgetHeaderOverflow({
  widgetId,
  items,
  open,
  setOpen,
  triggerRef,
  onBeforeToggle
}: Props): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Below "…" by default; above it when the window has no room below (a work
  // widget pinned to a bottom corner, or one near the bottom of the desk).
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    function onViewChange(): void {
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onViewChange)
    window.addEventListener('scroll', onViewChange, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onViewChange)
      window.removeEventListener('scroll', onViewChange, true)
    }
  }, [open, setOpen, triggerRef])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPos(null)
      return
    }
    const r = triggerRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
  }, [open, triggerRef])

  // Once the menu has a height, flip it above "…" if it would run off the
  // bottom of the window and there is more room above. Layout effect, so the
  // flip happens before paint.
  useLayoutEffect(() => {
    const menu = menuRef.current
    const trigger = triggerRef.current
    if (!open || !pos || pos.top === undefined || !menu || !trigger) return
    const r = trigger.getBoundingClientRect()
    const h = menu.getBoundingClientRect().height
    const roomBelow = window.innerHeight - r.bottom - 6
    const roomAbove = r.top - 6
    if (h > roomBelow - 8 && roomAbove > roomBelow) {
      setPos({ bottom: window.innerHeight - r.top + 6, right: window.innerWidth - r.right })
    }
  }, [open, pos, triggerRef])

  // Focus the first item once the menu is on screen.
  useEffect(() => {
    if (!open || !pos) return
    menuItems(menuRef.current)[0]?.focus()
  }, [open, pos])

  function close(refocus: boolean): void {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  function onMenuKey(e: React.KeyboardEvent): void {
    const list = menuItems(menuRef.current)
    if (!list.length) return
    const at = list.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (at + 1) % list.length
    else if (e.key === 'ArrowUp') next = (at - 1 + list.length) % list.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    } else if (e.key === 'Tab') {
      close(false)
      return
    }
    if (next >= 0) {
      e.preventDefault()
      e.stopPropagation()
      list[next]?.focus()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onBeforeToggle?.()
          setOpen(!open)
        }}
        className="widget-nodrag h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-50)] hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] hover:text-[var(--ink-100)] aria-expanded:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] aria-expanded:text-[var(--ink-100)] transition-colors"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        data-testid={`widget-overflow-${widgetId}`}
      >
        <Icon name="more_horiz" size={14} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="More work widget actions"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onMenuKey}
            className="fixed z-[200] min-w-[184px] max-w-[260px] rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1 cursor-default"
            style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            data-placement={pos.bottom !== undefined ? 'above' : 'below'}
            data-testid={`widget-overflow-menu-${widgetId}`}
          >
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  it.onSelect()
                }}
                aria-label={it.ariaLabel}
                title={it.title}
                data-testid={it.testId}
                data-action={it.id}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[12px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] focus-visible:bg-[var(--surface-sunken)] focus:outline-none"
              >
                <Icon name={it.icon} size={14} filled={it.iconFilled} className="text-[var(--ink-50)] shrink-0" />
                <span className="truncate">{it.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

function menuItems(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]')) : []
}
