// A block-level atom node that embeds a PlexiOffice document inside another
// document by id. It stores only { documentId }; the title/type are resolved at
// render time by DocEmbed, so the host document never carries a stale copy. Like
// WidgetEmbedNode, the same extension is used by the live editor and the
// headless HTML converters: headless rendering emits the data-doc-embed div and
// never touches the React NodeView, and parseHTML reads it back, so the node
// round-trips through HTML (and .docx export) exactly like every other node.

import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import DocEmbed from './DocEmbed'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    docEmbed: {
      insertDocEmbed: (documentId: string) => ReturnType
    }
  }
}

function DocEmbedView({ node, selected }: NodeViewProps): JSX.Element {
  const documentId = (node.attrs.documentId as string | null) ?? ''
  return (
    <NodeViewWrapper className="my-3" data-drag-handle>
      <div className={`not-prose ${selected ? 'rounded-lg ring-2 ring-accent' : ''}`} contentEditable={false}>
        <DocEmbed documentId={documentId} />
      </div>
    </NodeViewWrapper>
  )
}

export const DocEmbedNode = Node.create({
  name: 'docEmbed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      documentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-doc-embed'),
        renderHTML: (attrs) => (attrs.documentId ? { 'data-doc-embed': attrs.documentId } : {})
      }
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-doc-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // Static form for exports / headless conversion: names what it is rather
    // than pretending to be the live document card.
    return ['div', mergeAttributes(HTMLAttributes), 'Embedded PlexiiOffice document']
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocEmbedView)
  },

  addCommands() {
    return {
      insertDocEmbed:
        (documentId: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { documentId } })
    }
  }
})
