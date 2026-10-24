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

import { embedDisplayField, type EmbedDisplay } from './embedDisplay'
import {
  emptyPath,
  ellipsePath,
  hitPath,
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
  type Matrix,
  type Pt
} from './drawGeometry'
import { safeCssColor } from './cssColor'
import { esc, fixed, num } from './draw/markup'

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

/**
 * A live work widget placed on the drawing.
 *
 * It stores only the id, never a copy: a work widget is a file
 * (docs/widget-files.md), so the drawing points at it and the renderer
 * resolves the current content every time. The same widget can therefore sit
 * on a drawing, on desks and in a document at once, and typing in any of
 * them changes the one object.
 *
 * Deliberately unlike DrawImageObject, which embeds its bytes to keep the
 * document self-contained. A widget is not bytes; a snapshot of one would be
 * a copy that silently goes stale, which is the thing the file model exists
 * to prevent.
 */
export interface DrawWidgetObject extends DrawObjectBase {
  type: 'widget'
  x: number
  y: number
  w: number
  h: number
  /** A desk widget id, or `wf:<file id>` for a work widget file. */
  widgetId: string
  rotation?: number
  /** 'data' (the content alone, the default) or 'object' (the original, with its frame). */
  embedDisplay?: EmbedDisplay
}

/**
 * An object this build does not understand, kept VERBATIM.
 *
 * A newer PlexiiDraw can add object kinds (groups, symbols, type on a path…).
 * Before this existed the normaliser dropped anything it did not recognise, so
 * an older app that merely opened a newer drawing and then saved -- or co-edited
 * it live -- silently destroyed the newer work. Now the original JSON rides
 * along untouched in `raw`, is never drawn, never hit-tested and never edited,
 * and `drawBodyForStorage` writes it back exactly as it arrived. A document that
 * holds one opens read-only (see drawCompatibility), so in practice it is only
 * ever carried, not changed.
 *
 * The raw object never reaches markup: every renderer and the serializer skip
 * this type, so it needs no sanitising beyond the id used as a React key.
 */
export interface DrawOpaqueObject extends DrawObjectBase {
  type: 'opaque'
  /** The `type` the object arrived with, for the "unsupported object" notice. */
  originalType: string
  raw: Record<string, unknown>
}

export type DrawObject = DrawPathObject | DrawTextObject | DrawImageObject | DrawWidgetObject | DrawOpaqueObject

/** Object kinds this build can draw and edit. Anything else is carried as opaque. */
export const DRAW_OBJECT_TYPES = ['path', 'text', 'image', 'widget'] as const

export function isOpaqueObject(o: DrawObject): o is DrawOpaqueObject {
  return o.type === 'opaque'
}

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

/**
 * The shape every layer and object id must have: letters, digits, '-' and '_'.
 *
 * Ids are not just keys. An object id becomes part of an SVG element id
 * (`grad-<id>`), a `url(#grad-<id>)` paint reference and a data-testid, in the
 * editor AND in the exported file -- and a document arriving from a share link
 * or a peer was written by someone else. drawId() only ever produces this
 * shape, so a real document never trips it; anything else is replaced with a
 * fresh id at load rather than carried into markup.
 */
export const DRAW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isSafeDrawId(v: unknown): v is string {
  return typeof v === 'string' && DRAW_ID_PATTERN.test(v)
}

/**
 * Image bytes a document may embed: a data: URL of a raster or SVG image.
 *
 * The model has always said "data: URI" (see DrawImageObject.src); this makes it
 * true. A remote address would have every viewer of a shared drawing fetch it
 * -- a tracking pixel on the public share page -- and would taint the canvas
 * the raster tools read back. SVG is safe here because an <image>/<img> renders
 * it as a static picture with scripting disabled.
 */
const DRAW_IMAGE_SRC = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i

export function isDrawImageSrc(v: unknown): v is string {
  return typeof v === 'string' && DRAW_IMAGE_SRC.test(v)
}

const DRAW_SHAPE_KINDS: readonly DrawShapeKind[] = ['rect', 'roundRect', 'ellipse', 'polygon', 'star', 'line', 'pencil', 'pen', 'path']

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

// ── Forward compatibility ────────────────────────────────────────────────────

/**
 * The newest document schema this build can both read and write.
 *
 * A body carries `schemaVersion` (the shape it is written in) and, from v2 on,
 * `minWriterVersion` (the oldest app allowed to write it back). Either one
 * above this number means the document was made by a newer PlexiiDraw: this
 * build can show what it understands, but must not save over it, because its
 * normaliser would quietly drop whatever the newer app added.
 */
export const DRAW_SCHEMA_VERSION = 1

export type DrawReadOnlyReason = 'newer-schema' | 'unknown-objects' | 'unknown-layers'

export interface DrawCompatibility {
  /** True when this build must not save over the document. */
  readOnly: boolean
  reasons: DrawReadOnlyReason[]
  /** The schema version the body declares (1 when it declares none). */
  schemaVersion: number
  /** The oldest app version allowed to write it (defaults to schemaVersion). */
  minWriterVersion: number
  /** Distinct object `type`s this build does not know, in first-seen order. */
  unknownTypes: string[]
  /** How many objects carry one of those types. */
  unknownCount: number
}

function declaredVersion(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt
}

/** Whether a raw object's `type` is one this build draws (a missing type reads as a path, as it always has). */
function isKnownObjectType(t: unknown): boolean {
  return t === undefined || (typeof t === 'string' && (DRAW_OBJECT_TYPES as readonly string[]).includes(t))
}

/**
 * Can this build edit `raw`, or only show it?
 *
 * Read straight off the untrusted JSON, before any normalisation, because
 * normalising is exactly the step that would lose what a newer app wrote. Every
 * place that loads a drawing to EDIT it asks this first: the studio (which opens
 * read-only with a banner), the main-process document store (which then hands
 * the body over verbatim and refuses to overwrite it), and live co-editing.
 */
export function drawCompatibility(raw: unknown): DrawCompatibility {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const schemaVersion = declaredVersion(r.schemaVersion, 1)
  const minWriterVersion = declaredVersion(r.minWriterVersion, schemaVersion)
  const unknownTypes: string[] = []
  let unknownCount = 0
  let unknownLayers = false
  const layers = Array.isArray(r.layers) ? (r.layers as unknown[]) : []
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    const l = layer as Record<string, unknown>
    // A layer kind this build has no renderer for would otherwise be read as an
    // empty vector layer -- the same silent loss one level up.
    if (l.kind !== undefined && l.kind !== 'vector' && l.kind !== 'raster') unknownLayers = true
    const objects = Array.isArray(l.objects) ? (l.objects as unknown[]) : []
    for (const o of objects) {
      if (!o || typeof o !== 'object') continue
      const t = (o as Record<string, unknown>).type
      if (isKnownObjectType(t)) continue
      unknownCount += 1
      const label = typeof t === 'string' ? t : String(t)
      if (!unknownTypes.includes(label)) unknownTypes.push(label)
    }
  }
  const reasons: DrawReadOnlyReason[] = []
  if (schemaVersion > DRAW_SCHEMA_VERSION || minWriterVersion > DRAW_SCHEMA_VERSION) reasons.push('newer-schema')
  if (unknownCount > 0) reasons.push('unknown-objects')
  if (unknownLayers) reasons.push('unknown-layers')
  return { readOnly: reasons.length > 0, reasons, schemaVersion, minWriterVersion, unknownTypes, unknownCount }
}

/**
 * Must a save of `incoming` be refused because it would overwrite `stored`?
 *
 * Yes when the stored drawing is one this build can only show (see
 * drawCompatibility) and the incoming body is one this build produced -- i.e.
 * a downgrade. A body that is itself newer (a newer copy arriving verbatim,
 * say from sync or version history) is not refused: it carries the newer data
 * rather than erasing it.
 */
export function refusesDrawOverwrite(stored: unknown, incoming: unknown): boolean {
  return drawCompatibility(stored).readOnly && !drawCompatibility(incoming).readOnly
}

/**
 * The body as it should be written to storage or a co-editing peer.
 *
 * Every object this build understood is written as it is; every opaque object
 * is written back as the exact JSON it arrived as, so a document that passes
 * through an older app comes out holding everything a newer one put in.
 */
export function drawBodyForStorage(body: DrawBody): DrawBody {
  let touched = false
  const layers = body.layers.map((l) => {
    if (l.kind !== 'vector' || !l.objects.some(isOpaqueObject)) return l
    touched = true
    return { ...l, objects: l.objects.map((o) => (isOpaqueObject(o) ? (o.raw as unknown as DrawObject) : o)) }
  })
  return touched ? { ...body, layers } : body
}

// ── Normalisation ────────────────────────────────────────────────────────────

function clampDim(n: unknown, dflt: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : dflt
  return Math.max(16, Math.min(12000, v))
}

function num01(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt
}

/** A finite number. JSON cannot carry NaN or Infinity, but a structured clone can. */
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function normBlend(v: unknown): DrawBlend {
  return typeof v === 'string' && (DRAW_BLEND_MODES as readonly string[]).includes(v) ? (v as DrawBlend) : 'normal'
}

function normPaint(v: unknown, dflt: DrawPaint): DrawPaint {
  if (!v || typeof v !== 'object') return dflt
  const p = v as Record<string, unknown>
  if (p.type === 'none') return { type: 'none' }
  if (p.type === 'solid') {
    // Not a colour (see cssColor.ts) means not this paint: the caller's default
    // stands in, exactly as for a paint with no colour at all.
    const color = safeCssColor(p.color, undefined)
    return color ? solid(color, typeof p.opacity === 'number' ? num01(p.opacity, 1) : undefined) : dflt
  }
  if (p.type === 'linear' || p.type === 'radial') {
    const stops = Array.isArray(p.stops)
      ? (p.stops as unknown[])
          .map((s) => {
            const st = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
            return {
              offset: num01(st.offset, 0),
              color: safeCssColor(st.color, '#000000'),
              ...(typeof st.opacity === 'number' ? { opacity: num01(st.opacity, 1) } : {})
            }
          })
          .sort((a, b) => a.offset - b.offset)
      : []
    if (stops.length < 2) return dflt
    return p.type === 'linear'
      ? { type: 'linear', stops, ...(isNum(p.angle) ? { angle: p.angle } : {}) }
      : { type: 'radial', stops }
  }
  return dflt
}

function normStroke(v: unknown): DrawStroke | undefined {
  if (!v || typeof v !== 'object') return undefined
  const s = v as Record<string, unknown>
  const width = isNum(s.width) ? Math.max(0, s.width) : 1
  if (width <= 0) return undefined
  const paint = normPaint(s.paint, solid('#1c1917'))
  if (paint.type === 'none') return undefined
  return {
    paint,
    width,
    ...(s.cap === 'round' || s.cap === 'square' || s.cap === 'butt' ? { cap: s.cap } : {}),
    ...(s.join === 'round' || s.join === 'bevel' || s.join === 'miter' ? { join: s.join } : {}),
    ...(Array.isArray(s.dash) && s.dash.length ? { dash: (s.dash as unknown[]).filter((d): d is number => isNum(d) && d >= 0) } : {}),
    ...(isNum(s.miterLimit) ? { miterLimit: s.miterLimit } : {})
  }
}

/**
 * v1's normalisation rules, exported for the v2 normaliser (draw/normalize.ts)
 * so a paint, a stroke or a path means exactly the same thing in both. Not
 * for general use: call normalizeDrawBody / normalizeDrawDoc.
 */
export function normDrawPaint(v: unknown, dflt: DrawPaint): DrawPaint {
  return normPaint(v, dflt)
}
export function normDrawStroke(v: unknown): DrawStroke | undefined {
  return normStroke(v)
}
export function normDrawPath(v: unknown): DrawPath {
  return normPath(v)
}
export function normDrawBlend(v: unknown): DrawBlend {
  return normBlend(v)
}
/** A number clamped to 0..1, or `dflt` when it is not a finite number. */
export function unit01(v: unknown, dflt: number): number {
  return num01(v, dflt)
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
                  if (!isNum(nn.x) || !isNum(nn.y)) return null
                  return {
                    x: nn.x,
                    y: nn.y,
                    ...(isNum(nn.inX) && isNum(nn.inY) ? { inX: nn.inX, inY: nn.inY } : {}),
                    ...(isNum(nn.outX) && isNum(nn.outY) ? { outX: nn.outX, outY: nn.outY } : {})
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

/**
 * Image bytes a NEWER body keeps in its asset store (`assets[id].dataUrl`, see
 * the v2 model) rather than inline. Read only so that a drawing made by a newer
 * app can still be SHOWN here, read-only; it is held to the same embedded-bytes
 * rule as an inline src.
 */
type AssetLookup = (id: unknown) => string | undefined

function assetLookup(assets: unknown): AssetLookup {
  const a = (assets && typeof assets === 'object' ? assets : {}) as Record<string, unknown>
  return (id) => {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(a, id)) return undefined
    const entry = a[id] as Record<string, unknown> | null
    return entry && typeof entry === 'object' && isDrawImageSrc(entry.dataUrl) ? entry.dataUrl : undefined
  }
}

const NO_ASSETS: AssetLookup = () => undefined

function normObject(v: unknown, asset: AssetLookup = NO_ASSETS): DrawObject | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  // See DRAW_ID_PATTERN: an id that is not one this app could have minted is
  // replaced, never carried into the markup it would otherwise end up in.
  const id = isSafeDrawId(o.id) ? o.id : drawId('obj')
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
      x: isNum(o.x) ? o.x : 0,
      y: isNum(o.y) ? o.y : 0,
      w: isNum(o.w) ? Math.max(8, o.w) : 200,
      text: typeof o.text === 'string' ? o.text : '',
      fontSize: isNum(o.fontSize) ? Math.max(1, o.fontSize) : 48,
      ...(typeof o.fontFamily === 'string' ? { fontFamily: o.fontFamily } : {}),
      ...(isNum(o.fontWeight) ? { fontWeight: o.fontWeight } : {}),
      ...(o.italic === true ? { italic: true } : {}),
      ...(o.align === 'center' || o.align === 'right' ? { align: o.align } : {}),
      ...(isNum(o.lineHeight) ? { lineHeight: o.lineHeight } : {}),
      ...(isNum(o.letterSpacing) ? { letterSpacing: o.letterSpacing } : {}),
      ...(isNum(o.rotation) ? { rotation: o.rotation } : {}),
      ...(Array.isArray(o.lines) ? { lines: (o.lines as unknown[]).filter((l): l is string => typeof l === 'string') } : {}),
      fill: normPaint(o.fill, solid('#1c1917')),
      ...(normStroke(o.stroke) ? { stroke: normStroke(o.stroke)! } : {})
    }
  }
  if (o.type === 'widget') {
    // A live work widget. It was missing here, so it fell through to the path
    // branch below, had no geometry and was DROPPED: every widget placed on a
    // drawing vanished the next time the document was opened. The id is only
    // ever a React prop for WidgetEmbed, never markup, but it is still held to a
    // plain shape and length.
    if (typeof o.widgetId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(o.widgetId)) return null
    return {
      ...shared,
      type: 'widget',
      x: isNum(o.x) ? o.x : 0,
      y: isNum(o.y) ? o.y : 0,
      w: isNum(o.w) ? Math.max(1, o.w) : 320,
      h: isNum(o.h) ? Math.max(1, o.h) : 240,
      widgetId: o.widgetId,
      ...embedDisplayField(o.embedDisplay),
      ...(isNum(o.rotation) ? { rotation: o.rotation } : {})
    }
  }
  if (o.type === 'opaque' && o.raw && typeof o.raw === 'object' && typeof o.originalType === 'string') {
    // Already carried once (an in-memory body normalised again): keep the
    // original JSON, never wrap it twice.
    return { id, type: 'opaque', originalType: o.originalType, raw: o.raw as Record<string, unknown> }
  }
  if (!isKnownObjectType(o.type)) {
    // Made by a newer PlexiiDraw. Carried verbatim -- see DrawOpaqueObject.
    return { id, type: 'opaque', originalType: String(o.type), raw: o }
  }
  if (o.type === 'image') {
    // Embedded image bytes only (see isDrawImageSrc). Nothing in the editor
    // makes an image object with anything else, so this only ever drops content
    // that arrived from outside pointing somewhere it should not.
    const src = isDrawImageSrc(o.src) ? o.src : asset(o.assetId)
    if (!src) return null
    return {
      ...shared,
      type: 'image',
      x: isNum(o.x) ? o.x : 0,
      y: isNum(o.y) ? o.y : 0,
      w: isNum(o.w) ? Math.max(1, o.w) : 200,
      h: isNum(o.h) ? Math.max(1, o.h) : 200,
      src,
      ...(typeof o.alt === 'string' ? { alt: o.alt } : {}),
      ...(isNum(o.rotation) ? { rotation: o.rotation } : {})
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
    ...(typeof o.shapeKind === 'string' && (DRAW_SHAPE_KINDS as readonly string[]).includes(o.shapeKind)
      ? { shapeKind: o.shapeKind as DrawShapeKind }
      : {}),
    ...(isNum(o.cornerRadius) ? { cornerRadius: o.cornerRadius } : {}),
    ...(isNum(o.sides) ? { sides: o.sides } : {}),
    ...(isNum(o.innerRatio) ? { innerRatio: o.innerRatio } : {})
  }
}

function normLayer(v: unknown, index: number, asset: AssetLookup = NO_ASSETS): DrawLayer {
  const l = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const base = {
    id: isSafeDrawId(l.id) ? l.id : drawId('lyr'),
    name: typeof l.name === 'string' && l.name ? l.name : `Layer ${index + 1}`,
    visible: l.visible !== false,
    locked: l.locked === true,
    opacity: num01(l.opacity, 1),
    blend: normBlend(l.blend)
  }
  if (l.kind === 'raster') {
    // An empty layer, or embedded pixels. A remote address is treated as an
    // empty layer: the raster tools could not read it back anyway (it taints
    // the canvas), and loading it would ping its owner from every viewer.
    return { ...base, kind: 'raster', src: isDrawImageSrc(l.src) ? l.src : (asset(l.assetId) ?? '') }
  }
  const objects = Array.isArray(l.objects)
    ? (l.objects as unknown[]).map((o) => normObject(o, asset)).filter((o): o is DrawObject => o !== null)
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
  const asset = assetLookup(r.assets)
  const layers = Array.isArray(r.layers) ? (r.layers as unknown[]).map((l, i) => normLayer(l, i, asset)) : []
  if (layers.length === 0) layers.push(vectorLayer('Layer 1'))
  const activeLayerId = typeof r.activeLayerId === 'string' && layers.some((l) => l.id === r.activeLayerId) ? r.activeLayerId : layers[layers.length - 1].id
  // A newer body keeps its page size on its first artboard instead of at the
  // top level. Reading it there lets this build SHOW such a drawing at the right
  // size (read-only, see drawCompatibility) rather than on a default canvas.
  const board = Array.isArray(r.artboards) && r.artboards[0] && typeof r.artboards[0] === 'object' ? (r.artboards[0] as Record<string, unknown>) : null
  return {
    schemaVersion: 1,
    width: clampDim(r.width ?? board?.w, 1920),
    height: clampDim(r.height ?? board?.h, 1080),
    background: normPaint(r.background ?? board?.background, solid('#ffffff')),
    layers,
    activeLayerId,
    ...(typeof r.dpi === 'number' && r.dpi > 0 ? { dpi: Math.round(r.dpi) } : {})
  }
}

/** True for a frame object (text, image, work widget) that is turned. */
export function isRotatedFrame(o: DrawObject): boolean {
  return objectRotation(o) !== 0
}

// ── Object helpers ───────────────────────────────────────────────────────────

/** Degrees of a frame object's rotation, 0 for paths (whose rotation is baked into their nodes). */
export function objectRotation(o: DrawObject): number {
  if (o.type === 'text' || o.type === 'image' || o.type === 'widget') return isNum(o.rotation) ? o.rotation : 0
  return 0
}

/**
 * The point a frame object rotates about -- the SAME point both renderers and
 * the exporter pass to `rotate()`. Images and widgets turn about their centre;
 * text about the middle of its top edge, which is where the first line hangs.
 */
export function objectPivot(o: DrawTextObject | DrawImageObject | DrawWidgetObject): Pt {
  return o.type === 'text' ? { x: o.x + o.w / 2, y: o.y } : { x: o.x + o.w / 2, y: o.y + o.h / 2 }
}

/**
 * The box an object occupies BEFORE its rotation: a path's geometric bounds, or
 * a frame object's own x/y/w/h. This is what scaling and the text editor work
 * in -- the frame is what gets resized, then rotated.
 */
export function frameBounds(o: DrawObject): Box {
  if (o.type === 'path') return pathBounds(o.path)
  // An opaque object has no geometry this build understands. It is never
  // selectable, so this only keeps the function total.
  if (o.type === 'opaque') return { x: 0, y: 0, w: 0, h: 0 }
  // A widget is a plain box, like an image. Listed explicitly rather than
  // left to fall through to the text branch below, which would read
  // fontSize off it and produce NaN bounds — selection, alignment and the
  // export frame all derive from this.
  if (o.type === 'image' || o.type === 'widget') return { x: o.x, y: o.y, w: o.w, h: o.h }
  // Text height is a function of how it wraps, which only the renderer knows.
  // The model reports the single-line height as a floor; the editor replaces it
  // with the measured box once the text has been laid out.
  const lines = Math.max(1, o.lines?.length ?? o.text.split('\n').length)
  return { x: o.x, y: o.y, w: o.w, h: lines * o.fontSize * (o.lineHeight ?? 1.2) }
}

function rotatePt(p: Pt, c: Pt, degrees: number): Pt {
  const a = (degrees * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

/**
 * The box an object VISIBLY occupies on the artboard. For a rotated text,
 * image or widget that is the bounding box of its turned frame, not the frame
 * itself -- selecting, marquee-picking, aligning and snapping all measure what
 * you can see. (It used to return the unrotated frame, so a turned photo was
 * selected and aligned as if it had never been turned.)
 */
export function objectBounds(o: DrawObject): Box {
  const frame = frameBounds(o)
  const deg = objectRotation(o)
  if (!deg || o.type === 'path' || o.type === 'opaque') return frame
  const c = objectPivot(o)
  const corners = [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.w, y: frame.y },
    { x: frame.x + frame.w, y: frame.y + frame.h },
    { x: frame.x, y: frame.y + frame.h }
  ].map((p) => rotatePt(p, c, deg))
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function objectsBounds(objs: DrawObject[]): Box {
  return unionBox(objs.filter((o) => o.type !== 'opaque').map(objectBounds))
}

/**
 * Is `p` on the object? Paths test their real geometry (fill and stroke);
 * frame objects test their frame in their OWN rotated space, so a click on the
 * visible corner of a turned image hits it and a click in the empty triangle
 * its old unrotated box used to cover does not. Opaque objects are never hit.
 */
export function hitObject(o: DrawObject, p: Pt, slop = 0): boolean {
  if (o.type === 'opaque') return false
  if (o.type === 'path') return hitPath(o.path, p, { filled: o.fill.type !== 'none', strokeWidth: o.stroke?.width, slop })
  const frame = frameBounds(o)
  const deg = objectRotation(o)
  const q = deg ? rotatePt(p, objectPivot(o), -deg) : p
  return q.x >= frame.x && q.x <= frame.x + frame.w && q.y >= frame.y && q.y <= frame.y + frame.h
}

export function moveObject(o: DrawObject, dx: number, dy: number): DrawObject {
  if (o.type === 'path') return { ...o, path: translatePath(o.path, dx, dy) }
  if (o.type === 'opaque') return o
  return { ...o, x: o.x + dx, y: o.y + dy }
}

export function transformObject(o: DrawObject, m: Matrix): DrawObject {
  if (o.type === 'path') return { ...o, path: transformPath(o.path, m) }
  if (o.type === 'opaque') return o
  // Non-path objects are axis-aligned frames, so a transform is applied to the
  // frame corners and the result re-fitted to a box. Rotation stays a separate
  // property (as it does in the design studio) rather than being baked in.
  const x2 = o.x + o.w
  const y2 = o.y + (o.type === 'image' ? o.h : frameBounds(o).h)
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

/**
 * What "Select all" may pick: every object on a visible, unlocked vector layer
 * that is itself neither hidden nor locked (nor opaque). The keyboard ⌘A always
 * filtered like this; the Edit menu's Select all did not, so a locked object
 * landed in the selection and Align then moved it.
 */
export function selectableObjectIds(body: DrawBody): string[] {
  const out: string[] = []
  for (const l of body.layers) {
    if (l.kind !== 'vector' || !l.visible || l.locked) continue
    for (const o of l.objects) if (!o.hidden && !o.locked && o.type !== 'opaque') out.push(o.id)
  }
  return out
}

// ── Rendering ────────────────────────────────────────────────────────────────

// Everything below writes markup by hand, so every value that reaches it is
// either escaped (esc), formatted from a finite number (num), or checked
// against a closed set (colours, blend modes, caps, joins, ids). That holds even
// for a body that never went through normalizeDrawBody -- the serializer does
// not trust its caller to have done that.

// esc / num / fixed live in draw/markup.ts, shared with the v2 serializer so
// the two cannot drift.

function blendOk(v: unknown): v is DrawBlend {
  return typeof v === 'string' && (DRAW_BLEND_MODES as readonly string[]).includes(v)
}

/**
 * The SVG element id for a paint's gradient. Ids are already constrained at
 * load (DRAW_ID_PATTERN); this guarantees the same for any id that skipped it,
 * so the result is always safe in an id attribute AND inside `url(#…)`.
 */
export function gradientId(idHint: string): string {
  return `grad-${String(idHint).replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** One gradient stop, formatted for SVG. */
export interface DrawGradientStopDef {
  /** e.g. "37.50%" */
  offset: string
  /** A colour that passed isSafeCssColor. */
  color: string
  opacity?: string
}

/**
 * A gradient as data rather than markup.
 *
 * Both the exporter and the on-screen editor draw gradients from this one
 * description, so a gradient can never look different on screen than in the
 * file -- and the editor can render it as React elements instead of injecting
 * markup. Every field is already formatted and safe: the id is constrained,
 * the colours are checked, and the numbers are fixed-point strings.
 */
export interface DrawGradientDef {
  kind: 'linear' | 'radial'
  id: string
  /** objectBoundingBox endpoints. Linear only. */
  x1?: string
  y1?: string
  x2?: string
  y2?: string
  /**
   * Radial geometry in objectBoundingBox units. Absent = the centred circle
   * (0.5, 0.5, r 0.5) v1 always drew; v2 paints may move the centre, change
   * the radius and set a focal point.
   */
  cx?: string
  cy?: string
  r?: string
  fx?: string
  fy?: string
  stops: DrawGradientStopDef[]
}

export interface DrawSvgPaint {
  /** The SVG paint value: a colour, 'none', or url(#<gradient id>). */
  value: string
  opacity?: number
  /** The gradient `value` refers to, when it refers to one. */
  gradient?: DrawGradientDef
}

/**
 * A paint as an SVG paint value plus, for a gradient, its definition.
 * Gradients are declared in objectBoundingBox units so one definition scales to
 * whatever shape references it.
 */
export function svgPaint(paint: DrawPaint | undefined, idHint: string): DrawSvgPaint {
  if (!paint || paint.type === 'none') return { value: 'none' }
  if (paint.type === 'solid') {
    const color = safeCssColor(paint.color, undefined)
    if (!color) return { value: 'none' }
    return { value: color, ...(isNum(paint.opacity) ? { opacity: Math.max(0, Math.min(1, paint.opacity)) } : {}) }
  }
  if (paint.type !== 'linear' && paint.type !== 'radial') return { value: 'none' }
  const id = gradientId(idHint)
  const stops: DrawGradientStopDef[] = (Array.isArray(paint.stops) ? paint.stops : []).map((s) => ({
    offset: `${fixed(s.offset * 100, 2)}%`,
    color: safeCssColor(s.color, '#000000'),
    ...(isNum(s.opacity) ? { opacity: num(Math.max(0, Math.min(1, s.opacity))) } : {})
  }))
  if (paint.type === 'linear') {
    // Angle 0 points right; rotate the unit vector into objectBoundingBox coords.
    const rad = ((isNum(paint.angle) ? paint.angle : 0) * Math.PI) / 180
    const dx = Math.cos(rad) / 2
    const dy = Math.sin(rad) / 2
    return {
      value: `url(#${id})`,
      gradient: { kind: 'linear', id, x1: fixed(0.5 - dx, 4), y1: fixed(0.5 - dy, 4), x2: fixed(0.5 + dx, 4), y2: fixed(0.5 + dy, 4), stops }
    }
  }
  return { value: `url(#${id})`, gradient: { kind: 'radial', id, stops } }
}

/** A gradient definition as SVG markup, every value escaped. */
export function gradientToSvg(g: DrawGradientDef): string {
  const stops = g.stops
    .map(
      (s) =>
        `<stop offset="${esc(s.offset)}" stop-color="${esc(s.color)}"${s.opacity != null ? ` stop-opacity="${esc(s.opacity)}"` : ''}/>`
    )
    .join('')
  if (g.kind === 'linear') {
    return `<linearGradient id="${esc(g.id)}" x1="${esc(g.x1 ?? '0')}" y1="${esc(g.y1 ?? '0.5')}" x2="${esc(g.x2 ?? '1')}" y2="${esc(g.y2 ?? '0.5')}">${stops}</linearGradient>`
  }
  const focal = g.fx != null && g.fy != null ? ` fx="${esc(g.fx)}" fy="${esc(g.fy)}"` : ''
  return `<radialGradient id="${esc(g.id)}" cx="${esc(g.cx ?? '0.5')}" cy="${esc(g.cy ?? '0.5')}" r="${esc(g.r ?? '0.5')}"${focal}>${stops}</radialGradient>`
}

/**
 * Every gradient an object's paints need, fill first then stroke -- the same
 * ids the object's own paint references use. The editor collects these BEFORE
 * rendering the objects, so the <defs> exist when the shapes point at them.
 */
export function objectGradients(o: DrawObject): DrawGradientDef[] {
  // A widget has no paint of its own, like an image: it draws itself. An
  // opaque object is never drawn at all.
  if (o.hidden || o.type === 'image' || o.type === 'widget' || o.type === 'opaque') return []
  const out: DrawGradientDef[] = []
  const f = svgPaint(o.fill, o.id).gradient
  if (f) out.push(f)
  if (o.stroke) {
    const s = svgPaint(o.stroke.paint, `${o.id}-s`).gradient
    if (s) out.push(s)
  }
  return out
}

/**
 * A paint as an SVG paint value, appending any gradient it needs to `defs` as
 * markup. The string-building twin of svgPaint, for the exporter.
 */
export function paintToSvg(paint: DrawPaint | undefined, defs: string[], idHint: string): { value: string; opacity?: number } {
  const p = svgPaint(paint, idHint)
  if (p.gradient) defs.push(gradientToSvg(p.gradient))
  return { value: p.value, ...(p.opacity != null ? { opacity: p.opacity } : {}) }
}

/** The CSS value for a paint, for on-screen surfaces that are not SVG. */
export function paintToCss(paint: DrawPaint | undefined): string {
  if (!paint || paint.type === 'none') return 'transparent'
  if (paint.type === 'solid') return safeCssColor(paint.color, 'transparent')
  const stops = paint.stops.map((s) => `${safeCssColor(s.color, '#000000')} ${fixed(s.offset * 100, 1)}%`).join(', ')
  if (paint.type === 'linear') return `linear-gradient(${num((isNum(paint.angle) ? paint.angle : 0) + 90)}deg, ${stops})`
  return `radial-gradient(circle at 50% 50%, ${stops})`
}

const STROKE_CAPS = new Set(['butt', 'round', 'square'])
const STROKE_JOINS = new Set(['miter', 'round', 'bevel'])

function strokeAttrs(stroke: DrawStroke | undefined, defs: string[], idHint: string): string {
  if (!stroke) return ''
  const p = paintToSvg(stroke.paint, defs, `${idHint}-s`)
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

function objectStyle(o: DrawObject): string {
  const bits: string[] = []
  if (isNum(o.opacity) && o.opacity < 1) bits.push(`opacity:${num(o.opacity)}`)
  if (blendOk(o.blend) && o.blend !== 'normal') bits.push(`mix-blend-mode:${o.blend}`)
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
      `<path d="${esc(d)}" fill="${esc(f.value)}"` +
      (f.opacity != null ? ` fill-opacity="${num(f.opacity)}"` : '') +
      (o.path.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '') +
      strokeAttrs(o.stroke, defs, o.id) +
      objectStyle(o) +
      '/>'
    )
  }
  if (o.type === 'image') {
    // Only embedded image bytes are ever written out (see isDrawImageSrc); an
    // image pointing anywhere else is left out of the file, not linked to.
    if (!isDrawImageSrc(o.src)) return ''
    const rot = isNum(o.rotation) && o.rotation ? ` transform="rotate(${num(o.rotation)} ${num(o.x + o.w / 2)} ${num(o.y + o.h / 2)})"` : ''
    return `<image href="${esc(o.src)}" x="${num(o.x)}" y="${num(o.y)}" width="${num(o.w)}" height="${num(o.h)}" preserveAspectRatio="none"${rot}${objectStyle(o)}/>`
  }
  if (o.type === 'widget') {
    // OMITTED FROM THE EXPORT, deliberately. A work widget is live: it
    // renders from a file that keeps changing, and SVG has no way to carry
    // that. Drawing a box where it sat would put something in the file that
    // looks like the widget and is not — a snapshot that is wrong the moment
    // the widget is edited. The same reasoning as the image branch above,
    // which leaves out anything it cannot embed rather than linking to it.
    return ''
  }
  // Something a newer PlexiiDraw made: never written as markup by this build.
  if (o.type === 'opaque') return ''
  const f = paintToSvg(o.fill, defs, o.id)
  const lh = (o.lineHeight ?? 1.2) * o.fontSize
  const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start'
  const ax = o.align === 'center' ? o.x + o.w / 2 : o.align === 'right' ? o.x + o.w : o.x
  // Prefer the editor's measured breaks; estimateWrap is only the fallback for
  // text no editor has ever laid out.
  const lines = o.lines && o.lines.length ? o.lines : estimateWrap(String(o.text ?? ''), o.w, o.fontSize, o.letterSpacing ?? 0)
  const tspans = lines
    .map((l, i) => `<tspan x="${num(ax)}" y="${fixed(o.y + o.fontSize + i * lh, 2)}">${esc(String(l)) || ' '}</tspan>`)
    .join('')
  const rot = isNum(o.rotation) && o.rotation ? ` transform="rotate(${num(o.rotation)} ${num(o.x + o.w / 2)} ${num(o.y)})"` : ''
  return (
    `<text font-family="${esc(o.fontFamily ?? 'Inter, system-ui, sans-serif')}" font-size="${num(o.fontSize)}"` +
    (isNum(o.fontWeight) && o.fontWeight ? ` font-weight="${num(o.fontWeight)}"` : '') +
    (o.italic ? ' font-style="italic"' : '') +
    (isNum(o.letterSpacing) && o.letterSpacing ? ` letter-spacing="${num(o.letterSpacing)}"` : '') +
    ` text-anchor="${anchor}" fill="${esc(f.value)}"` +
    (f.opacity != null ? ` fill-opacity="${num(f.opacity)}"` : '') +
    strokeAttrs(o.stroke, defs, o.id) +
    rot +
    objectStyle(o) +
    `>${tspans}</text>`
  )
}

function layerStyle(l: DrawLayer): string {
  const bits: string[] = []
  if (isNum(l.opacity) && l.opacity < 1) bits.push(`opacity:${num(l.opacity)}`)
  if (blendOk(l.blend) && l.blend !== 'normal') bits.push(`mix-blend-mode:${l.blend}`)
  return bits.length ? ` style="${bits.join(';')}"` : ''
}

/**
 * The whole document as one standalone SVG. Raster layers ride along as
 * embedded <image> elements, so a mixed vector/paint document survives the
 * round trip into any other tool with its painted pixels intact.
 */
export function drawToSvg(body: DrawBody): string {
  const defs: string[] = []
  const w = num(body.width)
  const h = num(body.height)
  const layers = body.layers
    .filter((l) => l.visible)
    .map((l) => {
      if (l.kind === 'raster') {
        if (!isDrawImageSrc(l.src)) return ''
        return `<g${layerStyle(l)}><image href="${esc(l.src)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none"/></g>`
      }
      const objs = l.objects.map((o) => objectSvg(o, defs)).join('')
      if (!objs) return ''
      return `<g${layerStyle(l)}>${objs}</g>`
    })
    .join('')
  const bgPaint = paintToSvg(body.background, defs, 'bg')
  const bg = bgPaint.value === 'none' ? '' : `<rect x="0" y="0" width="${w}" height="${h}" fill="${esc(bgPaint.value)}"/>`
  const defsBlock = defs.length ? `<defs>${defs.join('')}</defs>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `${defsBlock}${bg}${layers}</svg>`
  )
}

/**
 * A standalone HTML page wrapping the SVG, for the offscreen PNG/PDF capture.
 *
 * By default the page is the artboard's pixel size. `cssSize` lays the same
 * vector drawing out at a different CSS size instead -- how the PDF export
 * gives the page its physical size from the document's dpi without
 * rasterising anything (the SVG's viewBox scales the vectors).
 */
export function drawToHtml(body: DrawBody, cssSize?: { w: number; h: number }): string {
  const transparent = body.background.type === 'none'
  const w = cssSize ? cssSize.w : body.width
  const h = cssSize ? cssSize.h : body.height
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{width:${num(w)}px;height:${num(h)}px;background:${transparent ? 'transparent' : 'none'}}` +
    (cssSize ? `svg{display:block;width:${num(w)}px;height:${num(h)}px}` : '') +
    `</style></head>` +
    `<body>${drawToSvg(body)}</body></html>`
  )
}

/** CSS reference pixels per inch -- what a document with no stored dpi has always been exported at. */
export const CSS_DPI = 96

/** The resolution a document declares, falling back to CSS's 96 for documents that never stored one. */
export function drawDpi(body: { dpi?: number }): number {
  return typeof body.dpi === 'number' && Number.isFinite(body.dpi) && body.dpi > 0 ? body.dpi : CSS_DPI
}
