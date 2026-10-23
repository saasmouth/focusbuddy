// Controls the Transform panel and the transform dialogs share: a numeric
// field that takes expressions and units ("100+20", "50%", "2in", "*2") and
// commits on Enter or blur (one undo step per committed value, never per
// keystroke), and the 9-point reference point locator.

import { useEffect, useRef, useState } from 'react'
import { docDpi, evalField, evalLength, formatField, formatLength } from '@shared/draw/fieldExpr'
import { REF_POINTS, refPointLabel, type RefPoint } from '@shared/draw/geometry/transform'
import type { DrawSettings } from '@shared/draw/model'

export type FieldKind = 'length' | 'deg' | 'pct'

export function formatValue(v: number, kind: FieldKind, settings: DrawSettings | undefined): string {
  if (kind === 'length') return formatLength(v, settings)
  return formatField(v, kind, 2)
}

export function parseValue(text: string, kind: FieldKind, settings: DrawSettings | undefined, current?: number): number | null {
  if (kind === 'length') return evalLength(text, settings, current)
  return evalField(text, { unit: kind, dpi: docDpi(settings), current })
}

export interface NumFieldProps {
  label: string
  /** Shown before the input: a short letter (X, W) or an icon glyph. */
  prefix?: string
  /** The value in the field's own unit: px for lengths, degrees, percent. Null shows an empty field. */
  value: number | null
  kind: FieldKind
  settings?: DrawSettings
  onCommit(v: number): void
  disabled?: boolean
  title?: string
  testId?: string
  className?: string
  /** Commit on every valid keystroke as well (dialogs with Preview). */
  live?: boolean
}

/**
 * A numeric field. Typing an expression and pressing Enter (or leaving the
 * field) commits it; Escape puts the old value back; text that does not parse
 * is refused and the old value comes back, as Illustrator's fields do.
 */
export function NumField({ label, prefix, value, kind, settings, onCommit, disabled, title, testId, className, live }: NumFieldProps): JSX.Element {
  const shown = value === null ? '' : formatValue(value, kind, settings)
  const [text, setText] = useState(shown)
  const focused = useRef(false)
  // What was last committed from this field, so Enter followed by the blur it
  // causes never applies a (relative) expression twice.
  const committed = useRef<string | null>(null)
  const [blurs, setBlurs] = useState(0)
  const [bad, setBad] = useState(false)
  useEffect(() => {
    if (!focused.current) setText(shown)
  }, [shown, blurs])

  function commit(): void {
    if (text.trim() === shown.trim() || text === committed.current) return
    const v = parseValue(text, kind, settings, value ?? undefined)
    if (v === null) {
      setBad(true)
      setText(shown)
      return
    }
    setBad(false)
    committed.current = text
    onCommit(v)
  }

  return (
    <label className={`flex items-center gap-1 min-w-0 ${className ?? ''}`} title={title ?? label}>
      {prefix && <span className="text-[10px] w-3 shrink-0 text-[var(--ink-50)] text-center">{prefix}</span>}
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={bad || undefined}
        value={text}
        disabled={disabled}
        data-testid={testId}
        onFocus={(e) => {
          focused.current = true
          e.currentTarget.select()
        }}
        onChange={(e) => {
          setText(e.target.value)
          committed.current = null
          setBad(false)
          if (live) {
            const v = parseValue(e.target.value, kind, settings, value ?? undefined)
            if (v !== null) onCommit(v)
          }
        }}
        onBlur={() => {
          focused.current = false
          commit()
          committed.current = null
          setBlurs((n) => n + 1)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
            if (!live) (e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            // The studio blurs the field on Escape; that blur must not commit what was typed.
            committed.current = text
            setText(shown)
            setBad(false)
          }
        }}
        className={`fb-field w-full min-w-0 px-1.5 py-0.5 text-[11px] fb-tabular ${bad ? 'border-red-500' : ''}`}
      />
    </label>
  )
}

/** The 9-point reference point locator; `compact` fits it in a bar row (26px). */
export function RefLocator({ value, onChange, testId = 'draw-transform-ref', disabled, disabledReason, compact }: {
  value: RefPoint
  onChange(r: RefPoint): void
  testId?: string
  disabled?: boolean
  /** Why it is off, appended to each point's tooltip while `disabled` (the shell's "Label — reason"). */
  disabledReason?: string
  compact?: boolean
}): JSX.Element {
  return (
    <div
      className={`grid grid-cols-3 rounded border border-[var(--edge-soft)] shrink-0 ${compact ? 'gap-px p-[2px]' : 'gap-[3px] p-1'}`}
      role="radiogroup"
      aria-label="Reference point"
      data-testid={testId}
    >
      {REF_POINTS.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          aria-label={`Reference point: ${refPointLabel(r)}`}
          title={disabled && disabledReason ? `Reference point: ${refPointLabel(r)} — ${disabledReason}` : `Reference point: ${refPointLabel(r)}`}
          data-testid={`${testId}-${r}`}
          disabled={disabled}
          onClick={() => onChange(r)}
          className={`${compact ? 'w-[6px] h-[6px] rounded-[1px]' : 'w-[9px] h-[9px] rounded-[2px]'} border disabled:opacity-40 ${value === r ? 'bg-accent border-accent' : 'border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)]'}`}
        />
      ))}
    </div>
  )
}

export function Check({ label, checked, onChange, disabled, title, testId }: { label: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean; title?: string; testId?: string }): JSX.Element {
  return (
    <label className={`flex items-center gap-1.5 text-[11px] ${disabled ? 'opacity-50' : ''}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>{label}</span>
    </label>
  )
}
