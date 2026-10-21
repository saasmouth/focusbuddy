// Untrusted JSON -> a valid v2 document.
//
// The same funnel as v1's normalizeDrawBody, widened to v2: every id matches
// DRAW_ID_PATTERN, every colour passes the CSS colour check, every number is
// finite and in range, every image is embedded bytes in the asset store. A
// v1 body is normalised as v1 and then migrated, so the two paths can never
// disagree about a v1 drawing.
//
// FORWARD COMPATIBILITY. This reader understands schema 2. Anything newer
// still loads -- shown, never saved (see drawDocCompatibility) -- and nothing
// it does not understand is dropped:
//   - an unknown node type becomes an opaque node holding the original JSON;
//   - an unknown FIELD on a node, layer, artboard or the document is kept
//     verbatim (never rendered), so an optional field a newer build adds
//     survives an edit by this one;
//   - an unknown effect kind is kept verbatim and makes the document read-only.

import {
  DRAW_ID_PATTERN,
  DRAW_SCHEMA_VERSION,
  drawId,
  isDrawImageSrc,
  isSafeDrawId,
  normDrawBlend,
  normDrawPaint,
  normDrawPath,
  normDrawStroke,
  normalizeDrawBody,
  unit01,
  type DrawPaint,
  type DrawShapeKind
} from '../draw'
import { safeCssColor } from '../cssColor'
import { putAsset } from './assets'
import { isNum } from './markup'
import { v1ToV2 } from './migrate'
import {
  DRAW_DOC_VERSION,
  DRAW_NODE_TYPES,
  type DrawAppearance,
  type DrawArtboard,
  type DrawAsset,
  type DrawDoc,
  type DrawDocLayer,
  type DrawDocPaint,
  type DrawDocStroke,
  type DrawEffect,
  type DrawGuide,
  type DrawNode,
  type DrawSettings,
  type DrawSwatch,
  type DrawUnits,
  type Matrix
} from './model'
import { MAX_GROUP_DEPTH } from './tree'
import { fieldHook, type DrawFieldScope } from './fieldHooks'

export { registerDrawField, unregisterDrawField, type DrawFieldHook, type DrawFieldScope } from './fieldHooks'

type Raw = Record<string, unknown>

function obj(v: unknown): Raw | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

// ── Field hooks ──────────────────────────────────────────────────────────────

// Packages register normalisers for fields they add (see fieldHooks.ts). Every
// file in ./fields/ is loaded here, so those hooks are in place wherever a
// drawing is normalised -- renderer, main process, tests -- without anyone
// importing them by name.
import.meta.glob('./fields/*.ts', { eager: true })

/**
 * The keys of `o` that `known` does not list: hooked ones normalised by their
 * hook (dropped when it says undefined), the rest kept verbatim.
 */
function extras(o: Raw, known: readonly string[], scope?: DrawFieldScope): Raw {
  const out: Raw = {}
  for (const k of Object.keys(o)) {
    if (known.includes(k)) continue
    const hook = scope ? fieldHook(scope, k) : undefined
    if (!hook) {
      out[k] = o[k]
      continue
    }
    const v = hook(o[k])
    if (v !== undefined) out[k] = v
  }
  return out
}

function clampDim(n: unknown, dflt: number): number {
  const v = isNum(n) ? Math.round(n) : dflt
  return Math.max(16, Math.min(12000, v))
}

function safeId(v: unknown, prefix: string): string {
  return isSafeDrawId(v) ? v : drawId(prefix)
}

function matrix(v: unknown): Matrix | undefined {
  return Array.isArray(v) && v.length === 6 && v.every(isNum) ? (v.slice() as Matrix) : undefined
}

function pt(v: unknown): { x: number; y: number } | undefined {
  const o = obj(v)
  return o && isNum(o.x) && isNum(o.y) ? { x: o.x, y: o.y } : undefined
}

// ── Paint ────────────────────────────────────────────────────────────────────

/** v1's paint rules, plus swatch references and gradient endpoints. */
function normPaint(v: unknown, dflt: DrawDocPaint): DrawDocPaint {
  const p = obj(v)
  if (!p) return dflt
  if (p.type === 'swatch') {
    if (!isSafeDrawId(p.id)) return dflt
    return { type: 'swatch', id: p.id, ...(isNum(p.tint) ? { tint: Math.max(0, Math.min(1, p.tint)) } : {}) }
  }
  const base = normDrawPaint(p, dflt as DrawPaint) as DrawDocPaint
  if (base.type === 'linear' && base !== dflt) {
    const from = pt(p.from)
    const to = pt(p.to)
    return { ...base, ...(from ? { from } : {}), ...(to ? { to } : {}) }
  }
  if (base.type === 'radial' && base !== dflt) {
    const center = pt(p.center)
    const focal = pt(p.focal)
    return { ...base, ...(center ? { center } : {}), ...(isNum(p.radius) ? { radius: Math.max(0, p.radius) } : {}), ...(focal ? { focal } : {}) }
  }
  return base
}

function normStroke(v: unknown): DrawDocStroke | undefined {
  const s = obj(v)
  if (!s) return undefined
  if (obj(s.paint)?.type === 'swatch') {
    // v1's stroke rules with the paint swapped for a swatch reference.
    const base = normDrawStroke({ ...s, paint: { type: 'solid', color: '#000000' } })
    if (!base) return undefined
    return { ...base, paint: normPaint(s.paint, { type: 'none' }) }
  }
  const base = normDrawStroke(s)
  if (!base) return undefined
  return { ...base, paint: normPaint(s.paint, base.paint as DrawDocPaint) }
}

// ── Appearance ───────────────────────────────────────────────────────────────

const EFFECT_NUM_RANGES: Record<string, [number, number]> = {
  dx: [-10000, 10000],
  dy: [-10000, 10000],
  blur: [0, 1000],
  spread: [-1000, 1000],
  opacity: [0, 1],
  radius: [0, 1000],
  offset: [-1000, 1000],
  miter: [1, 100],
  size: [0, 1000],
  detail: [0, 1000],
  ridges: [0, 1000],
  copies: [0, 500],
  seed: [0, 2 ** 31]
}

function clampNum(v: unknown, key: string, dflt: number): number {
  const [lo, hi] = EFFECT_NUM_RANGES[key] ?? [-1e6, 1e6]
  return isNum(v) ? Math.max(lo, Math.min(hi, v)) : dflt
}

/** One effect from the closed vocabulary, or the original JSON for a kind this build does not know. */
function normEffect(v: unknown): DrawEffect | null {
  const e = obj(v)
  if (!e || typeof e.kind !== 'string') return null
  const base = { id: safeId(e.id, 'fx'), ...(e.enabled === false ? { enabled: false } : {}) }
  const color = (): string => safeCssColor(e.color, '#000000')
  switch (e.kind) {
    case 'dropShadow':
      return { ...base, kind: 'dropShadow', dx: clampNum(e.dx, 'dx', 0), dy: clampNum(e.dy, 'dy', 4), blur: clampNum(e.blur, 'blur', 4), color: color(), opacity: clampNum(e.opacity, 'opacity', 0.5), ...(isNum(e.spread) ? { spread: clampNum(e.spread, 'spread', 0) } : {}) }
    case 'innerGlow':
    case 'outerGlow':
      return { ...base, kind: e.kind, blur: clampNum(e.blur, 'blur', 4), color: color(), opacity: clampNum(e.opacity, 'opacity', 0.75) }
    case 'blur':
    case 'feather':
    case 'roundCorners':
      return { ...base, kind: e.kind, radius: clampNum(e.radius, 'radius', 4) }
    case 'offsetPath':
      return { ...base, kind: 'offsetPath', offset: clampNum(e.offset, 'offset', 4), join: e.join === 'round' || e.join === 'bevel' ? e.join : 'miter', miter: clampNum(e.miter, 'miter', 4) }
    case 'roughen':
      return { ...base, kind: 'roughen', size: clampNum(e.size, 'size', 5), detail: clampNum(e.detail, 'detail', 10), smooth: e.smooth === true, ...(isNum(e.seed) ? { seed: Math.round(clampNum(e.seed, 'seed', 0)) } : {}) }
    case 'zigzag':
      return { ...base, kind: 'zigzag', size: clampNum(e.size, 'size', 5), ridges: Math.round(clampNum(e.ridges, 'ridges', 4)), smooth: e.smooth === true }
    case 'transform': {
      const m = matrix(e.m)
      return m ? { ...base, kind: 'transform', m, copies: Math.round(clampNum(e.copies, 'copies', 0)) } : null
    }
    default:
      // A newer effect: kept verbatim (never rendered), and the document opens
      // read-only (drawDocCompatibility), so nothing edits around it.
      return e as unknown as DrawEffect
  }
}

function normAppearance(v: unknown): DrawAppearance | undefined {
  const a = obj(v)
  if (!a) return undefined
  const fills = arr(a.fills)
    .map((f) => {
      const o = obj(f)
      if (!o) return null
      return {
        id: safeId(o.id, 'fill'),
        paint: normPaint(o.paint, { type: 'none' }),
        ...(isNum(o.opacity) ? { opacity: unit01(o.opacity, 1) } : {}),
        ...(o.blend ? { blend: normDrawBlend(o.blend) } : {}),
        ...(o.enabled === false ? { enabled: false } : {})
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  const strokes = arr(a.strokes)
    .map((s) => {
      const o = obj(s)
      const stroke = o ? normStroke(o.stroke) : undefined
      if (!o || !stroke) return null
      return {
        id: safeId(o.id, 'stroke'),
        stroke,
        ...(isNum(o.opacity) ? { opacity: unit01(o.opacity, 1) } : {}),
        ...(o.blend ? { blend: normDrawBlend(o.blend) } : {}),
        ...(o.enabled === false ? { enabled: false } : {})
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  const effects = arr(a.effects)
    .map(normEffect)
    .filter((x): x is DrawEffect => x !== null)
  return { fills, strokes, effects }
}

// ── Nodes ────────────────────────────────────────────────────────────────────

const SHAPE_KINDS: readonly DrawShapeKind[] = ['rect', 'roundRect', 'ellipse', 'polygon', 'star', 'line', 'pencil', 'pen', 'path']
const BASE_KEYS = ['id', 'type', 'name', 'opacity', 'blend', 'locked', 'hidden', 'appearance']
const KNOWN_KEYS: Record<string, readonly string[]> = {
  path: [...BASE_KEYS, 'path', 'fill', 'stroke', 'shapeKind', 'cornerRadius', 'sides', 'innerRatio'],
  text: [...BASE_KEYS, 'x', 'y', 'w', 'rotation', 'transform', 'text', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'align', 'lineHeight', 'letterSpacing', 'fill', 'stroke', 'lines'],
  image: [...BASE_KEYS, 'x', 'y', 'w', 'h', 'rotation', 'transform', 'assetId', 'src', 'alt'],
  widget: [...BASE_KEYS, 'x', 'y', 'w', 'h', 'rotation', 'transform', 'widgetId'],
  group: [...BASE_KEYS, 'children', 'clip', 'transform']
}

/** Mutable state threaded through one normalisation: the asset store being built. */
interface Ctx {
  assets: Record<string, DrawAsset>
}

function normNode(v: unknown, ctx: Ctx, depth: number): DrawNode | null {
  const o = obj(v)
  if (!o) return null
  const id = safeId(o.id, 'obj')
  const type = o.type === undefined ? 'path' : o.type
  if (type === 'opaque' && obj(o.raw) && typeof o.originalType === 'string') {
    return { id, type: 'opaque', originalType: o.originalType, raw: o.raw as Raw }
  }
  if (typeof type !== 'string' || !(DRAW_NODE_TYPES as readonly string[]).includes(type)) {
    return { id, type: 'opaque', originalType: String(type), raw: o }
  }
  const keep = extras(o, KNOWN_KEYS[type], 'node')
  const appearance = normAppearance(o.appearance)
  const shared = {
    ...keep,
    id,
    ...(typeof o.name === 'string' ? { name: o.name } : {}),
    ...(typeof o.opacity === 'number' ? { opacity: unit01(o.opacity, 1) } : {}),
    ...(o.blend ? { blend: normDrawBlend(o.blend) } : {}),
    ...(o.locked === true ? { locked: true } : {}),
    ...(o.hidden === true ? { hidden: true } : {}),
    ...(appearance ? { appearance } : {})
  }
  const transform = matrix(o.transform)
  const frame = {
    x: isNum(o.x) ? o.x : 0,
    y: isNum(o.y) ? o.y : 0,
    ...(isNum(o.rotation) ? { rotation: o.rotation } : {}),
    ...(transform ? { transform } : {})
  }
  if (type === 'group') {
    if (depth >= MAX_GROUP_DEPTH) return null
    const children = arr(o.children)
      .map((c) => normNode(c, ctx, depth + 1))
      .filter((c): c is DrawNode => c !== null)
    return { ...shared, type: 'group', children, ...(o.clip === true ? { clip: true } : {}), ...(transform ? { transform } : {}) }
  }
  if (type === 'text') {
    const stroke = normStroke(o.stroke)
    return {
      ...shared,
      type: 'text',
      ...frame,
      w: isNum(o.w) ? Math.max(8, o.w) : 200,
      text: typeof o.text === 'string' ? o.text : '',
      fontSize: isNum(o.fontSize) ? Math.max(1, o.fontSize) : 48,
      ...(typeof o.fontFamily === 'string' ? { fontFamily: o.fontFamily } : {}),
      ...(isNum(o.fontWeight) ? { fontWeight: o.fontWeight } : {}),
      ...(o.italic === true ? { italic: true } : {}),
      ...(o.align === 'center' || o.align === 'right' ? { align: o.align } : {}),
      ...(isNum(o.lineHeight) ? { lineHeight: o.lineHeight } : {}),
      ...(isNum(o.letterSpacing) ? { letterSpacing: o.letterSpacing } : {}),
      ...(Array.isArray(o.lines) ? { lines: o.lines.filter((l): l is string => typeof l === 'string') } : {}),
      fill: normPaint(o.fill, { type: 'solid', color: '#1c1917' }),
      ...(stroke ? { stroke } : {})
    }
  }
  if (type === 'image') {
    // The bytes must be in the asset store (or, from a hand-built body, inline:
    // moved into the store here). Anything else is dropped, as in v1.
    let assetId: string | undefined
    if (typeof o.assetId === 'string' && Object.prototype.hasOwnProperty.call(ctx.assets, o.assetId)) assetId = o.assetId
    else if (isDrawImageSrc(o.src)) {
      const put = putAsset(ctx.assets, o.src)
      ctx.assets = put.assets
      assetId = put.id
    }
    if (!assetId) return null
    return {
      ...shared,
      type: 'image',
      ...frame,
      w: isNum(o.w) ? Math.max(1, o.w) : 200,
      h: isNum(o.h) ? Math.max(1, o.h) : 200,
      assetId,
      ...(typeof o.alt === 'string' ? { alt: o.alt } : {})
    }
  }
  if (type === 'widget') {
    if (typeof o.widgetId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(o.widgetId)) return null
    return { ...shared, type: 'widget', ...frame, w: isNum(o.w) ? Math.max(1, o.w) : 320, h: isNum(o.h) ? Math.max(1, o.h) : 240, widgetId: o.widgetId }
  }
  const path = normDrawPath(o.path)
  if (path.subpaths.length === 0) return null
  const stroke = normStroke(o.stroke)
  return {
    ...shared,
    type: 'path',
    path,
    fill: normPaint(o.fill, { type: 'none' }),
    ...(stroke ? { stroke } : {}),
    ...(typeof o.shapeKind === 'string' && (SHAPE_KINDS as readonly string[]).includes(o.shapeKind) ? { shapeKind: o.shapeKind as DrawShapeKind } : {}),
    ...(isNum(o.cornerRadius) ? { cornerRadius: o.cornerRadius } : {}),
    ...(isNum(o.sides) ? { sides: o.sides } : {}),
    ...(isNum(o.innerRatio) ? { innerRatio: o.innerRatio } : {})
  }
}

// ── Document ─────────────────────────────────────────────────────────────────

const LAYER_KEYS = ['id', 'kind', 'name', 'visible', 'locked', 'opacity', 'blend', 'objects', 'assetId', 'src', 'color', 'template']
const ARTBOARD_KEYS = ['id', 'name', 'x', 'y', 'w', 'h', 'background', 'presetId']
const DOC_KEYS = ['schemaVersion', 'minWriterVersion', 'artboards', 'activeArtboardId', 'layers', 'activeLayerId', 'assets', 'swatches', 'guides', 'settings']
const UNITS: readonly DrawUnits[] = ['px', 'pt', 'mm', 'in', 'pc']

function normAssets(v: unknown): Record<string, DrawAsset> {
  const out: Record<string, DrawAsset> = {}
  const o = obj(v)
  if (!o) return out
  for (const [id, a] of Object.entries(o)) {
    const e = obj(a)
    if (!DRAW_ID_PATTERN.test(id) || !e || !isDrawImageSrc(e.dataUrl)) continue
    out[id] = {
      mime: typeof e.mime === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(e.mime) ? e.mime : 'application/octet-stream',
      dataUrl: e.dataUrl,
      ...(isNum(e.w) && isNum(e.h) && e.w > 0 && e.h > 0 ? { w: Math.round(e.w), h: Math.round(e.h) } : {})
    }
  }
  return out
}

function normLayer(v: unknown, index: number, ctx: Ctx): DrawDocLayer {
  const l = obj(v) ?? {}
  const base = {
    ...extras(l, LAYER_KEYS, 'layer'),
    id: safeId(l.id, 'lyr'),
    name: typeof l.name === 'string' && l.name ? l.name : `Layer ${index + 1}`,
    visible: l.visible !== false,
    locked: l.locked === true,
    opacity: unit01(l.opacity, 1),
    blend: normDrawBlend(l.blend)
  }
  if (l.kind === 'raster') {
    let assetId: string | undefined
    if (typeof l.assetId === 'string' && Object.prototype.hasOwnProperty.call(ctx.assets, l.assetId)) assetId = l.assetId
    else if (isDrawImageSrc(l.src)) {
      const put = putAsset(ctx.assets, l.src)
      ctx.assets = put.assets
      assetId = put.id
    }
    return { ...base, kind: 'raster', ...(assetId ? { assetId } : {}) }
  }
  const objects = arr(l.objects)
    .map((o) => normNode(o, ctx, 0))
    .filter((o): o is DrawNode => o !== null)
  const color = typeof l.color === 'string' ? safeCssColor(l.color, undefined) : undefined
  return { ...base, kind: 'vector', objects, ...(color ? { color } : {}), ...(l.template === true ? { template: true } : {}) }
}

function normArtboard(v: unknown, i: number): DrawArtboard | null {
  const a = obj(v)
  if (!a) return null
  return {
    ...extras(a, ARTBOARD_KEYS, 'artboard'),
    id: safeId(a.id, 'artboard'),
    name: typeof a.name === 'string' && a.name ? a.name : `Artboard ${i + 1}`,
    x: isNum(a.x) ? a.x : 0,
    y: isNum(a.y) ? a.y : 0,
    w: clampDim(a.w, 1920),
    h: clampDim(a.h, 1080),
    background: normPaint(a.background, { type: 'solid', color: '#ffffff' }),
    ...(typeof a.presetId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(a.presetId) ? { presetId: a.presetId } : {})
  }
}

function normSwatch(v: unknown): DrawSwatch | null {
  const s = obj(v)
  const color = s ? safeCssColor(s.color, undefined) : undefined
  if (!s || !color) return null
  return {
    id: safeId(s.id, 'swatch'),
    name: typeof s.name === 'string' ? s.name.slice(0, 200) : '',
    color,
    ...(s.global === true ? { global: true } : {}),
    ...(s.spot === true ? { spot: true } : {}),
    ...(typeof s.group === 'string' ? { group: s.group.slice(0, 200) } : {})
  }
}

function normGuide(v: unknown): DrawGuide | null {
  const g = obj(v)
  if (!g || (g.axis !== 'x' && g.axis !== 'y') || !isNum(g.at)) return null
  return {
    id: safeId(g.id, 'guide'),
    axis: g.axis,
    at: g.at,
    ...(isSafeDrawId(g.artboardId) ? { artboardId: g.artboardId } : {}),
    ...(g.locked === true ? { locked: true } : {})
  }
}

function normSettings(v: unknown): DrawSettings {
  const s = obj(v) ?? {}
  const grid = obj(s.grid)
  const snap = obj(s.snap)
  return {
    ...(isNum(s.dpi) && s.dpi > 0 ? { dpi: Math.round(s.dpi) } : {}),
    ...(typeof s.units === 'string' && (UNITS as readonly string[]).includes(s.units) ? { units: s.units as DrawUnits } : {}),
    ...(grid && isNum(grid.size) && grid.size > 0 ? { grid: { size: grid.size, subdivisions: isNum(grid.subdivisions) && grid.subdivisions >= 1 ? Math.round(grid.subdivisions) : 1 } } : {}),
    ...(snap ? { snap: isNum(snap.tolerance) && snap.tolerance >= 0 ? { tolerance: snap.tolerance } : {} } : {}),
    ...(isNum(s.keyIncrement) && s.keyIncrement > 0 ? { keyIncrement: s.keyIncrement } : {})
  }
}

function normV2(r: Raw): DrawDoc {
  const ctx: Ctx = { assets: normAssets(r.assets) }
  const layers = arr(r.layers).map((l, i) => normLayer(l, i, ctx))
  if (layers.length === 0) layers.push({ id: drawId('lyr'), kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] })
  const artboards = arr(r.artboards)
    .map(normArtboard)
    .filter((a): a is DrawArtboard => a !== null)
  if (artboards.length === 0) artboards.push({ id: drawId('artboard'), name: 'Artboard 1', x: 0, y: 0, w: 1920, h: 1080, background: { type: 'solid', color: '#ffffff' } })
  const activeLayerId = typeof r.activeLayerId === 'string' && layers.some((l) => l.id === r.activeLayerId) ? r.activeLayerId : layers[layers.length - 1].id
  const activeArtboardId = typeof r.activeArtboardId === 'string' && artboards.some((a) => a.id === r.activeArtboardId) ? r.activeArtboardId : undefined
  const declaredMin = isNum(r.minWriterVersion) ? Math.floor(r.minWriterVersion) : DRAW_DOC_VERSION
  return {
    ...(extras(r, DOC_KEYS, 'doc') as object),
    schemaVersion: 2,
    minWriterVersion: Math.max(DRAW_DOC_VERSION, declaredMin),
    artboards,
    ...(activeArtboardId ? { activeArtboardId } : {}),
    layers,
    activeLayerId,
    assets: ctx.assets,
    swatches: arr(r.swatches)
      .map(normSwatch)
      .filter((s): s is DrawSwatch => s !== null),
    guides: arr(r.guides)
      .map(normGuide)
      .filter((g): g is DrawGuide => g !== null),
    settings: normSettings(r.settings)
  }
}

/** The schema version a raw body declares (1 when it declares none). */
export function declaredSchema(raw: unknown): number {
  const v = obj(raw)?.schemaVersion
  return isNum(v) && v >= 1 ? Math.floor(v) : 1
}

/**
 * Anything loaded from disk or a peer, as a valid v2 document. A v1 body goes
 * through v1's own normaliser and then the migration, so v1 and v2 can never
 * disagree about a v1 drawing.
 */
export function normalizeDrawDoc(raw: unknown): DrawDoc {
  const r = obj(raw) ?? {}
  if (declaredSchema(r) <= DRAW_SCHEMA_VERSION && r.artboards === undefined) return v1ToV2(normalizeDrawBody(r))
  return normV2(r)
}
