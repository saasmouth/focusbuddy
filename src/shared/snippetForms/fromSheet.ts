import type { SheetSnippetBody } from '../snippets'
import type { ConvertDeps, Form } from '../snippetForms'
import { padRows } from './tiptap'
import { looksLikeHeader, rowsToGfm, rowsToTableNode, rowsToTsv } from './rows'
import { L, outsideRefs } from './lossy'

/** The block's input, every cell a string, ragged rows padded. */
export function sheetInput(body: SheetSnippetBody): string[][] {
  const rows = Array.isArray(body.rows) ? body.rows : []
  return padRows(rows.map((r) => (Array.isArray(r) ? r.map((c) => (typeof c === 'string' ? c : '')) : [])))
}

/**
 * What the block DISPLAYS, and what that costs. With the formula engine
 * (deps.evaluateSheet) formulas become their values; without it they are
 * shown as written and the loss says so, rather than a value being guessed.
 */
export function sheetValues(body: SheetSnippetBody, deps: ConvertDeps): { rows: string[][]; lossy: string[] } {
  const input = sheetInput(body)
  const lossy: string[] = []
  let rows = input
  const hasFormula = input.some((r) => r.some((c) => c.trim().startsWith('=')))
  if (hasFormula) {
    if (deps.evaluateSheet) {
      const ev = deps.evaluateSheet({ ...body, rows: input })
      rows = padRows(ev.values.map((r) => r.map((c) => String(c ?? ''))))
      lossy.push(L.formulasValues)
      if (ev.outside > 0) lossy.push(outsideRefs(ev.outside))
    } else lossy.push(L.formulasWritten)
  }
  if (body.formats && Object.keys(body.formats).length) lossy.push(L.cellFormatting)
  if (body.merges?.length) lossy.push(L.mergedSplit)
  if (body.validations?.length) lossy.push(L.validation)
  return { rows, lossy }
}

export function formsOfSheet(body: SheetSnippetBody, deps: ConvertDeps): Form[] {
  const forms: Form[] = [{ kind: 'native', value: body, lossy: [] }]
  const { rows, lossy } = sheetValues(body, deps)
  if (!rows.length || !rows[0].length) return forms
  const header = looksLikeHeader(rows)
  forms.push(
    { kind: 'rows', value: { rows, header }, lossy: [...lossy] },
    { kind: 'docNodes', value: [rowsToTableNode(rows, header)], lossy: [...lossy] },
    { kind: 'markdown', value: rowsToGfm(rows), lossy: [...lossy] },
    { kind: 'text', value: rowsToTsv(rows), lossy: [...lossy] }
  )
  return forms
}
