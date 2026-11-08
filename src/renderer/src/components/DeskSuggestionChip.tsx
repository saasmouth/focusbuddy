import { useMemo, useState } from 'react'
import { useWidgetStore } from '../stores/widgets'
import { useLinksStore } from '../stores/links'
import { useNodeStore } from '../stores/nodes'
import {
  computeDeskSuggestion,
  isSuggestionDismissed,
  dismissSuggestion
} from '../lib/deskSuggestions'
import Icon from './Icon'
import { isShareRecipient } from '../lib/shareMode'

// The proactive next-step nudge for a desk. Shows one honest, deterministic
// suggestion (see deskSuggestions.ts) as a small dismissible chip. Acting on it
// opens the assistant, where the suggested phrase becomes a full build plan the
// user confirms. Dismissal is remembered per desk + suggestion so it never nags.
function DeskSuggestionChipInner(): JSX.Element | null {
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const widgets = useWidgetStore((s) => s.widgets)
  const links = useLinksStore((s) => s.links)
  const [dismissedTick, setDismissedTick] = useState(0)

  const suggestion = useMemo(() => {
    if (!activeTaskId) return null
    const onTask = widgets.filter((w) => w.taskId === activeTaskId)
    const s = computeDeskSuggestion(onTask, links)
    if (!s) return null
    if (isSuggestionDismissed(activeTaskId, s.id)) return null
    return s
    // dismissedTick forces a recompute after a dismissal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskId, widgets, links, dismissedTick])

  if (!activeTaskId || !suggestion) return null

  return (
    <div
      data-floating-menu
      data-testid="desk-suggestion"
      className="fb-floating-chrome absolute bottom-3 left-[calc(50%+var(--fb-dock-inset,0px)/2)] -translate-x-1/2 z-[44] max-w-[520px] flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full bg-[var(--surface-raised)] shadow-[0_0_0_1px_var(--edge-hairline),var(--shadow-cast),var(--shadow-inset-highlight)]"
    >
      <Icon name="lightbulb" size={14} className="text-[rgb(var(--accent))] shrink-0" />
      <span className="text-[11.5px] text-[var(--ink-80)] truncate">{suggestion.text}</span>
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('fb:open-assistant'))}
        title={`Ask the assistant: "${suggestion.ask}"`}
        data-testid="desk-suggestion-act"
        className="shrink-0 inline-flex items-center gap-1 h-6 px-2.5 rounded-full bg-[rgb(var(--accent))] text-white text-[11px] font-medium hover:bg-[rgb(var(--accent-hover))] transition-colors"
      >
        Set it up
      </button>
      <button
        onClick={() => {
          dismissSuggestion(activeTaskId, suggestion.id)
          setDismissedTick((t) => t + 1)
        }}
        title="Dismiss"
        data-testid="desk-suggestion-dismiss"
        className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded-full text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

// Suggestions are for the person working on the desk ("You have a table but no
// agent. Set it up"): to a visitor on a shared desk they are noise, and every
// one of them is an AI action the page would gate anyway.
export default function DeskSuggestionChip(): JSX.Element | null {
  if (isShareRecipient()) return null
  return <DeskSuggestionChipInner />
}
