// The SVG importer: a parsed SVG document to PlexiiDraw nodes.
//
// It reads the subset of SVG that design tools write -- Illustrator, Figma,
// Inkscape, and PlexiiDraw's own export -- and turns it into EDITABLE art:
//
//   path rect circle ellipse line polyline polygon   -> paths (transforms baked
//                                                      in, as the model keeps them)
//   g a switch svg(nested)                           -> groups
//   use (with symbol, svg or any element)            -> expanded copies
//   clip-path                                         -> clipping groups
//   linear / radial gradients                         -> gradient paints
//   marker-start / -mid / -end                        -> the marker art, as vectors
//   text / tspan                                      -> text objects
//   image (embedded data only)                        -> image objects
//
// with fill, stroke and every stroke-* property, opacity, fill-rule, blend
// modes, and CSS from both style attributes and <style> class rules.
//
// Anything it cannot represent as editable art -- filters, masks, patterns,
// embedded HTML -- is not dropped: the element is kept as an embedded IMAGE
// of itself (a "fallback"), rasterised by the caller, and listed in the report.
//
// It is safe against hostile files. Nothing is executed or fetched: scripts
// and event attributes are never read; only `#fragment` references are
// followed and only `data:image/...` bytes are embedded; every number is
// checked; and the work done is bounded (elements visited, nodes produced,
// `use` expansions and nesting depth). The text-level guard (DOCTYPE,
// entities, size) is sanitize.ts, which runs before the XML parser.
//
// Output is always the full v2 structure; lowerToV1 (v1.ts) turns it into
// what an older-format drawing can hold.

import { DRAW_BLEND_MODES, drawId, isDrawImageSrc, type DrawBlend } from '../../../draw'
import { pathBounds, transformPath, type DrawPath } from '../../../drawGeometry'
import { putAsset } from '../../assets'
import type { Box, DrawAsset, DrawDocPaint, DrawDocStroke, DrawGroupNode, DrawImageNode, DrawNode, DrawPathNode, DrawTextNode, Matrix } from '../../model'
import { nodesBounds } from '../../ops/geometry'
import { base64ToBytes, rasterInfo, sniffImportKind } from '../imageInfo'
import { parseColor } from './color'
import { addStyleSheet, cascadedStyle, emptySheets, parentEl, type StyleSheetSet } from './css'
import { clamp01, inRange, MAX_COORD, numberList, parseLength, parseNumberOrPercent, type Axis } from './numbers'
import { gradientPaint, type GradientSpec, type GradientStop, type PaintNotes } from './paint'
import { parsePathData } from './pathData'
import { SvgImportReport } from './report'
import { decompose, frameRepresentable, IDENTITY, isAnisotropic, isIdentity, meanScale, mul, parseTransform, rotateDeg, translate, viewBoxTransform } from './transform'

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const XLINK_NS = 'http://www.w3.org/1999/xlink'

// ── The DOM we read (a browser Element or happy-dom's satisfies it) ─────────

export interface XmlAttr {
  name: string
  localName: string
  namespaceURI: string | null
  value: string
}

export interface XmlNode {
  nodeType: number
  nodeValue: string | null
}

export interface XmlElement extends XmlNode {
  localName: string
  namespaceURI: string | null
  getAttribute(name: string): string | null
  hasAttribute?(name: string): boolean
  attributes: ArrayLike<XmlAttr>
  childNodes: ArrayLike<XmlNode>
  parentNode: unknown
  textContent: string | null
}

export interface XmlDocument {
  documentElement: XmlElement | null
}

// ── Options and output ──────────────────────────────────────────────────────

export interface SvgLimits {
  /** Elements visited, counting every `use` expansion. */
  maxElements: number
  /** Nodes produced. */
  maxNodes: number
  /** Nesting depth (groups, nested svg, use). */
  maxDepth: number
  /** `use` expansions in total. */
  maxUses: number
}

export const DEFAULT_SVG_LIMITS: SvgLimits = { maxElements: 200_000, maxNodes: 50_000, maxDepth: 96, maxUses: 20_000 }

export interface SvgImportOptions {
  /** 'open' maps top-level groups to layers and a full-page backdrop to the artboard background; 'import' keeps everything as art. */
  mode: 'open' | 'import'
  newId?: (prefix: string) => string
  limits?: Partial<SvgLimits>
}

/** An element kept as an image of itself, waiting to be rasterised. */
export interface SvgFallback {
  /** The image node standing in for it (its assetId is filled in by resolveFallbacks). */
  nodeId: string
  /** A standalone, sanitised SVG of just that element, framed on `box`. */
  markup: string
  /** Document-space box the image covers. */
  box: Box
  /** What made it unrepresentable ("filter", "mask", ...). */
  reasons: string[]
}

export interface SvgImportLayer {
  name: string
  nodes: DrawNode[]
  opacity: number
  blend: DrawBlend
  visible: boolean
}

export interface SvgImportOutput {
  /** The artboard the file describes, in document units (CSS px). */
  width: number
  height: number
  layers: SvgImportLayer[]
  background?: DrawDocPaint
  assets: Record<string, DrawAsset>
  fallbacks: SvgFallback[]
  report: SvgImportReport
}

// ── Computed style ───────────────────────────────────────────────────────────

const INHERITED = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'color',
  'font-family',
  'font-weight',
  'font-style',
  'text-anchor',
  'letter-spacing',
  'visibility',
  'clip-rule',
  'white-space',
  'marker-start',
  'marker-mid',
  'marker-end',
  'paint-order',
  'text-decoration'
] as const

const NON_INHERITED = ['opacity', 'display', 'clip-path', 'mask', 'filter', 'mix-blend-mode', 'stop-color', 'stop-opacity', 'transform', 'vector-effect', 'overflow'] as const

const PRESENTATION = new Set<string>([...INHERITED, ...NON_INHERITED, 'font-size', 'marker'])

interface Computed {
  props: Record<string, string | undefined>
  fontSize: number
}

const ROOT_STYLE: Computed = {
  props: { fill: 'black', stroke: 'none', 'stroke-width': '1', visibility: 'visible', 'fill-rule': 'nonzero', 'clip-rule': 'nonzero', color: 'black' },
  fontSize: 16
}

// ── State ────────────────────────────────────────────────────────────────────

interface Ctx {
  ctm: Matrix
  /** The parent's computed style (what this element inherits). */
  parent: Computed
  vw: number
  vh: number
  depth: number
  /** `use` targets being expanded, for cycle detection. */
  useStack: XmlElement[]
  /** Measuring an element's extent for a fallback: no fallbacks, no clips, no report. */
  measure?: boolean
}

class Importer {
  readonly report = new SvgImportReport()
  readonly limits: SvgLimits
  readonly ids = new Map<string, XmlElement>()
  readonly sheets: StyleSheetSet = emptySheets()
  assets: Record<string, DrawAsset> = {}
  readonly fallbacks: SvgFallback[] = []
  readonly newId: (prefix: string) => string
  private visited = 0
  private produced = 0
  private uses = 0
  private stopped = false
  private styleCache = new Map<XmlElement, Computed>()
  private measureDepth = 0
  readonly notes: PaintNotes

  constructor(opts: SvgImportOptions) {
    this.limits = { ...DEFAULT_SVG_LIMITS, ...(opts.limits ?? {}) }
    this.newId = opts.newId ?? ((p) => drawId(p))
    this.notes = {
      approxRadial: () => this.note('radial', '1 radial gradient was stretched in a way PlexiiDraw cannot draw exactly; its shape was approximated.', '{n} radial gradients were stretched in ways PlexiiDraw cannot draw exactly; their shapes were approximated.'),
      spread: () => this.note('spread', '1 gradient repeats or reflects; it was imported with its end colours extended instead.', '{n} gradients repeat or reflect; they were imported with their end colours extended instead.'),
      degenerateBox: () => this.note('flatgrad', '1 gradient on a shape with no width or height became a solid colour.', '{n} gradients on shapes with no width or height became solid colours.')
    }
  }

  note(key: string, one: string, many: string, loss = true): void {
    if (this.measureDepth > 0) return
    this.report.note(key, one, many, loss)
  }

  // ── Budget ────────────────────────────────────────────────────────────────

  private tick(): boolean {
    if (this.stopped) return false
    this.visited++
    if (this.visited > this.limits.maxElements) {
      this.stopped = true
      this.report.note('limit', `The file has more than ${this.limits.maxElements.toLocaleString('en')} elements; the rest were not imported.`, '', true)
      return false
    }
    return true
  }

  private produce(): boolean {
    if (this.measureDepth > 0) return true
    this.produced++
    if (this.produced > this.limits.maxNodes) {
      if (!this.stopped) this.report.note('nodelimit', `The file makes more than ${this.limits.maxNodes.toLocaleString('en')} objects; the rest were not imported.`, '', true)
      this.stopped = true
      return false
    }
    return true
  }

  // ── Document setup ────────────────────────────────────────────────────────

  index(root: XmlElement): void {
    const stack: XmlElement[] = [root]
    let n = 0
    while (stack.length) {
      const el = stack.pop()!
      if (++n > this.limits.maxElements * 2) break
      const id = attr(el, 'id')
      if (id && !this.ids.has(id)) this.ids.set(id, el)
      if (isSvg(el) && el.localName === 'style') {
        const type = attr(el, 'type')
        if (!type || /^text\/css$/i.test(type.trim())) addStyleSheet(this.sheets, el.textContent ?? '')
      }
      const kids = elementChildren(el)
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
    }
    if (this.sheets.imports) this.note('cssimport', '1 CSS @import was not followed (external files are never loaded).', '{n} CSS @imports were not followed (external files are never loaded).')
    if (this.sheets.skippedSelectors) this.note('cssselector', '1 CSS rule uses a selector PlexiiDraw does not evaluate and was skipped.', '{n} CSS rules use selectors PlexiiDraw does not evaluate and were skipped.')
  }

  // ── Style ─────────────────────────────────────────────────────────────────

  computeStyle(el: XmlElement, parent: Computed): Computed {
    const props: Record<string, string | undefined> = {}
    for (const p of INHERITED) props[p] = parent.props[p]
    let fontSizeRaw: string | undefined
    const set = (p: string, v: string): void => {
      const val = v.trim()
      if (p === 'font-size') {
        fontSizeRaw = val
        return
      }
      if (p === 'font') {
        expandFontShorthand(val, set)
        return
      }
      if (p === 'marker') {
        set('marker-start', val)
        set('marker-mid', val)
        set('marker-end', val)
        return
      }
      if (val === 'inherit') props[p] = parent.props[p]
      else props[p] = val
    }
    for (const a of attrList(el)) {
      if (!a.namespaceURI && PRESENTATION.has(a.localName)) set(a.localName, a.value)
      else if (a.name === 'xml:space' && a.value === 'preserve') props['white-space'] = 'pre'
    }
    for (const [p, v] of cascadedStyle(el, this.sheets)) set(p, v)
    let fontSize = parent.fontSize
    if (fontSizeRaw && fontSizeRaw !== 'inherit') {
      const named: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32 }
      const v = named[fontSizeRaw] ?? (/%$/.test(fontSizeRaw) ? ((parseNumberOrPercent(fontSizeRaw) ?? 1) * parent.fontSize) : parseLength(fontSizeRaw, 'other', { vw: 0, vh: 0, fontSize: parent.fontSize }))
      if (v !== null && v > 0 && v < 100000) fontSize = v
    }
    return { props, fontSize }
  }

  /** The computed style of any element, from the root down (cached): for markers, gradients' stops, clip paths. */
  styleOf(el: XmlElement): Computed {
    const hit = this.styleCache.get(el)
    if (hit) return hit
    const chain: XmlElement[] = []
    for (let p: XmlElement | null = el; p && chain.length < 512; p = parentEl(p)) chain.unshift(p)
    let s = ROOT_STYLE
    for (const e of chain) {
      const c = this.styleCache.get(e)
      if (c) {
        s = c
        continue
      }
      s = this.computeStyle(e, s)
      this.styleCache.set(e, s)
    }
    return s
  }

  // ── References ────────────────────────────────────────────────────────────

  /** The element a `url(#id)` paint/clip value or a `#id` href names; refuses anything external. */
  urlTarget(v: string | undefined, what: string): XmlElement | null | 'external' {
    if (!v) return null
    const m = /^url\(\s*(['"]?)([^'")]*)\1\s*\)/i.exec(v.trim())
    if (!m) return null
    return this.hrefTarget(m[2], what)
  }

  hrefTarget(ref: string | null, what: string): XmlElement | null | 'external' {
    if (!ref) return null
    const r = ref.trim()
    if (r.startsWith('#')) return this.ids.get(decodeURIComponentSafe(r.slice(1))) ?? null
    this.note(`external:${what}`, `1 reference to an external file (${what}) was not followed: PlexiiDraw never loads files a drawing points to.`, `{n} references to external files (${what}) were not followed: PlexiiDraw never loads files a drawing points to.`)
    return 'external'
  }

  // ── Paint ─────────────────────────────────────────────────────────────────

  paint(value: string | undefined, opacity: number, style: Computed, localBox: Box, ctm: Matrix, docBox: Box, isFill: boolean): DrawDocPaint {
    const v = (value ?? (isFill ? 'black' : 'none')).trim()
    if (v === 'none') return { type: 'none' }
    if (v === 'context-fill' || v === 'context-stroke') {
      // A marker painted in the colours of the path it sits on.
      const c = this.context
      if (!c) return { type: 'none' }
      return this.paint(v === 'context-fill' ? c.fill : c.stroke, opacity, c.style, localBox, ctm, docBox, v === 'context-fill')
    }
    const solid = (s: string): DrawDocPaint | null => {
      const c = s.toLowerCase() === 'currentcolor' ? parseColor(style.props.color ?? 'black') : parseColor(s)
      if (!c) return null
      const a = clamp01(c.alpha * opacity)
      return { type: 'solid', color: c.hex, ...(a < 1 ? { opacity: round(a, 4) } : {}) }
    }
    if (/^url\(/i.test(v)) {
      const fallbackText = v.replace(/^url\([^)]*\)\s*/i, '')
      const t = this.urlTarget(v, 'paint')
      if (t && t !== 'external' && isSvg(t) && (t.localName === 'linearGradient' || t.localName === 'radialGradient')) {
        const spec = this.gradientSpec(t)
        if (spec) return gradientPaint(spec, localBox, ctm, docBox, clamp01(opacity), this.notes)
      }
      if (fallbackText) return solid(fallbackText) ?? { type: 'none' }
      return { type: 'none' }
    }
    const s = solid(v)
    if (s) return s
    this.note('badcolor', `1 colour could not be read ("${v.slice(0, 40)}") and was imported as ${isFill ? 'black' : 'no stroke'}.`, '{n} colours could not be read and were imported with their defaults.')
    return isFill ? { type: 'solid', color: '#000000' } : { type: 'none' }
  }

  gradientSpec(el: XmlElement): GradientSpec | null {
    // Attributes and stops are inherited along the href chain.
    const chain: XmlElement[] = []
    for (let g: XmlElement | null = el; g && chain.length < 32; ) {
      if (chain.includes(g)) break
      chain.push(g)
      const t = this.hrefTarget(href(g), 'gradient')
      g = t && t !== 'external' && isSvg(t) && (t.localName === 'linearGradient' || t.localName === 'radialGradient') ? t : null
    }
    const chainAttr = (name: string): string | null => {
      for (const g of chain) {
        const v = attr(g, name)
        if (v !== null) return v
      }
      return null
    }
    const kind = el.localName === 'linearGradient' ? 'linear' : 'radial'
    const objectBox = chainAttr('gradientUnits') !== 'userSpaceOnUse'
    const vp = { vw: this.rootW, vh: this.rootH, fontSize: 16 }
    const coord = (name: string, axis: Axis, dflt: number): number => {
      const v = chainAttr(name)
      if (v === null) return dflt
      if (objectBox) return parseNumberOrPercent(v) ?? dflt
      return parseLength(v, axis, vp) ?? dflt
    }
    const pct = (f: number, axis: Axis): number => (objectBox ? f : f * (axis === 'x' ? vp.vw : axis === 'y' ? vp.vh : Math.sqrt((vp.vw ** 2 + vp.vh ** 2) / 2)))
    const transform = parseTransform(chainAttr('gradientTransform')) ?? IDENTITY
    const spreadRaw = chainAttr('spreadMethod')
    const spread = spreadRaw === 'reflect' || spreadRaw === 'repeat' ? spreadRaw : 'pad'
    let stopEls: XmlElement[] = []
    for (const g of chain) {
      stopEls = elementChildren(g).filter((c) => isSvg(c) && c.localName === 'stop')
      if (stopEls.length) break
    }
    const stops: GradientStop[] = []
    let last = 0
    for (const s of stopEls.slice(0, 256)) {
      const st = this.styleOf(s)
      const off = clamp01(parseNumberOrPercent(attr(s, 'offset')) ?? 0)
      const offset = Math.max(last, off)
      last = offset
      const colorRaw = st.props['stop-color'] ?? 'black'
      const c = colorRaw.toLowerCase() === 'currentcolor' ? parseColor(st.props.color ?? 'black') : parseColor(colorRaw)
      const op = clamp01(parseNumberOrPercent(st.props['stop-opacity']) ?? 1)
      stops.push({ offset: round(offset, 6), hex: c?.hex ?? '#000000', alpha: (c?.alpha ?? 1) * op })
    }
    const cx = coord('cx', 'x', pct(0.5, 'x'))
    const cy = coord('cy', 'y', pct(0.5, 'y'))
    return {
      kind,
      x1: coord('x1', 'x', 0),
      y1: coord('y1', 'y', 0),
      x2: coord('x2', 'x', pct(1, 'x')),
      y2: coord('y2', 'y', 0),
      cx,
      cy,
      r: coord('r', 'other', pct(0.5, 'other')),
      fx: coord('fx', 'x', cx),
      fy: coord('fy', 'y', cy),
      objectBox,
      transform,
      spread,
      stops
    }
  }

  stroke(style: Computed, localBox: Box, ctm: Matrix, docBox: Box): DrawDocStroke | undefined {
    const p = style.props
    const op = clamp01(parseNumberOrPercent(p['stroke-opacity']) ?? 1)
    const paint = this.paint(p.stroke ?? 'none', op, style, localBox, ctm, docBox, false)
    if (paint.type === 'none') return undefined
    const lc = { vw: this.rootW, vh: this.rootH, fontSize: style.fontSize }
    const nonScaling = (p['vector-effect'] ?? '').trim() === 'non-scaling-stroke'
    const k = nonScaling ? 1 : meanScale(ctm)
    const w0 = parseLength(p['stroke-width'] ?? '1', 'other', lc) ?? 1
    if (w0 <= 0) return undefined
    if (!nonScaling && isAnisotropic(ctm)) this.note('aniso', '1 stroke was stretched unevenly by its transform; its width was averaged.', '{n} strokes were stretched unevenly by their transforms; their widths were averaged.')
    const out: DrawDocStroke = { paint, width: round(w0 * k, 4) }
    const cap = p['stroke-linecap']?.trim()
    // Written-out defaults are kept too, so a file says what it said.
    if (cap === 'butt' || cap === 'round' || cap === 'square') out.cap = cap
    const join = p['stroke-linejoin']?.trim()
    if (join === 'miter' || join === 'round' || join === 'bevel') out.join = join
    else if (join === 'miter-clip' || join === 'arcs') out.join = 'miter'
    const ml = parseNumberOrPercent(p['stroke-miterlimit'])
    if (ml !== null && ml >= 1 && ml !== 4) out.miterLimit = ml
    const da = p['stroke-dasharray']?.trim()
    if (da && da !== 'none') {
      const parts = da.split(/[\s,]+/).filter(Boolean).map((s) => parseLength(s, 'other', lc))
      if (parts.every((v): v is number => v !== null && v >= 0) && parts.some((v) => v > 0)) {
        const full = parts.length % 2 ? [...parts, ...parts] : parts
        out.dash = full.map((v) => round(v * k, 4))
        const off = parseLength(p['stroke-dashoffset'] ?? '0', 'other', lc) ?? 0
        if (Math.abs(off) > 1e-9) this.note('dashoffset', '1 dashed stroke has a dash offset, which PlexiiDraw does not keep; its dashes may start at a different point.', '{n} dashed strokes have dash offsets, which PlexiiDraw does not keep; their dashes may start at different points.')
      }
    }
    if ((p['paint-order'] ?? '').trim().startsWith('stroke')) this.note('paintorder', '1 object paints its stroke under its fill; it was imported with the stroke on top.', '{n} objects paint their strokes under their fills; they were imported with strokes on top.')
    return out
  }

  /** Opacity, blend, visibility and a name: what every node carries. */
  common(el: XmlElement, style: Computed): Partial<DrawPathNode> {
    const out: Partial<DrawPathNode> = {}
    const op = parseNumberOrPercent(style.props.opacity)
    if (op !== null && op < 1) out.opacity = round(clamp01(op), 4)
    const blend = style.props['mix-blend-mode']?.trim()
    if (blend && blend !== 'normal') {
      if ((DRAW_BLEND_MODES as readonly string[]).includes(blend)) out.blend = blend as DrawBlend
      else this.note('blend', `1 blend mode ("${blend.slice(0, 20)}") is not available and was imported as Normal.`, '{n} blend modes are not available and were imported as Normal.')
    }
    const vis = style.props.visibility?.trim()
    if (vis === 'hidden' || vis === 'collapse') out.hidden = true
    const name = nodeName(el)
    if (name) out.name = name
    return out
  }

  rootW = 0
  rootH = 0
  /** The path a marker is being drawn for, for context-fill and context-stroke. */
  context: { fill: string | undefined; stroke: string | undefined; style: Computed } | null = null

  // ── Elements ──────────────────────────────────────────────────────────────

  children(el: XmlElement, ctx: Ctx, style: Computed): DrawNode[] {
    const out: DrawNode[] = []
    for (const c of elementChildren(el)) {
      if (this.stopped) break
      out.push(...this.element(c, { ...ctx, parent: style, depth: ctx.depth + 1 }))
    }
    return out
  }

  element(el: XmlElement, ctx: Ctx): DrawNode[] {
    if (!isSvg(el)) return []
    if (!this.tick()) return []
    if (ctx.depth > this.limits.maxDepth) {
      this.note('depth', `Content nested deeper than ${this.limits.maxDepth} levels was not imported.`, `Content nested deeper than ${this.limits.maxDepth} levels was not imported ({n} places).`)
      return []
    }
    const tag = el.localName
    if (NEVER_RENDERED.has(tag)) return []
    if (tag === 'script') {
      this.note('script', '1 script was removed; nothing in an imported file is ever run.', '{n} scripts were removed; nothing in an imported file is ever run.', false)
      return []
    }
    if (ANIMATION.has(tag)) {
      this.note('anim', '1 animation was not imported (PlexiiDraw artwork is still).', '{n} animations were not imported (PlexiiDraw artwork is still).')
      return []
    }
    if (!RENDERED.has(tag)) {
      this.note(`unknown:${tag}`, `1 <${tag}> element is not supported and was not imported.`, `{n} <${tag}> elements are not supported and were not imported.`)
      return []
    }
    const style = this.computeStyle(el, ctx.parent)
    if ((style.props.display ?? '').trim() === 'none') return []
    // The element's own transform: the attribute, or a CSS transform over it.
    const tRaw = style.props.transform ?? attr(el, 'transform')
    let local = parseTransform(tRaw)
    if (!local) {
      this.note('badtransform', '1 transform could not be read and was ignored.', '{n} transforms could not be read and were ignored.')
      local = IDENTITY
    }
    // A <use>'s own transform is applied inside convertUse (with its x/y).
    const ctm = tag === 'use' || tag === 'svg' ? ctx.ctm : mul(ctx.ctm, local)
    const here: Ctx = { ...ctx, ctm }

    if (!ctx.measure) {
      const reasons = this.unsupported(el, style)
      // Measured and drawn from the PARENT's space: the element keeps its own transform.
      if (reasons.length) return this.fallback(el, ctx, style, reasons)
    }

    let nodes: DrawNode[]
    switch (tag) {
      case 'g':
      case 'a':
        // Illustrator wraps its art in a group it marks as extraneous: not one of the user's.
        if (attr(el, 'i:extraneous') === 'self') {
          nodes = this.children(el, here, style)
          break
        }
        nodes = this.group(el, here, style, this.children(el, here, style))
        if (tag === 'a') this.note('link', '1 link was imported as a plain group.', '{n} links were imported as plain groups.', false)
        break
      case 'switch': {
        // A switch draws its first child that applies; it is not a group of its own.
        const chosen = elementChildren(el).find((c) => isSvg(c) && switchAccepts(c))
        nodes = chosen ? this.element(chosen, { ...here, parent: style, depth: ctx.depth + 1 }) : []
        break
      }
      case 'svg':
        nodes = this.nestedSvg(el, { ...here, ctm: mul(ctx.ctm, local) }, style)
        break
      case 'use':
        nodes = this.use(el, ctx, style, local)
        break
      case 'text':
        nodes = this.text(el, here, style)
        break
      case 'image':
        nodes = this.image(el, here, style)
        break
      default:
        nodes = this.shape(el, here, style)
    }
    // A <use> applies its own clip (in its own space) inside use().
    if (!nodes.length || ctx.measure || tag === 'use') return nodes
    const clip = style.props['clip-path']?.trim()
    if (clip && clip !== 'none') return this.clip(el, here, style, clip, nodes)
    return nodes
  }

  /** Why an element cannot be imported as editable art (empty when it can). */
  unsupported(el: XmlElement, style: Computed): string[] {
    const out: string[] = []
    const ref = (prop: string, kinds: string[]): boolean => {
      const v = style.props[prop]?.trim()
      if (!v || v === 'none' || !/^url\(/i.test(v)) return false
      const t = this.urlTarget(v, prop)
      return !!t && t !== 'external' && kinds.includes(t.localName)
    }
    if (ref('filter', ['filter'])) out.push('filter')
    else if ((style.props.filter ?? 'none').trim() !== 'none' && !/^url\(/i.test(style.props.filter ?? '')) out.push('CSS filter')
    if (ref('mask', ['mask'])) out.push('mask')
    if (ref('fill', ['pattern']) || ref('stroke', ['pattern'])) out.push('pattern')
    if (el.localName === 'foreignObject') out.push('embedded HTML (foreignObject)')
    const clip = style.props['clip-path']?.trim()
    if (clip && clip !== 'none') {
      const t = this.urlTarget(clip, 'clip-path')
      if (t && t !== 'external' && t.localName === 'clipPath' && !this.clipConvertible(t)) out.push('clipping path made of text')
      else if (!/^url\(/i.test(clip)) out.push('CSS clip shape')
    }
    return out
  }

  clipConvertible(cp: XmlElement): boolean {
    for (const c of elementChildren(cp)) {
      if (!isSvg(c)) continue
      if (c.localName === 'text') return false
      if (c.localName === 'use') {
        const t = this.hrefTarget(href(c), 'clip-path')
        if (t && t !== 'external' && t.localName === 'text') return false
      }
    }
    return true
  }

  group(el: XmlElement, ctx: Ctx, style: Computed, children: DrawNode[]): DrawNode[] {
    if (!children.length) return []
    if (ctx.measure) return children
    if (!this.produce()) return []
    this.report.counts.groups++
    const c = this.common(el, style)
    const g: DrawGroupNode = { id: this.newId('grp'), type: 'group', children }
    if (c.name !== undefined) g.name = c.name
    if (c.opacity !== undefined) g.opacity = c.opacity
    if (c.blend !== undefined) g.blend = c.blend
    return [g]
  }

  nestedSvg(el: XmlElement, ctx: Ctx, style: Computed): DrawNode[] {
    const lc = { vw: ctx.vw, vh: ctx.vh, fontSize: style.fontSize }
    const x = parseLength(attr(el, 'x'), 'x', lc) ?? 0
    const y = parseLength(attr(el, 'y'), 'y', lc) ?? 0
    const w = parseLength(attr(el, 'width') ?? '100%', 'x', lc) ?? ctx.vw
    const h = parseLength(attr(el, 'height') ?? '100%', 'y', lc) ?? ctx.vh
    if (w <= 0 || h <= 0) return []
    const vb = parseViewBox(attr(el, 'viewBox'))
    const m = vb ? viewBoxTransform(vb, { x, y, w, h }, attr(el, 'preserveAspectRatio')) : translate(x, y)
    const inner: Ctx = { ...ctx, ctm: mul(ctx.ctm, m), vw: vb ? vb.w : w, vh: vb ? vb.h : h }
    return this.group(el, inner, style, this.children(el, inner, style))
  }

  use(el: XmlElement, ctx: Ctx, style: Computed, local: Matrix): DrawNode[] {
    const target = this.hrefTarget(href(el), 'use')
    if (!target || target === 'external') return []
    if (ctx.useStack.includes(target) || this.isAncestor(target, el)) {
      this.note('usecycle', '1 <use> refers to itself and was skipped.', '{n} <use> elements refer to themselves and were skipped.')
      return []
    }
    if (++this.uses > this.limits.maxUses) {
      this.note('uselimit', `The file reuses content more than ${this.limits.maxUses.toLocaleString('en')} times; the rest was not imported.`, '')
      this.stopped = true
      return []
    }
    const lc = { vw: ctx.vw, vh: ctx.vh, fontSize: style.fontSize }
    const x = parseLength(attr(el, 'x'), 'x', lc) ?? 0
    const y = parseLength(attr(el, 'y'), 'y', lc) ?? 0
    const base = mul(mul(ctx.ctm, local), translate(x, y))
    const next: Ctx = { ...ctx, ctm: base, parent: style, depth: ctx.depth + 1, useStack: [...ctx.useStack, target] }
    let nodes: DrawNode[]
    if (isSvg(target) && (target.localName === 'symbol' || target.localName === 'svg')) {
      const w = parseLength(attr(el, 'width') ?? attr(target, 'width') ?? '100%', 'x', lc) ?? ctx.vw
      const h = parseLength(attr(el, 'height') ?? attr(target, 'height') ?? '100%', 'y', lc) ?? ctx.vh
      const vb = parseViewBox(attr(target, 'viewBox'))
      const m = vb ? viewBoxTransform(vb, { x: 0, y: 0, w, h }, attr(target, 'preserveAspectRatio')) : IDENTITY
      const tStyle = this.computeStyle(target, style)
      const inner: Ctx = { ...next, ctm: mul(base, m), vw: vb ? vb.w : w, vh: vb ? vb.h : h }
      nodes = this.group(target, inner, tStyle, this.children(target, inner, tStyle))
    } else {
      nodes = this.element(target, next)
    }
    if (!nodes.length || ctx.measure) return nodes
    // The <use> is its own group when it carries opacity or a blend mode or a name.
    const c = this.common(el, style)
    if (c.opacity !== undefined || c.blend !== undefined) {
      if (!this.produce()) return []
      this.report.counts.groups++
      nodes = [{ id: this.newId('grp'), type: 'group', children: nodes, ...pick(c, ['name', 'opacity', 'blend']) } as DrawGroupNode]
    }
    const clip = style.props['clip-path']?.trim()
    if (clip && clip !== 'none') return this.clip(el, { ...ctx, ctm: mul(ctx.ctm, local) }, style, clip, nodes)
    return nodes
  }

  private isAncestor(a: XmlElement, el: XmlElement): boolean {
    for (let p: XmlElement | null = el; p; p = parentEl(p)) if (p === a) return true
    return false
  }

  // ── Shapes ────────────────────────────────────────────────────────────────

  /** An element's geometry in its own user space, or null when it has none (or bad numbers). */
  localPath(el: XmlElement, style: Computed, vw: number, vh: number): { path: DrawPath; kind: DrawPathNode['shapeKind']; radius?: number } | null {
    const lc = { vw, vh, fontSize: style.fontSize }
    const len = (n: string, axis: Axis, d = 0): number => parseLength(attr(el, n), axis, lc) ?? d
    switch (el.localName) {
      case 'path': {
        const d = attr(el, 'd')
        if (!d) return null
        const r = parsePathData(d)
        if (r.error) this.note('baddata', '1 path has an error in its data; it was imported up to the error, as a browser draws it.', '{n} paths have errors in their data; they were imported up to the errors, as a browser draws them.')
        return r.path.subpaths.length ? { path: r.path, kind: 'path' } : null
      }
      case 'rect': {
        const x = len('x', 'x')
        const y = len('y', 'y')
        const w = len('width', 'x')
        const h = len('height', 'y')
        if (!(w > 0) || !(h > 0) || !inRange(x, y, w, h)) return null
        let rx = parseLength(attr(el, 'rx'), 'x', lc)
        let ry = parseLength(attr(el, 'ry'), 'y', lc)
        if (rx === null || rx < 0) rx = ry !== null && ry >= 0 ? ry : 0
        if (ry === null || ry < 0) ry = rx
        rx = Math.min(rx, w / 2)
        ry = Math.min(ry, h / 2)
        if (rx <= 0 || ry <= 0) return { path: rectPathOf(x, y, w, h), kind: 'rect' }
        return { path: roundRect(x, y, w, h, rx, ry), kind: Math.abs(rx - ry) < 1e-9 ? 'roundRect' : 'path', radius: rx }
      }
      case 'circle': {
        const r = len('r', 'other')
        const cx = len('cx', 'x')
        const cy = len('cy', 'y')
        if (!(r > 0) || !inRange(cx, cy, r)) return null
        return { path: ellipse(cx, cy, r, r), kind: 'ellipse' }
      }
      case 'ellipse': {
        const cx = len('cx', 'x')
        const cy = len('cy', 'y')
        let rx = parseLength(attr(el, 'rx'), 'x', lc)
        let ry = parseLength(attr(el, 'ry'), 'y', lc)
        if (rx === null) rx = ry
        if (ry === null) ry = rx
        if (rx === null || ry === null || !(rx > 0) || !(ry > 0) || !inRange(cx, cy, rx, ry)) return null
        return { path: ellipse(cx, cy, rx, ry), kind: 'ellipse' }
      }
      case 'line': {
        const x1 = len('x1', 'x')
        const y1 = len('y1', 'y')
        const x2 = len('x2', 'x')
        const y2 = len('y2', 'y')
        if (!inRange(x1, y1, x2, y2)) return null
        return { path: { subpaths: [{ closed: false, nodes: [{ x: x1, y: y1 }, { x: x2, y: y2 }] }] }, kind: 'line' }
      }
      case 'polyline':
      case 'polygon': {
        const pts = numberList(attr(el, 'points'))
        const n = Math.floor(pts.length / 2)
        if (n < 2 || !inRange(...pts)) return null
        const nodes = Array.from({ length: n }, (_, i) => ({ x: pts[i * 2], y: pts[i * 2 + 1] }))
        return { path: { subpaths: [{ closed: el.localName === 'polygon', nodes }] }, kind: 'path' }
      }
      default:
        return null
    }
  }

  shape(el: XmlElement, ctx: Ctx, style: Computed): DrawNode[] {
    const geo = this.localPath(el, style, ctx.vw, ctx.vh)
    if (!geo) return []
    const baked = transformPath(geo.path, ctx.ctm)
    if (!pathInRange(baked)) {
      this.note('range', '1 shape has coordinates far outside any drawing and was not imported.', '{n} shapes have coordinates far outside any drawing and were not imported.')
      return []
    }
    if ((style.props['fill-rule'] ?? '').trim() === 'evenodd') baked.fillRule = 'evenodd'
    if (ctx.measure) return [{ id: 'm', type: 'path', path: baked, fill: { type: 'none' } }]
    if (!this.produce()) return []
    const localBox = pathBounds(geo.path)
    const docBox = pathBounds(baked)
    const fillOpacity = clamp01(parseNumberOrPercent(style.props['fill-opacity']) ?? 1)
    // A line has no inside, so no fill.
    const fill = el.localName === 'line' ? ({ type: 'none' } as DrawDocPaint) : this.paint(style.props.fill, fillOpacity, style, localBox, ctx.ctm, docBox, true)
    const stroke = this.stroke(style, localBox, ctx.ctm, docBox)
    // Live-shape kinds only where the shape is still axis-aligned and unskewed.
    const axisAligned = Math.abs(ctx.ctm[1]) < 1e-9 && Math.abs(ctx.ctm[2]) < 1e-9 && ctx.ctm[0] > 0 && ctx.ctm[3] > 0
    let kind = geo.kind
    if (!axisAligned && kind !== 'line') kind = 'path'
    const node: DrawPathNode = {
      id: this.newId('obj'),
      type: 'path',
      path: baked,
      fill,
      ...(stroke ? { stroke } : {}),
      ...this.common(el, style),
      ...(kind && kind !== 'path' ? { shapeKind: kind } : {}),
      ...(kind === 'roundRect' && geo.radius !== undefined && Math.abs(ctx.ctm[0] - ctx.ctm[3]) < 1e-9 ? { cornerRadius: round(geo.radius * ctx.ctm[0], 4) } : {})
    }
    if (kind === 'roundRect' && node.cornerRadius === undefined) delete node.shapeKind
    this.report.counts.paths++
    const markers = this.markers(el, geo.path, ctx, style)
    if (!markers.length) return [node]
    if (!this.produce()) return [node]
    this.report.counts.groups++
    return [{ id: this.newId('grp'), type: 'group', name: node.name ? `${node.name} with markers` : 'Path with markers', children: [node, ...markers] }]
  }

  // ── Markers ───────────────────────────────────────────────────────────────

  markers(el: XmlElement, path: DrawPath, ctx: Ctx, style: Computed): DrawNode[] {
    if (!MARKABLE.has(el.localName)) return []
    const get = (prop: string): XmlElement | null => {
      const v = style.props[prop]?.trim()
      if (!v || v === 'none') return null
      const t = this.urlTarget(v, 'marker')
      return t && t !== 'external' && t.localName === 'marker' ? t : null
    }
    const prevContext = this.context
    this.context = { fill: style.props.fill, stroke: style.props.stroke, style }
    try {
      return this.markersFor(path, ctx, style, get)
    } finally {
      this.context = prevContext
    }
  }

  private markersFor(path: DrawPath, ctx: Ctx, style: Computed, get: (prop: string) => XmlElement | null): DrawNode[] {
    const out: DrawNode[] = []
    const start = get('marker-start')
    const mid = get('marker-mid')
    const end = get('marker-end')
    if (!start && !mid && !end) return []
    const sw = parseLength(style.props['stroke-width'] ?? '1', 'other', { vw: ctx.vw, vh: ctx.vh, fontSize: style.fontSize }) ?? 1
    for (const sp of path.subpaths) {
      const n = sp.nodes.length
      if (n < 2) continue
      const dirOut = (i: number): number => {
        const a = sp.nodes[i]
        const b = sp.nodes[(i + 1) % n]
        const hx = a.outX ?? b.inX ?? b.x
        const hy = a.outY ?? b.inY ?? b.y
        const dx = hx - a.x || b.x - a.x
        const dy = hy - a.y || b.y - a.y
        return Math.atan2(dy, dx)
      }
      const dirIn = (i: number): number => {
        const b = sp.nodes[i]
        const a = sp.nodes[(i - 1 + n) % n]
        const hx = b.inX ?? a.outX ?? a.x
        const hy = b.inY ?? a.outY ?? a.y
        const dx = b.x - hx || b.x - a.x
        const dy = b.y - hy || b.y - a.y
        return Math.atan2(dy, dx)
      }
      const bisect = (a: number, b: number): number => Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b))
      const place = (m: XmlElement | null, i: number, angle: number, isStart: boolean): void => {
        if (!m) return
        const node = sp.nodes[i]
        out.push(...this.markerAt(m, node.x, node.y, angle, isStart, sw, ctx))
      }
      if (sp.closed) {
        place(start, 0, bisect(dirIn(0), dirOut(0)), true)
        for (let i = 1; i < n; i++) place(mid, i, bisect(dirIn(i), dirOut(i)), false)
        place(mid, 0, bisect(dirIn(0), dirOut(0)), false)
        place(end, 0, bisect(dirIn(0), dirOut(0)), false)
      } else {
        place(start, 0, dirOut(0), true)
        for (let i = 1; i < n - 1; i++) place(mid, i, bisect(dirIn(i), dirOut(i)), false)
        place(end, n - 1, dirIn(n - 1), false)
      }
    }
    return out
  }

  markerAt(m: XmlElement, x: number, y: number, angleRad: number, isStart: boolean, strokeWidth: number, ctx: Ctx): DrawNode[] {
    const style = this.styleOf(m)
    const lc = { vw: ctx.vw, vh: ctx.vh, fontSize: style.fontSize }
    const mw = parseLength(attr(m, 'markerWidth') ?? '3', 'x', lc) ?? 3
    const mh = parseLength(attr(m, 'markerHeight') ?? '3', 'y', lc) ?? 3
    if (mw <= 0 || mh <= 0) return []
    const orient = (attr(m, 'orient') ?? '0').trim()
    let deg: number
    if (orient === 'auto') deg = (angleRad * 180) / Math.PI
    else if (orient === 'auto-start-reverse') deg = (angleRad * 180) / Math.PI + (isStart ? 180 : 0)
    else deg = Number(orient.replace(/deg$/, '')) || 0
    const units = attr(m, 'markerUnits') === 'userSpaceOnUse' ? 1 : strokeWidth
    const vb = parseViewBox(attr(m, 'viewBox'))
    const vbm = vb ? viewBoxTransform(vb, { x: 0, y: 0, w: mw, h: mh }, attr(m, 'preserveAspectRatio')) : IDENTITY
    const refX = parseLength(attr(m, 'refX'), 'x', lc) ?? 0
    const refY = parseLength(attr(m, 'refY'), 'y', lc) ?? 0
    const r = [vbm[0] * refX + vbm[2] * refY + vbm[4], vbm[1] * refX + vbm[3] * refY + vbm[5]]
    const mm = mul(mul(mul(mul(ctx.ctm, translate(x, y)), rotateDeg(deg)), [units, 0, 0, units, 0, 0]), mul(translate(-r[0], -r[1]), vbm))
    const inner: Ctx = { ...ctx, ctm: mm, vw: vb ? vb.w : mw, vh: vb ? vb.h : mh, depth: ctx.depth + 1, useStack: [...ctx.useStack, m] }
    if (ctx.useStack.includes(m)) return []
    const kids = this.children(m, inner, style)
    if (!kids.length) return []
    if (!this.produce()) return []
    this.report.counts.groups++
    return [{ id: this.newId('grp'), type: 'group', name: 'Marker', children: kids }]
  }

  // ── Clipping ──────────────────────────────────────────────────────────────

  clip(el: XmlElement, ctx: Ctx, _style: Computed, value: string, nodes: DrawNode[]): DrawNode[] {
    const t = this.urlTarget(value, 'clip-path')
    if (!t || t === 'external' || t.localName !== 'clipPath') {
      if (!t) this.note('missingclip', '1 clipping path was missing from the file; the art was imported unclipped.', '{n} clipping paths were missing from the file; the art was imported unclipped.')
      return nodes
    }
    // The art's own extent, for clipPathUnits="objectBoundingBox".
    const box = nodesBounds(nodes)
    const local = this.clipShape(t, ctx, box, 0)
    if (!local) return nodes
    if (!this.produce()) return nodes
    this.report.counts.clipGroups++
    const clipNode: DrawPathNode = { id: this.newId('obj'), type: 'path', name: 'Clipping path', path: local, fill: { type: 'none' } }
    return [{ id: this.newId('grp'), type: 'group', clip: true, children: [...nodes, clipNode], ...(nodeName(el) ? { name: nodeName(el) } : {}) } as DrawGroupNode]
  }

  /** A clipPath element's region as ONE path in document space, or null when it is empty. */
  clipShape(cp: XmlElement, ctx: Ctx, objBox: Box, depth: number): DrawPath | null {
    const cpStyle = this.styleOf(cp)
    let m = mul(ctx.ctm, parseTransform(attr(cp, 'transform')) ?? IDENTITY)
    if (attr(cp, 'clipPathUnits') === 'objectBoundingBox') {
      // The art's box is in document space; map the unit square onto it.
      m = mul([objBox.w, 0, 0, objBox.h, objBox.x, objBox.y], parseTransform(attr(cp, 'transform')) ?? IDENTITY)
    }
    const pieces: DrawPath[] = []
    const add = (c: XmlElement, mm: Matrix, parent: Computed, d: number): void => {
      if (!isSvg(c) || d > 8) return
      const st = this.computeStyle(c, parent)
      if ((st.props.display ?? '').trim() === 'none') return
      const vis = st.props.visibility?.trim()
      const cm = mul(mm, parseTransform(st.props.transform ?? attr(c, 'transform')) ?? IDENTITY)
      if (c.localName === 'use') {
        const tg = this.hrefTarget(href(c), 'clip-path')
        if (!tg || tg === 'external') return
        const lc = { vw: ctx.vw, vh: ctx.vh, fontSize: st.fontSize }
        const ux = parseLength(attr(c, 'x'), 'x', lc) ?? 0
        const uy = parseLength(attr(c, 'y'), 'y', lc) ?? 0
        add(tg, mul(cm, translate(ux, uy)), st, d + 1)
        return
      }
      if (vis === 'hidden' || vis === 'collapse') return
      const geo = this.localPath(c, st, ctx.vw, ctx.vh)
      if (!geo) return
      const p = transformPath(geo.path, cm)
      if ((st.props['clip-rule'] ?? '').trim() === 'evenodd') p.fillRule = 'evenodd'
      pieces.push(p)
    }
    for (const c of elementChildren(cp)) add(c, m, cpStyle, 0)
    if (!pieces.length) {
      // An empty clip path hides everything; keep that as a zero-area clip.
      return { subpaths: [{ closed: true, nodes: [{ x: objBox.x, y: objBox.y }, { x: objBox.x, y: objBox.y }, { x: objBox.x, y: objBox.y }] }] }
    }
    let out = pieces[0]
    if (pieces.length > 1) {
      const rules = new Set(pieces.map((p) => p.fillRule ?? 'nonzero'))
      const boxes = pieces.map((p) => pathBounds(p))
      const overlap = boxes.some((a, i) => boxes.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h))
      if (overlap || rules.size > 1) this.note('clipunion', '1 clipping path is made of several overlapping shapes; they were combined into one compound path, which can differ where they overlap.', '{n} clipping paths are made of several overlapping shapes; each was combined into one compound path, which can differ where shapes overlap.')
      out = { subpaths: pieces.flatMap((p) => p.subpaths), ...(rules.size === 1 && rules.has('evenodd') ? { fillRule: 'evenodd' as const } : {}) }
    }
    const nested = cpStyle.props['clip-path']?.trim()
    if (nested && nested !== 'none' && depth === 0) this.note('nestedclip', '1 clipping path is itself clipped; the inner clip was not applied.', '{n} clipping paths are themselves clipped; the inner clips were not applied.')
    return out
  }

  // ── Images ────────────────────────────────────────────────────────────────

  image(el: XmlElement, ctx: Ctx, style: Computed): DrawNode[] {
    const src = href(el)?.trim() ?? ''
    if (!src) return []
    if (!/^data:/i.test(src)) {
      this.note('linkedimage', '1 linked image was not imported: PlexiiDraw never loads files or web addresses a drawing points to. Place the image file itself instead.', '{n} linked images were not imported: PlexiiDraw never loads files or web addresses a drawing points to. Place the image files themselves instead.')
      return []
    }
    if (!isDrawImageSrc(src)) {
      this.note('badimage', '1 embedded image is in a format PlexiiDraw cannot show and was not imported.', '{n} embedded images are in formats PlexiiDraw cannot show and were not imported.')
      return []
    }
    const lc = { vw: ctx.vw, vh: ctx.vh, fontSize: style.fontSize }
    const natural = dataUrlSize(src)
    let w = parseLength(attr(el, 'width'), 'x', lc)
    let h = parseLength(attr(el, 'height'), 'y', lc)
    // SVG 2: a missing width or height comes from the picture itself.
    if (w === null && h === null && natural) {
      w = natural.w
      h = natural.h
    } else if (w === null) w = natural && h !== null ? (h * natural.w) / natural.h : 0
    else if (h === null) h = natural ? (w * natural.h) / natural.w : 0
    const w0 = w ?? 0
    const h0 = h ?? 0
    const x = parseLength(attr(el, 'x'), 'x', lc) ?? 0
    const y = parseLength(attr(el, 'y'), 'y', lc) ?? 0
    if (!(w0 > 0) || !(h0 > 0) || !inRange(x, y, w0, h0)) return []
    // preserveAspectRatio: where the picture actually sits in its box.
    let rect: Box = { x, y, w: w0, h: h0 }
    const par = attr(el, 'preserveAspectRatio')
    let sliced = false
    if (natural && (par ?? '').trim() !== 'none') {
      const m = viewBoxTransform({ x: 0, y: 0, w: natural.w, h: natural.h }, rect, par)
      rect = { x: m[4], y: m[5], w: natural.w * m[0], h: natural.h * m[3] }
      sliced = /slice/.test(par ?? '') && (rect.w > w0 + 1e-6 || rect.h > h0 + 1e-6)
    }
    if (ctx.measure) return [frameImage(this.newId('m'), rect, ctx.ctm, '')]
    if (!this.produce()) return []
    const put = putAsset(this.assets, src, natural ?? undefined)
    this.assets = put.assets
    const node = frameImage(this.newId('img'), rect, ctx.ctm, put.id)
    Object.assign(node, pick(this.common(el, style), ['name', 'opacity', 'blend', 'hidden']))
    this.report.counts.images++
    if (!sliced) return [node]
    // "slice" crops the picture to its box: a clipping group.
    if (!this.produce()) return [node]
    this.report.counts.clipGroups++
    const clipPath = transformPath(rectPathOf(x, y, w0, h0), ctx.ctm)
    return [{ id: this.newId('grp'), type: 'group', clip: true, name: 'Cropped image', children: [node, { id: this.newId('obj'), type: 'path', name: 'Clipping path', path: clipPath, fill: { type: 'none' } }] }]
  }

  // ── Text ──────────────────────────────────────────────────────────────────

  text(el: XmlElement, ctx: Ctx, style: Computed): DrawNode[] {
    const lc = (s: Computed): { vw: number; vh: number; fontSize: number } => ({ vw: ctx.vw, vh: ctx.vh, fontSize: s.fontSize })
    interface Chunk {
      x: number | null
      y: number | null
      text: string
      style: Computed
    }
    const chunks: Chunk[] = []
    let approxPos = false
    let mixed = false
    const pre = (s: Computed): boolean => /^pre/.test((s.props['white-space'] ?? '').trim())
    const walk = (node: XmlElement, s: Computed, depth: number): void => {
      if (depth > 16) return
      const own = (n: string): number | null => {
        const list = numberList(attr(node, n))
        if (list.length > 1) approxPos = true
        if (!list.length) return null
        const v = parseLength(String(list[0]), n === 'x' ? 'x' : 'y', lc(s))
        return v
      }
      const x = own('x')
      const y = own('y')
      if (attr(node, 'dx') || attr(node, 'dy') || attr(node, 'rotate') || attr(node, 'textLength')) approxPos = true
      let first = true
      const kids = node.childNodes
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i]
        if (k.nodeType === 3 || k.nodeType === 4) {
          const t = k.nodeValue ?? ''
          chunks.push({ x: first ? x : null, y: first ? y : null, text: pre(s) ? t.replace(/[\n\r\t]/g, ' ') : t.replace(/[\n\r]/g, '').replace(/\t/g, ' '), style: s })
          first = false
        } else if (k.nodeType === 1) {
          const ce = k as XmlElement
          if (!isSvg(ce)) continue
          if (ce.localName === 'tspan' || ce.localName === 'textPath' || ce.localName === 'a') {
            if (ce.localName === 'textPath') this.note('textpath', '1 text on a path was imported as plain text.', '{n} texts on paths were imported as plain text.')
            const cs = this.computeStyle(ce, s)
            if ((cs.props.display ?? '').trim() === 'none') continue
            if (first && (x !== null || y !== null)) {
              chunks.push({ x, y, text: '', style: s })
            }
            first = false
            walk(ce, cs, depth + 1)
          }
        }
      }
      if (first && (x !== null || y !== null)) chunks.push({ x, y, text: '', style: s })
    }
    walk(el, style, 0)
    // Lines: a chunk with its own y (or x after text) starts one.
    interface Line {
      x: number
      y: number
      text: string
      style: Computed
    }
    const lines: Line[] = []
    let cx = 0
    let cy = 0
    for (const c of chunks) {
      const nx = c.x ?? cx
      const ny = c.y ?? cy
      const cur = lines[lines.length - 1]
      // A new baseline starts a new line; a new x on the same baseline (kerning,
      // word placement) continues it.
      const newLine = !cur || (c.y !== null && Math.abs(ny - cur.y) > 1e-6)
      if (newLine) lines.push({ x: nx, y: ny, text: c.text, style: c.style })
      else {
        if (c.text.trim() && cur.text.trim() && !sameTextStyle(cur.style, c.style)) mixed = true
        if (!cur.text.trim() && c.text.trim()) cur.style = c.style
        cur.text += c.text
      }
      cx = nx
      cy = ny
    }
    // Whitespace: collapse unless preserved.
    for (const l of lines) l.text = pre(l.style) ? l.text : l.text.replace(/ +/g, ' ').trim()
    // Blank lines inside a text block are part of it (a paragraph break).
    if (!lines.some((l) => l.text.length > 0)) return []
    const real = lines
    if (approxPos) this.note('textpos', '1 text object uses per-character positioning; its characters were laid out evenly instead.', '{n} text objects use per-character positioning; their characters were laid out evenly instead.')
    if (mixed) this.note('textmixed', '1 text object mixes character styles; it was imported with one style.', '{n} text objects mix character styles; each was imported with one style.')
    if ((style.props['text-decoration'] ?? 'none').trim() !== 'none') this.note('textdeco', '1 text object is underlined or struck through, which PlexiiDraw does not draw yet.', '{n} text objects are underlined or struck through, which PlexiiDraw does not draw yet.')
    // Lines sharing a start, a style and an even spacing become one text object.
    const groups: Line[][] = []
    for (const l of real) {
      const g = groups[groups.length - 1]
      const ok =
        g &&
        Math.abs(g[0].x - l.x) < 1e-6 &&
        sameTextStyle(g[0].style, l.style) &&
        l.y > g[g.length - 1].y &&
        (g.length < 2 || Math.abs(l.y - g[g.length - 1].y - (g[1].y - g[0].y)) < 0.01)
      if (ok) g.push(l)
      else groups.push([l])
    }
    const out: DrawNode[] = []
    for (const g of groups) {
      if (!g.some((l) => l.text.length > 0)) continue
      const n = this.textNode(el, g.map((l) => l.text), g[0].x, g[0].y, g.length > 1 ? g[1].y - g[0].y : null, g[0].style, ctx)
      if (n) out.push(n)
    }
    if (out.length > 1 && !ctx.measure) {
      if (!this.produce()) return out
      this.report.counts.groups++
      return [{ id: this.newId('grp'), type: 'group', name: nodeName(el) ?? 'Text', children: out }]
    }
    return out
  }

  textNode(el: XmlElement, lines: string[], ax: number, baseline: number, step: number | null, s: Computed, ctx: Ctx): DrawNode | null {
    const fs = s.fontSize
    if (!inRange(ax, baseline, fs)) return null
    const anchor = (s.props['text-anchor'] ?? 'start').trim()
    const align: DrawTextNode['align'] = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : undefined
    const ls = parseLength((s.props['letter-spacing'] ?? '').trim() === 'normal' ? '0' : (s.props['letter-spacing'] ?? '0'), 'other', { vw: ctx.vw, vh: ctx.vh, fontSize: fs }) ?? 0
    const longest = Math.max(...lines.map((l) => l.length))
    // No font metrics here: a width comfortably wider than the text, so it
    // never wraps where the original did not.
    const w = Math.max(8, Math.ceil(longest * (fs * 0.62 + Math.max(0, ls)) + fs))
    const x = align === 'center' ? ax - w / 2 : align === 'right' ? ax - w : ax
    const y = baseline - fs
    const font = fontOf(s)
    if (font.unreadable && !ctx.measure) this.note('badfont', '1 font name could not be read; the default font was used.', '{n} font names could not be read; the default font was used.')
    const localBox = { x, y, w, h: fs * (1 + (lines.length - 1) * (step ? step / fs : 1.2)) }
    const base: DrawTextNode = {
      id: ctx.measure ? 'm' : this.newId('txt'),
      type: 'text',
      x,
      y,
      w,
      text: lines.join('\n'),
      lines,
      fontSize: fs,
      ...(font.family ? { fontFamily: font.family } : {}),
      ...(font.weight && font.weight !== 400 ? { fontWeight: font.weight } : {}),
      ...(font.italic ? { italic: true } : {}),
      ...(align ? { align } : {}),
      ...(step && Math.abs(step / fs - 1.2) > 1e-9 ? { lineHeight: round(step / fs, 6) } : {}),
      ...(ls ? { letterSpacing: round(ls, 4) } : {}),
      fill: { type: 'none' }
    }
    if (ctx.measure) return placeFrame(base, ctx.ctm, true)
    if (!this.produce()) return null
    const placed = placeFrame(base, ctx.ctm, true) as DrawTextNode
    const docBox = nodesBounds([placed])
    const fillOpacity = clamp01(parseNumberOrPercent(s.props['fill-opacity']) ?? 1)
    placed.fill = this.paint(s.props.fill, fillOpacity, s, localBox, ctx.ctm, docBox, true)
    const stroke = this.stroke(s, localBox, ctx.ctm, docBox)
    if (stroke) placed.stroke = stroke
    Object.assign(placed, pick(this.common(el, s), ['name', 'opacity', 'blend', 'hidden']))
    this.report.counts.texts++
    return placed
  }

  // ── Fallback: an element kept as an image of itself ───────────────────────

  fallback(el: XmlElement, ctx: Ctx, style: Computed, reasons: string[]): DrawNode[] {
    // Its extent: the geometry, ignoring what made it unsupported, in its
    // parent's space (`ctx` is the parent's; the element's own transform is
    // inside both the measurement and the serialised markup).
    this.measureDepth++
    let nodes: DrawNode[]
    try {
      nodes = this.element(el, { ...ctx, ctm: IDENTITY, measure: true })
    } finally {
      this.measureDepth--
    }
    let local: Box | null = nodes.length ? nodesBounds(nodes) : null
    if (el.localName === 'foreignObject') {
      const lc = { vw: ctx.vw, vh: ctx.vh, fontSize: style.fontSize }
      local = { x: parseLength(attr(el, 'x'), 'x', lc) ?? 0, y: parseLength(attr(el, 'y'), 'y', lc) ?? 0, w: parseLength(attr(el, 'width'), 'x', lc) ?? 0, h: parseLength(attr(el, 'height'), 'y', lc) ?? 0 }
    }
    if (!local || !(local.w > 0 || local.h > 0)) return []
    // Room for the stroke, and for a filter's region (default: 10% beyond the box).
    const sw = (parseLength(style.props['stroke-width'] ?? '1', 'other', { vw: ctx.vw, vh: ctx.vh, fontSize: style.fontSize }) ?? 1) * ((style.props.stroke ?? 'none').trim() === 'none' ? 0 : 1)
    let region: Box = { x: local.x - sw, y: local.y - sw, w: local.w + 2 * sw, h: local.h + 2 * sw }
    const ft = this.urlTarget(style.props.filter, 'filter')
    if (ft && ft !== 'external' && ft.localName === 'filter') region = filterRegion(ft, local, ctx) ?? region
    // The element is drawn with its full transform inside the image, so the
    // image itself is an upright box in document space.
    const box = transformBoxOut(region, ctx.ctm)
    if (!(box.w > 0) || !(box.h > 0) || !inRange(box.x, box.y, box.w, box.h)) return []
    if (!this.produce()) return []
    const id = this.newId('img')
    const markup = this.standalone(el, ctx, box)
    this.fallbacks.push({ nodeId: id, markup, box, reasons })
    for (const r of reasons) this.report.raster(r)
    const name = nodeName(el)
    // The asset is filled in when the caller rasterises the markup.
    const node: DrawImageNode = { id, type: 'image', x: box.x, y: box.y, w: box.w, h: box.h, assetId: '', name: name ?? `Rasterised ${reasons[0]}` }
    return [node]
  }

  /** A standalone SVG of one element and everything it refers to, sanitised, framed on `box`. */
  standalone(el: XmlElement, ctx: Ctx, box: Box): string {
    const defs = new Map<XmlElement, string>()
    const pending: XmlElement[] = []
    const want = (id: string): void => {
      const t = this.ids.get(id)
      if (t && !defs.has(t) && !this.isAncestor(el, t) && !pending.includes(t)) pending.push(t)
    }
    const body = this.serialize(el, want, 0)
    for (let i = 0; i < pending.length && i < 512; i++) {
      const t = pending[i]
      defs.set(t, this.serialize(t, want, 0))
    }
    const inherited = INHERITED.map((p) => {
      const v = ctx.parent.props[p]
      return v !== undefined && safeCssValue(v) ? `${p}:${v}` : ''
    })
      .concat(ctx.parent.fontSize !== 16 ? [`font-size:${num(ctx.parent.fontSize)}px`] : [])
      .filter(Boolean)
      .join(';')
    // `ctx` is the parent's: the element's own transform is serialised with it.
    const outer = ctx.ctm
    return (
      `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="${num(box.w)}" height="${num(box.h)}" viewBox="${num(box.x)} ${num(box.y)} ${num(box.w)} ${num(box.h)}">` +
      (defs.size ? `<defs>${[...defs.values()].join('')}</defs>` : '') +
      `<g transform="matrix(${outer.map(num).join(' ')})"${inherited ? ` style="${escAttr(inherited)}"` : ''}>${body}</g></svg>`
    )
  }

  serialize(el: XmlElement, want: (id: string) => void, depth: number): string {
    if (depth > 64) return ''
    const tag = el.localName
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tag)) return ''
    if (DANGEROUS_TAGS.has(tag.toLowerCase())) return ''
    const svg = isSvg(el)
    const attrs: string[] = []
    for (const a of attrList(el)) {
      const name = a.localName
      const lower = name.toLowerCase()
      if (lower.startsWith('on') || lower === 'style' || lower === 'class') continue
      if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(name)) continue
      if (a.namespaceURI && a.namespaceURI !== XLINK_NS && a.name !== 'xml:space') continue
      let v = a.value
      if (/javascript:|vbscript:|data:text|expression\(/i.test(v)) continue
      if (lower === 'href' || lower === 'src') {
        if (v.trim().startsWith('#')) want(decodeURIComponentSafe(v.trim().slice(1)))
        else if (!isDrawImageSrc(v.trim())) continue
        attrs.push(`href="${escAttr(v.trim())}"`)
        continue
      }
      if (/url\(/i.test(v)) {
        if (!safeCssValue(v)) continue
        for (const m of v.matchAll(/url\(\s*['"]?#([^'")]+)['"]?\s*\)/gi)) want(decodeURIComponentSafe(m[1]))
      }
      if (name === 'space' && a.name === 'xml:space') {
        attrs.push(`xml:space="${escAttr(v)}"`)
        continue
      }
      v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      attrs.push(`${name}="${escAttr(v)}"`)
    }
    if (svg) {
      const css = [...cascadedStyle(el, this.sheets)]
        .filter(([p, v]) => /^-?[a-z][a-z0-9-]*$/.test(p) && safeCssValue(v))
        .map(([p, v]) => {
          for (const m of v.matchAll(/url\(\s*['"]?#([^'")]+)['"]?\s*\)/gi)) want(decodeURIComponentSafe(m[1]))
          return `${p}:${v}`
        })
      if (css.length) attrs.push(`style="${escAttr(css.join(';'))}"`)
    }
    let inner = ''
    const kids = el.childNodes
    for (let i = 0; i < kids.length && i < 100000; i++) {
      const k = kids[i]
      if (k.nodeType === 3 || k.nodeType === 4) inner += escText(k.nodeValue ?? '')
      else if (k.nodeType === 1) inner += this.serialize(k as XmlElement, want, depth + 1)
    }
    const xmlns = !svg && el.namespaceURI === 'http://www.w3.org/1999/xhtml' && parentEl(el) !== null && isSvg(parentEl(el)!) ? ' xmlns="http://www.w3.org/1999/xhtml"' : ''
    return `<${tag}${xmlns}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${inner}</${tag}>`
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const NEVER_RENDERED = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'pattern',
  'linearGradient',
  'radialGradient',
  'filter',
  'marker',
  'style',
  'title',
  'desc',
  'metadata',
  'font',
  'font-face',
  'glyph',
  'missing-glyph',
  'cursor',
  'view',
  'color-profile',
  'stop'
])
const ANIMATION = new Set(['animate', 'animateTransform', 'animateMotion', 'animateColor', 'set', 'mpath'])
const RENDERED = new Set(['g', 'a', 'switch', 'svg', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'foreignObject'])
const MARKABLE = new Set(['path', 'line', 'polyline', 'polygon'])
const DANGEROUS_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'applet', 'audio', 'video', 'source', 'track', 'portal'])

/**
 * An attribute, or null when absent. Some XML DOMs (xmldom) answer "" for a
 * missing attribute; a browser answers null. Every read goes through here so
 * "absent" means the same everywhere.
 */
function attr(el: { getAttribute(n: string): string | null; hasAttribute?(n: string): boolean }, name: string): string | null {
  const v = el.getAttribute(name)
  if (v === '' && el.hasAttribute && !el.hasAttribute(name)) return null
  return v
}

function isSvg(el: XmlElement): boolean {
  return el.namespaceURI === SVG_NS || !el.namespaceURI
}

function elementChildren(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const kids = el.childNodes
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i] as XmlElement)
  return out
}

function attrList(el: XmlElement): XmlAttr[] {
  const out: XmlAttr[] = []
  const a = el.attributes
  for (let i = 0; i < a.length; i++) out.push(a[i])
  return out
}

function href(el: XmlElement): string | null {
  for (const a of attrList(el)) if (a.localName === 'href' && (!a.namespaceURI || a.namespaceURI === XLINK_NS)) return a.value
  return attr(el, 'xlink:href') ?? attr(el, 'href')
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function switchAccepts(el: XmlElement): boolean {
  if (attr(el, 'requiredExtensions') !== null) return false
  const lang = attr(el, 'systemLanguage')
  if (lang !== null && !lang.split(',').some((l) => /^\s*en\b/i.test(l))) return false
  return true
}

/** Illustrator writes names into ids with `_x20_`-style escapes; Inkscape and Illustrator also keep labels. */
function nodeName(el: XmlElement): string | undefined {
  const label = attr(el, 'inkscape:label') ?? attr(el, 'data-name')
  if (label && label.trim()) return label.trim().slice(0, 120)
  const id = attr(el, 'id')
  if (!id) return undefined
  const decoded = id.replace(/_x([0-9A-Fa-f]{2,4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/_(\d+)_$/, '')
  return decoded.slice(0, 120)
}

function pick<T extends object>(o: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if ((o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k]
  return out as Partial<T>
}

function round(v: number, places = 6): number {
  const k = 10 ** places
  const r = Math.round(v * k) / k
  return Object.is(r, -0) ? 0 : r
}

function num(v: number): string {
  return String(round(v, 4))
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A CSS value safe to write back out: only fragment url()s, no escapes or expressions. */
function safeCssValue(v: string): boolean {
  if (/[\\<>{};]|expression|javascript:|@import/i.test(v)) return false
  const urls = v.match(/url\([^)]*\)/gi) ?? []
  return urls.every((u) => /^url\(\s*['"]?#[^'")]+['"]?\s*\)$/i.test(u))
}

function parseViewBox(v: string | null): Box | null {
  const n = numberList(v)
  if (n.length !== 4 || !(n[2] > 0) || !(n[3] > 0) || !inRange(...n)) return null
  return { x: n[0], y: n[1], w: n[2], h: n[3] }
}

function rectPathOf(x: number, y: number, w: number, h: number): DrawPath {
  return { subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] }
}

const KAPPA = 0.5522847498307936

function ellipse(cx: number, cy: number, rx: number, ry: number): DrawPath {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return {
    subpaths: [
      {
        closed: true,
        nodes: [
          { x: cx, y: cy - ry, inX: cx - kx, inY: cy - ry, outX: cx + kx, outY: cy - ry },
          { x: cx + rx, y: cy, inX: cx + rx, inY: cy - ky, outX: cx + rx, outY: cy + ky },
          { x: cx, y: cy + ry, inX: cx + kx, inY: cy + ry, outX: cx - kx, outY: cy + ry },
          { x: cx - rx, y: cy, inX: cx - rx, inY: cy + ky, outX: cx - rx, outY: cy - ky }
        ]
      }
    ]
  }
}

function roundRect(x: number, y: number, w: number, h: number, rx: number, ry: number): DrawPath {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  const x2 = x + w
  const y2 = y + h
  return {
    subpaths: [
      {
        closed: true,
        nodes: [
          { x: x + rx, y, inX: x + rx - kx, inY: y },
          { x: x2 - rx, y, outX: x2 - rx + kx, outY: y },
          { x: x2, y: y + ry, inX: x2, inY: y + ry - ky },
          { x: x2, y: y2 - ry, outX: x2, outY: y2 - ry + ky },
          { x: x2 - rx, y: y2, inX: x2 - rx + kx, inY: y2 },
          { x: x + rx, y: y2, outX: x + rx - kx, outY: y2 },
          { x, y: y2 - ry, inX: x, inY: y2 - ry + ky },
          { x, y: y + ry, outX: x, outY: y + ry - ky }
        ]
      }
    ]
  }
}

function pathInRange(p: DrawPath): boolean {
  for (const sp of p.subpaths)
    for (const n of sp.nodes) {
      if (!(Math.abs(n.x) <= MAX_COORD && Math.abs(n.y) <= MAX_COORD)) return false
      if (n.inX !== undefined && !(Math.abs(n.inX) <= MAX_COORD && Math.abs(n.inY ?? 0) <= MAX_COORD)) return false
      if (n.outX !== undefined && !(Math.abs(n.outX) <= MAX_COORD && Math.abs(n.outY ?? 0) <= MAX_COORD)) return false
    }
  return true
}

function transformBoxOut(b: Box, m: Matrix): Box {
  const pts = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h]
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.floor(Math.min(...xs))
  const y = Math.floor(Math.min(...ys))
  return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y }
}

function filterRegion(f: XmlElement, bbox: Box, ctx: Ctx): Box | null {
  const userSpace = attr(f, 'filterUnits') === 'userSpaceOnUse'
  const lc = { vw: ctx.vw, vh: ctx.vh, fontSize: 16 }
  const v = (n: string, axis: Axis, dflt: number): number => {
    const raw = attr(f, n)
    if (raw === null) return userSpace ? (axis === 'x' ? bbox.x + dflt * bbox.w : bbox.y + dflt * bbox.h) : dflt
    return userSpace ? (parseLength(raw, axis, lc) ?? 0) : (parseNumberOrPercent(raw) ?? dflt)
  }
  if (userSpace) {
    const x = v('x', 'x', -0.1)
    const y = v('y', 'y', -0.1)
    const w = attr(f, 'width') !== null ? (parseLength(attr(f, 'width'), 'x', lc) ?? bbox.w * 1.2) : bbox.w * 1.2
    const h = attr(f, 'height') !== null ? (parseLength(attr(f, 'height'), 'y', lc) ?? bbox.h * 1.2) : bbox.h * 1.2
    return w > 0 && h > 0 ? { x, y, w, h } : null
  }
  const fx = v('x', 'x', -0.1)
  const fy = v('y', 'y', -0.1)
  const fw = v('width', 'x', 1.2)
  const fh = v('height', 'y', 1.2)
  if (!(fw > 0) || !(fh > 0)) return null
  return { x: bbox.x + fx * bbox.w, y: bbox.y + fy * bbox.h, w: fw * bbox.w, h: fh * bbox.h }
}

function expandFontShorthand(v: string, set: (p: string, v: string) => void): void {
  // [style] [variant] [weight] size[/line-height] family
  const m = /^\s*((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|[1-9]00)\s+)*)([\d.]+(?:px|pt|em|rem|%|mm|cm|in|pc)?)(?:\/[^\s]+)?\s+(.+)$/i.exec(v)
  if (!m) return
  for (const tok of m[1].trim().split(/\s+/).filter(Boolean)) {
    if (/^(italic|oblique)$/i.test(tok)) set('font-style', tok)
    else if (/^(bold|bolder|lighter|[1-9]00)$/i.test(tok)) set('font-weight', tok)
  }
  set('font-size', m[2])
  set('font-family', m[3])
}

function sameTextStyle(a: Computed, b: Computed): boolean {
  const keys = ['fill', 'stroke', 'font-family', 'font-weight', 'font-style', 'letter-spacing', 'fill-opacity', 'text-anchor']
  return a.fontSize === b.fontSize && keys.every((k) => (a.props[k] ?? '') === (b.props[k] ?? ''))
}

const WEIGHTS: Array<[RegExp, number]> = [
  [/(hairline|thin)/i, 100],
  [/(extra|ultra)-?light/i, 200],
  [/light/i, 300],
  [/(semi|demi)-?bold/i, 600],
  [/(extra|ultra)-?bold/i, 800],
  [/(black|heavy)/i, 900],
  [/bold/i, 700],
  [/medium/i, 500],
  [/(regular|roman|book|normal)/i, 400]
]

/**
 * The font as the model stores it. Illustrator writes PostScript names
 * ("MyriadPro-BoldIt"); those become a family ("Myriad Pro") plus a weight
 * and italic, with the rest of the CSS fallback list kept.
 */
function fontOf(s: Computed): { family?: string; weight?: number; italic: boolean; unreadable?: boolean } {
  let weight: number | undefined
  const w = (s.props['font-weight'] ?? '').trim().toLowerCase()
  if (w === 'bold' || w === 'bolder') weight = 700
  else if (w === 'lighter') weight = 300
  else if (/^\d+$/.test(w)) weight = Math.max(1, Math.min(1000, Number(w)))
  let italic = /^(italic|oblique)/.test((s.props['font-style'] ?? '').trim())
  const raw = s.props['font-family']?.trim()
  if (!raw) return { weight, italic }
  const all = raw.split(',').map((f) => f.trim().replace(/^(['"])(.*)\1$/, '$2').trim())
  const families = all.filter((f) => f && /^[-\w .&+]{1,80}$/.test(f))
  if (!families.length) return { weight, italic, unreadable: true }
  const ps = /^([A-Za-z0-9]+)-((?:Hairline|Thin|ExtraLight|UltraLight|Light|Regular|Roman|Book|Normal|Medium|SemiBold|Semibold|DemiBold|Demi|Bold|ExtraBold|UltraBold|Black|Heavy)?(?:It|Italic|Oblique)?)$/.exec(families[0])
  if (ps && ps[2]) {
    const style = ps[2]
    for (const [re, wt] of WEIGHTS) {
      if (re.test(style)) {
        if (weight === undefined) weight = wt
        break
      }
    }
    if (/(it|italic|oblique)$/i.test(style)) italic = true
    families[0] = ps[1].replace(/([a-z])([A-Z])/g, '$1 $2')
    return { family: families.map((f) => (/[\s]/.test(f) ? `'${f}'` : f)).join(', '), weight, italic }
  }
  // A list that is all readable is kept exactly as written (quotes and all).
  const family = families.length === all.length ? raw : families.map((f) => (/[\s]/.test(f) ? `'${f}'` : f)).join(', ')
  return { family, weight, italic }
}

/** The pixel size of an embedded image's bytes, when its header can be read. */
function dataUrlSize(src: string): { w: number; h: number } | null {
  const m = /^data:([^;,]+)(;[^,]*)?,(.*)$/s.exec(src)
  if (!m) return null
  if (/svg/i.test(m[1])) {
    const text = /;base64/i.test(m[2] ?? '') ? new TextDecoder().decode(base64ToBytes(m[3].slice(0, 8192)) ?? new Uint8Array()) : decodeURIComponentSafe(m[3].slice(0, 8192))
    const svg = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
    const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)
    const n = numberList(vb?.[1] ?? '')
    if (n.length === 4 && n[2] > 0 && n[3] > 0) return { w: n[2], h: n[3] }
    return null
  }
  if (!/;base64/i.test(m[2] ?? '')) return null
  const bytes = base64ToBytes(m[3].slice(0, 1 << 16).replace(/=+$/, '').slice(0, Math.floor(Math.min(m[3].length, 1 << 16) / 4) * 4))
  if (!bytes) return null
  const kind = sniffImportKind(bytes)
  if (!kind) return null
  const info = rasterInfo(bytes, kind)
  return info ? { w: info.w, h: info.h } : null
}

/** An image frame for `rect` under `m`: plain fields when they can hold it, else a matrix. */
function frameImage(id: string, rect: Box, m: Matrix, assetId: string): DrawImageNode {
  const base: DrawImageNode = { id, type: 'image', x: rect.x, y: rect.y, w: rect.w, h: rect.h, assetId }
  return placeFrame(base, m, false) as DrawImageNode
}

/**
 * A frame node (built in its element's own coordinates) moved into document
 * space by `m`. When `m` is a rotation, a scale (uniform for text) and a move,
 * the node's own fields carry it exactly -- position, size, font size and a
 * rotation about its pivot. Otherwise it keeps its local frame plus the matrix.
 */
export function placeFrame(n: DrawTextNode | DrawImageNode, m: Matrix, isText: boolean): DrawTextNode | DrawImageNode {
  if (isIdentity(m)) return n
  if (!frameRepresentable(m, isText)) return { ...n, transform: m.map((v) => round(v, 9)) as Matrix }
  const q = decompose(m)
  if (isText) {
    const t = n as DrawTextNode
    const s = q.sx
    const pivotLocal = { x: t.x + t.w / 2, y: t.y }
    const p = { x: m[0] * pivotLocal.x + m[2] * pivotLocal.y + m[4], y: m[1] * pivotLocal.x + m[3] * pivotLocal.y + m[5] }
    const w = t.w * s
    const out: DrawTextNode = {
      ...t,
      x: round(p.x - w / 2, 6),
      y: round(p.y, 6),
      w: round(w, 6),
      fontSize: round(t.fontSize * s, 6),
      ...(t.letterSpacing ? { letterSpacing: round(t.letterSpacing * s, 6) } : {})
    }
    const rot = round(q.theta, 9)
    if (rot) out.rotation = rot
    return out
  }
  const im = n as DrawImageNode
  const c = { x: im.x + im.w / 2, y: im.y + im.h / 2 }
  const p = { x: m[0] * c.x + m[2] * c.y + m[4], y: m[1] * c.x + m[3] * c.y + m[5] }
  const w = im.w * q.sx
  const h = im.h * q.sy
  const out: DrawImageNode = { ...im, x: round(p.x - w / 2, 6), y: round(p.y - h / 2, 6), w: round(w, 6), h: round(h, 6) }
  const rot = round(q.theta, 9)
  if (rot) out.rotation = rot
  return out
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** True when the parser reported the text as malformed XML. */
function parserError(doc: XmlDocument): string | null {
  const root = doc.documentElement
  if (!root) return 'the file is empty'
  const find = (el: XmlElement, depth: number): XmlElement | null => {
    if (el.localName === 'parsererror') return el
    if (depth > 2) return null
    for (const c of elementChildren(el)) {
      const hit = find(c, depth + 1)
      if (hit) return hit
    }
    return null
  }
  const pe = find(root, 0)
  if (!pe) return null
  return (pe.textContent ?? 'the XML is malformed').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * Import a parsed SVG document. Throws SvgImportError when it is not an SVG
 * at all; everything short of that imports what it can and reports the rest.
 */
export function importSvgDocument(doc: XmlDocument, opts: SvgImportOptions): SvgImportOutput {
  const err = parserError(doc)
  if (err) throw new SvgImportError(`This is not a readable SVG file: ${err}`)
  const root = doc.documentElement!
  if (root.localName !== 'svg' || !isSvg(root)) throw new SvgImportError('This file is XML but not SVG.')
  const im = new Importer(opts)
  im.index(root)
  const rootStyle = im.computeStyle(root, ROOT_STYLE)
  const lc = { vw: 300, vh: 150, fontSize: rootStyle.fontSize }
  const vb = parseViewBox(attr(root, 'viewBox'))
  const wAttr = attr(root, 'width')
  const hAttr = attr(root, 'height')
  const pctOrMissing = (v: string | null): boolean => v === null || /%\s*$/.test(v) || v.trim() === 'auto'
  let width = pctOrMissing(wAttr) ? null : parseLength(wAttr, 'x', lc)
  let height = pctOrMissing(hAttr) ? null : parseLength(hAttr, 'y', lc)
  if (width === null && height === null) {
    width = vb ? vb.w : 300
    height = vb ? vb.h : 150
  } else if (width === null) width = vb ? ((height ?? 0) * vb.w) / vb.h : 300
  else if (height === null) height = vb ? (width * vb.h) / vb.w : 150
  if (!(width! > 0) || !(height! > 0)) {
    width = vb?.w ?? 300
    height = vb?.h ?? 150
  }
  const W = width!
  const H = height!
  im.rootW = vb ? vb.w : W
  im.rootH = vb ? vb.h : H
  const ctm = vb ? viewBoxTransform(vb, { x: 0, y: 0, w: W, h: H }, attr(root, 'preserveAspectRatio')) : IDENTITY
  const ctx: Ctx = { ctm, parent: rootStyle, vw: im.rootW, vh: im.rootH, depth: 1, useStack: [] }

  const layers: SvgImportLayer[] = []
  let background: DrawDocPaint | undefined
  const kids = elementChildren(root).filter((k) => isSvg(k))
  const renderable = kids.filter((k) => RENDERED.has(k.localName) || ANIMATION.has(k.localName) || k.localName === 'script')
  if (opts.mode === 'open') {
    // A full-page rectangle first thing is the page colour (it is how
    // PlexiiDraw, and many tools, write a background).
    const first = renderable[0]
    if (first && first.localName === 'rect' && !attr(first, 'transform') && isFullPage(first, im, ctx, W, H)) {
      const st = im.computeStyle(first, rootStyle)
      const op = clamp01(parseNumberOrPercent(st.props['fill-opacity']) ?? 1) * clamp01(parseNumberOrPercent(st.props.opacity) ?? 1)
      const geo = im.localPath(first, st, ctx.vw, ctx.vh)
      const plain = !im.unsupported(first, st).length && (st.props['clip-path'] ?? 'none').trim() === 'none' && (st.props.stroke ?? 'none').trim() === 'none'
      const p = geo && plain ? im.paint(st.props.fill, op, st, pathBounds(geo.path), ctx.ctm, { x: 0, y: 0, w: W, h: H }, true) : null
      if (p && (st.props.visibility ?? 'visible').trim() === 'visible' && (st.props['mix-blend-mode'] ?? 'normal').trim() === 'normal') {
        background = p
        renderable.shift()
      }
    }
    // Top-level groups that can be layers (no transform, clip, mask or filter) become layers.
    const layerish = (g: XmlElement): boolean => {
      if (g.localName !== 'g') return false
      const st = im.computeStyle(g, rootStyle)
      return !['clip-path', 'mask', 'filter', 'transform'].some((p) => (st.props[p] ?? 'none').trim() !== 'none') && !attr(g, 'transform')
    }
    const asLayers = renderable.length > 0 && renderable.every(layerish)
    if (asLayers) {
      renderable.forEach((g, i) => {
        const st = im.computeStyle(g, rootStyle)
        if ((st.props.display ?? '').trim() === 'none') {
          layers.push({ name: nodeName(g) ?? `Layer ${i + 1}`, nodes: im.children(g, { ...ctx, parent: st }, st), opacity: 1, blend: 'normal', visible: false })
          return
        }
        const c = im.common(g, st)
        layers.push({
          name: nodeName(g) ?? `Layer ${i + 1}`,
          nodes: im.children(g, { ...ctx, parent: st, depth: 2 }, st),
          opacity: c.opacity ?? 1,
          blend: c.blend ?? 'normal',
          visible: c.hidden !== true
        })
      })
    } else {
      const nodes: DrawNode[] = []
      for (const k of renderable) nodes.push(...im.element(k, ctx))
      layers.push({ name: 'Layer 1', nodes, opacity: 1, blend: 'normal', visible: true })
    }
  } else {
    const nodes: DrawNode[] = []
    for (const k of renderable) nodes.push(...im.element(k, ctx))
    layers.push({ name: 'Layer 1', nodes, opacity: 1, blend: 'normal', visible: true })
  }
  // Hidden SVG-level content (in defs only) is fine; report a file that drew nothing.
  return { width: W, height: H, layers, ...(background ? { background } : {}), assets: im.assets, fallbacks: im.fallbacks, report: im.report }
}

function isFullPage(r: XmlElement, im: Importer, ctx: Ctx, W: number, H: number): boolean {
  const geo = im.localPath(r, ROOT_STYLE, ctx.vw, ctx.vh)
  if (!geo || geo.kind !== 'rect') return false
  const b = pathBounds(transformPath(geo.path, ctx.ctm))
  return Math.abs(b.x) < 0.01 && Math.abs(b.y) < 0.01 && Math.abs(b.w - W) < 0.01 && Math.abs(b.h - H) < 0.01
}

export class SvgImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SvgImportError'
  }
}
