import type { SlideSnippetBody } from '../snippets'
import type { SlideElement } from '../types'
import type { Form } from '../snippetForms'
import { elementsPictureLossy, elementsText, elementsToSvg, isDrawableElement } from './picture'
import { L } from './lossy'

export function formsOfSlide(body: SlideSnippetBody): Form[] {
  const forms: Form[] = [{ kind: 'native', value: body, lossy: [] }]
  const elements = (Array.isArray(body.elements) ? body.elements : []).filter(isDrawableElement) as SlideElement[]
  if (!elements.length) return forms
  forms.push({ kind: 'svg', value: elementsToSvg(elements, 'PlexiiDeck'), lossy: elementsPictureLossy(elements) })
  const text = elementsText(elements)
  if (text) forms.push({ kind: 'text', value: text, lossy: [L.wordsOnly] })
  return forms
}
