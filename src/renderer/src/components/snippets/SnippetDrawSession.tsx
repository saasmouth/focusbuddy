import type { SnippetBody } from '@shared/snippets'
import DrawStudio from '../documents/DrawStudio'

// PlexiiDraw editing a draw snippet, for SnippetEditSessionView's registry.
//
// Written here rather than by Draw's owner at their request, to their
// instructions: DrawStudio's `content` IS the stored drawing body (v1 or v2; it
// normalises on load and emits v2 when v2 writes are on), so the snippet body
// goes straight in and the `kind` envelope goes back on the way out. DrawStudio
// ignores the extra field.
//
// No state of its own, unlike the sheet session: there is no wrapping to hold,
// because a DrawSnippetBody already IS what DrawStudio wants. The host buffers
// what comes out of onChange and writes only on Save.
//
// Deliberately NOT passed: foldExternal, liveUndo, v2Blocked. A snippet session
// is not a live room, and its undo is the editor's own snapshot stack, which is
// the right behaviour here — undo inside a session must not reach the host
// document, because the edit targets the snippet master.

export interface SnippetDrawSessionProps {
  body: SnippetBody
  title: string
  onChange: (next: SnippetBody) => void
}

export default function SnippetDrawSession({
  body,
  title,
  onChange
}: SnippetDrawSessionProps): JSX.Element | null {
  if (body.kind !== 'draw') return null
  return (
    <DrawStudio
      content={body}
      title={title}
      onChange={(next) => onChange({ ...(next as object), kind: 'draw' } as SnippetBody)}
    />
  )
}
