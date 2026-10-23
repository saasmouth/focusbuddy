import { useRef } from 'react'
import type { DrawSnippetBody, SnippetBody } from '@shared/snippets'
import { drawBodyFromSnippet, snippetFromDrawBody } from '@shared/draw/snippetBody'
import DrawStudio from '../documents/DrawStudio'

// PlexiiDraw editing a drawing snippet, for SnippetEditSessionView's registry.
//
// The wrapping is d1's (src/shared/draw/snippetBody.ts) and the rules it
// encodes are not obvious, so they are worth stating where the entry lives:
//
// - The artboard is the art's visible bounds plus half the widest stroke,
//   rounded out, plus a 32px margin — so it is often at NEGATIVE coordinates,
//   because the art is never moved to suit the frame. Objects are re-based to
//   the origin on the way out, which is what "Save selection as snippet…"
//   does, and 100 open/save cycles show no drift.
// - `lost` is one plain sentence per thing the snippet cannot hold exactly as
//   drawn: a paint layer becomes a picture object, extra artboards keep their
//   art, and layer structure, layer opacity and blend, template layers, the
//   artboard background and unused swatches are left out. The host shows these
//   beside Save, BEFORE the write.
// - An unreadable drawing comes back as `prev` plus a line saying so, so Save
//   writes a body identical to the master rather than destroying it.
//
// `session={{ kind: 'snippet' }}` is what turns the studio's document commands
// off — Move to trash would otherwise bin the documents store's active
// document, which is not this snippet.

export interface SnippetDrawSessionProps {
  body: SnippetBody
  title: string
  onChange: (next: SnippetBody, lost?: string[]) => void
  requestSave: () => void
}

export default function SnippetDrawSession({
  body,
  title,
  onChange,
  requestSave
}: SnippetDrawSessionProps): JSX.Element | null {
  if (body.kind !== 'draw') return null
  return <Inner body={body} title={title} onChange={onChange} requestSave={requestSave} />
}

function Inner({
  body,
  title,
  onChange,
  requestSave
}: {
  body: DrawSnippetBody
  title: string
  onChange: (next: SnippetBody, lost?: string[]) => void
  requestSave: () => void
}): JSX.Element {
  // Wrapped ONCE, from the body the session loaded. DrawStudio builds its
  // scene, undo stack and loaded rasters from `content` on mount and does not
  // re-seed, so re-wrapping on every render would fight it for control of its
  // own canvas. A Reload remounts this component (the host keys the surface on
  // snippetId:seed), which is how taking theirs reaches the canvas.
  const initial = useRef(drawBodyFromSnippet(body)).current

  // The previous SNIPPET body, which is what snippetFromDrawBody wants for
  // `prev` — it is how a damaged object is detected and left out rather than
  // written as rubble. A ref rather than the `body` prop: the studio can emit
  // several changes before the host re-renders, and a stale prev would compare
  // the newest drawing against a body two edits old.
  const prev = useRef<DrawSnippetBody>(body)

  return (
    <DrawStudio
      content={initial}
      title={title}
      onChange={(next) => {
        const result = snippetFromDrawBody(next, prev.current)
        prev.current = result.body
        onChange(result.body, result.lost)
      }}
      // File › Save and ⌘S inside the studio pull the host's trigger instead of
      // writing. Without this the studio's own Save shows disabled, which reads
      // as broken when the session plainly has a Save of its own.
      onSaveRequest={requestSave}
      session={{ kind: 'snippet' }}
    />
  )
}
