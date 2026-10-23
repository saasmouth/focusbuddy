// The lossy sentences, in one place so the same loss always reads the same.
// Plain, British, present tense, about what the person will NOT have.

import type { DocFeatures } from './tiptap'

export const L = {
  formatting: 'Formatting is not kept.',
  stylesPlain: 'Styles become plain text.',
  pictures: 'Pictures are not kept.',
  linkedPictures: 'Pictures linked from files are not kept.',
  embeds: 'Embedded items are not kept.',
  tablesAsLines: 'Tables become lines of text.',
  tablesAsParagraphs: 'Tables become paragraphs.',
  firstTableOnly: 'Only the first table is kept.',
  tableOnly: 'Only the table is kept.',
  mergedSplit: 'Merged cells are split.',
  formulasValues: 'Formulas become their values.',
  formulasWritten: 'Formulas are shown as written.',
  cellFormatting: 'Cell formatting is not kept.',
  validation: 'Data validation is not kept.',
  marksPlain: 'Bold, italic and links become plain text.',
  someStyles: 'Some text styles are not kept.',
  linksPlain: 'Links become plain text.',
  wordsOnly: 'Only the words are kept.',
  labelsOnly: 'Only the shape labels are kept.',
  eachParagraphNote: 'Each paragraph becomes a note.',
  connectorsLines: 'Connectors become plain lines.',
  partsPictured: 'Some parts become pictures inside the drawing.',
  linkedFrames: 'Linked text frames become one text box holding the whole story.',
  linkedFramesFirst: 'Text that flows through linked frames is drawn in the first frame.',
  colourSize: 'Text colour, size and highlighting are not kept.',
  alignment: 'Text alignment is not kept.',
  unsupportedImage: 'An image with an unsupported address was left out.',
  cellsCut: 'Long cells are cut short.',
  cellFonts: 'Cell fonts become the standard one.',
  textBoxesSeparate: 'Text boxes arrive as separate frames; to make the text flow, select them and use Link text frames on the Text tab.',
  // What an Excel workbook dropped from Files leaves behind (main/sheetXlsxRead.ts
  // detects each in the package; a line is said only for what is there).
  charts: 'Charts are not kept.',
  shapes: 'Shapes and text boxes are not kept.',
  pivotTables: 'Pivot tables become plain cells.',
  macros: 'Macros are not kept.',
  comments: 'Comments are not kept.',
  conditionalFormatting: 'Conditional formatting is not kept.',
  otherSheetFormulas: 'Formulas that read other sheets become their saved values.'
} as const

/** A workbook with more than one sheet: only the first comes in. "First sheet of 3." */
export function firstSheetOf(n: number): string {
  return `First sheet of ${n}.`
}

/** How many formulas could not be computed from the saved cells alone. */
export function outsideRefs(n: number): string {
  return n === 1
    ? '1 formula points outside the saved cells and shows #REF!.'
    : `${n} formulas point outside the saved cells and show #REF!.`
}

/** What a picture of a sheet leaves out past its row limit: "Showing the first 60 rows of 250." */
export function rowsShown(shown: number, total: number): string {
  return `Showing the first ${shown} rows of ${total}.`
}

/** The same for columns: "Showing the first 16 columns of 40." */
export function columnsShown(shown: number, total: number): string {
  return `Showing the first ${shown} columns of ${total}.`
}

/** What a diagram drops past its 50-note limit. */
export function notesDropped(n: number): string {
  return n === 1
    ? '1 more paragraph is left out: a diagram takes up to 50 at once.'
    : `${n} more paragraphs are left out: a diagram takes up to 50 at once.`
}

/** Unique, in first-seen order. */
export function uniq(list: string[]): string[] {
  return [...new Set(list)]
}

/** What a document fragment loses when it becomes plain text. */
export function docTextLossy(f: DocFeatures): string[] {
  const out: string[] = []
  if (f.marks.size || f.headings || f.lists || f.quotes || f.codeBlocks) out.push(L.stylesPlain)
  if (f.tables) out.push(L.tablesAsLines)
  if (f.images) out.push(L.pictures)
  if (f.other.size) out.push(L.embeds)
  return out
}

/** Marks markdown can write. */
const MD_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link'])

/** What a document fragment loses as markdown. */
export function docMarkdownLossy(f: DocFeatures): string[] {
  const out: string[] = []
  if ([...f.marks].some((m) => !MD_MARKS.has(m))) out.push(L.colourSize)
  if (f.other.size) out.push(L.embeds)
  return out
}
