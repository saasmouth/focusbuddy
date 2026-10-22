import { useEffect, useMemo, useState } from 'react'
import type { Widget } from '@shared/types'
import { WIDGET_CATALOG } from '../../../lib/widgetCatalog'
import PlexiiIcon from '../../PlexiiIcon'
import Icon from '../../Icon'
import { listDesksWithWidgets, listDesklessWidgetFiles, type DeskWidgets } from './widgetLookup'

// The work widget picker. Lists the widgets that are on no desk first —
// since 4.3.32 that is most of them — then every desk with its own
// embeddable widgets, filterable by widget title, kind or desk name. Selecting
// a widget hands its id back to the caller, which inserts the embed. Purely a
// chooser: it never mutates widgets or desks.

interface Props {
  onPick: (widgetId: string) => void
  onClose: () => void
}

function widgetLabel(w: Widget): string {
  const entry = WIDGET_CATALOG.find((e) => e.kind === w.kind)
  return w.title || entry?.label || w.kind
}

export default function WidgetPickerDialog({ onPick, onClose }: Props): JSX.Element {
  const [desks, setDesks] = useState<DeskWidgets[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    // Desks AND the work widgets that are on no desk. Since 4.3.32 a work
    // widget is a file, so most of them live in Files rather than on a desk;
    // listing only desks made the picker look complete while hiding the
    // majority of what a person could insert.
    Promise.all([listDesksWithWidgets(), listDesklessWidgetFiles()])
      .then(([d, loose]) => {
        if (!alive) return
        setDesks(
          loose.length
            ? [{ desk: { id: '__files__', title: 'In Files (on no desk)' } as DeskWidgets['desk'], widgets: loose }, ...d]
            : d
        )
      })
      .catch((e) => {
        if (alive) setError((e as Error).message)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    if (!desks) return []
    const q = query.trim().toLowerCase()
    if (!q) return desks
    return desks
      .map((d) => {
        const deskHit = d.desk.title.toLowerCase().includes(q)
        const widgets = deskHit
          ? d.widgets
          : d.widgets.filter(
              (w) => widgetLabel(w).toLowerCase().includes(q) || w.kind.toLowerCase().includes(q)
            )
        return { ...d, widgets }
      })
      .filter((d) => d.widgets.length > 0)
  }, [desks, query])

  const totalWidgets = desks?.reduce((n, d) => n + d.widgets.length, 0) ?? 0

  return (
    <div
      className="fb-scrim fixed inset-0 z-[200] flex items-center justify-center"
      onMouseDown={onClose}
      data-testid="widget-picker"
    >
      <div
        className="fb-card w-[460px] max-w-[92%] max-h-[76vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-2 px-4 pt-3.5 pb-2.5">
          <Icon name="widgets" size={16} className="text-accent" />
          <h3 className="text-[14px] font-semibold text-[var(--ink-90)]">Work widget from a desk</h3>
          <button onClick={onClose} className="ml-auto icon-btn" title="Close" aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="shrink-0 px-4 pb-2.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search work widgets or desks…"
            data-testid="widget-picker-search"
            className="fb-field w-full px-2.5 py-1.5 text-[13px]"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-2 pb-2.5">
          {error && <div className="px-2 py-3 text-[12px] text-red-600 dark:text-red-400">{error}</div>}
          {!error && desks == null && (
            <div className="px-2 py-3 text-[12px] text-[var(--ink-40)] flex items-center gap-1.5">
              <Icon name="autorenew" size={13} className="animate-spin" />
              <span>Loading desks…</span>
            </div>
          )}
          {!error && desks != null && totalWidgets === 0 && (
            <div className="px-2 py-3 text-[12px] text-[var(--ink-40)]">
              No work widgets on any desk yet. Add a work widget to a desk first, then embed it here.
            </div>
          )}
          {!error && desks != null && totalWidgets > 0 && filtered.length === 0 && (
            <div className="px-2 py-3 text-[12px] text-[var(--ink-40)]">Nothing matches that search.</div>
          )}
          {filtered.map((d) => (
            <div key={d.desk.id} className="mb-1.5">
              <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--ink-40)]">
                <Icon name="desktop_windows" size={12} />
                <span className="truncate">{d.desk.title || 'Untitled desk'}</span>
              </div>
              {d.widgets.length === 0 && !query && (
                <div className="px-2 pb-1 text-[11px] text-[var(--ink-40)]">No embeddable work widgets on this desk.</div>
              )}
              {d.widgets.map((w) => {
                const entry = WIDGET_CATALOG.find((e) => e.kind === w.kind)
                return (
                  <button
                    key={w.id}
                    onClick={() => onPick(w.id)}
                    data-testid={`widget-picker-item-${w.id}`}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-accent/[0.07]"
                  >
                    <PlexiiIcon kind="widget" id={w.kind} size={18} fallback={entry?.icon ?? 'widgets'} className="shrink-0" fallbackClassName="text-[var(--ink-50)]" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] text-[var(--ink-90)] truncate">{widgetLabel(w)}</span>
                      <span className="block text-[10px] text-[var(--ink-40)]">{entry?.label ?? w.kind}</span>
                    </span>
                    <Icon name="add" size={14} className="text-[var(--ink-30)] shrink-0" />
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
