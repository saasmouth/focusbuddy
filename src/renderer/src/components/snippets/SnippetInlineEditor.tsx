import { EditorContent, useEditor } from '@tiptap/react'
import { buildDocExtensions } from '../documents/editor/extensions'

// Editing a saved snippet where it sits.
//
// A SEPARATE editor with its own history, deliberately. The edit targets the
// MASTER, not the document hosting it, so the host's undo must not reach it:
// undoing a master edit from one document would silently change every other
// place that snippet is used, which nobody would expect from pressing ⌘Z in a
// file. Keeping the history here means ⌘Z inside the editor undoes typing, and
// ⌘Z in the document does what it always did.
//
// It uses the document's own schema (buildDocExtensions), so content survives
// the round trip exactly — tables, lists, marks and nested embeds included —
// rather than through a reduced editor that would quietly drop what it does not
// understand on save.
//
// Loaded lazily by SnippetEmbed, because this import reaches buildDocExtensions,
// which registers SnippetEmbedNode, which renders SnippetEmbed. That cycle is
// real and legitimate; it is broken at the import boundary.

export interface SnippetInlineEditorProps {
  content: unknown[]
  busy?: boolean
  onCommit: (content: unknown[], text: string) => void
  onCancel: () => void
}

export default function SnippetInlineEditor({
  content,
  busy = false,
  onCommit,
  onCancel
}: SnippetInlineEditorProps): JSX.Element {
  const editor = useEditor(
    {
      extensions: buildDocExtensions({ interactive: true }),
      content: { type: 'doc', content: content as never },
      autofocus: 'end'
    },
    []
  )

  const commit = (): void => {
    if (!editor || busy) return
    const json = editor.getJSON()
    const next = Array.isArray(json.content) ? json.content : []
    // An empty body is refused by the DB anyway (createSnippet/updateSnippet
    // both reject it), so catch it here and say so rather than firing a write
    // that comes back as an error the user has to interpret.
    if (next.length === 0) return
    onCommit(next, editor.getText())
  }

  return (
    <div
      className="rounded-[var(--radius-row)] border border-accent/40 bg-[var(--surface-raised)] p-2"
      data-testid="snippet-inline-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.stopPropagation()
          commit()
        }
      }}
    >
      <EditorContent editor={editor} />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={commit}
          disabled={busy}
          className="btn-primary !h-6 px-2 text-[11px]"
          data-testid="snippet-inline-save"
        >
          {busy ? 'Saving…' : 'Save to snippet'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="btn-ghost !h-6 px-2 text-[11px]"
          data-testid="snippet-inline-cancel"
        >
          Cancel
        </button>
        <span className="text-[10px] text-[var(--ink-40)]">⌘↩ saves · Esc cancels</span>
      </div>
    </div>
  )
}
