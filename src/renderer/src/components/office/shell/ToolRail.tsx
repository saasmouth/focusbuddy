import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../../Icon'
import Tooltip from '../../Tooltip'

// The office ToolRail: the left strip of tool icons every office app shares
// (spec: /private/tmp/claude-501/office-shell/SPEC.md §2.1–2.2), extracted from
// PlexiiDraw's Toolbox.
//
// It is deliberately dumb about state and keys:
//  - the host passes the items (Draw maps its tool registry straight onto them),
//    the active id (including temporary tools such as Space-for-Hand), and the
//    last-used member of each flyout;
//  - shortcut labels arrive already formatted from the host's live keymap;
//  - it registers NO document or window listener. Every key it handles is an
//    onKeyDown on its own buttons (roving focus), so letters, arrows and Enter
//    on the canvas still belong to the app's keymap.

export type RailKind = 'tool' | 'action' | 'panel'

export interface RailItem<C> {
  id: string
  label: string
  icon: string
  kind: RailKind
  group: number
  order: number
  shortcut?: string
  hidden?: boolean | ((c: C) => boolean)
  disabled?: boolean | ((c: C) => boolean)
  disabledReason?: string | ((c: C) => string)
  readOnlySafe?: boolean
  flyout?: string
  badge?: 'dot' | string
  pinned?: 'bottom'
  onSelect: (c: C) => void
  onOptions?: (c: C) => void
  testid?: string
}

export interface ToolRailProps<C> {
  items: RailItem<C>[]
  ctx: C
  activeId?: string
  openPanels?: string[]
  lastUsed?: Record<string, string>
  onFlyoutPick?: (flyout: string, id: string) => void
  readOnly?: boolean
  footer?: ReactNode
  testid: string
  ariaLabel?: string
}

const READ_ONLY_REASON = 'not available: this document is read-only'
const HOLD_MS = 350

const pick = <C, T>(v: T | ((c: C) => T) | undefined, c: C): T | undefined =>
  typeof v === 'function' ? (v as (c: C) => T)(c) : v

/** One rail slot: a single item, or a flyout group shown as its last-used member. */
interface Slot<C> {
  key: string
  group: number
  pinned: boolean
  shown: RailItem<C>
  members: RailItem<C>[]
}

/** Sort, drop hidden items, and fold flyout groups into one slot each. Pure, for tests. */
export function railSlots<C>(items: RailItem<C>[], ctx: C, lastUsed: Record<string, string> = {}): Slot<C>[] {
  const visible = items
    .filter((i) => !pick(i.hidden, ctx))
    .sort((a, b) => Number(!!a.pinned) - Number(!!b.pinned) || a.group - b.group || a.order - b.order || a.id.localeCompare(b.id))
  const slots: Slot<C>[] = []
  const byFlyout = new Map<string, Slot<C>>()
  for (const item of visible) {
    if (item.flyout) {
      const existing = byFlyout.get(item.flyout)
      if (existing) {
        existing.members.push(item)
        continue
      }
      const slot: Slot<C> = { key: `flyout:${item.flyout}`, group: item.group, pinned: !!item.pinned, shown: item, members: [item] }
      byFlyout.set(item.flyout, slot)
      slots.push(slot)
      continue
    }
    slots.push({ key: item.id, group: item.group, pinned: !!item.pinned, shown: item, members: [item] })
  }
  for (const [flyout, slot] of byFlyout) {
    const last = slot.members.find((m) => m.id === lastUsed[flyout])
    if (last) slot.shown = last
  }
  return slots
}

/** Tooltip text: "Label (Key)" plus the options or disabled suffix. Pure, for tests. */
export function railTooltip(label: string, shortcut: string | undefined, opts: { options?: boolean; disabledReason?: string }): string {
  let t = shortcut ? `${label} (${shortcut})` : label
  if (opts.disabledReason) return `${label} — ${opts.disabledReason}`
  if (opts.options) t += ' — double-click for options'
  return t
}

export default function ToolRail<C>({ items, ctx, activeId, openPanels = [], lastUsed = {}, onFlyoutPick, readOnly, footer, testid, ariaLabel = 'Tools' }: ToolRailProps<C>): JSX.Element {
  const slots = useMemo(() => railSlots(items, ctx, lastUsed), [items, ctx, lastUsed])
  const [focusIdx, setFocusIdx] = useState(0)
  const [openFlyout, setOpenFlyout] = useState<string | null>(null)
  const btns = useRef<(HTMLButtonElement | null)[]>([])
  const hold = useRef<number | null>(null)

  useEffect(() => {
    if (focusIdx >= slots.length) setFocusIdx(Math.max(0, slots.length - 1))
  }, [slots.length, focusIdx])

  const stateOf = (item: RailItem<C>): { disabled: boolean; reason?: string } => {
    if (readOnly && !item.readOnlySafe) return { disabled: true, reason: READ_ONLY_REASON }
    const disabled = !!pick(item.disabled, ctx)
    return { disabled, reason: disabled ? pick(item.disabledReason, ctx) : undefined }
  }

  const activate = (item: RailItem<C>): void => {
    if (stateOf(item).disabled) return
    if (item.flyout) onFlyoutPick?.(item.flyout, item.id)
    item.onSelect(ctx)
  }

  const move = (to: number): void => {
    const n = slots.length
    if (!n) return
    const i = ((to % n) + n) % n
    setFocusIdx(i)
    btns.current[i]?.focus()
  }

  const onKeyDown = (e: ReactKeyboardEvent, idx: number, slot: Slot<C>): void => {
    // Only reached while focus is ON a rail button: never a global listener.
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(idx + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(idx - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      move(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      move(slots.length - 1)
    } else if (e.key === 'F10' && e.shiftKey && slot.members.length > 1) {
      e.preventDefault()
      setOpenFlyout(slot.key)
    } else if (e.key === 'Escape' && openFlyout) {
      e.preventDefault()
      setOpenFlyout(null)
    }
  }

  const startHold = (slot: Slot<C>): void => {
    if (slot.members.length < 2) return
    hold.current = window.setTimeout(() => {
      hold.current = null
      setOpenFlyout(slot.key)
    }, HOLD_MS)
  }
  const endHold = (): boolean => {
    if (hold.current === null) return false
    window.clearTimeout(hold.current)
    hold.current = null
    return true
  }

  const renderSlot = (slot: Slot<C>, idx: number, prev: Slot<C> | undefined): ReactNode => {
    const item = slot.shown
    const { disabled, reason } = stateOf(item)
    const pressed = slot.members.some((m) => (m.kind === 'panel' ? openPanels.includes(m.id) : m.kind === 'tool' && m.id === activeId))
    const shownActive = slot.members.find((m) => m.id === activeId) ?? item
    const tip = railTooltip(shownActive.label, shownActive.shortcut, { options: !!shownActive.onOptions, disabledReason: reason })
    const sep = prev && (prev.group !== slot.group || prev.pinned !== slot.pinned)
    const isFlyout = slot.members.length > 1
    return (
      <div key={slot.key} className="relative">
        {sep && <div className="my-1 mx-2 h-px bg-[var(--edge-soft)]" role="separator" />}
        <Tooltip content={tip} placement="right">
          <button
            ref={(el) => (btns.current[idx] = el)}
            type="button"
            tabIndex={idx === focusIdx ? 0 : -1}
            aria-label={tip}
            aria-pressed={item.kind === 'action' ? undefined : pressed}
            aria-haspopup={isFlyout ? 'menu' : undefined}
            aria-expanded={isFlyout ? openFlyout === slot.key : undefined}
            disabled={disabled}
            data-testid={shownActive.testid ?? `${testid}-${shownActive.id}`}
            data-rail-kind={item.kind}
            onFocus={() => setFocusIdx(idx)}
            onKeyDown={(e) => onKeyDown(e, idx, slot)}
            onPointerDown={() => startHold(slot)}
            onPointerUp={() => endHold()}
            onPointerLeave={() => endHold()}
            onClick={() => {
              if (openFlyout === slot.key) return
              activate(shownActive)
            }}
            onDoubleClick={() => shownActive.onOptions && !disabled && shownActive.onOptions(ctx)}
            className={`relative w-8 h-8 mx-1 rounded flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              pressed ? 'bg-accent/15 text-accent' : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <Icon name={shownActive.icon} size={17} />
            {shownActive.badge === 'dot' && <span aria-hidden className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent" />}
            {shownActive.badge && shownActive.badge !== 'dot' && (
              <span aria-hidden className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-accent text-white text-[9px] leading-[14px] text-center">
                {shownActive.badge}
              </span>
            )}
            {isFlyout && (
              <span
                aria-hidden
                data-testid={`${testid}-flyout-${slot.key.replace('flyout:', '')}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenFlyout(openFlyout === slot.key ? null : slot.key)
                }}
                className="absolute bottom-0.5 right-0.5 w-0 h-0 border-l-[4px] border-l-transparent border-b-[4px] border-b-current opacity-60"
              />
            )}
          </button>
        </Tooltip>
        {openFlyout === slot.key && (
          <FlyoutMenu
            anchor={btns.current[idx]}
            testid={`${testid}-flyout-menu`}
            onClose={() => {
              setOpenFlyout(null)
              btns.current[idx]?.focus()
            }}
          >
            {slot.members.map((m) => {
              const st = stateOf(m)
              return (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m.id === shownActive.id}
                  disabled={st.disabled}
                  data-testid={`${m.testid ?? `${testid}-${m.id}`}-flyout`}
                  onClick={() => {
                    setOpenFlyout(null)
                    activate(m)
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1 text-[12px] text-left text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] disabled:opacity-40"
                >
                  <Icon name={m.icon} size={15} />
                  <span className="flex-1">{m.label}</span>
                  {m.shortcut && <span className="text-[var(--ink-40)] fb-tabular">{m.shortcut}</span>}
                </button>
              )
            })}
          </FlyoutMenu>
        )}
      </div>
    )
  }

  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      data-testid={testid}
      className="shrink-0 w-10 h-full flex flex-col py-1 border-r border-[var(--edge-soft)] overflow-y-auto overflow-x-visible bg-[var(--surface-raised)]"
    >
      {slots.map((slot, i) => renderSlot(slot, i, slots[i - 1]))}
      {footer && <div className="mt-auto pt-1 border-t border-[var(--edge-soft)] flex flex-col items-center gap-1 py-1">{footer}</div>}
    </div>
  )
}

// The flyout is portalled to <body> and clamped to the window, so a rail that
// scrolls (short editors, desk widgets) never clips it (spec §2.6).
function FlyoutMenu({ anchor, testid, onClose, children }: { anchor: HTMLElement | null; testid: string; onClose: () => void; children: ReactNode }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const menu = ref.current
    const w = menu?.offsetWidth ?? 180
    const h = menu?.offsetHeight ?? 160
    const left = Math.min(r.right + 4, window.innerWidth - w - 4)
    const top = Math.max(4, Math.min(r.top, window.innerHeight - h - 4))
    setPos({ left, top })
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not([disabled])')?.focus()
  }, [anchor])
  useEffect(() => {
    // Close on a pointer press outside: listener lives only while the flyout is
    // open and only closes it (it never handles keys or tools).
    const down = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [anchor, onClose])
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid={testid}
      style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className="z-[70] fb-glass-panel rounded-[var(--radius-row)] py-1 min-w-[180px] fb-pop-in"
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not([disabled])') ?? [])]
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          items[(i + 1) % items.length]?.focus()
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          items[(i - 1 + items.length) % items.length]?.focus()
        }
      }}
    >
      {children}
    </div>,
    document.body
  )
}
