import { useCallback, useEffect, useState, useRef, lazy, Suspense } from 'react'
import type { Widget } from '@shared/types'
import { WIDGET_CATALOG } from '../../../lib/widgetCatalog'
import Icon from '../../Icon'
import { resolveWidget } from './widgetLookup'
import { normaliseEmbedDisplay, type EmbedDisplay } from '../../../lib/widgetSurface'
import { hasOutputView, type NaturalShape } from './embedOutputKind'
import { useWidgetStore } from '../../../stores/widgets'
import { useWidgetFilesStore } from '../../../stores/widgetFiles'
import { isWidgetFilePaneId, widgetFileIdFromGroup, widgetFromFile } from '@shared/widgetFiles'
import { documentIdFromEmbed } from '@shared/documentEmbedId'
import { onWidgetWrite } from '../../../lib/widgetWrites'
// Lazy, to break the document <-> widget import cycle. See
// EmbeddedWidgetBody for why the cycle is legitimate and cannot be removed.
const EmbeddedWidgetBody = lazy(() => import('./EmbeddedWidgetBody'))
// Lazy for the same reason: the output renderers reach the stores, and the
// Write editor's extensions reach this file through the embed node.
const EmbedOutput = lazy(() => import('./EmbedOutput'))

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
// THE WIDGET IS NEVER DELETED HERE, deliberately. `remove` on a `wf:` id
// trashes the FILE and every desk instance of it (stores/widgets.ts), so a
// stray × inside a document would destroy an object that lives in Files and on
// other desks. The components renderWidget draws carry their own desk frame,
// × included, so the body is rendered as NOT removable (EmbeddedWidgetBody, and
// WidgetRemovableContext in lib/widgetSurface): the frame then offers no
// remove tool, on its header or in its "…" menu. What the embed does offer is
// Remove from the HOST (owner, 4.3.44: "remove it from the embed parent,
// without delete being the only option"): the host passes `onRemove`, which
// takes out the node or element and leaves the widget where it lives.



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
  /** Takes the embed out of its host (the placement only). Absent = not offered. */
  onRemove?: () => void
  /** Where it is embedded, for the remove label ("Remove from document"). */
  hostNoun?: string
  /** The content's natural shape, so a host can size a new embed to fit it. */
  onNaturalShape?: (shape: NaturalShape) => void
}

export default function WidgetEmbed({ widgetId, display: displayProp, onDisplayChange, onRemove, hostNoun = 'here', onNaturalShape }: Props): JSX.Element {
  const display = normaliseEmbedDisplay(displayProp)
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'missing' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; widget: Widget; deskTitle: string }
  >({ phase: 'loading' })
  // Editing is a mode you enter on purpose and leave; at rest the embed shows
  // the output only. Not saved: every open starts at rest.
  const [editing, setEditing] = useState(false)

  const resolve = useCallback(async (): Promise<void> => {
    try {
      const res = await resolveWidget(widgetId)
      setState(res ? { phase: 'ready', widget: res.widget, deskTitle: res.deskTitle } : { phase: 'missing' })
    } catch (e) {
      setState({ phase: 'error', message: (e as Error).message })
    }
  }, [widgetId])

  useEffect(() => {
    setState({ phase: 'loading' })
    setEditing(false)
    void resolve()
  }, [resolve])

  // LIVE, so nothing is shown or edited from a stale copy. A desk widget and a
  // work widget file are both held by the renderer's stores, which every edit
  // goes through (desk, Focus mode, another embed, the full-pane view); follow
  // them. Office documents follow documents:changed inside EmbedOutput, and
  // their editor keeps its own compare-and-set.
  const fileId = isWidgetFilePaneId(widgetId) ? widgetFileIdFromGroup(widgetId) : null
  const fromDesk = useWidgetStore((st) => (fileId || documentIdFromEmbed(widgetId) ? undefined : st.widgets.find((w) => w.id === widgetId)))
  const fromFile = useWidgetFilesStore((st) => (fileId ? (st as unknown as { files: Record<string, import('@shared/types').WidgetFile> }).files?.[fileId] : undefined))
  // A desk widget whose desk is not open is not in the store. Its saved copy
  // still arrives from any edit made in this window (lib/widgetWrites), and an
  // agent writing it straight to the database (widgets:externalChange) is read
  // again, so it is never shown, or edited, from an old copy.
  useEffect(() => {
    if (fileId || documentIdFromEmbed(widgetId)) return
    const offWrite = onWidgetWrite((w) => {
      if (w.id === widgetId) setState((s) => (s.phase === 'ready' ? { ...s, widget: w } : s))
    })
    const offExternal = window.api.widgets.onExternalChange(() => void resolve())
    return () => {
      offWrite()
      offExternal()
    }
  }, [fileId, widgetId, resolve])

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

  const reportShape = useCallback((s: NaturalShape) => onNaturalShape?.(s), [onNaturalShape])

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

  const { deskTitle } = state
  // The freshest copy: the store's when it holds this object, else the resolved one.
  const widget: Widget = fromDesk ?? (fromFile ? { ...widgetFromFile(fromFile), id: widgetId } : state.widget)
  const entry = WIDGET_CATALOG.find((e) => e.kind === widget.kind)
  // A table or a chart lays out to the pixels it is given, so the widget is
  // handed the box it actually has rather than the size it happens to carry
  // from the desk it came from.
  const sized = { ...widget, width: box.width || widget.width, height: box.height || widget.height }
  const label = widget.title || entry?.label || widget.kind
  // At rest (Data, not editing): the output. Kinds whose live view IS the
  // content (a calendar, a browser) show it, but inert until Edit.
  const atRest = display === 'data' && !editing
  const outputOnly = atRest && hasOutputView(widget)

  const chip = 'inline-flex items-center gap-1 rounded-md px-1.5 h-6 text-[11px] font-medium bg-[var(--surface-raised)] text-[var(--ink-70)] shadow-[0_0_0_1px_var(--edge-soft),var(--shadow-soft)] hover:text-[rgb(var(--accent))]'
  const stop = {
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation()
  }
  return (
    <div
      className={`group/embed relative h-full w-full flex flex-col overflow-hidden ${display === 'data' ? '' : 'rounded-[var(--radius-card)]'} ${editing ? 'ring-2 ring-[rgb(var(--accent))]' : ''}`}
      data-testid="widget-embed"
      data-embed-display={display}
      data-embed-editing={editing ? '' : undefined}
      title={atRest && deskTitle ? `${label} \u2014 from the desk \u201c${deskTitle}\u201d` : undefined}
    >
      {/* Controls, hover-revealed and keyboard reachable: Edit / Done, Data or
          Original, and Remove from the host. While editing they stay shown,
          so Done is never hidden. */}
      <div className={`fb-floating-chrome absolute right-1.5 top-1.5 z-20 flex items-center gap-1 ${editing ? '' : 'opacity-0 group-hover/embed:opacity-100 focus-within:opacity-100'} transition-opacity`}>
        {display === 'data' && (
          <button
            type="button"
            className={chip}
            data-testid="embed-edit-toggle"
            aria-pressed={editing}
            title={editing ? 'Done editing: show the output again' : 'Edit this here'}
            {...stop}
            onClick={(e) => {
              e.stopPropagation()
              // Always from the latest saved content, never a copy this embed
              // loaded earlier: a stale copy saved back would drop newer work.
              if (editing) {
                setEditing(false)
                void resolve()
              } else void resolve().then(() => setEditing(true))
            }}
          >
            <Icon name={editing ? 'check' : 'edit'} size={13} />
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
        {onDisplayChange && !editing && (
          <button
            type="button"
            className={chip}
            data-testid="embed-display-toggle"
            aria-pressed={display === 'object'}
            title={display === 'data' ? 'Show the original object, with its header and tools' : 'Show only the content, without the frame'}
            {...stop}
            onClick={(e) => {
              e.stopPropagation()
              onDisplayChange(display === 'data' ? 'object' : 'data')
            }}
          >
            <Icon name={display === 'data' ? 'web_asset' : 'table_rows'} size={13} />
            {display === 'data' ? 'Original' : 'Data only'}
          </button>
        )}
        {onRemove && !editing && (
          <button
            type="button"
            className={chip}
            data-testid="embed-remove"
            title={`Remove from ${hostNoun}. The original is not deleted.`}
            aria-label={`Remove from ${hostNoun}`}
            {...stop}
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            <Icon name="link_off" size={13} />
            Remove
          </button>
        )}
      </div>
      {/* MOVE GRIP. The content below belongs to the widget: a press that
          starts in it draws, types or scrolls there and never moves the
          object. Every host moves an embed from here instead. */}
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
        {outputOnly ? (
          <div className="h-full w-full" data-testid="embed-output">
            <Suspense fallback={<div className="h-full w-full" aria-hidden />}>
              <EmbedOutput widget={widget} width={box.width || 640} onShape={reportShape} />
            </Suspense>
          </div>
        ) : (
          <div className={`h-full w-full ${atRest ? 'pointer-events-none' : ''}`}>
            <Suspense fallback={<div className="h-full w-full" aria-hidden />}>
              <EmbeddedWidgetBody widget={sized} display={display} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  )
}
