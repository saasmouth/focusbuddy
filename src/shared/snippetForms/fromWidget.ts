import type { WidgetSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'

export function formsOfWidget(body: WidgetSnippetBody): Form[] {
  return [{ kind: 'native', value: body, lossy: [] }]
}
