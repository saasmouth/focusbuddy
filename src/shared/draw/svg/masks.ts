// Clipping groups as SVG markup: the <clipPath> definition and the group
// around the masked members. Shared by the exporter (svg.ts); the canvas
// (render/SceneView.tsx) draws the same parts (ops/masks.ts clipGroupParts) as
// React elements, so a mask can never look different on screen than in the file.
//
// Every id goes through clipId (the id-safe alphabet, like gradient ids) and
// every value through esc, so a hostile document cannot break out of markup.

import { pathToSvgD } from '../../drawGeometry'
import type { DrawNode } from '../model'
import { clipSilhouette, type ClipShape } from '../ops/masks'
import { esc } from '../markup'

/** The SVG id of a clipping group's clip path, held to the id-safe alphabet like gradientId. */
export function clipId(idHint: string): string {
  return `clip-${String(idHint).replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * The <clipPath> element for a clipping group, or '' when the clip shape has
 * no outline to clip with. A path clips with its own outline and fill rule; a
 * type object clips with its glyphs (`renderText` draws it as the serializer
 * draws any type, so the same escaping applies).
 */
export function clipPathMarkup(groupId: string, clip: ClipShape, renderText: (n: DrawNode) => string): string {
  const id = clipId(groupId)
  if (clip.type === 'path') {
    const d = pathToSvgD(clip.path)
    if (!d) return ''
    const rule = clip.path.fillRule === 'evenodd' ? ' clip-rule="evenodd"' : ''
    return `<clipPath id="${esc(id)}"><path d="${esc(d)}"${rule}/></clipPath>`
  }
  const text = renderText(clipSilhouette(clip))
  return text ? `<clipPath id="${esc(id)}">${text}</clipPath>` : ''
}

/**
 * The markup of a clipping group: the masked members (with the clip path's
 * own fill beneath them) inside a clipped <g>, and the clip path's own stroke,
 * when it has one, drawn over them unclipped. With no fill and no stroke on the
 * clip path -- what Make Clipping Mask leaves -- this is the single
 * `<g transform clip-path style>` the format has always written.
 */
export function clipGroupMarkup(opts: { groupId: string; transformAttr: string; styleAttr: string; inner: string; over: string }): string {
  const clip = ` clip-path="url(#${esc(clipId(opts.groupId))})"`
  if (!opts.over) return opts.inner ? `<g${opts.transformAttr}${clip}${opts.styleAttr}>${opts.inner}</g>` : ''
  return `<g${opts.transformAttr}${opts.styleAttr}>${opts.inner ? `<g${clip}>${opts.inner}</g>` : ''}${opts.over}</g>`
}
