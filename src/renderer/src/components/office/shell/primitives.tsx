import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../../Icon'
import Tooltip from '../../Tooltip'

// Bar primitives (spec §2.5): one look for every office app's ContextBar.
// Every primitive takes disabled / disabledReason / readOnlySafe / shortcut /
// testid. The bar's read-only state arrives through BarContext so a tab never
// has to thread it by hand. None of these handle keys beyond their own focused
// element (no document listeners).

export const READ_ONLY_REASON = 'not available: this document is read-only'

export const BarContext = createContext<{ readOnly: boolean }>({ readOnly: false })

export interface BarCommon {
  disabled?: boolean
  disabledReason?: string
  readOnlySafe?: boolean
  shortcut?: string // host-formatted from the app's live keymap
  testid?: string
  /** Id of what this control opens or toggles (e.g. a ShellPanel's DOM id); sets aria-controls. */
  controls?: string
}

/** Resolve disabled + the reason shown in the tooltip. Exported for tests. */
export function useBarState(p: BarCommon): { disabled: boolean; reason?: string } {
  const { readOnly } = useContext(BarContext)
  if (readOnly && !p.readOnlySafe) return { disabled: true, reason: READ_ONLY_REASON }
  return { disabled: !!p.disabled, reason: p.disabled ? p.disabledReason : undefined }
}

export function barTip(label: string, shortcut?: string, reason?: string): string {
  if (reason) return `${label} — ${reason}`
  return shortcut ? `${label} (${shortcut})` : label
}

/**
 * A popover anchored under a bar control, portalled to <body> and clamped to
 * the window. Row 2 scrolls horizontally, and a scroller clips vertically too,
 * so nothing that drops down may render inside it (SPEC §2.6). Closes on an
 * outside press (listener present only while open) or Escape inside it.
 */
export function BarPopover({ anchor, onClose, children, role = 'dialog', label, testid, minWidth = 176 }: {
  anchor: HTMLElement | null
  onClose: () => void
  children: ReactNode
  role?: 'dialog' | 'menu'
  label?: string
  testid?: string
  minWidth?: number
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const w = ref.current?.offsetWidth ?? minWidth
    const h = ref.current?.offsetHeight ?? 200
    const left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4))
    const below = r.bottom + 4
    const top = below + h > window.innerHeight - 4 ? Math.max(4, r.top - h - 4) : below
    setPos({ left, top })
  }, [anchor, minWidth])
  useEffect(() => {
    const down = (e: PointerEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [anchor, onClose])
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      data-testid={testid}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
          anchor?.focus()
        }
      }}
      style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth }}
      className="z-[70] fb-glass-panel rounded-[var(--radius-row)] fb-pop-in"
    >
      {children}
    </div>,
    document.body
  )
}

const BTN = 'h-7 min-w-7 px-1.5 inline-flex items-center justify-center gap-1 rounded text-[12px] transition-colors disabled:opacity-35 disabled:cursor-not-allowed'
const IDLE = 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
const ON = 'bg-accent/15 text-accent'

interface IconLabel extends BarCommon {
  icon?: string
  label: string // tooltip + accessible name
  showLabel?: boolean // render the text next to the icon
}

export function BarButton({ icon, label, showLabel, onClick, ...common }: IconLabel & { onClick: () => void }): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const tip = barTip(label, common.shortcut, reason)
  return (
    <Tooltip content={tip} placement="bottom">
      <button type="button" aria-label={tip} aria-controls={common.controls} disabled={disabled} data-testid={common.testid} onClick={onClick} className={`${BTN} ${IDLE}`}>
        {icon && <Icon name={icon} size={16} />}
        {(showLabel || !icon) && <span>{label}</span>}
      </button>
    </Tooltip>
  )
}

export function BarToggle({ icon, label, showLabel, pressed, onChange, ...common }: IconLabel & { pressed: boolean; onChange: (v: boolean) => void }): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const tip = barTip(label, common.shortcut, reason)
  return (
    <Tooltip content={tip} placement="bottom">
      <button
        type="button"
        aria-label={tip}
        aria-pressed={pressed}
        aria-controls={common.controls}
        disabled={disabled}
        data-testid={common.testid}
        onClick={() => onChange(!pressed)}
        className={`${BTN} ${pressed ? ON : IDLE}`}
      >
        {icon && <Icon name={icon} size={16} />}
        {(showLabel || !icon) && <span>{label}</span>}
      </button>
    </Tooltip>
  )
}

/** Opens a dialog or overlay panel; always shows its label with an ellipsis (spec §2.5). */
export function BarDialogButton({ icon, label, onOpen, ...common }: Omit<IconLabel, 'showLabel'> & { onOpen: () => void }): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const text = label.endsWith('…') ? label : `${label}…`
  const tip = barTip(text, common.shortcut, reason)
  return (
    <Tooltip content={tip} placement="bottom">
      <button type="button" aria-label={tip} aria-haspopup="dialog" disabled={disabled} data-testid={common.testid} onClick={onOpen} className={`${BTN} ${IDLE}`}>
        {icon && <Icon name={icon} size={16} />}
        <span>{text}</span>
      </button>
    </Tooltip>
  )
}

export function BarSelect<T extends string>({ label, value, options, onChange, width = 110, ...common }: BarCommon & {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  width?: number
}): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const tip = barTip(label, common.shortcut, reason)
  return (
    <Tooltip content={tip} placement="bottom">
      <select
        aria-label={tip}
        value={value}
        disabled={disabled}
        data-testid={common.testid}
        onChange={(e) => onChange(e.target.value as T)}
        onKeyDown={(e) => e.stopPropagation()}
        style={{ width }}
        className="fb-field h-6 px-1 py-0 text-[12px] disabled:opacity-35"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Tooltip>
  )
}

export function BarNumber({ label, value, onChange, min, max, step = 1, suffix, width = 56, ...common }: BarCommon & {
  label: string
  value: number | undefined
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  width?: number
}): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const tip = barTip(label, common.shortcut, reason)
  const [draft, setDraft] = useState<string>(value === undefined ? '' : String(value))
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n)) return setDraft(value === undefined ? '' : String(value))
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    // Leaving the field (or Enter) with the value unchanged is not an edit:
    // an app would otherwise record an empty undo step on every blur.
    if (c === value) return setDraft(String(c))
    onChange(c)
  }
  return (
    <Tooltip content={tip} placement="bottom">
      <span className="inline-flex items-center gap-0.5">
        <input
          aria-label={tip}
          inputMode="decimal"
          value={draft}
          placeholder="—"
          disabled={disabled}
          data-testid={common.testid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const n = (Number(draft) || 0) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1)
              onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)))
            }
          }}
          style={{ width }}
          className="fb-field h-6 px-1 py-0 text-[12px] fb-tabular disabled:opacity-35"
        />
        {suffix && <span className="text-[10px] text-[var(--ink-40)]">{suffix}</span>}
      </span>
    </Tooltip>
  )
}

export function BarColor({ icon = 'palette', label, value, onChange, palette, allowNone, ...common }: BarCommon & {
  icon?: string
  label: string
  value: string | undefined
  onChange: (v: string | undefined) => void
  palette: string[]
  allowNone?: boolean
}): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const tip = barTip(label, common.shortcut, reason)
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <span className="relative inline-flex">
      <Tooltip content={tip} placement="bottom">
        <button
          ref={btn}
          type="button"
          aria-label={tip}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          data-testid={common.testid}
          onClick={() => setOpen((v) => !v)}
          className={`${BTN} ${IDLE} flex-col !gap-0`}
        >
          <Icon name={icon} size={15} />
          <span className="block w-4 h-[3px] rounded-sm" style={{ background: value ?? 'transparent', outline: value ? undefined : '1px dashed var(--ink-30)' }} />
        </button>
      </Tooltip>
      {open && (
        <BarPopover anchor={btn.current} onClose={() => setOpen(false)} label={label} testid={common.testid ? `${common.testid}-popover` : undefined}>
          <div className="p-2 w-[176px]">
            <div className="grid grid-cols-8 gap-1">
              {palette.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => {
                    onChange(c)
                    setOpen(false)
                  }}
                  className={`w-4 h-4 rounded-sm border ${value === c ? 'ring-2 ring-accent' : 'border-[var(--edge-soft)]'}`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input type="color" aria-label={`${label}: custom`} value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} className="w-7 h-6 p-0 border-0 bg-transparent" />
              {allowNone && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(undefined)
                    setOpen(false)
                  }}
                  className="text-[11px] text-[var(--ink-60)] hover:text-[var(--ink-90)]"
                >
                  None
                </button>
              )}
            </div>
          </div>
        </BarPopover>
      )}
    </span>
  )
}

export interface BarMenuItem {
  label: string
  icon?: string
  preview?: ReactNode // e.g. an arrowhead drawing, in place of an icon
  run: () => void
  active?: boolean
  disabled?: boolean
  testid?: string
  shortcut?: string
}

export function BarMenu({ icon, label, showLabel = true, valueLabel, items, ...common }: IconLabel & { valueLabel?: ReactNode; items: (BarMenuItem | 'sep')[] }): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const tip = barTip(label, common.shortcut, reason)
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <span className="relative inline-flex">
      <Tooltip content={tip} placement="bottom">
        <button ref={btn} type="button" aria-label={tip} aria-haspopup="menu" aria-expanded={open} disabled={disabled} data-testid={common.testid} onClick={() => setOpen((v) => !v)} className={`${BTN} ${IDLE}`}>
          {icon && <Icon name={icon} size={16} />}
          {valueLabel ?? (showLabel && <span>{label}</span>)}
          <Icon name="expand_more" size={14} />
        </button>
      </Tooltip>
      {open && (
        <BarPopover anchor={btn.current} onClose={() => setOpen(false)} role="menu" testid={common.testid ? `${common.testid}-menu` : undefined} minWidth={200}>
          <div className="py-1 max-h-[60vh] overflow-auto">
            {items.map((it, i) =>
              it === 'sep' ? (
                <div key={`s${i}`} className="my-1 h-px bg-[var(--edge-soft)]" />
              ) : (
                <button
                  key={`${it.label}-${i}`}
                  type="button"
                  // An item that can be the current choice (a layout, a theme, a zoom level)
                  // says so to assistive tech, not only in bold.
                  role={it.active === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={it.active === undefined ? undefined : it.active}
                  disabled={it.disabled}
                  data-testid={it.testid}
                  onClick={() => {
                    setOpen(false)
                    it.run()
                  }}
                  className={`w-full flex items-center gap-2 px-2.5 py-1 text-[12px] text-left text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] disabled:opacity-40 ${it.active ? 'font-semibold' : ''}`}
                >
                  <span className="min-w-4 inline-flex justify-center">{it.preview ?? (it.icon ? <Icon name={it.icon} size={15} /> : it.active ? <Icon name="check" size={14} /> : null)}</span>
                  <span className="flex-1">{it.label}</span>
                  {it.shortcut && <span className="text-[var(--ink-40)] fb-tabular">{it.shortcut}</span>}
                  {it.active && (it.icon || it.preview) && <Icon name="check" size={14} className="text-accent" />}
                </button>
              )
            )}
          </div>
        </BarPopover>
      )}
    </span>
  )
}

export function BarGroup({ label, children, testid }: { label?: string; children: ReactNode; testid?: string }): JSX.Element {
  return (
    <div role="group" aria-label={label} data-testid={testid} className="inline-flex items-center gap-0.5 shrink-0">
      {children}
    </div>
  )
}

export function BarSep(): JSX.Element {
  return <span aria-hidden className="shrink-0 w-px h-5 mx-1.5 bg-[var(--edge-soft)]" />
}

/** App widgets (FontPicker, arrow pickers, the nine-point reference) at bar height. */
export function BarCustom({ children, label, testid }: { children: ReactNode; label?: string; testid?: string }): JSX.Element {
  return (
    <span role={label ? 'group' : undefined} aria-label={label} data-testid={testid} className="inline-flex items-center gap-1 shrink-0 h-7">
      {children}
    </span>
  )
}
