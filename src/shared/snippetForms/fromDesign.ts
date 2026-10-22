import type { DesignSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'

export function formsOfDesign(body: DesignSnippetBody): Form[] {
  return [{ kind: 'native', value: body, lossy: [] }]
}
