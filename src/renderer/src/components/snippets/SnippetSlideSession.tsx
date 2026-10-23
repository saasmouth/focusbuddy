import { useState } from 'react'
import type { SlidesBody } from '@shared/types'
import type { SnippetBody, SlideSnippetBody } from '@shared/snippets'
import SlidesEditor from '../documents/SlidesEditor'
import { unwrapSlideSnippet, wrapSlideSnippet } from '../documents/slides/snippetSession'

// PlexiiDeck editing a slide snippet, for SnippetEditSessionView's registry.
//
// A slide snippet is a fragment (slide elements), so it is edited on an
// IN-MEMORY one-slide deck (9d's ruling): SlidesEditor runs with singleSlide,
// which hides the navigator and refuses every slide-level command, so nothing
// can be added that the snippet would have nowhere to keep. The deck lives only
// in this component's state; no document row is ever created. It unwraps on
// every change, keeping the host's buffer snippet-shaped, and nothing is written
// until the host's Save; SlidesEditor never saves anything itself.

export interface SnippetSlideSessionProps {
  body: SnippetBody
  title: string
  onChange: (next: SnippetBody) => void
}

export default function SnippetSlideSession({ body, title, onChange }: SnippetSlideSessionProps): JSX.Element | null {
  if (body.kind !== 'slide') return null
  return <Inner body={body} title={title} onChange={onChange} />
}

function Inner({ body, title, onChange }: { body: SlideSnippetBody; title: string; onChange: (next: SnippetBody) => void }): JSX.Element {
  const [deck, setDeck] = useState<SlidesBody>(() => wrapSlideSnippet(body))
  return (
    <SlidesEditor
      body={deck}
      title={title}
      singleSlide
      onChange={(d) => {
        setDeck(d)
        onChange(unwrapSlideSnippet(d))
      }}
    />
  )
}
