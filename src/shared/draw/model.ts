// PlexiiDraw document model, schema v2.
//
// v1 (src/shared/draw.ts) is one artboard, flat layers of objects, and image
// bytes inline. v2 is the model every Illustrator-class feature builds on:
//
//   - several ARTBOARDS (v1's width/height/background become artboards[0]);
//   - GROUP nodes, optionally clipping (a clip group's topmost child clips the
//     rest, Illustrator's semantics);
//   - a general TRANSFORM on frame nodes and groups, for shear and reflect;
//   - an optional APPEARANCE stack (several fills and strokes) and a CLOSED
//     list of effects -- data only here; WP-APPEAR and WP-EFFECTS render them;
//   - document SWATCHES (global colours a paint can reference), GUIDES and
//     SETTINGS (units, grid, snapping, keyboard increment, dpi);
//   - an ASSET STORE: image and paint-layer bytes live once, under a content
//     hash, so undo snapshots, duplicates and co-editing carry ids, not
//     megabytes;
//   - OPAQUE nodes: anything a newer PlexiiDraw adds survives an older one
//     verbatim (see DrawOpaqueObject in draw.ts).
//
// Two deliberate departures from the ARCHITECTURE.md sketch, both made so an
// older app can still read a v2 drawing:
//
//   - A vector layer's list is still called `objects` (the sketch says
//     `children`). The guard release (schema 1 reader) then still SHOWS the
//     top-level art of a v2 drawing, read-only, instead of an empty canvas; and
//     every layer-level operation keeps its meaning. Groups nest their own
//     `children`.
//   - Frame nodes keep `rotation` in degrees about their pivot (the sketch
//     folds it into `transform`). A matrix cannot give back the exact degrees it
//     was built from, so folding would change the exported SVG of every rotated
//     v1 object by floating-point noise; keeping the number keeps v1 -> v2
//     byte-identical, and it is what a Transform panel shows anyway. `transform`
//     is the extra, general matrix, applied outside the rotation.

import type { DrawBlend, DrawGradientStop, DrawShapeKind } from '../draw'
import type { Box, DrawPath, Matrix, Pt } from '../drawGeometry'

export type { DrawBlend, DrawGradientStop, DrawShapeKind } from '../draw'
export type { Box, DrawPath, Matrix, Pt } from '../drawGeometry'

/** The schema this module reads and writes. */
export const DRAW_DOC_VERSION = 2

// ── Paint ────────────────────────────────────────────────────────────────────

export interface DrawSolidPaint {
  type: 'solid'
  color: string
  opacity?: number
}

export interface DrawLinearGradient {
  type: 'linear'
  stops: DrawGradientStop[]
  /** Degrees, 0 = left to right (the v1 meaning). Ignored when from/to are set. */
  angle?: number
  /** Endpoints in the object's bounding-box units (0..1), for the on-canvas gradient tool. */
  from?: Pt
  to?: Pt
}

export interface DrawRadialGradient {
  type: 'radial'
  stops: DrawGradientStop[]
  /** Bounding-box units. Absent = the centred circle v1 always drew. */
  center?: Pt
  radius?: number
  focal?: Pt
}

/** A reference to a document swatch: editing a GLOBAL swatch recolours every use. */
export interface DrawSwatchPaint {
  type: 'swatch'
  id: string
  /** 0..1 strength towards white (1 = the swatch itself). */
  tint?: number
}

export type DrawDocPaint = { type: 'none' } | DrawSolidPaint | DrawLinearGradient | DrawRadialGradient | DrawSwatchPaint

export interface DrawDocStroke {
  paint: DrawDocPaint
  width: number
  cap?: 'butt' | 'round' | 'square'
  join?: 'miter' | 'round' | 'bevel'
  dash?: number[]
  miterLimit?: number
}

// ── Appearance and effects ───────────────────────────────────────────────────

export interface DrawFillLayer {
  id: string
  paint: DrawDocPaint
  opacity?: number
  blend?: DrawBlend
  enabled?: boolean
}

export interface DrawStrokeLayer {
  id: string
  stroke: DrawDocStroke
  opacity?: number
  blend?: DrawBlend
  enabled?: boolean
}

interface EffectBase {
  id: string
  enabled?: boolean
}

/**
 * The CLOSED list of live effects. There is no "raw SVG filter" member and
 * there never will be: a shared drawing is untrusted input, and every effect
 * compiles from these numbers to markup PlexiiDraw writes itself.
 */
export type DrawEffect =
  | (EffectBase & { kind: 'dropShadow'; dx: number; dy: number; blur: number; color: string; opacity: number; spread?: number })
  | (EffectBase & { kind: 'innerGlow' | 'outerGlow'; blur: number; color: string; opacity: number })
  | (EffectBase & { kind: 'blur'; radius: number })
  | (EffectBase & { kind: 'feather'; radius: number })
  | (EffectBase & { kind: 'offsetPath'; offset: number; join: 'miter' | 'round' | 'bevel'; miter: number })
  | (EffectBase & { kind: 'roundCorners'; radius: number })
  | (EffectBase & { kind: 'roughen'; size: number; detail: number; smooth: boolean; seed?: number })
  | (EffectBase & { kind: 'zigzag'; size: number; ridges: number; smooth: boolean })
  | (EffectBase & { kind: 'transform'; m: Matrix; copies: number })

export const DRAW_EFFECT_KINDS = [
  'dropShadow',
  'innerGlow',
  'outerGlow',
  'blur',
  'feather',
  'offsetPath',
  'roundCorners',
  'roughen',
  'zigzag',
  'transform'
] as const

/**
 * Several fills and strokes, painted bottom-up in array order, then effects.
 * ABSENT means the node draws exactly as v1 did, from its own fill and stroke.
 */
export interface DrawAppearance {
  fills: DrawFillLayer[]
  strokes: DrawStrokeLayer[]
  effects: DrawEffect[]
}

// ── Nodes ────────────────────────────────────────────────────────────────────

export interface DrawNodeBase {
  id: string
  name?: string
  opacity?: number
  blend?: DrawBlend
  locked?: boolean
  hidden?: boolean
  appearance?: DrawAppearance
}

export interface DrawPathNode extends DrawNodeBase {
  type: 'path'
  path: DrawPath
  fill: DrawDocPaint
  stroke?: DrawDocStroke
  shapeKind?: DrawShapeKind
  cornerRadius?: number
  sides?: number
  innerRatio?: number
}

interface FrameBase extends DrawNodeBase {
  x: number
  y: number
  w: number
  /** Degrees about the node's pivot (see objectPivot in draw.ts). */
  rotation?: number
  /** An extra document-space matrix applied outside the rotation (shear, reflect). */
  transform?: Matrix
}

export interface DrawTextNode extends FrameBase {
  type: 'text'
  text: string
  fontFamily?: string
  fontSize: number
  fontWeight?: number
  italic?: boolean
  align?: 'left' | 'center' | 'right'
  lineHeight?: number
  letterSpacing?: number
  fill: DrawDocPaint
  stroke?: DrawDocStroke
  /** Measured line breaks, a renderer-maintained cache (see DrawTextObject). */
  lines?: string[]
}

export interface DrawImageNode extends FrameBase {
  type: 'image'
  h: number
  /** Key into DrawDoc.assets. The bytes live there, once. */
  assetId: string
  alt?: string
}

export interface DrawWidgetNode extends FrameBase {
  type: 'widget'
  h: number
  widgetId: string
}

export interface DrawGroupNode extends DrawNodeBase {
  type: 'group'
  /** Paint order: index 0 at the bottom, like layers. */
  children: DrawNode[]
  /** Clipping group: the TOPMOST child (the last) is the clip path for the rest. */
  clip?: boolean
  transform?: Matrix
}

/** Carried verbatim, never drawn or edited (see DrawOpaqueObject in draw.ts). */
export interface DrawOpaqueNode {
  id: string
  type: 'opaque'
  originalType: string
  raw: Record<string, unknown>
  name?: string
  opacity?: number
  blend?: DrawBlend
  locked?: boolean
  hidden?: boolean
}

export type DrawNode = DrawPathNode | DrawTextNode | DrawImageNode | DrawWidgetNode | DrawGroupNode | DrawOpaqueNode

/** Node kinds this build draws and edits. */
export const DRAW_NODE_TYPES = ['path', 'text', 'image', 'widget', 'group'] as const

// ── Layers ───────────────────────────────────────────────────────────────────

interface DrawDocLayerBase {
  id: string
  name: string
  visible: boolean
  locked: boolean
  opacity: number
  blend: DrawBlend
}

export interface DrawDocVectorLayer extends DrawDocLayerBase {
  kind: 'vector'
  objects: DrawNode[]
  /** Selection highlight colour for this layer's objects. */
  color?: string
  /** A template layer is shown dimmed, locked, and left out of export. */
  template?: boolean
}

export interface DrawDocRasterLayer extends DrawDocLayerBase {
  kind: 'raster'
  /** Key into DrawDoc.assets; absent for an empty layer. */
  assetId?: string
  /**
   * Where the layer's pixels lie, in document space: its picture is exactly
   * frame.w × frame.h pixels with its top-left at (frame.x, frame.y). Absent
   * means the first page at the origin (rasterFrame), as every drawing before
   * 4.3.41 has it. Written when the layer follows its artboard (moved,
   * resized or rearranged); see ops/artboards.ts.
   */
  frame?: Box
}

export type DrawDocLayer = DrawDocVectorLayer | DrawDocRasterLayer

// ── Document ─────────────────────────────────────────────────────────────────

export interface DrawArtboard {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** `{ type: 'none' }` is a genuinely transparent page, as in v1. */
  background: DrawDocPaint
  presetId?: string
}

/** Image bytes, stored once under a content hash (see assets.ts). */
export interface DrawAsset {
  /** e.g. image/png. */
  mime: string
  /** Embedded bytes only -- always passes isDrawImageSrc. */
  dataUrl: string
  /** Natural pixel size when known. */
  w?: number
  h?: number
}

export interface DrawSwatch {
  id: string
  name: string
  color: string
  /** A global swatch recolours every paint that references it when edited. */
  global?: boolean
  /** Spot colour flag. Output is still sRGB: print production is out of scope. */
  spot?: boolean
  /** Colour group this swatch belongs to. */
  group?: string
}

export interface DrawGuide {
  id: string
  axis: 'x' | 'y'
  /** Document-space position. */
  at: number
  /** Present when the guide belongs to one artboard rather than the pasteboard. */
  artboardId?: string
  locked?: boolean
}

export type DrawUnits = 'px' | 'pt' | 'mm' | 'in' | 'pc'

export interface DrawSettings {
  /** Logical px per inch, for export (was body.dpi in v1). */
  dpi?: number
  units?: DrawUnits
  grid?: { size: number; subdivisions: number }
  snap?: { tolerance?: number }
  /** Arrow-key nudge, in px. */
  keyIncrement?: number
}

export interface DrawDoc {
  schemaVersion: 2
  /** The oldest PlexiiDraw allowed to WRITE this body; older ones open it read-only. */
  minWriterVersion: number
  artboards: DrawArtboard[]
  activeArtboardId?: string
  /** Index 0 is the bottom of the stack, as in v1. */
  layers: DrawDocLayer[]
  activeLayerId?: string
  assets: Record<string, DrawAsset>
  swatches: DrawSwatch[]
  guides: DrawGuide[]
  settings: DrawSettings
}
