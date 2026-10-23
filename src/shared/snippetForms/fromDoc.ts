import type { DocSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'
import { docFeatures, firstTableRows, nodesToLines, nodesToPlainText, tiptapToMarkdown } from './tiptap'
import { looksLikeHeader } from './rows'
import { L, docMarkdownLossy, docTextLossy, uniq } from './lossy'

/** The forms a list of TipTap nodes can take (everything but the native body). */
export function formsOfDocNodes(content: unknown[]): Form[] {
  const nodes = structuredClone(content)
  const f = docFeatures(nodes)
  const forms: Form[] = [
    { kind: 'docNodes', value: nodes, lossy: [] },
    { kind: 'markdown', value: tiptapToMarkdown(nodes), lossy: docMarkdownLossy(f) },
    { kind: 'text', value: nodesToPlainText(nodes), lossy: docTextLossy(f) }
  ]
  // Rows: the first table's cells when there is a table, otherwise one line of
  // text per row. Last, because only a grid destination wants it over text.
  const table = firstTableRows(nodes)
  if (table && table.rows.length) {
    const lossy: string[] = [L.formatting]
    const outside = nodes.filter((n) => (n as { type?: string })?.type !== 'table')
    if (f.tables > 1 || nodesToLines(outside).length > 0) lossy.push(L.firstTableOnly)
    if (table.spans) lossy.push(L.mergedSplit)
    forms.push({ kind: 'rows', value: { rows: table.rows, header: table.header || looksLikeHeader(table.rows) }, lossy })
  } else {
    const lines = nodesToLines(nodes)
    if (lines.length) {
      const lossy: string[] = []
      if (f.marks.size || f.headings || f.lists || f.quotes || f.codeBlocks) lossy.push(L.formatting)
      if (f.images) lossy.push(L.pictures)
      if (f.other.size) lossy.push(L.embeds)
      forms.push({ kind: 'rows', value: { rows: lines.map((l) => [l]), header: false }, lossy: uniq(lossy) })
    }
  }
  return forms
}

export function formsOfDoc(body: DocSnippetBody): Form[] {
  const content = Array.isArray(body.content) ? body.content : []
  return [{ kind: 'native', value: body, lossy: [] }, ...formsOfDocNodes(content)]
}
