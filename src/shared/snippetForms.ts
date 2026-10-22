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
 */
export type FormKind = 'native' | 'docNodes' | 'markdown' | 'text' | 'rows' | 'svg' | 'image'

/** The app that owns the editable original of a picture, as the user knows it. */
export type SnippetAppName = 'PlexiiWrite' | 'PlexiiCells' | 'PlexiiDeck' | 'PlexiiDesign' | 'PlexiiDiagrams' | 'PlexiiDraw' | 'a work widget'

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
   * only ever be a picture.
   */
  vector: boolean
  /** Where the editable original lives. */
  app: SnippetAppName
}

export interface ImageValue {
  src: string
  width?: number
  height?: number
  alt?: string
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

/** One way a body can be held, with what that way loses. `kind` discriminates `value`. */
export type Form = NativeForm | DocNodesForm | MarkdownForm | TextForm | RowsForm | SvgForm | ImageForm

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
