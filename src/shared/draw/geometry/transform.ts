// Affine maths for the Transform panel, the transform tools and Transform
// Again: building, composing, inverting and decomposing matrices, the 9-point
// reference locator, and the Illustrator-convention builders for rotate,
// reflect, shear and move.
//
// Two angle conventions meet here, and every function says which it takes:
//
//   - INTERNAL (SVG) angles: y points down, so a positive angle turns
//     CLOCKWISE on screen. rotateAbout, frame `rotation` and `transform`
//     matrices all use this.
//   - UI (Illustrator) angles: what a person types. A positive rotate angle
//     turns COUNTER-CLOCKWISE on screen, a reflect or shear axis angle is
//     measured counter-clockwise from horizontal, a move angle points up for
//     90°, and a positive shear slants clockwise (a horizontal shear leans the
//     top to the right, like italic type).
//
// The ui* builders are the only place one converts to the other.
//
// Matrices are SVG's [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f.

import { applyMatrix, multiplyMatrix, type Box, type Matrix, type Pt } from '../../drawGeometry'

export type { Matrix } from '../../drawGeometry'

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0]

const EPS = 1e-9
const DEG = Math.PI / 180

/** a·b: apply b first, then a. Several matrices compose right-to-left: compose(a, b, c) = a·b·c. */
export function compose(...ms: Matrix[]): Matrix {
  return ms.reduce((acc, m) => multiplyMatrix(acc, m), IDENTITY_MATRIX)
}

export function translation(dx: number, dy: number): Matrix {
  return [1, 0, 0, 1, dx, dy]
}

export function scaling(sx: number, sy: number = sx): Matrix {
  return [sx, 0, 0, sy, 0, 0]
}

/** A turn by INTERNAL degrees (clockwise on screen) about the origin. */
export function rotation(degrees: number): Matrix {
  const r = degrees * DEG
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [cos, sin, -sin, cos, 0, 0]
}

/** x' = x + kx·y, y' = y + ky·x. */
export function skewing(kx: number, ky: number): Matrix {
  return [1, ky, kx, 1, 0, 0]
}

/** The linear map `m` (its translation ignored) performed about `origin`: T(o)·L·T(-o). */
export function about(origin: Pt, m: Matrix): Matrix {
  const l: Matrix = [m[0], m[1], m[2], m[3], 0, 0]
  return compose(translation(origin.x, origin.y), l, translation(-origin.x, -origin.y))
}

export function determinant(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2]
}

export function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

export function isFiniteMatrix(m: Matrix): boolean {
  return m.length === 6 && m.every((v) => Number.isFinite(v))
}

export function matricesEqual(a: Matrix, b: Matrix, eps = 1e-9): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= eps)
}

export function isIdentity(m: Matrix, eps = 1e-9): boolean {
  return matricesEqual(m, IDENTITY_MATRIX, eps)
}

/** Nothing but a move. */
export function isTranslation(m: Matrix, eps = 1e-9): boolean {
  return Math.abs(m[0] - 1) <= eps && Math.abs(m[1]) <= eps && Math.abs(m[2]) <= eps && Math.abs(m[3] - 1) <= eps
}

/** No rotation and no shear: each axis maps onto itself (scales may be negative = flips). */
export function isAxisAligned(m: Matrix, eps = 1e-9): boolean {
  return Math.abs(m[1]) <= eps && Math.abs(m[2]) <= eps
}

/**
 * How much a transform scales LENGTHS on average: √|det|. A rotation, a
 * reflection or a shear is 1; a uniform 200% is 2; a 400% × 100% is 2. This is
 * what "Scale Strokes & Effects" multiplies stroke widths (and dashes) by.
 */
export function lengthScale(m: Matrix): number {
  return Math.sqrt(Math.abs(determinant(m)))
}

// ── Decomposition ────────────────────────────────────────────────────────────

/**
 * A matrix as the parts a Transform panel shows. The linear part is
 *
 *   L = R(rotation) · Shear(skew) · S(scaleX, scaleY)
 *
 * with Shear(skew) = [[1, tan skew], [0, 1]] (x' = x + tan(skew)·y). A
 * reflection shows up as a negative scaleY. Angles are INTERNAL degrees.
 */
export interface Decomposed {
  translateX: number
  translateY: number
  rotation: number
  scaleX: number
  scaleY: number
  skew: number
}

export function decompose(m: Matrix): Decomposed {
  const [a, b, c, d, e, f] = m
  const scaleX = Math.hypot(a, b)
  const theta = scaleX > EPS ? Math.atan2(b, a) : 0
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  // Rotate the second column back by -theta: (k·sy, sy).
  const scaleY = -c * sin + d * cos
  const k = Math.abs(scaleY) > EPS ? (c * cos + d * sin) / scaleY : 0
  return { translateX: e, translateY: f, rotation: theta / DEG, scaleX, scaleY, skew: Math.atan(k) / DEG }
}

export function recompose(p: Decomposed): Matrix {
  const l = compose(rotation(p.rotation), skewing(Math.tan(p.skew * DEG), 0), scaling(p.scaleX, p.scaleY))
  return [l[0], l[1], l[2], l[3], p.translateX, p.translateY]
}

// ── Reference points ─────────────────────────────────────────────────────────

/** The 9-point reference locator: top-left ... centre ... bottom-right. */
export type RefPoint = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br'
export const REF_POINTS: readonly RefPoint[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br']

const REF_LABELS: Record<RefPoint, string> = {
  tl: 'top left',
  t: 'top centre',
  tr: 'top right',
  l: 'left centre',
  c: 'centre',
  r: 'right centre',
  bl: 'bottom left',
  b: 'bottom centre',
  br: 'bottom right'
}

export function refPointLabel(r: RefPoint): string {
  return REF_LABELS[r]
}

export function isRefPoint(v: unknown): v is RefPoint {
  return typeof v === 'string' && (REF_POINTS as readonly string[]).includes(v)
}

/** Fractions (0, ½, 1) of the box's width and height that a reference point sits at. */
export function refFractions(r: RefPoint): { fx: number; fy: number } {
  const fx = r.endsWith('l') ? 0 : r.endsWith('r') ? 1 : 0.5
  const fy = r.startsWith('t') ? 0 : r.startsWith('b') ? 1 : 0.5
  return { fx, fy }
}

export function refPointOf(box: Box, r: RefPoint): Pt {
  const { fx, fy } = refFractions(r)
  return { x: box.x + box.w * fx, y: box.y + box.h * fy }
}

/**
 * The axis-aligned map that turns box `from` into box `to` while the reference
 * point `r` of one lands on the reference point of the other -- what typing
 * into the panel's X, Y, W or H fields does. A zero-width (or zero-height)
 * source keeps that axis unscaled rather than dividing by zero.
 */
export function boxToBox(from: Box, to: Box, r: RefPoint = 'tl'): Matrix {
  const sx = Math.abs(from.w) > EPS ? to.w / from.w : 1
  const sy = Math.abs(from.h) > EPS ? to.h / from.h : 1
  const a = refPointOf(from, r)
  const b = refPointOf(to, r)
  return [sx, 0, 0, sy, b.x - a.x * sx, b.y - a.y * sy]
}

/** The axis-aligned bounds of a box after a transform. */
export function transformedBox(b: Box, m: Matrix): Box {
  const pts = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h }
  ].map((p) => applyMatrix(m, p))
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

// ── Illustrator-convention builders (UI angles) ──────────────────────────────

/** Rotate by a UI angle (positive = counter-clockwise on screen) about `origin`. */
export function uiRotate(degrees: number, origin: Pt): Matrix {
  return about(origin, rotation(-degrees))
}

/**
 * Reflect across an axis through `origin` at a UI angle (counter-clockwise from
 * horizontal). 0° is Illustrator's "Horizontal" axis (flips upside down); 90°
 * is "Vertical" (mirrors left to right).
 */
export function uiReflect(axisDegrees: number, origin: Pt): Matrix {
  const a = -axisDegrees * DEG * 2
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return about(origin, [cos, sin, sin, -cos, 0, 0])
}

/**
 * Shear by a UI angle along an axis at a UI angle, about `origin`. The slant is
 * clockwise for a positive angle: a horizontal shear of +30° leans the top of a
 * shape to the right; a vertical shear of +30° drops its right side.
 */
export function uiShear(shearDegrees: number, axisDegrees: number, origin: Pt): Matrix {
  const k = Math.tan(shearDegrees * DEG)
  // In the axis's own frame the shear is horizontal: x' = x - k·y (y down).
  const inFrame = skewing(-k, 0)
  const r = rotation(-axisDegrees)
  const back = rotation(axisDegrees)
  return about(origin, compose(r, inFrame, back))
}

/** Scale by percentages about `origin`. */
export function uiScale(percentX: number, percentY: number, origin: Pt): Matrix {
  return about(origin, scaling(percentX / 100, percentY / 100))
}

/** A move given as a distance and a UI angle (90° = straight up the screen). */
export function polarMove(distance: number, angleDegrees: number): { dx: number; dy: number } {
  const a = angleDegrees * DEG
  const dx = distance * Math.cos(a)
  const dy = -distance * Math.sin(a)
  return { dx: Math.abs(dx) < 1e-12 ? 0 : dx, dy: Math.abs(dy) < 1e-12 ? 0 : dy }
}

/** A move's distance and UI angle (the inverse of polarMove). */
export function moveToPolar(dx: number, dy: number): { distance: number; angle: number } {
  const distance = Math.hypot(dx, dy)
  const angle = distance > EPS ? Math.atan2(-dy, dx) / DEG : 0
  return { distance, angle }
}

/** Wrap an angle into (-180, 180]. */
export function normalizeAngle(deg: number): number {
  let a = deg % 360
  if (a <= -180) a += 360
  if (a > 180) a -= 360
  return Object.is(a, -0) ? 0 : a
}
