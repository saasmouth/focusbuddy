import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon'
import {
  WIDGET_CATALOG,
  groupedPickerEntries,
  type WidgetCatalogEntry
} from '../../lib/widgetCatalog'
import { effectiveQuickAddMap, useKeymap } from '../../lib/keymap'

// The prominent "Add widget" button, centred in the app header.
//
// It is here, and labelled, because the rail's version is not discoverable: it
// lives inside a panel that only appears when you hover a construction icon.
//
// LAYOUT: one VERTICAL COLUMN PER USE-CASE GROUP, columns side by side, and the
// strip scrolls horizontally when there are more columns than fit.
//
// It began as a single horizontal row of all 47 widgets, which is a lot to read
// sideways and told you nothing about what any of them was for. The groups come
// from WIDGET_USE_CASE_GROUPS, not from the catalog's `category` field: that
// field is the rail picker's taxonomy, and its 'Tools' bucket holds 22 of the
// 47 — Calc, Timer, Mind map, Desk agent and the URL hooks together — which is
// a list, not a grouping.
//
// Every item carries its quick-add key in grey. That is deliberate teaching:
// the shortcuts already exist and almost nobody knows, because the only place
// they were written down is the Cmd+/ reference. The keys come from
// effectiveQuickAddMap(), NOT from WIDGET_SHORTCUTS, because they are
// user-remappable and printing a default beside a key someone has changed
// would teach the wrong thing.

const PICKER_ENTRIES = WIDGET_CATALOG.filter((e) => !e.hideFromPicker)

export default function DeskAddWidget({
  onAdd,
  disabled
}: {
  onAdd: (entry: WidgetCatalogEntry) => void
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Subscribing to the overrides makes the printed keys update the moment they
  // are remapped in Settings, rather than at the next reload.
  const overrides = useKeymap((s) => s.overrides)

  const keys = useMemo(() => {
    return effectiveQuickAddMap()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides])

  // Search covers the label, the hint and the kind, so "sketch" finds the
  // Scratchpad by its hint and "webhook" finds "Send to a URL" by its kind.
  // The group name matches too: typing "numbers" gives you that whole column.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groupedPickerEntries(PICKER_ENTRIES)
    const all = groupedPickerEntries(PICKER_ENTRIES)
    return all
      .map((g) => ({
        name: g.name,
        entries: g.name.toLowerCase().includes(q)
          ? g.entries
          : g.entries.filter(
              (e) =>
                e.label.toLowerCase().includes(q) ||
                e.kind.toLowerCase().includes(q) ||
                (e.hint ?? '').toLowerCase().includes(q)
            )
      }))
      .filter((g) => g.entries.length > 0)
  }, [query])

  const firstMatch = groups[0]?.entries[0] ?? null

  useEffect(() => {
    if (!open) return
    function place(): void {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      setPos({ top: r.bottom + 6, left: r.left + r.width / 2 })
    }
    place()
    function onDoc(e: MouseEvent): void {
      if (popRef.current?.contains(e.target as Node)) return
      if (btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    window.addEventListener('resize', place)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      // Opening the menu and typing should just work.
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open])

  function pick(entry: WidgetCatalogEntry): void {
    onAdd(entry)
    setOpen(false)
  }

  // Wheel and two-finger swipe over this menu must move the MENU, never the
  // canvas underneath.
  //
  // The menu is portaled to document.body, but a React portal's events still
  // bubble up the REACT tree, and this component is rendered by Canvas — so
  // without stopPropagation the canvas's own onWheel pans and zooms the desk
  // while you are trying to scroll a menu sitting over it.
  //
  // stopPropagation is therefore unconditional. preventDefault is not: it is
  // only right when we are actually consuming the gesture to scroll the strip,
  // and a trackpad swipe is mostly-vertical even when the user means "move
  // along", so a vertical delta is translated into horizontal scroll.
  function onWheelStrip(e: React.WheelEvent<HTMLDivElement>): void {
    e.stopPropagation()
    const el = stripRef.current
    if (!el) return
    const canScrollX = el.scrollWidth > el.clientWidth + 1
    if (!canScrollX) return
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (horizontal === 0) return
    el.scrollLeft += horizontal
    e.preventDefault()
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="header-add-widget"
        title="Add a widget to this desk"
        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg bg-[rgb(var(--accent))] text-white text-[12px] font-semibold shadow-[0_2px_8px_-2px_rgb(var(--accent)/0.7)] hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Icon name="add" size={14} />
        <span>Add widget</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            data-floating-menu
            data-testid="header-add-widget-menu"
            role="dialog"
            aria-label="Add a widget"
            // stopPropagation here too: a wheel over the search row or the
            // footer is still a wheel over this menu, and must not reach the
            // canvas either.
            onWheel={(e) => e.stopPropagation()}
            className="fixed z-[210] max-w-[min(960px,calc(100vw-24px))] rounded-[var(--radius-card)] border border-[var(--edge-firm)] bg-[var(--surface-raised)] p-1.5"
            style={{
              top: pos.top,
              left: pos.left,
              transform: 'translateX(-50%)',
              boxShadow: 'var(--shadow-cast)',
              overscrollBehavior: 'contain'
            }}
          >
            <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
              <Icon name="search" size={14} className="text-[var(--ink-40)] shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && firstMatch) {
                    e.preventDefault()
                    pick(firstMatch)
                  }
                }}
                data-testid="add-widget-search"
                placeholder="Search widgets…"
                aria-label="Search widgets"
                className="flex-1 min-w-0 bg-transparent text-[12px] text-[var(--ink-80)] placeholder:text-[var(--ink-40)] outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                  aria-label="Clear search"
                  className="shrink-0 h-5 w-5 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:bg-[var(--surface-sunken)]"
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>

            {groups.length === 0 ? (
              <p
                data-testid="add-widget-no-matches"
                className="px-1.5 py-6 text-center text-[12px] text-[var(--ink-40)]"
              >
                Nothing matches “{query.trim()}”.
              </p>
            ) : (
              <div
                ref={stripRef}
                onWheel={onWheelStrip}
                data-testid="add-widget-groups"
                className="flex items-start gap-1 overflow-x-auto border-t border-[var(--edge-soft)] pt-1.5"
                style={{ overscrollBehavior: 'contain', maxHeight: 'min(60vh, 420px)' }}
              >
                {groups.map((g) => (
                  <div
                    key={g.name}
                    data-testid="add-widget-group"
                    data-group={g.name}
                    className="shrink-0 w-[172px] flex flex-col"
                  >
                    <div className="px-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-45,var(--ink-50))]">
                      {g.name}
                    </div>
                    {g.entries.map((entry) => (
                      <button
                        key={entry.kind}
                        type="button"
                        onClick={() => pick(entry)}
                        data-testid={`add-widget-${entry.kind}`}
                        title={entry.hint || entry.label}
                        className="w-full flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-row)] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] transition-colors text-left"
                      >
                        <Icon name={entry.icon} size={15} className="text-[var(--ink-60)] shrink-0" />
                        {/* Label then key, in that DOM order: the key must be
                            the last span for the contrast check in
                            headerAddWidget.spec.ts to find it. */}
                        <span className="flex-1 min-w-0 truncate text-[11.5px]">{entry.label}</span>
                        <span className="shrink-0 w-[14px] text-right text-[10px] font-mono text-[var(--ink-35,var(--ink-40))]">
                          {keys[entry.kind] ?? ''}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            <p className="px-1.5 pt-1.5 pb-0.5 text-[10.5px] text-[var(--ink-40)]">
              Press the grey key on the desk to drop one straight away — no menu needed.
            </p>
          </div>,
          document.body
        )}
    </>
  )
}
