// A block-level atom node that embeds a live desk widget in a document by id.
// The node stores only { widgetId }; the content is resolved at render time by
// WidgetEmbed, so the document never carries a stale copy of the widget. The
// same extension is used by the live editor and the headless HTML converters
// (docHtml.ts): headless rendering emits the data-widget-embed div below and
// never touches the React NodeView, and parseHTML reads that div back, so the
// node round-trips through HTML exactly like every other schema node.

import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { NaturalShape } from './embedOutputKind'
import { EMBED_DISPLAY_DEFAULT, normaliseEmbedDisplay } from '../../../lib/widgetSurface'
// Lazy: this file is schema, loaded by the headless converters and the node
// tests too, but the view follows the widget stores, which need a renderer.
const WidgetEmbed = lazy(() => import('./WidgetEmbed'))

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    widgetEmbed: {
      insertWidgetEmbed: (widgetId: string) => ReturnType
    }
  }
}

const MIN_W = 160
const MIN_H = 100
const MAX_H = 1400
const clampH = (h: number): number => Math.round(Math.min(MAX_H, Math.max(MIN_H, h)))

/** A size to show before the content has reported its own: roomier for an office app. */
function fallbackHeight(widgetId: string): number {
  return widgetId.startsWith('doc:') ? 480 : 240
}

function WidgetEmbedView({ node, selected, editor, updateAttributes, deleteNode }: NodeViewProps): JSX.Element {
  const widgetId = (node.attrs.widgetId as string | null) ?? ''
  const display = normaliseEmbedDisplay(node.attrs.display)
  const savedH = typeof node.attrs.height === 'number' ? (node.attrs.height as number) : null
  const savedW = typeof node.attrs.width === 'number' ? (node.attrs.width as number) : null
  const editable = editor.isEditable

  // The column this embed sits in, so a content-shaped default can be worked out.
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [columnW, setColumnW] = useState(0)
  useEffect(() => {
    const el = boxRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver((e) => setColumnW(Math.round(e[0]?.contentRect.width ?? 0)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The content's own size (owner, 4.3.44: "the default size of the embed
  // should be the same as the content within"): a diagram or drawing keeps its
  // proportions, text and tables take their real height. A size the user has
  // dragged to always wins.
  const [natural, setNatural] = useState<{ aspect?: number; height?: number } | null>(null)
  const onNaturalShape = useCallback((shape: NaturalShape) => {
    setNatural('aspect' in shape ? { aspect: shape.aspect } : { height: shape.height })
  }, [])
  const width = savedW ?? (columnW || 640)
  const naturalH = natural?.aspect ? width * natural.aspect : natural?.height ? natural.height + 6 : null
  const [drag, setDrag] = useState<{ w: number; h: number } | null>(null)
  const height = drag?.h ?? savedH ?? (naturalH ? clampH(naturalH) : fallbackHeight(widgetId))
  const shownW = drag?.w ?? savedW

  // Resize like a Workcentre tile: right edge, bottom edge, corner.
  const begin = (e: React.PointerEvent, edge: 'r' | 'b' | 'rb'): void => {
    if (!editable) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const w0 = shownW ?? (boxRef.current?.getBoundingClientRect().width ?? width)
    const h0 = height
    const maxW = columnW || w0
    let last = { w: w0, h: h0 }
    const move = (ev: PointerEvent): void => {
      last = {
        w: edge === 'b' ? w0 : Math.round(Math.min(maxW, Math.max(MIN_W, w0 + ev.clientX - startX))),
        h: edge === 'r' ? h0 : clampH(h0 + ev.clientY - startY)
      }
      setDrag(last)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      updateAttributes({ height: last.h, width: edge === 'b' ? savedW : last.w >= maxW - 2 ? null : last.w })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <NodeViewWrapper className="my-3">
      <div
        ref={boxRef}
        className={`relative not-prose ${selected ? 'rounded-lg ring-2 ring-accent' : ''}`}
        style={{ height, width: shownW ? `${shownW}px` : '100%', maxWidth: '100%' }}
        contentEditable={false}
        data-testid="embed-box"
      >
        <Suspense fallback={null}>
          <WidgetEmbed
            widgetId={widgetId}
            display={display}
            // A read-only document can show either form but cannot change it.
            onDisplayChange={editable ? (d) => updateAttributes({ display: d }) : undefined}
            onRemove={editable ? () => deleteNode() : undefined}
            hostNoun="this document"
            onNaturalShape={onNaturalShape}
          />
        </Suspense>
        {editable && (
          <>
            <div onPointerDown={(e) => begin(e, 'r')} className="absolute top-8 -right-1 bottom-3 w-2 cursor-ew-resize hover:bg-[rgb(var(--accent)/0.35)] rounded" data-testid="embed-resize-r" title="Drag to resize" />
            <div onPointerDown={(e) => begin(e, 'b')} className="absolute -bottom-1 left-0 right-3 h-2 cursor-ns-resize hover:bg-[rgb(var(--accent)/0.35)] rounded" data-testid="embed-resize-b" title="Drag to resize" />
            <div onPointerDown={(e) => begin(e, 'rb')} className="absolute -bottom-1 -right-1 h-3.5 w-3.5 cursor-nwse-resize rounded-sm bg-[var(--surface-raised)] shadow-[0_0_0_1px_var(--edge-soft)]" data-testid="embed-resize-corner" title="Drag to resize" />
          </>
        )}
      </div>
    </NodeViewWrapper>
  )
}

export const WidgetEmbedNode = Node.create({
  name: 'widgetEmbed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      widgetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-widget-embed'),
        renderHTML: (attrs) => (attrs.widgetId ? { 'data-widget-embed': attrs.widgetId } : {})
      },
      // 'data' (the content alone) or 'object' (the original, with its frame).
      // Older documents carry nothing and read as the default.
      // A size the user dragged to, in px; absent = sized to its content.
      height: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-embed-height')) || null,
        renderHTML: (attrs) => (attrs.height ? { 'data-embed-height': String(attrs.height) } : {})
      },
      width: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-embed-width')) || null,
        renderHTML: (attrs) => (attrs.width ? { 'data-embed-width': String(attrs.width) } : {})
      },
      display: {
        default: EMBED_DISPLAY_DEFAULT,
        parseHTML: (el) => normaliseEmbedDisplay(el.getAttribute('data-embed-display')),
        renderHTML: (attrs) => ({ 'data-embed-display': normaliseEmbedDisplay(attrs.display) })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-widget-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // The static form (exports, headless conversion) names what it is rather
    // than pretending to be the live widget.
    return ['div', mergeAttributes(HTMLAttributes), 'Embedded work widget']
  },

  addNodeView() {
    return ReactNodeViewRenderer(WidgetEmbedView, {
      // Events inside the embedded widget's content are the widget's (a pen
      // stroke on a scratchpad, typing in a table). ProseMirror must not treat
      // them as a node selection or the start of a node drag. The grip, which
      // carries data-drag-handle, stays the editor's.
      stopEvent: ({ event }) => {
        const t = event.target as HTMLElement | null
        return !!t?.closest?.('[data-embed-interactive]')
      }
    })
  },

  addCommands() {
    return {
      insertWidgetEmbed:
        (widgetId: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { widgetId } })
    }
  }
})
