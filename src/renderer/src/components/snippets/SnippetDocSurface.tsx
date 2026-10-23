import { EditorContent, useEditor } from '@tiptap/react'
import { buildDocExtensions } from '../documents/editor/extensions'

// A bare editable surface for a doc snippet body: content in, changes out, no
// chrome of its own.
//
// It is the same controlled shape every office editor already has — DrawStudio,
// DesignEditor, DiagramEditor, SheetEditor and SlidesEditor are all
// `{ body, title, onChange }` with no document id and no writes of their own —
// so the session host can treat a document fragment exactly like the others.
// Write has no such component because a document IS the editor, hence this.
//
// It does NOT save, deliberately, and that is the property the session depends
// on: the host buffers onChange and writes only when the user asks. See
// SnippetEditSessionView.

export interface SnippetDocSurfaceProps {
  content: unknown[]
  onChange: (content: unknown[], text: string) => void
}

export default function SnippetDocSurface({ content, onChange }: SnippetDocSurfaceProps): JSX.Element {
  const editor = useEditor(
    {
      extensions: buildDocExtensions({ interactive: true }),
      content: { type: 'doc', content: content as never },
      autofocus: 'end',
      onUpdate: ({ editor: ed }) => {
        const json = ed.getJSON()
        onChange(Array.isArray(json.content) ? json.content : [], ed.getText())
      }
    },
    []
  )

  return (
    <div className="h-full overflow-auto p-4" data-testid="snippet-doc-surface">
      <EditorContent editor={editor} />
    </div>
  )
}
