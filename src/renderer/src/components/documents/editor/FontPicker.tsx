// A searchable font picker over the fonts bundled with the app (lib/googleFonts:
// Google Fonts families served from the app itself, never a font CDN) plus the
// generic stacks. Each family is previewed in its own typeface. Shared by the
// document, spreadsheet and slide editors.

import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { GENERIC_FONTS, GOOGLE_FONTS, loadGoogleFont, fontFamilyValue, familyLabel } from '../../../lib/googleFonts'

interface Props {
  // Current stored CSS font-family value ('' = default).
  value: string | undefined
  // Called with the CSS font-family value to store ('' clears to default).
  onChange: (cssValue: string) => void
  compact?: boolean
}

export default function FontPicker({ value, onChange, compact }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  const current = familyLabel(value)

  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

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
        data-testid="font-picker-btn"
        onClick={() => setOpen((v) => !v)}
        title="Font"
        className={`fb-tile h-7 inline-flex items-center gap-1 px-1.5 text-[11px] text-[var(--ink-70)] ${compact ? 'w-20' : 'w-28'}`}
      >
        <span className="truncate flex-1 min-w-0 text-left" style={{ fontFamily: value || undefined }}>{current}</span>
        <Icon name="expand_more" size={12} />
      </button>
      {open && (
        <div data-testid="font-picker-panel" className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-50 mt-1 left-0 w-56 p-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fonts…"
            className="fb-field w-full mb-1 px-2 py-1 text-[12px]"
          />
          <div className="max-h-64 overflow-auto">
            {GENERIC_FONTS.map((g) => (
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
        </div>
      )}
    </div>
  )
}
