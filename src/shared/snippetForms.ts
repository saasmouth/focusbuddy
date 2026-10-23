// Every snippet as the FORMS it can take outside its own app.
//
// A snippet body is native to one app. To put it somewhere else (a sheet block
// into PlexiiWrite, a diagram onto a slide, a sticky into PlexiiCells) it has
// to become something the destination holds natively: TipTap nodes, rows of
// values, a picture, plain text. `formsOf` lists those forms for one body,
// BEST FIRST, each carrying the plain-English list of what is lost on the way.
// A destination's builder (shared/snippetConvert/to*.ts) then takes the first
// form it can hold. The same list serves snippet insertion and ⌘V paste, so a
// paste and an insert of the same thing land identically.
//
// Pure and deterministic: no React, no DOM, no clock, no randomness, no id
// minting. Anything that only exists in the renderer (the formula engine,
// PlexiiDraw's SVG writer and SVG importer) arrives through ConvertDeps, and a
// missing dep means a form is honestly absent, never faked.

import type { DrawSnippetBody, SheetSnippetBody, SnippetBody } from './snippets'
import { formsOfDoc } from './snippetForms/fromDoc'
import { formsOfSheet } from './snippetForms/fromSheet'
import { formsOfSlide } from './snippetForms/fromSlide'
import { formsOfDesign } from './snippetForms/fromDesign'
import { formsOfDiagram } from './snippetForms/fromDiagram'
import { formsOfDraw } from './snippetForms/fromDraw'
import { formsOfWidget } from './snippetForms/fromWidget'

/**
 * What a form holds.
 *
 * native    the body itself, unchanged
 * docNodes  top-level TipTap nodes, as PlexiiWrite stores them
 * markdown  GitHub-flavoured markdown text
 * text      plain text, one paragraph per line
 * rows      a grid of DISPLAYED values (formulas computed when an evaluator is given)
 * svg       a standalone SVG picture of the content
 * image     a picture held by reference (a URL, a file link or a data: URL)
 * link      a reference to a file, document or folder in Files (a drop from
 *           the Files panel): it carries no content, only where the thing is
 */
export type FormKind = 'native' | 'docNodes' | 'markdown' | 'text' | 'rows' | 'svg' | 'image' | 'link'

/** The app that owns the editable original of a picture, as the user knows it. */
export type SnippetAppName =
  | 'PlexiiWrite'
  | 'PlexiiCells'
  | 'PlexiiDeck'
  | 'PlexiiDesign'
  | 'PlexiiDiagrams'
  | 'PlexiiDraw'
  | 'a work widget'
  /** A picture pasted from outside our apps: its original is wherever it was copied from. */
  | 'the app it came from'
  /** A picture made from a file dropped from Files (an SVG): the file itself is the editable original. */
  | 'the original file'

export interface RowsValue {
  rows: string[][]
  /** The first row reads as column headings (text over the columns, no numbers). */
  header: boolean
}

export interface SvgValue {
  /** Standalone SVG markup with an xmlns. */
  svg: string
  width: number
  height: number
  /**
   * True when the SVG is real vector markup an importer can turn back into
   * editable objects. False when it wraps HTML in a foreignObject, which can
   * only ever be a picture, or when it is offered only AS a picture: a sheet's
   * table (snippetForms/sheetPicture.ts) is vector markup, but its editable
   * original is the sheet, and hundreds of loose boxes and words in a drawing
   * would be worse than one picture of them.
   */
  vector: boolean
  /** Where the editable original lives. */
  app: SnippetAppName
  /**
   * The same art without its backdrop, for importing as objects (a picture
   * wants the app's page colour behind it; editable objects do not want a
   * page-sized rectangle under them). Absent when the picture has no backdrop.
   */
  importSvg?: string
}

export interface ImageValue {
  src: string
  width?: number
  height?: number
  alt?: string
  /**
   * The fb_files row this picture already is, when it came from Files. A work
   * widget then refers to that row (`fb-file://<id>`) instead of storing a
   * second copy of the same bytes. Office builders ignore it and use `src`
   * (the data: URL), because an office document carries its pictures inline.
   */
  fileId?: string
}

/**
 * A reference to something in Files: a file, an office document or a folder.
 * It has no content of its own, so only destinations that hold links take it
 * (PlexiiWrite, page, markdown, sticky and note); every other one refuses it
 * with a reason that names somewhere it can go (snippetConvert/common.ts,
 * linkRefusal).
 */
export interface LinkValue {
  /** Where it points, as a `plexii://file/<id>`, `plexii://document/<id>` or `plexii://folder/<id>` link. */
  href: string
  /** What the person sees: the file's, document's or folder's name. */
  title: string
  target: 'file' | 'document' | 'folder'
  /** The file's type, when it is a file. Decides how a refusal names it (a video, an audio file). */
  mime?: string
}

interface FormOf<K extends FormKind, V> {
  kind: K
  value: V
  /** What the user does NOT get in this form. Plain, British, no em dashes. Empty = faithful. */
  lossy: string[]
}

export type NativeForm = FormOf<'native', SnippetBody>
export type DocNodesForm = FormOf<'docNodes', unknown[]>
export type MarkdownForm = FormOf<'markdown', string>
export type TextForm = FormOf<'text', string>
export type RowsForm = FormOf<'rows', RowsValue>
export type SvgForm = FormOf<'svg', SvgValue>
export type ImageForm = FormOf<'image', ImageValue>
export type LinkForm = FormOf<'link', LinkValue>

/** One way a body can be held, with what that way loses. `kind` discriminates `value`. */
export type Form = NativeForm | DocNodesForm | MarkdownForm | TextForm | RowsForm | SvgForm | ImageForm | LinkForm

/**
 * The lossy line on a picture of a PDF's first page (a PDF dropped from Files
 * into somewhere that holds pictures). The page is rendered by the Files drop
 * reader, which is async and DOM-bound, so it is not a ConvertDeps entry: the
 * reader emits an `image` form carrying this line, and the core stays pure.
 */
export const PDF_FIRST_PAGE = 'Only the first page comes in, as a picture.'

/** What the formula engine says a sheet block displays. */
export interface SheetEvaluation {
  /** The displayed value of every cell, same shape as body.rows. */
  values: string[][]
  /** How many cells held a formula. */
  formulas: number
  /** How many formulas pointed outside the saved cells (or at another sheet) and so show #REF!. */
  outside: number
}

/** A picture of PlexiiDraw objects. */
export interface DrawPicture {
  svg: string
  width: number
  height: number
}

/** Editable PlexiiDraw objects imported from SVG. */
export interface DrawImport {
  objects: unknown[]
  assets: Record<string, unknown>
  swatches: unknown[]
  /** Parts the importer could not keep as vectors, kept as pictures inside the drawing. */
  pictured: number
}

/**
 * The renderer-only capabilities a conversion may use. Every one is optional:
 * without it the shared code says what it cannot do (a refusal, or a stated
 * lossy fallback), never a guess. The real ones are in
 * renderer/src/lib/snippetConvertDeps.ts. Each must itself be deterministic.
 */
export interface ConvertDeps {
  /** Compute what each cell of a sheet block displays (renderer/src/lib/sheetFormula.ts). */
  evaluateSheet?: (body: SheetSnippetBody) => SheetEvaluation
  /** PlexiiDraw objects as SVG (Draw's buildClipboard / drawDocToSvg). Null when nothing can be drawn. */
  drawToSvg?: (body: DrawSnippetBody) => DrawPicture | null
  /** SVG markup as editable PlexiiDraw objects (Draw's importSvgText). Null when it cannot be imported. */
  svgToDraw?: (svg: string) => DrawImport | null
}

/** Every form this body can take, best first. The first is always the native form. */
export function formsOf(body: SnippetBody, deps: ConvertDeps = {}): Form[] {
  switch (body.kind) {
    case 'doc':
      return formsOfDoc(body)
    case 'sheet':
      return formsOfSheet(body, deps)
    case 'slide':
      return formsOfSlide(body)
    case 'design':
      return formsOfDesign(body)
    case 'diagram':
      return formsOfDiagram(body)
    case 'draw':
      return formsOfDraw(body, deps)
    case 'widget':
      return formsOfWidget(body)
  }
}
