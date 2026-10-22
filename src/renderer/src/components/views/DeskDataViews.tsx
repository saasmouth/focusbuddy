import type { Widget } from '@shared/types'
import Icon from '../Icon'
import PlexiiIcon, { PlexiiChipIcon } from '../PlexiiIcon'
import ViewSelector from './ViewSelector'
import { catalogFor } from '../../lib/widgetCatalog'
import { widgetDisplayName } from '../../lib/widgetDisplayName'
import { useNodeStore } from '../../stores/nodes'
import { useWidgetStore } from '../../stores/widgets'

// Four lightweight desk views (spec §3.4): the same desk objects rendered as a
// List, a Table, a Gallery of cards, or a Compact chip scan. All read the real
// widgets and open an object into focus on click. Kanban is the Columns status
// board; Timeline/Calendar are intentionally not here (they fit time-bound events,
// not arbitrary desk objects — forcing them would be low-value).

export type DataLayout = 'list' | 'table' | 'gallery' | 'compact'

const LAYOUT_META: Record<DataLayout, { label: string; icon: string }> = {
  list: { label: 'List', icon: 'view_list' },
  table: { label: 'Table', icon: 'table_rows' },
  gallery: { label: 'Gallery', icon: 'grid_view' },
  compact: { label: 'Compact', icon: 'density_small' }
}

const STATUS_LABEL: Record<string, string> = {
  todo: 'To sort',
  doing: 'In progress',
  done: 'Done',
  reference: 'Reference'
}

function relTime(ms: number): string {
  const d = Math.round((Date.now() - ms) / 86_400_000)
  if (d <= 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function DeskDataViews({
  taskId,
  widgets,
  layout
}: {
  taskId: string
  widgets: Widget[]
  layout: DataLayout
}): JSX.Element {
  const setActive = useNodeStore((s) => s.setActive)
  const setFocused = useWidgetStore((s) => s.setFocused)

  const items = widgets
    .filter((w) => !w.archived && w.kind !== 'section' && w.kind !== 'minimap')
    .sort((a, b) => b.updatedAt - a.updatedAt)

  function open(w: Widget): void {
    // setActive is the node store's ACTIVE DESK setter. It was being handed a
    // widget id, so no node matched and the app fell back to "All desks" --
    // clicking a card in Gallery, List, Table or Compact navigated away instead
    // of opening the object. It also wrote a task_switched trail entry naming a
    // widget id with a null title. The desk that owns the widget is what should
    // be active; that is a no-op when we are already on it.
    setActive(w.taskId)
    setFocused(w.id)
  }

  const meta = (w: Widget): { icon: string; label: string } => {
    const c = catalogFor(w.kind)
    return { icon: c?.icon ?? 'widgets', label: c?.label ?? w.kind }
  }

  const empty = (
    <div className="py-12 text-center text-[13px] text-[var(--ink-50)]">
      This desk has no objects yet. Add one on the canvas and it shows up here.
    </div>
  )

  const lm = LAYOUT_META[layout]

  return (
    <div
      className="absolute inset-y-0 right-0 left-[var(--fb-dock-inset,0px)] z-[60] bg-[var(--surface-sunken)] flex flex-col"
      data-testid={`data-view-${layout}`}
      data-desk-view={layout}
    >
      {/* Self-contained control bar so the view switcher is always reachable (the
          overlay covers the canvas breadcrumb), mirroring the Columns view. */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--edge-soft)] bg-[var(--surface-raised)]">
        <Icon name={lm.icon} size={16} className="text-[var(--ink-50)]" />
        <span className="text-[13px] font-medium text-[var(--ink-90)]">{lm.label}</span>
        <span className="text-[11px] text-[var(--ink-40)]">
          {items.length} object{items.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto">
          <ViewSelector taskId={taskId} />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-5xl mx-auto p-4">
        {items.length === 0 ? (
          empty
        ) : layout === 'table' ? (
          <div className="fb-card overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-[var(--ink-50)] border-b border-[var(--edge-soft)]">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((w) => {
                  const m = meta(w)
                  return (
                    <tr
                      key={w.id}
                      onClick={() => open(w)}
                      data-testid={`data-item-${w.id}`}
                      className="border-b border-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] last:border-b-0 hover:bg-[var(--surface-sunken)] cursor-pointer"
                    >
                      <td className="px-3 py-2 text-[13px] text-[var(--ink-100)]">
                        <span className="inline-flex items-center gap-2">
                          <PlexiiIcon kind="widget" id={w.kind} size={17} fallback={m.icon} fallbackClassName="text-[var(--ink-40)]" className="shrink-0" />
                          <span className="truncate">{widgetDisplayName(w)}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[12px] text-[var(--ink-60)]">{m.label}</td>
                      <td className="px-3 py-2 text-[12px] text-[var(--ink-60)]">
                        {w.status ? STATUS_LABEL[w.status] ?? w.status : '—'}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-[var(--ink-50)] fb-tabular">{relTime(w.updatedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : layout === 'gallery' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {items.map((w) => {
              const m = meta(w)
              return (
                <button
                  key={w.id}
                  onClick={() => open(w)}
                  data-testid={`data-item-${w.id}`}
                  className="fb-btn-surface flex flex-col items-start gap-2 p-3 text-left hover:border-[rgb(var(--accent))]/40"
                >
                  <PlexiiChipIcon
                    entity={{ kind: 'widget', id: w.kind }}
                    fallback={m.icon}
                    size={36}
                    glyphSize={18}
                    chipClassName="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-sunken)] text-[var(--ink-60)]"
                  />
                  <span className="block w-full truncate text-[13px] text-[var(--ink-100)]">{widgetDisplayName(w)}</span>
                  <span className="text-[11px] text-[var(--ink-50)]">{m.label}</span>
                </button>
              )
            })}
          </div>
        ) : layout === 'compact' ? (
          <div className="flex flex-wrap gap-1.5">
            {items.map((w) => {
              const m = meta(w)
              return (
                <button
                  key={w.id}
                  onClick={() => open(w)}
                  data-testid={`data-item-${w.id}`}
                  title={m.label}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-sunken)] px-2.5 h-7 text-[12px] text-[var(--ink-90)] hover:text-[rgb(var(--accent))]"
                >
                  <PlexiiIcon kind="widget" id={w.kind} size={15} fallback={m.icon} fallbackClassName="text-[var(--ink-40)]" className="shrink-0" />
                  <span className="max-w-[160px] truncate">{widgetDisplayName(w)}</span>
                </button>
              )
            })}
          </div>
        ) : (
          // list
          <ul className="space-y-1">
            {items.map((w) => {
              const m = meta(w)
              return (
                <li key={w.id}>
                  <button
                    onClick={() => open(w)}
                    data-testid={`data-item-${w.id}`}
                    className="fb-btn-surface w-full flex items-center gap-3 px-3 py-2 text-left hover:border-[rgb(var(--accent))]/40"
                  >
                    <PlexiiIcon kind="widget" id={w.kind} size={18} fallback={m.icon} fallbackClassName="text-[var(--ink-40)]" className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[var(--ink-100)]">{widgetDisplayName(w)}</span>
                      <span className="block text-[11px] text-[var(--ink-50)]">{m.label}</span>
                    </span>
                    {w.status && (
                      <span className="shrink-0 text-[10.5px] px-2 py-0.5 rounded-full bg-[var(--surface-sunken)] text-[var(--ink-60)]">
                        {STATUS_LABEL[w.status] ?? w.status}
                      </span>
                    )}
                    <span className="shrink-0 text-[11px] text-[var(--ink-50)] fb-tabular">{relTime(w.updatedAt)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        </div>
      </div>
    </div>
  )
}
