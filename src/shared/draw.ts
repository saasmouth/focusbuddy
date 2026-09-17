// PlexiDraw — the document model for the vector + painting studio.
//
// One document holds a stack of LAYERS, and a layer is one of two kinds:
//
//   vector — a list of resolution-independent objects (paths, text, images),
//            the Illustrator half: editable anchors, fills, strokes, booleans.
//   raster — a single pixel buffer held as a PNG data URL, the Photoshop half:
//            brush, eraser and bucket strokes are composited into it.
//
// Keeping both kinds in ONE stack (rather than two parallel documents) is what
// makes the studio feel like one tool: a painted layer can sit between two
// vector layers, every layer shares the same opacity / blend-mode / lock
// controls, and export walks a single ordered list.
//
// Layer 0 is the BOTTOM of the stack, matching SVG and canvas paint order, so
// "draw them in array order" is always correct and no reversal is ever needed.

import {
  emptyPath,
  ellipsePath,
  linePath,
  pathBounds,
  pathToSvgD,
  polygonPath,
  rectPath,
  roundRectPath,
  starPath,
  transformPath,
  translatePath,
  unionBox,
  type Box,
  type DrawPath,
  type Matrix
} from './drawGeometry'

export type {
  Box,
  DrawNode,
  DrawPath,
  DrawSubpath,
  Matrix,
  Pt
} from './drawGeometry'

// ── Paint ────────────────────────────────────────────────────────────────────

// The CSS/SVG blend modes, which are the same list Photoshop ships minus the
// handful (Dissolve, Linear Burn…) the web platform has no compositing op for.
// Declaring only what actually renders keeps the picker honest.
export const DRAW_BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity'
] as const
export type DrawBlend = (typeof DRAW_BLEND_MODES)[number]

export interface DrawGradientStop {
  /** 0..1 along the gradient. */
  offset: number
  color: string
  opacity?: number
}

export type DrawPaint =
  | { type: 'none' }
  | { type: 'solid'; color: string; opacity?: number }
  // Angle in degrees, 0 = left-to-right, increasing clockwise (CSS convention
  // minus 90 so it reads the same way as the design studio's fills).
  | { type: 'linear'; stops: DrawGradientStop[]; angle?: number }
  | { type: 'radial'; stops: DrawGradientStop[] }

export interface DrawStroke {
  paint: DrawPaint
  width: number
  cap?: 'butt' | 'round' | 'square'
  join?: 'miter' | 'round' | 'bevel'
  /** Dash pattern in logical px. Absent or empty means a solid line. */
  dash?: number[]
  miterLimit?: number
}

export const NO_PAINT: DrawPaint = { type: 'none' }

export function solid(color: string, opacity?: number): DrawPaint {
  return opacity == null ? { type: 'solid', color } : { type: 'solid', color, opacity }
}

// ── Objects ──────────────────────────────────────────────────────────────────

interface DrawObjectBase {
  id: string
  name?: string
  opacity?: number
  blend?: DrawBlend
  locked?: boolean
  hidden?: boolean
}

/**
 * How a path was originally drawn. Live shapes keep their parameters so the
 * inspector can still offer "corner radius" or "points" after the fact; once a
 * boolean or a node edit changes the geometry the kind drops to 'path' and the
 * parameters are gone, exactly as in Illustrator.
 */
export type DrawShapeKind = 'rect' | 'roundRect' | 'ellipse' | 'polygon' | 'star' | 'line' | 'pencil' | 'pen' | 'path'

export interface DrawPathObject extends DrawObjectBase {
  type: 'path'
  path: DrawPath
  fill: DrawPaint
  stroke?: DrawStroke
  shapeKind?: DrawShapeKind
  /** Live-shape parameters, meaningful only for the matching shapeKind. */
  cornerRadius?: number
  sides?: number
  innerRatio?: number
}

export interface DrawTextObject extends DrawObjectBase {
  type: 'text'
  x: number
  y: number
  /** Wrapping width. Text grows downward from y. */
  w: number
  text: string
  fontFamily?: string
  fontSize: number
  fontWeight?: number
  italic?: boolean
  align?: 'left' | 'center' | 'right'
  lineHeight?: number
  letterSpacing?: number
  fill: DrawPaint
  stroke?: DrawStroke
  rotation?: number
  /**
   * The wrapped lines, as the editor measured them with the real font engine.
   * This is a CACHE the renderer maintains on every text/width/font change, and
   * it exists so the exporter draws the same breaks the screen showed rather
   * than re-guessing them. Absent (an older body, or text that has never been
   * opened) falls back to estimateWrap.
   */
  lines?: string[]
}

export interface DrawImageObject extends DrawObjectBase {
  type: 'image'
  x: number
  y: number
  w: number
  h: number
  /** data: URI. Keeping the bytes in the document makes it self-contained. */
  src: string
  alt?: string
  rotation?: number
}

export type DrawObject = DrawPathObject | DrawTextObject | DrawImageObject

// ── Layers ───────────────────────────────────────────────────────────────────

interface DrawLayerBase {
  id: string
  name: string
  visible: boolean
  locked: boolean
  /** 0..1. */
  opacity: number
  blend: DrawBlend
}

export interface DrawVectorLayer extends DrawLayerBase {
  kind: 'vector'
  objects: DrawObject[]
}

export interface DrawRasterLayer extends DrawLayerBase {
  kind: 'raster'
  /** PNG data URL at the document's pixel size, or '' for an empty layer. */
  src: string
}

export type DrawLayer = DrawVectorLayer | DrawRasterLayer

// ── Document ─────────────────────────────────────────────────────────────────

export interface DrawBody {
  schemaVersion: 1
  width: number
  height: number
  /**
   * The artboard behind every layer. `{ type: 'none' }` is a genuinely
   * transparent document — PNG export writes real alpha rather than baking in
   * a white rectangle that was never there.
   */
  background: DrawPaint
  layers: DrawLayer[]
  /** Id of the layer edits land on. */
  activeLayerId?: string
  /** Export resolution hint, logical px per inch. */
  dpi?: number
}

export interface DrawSize {
  id: string
  label: string
  category: 'canvas' | 'print' | 'screen' | 'icon'
  w: number
  h: number
  transparent?: boolean
}

export const DRAW_SIZES: DrawSize[] = [
  { id: 'square-2048', label: 'Square canvas', category: 'canvas', w: 2048, h: 2048 },
  { id: 'landscape-1920', label: 'Landscape', category: 'canvas', w: 1920, h: 1080 },
  { id: 'portrait-1080', label: 'Portrait', category: 'canvas', w: 1080, h: 1350 },
  { id: 'wide-3840', label: 'Wide (4K)', category: 'canvas', w: 3840, h: 2160 },
  { id: 'a4-print', label: 'A4 at 150dpi', category: 'print', w: 1240, h: 1754 },
  { id: 'letter-print', label: 'US Letter at 150dpi', category: 'print', w: 1275, h: 1650 },
  { id: 'poster-print', label: 'Poster A3 at 150dpi', category: 'print', w: 1754, h: 2480 },
  { id: 'web-banner', label: 'Web banner', category: 'screen', w: 1600, h: 500 },
  { id: 'social-post', label: 'Social post', category: 'screen', w: 1080, h: 1080 },
  { id: 'story', label: 'Story / Reel', category: 'screen', w: 1080, h: 1920 },
  { id: 'icon-1024', label: 'App icon', category: 'icon', w: 1024, h: 1024, transparent: true },
  { id: 'icon-512', label: 'Logo mark', category: 'icon', w: 512, h: 512, transparent: true }
]

export function findDrawSize(id: string): DrawSize | undefined {
  return DRAW_SIZES.find((s) => s.id === id)
}

let idCounter = 0
export function drawId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export function vectorLayer(name: string): DrawVectorLayer {
  return { id: drawId('lyr'), kind: 'vector', name, visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] }
}

export function rasterLayer(name: string): DrawRasterLayer {
  return { id: drawId('lyr'), kind: 'raster', name, visible: true, locked: false, opacity: 1, blend: 'normal', src: '' }
}

export function blankDrawBody(size: DrawSize): DrawBody {
  const first = vectorLayer('Layer 1')
  return {
    schemaVersion: 1,
    width: size.w,
    height: size.h,
    background: size.transparent ? { type: 'none' } : solid('#ffffff'),
    layers: [first],
    activeLayerId: first.id,
    dpi: size.category === 'print' ? 150 : 72
  }
}

// ── Normalisation ────────────────────────────────────────────────────────────

function clampDim(n: unknown, dflt: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : dflt
  return Math.max(16, Math.min(12000, v))
}

function num01(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt
}

function normBlend(v: unknown): DrawBlend {
  return typeof v === 'string' && (DRAW_BLEND_MODES as readonly string[]).includes(v) ? (v as DrawBlend) : 'normal'
}

function normPaint(v: unknown, dflt: DrawPaint): DrawPaint {
  if (!v || typeof v !== 'object') return dflt
  const p = v as Record<string, unknown>
  if (p.type === 'none') return { type: 'none' }
  if (p.type === 'solid') return typeof p.color === 'string' ? solid(p.color, typeof p.opacity === 'number' ? num01(p.opacity, 1) : undefined) : dflt
  if (p.type === 'linear' || p.type === 'radial') {
    const stops = Array.isArray(p.stops)
      ? (p.stops as unknown[])
          .map((s) => {
            const st = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
            return {
              offset: num01(st.offset, 0),
              color: typeof st.color === 'string' ? st.color : '#000000',
              ...(typeof st.opacity === 'number' ? { opacity: num01(st.opacity, 1) } : {})
            }
          })
          .sort((a, b) => a.offset - b.offset)
      : []
    if (stops.length < 2) return dflt
    return p.type === 'linear'
      ? { type: 'linear', stops, ...(typeof p.angle === 'number' ? { angle: p.angle } : {}) }
      : { type: 'radial', stops }
  }
  return dflt
}

function normStroke(v: unknown): DrawStroke | undefined {
  if (!v || typeof v !== 'object') return undefined
  const s = v as Record<string, unknown>
  const width = typeof s.width === 'number' && Number.isFinite(s.width) ? Math.max(0, s.width) : 1
  if (width <= 0) return undefined
  const paint = normPaint(s.paint, solid('#1c1917'))
  if (paint.type === 'none') return undefined
  return {
    paint,
    width,
    ...(s.cap === 'round' || s.cap === 'square' || s.cap === 'butt' ? { cap: s.cap } : {}),
    ...(s.join === 'round' || s.join === 'bevel' || s.join === 'miter' ? { join: s.join } : {}),
    ...(Array.isArray(s.dash) && s.dash.length ? { dash: (s.dash as unknown[]).filter((d): d is number => typeof d === 'number' && d >= 0) } : {}),
    ...(typeof s.miterLimit === 'number' ? { miterLimit: s.miterLimit } : {})
  }
}

function normPath(v: unknown): DrawPath {
  if (!v || typeof v !== 'object') return emptyPath()
  const p = v as Record<string, unknown>
  const subpaths = Array.isArray(p.subpaths)
    ? (p.subpaths as unknown[])
        .map((sp) => {
          const s = (sp && typeof sp === 'object' ? sp : {}) as Record<string, unknown>
          const nodes = Array.isArray(s.nodes)
            ? (s.nodes as unknown[])
                .map((n) => {
                  const nn = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>
                  if (typeof nn.x !== 'number' || typeof nn.y !== 'number') return null
                  return {
                    x: nn.x,
                    y: nn.y,
                    ...(typeof nn.inX === 'number' && typeof nn.inY === 'number' ? { inX: nn.inX, inY: nn.inY } : {}),
                    ...(typeof nn.outX === 'number' && typeof nn.outY === 'number' ? { outX: nn.outX, outY: nn.outY } : {})
                  }
                })
                .filter((n): n is NonNullable<typeof n> => n !== null)
            : []
          return { closed: s.closed === true, nodes }
        })
        .filter((s) => s.nodes.length > 0)
    : []
  return { subpaths, ...(p.fillRule === 'evenodd' ? { fillRule: 'evenodd' as const } : {}) }
}

function normObject(v: unknown): DrawObject | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id : drawId('obj')
  const shared = {
    id,
    ...(typeof o.name === 'string' ? { name: o.name } : {}),
    ...(typeof o.opacity === 'number' ? { opacity: num01(o.opacity, 1) } : {}),
    ...(o.blend ? { blend: normBlend(o.blend) } : {}),
    ...(o.locked === true ? { locked: true } : {}),
    ...(o.hidden === true ? { hidden: true } : {})
  }
  if (o.type === 'text') {
    return {
      ...shared,
      type: 'text',
      x: typeof o.x === 'number' ? o.x : 0,
      y: typeof o.y === 'number' ? o.y : 0,
      w: typeof o.w === 'number' ? Math.max(8, o.w) : 200,
      text: typeof o.text === 'string' ? o.text : '',
      fontSize: typeof o.fontSize === 'number' ? Math.max(1, o.fontSize) : 48,
      ...(typeof o.fontFamily === 'string' ? { fontFamily: o.fontFamily } : {}),
      ...(typeof o.fontWeight === 'number' ? { fontWeight: o.fontWeight } : {}),
      ...(o.italic === true ? { italic: true } : {}),
      ...(o.align === 'center' || o.align === 'right' ? { align: o.align } : {}),
      ...(typeof o.lineHeight === 'number' ? { lineHeight: o.lineHeight } : {}),
      ...(typeof o.letterSpacing === 'number' ? { letterSpacing: o.letterSpacing } : {}),
      ...(typeof o.rotation === 'number' ? { rotation: o.rotation } : {}),
      ...(Array.isArray(o.lines) ? { lines: (o.lines as unknown[]).filter((l): l is string => typeof l === 'string') } : {}),
      fill: normPaint(o.fill, solid('#1c1917')),
      ...(normStroke(o.stroke) ? { stroke: normStroke(o.stroke)! } : {})
    }
  }
  if (o.type === 'image') {
    if (typeof o.src !== 'string' || !o.src) return null
    return {
      ...shared,
      type: 'image',
      x: typeof o.x === 'number' ? o.x : 0,
      y: typeof o.y === 'number' ? o.y : 0,
      w: typeof o.w === 'number' ? Math.max(1, o.w) : 200,
      h: typeof o.h === 'number' ? Math.max(1, o.h) : 200,
      src: o.src,
      ...(typeof o.alt === 'string' ? { alt: o.alt } : {}),
      ...(typeof o.rotation === 'number' ? { rotation: o.rotation } : {})
    }
  }
  const path = normPath(o.path)
  if (path.subpaths.length === 0) return null
  return {
    ...shared,
    type: 'path',
    path,
    fill: normPaint(o.fill, NO_PAINT),
    ...(normStroke(o.stroke) ? { stroke: normStroke(o.stroke)! } : {}),
    ...(typeof o.shapeKind === 'string' ? { shapeKind: o.shapeKind as DrawShapeKind } : {}),
    ...(typeof o.cornerRadius === 'number' ? { cornerRadius: o.cornerRadius } : {}),
    ...(typeof o.sides === 'number' ? { sides: o.sides } : {}),
    ...(typeof o.innerRatio === 'number' ? { innerRatio: o.innerRatio } : {})
  }
}

function normLayer(v: unknown, index: number): DrawLayer {
  const l = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const base = {
    id: typeof l.id === 'string' && l.id ? l.id : drawId('lyr'),
    name: typeof l.name === 'string' && l.name ? l.name : `Layer ${index + 1}`,
    visible: l.visible !== false,
    locked: l.locked === true,
    opacity: num01(l.opacity, 1),
    blend: normBlend(l.blend)
  }
  if (l.kind === 'raster') {
    return { ...base, kind: 'raster', src: typeof l.src === 'string' ? l.src : '' }
  }
  const objects = Array.isArray(l.objects)
    ? (l.objects as unknown[]).map(normObject).filter((o): o is DrawObject => o !== null)
    : []
  return { ...base, kind: 'vector', objects }
}

/**
 * Turn anything loaded from disk (or arriving from a peer) into a valid body.
 * A document with no layers gets one empty vector layer rather than an
 * unusable canvas with nowhere to draw.
 */
export function normalizeDrawBody(raw: unknown): DrawBody {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const layers = Array.isArray(r.layers) ? (r.layers as unknown[]).map(normLayer) : []
  if (layers.length === 0) layers.push(vectorLayer('Layer 1'))
  const activeLayerId = typeof r.activeLayerId === 'string' && layers.some((l) => l.id === r.activeLayerId) ? r.activeLayerId : layers[layers.length - 1].id
  return {
    schemaVersion: 1,
    width: clampDim(r.width, 1920),
    height: clampDim(r.height, 1080),
    background: normPaint(r.background, solid('#ffffff')),
    layers,
    activeLayerId,
    ...(typeof r.dpi === 'number' && r.dpi > 0 ? { dpi: Math.round(r.dpi) } : {})
  }
}

// ── Object helpers ───────────────────────────────────────────────────────────

export function objectBounds(o: DrawObject): Box {
  if (o.type === 'path') return pathBounds(o.path)
  if (o.type === 'image') return { x: o.x, y: o.y, w: o.w, h: o.h }
  // Text height is a function of how it wraps, which only the renderer knows.
  // The model reports the single-line height as a floor; the editor replaces it
  // with the measured box once the text has been laid out.
  const lines = Math.max(1, o.lines?.length ?? o.text.split('\n').length)
  return { x: o.x, y: o.y, w: o.w, h: lines * o.fontSize * (o.lineHeight ?? 1.2) }
}

export function objectsBounds(objs: DrawObject[]): Box {
  return unionBox(objs.map(objectBounds))
}

export function moveObject(o: DrawObject, dx: number, dy: number): DrawObject {
  if (o.type === 'path') return { ...o, path: translatePath(o.path, dx, dy) }
  return { ...o, x: o.x + dx, y: o.y + dy }
}

export function transformObject(o: DrawObject, m: Matrix): DrawObject {
  if (o.type === 'path') return { ...o, path: transformPath(o.path, m) }
  // Non-path objects are axis-aligned frames, so a transform is applied to the
  // frame corners and the result re-fitted to a box. Rotation stays a separate
  // property (as it does in the design studio) rather than being baked in.
  const x2 = o.x + o.w
  const y2 = o.y + (o.type === 'image' ? o.h : objectBounds(o).h)
  const p1 = { x: m[0] * o.x + m[2] * o.y + m[4], y: m[1] * o.x + m[3] * o.y + m[5] }
  const p2 = { x: m[0] * x2 + m[2] * y2 + m[4], y: m[1] * x2 + m[3] * y2 + m[5] }
  const nx = Math.min(p1.x, p2.x)
  const ny = Math.min(p1.y, p2.y)
  const nw = Math.abs(p2.x - p1.x)
  const nh = Math.abs(p2.y - p1.y)
  if (o.type === 'image') return { ...o, x: nx, y: ny, w: Math.max(1, nw), h: Math.max(1, nh) }
  return { ...o, x: nx, y: ny, w: Math.max(8, nw) }
}

/** Build the path for a live shape from its parameters. */
export function shapePath(kind: DrawShapeKind, box: Box, opts: { cornerRadius?: number; sides?: number; innerRatio?: number } = {}): DrawPath {
  const { x, y, w, h } = box
  switch (kind) {
    case 'rect':
      return rectPath(x, y, w, h)
    case 'roundRect':
      return roundRectPath(x, y, w, h, opts.cornerRadius ?? Math.min(w, h) * 0.15)
    case 'ellipse':
      return ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2)
    case 'polygon':
      return polygonPath(x + w / 2, y + h / 2, Math.min(w, h) / 2, opts.sides ?? 6)
    case 'star':
      return starPath(x + w / 2, y + h / 2, Math.min(w, h) / 2, opts.sides ?? 5, opts.innerRatio ?? 0.5)
    case 'line':
      return linePath(x, y, x + w, y + h)
    default:
      return rectPath(x, y, w, h)
  }
}

// ── Layer helpers ────────────────────────────────────────────────────────────

export function findLayer(body: DrawBody, id: string | undefined): DrawLayer | undefined {
  return id ? body.layers.find((l) => l.id === id) : undefined
}

export function activeLayer(body: DrawBody): DrawLayer | undefined {
  return findLayer(body, body.activeLayerId) ?? body.layers[body.layers.length - 1]
}

export function replaceLayer(body: DrawBody, id: string, fn: (l: DrawLayer) => DrawLayer): DrawBody {
  return { ...body, layers: body.layers.map((l) => (l.id === id ? fn(l) : l)) }
}

/** Every object on every unlocked, visible vector layer, newest (topmost) last. */
export function allObjects(body: DrawBody): Array<{ layerId: string; object: DrawObject }> {
  const out: Array<{ layerId: string; object: DrawObject }> = []
  for (const l of body.layers) {
    if (l.kind !== 'vector') continue
    for (const o of l.objects) out.push({ layerId: l.id, object: o })
  }
  return out
}

export function findObject(body: DrawBody, objectId: string): { layerId: string; object: DrawObject } | undefined {
  return allObjects(body).find((e) => e.object.id === objectId)
}

// ── Rendering ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * A paint as an SVG paint value, appending any gradient it needs to `defs`.
 * Gradients are declared in objectBoundingBox units so one definition scales to
 * whatever shape references it.
 */
export function paintToSvg(paint: DrawPaint | undefined, defs: string[], idHint: string): { value: string; opacity?: number } {
  if (!paint || paint.type === 'none') return { value: 'none' }
  if (paint.type === 'solid') return { value: paint.color, ...(paint.opacity != null ? { opacity: paint.opacity } : {}) }
  const id = `grad-${idHint}`
  const stops = paint.stops
    .map((s) => `<stop offset="${(s.offset * 100).toFixed(2)}%" stop-color="${esc(s.color)}"${s.opacity != null ? ` stop-opacity="${s.opacity}"` : ''}/>`)
    .join('')
  if (paint.type === 'linear') {
    // Angle 0 points right; rotate the unit vector into objectBoundingBox coords.
    const rad = ((paint.angle ?? 0) * Math.PI) / 180
    const dx = Math.cos(rad) / 2
    const dy = Math.sin(rad) / 2
    defs.push(
      `<linearGradient id="${id}" x1="${(0.5 - dx).toFixed(4)}" y1="${(0.5 - dy).toFixed(4)}" x2="${(0.5 + dx).toFixed(4)}" y2="${(0.5 + dy).toFixed(4)}">${stops}</linearGradient>`
    )
  } else {
    defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`)
  }
  return { value: `url(#${id})` }
}

/** The CSS value for a paint, for on-screen surfaces that are not SVG. */
export function paintToCss(paint: DrawPaint | undefined): string {
  if (!paint || paint.type === 'none') return 'transparent'
  if (paint.type === 'solid') return paint.color
  const stops = paint.stops.map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`).join(', ')
  if (paint.type === 'linear') return `linear-gradient(${(paint.angle ?? 0) + 90}deg, ${stops})`
  return `radial-gradient(circle at 50% 50%, ${stops})`
}

function strokeAttrs(stroke: DrawStroke | undefined, defs: string[], idHint: string): string {
  if (!stroke) return ''
  const p = paintToSvg(stroke.paint, defs, `${idHint}-s`)
  if (p.value === 'none') return ''
  return (
    ` stroke="${p.value}" stroke-width="${stroke.width}"` +
    (p.opacity != null ? ` stroke-opacity="${p.opacity}"` : '') +
    (stroke.cap ? ` stroke-linecap="${stroke.cap}"` : '') +
    (stroke.join ? ` stroke-linejoin="${stroke.join}"` : '') +
    (stroke.dash && stroke.dash.length ? ` stroke-dasharray="${stroke.dash.join(' ')}"` : '') +
    (stroke.miterLimit != null ? ` stroke-miterlimit="${stroke.miterLimit}"` : '')
  )
}

function objectStyle(o: DrawObject): string {
  const bits: string[] = []
  if (o.opacity != null && o.opacity < 1) bits.push(`opacity:${o.opacity}`)
  if (o.blend && o.blend !== 'normal') bits.push(`mix-blend-mode:${o.blend}`)
  return bits.length ? ` style="${bits.join(';')}"` : ''
}

/**
 * Wrap `text` to `width` using an average-advance estimate. This is only ever
 * used for EXPORT, where the renderer's real measurements are unavailable — the
 * on-canvas editor measures glyphs properly and stores the result, so what you
 * see is what you get. The estimate is deliberately conservative (slightly wide)
 * so exported text breaks no later than it does on screen, never overflowing.
 */
export function estimateWrap(text: string, width: number, fontSize: number, letterSpacing = 0): string[] {
  const advance = fontSize * 0.52 + letterSpacing
  const perLine = Math.max(1, Math.floor(width / Math.max(0.01, advance)))
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (para.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of para.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      if (candidate.length <= perLine || !line) line = candidate
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

function objectSvg(o: DrawObject, defs: string[]): string {
  if (o.hidden) return ''
  if (o.type === 'path') {
    const f = paintToSvg(o.fill, defs, o.id)
    const d = pathToSvgD(o.path)
    if (!d) return ''
    return (
      `<path d="${d}" fill="${f.value}"` +
      (f.opacity != null ? ` fill-opacity="${f.opacity}"` : '') +
      (o.path.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '') +
      strokeAttrs(o.stroke, defs, o.id) +
      objectStyle(o) +
      '/>'
    )
  }
  if (o.type === 'image') {
    const rot = o.rotation ? ` transform="rotate(${o.rotation} ${o.x + o.w / 2} ${o.y + o.h / 2})"` : ''
    return `<image href="${esc(o.src)}" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" preserveAspectRatio="none"${rot}${objectStyle(o)}/>`
  }
  const f = paintToSvg(o.fill, defs, o.id)
  const lh = (o.lineHeight ?? 1.2) * o.fontSize
  const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start'
  const ax = o.align === 'center' ? o.x + o.w / 2 : o.align === 'right' ? o.x + o.w : o.x
  // Prefer the editor's measured breaks; estimateWrap is only the fallback for
  // text no editor has ever laid out.
  const lines = o.lines && o.lines.length ? o.lines : estimateWrap(o.text, o.w, o.fontSize, o.letterSpacing ?? 0)
  const tspans = lines
    .map((l, i) => `<tspan x="${ax}" y="${(o.y + o.fontSize + i * lh).toFixed(2)}">${esc(l) || ' '}</tspan>`)
    .join('')
  const rot = o.rotation ? ` transform="rotate(${o.rotation} ${o.x + o.w / 2} ${o.y})"` : ''
  return (
    `<text font-family="${esc(o.fontFamily ?? 'Inter, system-ui, sans-serif')}" font-size="${o.fontSize}"` +
    (o.fontWeight ? ` font-weight="${o.fontWeight}"` : '') +
    (o.italic ? ' font-style="italic"' : '') +
    (o.letterSpacing ? ` letter-spacing="${o.letterSpacing}"` : '') +
    ` text-anchor="${anchor}" fill="${f.value}"` +
    (f.opacity != null ? ` fill-opacity="${f.opacity}"` : '') +
    strokeAttrs(o.stroke, defs, o.id) +
    rot +
    objectStyle(o) +
    `>${tspans}</text>`
  )
}

function layerStyle(l: DrawLayer): string {
  const bits: string[] = []
  if (l.opacity < 1) bits.push(`opacity:${l.opacity}`)
  if (l.blend !== 'normal') bits.push(`mix-blend-mode:${l.blend}`)
  return bits.length ? ` style="${bits.join(';')}"` : ''
}

/**
 * The whole document as one standalone SVG. Raster layers ride along as
 * embedded <image> elements, so a mixed vector/paint document survives the
 * round trip into any other tool with its painted pixels intact.
 */
export function drawToSvg(body: DrawBody): string {
  const defs: string[] = []
  const layers = body.layers
    .filter((l) => l.visible)
    .map((l) => {
      if (l.kind === 'raster') {
        if (!l.src) return ''
        return `<g${layerStyle(l)}><image href="${esc(l.src)}" x="0" y="0" width="${body.width}" height="${body.height}" preserveAspectRatio="none"/></g>`
      }
      const objs = l.objects.map((o) => objectSvg(o, defs)).join('')
      if (!objs) return ''
      return `<g${layerStyle(l)}>${objs}</g>`
    })
    .join('')
  const bgPaint = paintToSvg(body.background, defs, 'bg')
  const bg = bgPaint.value === 'none' ? '' : `<rect x="0" y="0" width="${body.width}" height="${body.height}" fill="${bgPaint.value}"/>`
  const defsBlock = defs.length ? `<defs>${defs.join('')}</defs>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${body.width}" height="${body.height}" viewBox="0 0 ${body.width} ${body.height}">` +
    `${defsBlock}${bg}${layers}</svg>`
  )
}

/** A standalone HTML page wrapping the SVG, for the offscreen PNG/PDF capture. */
export function drawToHtml(body: DrawBody): string {
  const transparent = body.background.type === 'none'
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{width:${body.width}px;height:${body.height}px;background:${transparent ? 'transparent' : 'none'}}</style></head>` +
    `<body>${drawToSvg(body)}</body></html>`
  )
}
