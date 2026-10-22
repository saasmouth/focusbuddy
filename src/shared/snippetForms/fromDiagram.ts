import type { DiagramSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'

export function formsOfDiagram(body: DiagramSnippetBody): Form[] {
  return [{ kind: 'native', value: body, lossy: [] }]
}
