import { useState } from 'react'
import type { DesignBody } from '@shared/design'
import type { DesignSnippetBody, SnippetBody } from '@shared/snippets'
import DesignEditor from '../documents/DesignEditor'
import { unwrapDesignSnippet, wrapDesignSnippet } from '../documents/design/snippetSession'

// PlexiiDesign editing a design snippet, for SnippetEditSessionView's registry.
//
// A design snippet is { kind, elements, stories?, swatches? }, with no size and
// no pages, so it is edited on an IN-MEMORY one-page document sized to the art
// (documents/design/snippetSession.ts, where the decisions and their tests
// live). No document row is ever created. This component is the state between:
// `render` is handed a SnippetBody and its onChange wants one back, so the
// wrapped DesignBody has to live somewhere for the length of the session.
//
//   UNWRAPS ON EVERY CHANGE, not only on Save, like the slide and diagram
//   entries. The host buffers the body in a ref and writes only when Save
//   runs, so the cost is one conversion per commit (a drag ending, a coalesced
//   run of typing), not per frame, and the buffer is snippet-shaped at all
//   times. Measured on the real module when this was first written: 0.014 ms
//   for 50 elements, 0.066 ms for 400, 0.246 ms for 2000.
//
//   NO foldExternal. Saving the master broadcasts, and with folding on, the
//   session would take its own save back as a peer's merge in the middle of an
//   edit. Conflict is the host's compare-and-set on the revision it loaded.
//
//   NO documentOps. A snippet is not a document: File offers no New, copy,
//   rename, history or trash, and Download stays (DesignMenuBar).
//
//   NO readOnly or session flag. Design does not autosave: it calls onChange
//   on every commit and the host decides what that means.

export interface SnippetDesignSessionProps {
  body: SnippetBody
  title: string
  onChange: (next: SnippetBody) => void
}

export default function SnippetDesignSession({ body, title, onChange }: SnippetDesignSessionProps): JSX.Element | null {
  if (body.kind !== 'design') return null
  return <Inner body={body} title={title} onChange={onChange} />
}

function Inner({ body, title, onChange }: { body: DesignSnippetBody; title: string; onChange: (next: SnippetBody) => void }): JSX.Element {
  // Wrapped once, on mount: re-wrapping on every render would throw away the
  // document (and its undo history) on each change.
  const [doc, setDoc] = useState<DesignBody>(() => wrapDesignSnippet(body))
  return (
    <DesignEditor
      content={doc}
      title={title}
      onChange={(next) => {
        const d = next as DesignBody
        setDoc(d)
        onChange(unwrapDesignSnippet(d))
      }}
    />
  )
}
