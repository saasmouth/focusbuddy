import type { SlideSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'
import { elementsPictureLossy, elementsText, elementsToSvg, usableElements, type ImageSrcCheck } from './picture'
import { L } from './lossy'

export function formsOfSlide(body: SlideSnippetBody, srcOk?: ImageSrcCheck): Form[] {
  const forms: Form[] = [{ kind: 'native', value: body, lossy: [] }]
  const { elements, dropped } = usableElements(body.elements, srcOk)
  const left = dropped ? [L.unsupportedImage] : []
  if (!elements.length) return forms
  forms.push({ kind: 'svg', value: elementsToSvg(elements, 'PlexiiDeck'), lossy: [...elementsPictureLossy(elements), ...left] })
  const text = elementsText(elements)
  if (text) forms.push({ kind: 'text', value: text, lossy: [L.wordsOnly] })
  return forms
}
