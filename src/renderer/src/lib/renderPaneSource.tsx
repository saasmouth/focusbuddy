// The SINGLE dispatch point from a PaneSource to a rendered pane body (spec §5).
// Adding a new pane content kind = one case here + one PaneSource variant. Widget
// content is resolved by id from the passed widget list so a saved view degrades
// gracefully when the referenced widget is gone (spec §7) instead of crashing.

import type { PaneSource, Widget } from '@shared/types'
import { renderWidgetInline } from './renderWidgetInline'
import FocusAddSurface from '../components/focus/FocusAddSurface'
import FocusChatSurface from '../components/focus/FocusChatSurface'
import Icon from '../components/Icon'

interface PaneRenderDeps {
  // All live widgets — used to resolve a { kind:'widget', widgetId } source.
  widgets: Widget[]
  // Chrome surfaces need a way to focus a freshly created/opened widget. In split
  // mode this promotes the new widget into the acting pane (wired by SplitGrid).
  onOpenWidget: (widgetId: string) => void
}

// A calm, non-crashing placeholder for a pane whose content can't be shown —
// either a removed widget (saved view) or a reserved-but-unbuilt kind (meet).
function PanePlaceholder({ icon, title, note }: { icon: string; title: string; note: string }): JSX.Element {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-2 text-center px-6 bg-[var(--surface-sunken)]">
      <Icon name={icon} size={28} className="text-[var(--ink-40)]" />
      <div className="text-sm font-medium text-[var(--ink-70)]">{title}</div>
      <div className="text-xs text-[var(--ink-40)] max-w-[36ch]">{note}</div>
    </div>
  )
}

export function renderPaneSource(source: PaneSource, deps: PaneRenderDeps): JSX.Element | null {
  switch (source.kind) {
    case 'widget': {
      const w = deps.widgets.find((x) => x.id === source.widgetId)
      if (!w) {
        return (
          <PanePlaceholder
            icon="help"
            title="Work widget unavailable"
            note="This work widget was removed or moved off the desk. Drag another tab in to fill this pane."
          />
        )
      }
      return renderWidgetInline(w)
    }
    case 'chrome':
      return source.tab === 'add' ? (
        <FocusAddSurface onOpenWidget={deps.onOpenWidget} />
      ) : (
        <FocusChatSurface onOpenWidget={deps.onOpenWidget} />
      )
    case 'meet':
      // Reserved for PlexiMeet. Renders a placeholder in v1 so the pane model,
      // drag, resize, and save all work end-to-end before live video lands.
      return (
        <PanePlaceholder
          icon="videocam"
          title="PlexiMeet"
          note="Live video panes are coming. This pane is reserved and will hold your meeting here."
        />
      )
    default:
      return null
  }
}
