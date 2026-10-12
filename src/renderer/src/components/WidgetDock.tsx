import type { Widget } from '@shared/types'
import { useWidgetStore } from '../stores/widgets'
import { catalogFor } from '../lib/widgetCatalog'
import Icon from './Icon'
import { confirmDialog } from './plexi/PromptDialog'

function labelFor(w: Widget): string {
  if (w.title) return w.title
  if (w.kind === 'sticky' || w.kind === 'note') {
    const first = (w.content || '').split('\n')[0].trim()
    return first || catalogFor(w.kind)?.label || w.kind
  }
  if (w.content) {
    try {
      return new URL(w.content).hostname.replace(/^www\./, '')
    } catch {
      return w.content.slice(0, 24)
    }
  }
  return catalogFor(w.kind)?.label ?? w.kind
}

export default function WidgetDock(): JSX.Element | null {
  const widgets = useWidgetStore((s) => s.widgets)
  // Clicking a dock item centers that widget on the canvas at 100% (the same
  // "go to this widget" the minimap uses), rather than opening focus mode.
  const zoomToWidget = useWidgetStore((s) => s.zoomToWidget)
  const remove = useWidgetStore((s) => s.remove)
  const activeId = useWidgetStore((s) => s.activeWidgetId)

  // Sections are spatial markers — don't clutter the dock with them.
  const dockable = widgets.filter((w) => w.kind !== 'section')
  if (dockable.length === 0) return null

  return (
    <div className="border-t border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_95%,transparent)] backdrop-blur">
      <div className="px-3 py-2 flex items-center gap-2 overflow-x-auto">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-medium pr-1 shrink-0">
          On desk
        </span>
        {dockable.map((w) => {
          const entry = catalogFor(w.kind)
          const isActive = activeId === w.id
          return (
            <div key={w.id} className="group relative shrink-0">
              <button
                onClick={() => zoomToWidget(w.id)}
                title={`Go to ${labelFor(w)} on the canvas`}
                className={`inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-md border transition-colors text-xs max-w-[180px] ${
                  isActive
                    ? 'border-[var(--ink-90)] bg-[var(--ink-90)] text-[var(--surface-raised)]'
                    : 'border-[var(--edge-firm)] bg-[var(--surface-raised)] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <Icon name={entry?.icon ?? 'apps'} size={14} />
                <span className="truncate">{labelFor(w)}</span>
              </button>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  if (await confirmDialog({ title: 'Remove from the desk?', confirmLabel: 'Remove', danger: true })) {
                    void remove(w.id)
                  }
                }}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 absolute -top-1 -right-1 h-4 w-4 rounded-full bg-[var(--surface-raised)] border border-[var(--edge-firm)] hover:border-red-500 dark:hover:border-red-400 hover:text-red-700 dark:hover:text-red-400 text-[var(--ink-50)] inline-flex items-center justify-center transition-opacity"
                aria-label="Remove"
                title="Remove from desk"
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
