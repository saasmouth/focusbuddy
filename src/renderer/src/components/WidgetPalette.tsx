import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CATEGORIES,
  DRAG_MIME,
  entriesByCategory,
  isAdvancedKind,
  type WidgetCatalogEntry
} from '../lib/widgetCatalog'
import { canCreateWidget } from '../lib/gating'
import { useCapabilityStore } from '../stores/capabilities'
import { promptUpgrade } from '../stores/upgradePrompt'
import Icon from './Icon'

interface Props {
  onAdd: (entry: WidgetCatalogEntry) => void
  onImport?: () => void
  onBringSynced?: () => void
  disabled: boolean
  // 'toolbar' is the compact accent chip in the desk toolbar. 'fab' is a large
  // round always-visible button anchored on the canvas surface, so adding a
  // widget is discoverable even when the toolbar wraps off on a small window.
  variant?: 'toolbar' | 'fab'
}

// Compact desk-objects picker.
//
// The previous design was a full-width horizontal strip pinned across the
// top of the canvas — at ~120px tall with 20+ chips, it routinely chewed
// 15-20% of vertical real estate even when collapsed. The new design is a
// single "+ Add" button in the toolbar that opens a portalled popover with
// the categorised chips. The popover closes on outside-click / Esc and is
// keyboard-friendly (Tab through chips, Enter to add). The picker itself
// is what shrank — what's IN it (the chips) is the same set, minus the
// redundant kinds we just folded into File.
export default function WidgetPalette({
  onAdd,
  onImport,
  onBringSynced,
  disabled,
  variant = 'toolbar'
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // The picker shows a small CORE set by default; the rest live behind this
  // expander so a first-run user isn't faced with the whole catalog at once.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const inButton = buttonRef.current?.contains(e.target as Node)
      const inPopover = popoverRef.current?.contains(e.target as Node)
      if (!inButton && !inPopover) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', () => setOpen(false))
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Anchor the popover under the button. Portal it into document.body so it
  // escapes the toolbar's overflow/transform stacking context. CLAMP both axes
  // to the viewport so the 340-wide popover never runs off the right edge (the
  // Add button sits on the right of the toolbar) and never spills below the
  // bottom — previously the right/bottom of the menu was unreachable on smaller
  // windows, hiding the lower catalog tiles (Diagram / Scratchpad).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      setPopoverPos(null)
      return
    }
    const POPOVER_W = 340
    const POPOVER_MAXH = Math.round(window.innerHeight * 0.6)
    const r = buttonRef.current.getBoundingClientRect()
    // Right-align the popover to the button when the button sits in the right
    // half (the canvas FAB), so it never runs off the right edge; otherwise
    // left-align. Clamp to the viewport either way.
    const preferRight = r.left > window.innerWidth / 2
    const rawLeft = preferRight ? r.right - POPOVER_W : r.left
    const left = Math.min(Math.max(8, rawLeft), window.innerWidth - POPOVER_W - 8)
    // Open below the button by default; if the button sits in the lower half of
    // the screen (the FAB), open ABOVE it so the whole menu stays on-screen.
    const openAbove = r.top > window.innerHeight / 2
    const top = openAbove
      ? Math.max(8, r.top - 6 - POPOVER_MAXH)
      : Math.min(r.bottom + 6, window.innerHeight - 80)
    setPopoverPos({ top, left })
  }, [open])

  // Reset the search and focus the box each time the picker opens.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setShowAdvanced(false)
      return
    }
    const id = window.setTimeout(() => searchRef.current?.focus(), 20)
    return () => window.clearTimeout(id)
  }, [open])

  const grouped = entriesByCategory()
  const q = query.trim().toLowerCase()
  function matches(entry: WidgetCatalogEntry): boolean {
    if (!q) return true
    return (
      entry.label.toLowerCase().includes(q) ||
      entry.kind.toLowerCase().includes(q) ||
      (entry.hint?.toLowerCase().includes(q) ?? false)
    )
  }
  // Live, admin-overridable capability map. A widget kind whose capability
  // resolves falsy for this user renders locked + opens the upgrade prompt
  // instead of creating. This is what makes the matrix gate the app.
  const caps = useCapabilityStore((s) => s.capabilities)

  // One catalog tile (locked -> upgrade prompt, else add/drag). Shared by the core
  // grid, the Advanced grid and the search results so they stay identical.
  function renderEntry(entry: WidgetCatalogEntry): JSX.Element {
    const locked = !canCreateWidget(caps, entry.kind)
    if (locked) {
      return (
        <button
          key={entry.kind}
          title={`${entry.label} is a Pro feature — click to upgrade`}
          onClick={() => {
            promptUpgrade(`The ${entry.label} widget is a Pro feature.`)
            setOpen(false)
          }}
          className="fb-tile relative flex flex-col items-center gap-1 px-2 py-2 text-[var(--ink-40)] text-[10px] leading-tight cursor-pointer transition-colors hover:border-accent/40"
          data-testid={`palette-locked-${entry.kind}`}
        >
          <span className="absolute top-1 right-1 text-accent">
            <Icon name="lock" size={10} />
          </span>
          <Icon name={entry.icon} size={18} className="opacity-50" />
          <span className="font-medium text-center opacity-70">{entry.label}</span>
        </button>
      )
    }
    return (
      <button
        key={entry.kind}
        title={entry.hint}
        draggable
        onClick={() => {
          onAdd(entry)
          setOpen(false)
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, entry.kind)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        className="fb-btn-surface flex flex-col items-center gap-1 px-2 py-2 hover:border-accent hover:bg-accent/5 dark:hover:bg-accent/10 text-[var(--ink-70)] text-[10px] leading-tight cursor-grab active:cursor-grabbing transition-colors"
        data-testid={`palette-add-${entry.kind}`}
      >
        <Icon name={entry.icon} size={18} className="text-[var(--ink-70)]" />
        <span className="font-medium text-center">{entry.label}</span>
      </button>
    )
  }

  return (
    <>
      {variant === 'fab' ? (
        <button
          ref={buttonRef}
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          // Large round always-visible add button on the canvas surface. Solid
          // accent so it reads as the primary "add something to this desk"
          // action no matter how the toolbar wraps.
          className="h-12 w-12 inline-flex items-center justify-center rounded-full bg-[rgb(var(--accent))] text-white shadow-lg hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40 disabled:cursor-not-allowed transition-transform active:scale-95"
          title="Add a widget or object to this desk"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Add a widget or object"
          data-testid="palette-fab-button"
        >
          <Icon name={open ? 'close' : 'add'} size={24} />
        </button>
      ) : (
        <button
          ref={buttonRef}
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          // Accent-tinted so the primary "create something" action is the most
          // visible control in the toolbar, in every theme (it keys off the
          // --accent token, not a fixed stone colour). Labelled "Add widget" so
          // its purpose is explicit rather than a generic "Add".
          className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            open
              ? 'bg-[rgb(var(--accent-hover))] text-white'
              : 'bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))]'
          }`}
          title="Add a widget to your desk"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="palette-add-button"
        >
          <Icon name="add" size={14} />
          <span>Add widget</span>
        </button>
      )}
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          data-floating-menu
          className="fb-glass-panel rounded-[var(--radius-card)] fb-pop-in fixed z-[200] w-[340px] max-h-[60vh] overflow-y-auto"
          style={{ top: popoverPos.top, left: popoverPos.left }}
          role="dialog"
          aria-label="Desk objects"
        >
          <div className="sticky top-0 z-10 bg-[var(--surface-raised)] px-3 py-2 border-b border-[var(--edge-soft)]">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
                Add to this desk
              </span>
              <button
                onClick={() => setOpen(false)}
                className="h-5 w-5 inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)]"
                aria-label="Close picker"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
            <div className="relative mt-2">
              <Icon
                name="search"
                size={13}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-40)]"
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search widgets and objects"
                data-testid="palette-search"
                className="fb-field w-full h-7 pl-7 pr-2 text-[12px] text-[var(--ink-90)] placeholder:text-[var(--ink-40)]"
              />
            </div>
          </div>
          <div className="p-3 flex flex-col gap-3">
            {/* Category sections. When searching, every match (core + advanced)
                shows. Otherwise the default view shows only the CORE set per
                category, with the rest tucked under the Advanced expander below. */}
            {CATEGORIES.map((cat) => {
              const items = grouped[cat].filter(
                (entry) => matches(entry) && (q ? true : !isAdvancedKind(entry.kind))
              )
              if (items.length === 0) return null
              return (
                <div key={cat}>
                  <div className="text-[9px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold mb-1.5">
                    {cat}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">{items.map(renderEntry)}</div>
                </div>
              )
            })}

            {/* Advanced expander — only in the default (non-search) view, and only
                when advanced widgets exist. Keeps the first-run surface small while
                every widget stays one tap away (nothing is removed). */}
            {!q && CATEGORIES.some((c) => grouped[c].some((e) => isAdvancedKind(e.kind))) && (
              <div className="border-t border-[var(--edge-soft)] pt-2">
                <button
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="w-full flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold hover:text-[var(--ink-80)]"
                  data-testid="palette-advanced-toggle"
                  aria-expanded={showAdvanced}
                >
                  <Icon name={showAdvanced ? 'expand_more' : 'chevron_right'} size={14} />
                  <span>Advanced</span>
                  <span className="ml-auto normal-case tracking-normal text-[var(--ink-40)] font-normal">
                    {showAdvanced ? 'hide' : 'more objects'}
                  </span>
                </button>
                {showAdvanced && (
                  <div className="mt-2 flex flex-col gap-3" data-testid="palette-advanced-section">
                    {CATEGORIES.map((cat) => {
                      const items = grouped[cat].filter((e) => isAdvancedKind(e.kind))
                      if (items.length === 0) return null
                      return (
                        <div key={cat}>
                          <div className="text-[9px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold mb-1.5">
                            {cat}
                          </div>
                          <div className="grid grid-cols-3 gap-1.5">{items.map(renderEntry)}</div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {q && !CATEGORIES.some((c) => grouped[c].some(matches)) && (
              <div className="text-[12px] text-[var(--ink-50)] text-center py-4" data-testid="palette-no-results">
                No widgets or objects match “{query}”.
              </div>
            )}
            {!q && onBringSynced && (
              <div className="border-t border-[var(--edge-soft)] pt-2">
                <div className="text-[9px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold mb-1.5">
                  From elsewhere
                </div>
                <button
                  onClick={() => {
                    onBringSynced()
                    setOpen(false)
                  }}
                  className="fb-btn-surface w-full flex items-center gap-2 px-2 py-2 hover:border-accent hover:bg-accent/5 dark:hover:bg-accent/10 text-[var(--ink-70)] text-[11px]"
                  data-testid="palette-bring-synced"
                >
                  <Icon name="link" size={14} className="text-accent" />
                  <div className="flex-1 text-left">
                    <div className="font-medium">Bring a synced widget…</div>
                    <div className="text-[9px] text-[var(--ink-50)]">
                      Live-linked copy from another task — edits mirror both ways
                    </div>
                  </div>
                </button>
              </div>
            )}
            {!q && onImport && (
              <div className="border-t border-[var(--edge-soft)] pt-2">
                <div className="text-[9px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold mb-1.5">
                  Import
                </div>
                <button
                  onClick={() => {
                    onImport()
                    setOpen(false)
                  }}
                  className="fb-btn-surface w-full flex items-center gap-2 px-2 py-2 hover:border-accent hover:bg-accent/5 dark:hover:bg-accent/10 text-[var(--ink-70)] text-[11px]"
                  data-testid="palette-import-file"
                >
                  <Icon name="upload_file" size={14} className="text-[var(--ink-70)]" />
                  <div className="flex-1 text-left">
                    <div className="font-medium">Import file…</div>
                    <div className="text-[9px] text-[var(--ink-50)]">
                      .txt / .md → note · .csv / .json → table
                    </div>
                  </div>
                </button>
              </div>
            )}
            {!q && (
              <div className="text-[10px] text-[var(--ink-50)] leading-snug border-t border-[var(--edge-soft)] pt-2 -mb-1">
                Tip: drag any tile onto the canvas to place it where you want, or click to add at the centre.
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
