import type { SheetSnippetBody } from '../snippets'
import type { ConvertDeps, Form } from '../snippetForms'

export function formsOfSheet(body: SheetSnippetBody, _deps: ConvertDeps): Form[] {
  return [{ kind: 'native', value: body, lossy: [] }]
}
