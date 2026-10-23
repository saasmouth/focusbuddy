import type { BuildContext, SnippetConversion } from '../snippetConvert'
import type { MapNode } from '../types'
import { getShape } from '../diagram/shapes'
import { pictureLossy, svgDataUrl } from '../snippetForms/picture'
import { L, notesDropped } from '../snippetForms/lossy'
import { fitWithin, linkRefusal, ok, pick, refusal } from './common'

/** As many notes as Diagrams' own text paste makes at once. */
export const DIAGRAM_MAX_NOTES = 50

function node(shape: string, x: number, y: number, extra: Partial<MapNode>, id: string): MapNode {
  const def = getShape(shape)
  return { id, x, y, label: '', shape: def.id, color: def.color ?? '#2563eb', ...extra }
}

/**
 * Into PlexiiDiagrams: shapes. A sheet block is a TABLE shape holding the
 * computed cells (Diagrams' own table, which the canvas edits and every
 * exporter draws). Text is one note per paragraph, up to the 50 Diagrams'
 * paste takes. Anything visual is an image shape holding the picture.
 */
export function toDiagram(ctx: BuildContext): SnippetConversion {
  const { body, forms } = ctx
  if (body?.kind === 'diagram') return ok(structuredClone(body), [])
  const f = pick(forms, ['rows', 'image', 'svg', 'text'], body)
  if (!f) return linkRefusal(forms, 'diagram') ?? refusal(body, 'diagram', ctx.verb)
  switch (f.kind) {
    case 'rows': {
      const rows = f.value.rows
      const cols = rows.reduce((m, r) => Math.max(m, r.length), 0)
      const cells = rows.map((r) => [...r, ...Array<string>(cols - r.length).fill('')])
      const shape = f.value.header ? 'table-header' : 'table-3x3'
      return ok({ kind: 'diagram', nodes: [node(shape, 0, 0, { width: Math.min(1600, cols * 120), height: Math.min(2000, rows.length * 32), cells }, 'table-0')], edges: [] }, f.lossy)
    }
    case 'image': {
      const size = fitWithin(f.value.width ?? 240, f.value.height ?? 160, 800, 800)
      return ok({ kind: 'diagram', nodes: [node('image', 0, 0, { image: f.value.src, width: size.w, height: size.h }, 'image-0')], edges: [] }, f.lossy)
    }
    case 'svg': {
      const size = fitWithin(f.value.width, f.value.height, 800, 800)
      return ok(
        { kind: 'diagram', nodes: [node('image', 0, 0, { image: svgDataUrl(f.value.svg), width: size.w, height: size.h, description: `Picture from ${f.value.app}` }, 'image-0')], edges: [] },
        [pictureLossy(f.value.app), ...f.lossy]
      )
    }
    case 'text': {
      const paras = f.value.split('\n').map((l) => l.trim()).filter(Boolean)
      if (!paras.length) return refusal(body, 'diagram', ctx.verb)
      const kept = paras.slice(0, DIAGRAM_MAX_NOTES)
      const def = getShape('note')
      const nodes = kept.map((label, i) => node('note', 0, i * Math.max(64, def.h + 16), { label }, `note-${i}`))
      const lossy = [...f.lossy, L.eachParagraphNote]
      if (paras.length > kept.length) lossy.push(notesDropped(paras.length - kept.length))
      return ok({ kind: 'diagram', nodes, edges: [] }, lossy)
    }
    default:
      return refusal(body, 'diagram', ctx.verb)
  }
}
