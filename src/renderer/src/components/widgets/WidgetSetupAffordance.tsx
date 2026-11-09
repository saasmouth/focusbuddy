import { useLayoutEffect, useRef, useState } from 'react'
import Icon from '../Icon'
import type { Widget } from '@shared/types'
import { isWidgetEmptyForSetup } from '../../lib/widgetSetup'
import { useWidgetSetup } from '../../stores/widgetSetup'
import { chooseChipSlot, type ChipSlot } from '../../lib/setupChipSlot'
import { WIDGET_AI } from '../../lib/widgetAiFamilies'

const CONTROLS = 'button,[role="button"],select,input:not([type="hidden"]),a[href]'

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
  const overlay = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const [slot, setSlot] = useState<ChipSlot>('bottom')
  // A calculator or colour picker has nothing to set up (lib/widgetAiFamilies),
  // and its keys are exactly where the chip would sit.
  const show = isWidgetEmptyForSetup(widget) && WIDGET_AI[widget.kind]?.family !== 'naming'

  // Keep clear of the widget's own controls, whatever size it is now and
  // whatever it mounts after this does.
  useLayoutEffect(() => {
    if (!show) return
    const body = overlay.current?.parentElement
    if (!body) return
    const measure = (): void => {
      const button = chip.current
      if (!button) return
      const box = body.getBoundingClientRect()
      const own = button.getBoundingClientRect()
      const controls = Array.from(body.querySelectorAll<HTMLElement>(CONTROLS))
        .filter((el) => !overlay.current?.contains(el))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
      const scale = body.offsetWidth > 0 ? box.width / body.offsetWidth : 1
      setSlot(chooseChipSlot({ body: box, chip: own, controls, inset: 8 * scale }))
    }
    measure()
    let frame = 0
    const soon = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const resized = new ResizeObserver(soon)
    resized.observe(body)
    const changed = new MutationObserver(soon)
    changed.observe(body, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      resized.disconnect()
      changed.disconnect()
    }
  }, [show])

  if (!show) return null
  return (
    <div
      ref={overlay}
      data-setup-chip-slot={slot ?? 'none'}
      className={`widget-nodrag pointer-events-none absolute inset-x-0 z-10 flex justify-center ${slot === 'top' ? 'top-2' : 'bottom-2'} ${slot === null ? 'invisible' : ''}`}
    >
      <button
        ref={chip}
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
