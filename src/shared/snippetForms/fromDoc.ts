import type { DocSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'

export function formsOfDoc(body: DocSnippetBody): Form[] {
  return [{ kind: 'native', value: body, lossy: [] }]
}
