import type { BuildContext, SnippetConversion } from '../snippetConvert'
import type { DrawImageNode, DrawTextNode } from '../draw/model'
import { putAsset } from '../draw/assets'
import { isDrawImageSrc } from '../draw'
import { pictureLossy, svgDataUrl } from '../snippetForms/picture'
import { L } from '../snippetForms/lossy'
import { REASON, fitWithin, linkRefusal, ok, pick, refusal } from './common'
import { formsOfSlide } from '../snippetForms/fromSlide'
import { formsOfDesign } from '../snippetForms/fromDesign'

function imageObject(dataUrl: string, w: number, h: number, alt: string): { node: DrawImageNode; assets: Record<string, unknown> } {
  const size = fitWithin(w, h, 2000, 2000)
  const put = putAsset({}, dataUrl, { w: Math.round(w), h: Math.round(h) })
  return { node: { id: 'image-0', type: 'image', x: 0, y: 0, w: size.w, h: size.h, assetId: put.id, ...(alt ? { alt } : {}) }, assets: put.assets }
}

function textObject(text: string): DrawTextNode {
  return { id: 'text-0', type: 'text', x: 0, y: 0, w: 480, text, fontSize: 18, lineHeight: 1.3, fill: { type: 'solid', color: '#111827' } }
}

/**
 * Into PlexiiDraw: objects. A diagram's SVG is imported as EDITABLE vectors
 * (deps.svgToDraw, Draw's own importer); Deck and Design draw through HTML,
 * which no importer can turn back into shapes, so they land as a picture.
 * Text becomes a text object. A sheet is refused: Draw has no tables.
 */
export function toDraw(ctx: BuildContext): SnippetConversion {
  const { body, deps } = ctx
  if (body?.kind === 'draw') return ok(structuredClone(body), [])
  if (body?.kind === 'sheet') return { ok: false, reason: REASON.drawNoTables }
  // A drawing holds only embedded image bytes (isDrawImageSrc), so a remote
  // picture can never taint Draw's canvas: slide and design bodies are read
  // with Draw's own rule, and an image it refuses is left out and said so.
  const forms = body?.kind === 'slide' ? formsOfSlide(body, isDrawImageSrc) : body?.kind === 'design' ? formsOfDesign(body, isDrawImageSrc) : ctx.forms
  const f = pick(forms, ['svg', 'image', 'text'], body)
  if (!f && !body && forms.some((x) => x.kind === 'rows')) return { ok: false, reason: REASON.drawNoTables }
  if (!f) return linkRefusal(forms, 'draw') ?? refusal(body, 'draw')
  switch (f.kind) {
    case 'svg': {
      const v = f.value
      if (v.vector && deps.svgToDraw) {
        const imported = deps.svgToDraw(v.importSvg ?? v.svg)
        if (imported && imported.objects.length) {
          const lossy = [...f.lossy]
          if (body?.kind === 'diagram') lossy.push(L.connectorsLines)
          if (imported.pictured > 0) lossy.push(L.partsPictured)
          return ok({ kind: 'draw', objects: imported.objects, assets: imported.assets, swatches: imported.swatches }, lossy)
        }
      }
      // HTML in a foreignObject, or no importer here: a picture, said so.
      const pic = imageObject(svgDataUrl(v.svg), v.width, v.height, `Picture from ${v.app}`)
      return ok({ kind: 'draw', objects: [pic.node], assets: pic.assets, swatches: [] }, [pictureLossy(v.app), ...f.lossy])
    }
    case 'image': {
      if (!isDrawImageSrc(f.value.src)) return { ok: false, reason: REASON.linkedPictureDraw }
      const pic = imageObject(f.value.src, f.value.width ?? 360, f.value.height ?? 280, f.value.alt ?? '')
      return ok({ kind: 'draw', objects: [pic.node], assets: pic.assets, swatches: [] }, f.lossy)
    }
    case 'text':
      if (!f.value.trim()) return refusal(body, 'draw')
      return ok({ kind: 'draw', objects: [textObject(f.value.trim())], assets: {}, swatches: [] }, f.lossy)
    default:
      return refusal(body, 'draw')
  }
}
