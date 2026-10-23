// A searchable font picker over the fonts bundled with the app (lib/googleFonts:
// Google Fonts families served from the app itself, never a font CDN) plus the
// generic stacks. Each family is previewed in its own typeface. Shared by the
// document, spreadsheet and slide editors.
//
// The panel is portalled to <body> and positioned from the trigger. Inside the
// office shell the picker sits in the ContextBar's Row 2, which scrolls sideways
// (overflow-x: auto, and so clips vertically too): an absolutely positioned
// panel was cut to the 36px row and could not be used.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../../Icon'
import { barTip, useBarSlot } from '../../office/shell/primitives'
import { GENERIC_FONTS, GOOGLE_FONTS, loadGoogleFont, fontFamilyValue, familyLabel } from '../../../lib/googleFonts'

interface Props {
  // Current stored CSS font-family value ('' = default).
  value: string | undefined
  // Called with the CSS font-family value to store ('' clears to default).
  onChange: (cssValue: string) => void
  compact?: boolean
  /** Test id for the trigger (default font-picker-btn): a bar control keeps the id it had as a select (design-font-family, diagram-font, draw-text-family). */
  testid?: string
  /** Accessible name and tooltip of the trigger (default "Font"). */
  label?: string
  /** App families listed first, before the bundled ones (Diagrams' system stacks). */
  extra?: { label: string; value: string }[]
  /** The selection mixes families: the trigger says "Mixed". */
  mixed?: boolean
  /** Offer "Default" (clear to the app default). Apps whose text always carries a family turn it off. */
  allowDefault?: boolean
}

// The one font-family control of every office app's bar (SPEC §3.9): Write,
// Cells, Deck, Design, Diagrams and Draw all use this picker.
export default function FontPicker({ value, onChange, compact, testid = 'font-picker-btn', label = 'Font', extra, mixed, allowDefault = true }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const current = mixed ? 'Mixed' : extra?.find((e) => e.value === value)?.label ?? familyLabel(value)
  // In a BarCustom that is off (a read-only bar), the picker still SHOWS the
  // font -- seeing it is fine -- but does not open, and says why.
  const slot = useBarSlot()
  const off = slot.disabled
  useEffect(() => {
    if (off) setOpen(false)
  }, [off])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Anchor under the trigger, clamped to the window (224px wide, ~300 tall).
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      const w = 224
      const h = 300
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
      const below = r.bottom + 4
      const top = below + h > window.innerHeight - 8 && r.top - h - 4 > 8 ? r.top - h - 4 : below
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Ensure the current font is loaded so the trigger shows it correctly.
  useEffect(() => {
    if (value && !value.includes(',')) loadGoogleFont(familyLabel(value))
  }, [value])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return GOOGLE_FONTS.filter((f) => f.toLowerCase().includes(q)).slice(0, 60)
  }, [query])

  // Load the previews for the currently visible list.
  useEffect(() => {
    if (open) results.forEach((f) => loadGoogleFont(f))
  }, [open, results])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid={testid}
        data-bar-kind="font"
        aria-label={`${label}: ${current}`}
        aria-haspopup="dialog"
        aria-expanded={open && !off}
        disabled={off}
        onClick={() => !off && setOpen((v) => !v)}
        title={off ? barTip(label, undefined, slot.reason) : label}
        className={`fb-tile h-7 inline-flex items-center gap-1 px-1.5 text-[11px] text-[var(--ink-70)] disabled:opacity-60 disabled:cursor-not-allowed ${compact ? 'w-20' : 'w-28'}`}
      >
        <span className="truncate flex-1 min-w-0 text-left" style={{ fontFamily: value || undefined }}>{current}</span>
        <Icon name="expand_more" size={12} />
      </button>
      {open && !off && pos && createPortal(
        <div
          ref={panelRef}
          data-testid="font-picker-panel"
          role="dialog"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
            }
          }}
          className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in fixed z-[80] w-56 p-1.5"
          style={{ left: pos.left, top: pos.top }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fonts…"
            className="fb-field w-full mb-1 px-2 py-1 text-[12px]"
          />
          <div className="max-h-64 overflow-auto">
            {extra?.map((g) => (
              <button
                key={`x-${g.label}`}
                onClick={() => { onChange(g.value); setOpen(false) }}
                className={`w-full text-left px-2 py-1 text-[12.5px] rounded hover:bg-[var(--surface-sunken)] ${value === g.value ? 'bg-accent/10 text-accent' : ''}`}
                style={{ fontFamily: g.value || undefined }}
              >
                {g.label}
              </button>
            ))}
            {extra && extra.length > 0 && <div className="my-1 border-t border-[var(--edge-soft)]" />}
            {GENERIC_FONTS.filter((g) => allowDefault || g.value).map((g) => (
              <button
                key={g.label}
                onClick={() => { onChange(g.value); setOpen(false) }}
                className="w-full text-left px-2 py-1 text-[12.5px] rounded hover:bg-[var(--surface-sunken)]"
                style={{ fontFamily: g.value || undefined }}
              >
                {g.label}
              </button>
            ))}
            <div className="my-1 border-t border-[var(--edge-soft)]" />
            {results.map((f) => (
              <button
                key={f}
                onClick={() => { onChange(fontFamilyValue(f)); setOpen(false) }}
                className={`w-full text-left px-2 py-1 text-[13px] rounded hover:bg-[var(--surface-sunken)] ${current === f ? 'bg-accent/10 text-accent' : ''}`}
                style={{ fontFamily: `"${f}", sans-serif` }}
              >
                {f}
              </button>
            ))}
            {results.length === 0 && <div className="px-2 py-2 text-[12px] text-[var(--ink-40)]">No matching font</div>}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
