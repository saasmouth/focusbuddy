import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import PlexiiIcon from './PlexiiIcon'
import type { EntityRef } from '../lib/plexiiIconMap'
import { useMenuOverlay } from '../lib/useMenuOverlay'
import { collectMenuRects, resolvePosition } from '../lib/floatingChrome'

export interface CtxMenuItem {
  label?: string
  icon?: string
  /** The entity the item adds or opens: drawn with its Plexii icon, `icon` as fallback. */
  entity?: EntityRef
  shortcut?: string
  separator?: boolean
  disabled?: boolean
  onClick?: () => void
  children?: CtxMenuItem[]
  /** A data-testid for the item's button. */
  testid?: string
}

interface Props {
  x: number
  y: number
  items: CtxMenuItem[]
  onClose: () => void
}

// The menu is fully keyboard navigable. Open it and the panel takes focus;
// arrow keys move the highlight, type-ahead jumps to a label, Enter or the
// right arrow opens a submenu and moves focus into it, the left arrow or Escape
// steps back out, and Escape on the root closes everything. Mouse and hover
// behave exactly as before.
export default function CanvasContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  // Keep the latest onClose in a ref so the dismiss listener can be attached
  // ONCE and never re-armed. Depending on `onClose` (a fresh arrow on every
  // parent render) used to reset the 50ms arm on each re-render, so the
  // mousedown listener could fail to attach at all — that is why clicking
  // outside did not dismiss the menu, and why a second right-click stacked a new
  // menu on top of the old one instead of replacing it.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    function onMouseDown(e: MouseEvent): void {
      // Ignore the right button: a right-click elsewhere is about to open/move a
      // menu, and that flow replaces this one. Closing here would race the
      // re-open and leave nothing. Left/middle clicks outside dismiss.
      if (e.button === 2) return
      const target = e.target as Element | null
      if (target && !target.closest('[data-canvas-ctx-menu]')) onCloseRef.current()
    }
    // Small delay so the right-click that just opened the menu isn't caught.
    const armId = window.setTimeout(() => window.addEventListener('mousedown', onMouseDown), 50)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.clearTimeout(armId)
    }
  }, [])

  return <MenuPanel items={items} x={x} y={y} onClose={onClose} isRoot autoFocus />
}

interface PanelProps {
  items: CtxMenuItem[]
  x: number
  y: number
  onClose: () => void
  isRoot: boolean
  autoFocus: boolean
  // Called when this submenu wants to hand focus back to its parent (Left arrow).
  onStepOut?: () => void
  // Hover bridging between a parent row and this submenu.
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}

function MenuPanel({
  items,
  x,
  y,
  onClose,
  isRoot,
  autoFocus,
  onStepOut,
  onPointerEnter,
  onPointerLeave
}: PanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  const [pos, setPos] = useState({ left: x, top: y })
  const [active, setActive] = useState<number>(-1)
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [openByKeyboard, setOpenByKeyboard] = useState(false)
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)
  const closeTimer = useRef<number | null>(null)
  const typeBuf = useRef('')
  const typeTimer = useRef<number | null>(null)

  function isNav(i: number): boolean {
    const it = items[i]
    return !!it && !it.separator && !it.disabled
  }
  function navIndices(): number[] {
    return items.map((_, i) => i).filter(isNav)
  }

  useEffect(() => {
    if (autoFocus) panelRef.current?.focus()
  }, [autoFocus])

  // The root menu registers as an open overlay so edge-pan stands down while it
  // is open. Submenus are part of the same menu and do not register separately.
  useMenuOverlay('canvas-context-menu', isRoot, panelRef)

  // Place the panel: clamp inside the viewport, then (root only) nudge it clear
  // of the other floating menus (the pill, breadcrumb, toolbar, FABs) so menus
  // never stack. Submenus keep their own flip-left behaviour below.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (isRoot) {
      const placed = resolvePosition(x, y, r.width, r.height, collectMenuRects(el))
      setPos({ left: placed.left, top: placed.top })
    } else {
      setPos({
        left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
      })
    }
  }, [x, y, items, isRoot])

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpenIndex(null), 140)
  }
  useEffect(() => cancelClose, [])

  function openSub(i: number, byKeyboard: boolean): void {
    cancelClose()
    setOpenIndex(i)
    setOpenByKeyboard(byKeyboard)
  }
  function closeSub(focusSelf: boolean): void {
    setOpenIndex(null)
    setOpenByKeyboard(false)
    if (focusSelf) panelRef.current?.focus()
  }

  function activate(i: number): void {
    const it = items[i]
    if (!it || it.disabled) return
    if (it.children?.length) openSub(i, true)
    else if (it.onClick) {
      it.onClick()
      onClose()
    }
  }

  function move(dir: 1 | -1): void {
    const idxs = navIndices()
    if (!idxs.length) return
    const cur = idxs.indexOf(active)
    setActive(cur === -1 ? (dir > 0 ? idxs[0] : idxs[idxs.length - 1]) : idxs[(cur + dir + idxs.length) % idxs.length])
  }

  function typeAhead(ch: string): void {
    typeBuf.current += ch.toLowerCase()
    if (typeTimer.current) window.clearTimeout(typeTimer.current)
    typeTimer.current = window.setTimeout(() => (typeBuf.current = ''), 600)
    const match = navIndices().find((i) => (items[i].label ?? '').toLowerCase().startsWith(typeBuf.current))
    if (match != null) setActive(match)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        e.stopPropagation()
        move(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        e.stopPropagation()
        move(-1)
        break
      case 'Home': {
        e.preventDefault()
        const a = navIndices()
        if (a.length) setActive(a[0])
        break
      }
      case 'End': {
        e.preventDefault()
        const a = navIndices()
        if (a.length) setActive(a[a.length - 1])
        break
      }
      case 'ArrowRight':
        if (active >= 0 && items[active]?.children?.length) {
          e.preventDefault()
          e.stopPropagation()
          openSub(active, true)
        }
        break
      case 'ArrowLeft':
        if (!isRoot) {
          e.preventDefault()
          e.stopPropagation()
          onStepOut?.()
        }
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        onClose()
        break
      case 'Enter':
      case ' ':
        if (active >= 0) {
          e.preventDefault()
          e.stopPropagation()
          activate(active)
        }
        break
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          typeAhead(e.key)
        }
    }
  }

  // Position the open submenu beside its row, flipping left if needed.
  useLayoutEffect(() => {
    if (openIndex == null) {
      setSubPos(null)
      return
    }
    const row = rowRefs.current[openIndex]
    if (!row) return
    const anchor = row.getBoundingClientRect()
    const w = 200
    let left = anchor.right - 2
    if (left + w > window.innerWidth - 8) left = Math.max(8, anchor.left - w + 2)
    const top = Math.max(8, anchor.top - 5)
    setSubPos({ left, top })
  }, [openIndex])

  return createPortal(
    <div
      ref={panelRef}
      data-canvas-ctx-menu
      data-floating-menu
      role="menu"
      tabIndex={-1}
      className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in fb-context-menu fixed z-[260] py-1 min-w-[210px] max-h-[85vh] overflow-y-auto text-sm"
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {items.map((item, i) => {
        if (item.separator) return <div key={i} role="separator" className="my-1 h-px bg-[var(--surface-sunken)]" />
        const hasChildren = !!item.children?.length
        return (
          <div
            key={i}
            ref={(el) => (rowRefs.current[i] = el)}
            className="relative"
            onMouseEnter={() => {
              setActive(i)
              if (hasChildren) openSub(i, false)
            }}
            onMouseLeave={() => {
              if (hasChildren) scheduleClose()
            }}
          >
            <button
              role="menuitem"
              data-testid={item.testid}
              aria-haspopup={hasChildren || undefined}
              aria-expanded={hasChildren ? openIndex === i : undefined}
              aria-disabled={item.disabled || undefined}
              onClick={
                hasChildren
                  ? () => openSub(i, false)
                  : () => {
                      if (item.disabled) return
                      item.onClick?.()
                      onClose()
                    }
              }
              disabled={item.disabled && !hasChildren}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${
                item.disabled
                  ? 'text-[var(--ink-40)] cursor-not-allowed'
                  : `text-[var(--ink-90)] ${active === i ? 'bg-[var(--surface-sunken)]' : 'hover:bg-[var(--surface-sunken)]'}`
              }`}
            >
              {item.entity ? (
                <PlexiiIcon kind={item.entity.kind} id={item.entity.id} size={16} fallback={item.icon} fallbackClassName="text-[var(--ink-50)]" />
              ) : item.icon ? (
                <Icon name={item.icon} size={14} className="text-[var(--ink-50)]" />
              ) : (
                <span className="w-3.5" />
              )}
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.shortcut && (
                <span className="text-[11px] text-[var(--ink-50)] font-mono">{item.shortcut}</span>
              )}
              {hasChildren && <Icon name="chevron_right" size={14} className="text-[var(--ink-50)]" />}
            </button>
          </div>
        )
      })}
      {openIndex != null && items[openIndex]?.children?.length && subPos && (
        <MenuPanel
          items={items[openIndex].children as CtxMenuItem[]}
          x={subPos.left}
          y={subPos.top}
          onClose={onClose}
          isRoot={false}
          autoFocus={openByKeyboard}
          onStepOut={() => closeSub(true)}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        />
      )}
    </div>,
    document.body
  )
}
