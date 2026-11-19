// What the assistant's composer does with a paste (components/assistant/
// MentionComposer). The composer is a TipTap editor, and left to itself
// ProseMirror reads a paste's HTML: a range from Sheets, Excel or Numbers then
// arrived as one line with its tabs gone (table cells are not blocks to it,
// and it collapses whitespace), and plain text lost its blank lines. Text with
// line breaks or tabs, or a table, therefore goes in exactly as written: one
// paragraph per line, blank lines and tabs kept. A one-line paste is left to the
// editor, so a mention chip copied from the composer still pastes as a chip.
import { Fragment, Slice, type Schema } from '@tiptap/pm/model'
import { htmlTableMatrix } from './tableSelection'

/** The plain text to put in: the clipboard's text, or a pasted HTML table as tab-separated lines. */
export function pastedPlainText(text: string, html: string): string {
  if (text) return text
  const table = html ? htmlTableMatrix(html) : null
  return table ? table.map((r) => r.join('\t')).join('\n') : ''
}

/** Does this paste need to go in line by line (rather than through the editor's HTML reading)? */
export function wantsPlainLines(text: string, html: string): boolean {
  return /[\n\t]/.test(text) || /<table[\s>]/i.test(html)
}

/**
 * Plain text as composer paragraphs: one per line, blank lines and tabs kept.
 * Open at both ends, so the first line joins the paragraph the caret is in and
 * the last line runs into what follows it, as typing would.
 */
export function linesSlice(schema: Schema, text: string): Slice {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  const paragraph = schema.nodes.paragraph
  const nodes = lines.map((line) => paragraph.create(null, line ? schema.text(line) : null))
  return new Slice(Fragment.from(nodes), 1, 1)
}
