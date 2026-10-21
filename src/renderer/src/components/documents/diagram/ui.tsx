import { useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'

// Small, consistent controls for the PlexiDiagrams chrome (toolbar, inspector,
// panels). Deliberately plain: they render real values and call back on change.

export function IconBtn({
  icon,
  title,
  onClick,
  active,
  disabled,
  testid,
  label,
  size = 15
}: {
  icon: string
  title: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  testid?: string
  label?: string
  size?: number
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-testid={testid}
      className={`inline-flex items-center gap-1 h-7 ${label ? 'px-1.5' : 'w-7 justify-center'} rounded text-[11px] transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${
        active ? 'bg-[color-mix(in_oklab,#2563eb_14%,transparent)] text-[#1d4ed8] dark:text-[#93c5fd]' : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <Icon name={icon} size={size} />
      {label && <span>{label}</span>}
    </button>
  )
}

export function Sep(): JSX.Element {
  return <div className="w-px h-5 bg-[var(--edge-firm)] mx-1 shrink-0" />
}

export function Section({ title, children, defaultOpen = true, testid }: { title: string; children: React.ReactNode; defaultOpen?: boolean; testid?: string }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-[var(--edge-soft)]" data-testid={testid}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-60)] hover:text-[var(--ink-90)]">
        {title}
        <Icon name={open ? 'expand_less' : 'expand_more'} size={14} />
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  )
}

export function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-[11px] text-[var(--ink-70)]">
      <span className="w-[72px] shrink-0 text-[var(--ink-50)]">{label}</span>
      <div className="flex-1 min-w-0 flex items-center gap-1">{children}</div>
    </label>
  )
}

// Number input that commits on blur/Enter and supports arrow keys.
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  testid,
  placeholder,
  width = 64
}: {
  value: number | undefined
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  testid?: string
  placeholder?: string
  width?: number
}): JSX.Element {
  const [draft, setDraft] = useState(value === undefined ? '' : String(round(value)))
  useEffect(() => setDraft(value === undefined ? '' : String(round(value))), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(value === undefined ? '' : String(round(value)))
      return
    }
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    if (c !== value) onChange(c)
    setDraft(String(round(c)))
  }
  return (
    <span className="inline-flex items-center">
      <input
        type="number"
        value={draft}
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        data-testid={testid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
            ;(e.target as HTMLInputElement).blur()
          }
          e.stopPropagation()
        }}
        className="fb-field h-6 px-1.5 text-[11px] tabular-nums"
        style={{ width }}
      />
      {suffix && <span className="ml-1 text-[10px] text-[var(--ink-50)]">{suffix}</span>}
    </span>
  )
}

const round = (v: number): number => Math.round(v * 100) / 100

export function Select<T extends string>({
  value,
  options,
  onChange,
  testid,
  width
}: {
  value: T | undefined
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  testid?: string
  width?: number
}): JSX.Element {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value as T)}
      data-testid={testid}
      className="fb-field h-6 px-1 text-[11px] min-w-0"
      style={width ? { width } : { flex: 1 }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {value === undefined && <option value="">Mixed</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({ checked, onChange, label, testid }: { checked: boolean; onChange: (v: boolean) => void; label: string; testid?: string }): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-[11px] text-[var(--ink-70)] cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} className="accent-[#2563eb]" />
      {label}
    </label>
  )
}

// Colour picker: theme swatches, a "none" option where allowed, and a native picker.
export function ColorField({
  value,
  onChange,
  palette,
  allowNone,
  testid,
  title
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  palette: string[]
  allowNone?: boolean
  testid?: string
  title?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const swatch = value && value !== 'none' ? value : undefined
  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title ?? 'Colour'}
        data-testid={testid}
        className="h-6 w-9 rounded border border-[var(--edge-firm)] flex items-center justify-center"
        style={{ background: swatch ?? 'repeating-linear-gradient(45deg,#fff 0 4px,#e7e5e4 4px 8px)' }}
      >
        {value === 'none' && <Icon name="block" size={12} className="text-red-500" />}
      </button>
      {open && (
        <div className="fb-glass-panel fb-pop-in absolute z-50 mt-1 p-2 rounded-[var(--radius-row)] w-[176px] left-0">
          <div className="grid grid-cols-8 gap-1">
            {[...palette, '#000000', '#ffffff', '#f5f5f4', '#e7e5e4', '#a8a29e', '#57534e'].slice(0, 24).map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => {
                  onChange(c)
                  setOpen(false)
                }}
                className={`h-4 w-4 rounded-sm border ${value === c ? 'ring-2 ring-[#2563eb] ring-offset-1' : 'border-black/15'}`}
                style={{ background: c }}
              />
            ))}
          </div>
          <div className="flex items-center gap-1 mt-2">
            <input
              type="color"
              value={swatch && /^#[0-9a-f]{6}$/i.test(swatch) ? swatch : '#2563eb'}
              onChange={(e) => onChange(e.target.value)}
              className="h-6 w-8 p-0 border-0 bg-transparent"
              title="Custom colour"
            />
            <input
              defaultValue={value ?? ''}
              placeholder="#hex"
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.trim()
                  if (/^#?[0-9a-f]{3,8}$/i.test(v)) onChange(v.startsWith('#') ? v : `#${v}`)
                  setOpen(false)
                }
              }}
              className="fb-field h-6 px-1 text-[11px] w-[70px]"
            />
            {allowNone && (
              <button type="button" onClick={() => (onChange('none'), setOpen(false))} className="text-[10px] px-1 text-[var(--ink-60)] hover:text-[var(--ink-90)]" title="No colour">
                None
              </button>
            )}
            <button type="button" onClick={() => (onChange(undefined), setOpen(false))} className="text-[10px] px-1 text-[var(--ink-60)] hover:text-[var(--ink-90)]" title="Reset to theme">
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// A small dropdown menu anchored to a button.
export function MenuButton({
  icon,
  label,
  title,
  items,
  testid
}: {
  icon: string
  label?: string
  title: string
  items: ({ label: string; icon?: string; run: () => void; testid?: string; hint?: string; active?: boolean } | 'sep')[]
  testid?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        data-testid={testid}
        className="inline-flex items-center gap-1 h-7 px-1.5 rounded text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
      >
        <Icon name={icon} size={15} />
        {label && <span>{label}</span>}
        <Icon name="expand_more" size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fb-glass-panel fb-pop-in absolute z-50 mt-1 min-w-[190px] py-1 rounded-[var(--radius-row)] max-h-[70vh] overflow-auto">
            {items.map((it, i) =>
              it === 'sep' ? (
                <div key={i} className="my-1 h-px bg-[var(--edge-soft)]" />
              ) : (
                <button
                  key={i}
                  type="button"
                  data-testid={it.testid}
                  onClick={() => {
                    it.run()
                    setOpen(false)
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-[var(--surface-sunken)] ${it.active ? 'font-semibold' : ''}`}
                >
                  {it.icon && <Icon name={it.icon} size={14} className="text-[var(--ink-60)]" />}
                  <span className="flex-1">{it.label}</span>
                  {it.hint && <span className="text-[10px] text-[var(--ink-40)]">{it.hint}</span>}
                </button>
              )
            )}
          </div>
        </>
      )}
    </div>
  )
}
