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
import WidgetEmbed from './WidgetEmbed'
import { EMBED_DISPLAY_DEFAULT, normaliseEmbedDisplay } from '../../../lib/widgetSurface'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    widgetEmbed: {
      insertWidgetEmbed: (widgetId: string) => ReturnType
    }
  }
}

function WidgetEmbedView({ node, selected, editor, updateAttributes }: NodeViewProps): JSX.Element {
  const widgetId = (node.attrs.widgetId as string | null) ?? ''
  const display = normaliseEmbedDisplay(node.attrs.display)
  return (
    <NodeViewWrapper className="my-3">
      <div
        className={`h-[220px] not-prose ${selected ? 'rounded-lg ring-2 ring-accent' : ''}`}
        contentEditable={false}
      >
        <WidgetEmbed
          widgetId={widgetId}
          display={display}
          // A read-only document can show either form but cannot change it.
          onDisplayChange={editor.isEditable ? (d) => updateAttributes({ display: d }) : undefined}
        />
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
