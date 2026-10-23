// A block-level atom node that embeds a LIVE saved snippet in a document by id.
//
// The node stores only { snippetId }; the content is resolved at render time by
// SnippetEmbed, so the document never carries a stale copy of the snippet. Edit
// the snippet in the library and every live instance shows the change.
//
// The same extension is used by the live editor and the headless HTML
// converters (docHtml.ts): headless rendering emits the data-snippet-embed div
// below and never touches the React NodeView, and parseHTML reads that div back,
// so the node round-trips through HTML exactly like the widget and document
// embeds. Without that shared schema a document containing a live snippet would
// lose it on export and re-import.
//
// A DUPLICATE insertion deliberately creates NO node of this kind. It inserts
// the snippet's own content as ordinary editable blocks, because that is what a
// duplicate is: a copy that has stopped tracking its origin. Only a live
// instance needs a reference, so only a live instance gets one.

import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import SnippetEmbed from './SnippetEmbed'
import { openSnippetSession } from '../../snippets/snippetSessionStore'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    snippetEmbed: {
      /** Insert a LIVE instance: a reference resolved on every render. */
      insertSnippetLive: (snippetId: string) => ReturnType
      /**
       * Insert a DUPLICATE: the snippet's blocks as ordinary editable content.
       * Takes the content rather than an id, precisely because the result keeps
       * no link back to the snippet.
       */
      insertSnippetDuplicate: (content: unknown[]) => ReturnType
    }
  }
}

function SnippetEmbedView({ node, selected, updateAttributes, editor, getPos }: NodeViewProps): JSX.Element {
  const snippetId = (node.attrs.snippetId as string | null) ?? ''
  const showChrome = node.attrs.showChrome === true
  return (
    <NodeViewWrapper className="my-3" data-drag-handle>
      {/*
        No `not-prose` here, deliberately. A doc snippet is meant to read as the
        paragraphs around it — that is what "appear as their natural form" means
        — so it inherits the document's own typography. It carried not-prose
        while it was a bordered card with its own header, where matching the page
        did not matter.
      */}
      <div className={selected ? 'rounded-lg ring-2 ring-accent' : ''} contentEditable={false}>
        <SnippetEmbed
          snippetId={snippetId}
          host="doc"
          showChrome={showChrome}
          onShowChromeChange={(next) => updateAttributes({ showChrome: next })}
          // A converted instance is live and read-only, so the only way to
          // change what it shows is to edit the master — "open and edit the
          // original from where it's placed". The session is mounted globally
          // (SnippetSessionHost) and opened imperatively, because a node view
          // has no React parent to pass it a callback.
          onOpenOriginal={(snippet) => openSnippetSession(snippet.id)}
          onDetach={(content) => {
            // "Detach to edit only here": this reference becomes the content it
            // was showing, unlinked. Only the node view can do it, because only
            // it knows where in the document this instance sits.
            //
            // One range replacement rather than a delete then an insert, so it
            // is a single undo step — detaching is one action to the user and
            // should take one ⌘Z, not two.
            const pos = getPos()
            if (typeof pos !== 'number') return
            if (!Array.isArray(content) || content.length === 0) return
            editor
              .chain()
              .focus()
              .insertContentAt({ from: pos, to: pos + node.nodeSize }, content as never)
              .run()
          }}
        />
      </div>
    </NodeViewWrapper>
  )
}

export const SnippetEmbedNode = Node.create({
  name: 'snippetEmbed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      snippetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-snippet-embed'),
        renderHTML: (attrs) => (attrs.snippetId ? { 'data-snippet-embed': attrs.snippetId } : {})
      },
      /**
       * Whether this instance keeps its frame shown. Per-instance, because the
       * owner asked for the pin to be "on the instance of the snippet when
       * applied" rather than a global preference — two copies of the same
       * snippet in one document can differ.
       *
       * It round-trips through HTML like snippetId, so exporting and re-importing
       * a document keeps the pin instead of quietly resetting it. Absent means
       * false, which is the resting state.
       */
      showChrome: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-snippet-chrome') === 'true',
        renderHTML: (attrs) => (attrs.showChrome ? { 'data-snippet-chrome': 'true' } : {})
      }
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-snippet-embed]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // The static form (exports, headless conversion) names what it is rather
    // than pretending to be the resolved snippet. An exported .docx therefore
    // says a live snippet was here instead of silently dropping it.
    return ['div', mergeAttributes(HTMLAttributes), 'Live snippet']
  },

  addNodeView() {
    return ReactNodeViewRenderer(SnippetEmbedView)
  },

  addCommands() {
    return {
      insertSnippetLive:
        (snippetId: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { snippetId } }),

      insertSnippetDuplicate:
        (content: unknown[]) =>
        ({ commands }) => {
          // Nothing to insert is a refused command, not a silent no-op that
          // the caller would report as a successful insertion.
          if (!Array.isArray(content) || content.length === 0) return false
          return commands.insertContent(content as never)
        }
    }
  }
})
