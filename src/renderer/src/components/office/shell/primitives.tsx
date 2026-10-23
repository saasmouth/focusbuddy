import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../../Icon'
import Tooltip from '../../Tooltip'

// Bar primitives (spec §2.5): one look for every office app's ContextBar.
// Every primitive takes disabled / disabledReason / readOnlySafe / shortcut /
// testid. The bar's read-only state arrives through BarContext so a tab never
// has to thread it by hand. None of these handle keys beyond their own focused
// element (no document listeners).

/**
 * The one sentence every office app shows for an action a read-only document
 * cannot take: in the bar, the rail, the menus and the commands (aggregator
 * ruling, 4.3.41). This constant is its only source; an app imports it rather
 * than writing its own (Draw's commands/gate.ts, Write's and Cells' registries,
 * the snippet declines). officeReadOnlyReason.test.tsx holds every app to it.
 */
export const READ_ONLY_REASON = 'This document is read-only.'

export const BarContext = createContext<{ readOnly: boolean }>({ readOnly: false })

/**
 * What a text-formatting control MEANS, so the control-type contract (SPEC
 * §3.9, `controlViolations`) can find it without reading labels: font size is
 * a BarNumber, colours are BarColor, alignment is three BarToggles, B/I/U are
 * BarToggles, the family is the FontPicker. Rendered as data-bar-semantic.
 */
export type BarSemantic = 'font-family' | 'font-size' | 'bold' | 'italic' | 'underline' | 'text-color' | 'align-left' | 'align-center' | 'align-right'

/** The primitive a control is, rendered as data-bar-kind (read by the contract, never by apps). */
export type BarKind = 'button' | 'toggle' | 'dialog' | 'select' | 'number' | 'color' | 'menu' | 'custom' | 'font'

export interface BarCommon {
  /** See BarSemantic. */
  semantic?: BarSemantic
  disabled?: boolean
  disabledReason?: string
  readOnlySafe?: boolean
  shortcut?: string // host-formatted from the app's live keymap
  testid?: string
  /** Id of what this control opens or toggles (e.g. a ShellPanel's DOM id); sets aria-controls. */
  controls?: string
}

/**
 * Resolve disabled + the reason shown in the tooltip. Exported for tests.
 *
 * In a read-only document every control that is not `readOnlySafe` is off. Its
 * reason is the control's OWN when it has one (an off command says why: its
 * pending note, its gated reason, `barProps` from the OfficeCommand registry),
 * so the bar says exactly what the menu row for the same command says; only a
 * control with no reason of its own is given READ_ONLY_REASON.
 */
export function useBarState(p: BarCommon): { disabled: boolean; reason?: string } {
  const { readOnly } = useContext(BarContext)
  const own = p.disabled ? p.disabledReason : undefined
  if (readOnly && !p.readOnlySafe) return { disabled: true, reason: own || READ_ONLY_REASON }
  return { disabled: !!p.disabled, reason: own }
}

export function barTip(label: string, shortcut?: string, reason?: string): string {
  if (reason) return `${label} — ${reason}`
  return shortcut ? `${label} (${shortcut})` : label
}

/**
 * The words a bar control shows on its face. A label is the tooltip and the
 * accessible name, and may be "Name — what it does"; only the name belongs on
 * the button. Shown whole, Write's Styles button read "Styles — apply and
 * customise paragraph styles" across two lines in the Home tab (rails-tabs-41
 * shots). The description stays in the tooltip and the aria-label.
 */
export function barText(label: string): string {
  const i = label.indexOf(' — ')
  return i > 0 ? label.slice(0, i) : label
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

const BTN = 'h-7 min-w-7 px-1.5 inline-flex items-center justify-center gap-1 rounded text-[12px] whitespace-nowrap shrink-0 transition-colors disabled:opacity-35 disabled:cursor-not-allowed'
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
      <button type="button" aria-label={tip} aria-controls={common.controls} disabled={disabled} data-testid={common.testid} data-bar-kind="button" data-bar-semantic={common.semantic} onClick={onClick} className={`${BTN} ${IDLE}`}>
        {icon && <Icon name={icon} size={16} />}
        {(showLabel || !icon) && <span>{barText(label)}</span>}
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
        data-bar-kind="toggle"
        data-bar-semantic={common.semantic}
        onClick={() => onChange(!pressed)}
        className={`${BTN} ${pressed ? ON : IDLE}`}
      >
        {icon && <Icon name={icon} size={16} />}
        {(showLabel || !icon) && <span>{barText(label)}</span>}
      </button>
    </Tooltip>
  )
}

/** Opens a dialog or overlay panel; always shows its label with an ellipsis (spec §2.5). */
export function BarDialogButton({ icon, label, onOpen, ...common }: Omit<IconLabel, 'showLabel'> & { onOpen: () => void }): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const name = barText(label)
  const text = name.endsWith('…') ? name : `${name}…`
  // The tooltip keeps a description when the label has one; otherwise it is the face text.
  const tip = barTip(name === label ? text : label, common.shortcut, reason)
  return (
    <Tooltip content={tip} placement="bottom">
      <button type="button" aria-label={tip} aria-haspopup="dialog" disabled={disabled} data-testid={common.testid} data-bar-kind="dialog" onClick={onOpen} className={`${BTN} ${IDLE}`}>
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
        data-bar-kind="select"
        data-bar-semantic={common.semantic}
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

export function BarNumber({ label, value, fallback, onChange, min, max, step = 1, suffix, width = 56, ...common }: BarCommon & {
  label: string
  value: number | undefined
  /**
   * The value in force when none is set (Write's text with no size of its own
   * is still at the document's size). Shown instead of "—", which claims there
   * is no value: an empty document's font size read "—" (rails-tabs-41 shots).
   * Committing it unchanged is not an edit; changing it sets `value`.
   */
  fallback?: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  width?: number
}): JSX.Element {
  const { disabled, reason } = useBarState(common)
  const tip = barTip(label, common.shortcut, reason)
  const shown = value ?? fallback
  const [draft, setDraft] = useState<string>(shown === undefined ? '' : String(shown))
  useEffect(() => setDraft(shown === undefined ? '' : String(shown)), [shown])
  const commit = (): void => {
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n)) return setDraft(shown === undefined ? '' : String(shown))
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    // Leaving the field (or Enter) with the value unchanged is not an edit:
    // an app would otherwise record an empty undo step on every blur.
    if (c === shown) return setDraft(String(c))
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
          data-bar-kind="number"
          data-bar-semantic={common.semantic}
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

export function BarColor({ icon = 'palette', label, value, onChange, palette, allowNone, popover, swatch, ...common }: BarCommon & {
  icon?: string
  label: string
  value: string | undefined
  onChange: (v: string | undefined) => void
  palette: string[]
  allowNone?: boolean
  /**
   * An app's own picker body in place of the palette (Draw's paints: swatches,
   * gradients, none). The trigger, its look and its aria stay BarColor's, so a
   * colour control looks and behaves the same in every app (SPEC §3.9).
   */
  popover?: (close: () => void) => ReactNode
  /** CSS background for the swatch under the icon when `value` is not a plain colour (a gradient). */
  swatch?: string
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
          data-bar-kind="color"
          data-bar-semantic={common.semantic}
          onClick={() => setOpen((v) => !v)}
          className={`${BTN} ${IDLE} flex-col !gap-0`}
        >
          <Icon name={icon} size={15} />
          <span className="block w-4 h-[3px] rounded-sm" style={{ background: swatch ?? value ?? 'transparent', outline: swatch ?? value ? undefined : '1px dashed var(--ink-30)' }} />
        </button>
      </Tooltip>
      {open && (
        <BarPopover anchor={btn.current} onClose={() => setOpen(false)} label={label} testid={common.testid ? `${common.testid}-popover` : undefined}>
          {popover ? popover(() => setOpen(false)) : (
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
          )}
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
        <button ref={btn} type="button" aria-label={tip} aria-haspopup="menu" aria-expanded={open} disabled={disabled} data-testid={common.testid} data-bar-kind="menu" data-bar-semantic={common.semantic} onClick={() => setOpen((v) => !v)} className={`${BTN} ${IDLE}`}>
          {icon && <Icon name={icon} size={16} />}
          {valueLabel ?? (showLabel && <span>{barText(label)}</span>)}
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
export function BarCustom({ children, label, testid, semantic }: { children: ReactNode; label?: string; testid?: string; semantic?: BarSemantic }): JSX.Element {
  return (
    <span role={label ? 'group' : undefined} aria-label={label} data-testid={testid} data-bar-kind="custom" data-bar-semantic={semantic} className="inline-flex items-center gap-1 shrink-0 h-7">
      {children}
    </span>
  )
}

/**
 * Font size, the same control in every app (SPEC §3.9): a BarNumber, plus the
 * app's preset sizes in a menu beside it when it has them (Deck's pattern,
 * which kept Write's old size list reachable when its select became a number).
 */
export function BarFontSize({ label = 'Font size', value, fallback, onChange, onClear, min = 1, max, suffix, width = 48, presets, ...common }: Omit<BarCommon, 'semantic'> & {
  label?: string
  value: number | undefined
  /** The size in force when the text sets none (see BarNumber). */
  fallback?: number
  onChange: (v: number) => void
  min?: number
  max?: number
  suffix?: string
  width?: number
  presets?: number[]
  /** Clear back to the app's default size (Write's old "Size" choice); offered first in the presets menu. */
  onClear?: () => void
}): JSX.Element {
  return (
    <>
      <BarNumber label={label} value={value} fallback={fallback} onChange={onChange} min={min} max={max} suffix={suffix} width={width} semantic="font-size" {...common} />
      {presets && presets.length > 0 && (
        <BarMenu
          icon="format_size"
          label="Font size presets"
          showLabel={false}
          disabled={common.disabled}
          disabledReason={common.disabledReason}
          readOnlySafe={common.readOnlySafe}
          items={[
            ...(onClear ? [{ label: 'Default', run: onClear, active: value === undefined }, 'sep' as const] : []),
            ...presets.map((p) => ({ label: `${p}`, run: () => onChange(p), active: value === p }))
          ]}
        />
      )}
    </>
  )
}
