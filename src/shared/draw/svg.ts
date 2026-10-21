// The v2 SVG serializer.
//
// For a document that uses only what v1 had, the output is BYTE-IDENTICAL to
// v1's drawToSvg (tests/unit/drawMigrate.test.ts proves it over a corpus).
// Everything v2 adds renders here too: groups, clipping groups, frame
// transforms, the asset store, swatch references, gradient endpoints, and the
// appearance stack's several fills and strokes. Live EFFECTS are declared in
// the model but not drawn yet -- that is WP-EFFECTS, which compiles them to a
// closed SVG filter vocabulary. Opaque nodes are never written.
//
// Same rule as v1: everything that reaches markup is escaped, a finite number,
// or a member of a closed set, even for a document that skipped normalize.

import { DRAW_BLEND_MODES, estimateWrap, gradientToSvg, isDrawImageSrc, paintToCss, svgPaint, type DrawBlend, type DrawGradientDef, type DrawPaint, type DrawSvgPaint } from '../draw'
import { pathToSvgD } from '../drawGeometry'
import { safeCssColor } from '../cssColor'
import { assetSrc } from './assets'
import { esc, fixed, isNum, num } from './markup'
import type {
  DrawArtboard,
  DrawDoc,
  DrawDocLayer,
  DrawDocPaint,
  DrawDocStroke,
  DrawGroupNode,
  DrawNode,
  DrawPathNode,
  DrawTextNode,
  Matrix
} from './model'

// ── Paint ────────────────────────────────────────────────────────────────────

function parseHex6(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/**
 * A paint with swatch references resolved to the colour they stand for, so
 * screen and file agree. A tint below 1 mixes a hex swatch towards white; a
 * reference to a swatch that no longer exists paints nothing rather than
 * inventing a colour.
 */
export function resolvePaint(doc: Pick<DrawDoc, 'swatches'>, p: DrawDocPaint | undefined): DrawDocPaint | undefined {
  if (!p || p.type !== 'swatch') return p
  const sw = doc.swatches.find((s) => s.id === p.id)
  const color = sw ? safeCssColor(sw.color, undefined) : undefined
  if (!color) return { type: 'none' }
  const tint = isNum(p.tint) ? Math.max(0, Math.min(1, p.tint)) : 1
  if (tint >= 1) return { type: 'solid', color }
  const rgb = parseHex6(color)
  if (!rgb) return { type: 'solid', color }
  const mix = rgb.map((v) => Math.round(255 - (255 - v) * tint).toString(16).padStart(2, '0')).join('')
  return { type: 'solid', color: `#${mix}` }
}

/** A paint as a CSS value (swatches resolved), for on-screen surfaces that are not SVG. */
export function docPaintToCss(doc: Pick<DrawDoc, 'swatches'>, p: DrawDocPaint | undefined): string {
  return paintToCss(resolvePaint(doc, p) as DrawPaint | undefined)
}

function hasGradientExtras(p: DrawDocPaint): boolean {
  if (p.type === 'linear') return p.from !== undefined || p.to !== undefined
  if (p.type === 'radial') return p.center !== undefined || p.radius !== undefined || p.focal !== undefined
  return false
}

function unit(v: unknown, dflt: number): number {
  return isNum(v) ? v : dflt
}

/**
 * The v2 twin of svgPaint. A paint v1 could express goes through v1's own
 * function, so its output is unchanged; swatches and gradient endpoints are
 * the additions.
 */
export function svgDocPaint(doc: Pick<DrawDoc, 'swatches'>, paint: DrawDocPaint | undefined, idHint: string): DrawSvgPaint {
  const p = resolvePaint(doc, paint)
  if (!p || !hasGradientExtras(p)) return svgPaint(p as DrawPaint | undefined, idHint)
  const base = svgPaint(p as DrawPaint, idHint)
  if (!base.gradient) return base
  if (p.type === 'linear') {
    const from = p.from ?? { x: 0, y: 0.5 }
    const to = p.to ?? { x: 1, y: 0.5 }
    return { ...base, gradient: { ...base.gradient, x1: fixed(unit(from.x, 0), 4), y1: fixed(unit(from.y, 0.5), 4), x2: fixed(unit(to.x, 1), 4), y2: fixed(unit(to.y, 0.5), 4) } }
  }
  if (p.type === 'radial') {
    const c = p.center ?? { x: 0.5, y: 0.5 }
    const g: DrawGradientDef = {
      ...base.gradient,
      cx: fixed(unit(c.x, 0.5), 4),
      cy: fixed(unit(c.y, 0.5), 4),
      r: fixed(Math.max(0, unit(p.radius, 0.5)), 4),
      ...(p.focal ? { fx: fixed(unit(p.focal.x, 0.5), 4), fy: fixed(unit(p.focal.y, 0.5), 4) } : {})
    }
    return { ...base, gradient: g }
  }
  return base
}

function paintAttr(doc: DrawDoc, paint: DrawDocPaint | undefined, defs: string[], idHint: string): { value: string; opacity?: number } {
  const p = svgDocPaint(doc, paint, idHint)
  if (p.gradient) defs.push(gradientToSvg(p.gradient))
  return { value: p.value, ...(p.opacity != null ? { opacity: p.opacity } : {}) }
}

// ── Attributes ───────────────────────────────────────────────────────────────

const STROKE_CAPS = new Set(['butt', 'round', 'square'])
const STROKE_JOINS = new Set(['miter', 'round', 'bevel'])

function blendOk(v: unknown): v is DrawBlend {
  return typeof v === 'string' && (DRAW_BLEND_MODES as readonly string[]).includes(v)
}

function strokeAttrs(doc: DrawDoc, stroke: DrawDocStroke | undefined, defs: string[], idHint: string): string {
  if (!stroke) return ''
  const p = paintAttr(doc, stroke.paint, defs, `${idHint}-s`)
  if (p.value === 'none') return ''
  const dash = Array.isArray(stroke.dash) ? stroke.dash.filter((d) => isNum(d) && d >= 0) : []
  return (
    ` stroke="${esc(p.value)}" stroke-width="${num(stroke.width)}"` +
    (p.opacity != null ? ` stroke-opacity="${num(p.opacity)}"` : '') +
    (stroke.cap && STROKE_CAPS.has(stroke.cap) ? ` stroke-linecap="${stroke.cap}"` : '') +
    (stroke.join && STROKE_JOINS.has(stroke.join) ? ` stroke-linejoin="${stroke.join}"` : '') +
    (dash.length ? ` stroke-dasharray="${dash.map(num).join(' ')}"` : '') +
    (isNum(stroke.miterLimit) ? ` stroke-miterlimit="${num(stroke.miterLimit)}"` : '')
  )
}

function styleAttr(o: { opacity?: number; blend?: DrawBlend }): string {
  const bits: string[] = []
  if (isNum(o.opacity) && o.opacity < 1) bits.push(`opacity:${num(o.opacity)}`)
  if (blendOk(o.blend) && o.blend !== 'normal') bits.push(`mix-blend-mode:${o.blend}`)
  return bits.length ? ` style="${bits.join(';')}"` : ''
}

function matrixOk(m: unknown): m is Matrix {
  return Array.isArray(m) && m.length === 6 && m.every(isNum)
}

function matrixStr(m: Matrix): string {
  return `matrix(${m.map(num).join(' ')})`
}

/** A frame's transform attribute: the extra matrix outside, then the rotation about the pivot (v1's exact text). */
function frameTransform(t: Matrix | undefined, rotation: number | undefined, px: number, py: number): string {
  const rot = isNum(rotation) && rotation ? `rotate(${num(rotation)} ${num(px)} ${num(py)})` : ''
  const mat = matrixOk(t) ? matrixStr(t) : ''
  const v = [mat, rot].filter(Boolean).join(' ')
  return v ? ` transform="${v}"` : ''
}

/** The SVG id of a clipping group's clip path, held to the id-safe alphabet like gradientId. */
export function clipId(idHint: string): string {
  return `clip-${String(idHint).replace(/[^A-Za-z0-9_-]/g, '_')}`
}

// ── Nodes ────────────────────────────────────────────────────────────────────

function pathSvg(doc: DrawDoc, o: DrawPathNode, defs: string[]): string {
  const d = pathToSvgD(o.path)
  if (!d) return ''
  const rule = o.path.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''
  if (o.appearance) {
    // Several fills, then several strokes, bottom-up, each its own element; the
    // node's opacity and blend apply to the stack as a whole.
    const parts: string[] = []
    o.appearance.fills.forEach((f, i) => {
      if (f.enabled === false) return
      const p = paintAttr(doc, f.paint, defs, `${o.id}-f${i}`)
      if (p.value === 'none') return
      parts.push(`<path d="${esc(d)}" fill="${esc(p.value)}"${p.opacity != null ? ` fill-opacity="${num(p.opacity)}"` : ''}${rule}${styleAttr(f)}/>`)
    })
    o.appearance.strokes.forEach((s, i) => {
      if (s.enabled === false) return
      const attrs = strokeAttrs(doc, s.stroke, defs, `${o.id}-k${i}`)
      if (!attrs) return
      parts.push(`<path d="${esc(d)}" fill="none"${attrs}${styleAttr(s)}/>`)
    })
    return parts.length ? `<g${styleAttr(o)}>${parts.join('')}</g>` : ''
  }
  const f = paintAttr(doc, o.fill, defs, o.id)
  return (
    `<path d="${esc(d)}" fill="${esc(f.value)}"` +
    (f.opacity != null ? ` fill-opacity="${num(f.opacity)}"` : '') +
    rule +
    strokeAttrs(doc, o.stroke, defs, o.id) +
    styleAttr(o) +
    '/>'
  )
}

function textSvg(doc: DrawDoc, o: DrawTextNode, defs: string[]): string {
  const lh = (o.lineHeight ?? 1.2) * o.fontSize
  const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start'
  const ax = o.align === 'center' ? o.x + o.w / 2 : o.align === 'right' ? o.x + o.w : o.x
  // Prefer the editor's measured breaks; estimateWrap is only the fallback for
  // text no editor has ever laid out.
  const lines = o.lines && o.lines.length ? o.lines : estimateWrap(String(o.text ?? ''), o.w, o.fontSize, o.letterSpacing ?? 0)
  const tspans = lines.map((l, i) => `<tspan x="${num(ax)}" y="${fixed(o.y + o.fontSize + i * lh, 2)}">${esc(String(l)) || ' '}</tspan>`).join('')
  const font =
    `<text font-family="${esc(o.fontFamily ?? 'Inter, system-ui, sans-serif')}" font-size="${num(o.fontSize)}"` +
    (isNum(o.fontWeight) && o.fontWeight ? ` font-weight="${num(o.fontWeight)}"` : '') +
    (o.italic ? ' font-style="italic"' : '') +
    (isNum(o.letterSpacing) && o.letterSpacing ? ` letter-spacing="${num(o.letterSpacing)}"` : '') +
    ` text-anchor="${anchor}"`
  const tr = frameTransform(o.transform, o.rotation, o.x + o.w / 2, o.y)
  if (o.appearance) {
    const parts: string[] = []
    o.appearance.fills.forEach((f, i) => {
      if (f.enabled === false) return
      const p = paintAttr(doc, f.paint, defs, `${o.id}-f${i}`)
      if (p.value === 'none') return
      parts.push(`${font} fill="${esc(p.value)}"${p.opacity != null ? ` fill-opacity="${num(p.opacity)}"` : ''}${styleAttr(f)}>${tspans}</text>`)
    })
    o.appearance.strokes.forEach((s, i) => {
      if (s.enabled === false) return
      const attrs = strokeAttrs(doc, s.stroke, defs, `${o.id}-k${i}`)
      if (!attrs) return
      parts.push(`${font} fill="none"${attrs}${styleAttr(s)}>${tspans}</text>`)
    })
    return parts.length ? `<g${tr}${styleAttr(o)}>${parts.join('')}</g>` : ''
  }
  const f = paintAttr(doc, o.fill, defs, o.id)
  return (
    `${font} fill="${esc(f.value)}"` +
    (f.opacity != null ? ` fill-opacity="${num(f.opacity)}"` : '') +
    strokeAttrs(doc, o.stroke, defs, o.id) +
    tr +
    styleAttr(o) +
    `>${tspans}</text>`
  )
}

function groupSvg(doc: DrawDoc, g: DrawGroupNode, defs: string[]): string {
  const tr = matrixOk(g.transform) ? ` transform="${matrixStr(g.transform)}"` : ''
  let children = g.children
  let clipAttr = ''
  if (g.clip && children.length) {
    // Illustrator's clipping group: the topmost member is the clip path, and
    // is not itself painted.
    const top = children[children.length - 1]
    const d = top.type === 'path' ? pathToSvgD(top.path) : ''
    if (d) {
      const id = clipId(g.id)
      const rule = top.type === 'path' && top.path.fillRule === 'evenodd' ? ' clip-rule="evenodd"' : ''
      defs.push(`<clipPath id="${esc(id)}"><path d="${esc(d)}"${rule}/></clipPath>`)
      clipAttr = ` clip-path="url(#${esc(id)})"`
      children = children.slice(0, -1)
    }
  }
  const inner = children.map((c) => nodeSvg(doc, c, defs)).join('')
  if (!inner) return ''
  return `<g${tr}${clipAttr}${styleAttr(g)}>${inner}</g>`
}

/** One node as markup, appending any definitions it needs to `defs`. */
export function nodeSvg(doc: DrawDoc, o: DrawNode, defs: string[]): string {
  if (o.hidden) return ''
  switch (o.type) {
    case 'path':
      return pathSvg(doc, o, defs)
    case 'text':
      return textSvg(doc, o, defs)
    case 'image': {
      // Only embedded bytes are ever written out; an image whose asset is
      // missing or not image bytes is left out of the file, not linked to.
      const src = assetSrc(doc.assets, o.assetId)
      if (!src || !isDrawImageSrc(src)) return ''
      const tr = frameTransform(o.transform, o.rotation, o.x + o.w / 2, o.y + o.h / 2)
      return `<image href="${esc(src)}" x="${num(o.x)}" y="${num(o.y)}" width="${num(o.w)}" height="${num(o.h)}" preserveAspectRatio="none"${tr}${styleAttr(o)}/>`
    }
    case 'widget':
      // Omitted from export, deliberately: a live work widget cannot be
      // carried by SVG, and a snapshot would be wrong the moment it changed.
      return ''
    case 'group':
      return groupSvg(doc, o, defs)
    default:
      // Opaque (made by a newer PlexiiDraw) or anything else: never markup.
      return ''
  }
}

function layerSvg(doc: DrawDoc, l: DrawDocLayer, board: DrawArtboard, defs: string[]): string {
  const style = styleAttr(l)
  if (l.kind === 'raster') {
    const src = assetSrc(doc.assets, l.assetId)
    if (!src) return ''
    return `<g${style}><image href="${esc(src)}" x="${num(board.x)}" y="${num(board.y)}" width="${num(board.w)}" height="${num(board.h)}" preserveAspectRatio="none"/></g>`
  }
  // A template layer is a tracing aid: shown dimmed in the editor, never exported.
  if (l.template) return ''
  const objs = l.objects.map((o) => nodeSvg(doc, o, defs)).join('')
  if (!objs) return ''
  return `<g${style}>${objs}</g>`
}

/** The artboard an export covers: the one named, else the first. */
export function exportArtboard(doc: DrawDoc, artboardId?: string): DrawArtboard {
  return (artboardId ? doc.artboards.find((a) => a.id === artboardId) : undefined) ?? doc.artboards[0]
}

/**
 * The document as one standalone SVG framed on one artboard (the first unless
 * named). Paint layers ride along as embedded images; widgets and opaque nodes
 * are left out; every other node is real vector markup.
 */
export function drawDocToSvg(doc: DrawDoc, opts: { artboardId?: string } = {}): string {
  const board = exportArtboard(doc, opts.artboardId)
  const defs: string[] = []
  const w = num(board.w)
  const h = num(board.h)
  const layers = doc.layers
    .filter((l) => l.visible)
    .map((l) => layerSvg(doc, l, board, defs))
    .join('')
  const bgPaint = paintAttr(doc, board.background, defs, 'bg')
  const bg = bgPaint.value === 'none' ? '' : `<rect x="${num(board.x)}" y="${num(board.y)}" width="${w}" height="${h}" fill="${esc(bgPaint.value)}"/>`
  const defsBlock = defs.length ? `<defs>${defs.join('')}</defs>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="${num(board.x)} ${num(board.y)} ${w} ${h}">` +
    `${defsBlock}${bg}${layers}</svg>`
  )
}

/** A standalone HTML page wrapping drawDocToSvg, for the offscreen PNG/PDF capture (see drawToHtml). */
export function drawDocToHtml(doc: DrawDoc, opts: { artboardId?: string; cssSize?: { w: number; h: number } } = {}): string {
  const board = exportArtboard(doc, opts.artboardId)
  const transparent = resolvePaint(doc, board.background)?.type === 'none'
  const w = opts.cssSize ? opts.cssSize.w : board.w
  const h = opts.cssSize ? opts.cssSize.h : board.h
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{width:${num(w)}px;height:${num(h)}px;background:${transparent ? 'transparent' : 'none'}}` +
    (opts.cssSize ? `svg{display:block;width:${num(w)}px;height:${num(h)}px}` : '') +
    `</style></head>` +
    `<body>${drawDocToSvg(doc, { artboardId: opts.artboardId })}</body></html>`
  )
}
