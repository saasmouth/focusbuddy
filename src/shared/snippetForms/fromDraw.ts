import type { DrawSnippetBody } from '../snippets'
import type { ConvertDeps, Form } from '../snippetForms'
import { L } from './lossy'

/** The words of every text object, groups included, in paint order. */
function drawText(objects: unknown[], out: string[] = [], depth = 0): string[] {
  if (depth > 64) return out
  for (const o of objects) {
    if (!o || typeof o !== 'object') continue
    const n = o as { type?: string; text?: unknown; children?: unknown }
    if (n.type === 'text' && typeof n.text === 'string' && n.text.trim()) out.push(n.text.trim())
    else if (n.type === 'group' && Array.isArray(n.children)) drawText(n.children, out, depth + 1)
  }
  return out
}

export function formsOfDraw(body: DrawSnippetBody, deps: ConvertDeps): Form[] {
  const forms: Form[] = [{ kind: 'native', value: body, lossy: [] }]
  const objects = Array.isArray(body.objects) ? body.objects : []
  if (!objects.length) return forms
  // PlexiiDraw's SVG writer lives in the renderer: without it there is no
  // picture form at all, and a destination that needs one says so.
  const pic = deps.drawToSvg ? deps.drawToSvg(body) : null
  if (pic) forms.push({ kind: 'svg', value: { svg: pic.svg, width: pic.width, height: pic.height, vector: true, app: 'PlexiiDraw' }, lossy: [] })
  const words = drawText(objects)
  if (words.length) forms.push({ kind: 'text', value: words.join('\n'), lossy: [L.wordsOnly] })
  return forms
}
