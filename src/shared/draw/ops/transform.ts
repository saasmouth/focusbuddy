// Affine transforms of v2 nodes: what the Transform panel, the Rotate,
// Reflect, Scale and Shear tools and dialogs, Free Transform, Transform Each
// and Transform Again all come down to. Pure functions over DrawDoc.
//
// How each kind of node takes a matrix M (document space):
//
//   - PATHS are re-baked (their anchors and handles go through M), as in
//     Illustrator. "Scale Strokes & Effects" multiplies the stroke width and
//     dashes by √|det M|. A live rectangle, rounded rectangle or ellipse stays
//     live under an axis-aligned M; a rounded rectangle is re-derived so its
//     corners keep their radius unless "Scale Corners" is on. Anything that a
//     live shape's parameters cannot describe (a rotation, a shear, a flipped
//     star) detaches it into a plain path -- the way an anchor edit does -- so a
//     later parameter change can never undo the transform.
//   - FRAMES (text, image, work widget) keep the clean fields where they can: a
//     move moves x/y, a turn-and-uniform-scale adds to `rotation` and resizes,
//     an axis-aligned scale of an unturned frame resizes it (text scales its
//     point size). Anything else (reflect, shear, a non-uniform scale of a
//     turned frame) goes into the frame's `transform` matrix -- which only a v2
//     drawing can hold, so callers check `needsFrameMatrix` first.
//   - GROUPS with a matrix take M into it; plain groups pass M to every member.
//   - OPAQUE nodes are never touched.

import { drawId, shapePath } from '../../draw'
import { applyMatrix, fitPathToBox, multiplyMatrix, transformPath, type Box, type Matrix, type Pt } from '../../drawGeometry'
import {
  about,
  compose,
  decompose,
  isAxisAligned,
  isTranslation,
  lengthScale,
  refPointOf,
  rotation as rotationMatrix,
  scaling,
  translation,
  type RefPoint
} from '../geometry/transform'
import type { DrawAppearance, DrawDoc, DrawDocPaint, DrawEffect, DrawDocStroke, DrawGroupNode, DrawImageNode, DrawNode, DrawPathNode, DrawTextNode, DrawWidgetNode } from '../model'
import { nodeBounds, nodePivot, scaleNode, translateNode } from './geometry'
import { editableIds } from './objects'
import { allPlaces, applyNodeMatrix, invertMatrix as invertNodeMatrix, isIdentityMatrix, parentMatrix } from './groups'

export interface TransformOptions {
  /** Multiply stroke widths and dashes by the transform's length scale (Illustrator: "Scale Strokes & Effects"). */
  scaleStrokes?: boolean
  /** Scale a live rounded rectangle's corner radius with it (Illustrator: "Scale Corners"). */
  scaleCorners?: boolean
  /**
   * Frames may take a general matrix (reflect, shear). Only a v2 drawing can
   * store one; without it a frame that needs one is left exactly as it was
   * (callers refuse the whole transform before that can happen).
   */
  frameMatrix?: boolean
}

type FrameNode = DrawTextNode | DrawImageNode | DrawWidgetNode

function isFrame(n: DrawNode): n is FrameNode {
  return n.type === 'text' || n.type === 'image' || n.type === 'widget'
}

const EPS = 1e-9

/** A turn plus a uniform positive scale, nothing else: what a frame's `rotation` and size can hold. */
function similarity(m: Matrix): { degrees: number; scale: number } | null {
  const d = decompose(m)
  if (d.scaleX <= EPS || d.scaleY <= EPS) return null
  if (Math.abs(d.skew) > 1e-7) return null
  if (Math.abs(d.scaleX - d.scaleY) > 1e-9 * Math.max(1, d.scaleX)) return null
  return { degrees: d.rotation, scale: d.scaleX }
}

function positiveAxisAligned(m: Matrix): boolean {
  return isAxisAligned(m) && m[0] > EPS && m[3] > EPS
}

/**
 * How a frame takes `m`: 'exact' (its own fields hold the result), 'approx'
 * (a non-uniform scale of a TURNED frame, which its fields can only
 * approximate the way the selection handles always have), or 'matrix' (only a
 * `transform` matrix can hold it).
 */
export function frameFit(n: FrameNode, m: Matrix): 'exact' | 'approx' | 'matrix' {
  if (n.transform) return 'matrix'
  if (isTranslation(m)) return 'exact'
  if (similarity(m)) return 'exact'
  if (positiveAxisAligned(m)) return n.rotation ? 'approx' : 'exact'
  return 'matrix'
}

/**
 * Would transforming this node by `m` need a frame matrix it does not already
 * have -- i.e. v2-only content? A group or a frame that already carries a
 * matrix is v2 already, so it never "needs" one newly.
 */
export function needsFrameMatrix(n: DrawNode, m: Matrix): boolean {
  if (n.type === 'group') return !n.transform && n.children.some((c) => needsFrameMatrix(c, m))
  if (!isFrame(n) || n.transform) return false
  return frameFit(n, m) === 'matrix'
}

function scaleStroke(s: DrawDocStroke | undefined, k: number): DrawDocStroke | undefined {
  if (!s || Math.abs(k - 1) < 1e-12) return s
  return { ...s, width: s.width * k, ...(s.dash ? { dash: s.dash.map((d) => d * k) } : {}) }
}

/**
 * A linear gradient set by angle lives in the object's bounding-box units, so
 * an axis-aligned scale leaves it alone; a flip mirrors it and a turn turns it
 * -- the gradient follows the art, as Illustrator's does.
 */
function transformPaint(p: DrawDocPaint, m: Matrix): DrawDocPaint {
  if (p.type !== 'linear' || p.from || p.to) return p
  const angle = p.angle ?? 0
  let next: number
  if (isAxisAligned(m)) {
    const r = (angle * Math.PI) / 180
    next = (Math.atan2(Math.sign(m[3]) * Math.sin(r), Math.sign(m[0]) * Math.cos(r)) * 180) / Math.PI
  } else {
    const r = (angle * Math.PI) / 180
    const v = applyMatrix([m[0], m[1], m[2], m[3], 0, 0], { x: Math.cos(r), y: Math.sin(r) })
    next = (Math.atan2(v.y, v.x) * 180) / Math.PI
  }
  next = Math.round(next * 1e9) / 1e9
  if (Math.abs(next - angle) < 1e-9) return p
  return { ...p, angle: Object.is(next, -0) ? 0 : next }
}

const KEEP_LIVE_FLIPPED = new Set(['rect', 'roundRect', 'ellipse'])
const LIVE = new Set(['rect', 'roundRect', 'ellipse', 'polygon', 'star', 'line'])

function detach(n: DrawPathNode): DrawPathNode {
  if (!n.shapeKind || !LIVE.has(n.shapeKind)) return n
  const { cornerRadius: _r, sides: _s, innerRatio: _i, ...rest } = n
  void _r
  void _s
  void _i
  return { ...rest, shapeKind: 'path' }
}

function transformPathNode(n: DrawPathNode, m: Matrix, opts: TransformOptions): DrawPathNode {
  const k = opts.scaleStrokes ? lengthScale(m) : 1
  let out: DrawPathNode = {
    ...n,
    path: transformPath(n.path, m),
    fill: transformPaint(n.fill, m),
    ...(n.stroke ? { stroke: scaleStroke({ ...n.stroke, paint: transformPaint(n.stroke.paint, m) }, k) } : {})
  }
  const kind = n.shapeKind
  if (!kind || !LIVE.has(kind)) return out
  const aligned = isAxisAligned(m)
  const flipped = m[0] < 0 || m[3] < 0
  if (!aligned || (flipped && !KEEP_LIVE_FLIPPED.has(kind))) return detach(out)
  if (kind === 'roundRect') {
    // Re-derive the outline so the corners are circular arcs of the right radius.
    const oldBox = nodeBounds(n)
    const r0 = n.cornerRadius ?? Math.min(oldBox.w, oldBox.h) * 0.15
    const r = opts.scaleCorners ? r0 * Math.sqrt(Math.abs(m[0] * m[3])) : r0
    const box = nodeBounds(out)
    out = { ...out, cornerRadius: r, path: fitPathToBox(shapePath('roundRect', box, { cornerRadius: r }), box) }
  }
  return out
}

/** A frame turned by `degrees` and scaled by `s` about `m`, kept in its own fields. */
function frameBySimilarity(n: FrameNode, m: Matrix, degrees: number, s: number, opts: TransformOptions): FrameNode {
  const pivot = applyMatrix(m, nodePivot(n))
  const rotation = (n.rotation ?? 0) + degrees
  const rot = Math.abs(rotation) < 1e-9 ? undefined : Math.round(rotation * 1e9) / 1e9
  const k = opts.scaleStrokes ? s : 1
  if (n.type === 'text') {
    const w = n.w * s
    const next: DrawTextNode = {
      ...n,
      x: pivot.x - w / 2,
      y: pivot.y,
      w,
      fontSize: n.fontSize * s,
      ...(n.letterSpacing ? { letterSpacing: n.letterSpacing * s } : {}),
      fill: transformPaint(n.fill, m),
      ...(n.stroke ? { stroke: scaleStroke(n.stroke, k) } : {})
    }
    if (rot === undefined) delete next.rotation
    else next.rotation = rot
    return next
  }
  const w = n.w * s
  const h = n.h * s
  const next = { ...n, x: pivot.x - w / 2, y: pivot.y - h / 2, w, h } as DrawImageNode | DrawWidgetNode
  if (rot === undefined) delete next.rotation
  else next.rotation = rot
  return next
}

function transformFrame(n: FrameNode, m: Matrix, opts: TransformOptions): DrawNode {
  if (isTranslation(m)) return translateNode(n, m[4], m[5])
  const fit = frameFit(n, m)
  if (fit === 'matrix') {
    if (!n.transform && !opts.frameMatrix) return n
    const withStroke = n.type === 'text' && n.stroke && opts.scaleStrokes ? { ...n, stroke: scaleStroke(n.stroke, lengthScale(m)) } : n
    return { ...withStroke, transform: n.transform ? multiplyMatrix(m, n.transform) : m }
  }
  const sim = similarity(m)
  if (sim) return frameBySimilarity(n, m, sim.degrees, sim.scale, opts)
  // Axis-aligned positive scale: the selection handles' own resize.
  const scaled = scaleNode(n, m[0], m[3], m[4], m[5]) as FrameNode
  if (scaled.type === 'text' && scaled.stroke && opts.scaleStrokes) return { ...scaled, stroke: scaleStroke(scaled.stroke, Math.sqrt(m[0] * m[3])) }
  return scaled
}

/** One node transformed by the document-space matrix `m` (see the header for each kind). */
export function transformNode(n: DrawNode, m: Matrix, opts: TransformOptions = {}): DrawNode {
  if (n.type === 'opaque') return n
  if (isTranslation(m) && Math.abs(m[4]) < 1e-12 && Math.abs(m[5]) < 1e-12) return n
  const out = transformNodeBody(n, m, opts)
  // "Scale Strokes & Effects" also scales the appearance stack's strokes and
  // every effect's distances. A matrix on the node scales them visually already.
  if (!opts.scaleStrokes || isTranslation(m) || out.type === 'opaque' || !out.appearance) return out
  if ((out.type === 'group' || out.type === 'text' || out.type === 'image' || out.type === 'widget') && out.transform) return out
  return { ...out, appearance: scaleAppearance(out.appearance, m) } as DrawNode
}

/** An appearance stack with stroke widths and effect distances scaled by the transform. */
export function scaleAppearance(a: DrawAppearance, m: Matrix): DrawAppearance {
  const k = lengthScale(m)
  if (Math.abs(k - 1) < 1e-12) return a
  const effects = a.effects.map((e): DrawEffect => {
    switch (e.kind) {
      case 'dropShadow': {
        const d = applyMatrix([m[0], m[1], m[2], m[3], 0, 0], { x: e.dx, y: e.dy })
        return { ...e, dx: d.x, dy: d.y, blur: e.blur * k, ...(e.spread !== undefined ? { spread: e.spread * k } : {}) }
      }
      case 'innerGlow':
      case 'outerGlow':
        return { ...e, blur: e.blur * k }
      case 'blur':
      case 'feather':
      case 'roundCorners':
        return { ...e, radius: e.radius * k }
      case 'offsetPath':
        return { ...e, offset: e.offset * k }
      case 'roughen':
      case 'zigzag':
        return { ...e, size: e.size * k }
      default:
        return e
    }
  })
  return { ...a, strokes: a.strokes.map((l) => ({ ...l, stroke: scaleStroke(l.stroke, k)! })), effects }
}

function transformNodeBody(n: Exclude<DrawNode, { type: 'opaque' }>, m: Matrix, opts: TransformOptions): DrawNode {
  if (n.type === 'path') return transformPathNode(n, m, opts)
  if (n.type === 'group') {
    if (n.transform) return { ...n, transform: multiplyMatrix(m, n.transform) }
    // Members are already v2 content (a group is), so they may take matrices.
    return { ...n, children: n.children.map((c) => transformNode(c, m, { ...opts, frameMatrix: true })) } as DrawGroupNode
  }
  return transformFrame(n, m, opts)
}

/** Ids among `ids` that may be edited (unlocked, visible, not opaque), as the transforms act on them. */
export function transformableIds(doc: DrawDoc, ids: string[]): string[] {
  return editableIds(doc, ids)
}

/** Does transforming these nodes by `m` need a frame matrix (v2-only content)? */
export function selectionNeedsFrameMatrix(doc: DrawDoc, ids: string[], m: Matrix | ((n: DrawNode) => Matrix)): boolean {
  const wanted = new Set(editableIds(doc, ids))
  let needs = false
  const visit = (nodes: DrawNode[]): void => {
    for (const n of nodes) {
      if (needs) return
      if (wanted.has(n.id)) needs = needsFrameMatrix(n, typeof m === 'function' ? m(n) : m)
      else if (n.type === 'group') visit(n.children)
    }
  }
  for (const l of doc.layers) if (l.kind === 'vector') visit(l.objects)
  return needs
}

/** Map every wanted node (anywhere in the tree) through `fn`; `copy` places the result directly above the original instead. */
function rebuild(doc: DrawDoc, wanted: Set<string>, fn: (n: DrawNode, original: DrawNode) => DrawNode, copy: boolean, newIds: string[]): DrawDoc {
  const walk = (nodes: DrawNode[]): DrawNode[] => {
    let changed = false
    const out: DrawNode[] = []
    for (const n of nodes) {
      if (wanted.has(n.id)) {
        const next = fn(copy ? cloneWithNewIds(n) : n, n)
        if (copy) {
          out.push(n, next)
          newIds.push(next.id)
          changed = true
        } else {
          out.push(next)
          if (next !== n) changed = true
        }
        continue
      }
      if (n.type === 'group') {
        const children = walk(n.children)
        if (children !== n.children) {
          out.push({ ...n, children })
          changed = true
          continue
        }
      }
      out.push(n)
    }
    return changed ? out : nodes
  }
  let any = false
  const layers = doc.layers.map((l) => {
    if (l.kind !== 'vector') return l
    const objects = walk(l.objects)
    if (objects === l.objects) return l
    any = true
    return { ...l, objects }
  })
  return any ? { ...doc, layers } : doc
}

/**
 * A deep copy with fresh ids. Deep, not spread: a saved drawing must not hold
 * the same object twice (the main process refuses shared references in IPC
 * payloads as possible cycles), so a copy shares nothing with its original.
 */
function cloneWithNewIds(n: DrawNode): DrawNode {
  const fresh = (c: DrawNode): DrawNode => (c.type === 'group' ? { ...c, id: drawId('obj'), children: c.children.map(fresh) } : { ...c, id: drawId('obj') })
  return fresh(structuredClone(n))
}

export interface TransformResult {
  doc: DrawDoc
  /** Ids of the copies made (empty unless `copy`), in paint order. */
  newIds: string[]
}

/**
 * Transform the editable nodes among `ids` by `m` -- or, with `copy`, transform
 * copies of them, each placed directly above its original (Illustrator's
 * "Copy" button and Alt-drag). Locked, hidden and opaque nodes never move.
 */
export function transformObjects(doc: DrawDoc, ids: string[], m: Matrix, opts: TransformOptions = {}, copy = false): TransformResult {
  return transformObjectsBy(doc, ids, () => m, opts, copy)
}

/** As transformObjects, with a matrix per node (Transform Each, reference points per object). */
export function transformObjectsBy(doc: DrawDoc, ids: string[], matrixFor: (n: DrawNode) => Matrix, opts: TransformOptions = {}, copy = false): TransformResult {
  const wanted = new Set(editableIds(doc, ids))
  const newIds: string[] = []
  if (!wanted.size) return { doc, newIds }
  const inGroups = parentMatrices(doc, wanted)
  const next = rebuild(
    doc,
    wanted,
    (n, original) => {
      const pm = inGroups.get(original.id)
      const inv = pm ? invertNodeMatrix(pm) : null
      if (!pm || !inv) return transformNode(n, matrixFor(original), opts)
      // A member of a transformed group: `m` is meant on the artboard (and is
      // measured there), so it is applied in the member's own space as
      // inverse(parent) · m · parent. Groups are v2 content, so members may
      // take a frame matrix.
      const m = matrixFor(applyNodeMatrix(original, pm))
      return transformNode(n, multiplyMatrix(inv, multiplyMatrix(m, pm)), { ...opts, frameMatrix: true })
    },
    copy,
    newIds
  )
  return { doc: next, newIds }
}

/** Members of transformed groups among `wanted`: id -> the matrix from the member's space to the artboard. */
function parentMatrices(doc: DrawDoc, wanted: Set<string>): Map<string, Matrix> {
  const out = new Map<string, Matrix>()
  for (const p of allPlaces(doc)) {
    if (!wanted.has(p.node.id) || !p.parents.length) continue
    const pm = parentMatrix(p.parents)
    if (!isIdentityMatrix(pm)) out.set(p.node.id, pm)
  }
  return out
}

// ── Transform Each ───────────────────────────────────────────────────────────

/** Object › Transform › Transform Each…: every value applies to each object about its OWN reference point. */
export interface TransformEachParams {
  /** Percent; 100 = unchanged. */
  scaleH: number
  scaleV: number
  /** Document px. */
  moveH: number
  moveV: number
  /** UI degrees (counter-clockwise positive). */
  rotate: number
  /** Reflect X flips across the horizontal axis (upside down); Reflect Y across the vertical axis (mirror). */
  reflectX: boolean
  reflectY: boolean
  ref: RefPoint
  /** Each object gets its own random amount between "unchanged" and the value entered. */
  random: boolean
}

export const TRANSFORM_EACH_DEFAULTS: TransformEachParams = {
  scaleH: 100,
  scaleV: 100,
  moveH: 0,
  moveV: 0,
  rotate: 0,
  reflectX: false,
  reflectY: false,
  ref: 'c',
  random: false
}

/** The matrix Transform Each applies to one object with bounds `box`; `rand` returns [0, 1). */
export function transformEachMatrix(box: Box, p: TransformEachParams, rand: () => number = Math.random): Matrix {
  const pick = (from: number, to: number): number => (p.random ? from + (to - from) * rand() : to)
  const sx = pick(100, p.scaleH) / 100
  // Equal H and V stay a uniform scale under Random: one draw for both.
  const sy = p.scaleV === p.scaleH ? sx : pick(100, p.scaleV) / 100
  const deg = pick(0, p.rotate)
  const dx = pick(0, p.moveH)
  const dy = pick(0, p.moveV)
  const origin: Pt = refPointOf(box, p.ref)
  const linear = compose(rotationMatrix(-deg), scaling(p.reflectY ? -1 : 1, p.reflectX ? -1 : 1), scaling(sx, sy))
  return compose(translation(dx, dy), about(origin, linear))
}

export function transformEach(
  doc: DrawDoc,
  ids: string[],
  p: TransformEachParams,
  opts: TransformOptions = {},
  copy = false,
  rand: () => number = Math.random
): TransformResult {
  // One random draw per object, fixed before anything moves.
  const matrices = new Map<string, Matrix>()
  return transformObjectsBy(
    doc,
    ids,
    (n) => {
      let m = matrices.get(n.id)
      if (!m) {
        m = transformEachMatrix(nodeBounds(n), p, rand)
        matrices.set(n.id, m)
      }
      return m
    },
    opts,
    copy
  )
}

// ── Reset Bounding Box ───────────────────────────────────────────────────────

/** Turned frames among `ids`: their bounding box follows the turn, so Reset Bounding Box has something to do. */
export function turnedFrameIds(doc: DrawDoc, ids: string[]): string[] {
  const wanted = new Set(editableIds(doc, ids))
  const out: string[] = []
  for (const l of doc.layers) {
    if (l.kind !== 'vector') continue
    for (const n of l.objects) if (wanted.has(n.id) && isFrame(n) && n.rotation) out.push(n.id)
  }
  return out
}

/**
 * Object › Transform › Reset Bounding Box: a turned text, image or work widget
 * keeps exactly how it looks, but its turn moves out of `rotation` and into its
 * matrix, so its frame reads as square to the page again (Rotate 0°) -- and a
 * later handle scale stretches it along the page's axes, as in Illustrator.
 * Needs a v2 drawing (it writes a matrix).
 */
export function resetBoundingBox(doc: DrawDoc, ids: string[]): DrawDoc {
  const turned = new Set(turnedFrameIds(doc, ids))
  if (!turned.size) return doc
  return rebuild(
    doc,
    turned,
    (n) => {
      if (!isFrame(n) || !n.rotation) return n
      const p = nodePivot(n)
      const r = about(p, rotationMatrix(n.rotation))
      const { rotation: _r, ...rest } = n
      void _r
      return { ...rest, transform: n.transform ? multiplyMatrix(n.transform, r) : r } as DrawNode
    },
    false,
    []
  )
}

// ── Reading a selection's transform, for the panel ───────────────────────────

/**
 * The turn and shear a single node carries, in INTERNAL degrees: a frame's
 * `rotation` plus whatever its matrix (or a group's) adds. Paths are baked --
 * their box is always square to the page -- so they read 0.
 */
export function nodeOrientation(n: DrawNode): { rotation: number; skew: number } {
  if (n.type === 'group') {
    if (!n.transform) return { rotation: 0, skew: 0 }
    const d = decompose(n.transform)
    return { rotation: d.rotation, skew: d.skew }
  }
  if (!isFrame(n)) return { rotation: 0, skew: 0 }
  const base = n.rotation ?? 0
  if (!n.transform) return { rotation: base, skew: 0 }
  const d = decompose(multiplyMatrix(n.transform, rotationMatrix(base)))
  return { rotation: d.rotation, skew: d.skew }
}
