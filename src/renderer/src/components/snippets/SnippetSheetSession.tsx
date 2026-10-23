import { useState } from 'react'
import type { SheetBodyV2 } from '@shared/types'
import type { SnippetBody, SheetSnippetBody } from '@shared/snippets'
import SheetEditor from '../documents/SheetEditor'
import {
  unwrapSheetSnippet,
  wrapSheetSnippet
} from '../documents/sheet/snippetSession'

// PlexiiCells editing a sheet snippet, for SnippetEditSessionView's registry.
//
// The wrapped workbook lives in state here because SheetEditor is a controlled
// component — `{ body, title, onChange }`, like every other office editor — so
// something has to hold the document shape while the host holds the snippet
// shape.
//
// It unwraps on EVERY change rather than only on Save. That costs a trim and
// keeps the host's buffer snippet-shaped at all times, so Save needs no special
// path and cannot forget to unwrap. Nothing is written until the host's Save
// asks for it: SheetEditor, like the rest, never saves anything itself.

export interface SnippetSheetSessionProps {
  body: SnippetBody
  title: string
  onChange: (next: SnippetBody) => void
}

export default function SnippetSheetSession({
  body,
  title,
  onChange
}: SnippetSheetSessionProps): JSX.Element | null {
  if (body.kind !== 'sheet') return null
  return <Inner body={body} title={title} onChange={onChange} />
}

function Inner({
  body,
  title,
  onChange
}: {
  body: SheetSnippetBody
  title: string
  onChange: (next: SnippetBody) => void
}): JSX.Element {
  // Wrapped once, from the body the session loaded. Re-wrapping on every render
  // would fight the editor for control of its own content.
  const [doc, setDoc] = useState<SheetBodyV2>(() => wrapSheetSnippet(body, title || 'Snippet'))
  return (
    <SheetEditor
      body={doc}
      title={title}
      onChange={(next) => {
        const v2 = next as SheetBodyV2
        setDoc(v2)
        onChange(unwrapSheetSnippet(v2))
      }}
    />
  )
}
