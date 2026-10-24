import { useEffect, useState, useRef, lazy, Suspense } from 'react'
import type { Widget } from '@shared/types'
import { WIDGET_CATALOG } from '../../../lib/widgetCatalog'
import Icon from '../../Icon'
import { resolveWidget } from './widgetLookup'
import { normaliseEmbedDisplay, type EmbedDisplay } from '../../../lib/widgetSurface'
// Lazy, to break the document <-> widget import cycle. See
// EmbeddedWidgetBody for why the cycle is legitimate and cannot be removed.
const EmbeddedWidgetBody = lazy(() => import('./EmbeddedWidgetBody'))

// A LIVE, EDITABLE work widget inside a document, slide, diagram, design or
// drawing. It resolves fresh on every mount, so reopening shows current
// content, and it never pretends: a deleted widget renders an explicit
// missing state rather than a fabricated preview.
//
// It used to be read-only, and 242 lines of it: a second implementation of
// each kind, which could drift from what the desk showed and could not be
// typed into. It now renders through `renderWidget`, the same switch the
// canvas and the full-pane view use, so there is one renderer and editing
// comes for free — the widget store routes a write by id, a desk widget to
// its row and a `wf:<file id>` to its file, which fans out to every other
// instance of that file.
//
// NO DELETE IS OFFERED HERE, deliberately. `remove` on a `wf:` id trashes the
// FILE and every desk instance of it (stores/widgets.ts), so a stray × inside
// a document would destroy an object that lives in Files and on other desks.
// The components renderWidget draws carry their own desk frame, × included,
// so the body is rendered as NOT removable (EmbeddedWidgetBody, and
// WidgetRemovableContext in lib/widgetSurface): the frame then offers no
// remove tool, on its header or in its "…" menu. Removing the EMBED is the
// host editor's job: delete the node, not the widget.



// Flatten a cell value to display text. Select ids map to their option labels;
// everything unrenderable shows as a dash rather than an invented value.




// The kinds this embed renders with real content. Text kinds and cards go
// through WidgetPreview (the same renderer the minimap magnifier trusts);
// tables get real rows; todo-style markdown gets a checklist. Anything else
// falls to an honest placeholder that names the kind.


interface Props {
  widgetId: string
  /** This placement's choice: the content alone, or the original object. */
  display?: EmbedDisplay
  /** How the host saves a new choice. Absent = the host cannot store one, so no toggle is offered. */
  onDisplayChange?: (display: EmbedDisplay) => void
}

export default function WidgetEmbed({ widgetId, display: displayProp, onDisplayChange }: Props): JSX.Element {
  const display = normaliseEmbedDisplay(displayProp)
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'missing' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; widget: Widget; deskTitle: string }
  >({ phase: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })
    resolveWidget(widgetId)
      .then((res) => {
        if (!alive) return
        setState(res ? { phase: 'ready', widget: res.widget, deskTitle: res.deskTitle } : { phase: 'missing' })
      })
      .catch((e) => {
        if (alive) setState({ phase: 'error', message: (e as Error).message })
      })
    return () => {
      alive = false
    }
  }, [widgetId])

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setBox({ width: Math.round(r.width), height: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [state.phase])

  // A press-and-drag in the content must never become a native HTML drag of
  // the whole embed. A document node is draggable, and the browser fires
  // dragstart on that DRAGGABLE ANCESTOR (not on what was pressed) and then
  // cancels the pointer stream after its first point: a pen stroke on an
  // embedded scratchpad became a dot. So while a press that began in the
  // content is held, the nearest draggable ancestor is made undraggable, and
  // restored on release. The grip is outside the content, so it still drags.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onDown = (): void => {
      const host = el.parentElement?.closest<HTMLElement>('[draggable="true"]')
      if (!host) return
      host.setAttribute('draggable', 'false')
      const restore = (): void => {
        host.setAttribute('draggable', 'true')
        window.removeEventListener('pointerup', restore, true)
        window.removeEventListener('pointercancel', restore, true)
      }
      window.addEventListener('pointerup', restore, true)
      window.addEventListener('pointercancel', restore, true)
    }
    el.addEventListener('pointerdown', onDown, true)
    return () => el.removeEventListener('pointerdown', onDown, true)
  }, [state.phase])

  const shell =
    'fb-card h-full w-full flex flex-col overflow-hidden'

  if (state.phase === 'loading') {
    return (
      <div className={shell} data-testid="widget-embed-loading">
        <div className="flex-1 flex items-center justify-center gap-1.5 text-[11px] text-[var(--ink-40)] p-3">
          <Icon name="autorenew" size={13} className="animate-spin" />
          <span>Loading work widget…</span>
        </div>
      </div>
    )
  }
  if (state.phase === 'missing' || state.phase === 'error') {
    return (
      <div className={shell} data-testid="widget-embed-missing">
        <div className="flex-1 flex flex-col items-center justify-center gap-1 text-[11px] text-[var(--ink-40)] p-3 text-center">
          <Icon name="link_off" size={18} />
          <span>{state.phase === 'missing' ? 'This work widget no longer exists' : state.message}</span>
        </div>
      </div>
    )
  }

  const { widget, deskTitle } = state
  const entry = WIDGET_CATALOG.find((e) => e.kind === widget.kind)
  // A table or a chart lays out to the pixels it is given, so the widget is
  // handed the box it actually has rather than the size it happens to carry
  // from the desk it came from.
  const sized = { ...widget, width: box.width || widget.width, height: box.height || widget.height }
  const label = widget.title || entry?.label || widget.kind
  return (
    <div
      className={`group/embed relative h-full w-full flex flex-col overflow-hidden ${display === 'data' ? '' : 'rounded-[var(--radius-card)]'}`}
      data-testid="widget-embed"
      data-embed-display={display}
      title={display === 'data' && deskTitle ? `${label} \u2014 from the desk \u201c${deskTitle}\u201d` : undefined}
    >
      {/* No title strip of its own any more: in 'object' the widget's own
          frame carries the title, and in 'data' there is meant to be none.
          The strip used to stack on top of the frame's header, two headers
          for one object. */}
      {onDisplayChange && (
        <button
          type="button"
          // Hover-revealed, and always reachable by keyboard: the choice is
          // the placement's, so it lives on the placement, not in a menu.
          className="fb-floating-chrome absolute right-1.5 top-1.5 z-20 inline-flex items-center gap-1 rounded-md px-1.5 h-6 text-[11px] font-medium bg-[var(--surface-raised)] text-[var(--ink-70)] shadow-[0_0_0_1px_var(--edge-soft),var(--shadow-soft)] opacity-0 group-hover/embed:opacity-100 focus-visible:opacity-100 transition-opacity"
          data-testid="embed-display-toggle"
          aria-pressed={display === 'object'}
          title={display === 'data' ? 'Show the original object, with its header and tools' : 'Show only the data, without the frame'}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDisplayChange(display === 'data' ? 'object' : 'data')
          }}
        >
          <Icon name={display === 'data' ? 'web_asset' : 'table_rows'} size={13} />
          {display === 'data' ? 'Original' : 'Data only'}
        </button>
      )}
      {/* MOVE GRIP. The content below belongs to the widget: a press that
          starts in it draws, types or scrolls there and never moves the
          object. Every host moves an embed from here instead — a document's
          node drag, a slide or design element, a diagram node, a drawing
          object. Before this, a pen stroke on an embedded scratchpad was
          taken by the host as "move the object", and only dots were drawn. */}
      <span
        className="fb-floating-chrome absolute left-1.5 top-1.5 z-20 inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--surface-raised)] text-[var(--ink-50)] shadow-[0_0_0_1px_var(--edge-soft),var(--shadow-soft)] cursor-grab active:cursor-grabbing opacity-0 group-hover/embed:opacity-100 transition-opacity"
        data-embed-grip=""
        data-drag-handle=""
        data-testid="embed-grip"
        title="Drag to move"
        aria-hidden
      >
        <Icon name="drag_indicator" size={14} />
      </span>
      <div
        ref={bodyRef}
        // EMBED_INTERACTIVE: hosts leave presses that start here to the widget.
        // nodrag / nopan / nowheel are the diagram canvas's own opt-outs.
        className="nodrag nopan nowheel flex-1 min-h-0 overflow-hidden"
        data-embed-interactive=""
      >
        <Suspense fallback={<div className="h-full w-full" aria-hidden />}>
          <EmbeddedWidgetBody widget={sized} display={display} />
        </Suspense>
      </div>
    </div>
  )
}
