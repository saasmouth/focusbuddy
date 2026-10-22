import { lazy, Suspense } from 'react'
import { snippetKindLabel, type SnippetBody } from '@shared/snippets'

// A snippet's content, and ONLY its content.
//
// No border, no title, no badge, no frame. The owner's instruction is that a
// placed snippet "should appear as its natural form, e.g. diagram, image, text,
// not bound within widget structure with title etc." — so a doc fragment renders
// as the paragraphs and tables it is, indistinguishable from the text around it.
// Anything a host wants to draw AROUND this (hover chrome, a pin, an edit
// affordance) is the host's business, drawn outside this component.
//
// This replaces a bordered box with a header showing the snippet's name and a
// "Live" pill, which was mine and was exactly the structure the owner objected
// to.
//
// Lazy on SnippetDocBody for the same reason it was always lazy: docHtml pulls
// in buildDocExtensions, which registers SnippetEmbedNode, which renders the
// embed that renders this. The cycle is legitimate — a snippet really can hold a
// document fragment — so it is broken at the import boundary.
const SnippetDocBody = lazy(() => import('../documents/embed/SnippetDocBody'))

export interface SnippetContentProps {
  body: SnippetBody
}

export default function SnippetContent({ body }: SnippetContentProps): JSX.Element {
  if (body.kind === 'doc') {
    return (
      <Suspense fallback={<span className="text-[12px] text-[var(--ink-50)]">Rendering…</span>}>
        <SnippetDocBody content={body.content} />
      </Suspense>
    )
  }

  // A kind this host cannot draw as itself. Visible rather than hidden, and it
  // names the kind: a host that cannot show something must say so, because the
  // alternative is a blank space where the user put content. Conversion (2e's
  // convertSnippetBody) normally runs BEFORE this component sees a body, so a
  // reader reaching this state means a pair has no conversion yet — which is
  // worth seeing plainly rather than discovering as an empty gap.
  return (
    <span className="text-[12px] text-[var(--ink-50)]" data-testid="snippet-content-unsupported">
      This {snippetKindLabel(body.kind).toLowerCase()} cannot be shown here yet. Open it from the
      snippet library.
    </span>
  )
}
