import { useEffect, useState, useRef, lazy, Suspense } from 'react'
import type { Widget } from '@shared/types'
import { WIDGET_CATALOG } from '../../../lib/widgetCatalog'
import Icon from '../../Icon'
import PlexiiIcon from '../../PlexiiIcon'
import { resolveWidget } from './widgetLookup'
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
}

export default function WidgetEmbed({ widgetId }: Props): JSX.Element {
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
  return (
    <div className={shell} data-testid="widget-embed">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)]">
        <PlexiiIcon kind="widget" id={widget.kind} size={16} fallback={entry?.icon ?? 'widgets'} fallbackClassName="text-accent" className="shrink-0" />
        <span className="text-[12px] font-medium text-[var(--ink-90)] truncate">
          {widget.title || entry?.label || widget.kind}
        </span>
        {deskTitle && (
          <span className="ml-auto text-[10px] text-[var(--ink-40)] truncate" title={`From the desk "${deskTitle}"`}>
            {deskTitle}
          </span>
        )}
      </div>
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-hidden">
        {/* THE REAL COMPONENT, not a preview of it.
            This was 242 lines that re-implemented each kind read-only, which
            meant two renderers to keep in step and an embed that could show
            something the desk did not. renderWidget is the switch the canvas
            and the full-pane view already use, so what you see here is what
            the desk shows, and it is EDITABLE: the widget store routes a
            write by id — a desk widget to its row, a `wf:` id to its file,
            which fans out to every other instance.
            'embedded' fills the box and cannot be dragged, so no desk
            coordinates are written back from inside a document. */}
        <Suspense fallback={<div className="h-full w-full" aria-hidden />}>
          <EmbeddedWidgetBody widget={sized} />
        </Suspense>
      </div>
    </div>
  )
}
