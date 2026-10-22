import type { DrawSnippetBody } from '../snippets'
import type { ConvertDeps, Form } from '../snippetForms'

export function formsOfDraw(body: DrawSnippetBody, _deps: ConvertDeps): Form[] {
  return [{ kind: 'native', value: body, lossy: [] }]
}
