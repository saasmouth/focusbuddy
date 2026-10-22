// Any snippet into any destination, in its most faithful NATIVE form.
//
// `convertSnippetBody(body, to)` returns a body of EXACTLY kind `to`, or a
// refusal with a reason a person can act on. Never another kind: a drawing in
// PlexiiWrite is a doc body holding an image node, a sheet block in PlexiiDeck
// is a slide body holding a table element. What the conversion loses is listed
// in `lossy`, in plain words, so a converted insert can say so instead of being
// silently lossy. An empty list means it is faithful.
//
// The path is always the same: `formsOf(body)` lists the forms the body can
// take, best first (shared/snippetForms.ts), and the destination's builder
// (shared/snippetConvert/to*.ts) takes the first one it can hold. A pair the
// product does not support (a picture into PlexiiCells) is refused by the
// builder with the reason from shared/snippetConvert/reasons.ts.

import type { SnippetBody, SnippetKind } from './snippets'
import { formsOf, type ConvertDeps, type Form } from './snippetForms'
import { toDoc } from './snippetConvert/toDoc'
import { toSheet } from './snippetConvert/toSheet'
import { toSlide } from './snippetConvert/toSlide'
import { toDesign } from './snippetConvert/toDesign'
import { toDiagram } from './snippetConvert/toDiagram'
import { toDraw } from './snippetConvert/toDraw'
import { toWidget } from './snippetConvert/toWidget'

export type { ConvertDeps, DrawImport, DrawPicture, Form, FormKind, SheetEvaluation } from './snippetForms'

export type SnippetConversion =
  | { ok: true; body: SnippetBody; lossy: string[] }
  | { ok: false; reason: string }

/** What every builder is handed: the source, its forms (best first) and the deps. */
export interface BuildContext {
  body: SnippetBody
  forms: Form[]
  deps: ConvertDeps
}

export type SnippetBuilder = (ctx: BuildContext) => SnippetConversion

const BUILDERS: Record<SnippetKind, SnippetBuilder> = {
  doc: toDoc,
  sheet: toSheet,
  slide: toSlide,
  design: toDesign,
  diagram: toDiagram,
  draw: toDraw,
  widget: toWidget
}

/**
 * Convert a snippet body into a body of kind `to`.
 *
 * DETERMINISM IS A CORRECTNESS REQUIREMENT, NOT AN OPTIMISATION. A converted
 * LIVE instance is re-converted from the master on every render (the resolve
 * path calls this with primaryKindFor(host) each time it draws), so the same
 * input must give byte-identical output every time. Minting ids, reading a
 * clock or drawing randomness here would make an embed churn on every render
 * or never settle. Ids are derived from position (`${prefix}-${index}`); the
 * caller's insert step re-mints them, as every target already does on paste.
 * Do not relax this. Live converted instances render the SVG form; turning it
 * into a PNG is async and DOM-bound, and stays outside this pure core
 * (renderer/src/lib/snippetRaster.ts).
 *
 * Never mutates `body`; the result shares no object with it.
 */
export function convertSnippetBody(body: SnippetBody, to: SnippetKind, deps: ConvertDeps = {}): SnippetConversion {
  const builder = BUILDERS[to]
  if (!builder) return { ok: false, reason: 'That is not a kind of snippet this app knows.' }
  return builder({ body, forms: formsOf(body, deps), deps })
}
