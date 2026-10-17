import Icon from '../Icon'
import type { Widget } from '@shared/types'
import { isWidgetEmptyForSetup } from '../../lib/widgetSetup'
import { useWidgetSetup } from '../../stores/widgetSetup'

// The proactive "Set up with AI" affordance shown on an EMPTY widget the setup
// assistant supports. It answers the one question every empty widget should:
// "what should this become, based on the current desk?" Clicking opens the
// shared setup preview (useWidgetSetup), the same approve-before-apply flow the
// right-click "Build with AI" uses — this is just a more visible entry point,
// and it reaches the structured kinds (page, browser, …) too.
//
// Rendered inside the widget body over an empty widget. The overlay itself is
// pointer-transparent so it never blocks the widget's own UI; only the chip is
// clickable. It disappears the moment the widget has real content.
export default function WidgetSetupAffordance({ widget }: { widget: Widget }): JSX.Element | null {
  const start = useWidgetSetup((s) => s.start)
  if (!isWidgetEmptyForSetup(widget)) return null
  return (
    <div className="widget-nodrag pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center">
      <button
        onClick={(e) => {
          e.stopPropagation()
          start(widget.id)
        }}
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full fb-glass-chrome border border-[color:var(--glass-chrome-border)] shadow-md ring-1 ring-[rgb(var(--accent)/0.3)] px-2.5 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
        title="Set up this work widget with AI, based on what you're working on"
      >
        <Icon name="auto_awesome" size={12} />
        Set up with AI
      </button>
    </div>
  )
}
