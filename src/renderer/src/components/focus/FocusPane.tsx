import type { Pane, Widget } from '@shared/types'
import { catalogFor, fitsPaneFor } from '../../lib/widgetCatalog'
import { renderPaneSource } from '../../lib/renderPaneSource'
import Icon from '../Icon'

interface Props {
  pane: Pane
  widgets: Widget[]
  isActive: boolean
  // Only shown when the split has >1 pane — a single pane has no per-pane chrome
  // (it reads as the classic focus card).
  showChrome: boolean
  onActivate: (paneId: string) => void
  onClose: (paneId: string) => void
  onOpenWidget: (widgetId: string) => void
}

// One tile in the split grid: a titled, framed pane whose body is dispatched from
// its PaneSource. Marked `data-focus-no-exit` so clicking pane chrome never
// dismisses focus mode (the overlay's one-press-exit walk respects that flag).
// The active pane carries an accent ring; clicking anywhere in a pane makes it
// the keyboard-focus target (spec §6.3).
export default function FocusPane({
  pane,
  widgets,
  isActive,
  showChrome,
  onActivate,
  onClose,
  onOpenWidget
}: Props): JSX.Element {
  const { source } = pane

  // Title + glyph for the pane header, derived from the source.
  let title = 'Pane'
  let glyph = 'apps'
  if (source.kind === 'widget') {
    const w = widgets.find((x) => x.id === source.widgetId)
    const entry = w ? catalogFor(w.kind) : null
    title = w?.title || entry?.label || 'Work widget'
    glyph = entry?.icon ?? 'apps'
  } else if (source.kind === 'chrome') {
    title = source.tab === 'add' ? 'Add' : 'AI Chat'
    glyph = source.tab === 'add' ? 'add' : 'smart_toy'
  } else if (source.kind === 'meet') {
    title = 'PlexiiMeet'
    glyph = 'videocam'
  }

  // How the body sits in the pane. Short/atmospheric widgets (sticky, note, …)
  // are framed as a contained card on the pane's calm surface instead of bleeding
  // their coloured body edge-to-edge (the redesign's sticky-pane fix). Chrome and
  // meet, and every scroll/fill widget, fill the pane.
  const fit =
    source.kind === 'widget'
      ? fitsPaneFor(widgets.find((x) => x.id === source.widgetId)?.kind ?? 'sticky')
      : 'fill'

  return (
    <div
      data-focus-no-exit
      data-testid={`focus-pane-${pane.id}`}
      data-active={isActive ? 'true' : 'false'}
      onMouseDownCapture={() => onActivate(pane.id)}
      className={[
        // flex-1 + full size → the pane fills its tile edge-to-edge (no void).
        // A float shadow lifts each pane off the blurred backdrop so it reads as an
        // independent floating tile (the mock's "floating tabs" feel), not a box
        // inside a box — the outer focus card is dissolved when split.
        'relative flex-1 w-full h-full flex flex-col min-h-0 min-w-0 overflow-hidden bg-[var(--surface-raised)]',
        'rounded-xl border transition-colors duration-150 fb-pane-float',
        isActive
          ? 'border-[rgb(var(--accent))] ring-1 ring-inset ring-[rgb(var(--accent))]'
          : 'border-[var(--edge-soft)]'
      ].join(' ')}
    >
      {showChrome && (
        <div className="px-3 py-1.5 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex items-center gap-2 shrink-0">
          <Icon
            name={glyph}
            size={14}
            filled={isActive}
            className={isActive ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-60)]'}
          />
          <span className="text-xs font-medium text-[var(--ink-80)] flex-1 min-w-0 truncate">{title}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose(pane.id)
            }}
            className="icon-btn h-6 w-6"
            aria-label={`Close ${title} pane`}
            title="Remove pane"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
      {fit === 'center' ? (
        // Short/atmospheric widget: centered, contained card on the pane's calm
        // surface. overflow-auto so a genuinely tall note in a small quad cell
        // scrolls instead of overflowing; the max-width keeps it from stretching
        // into a lost slab. This is the sticky-pane fix.
        <div className="flex-1 min-h-0 overflow-auto grid place-items-center p-4 bg-[var(--surface-raised)]">
          <div className="w-full max-w-[min(100%,340px)] max-h-full overflow-auto rounded-lg shadow-md ring-1 ring-[var(--edge-soft)]">
            {renderPaneSource(source, { widgets, onOpenWidget })}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden">
          {renderPaneSource(source, { widgets, onOpenWidget })}
        </div>
      )}
    </div>
  )
}
