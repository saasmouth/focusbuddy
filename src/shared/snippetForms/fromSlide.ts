import type { SlideSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'

export function formsOfSlide(body: SlideSnippetBody): Form[] {
  return [{ kind: 'native', value: body, lossy: [] }]
}
