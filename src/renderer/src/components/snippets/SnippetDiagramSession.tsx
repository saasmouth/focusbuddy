import { useState } from 'react'
import type { MapBody } from '@shared/types'
import type { SnippetBody, DiagramSnippetBody } from '@shared/snippets'
import MapEditor from '../documents/MapEditor'
import { unwrapDiagramSnippet, wrapDiagramSnippet } from '../documents/diagram/snippetSession'

// PlexiiDiagrams editing a diagram snippet, for SnippetEditSessionView's registry.
//
// The wrapped diagram lives in state here because DiagramEditor is a controlled
// component, so something holds the document shape while the host holds the
// snippet shape. It unwraps on every change, keeping the host's buffer
// snippet-shaped at all times, so Save needs no special path. Nothing is written
// until the host's Save asks for it; DiagramEditor never saves anything itself.
// No foldExternal, no liveUndo: this is a private buffer, not a co-edit.

export interface SnippetDiagramSessionProps {
  body: SnippetBody
  title: string
  onChange: (next: SnippetBody) => void
}

export default function SnippetDiagramSession({ body, title, onChange }: SnippetDiagramSessionProps): JSX.Element | null {
  if (body.kind !== 'diagram') return null
  return <Inner body={body} title={title} onChange={onChange} />
}

function Inner({ body, title, onChange }: { body: DiagramSnippetBody; title: string; onChange: (next: SnippetBody) => void }): JSX.Element {
  const [doc, setDoc] = useState<MapBody>(() => wrapDiagramSnippet(body))
  return (
    <MapEditor
      body={doc}
      title={title}
      singlePage
      onChange={(d) => {
        setDoc(d)
        onChange(unwrapDiagramSnippet(d))
      }}
    />
  )
}
