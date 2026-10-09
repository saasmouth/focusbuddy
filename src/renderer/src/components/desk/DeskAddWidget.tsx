import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon'
import { WIDGET_CATALOG, type WidgetCatalogEntry } from '../../lib/widgetCatalog'
import { effectiveQuickAddMap, useKeymap } from '../../lib/keymap'

// The prominent "Add widget" button, centred in the app header.
//
// It is here, and labelled, because the rail's version is not discoverable: it
// lives inside a panel that only appears when you hover a construction icon.
// An icon-only purple plus in the rail's collapsed header was tried and read
// as a bare "+" with nothing to say what it did, so the rail went back to what
// it was and the prominent control moved here.
//
// THE DROP-DOWN IS HORIZONTAL and every item carries its quick-add key in grey.
// That is the point of it: these shortcuts already exist and almost nobody
// knows, because the only place they were written down is the Cmd+/ reference.
// Putting the key beside the thing it makes, every time you reach for the
// mouse, is how it gets learned — the menu teaches its own replacement.
//
// The keys come from effectiveQuickAddMap(), NOT from WIDGET_SHORTCUTS: they
// are user-remappable, and printing the default next to a key someone has
// changed would teach the wrong thing. Entries with the shortcut disabled show
// no key rather than a stale one.

export default function DeskAddWidget({
  onAdd,
  disabled
}: {
  onAdd: (entry: WidgetCatalogEntry) => void
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  // Subscribing to the overrides makes the printed keys update the moment they
  // are remapped in Settings, rather than at the next reload.
  const overrides = useKeymap((s) => s.overrides)

  const items = useMemo(() => {
    const keys = effectiveQuickAddMap()
    return WIDGET_CATALOG.filter((e) => !e.hideFromPicker).map((e) => ({
      entry: e,
      key: keys[e.kind] ?? null
    }))
    // `overrides` is the dependency that matters; effectiveQuickAddMap reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides])

  // The ones with a key lead. Someone scanning for "what can I type?" should
  // not have to hunt past a dozen entries that answer "nothing".
  const withKeys = items.filter((i) => i.key)
  const rest = items.filter((i) => !i.key)

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

  function pick(entry: WidgetCatalogEntry): void {
    onAdd(entry)
    setOpen(false)
  }

  const Chip = ({ entry, k }: { entry: WidgetCatalogEntry; k: string | null }): JSX.Element => (
    <button
      type="button"
      onClick={() => pick(entry)}
      data-testid={`add-widget-${entry.kind}`}
      title={entry.hint || entry.label}
      className="shrink-0 w-[84px] flex flex-col items-center gap-1 px-1.5 py-2 rounded-[var(--radius-row)] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] transition-colors"
    >
      <Icon name={entry.icon} size={18} className="text-[var(--ink-60)]" />
      <span className="text-[11px] leading-tight text-center truncate w-full">{entry.label}</span>
      {/* The teaching bit. Lighter than the label on purpose: present when you
          look for it, quiet when you are not. */}
      <span className="h-[14px] text-[10px] font-mono text-[var(--ink-35,var(--ink-40))]">
        {k ?? ''}
      </span>
    </button>
  )

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
            // Centred under the button and laid out as ONE horizontal strip
            // that scrolls, rather than a grid: a single row keeps every item
            // the same distance from the button and keeps the shortcut column
            // readable straight across.
            className="fixed z-[210] max-w-[min(900px,calc(100vw-24px))] rounded-[var(--radius-card)] border border-[var(--edge-firm)] bg-[var(--surface-raised)] p-1.5"
            style={{ top: pos.top, left: pos.left, transform: 'translateX(-50%)', boxShadow: 'var(--shadow-cast)' }}
          >
            <div className="flex items-stretch gap-0.5 overflow-x-auto">
              {withKeys.map(({ entry, key }) => (
                <Chip key={entry.kind} entry={entry} k={key} />
              ))}
              {withKeys.length > 0 && rest.length > 0 && (
                <div aria-hidden className="w-px self-stretch bg-[var(--edge-soft)] mx-1 shrink-0" />
              )}
              {rest.map(({ entry }) => (
                <Chip key={entry.kind} entry={entry} k={null} />
              ))}
            </div>
            <p className="px-1.5 pt-1.5 pb-0.5 text-[10.5px] text-[var(--ink-40)]">
              Press the grey key on the desk to drop one straight away — no menu needed.
            </p>
          </div>,
          document.body
        )}
    </>
  )
}
