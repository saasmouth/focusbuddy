// Gradients from an SVG file to the drawing model -- and, for drawings still
// written in the older format, to what that format can hold.
//
// An SVG gradient lives in its own space: objectBoundingBox or user units,
// then gradientTransform, then the element's transform chain. The model's
// gradients live in the bounding-box units of the BAKED path (the serializer
// writes objectBoundingBox on the final geometry). Both ends are affine, so:
//
//   - a LINEAR gradient converts exactly to the model, always: its colour is an affine
//     function of position, and so stays one after any affine change of
//     coordinates; we just re-derive the from/to that give the same function;
//   - a RADIAL gradient converts exactly when the combined mapping keeps its
//     circle a circle in box units; otherwise its radius is approximated (and
//     the import report says how many were).
// Spread methods other than pad are approximated as pad, and reported.

import type { DrawGradientStop } from '../../../draw'
import type { Box, DrawDocPaint, Matrix, Pt } from '../../model'
import { mixHex } from './color'
import { decompose, invert, mul } from './transform'

export interface GradientStop {
  offset: number
  hex: string
  alpha: number
}

export interface GradientSpec {
  kind: 'linear' | 'radial'
  /** Geometry already resolved to numbers in the gradient's own space. */
  x1: number
  y1: number
  x2: number
  y2: number
  cx: number
  cy: number
  r: number
  fx: number
  fy: number
  objectBox: boolean
  transform: Matrix
  spread: 'pad' | 'reflect' | 'repeat'
  stops: GradientStop[]
}

export interface PaintNotes {
  approxRadial(): void
  spread(): void
  degenerateBox(): void
}

/** The colour (and alpha) of a stop list at `t`, padded at both ends. */
export function stopAt(stops: Array<{ offset: number; color: string; opacity?: number }>, t: number): { color: string; opacity: number } {
  if (!stops.length) return { color: '#000000', opacity: 0 }
  if (t <= stops[0].offset) return { color: stops[0].color, opacity: stops[0].opacity ?? 1 }
  const last = stops[stops.length - 1]
  if (t >= last.offset) return { color: last.color, opacity: last.opacity ?? 1 }
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    if (t <= b.offset) {
      const span = b.offset - a.offset
      const k = span > 0 ? (t - a.offset) / span : 1
      return { color: mixHex(a.color, b.color, k), opacity: (a.opacity ?? 1) + ((b.opacity ?? 1) - (a.opacity ?? 1)) * k }
    }
  }
  return { color: last.color, opacity: last.opacity ?? 1 }
}

function modelStops(stops: GradientStop[], alpha: number): DrawGradientStop[] {
  return stops.map((s) => {
    const a = s.alpha * alpha
    return { offset: s.offset, color: s.hex, ...(a < 1 ? { opacity: round(a, 4) } : {}) }
  })
}

function round(v: number, places = 6): number {
  const k = 10 ** places
  const r = Math.round(v * k) / k
  return Object.is(r, -0) ? 0 : r
}

function rp(p: Pt): Pt {
  return { x: round(p.x), y: round(p.y) }
}

function apply(m: Matrix, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/**
 * A gradient as a model paint for a shape whose LOCAL bounding box is
 * `localBox` (for objectBoundingBox units), drawn under `ctm`, and whose
 * baked geometry has the document-space box `docBox`. `alpha` is the
 * fill- or stroke-opacity, folded into the stops (a model gradient has no
 * paint-level opacity).
 */
export function gradientPaint(g: GradientSpec, localBox: Box, ctm: Matrix, docBox: Box, alpha: number, notes: PaintNotes): DrawDocPaint {
  const stops = modelStops(g.stops, alpha)
  if (stops.length === 0) return { type: 'none' }
  if (stops.length === 1) {
    const op = stops[0].opacity
    return { type: 'solid', color: stops[0].color, ...(op !== undefined ? { opacity: op } : {}) }
  }
  if (g.spread !== 'pad') notes.spread()
  const mid = (): DrawDocPaint => {
    const c = stopAt(stops, 0.5)
    return { type: 'solid', color: c.color, ...(c.opacity < 1 ? { opacity: round(c.opacity, 4) } : {}) }
  }
  // objectBoundingBox on an empty box draws nothing in SVG; the model cannot
  // express a gradient there at all, so it becomes its middle colour.
  if (g.objectBox && (!(localBox.w > 0) || !(localBox.h > 0))) return { type: 'none' }
  if (!(docBox.w > 1e-9) || !(docBox.h > 1e-9)) {
    notes.degenerateBox()
    return mid()
  }
  // Gradient space -> local user space -> document -> box units of the baked shape.
  const units: Matrix = g.objectBox ? [localBox.w, 0, 0, localBox.h, localBox.x, localBox.y] : [1, 0, 0, 1, 0, 0]
  const toBox: Matrix = [1 / docBox.w, 0, 0, 1 / docBox.h, -docBox.x / docBox.w, -docBox.y / docBox.h]
  const A = mul(toBox, mul(ctm, mul(units, g.transform)))
  if (g.kind === 'linear') {
    const vx = g.x2 - g.x1
    const vy = g.y2 - g.y1
    const vv = vx * vx + vy * vy
    // Coincident endpoints: SVG paints the last stop's colour.
    if (vv < 1e-18) {
      const last = stops[stops.length - 1]
      return { type: 'solid', color: last.color, ...(last.opacity !== undefined ? { opacity: last.opacity } : {}) }
    }
    const Ai = invert(A)
    if (!Ai) return mid()
    // f(q) = a.q + c, the gradient parameter at box-unit point q.
    const ax = (Ai[0] * vx + Ai[1] * vy) / vv
    const ay = (Ai[2] * vx + Ai[3] * vy) / vv
    const c = ((Ai[4] - g.x1) * vx + (Ai[5] - g.y1) * vy) / vv
    const aa = ax * ax + ay * ay
    if (aa < 1e-18) return mid()
    const from = { x: (-c * ax) / aa, y: (-c * ay) / aa }
    const to = { x: from.x + ax / aa, y: from.y + ay / aa }
    return { type: 'linear', stops, from: rp(from), to: rp(to) }
  }
  // Radial: the circle (c, r) and focal point in gradient space, through A.
  const q = decompose(A)
  const center = apply(A, g.cx, g.cy)
  const focal = apply(A, g.fx, g.fy)
  const sxAbs = Math.abs(q.sx)
  const syAbs = Math.abs(q.sy)
  const round_ = Math.abs(q.shear) < 0.01 && Math.abs(sxAbs - syAbs) / Math.max(sxAbs, syAbs, 1e-12) < 0.01
  if (!round_) notes.approxRadial()
  const radius = round_ ? (g.r * (sxAbs + syAbs)) / 2 : g.r * Math.sqrt(Math.abs(sxAbs * syAbs))
  const focalSame = Math.abs(focal.x - center.x) < 1e-9 && Math.abs(focal.y - center.y) < 1e-9
  return { type: 'radial', stops, center: rp(center), radius: round(Math.max(0, radius)), ...(focalSame ? {} : { focal: rp(focal) }) }
}

// ── The older format ─────────────────────────────────────────────────────────

/**
 * Stops re-laid along a new parameter t = map(s), cut to 0..1 with the colours
 * that padding would show at each end -- the same picture on the new line.
 */
function remapStops(stops: DrawGradientStop[], map: (s: number) => number): DrawGradientStop[] {
  const mapped = stops.map((s) => ({ ...s, offset: map(s.offset) }))
  const reversed = mapped.length > 1 && mapped[mapped.length - 1].offset < mapped[0].offset
  const ordered = reversed ? [...mapped].reverse() : mapped
  const at = (t: number): DrawGradientStop => {
    const c = stopAt(ordered, t)
    return { offset: t, color: c.color, ...(c.opacity < 1 ? { opacity: round(c.opacity, 4) } : {}) }
  }
  const inner = ordered.filter((s) => s.offset > 0 && s.offset < 1).map((s) => ({ ...s, offset: round(s.offset) }))
  return [at(0), ...inner, at(1)]
}

/**
 * A model gradient as one the older format can draw (an angle through the
 * box centre, or a centred circle). Linear gradients convert exactly when
 * their colour changes happen within v1's one-unit line through the centre
 * (always true for a gradient PlexiiDraw itself made); radial ones exactly
 * when centred with no focal point. Otherwise the nearest such gradient is
 * used and `approx` is called, so the import report can say so.
 */
export function gradientToV1(p: DrawDocPaint, approx: () => void): DrawDocPaint {
  if (p.type === 'linear' && (p.from || p.to)) {
    const F = p.from ?? { x: 0, y: 0.5 }
    const T = p.to ?? { x: 1, y: 0.5 }
    const dx = T.x - F.x
    const dy = T.y - F.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-12) return { type: 'linear', stops: p.stops, angle: 0 }
    const fc = ((0.5 - F.x) * dx + (0.5 - F.y) * dy) / (len * len)
    const angle = round((Math.atan2(dy, dx) * 180) / Math.PI, 6)
    // v1's line is one box unit long through the centre; beyond its ends it
    // pads. That is the same picture only if the original gradient has no
    // colour change outside the part of it the line covers.
    const sAt = (t: number): number => (t - 0.5) / len + fc
    const s0 = Math.min(sAt(0), sAt(1))
    const s1 = Math.max(sAt(0), sAt(1))
    const first = p.stops[0]?.offset ?? 0
    const last = p.stops[p.stops.length - 1]?.offset ?? 1
    // (A tolerance for files that wrote their endpoints to a few decimals.)
    if (s0 > first + 2e-3 || s1 < last - 2e-3) approx()
    return { type: 'linear', angle, stops: remapStops(p.stops, (s) => (s - fc) * len + 0.5) }
  }
  if (p.type === 'radial' && (p.center || p.radius !== undefined || p.focal)) {
    const c = p.center ?? { x: 0.5, y: 0.5 }
    const r = p.radius ?? 0.5
    const centred = Math.abs(c.x - 0.5) < 1e-6 && Math.abs(c.y - 0.5) < 1e-6
    const focalOk = !p.focal || (Math.abs(p.focal.x - c.x) < 1e-6 && Math.abs(p.focal.y - c.y) < 1e-6)
    if (!centred || !focalOk) approx()
    // v1's circle has radius 0.5 in box units.
    return { type: 'radial', stops: r > 1e-9 ? remapStops(p.stops, (s) => (s * r) / 0.5) : p.stops }
  }
  return p
}
