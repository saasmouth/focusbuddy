// Shared building blocks for the shape-library category files. Everything here
// is pure geometry over the helpers in types.ts — no React, no DOM — and every
// number that reaches a path string goes through r() so the output is always a
// clean, absolute-command SVG path.

import {
  type Rect,
  type ShapeCategory,
  type ShapeDef,
  type ShapeGeometry,
  type ShapePart,
  ellipse,
  r,
  rect
} from './types'

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

// "x,y" with rounding.
export const P = (x: number, y: number): string => `${r(x)},${r(y)}`

// Part constructors.
export const fill = (d: string): ShapePart => ({ d, paint: 'fill' })
export const stroke = (d: string): ShapePart => ({ d, paint: 'stroke' })
export const shade = (d: string): ShapePart => ({ d, paint: 'shade' })
export const solid = (d: string): ShapePart => ({ d, paint: 'solid' })
export const none = (d: string): ShapePart => ({ d, paint: 'none' })

// A text rect forced inside the w×h box (never negative, never past an edge).
export function box(w: number, h: number, x: number, y: number, bw: number, bh: number): Rect {
  const x0 = clamp(x, 0, w)
  const y0 = clamp(y, 0, h)
  return { x: x0, y: y0, w: clamp(bw, 0, w - x0), h: clamp(bh, 0, h - y0) }
}

// inset() that can never escape the box, even at tiny sizes.
export function pad(w: number, h: number, l: number, t = l, rt = l, b = t): Rect {
  return box(w, h, l, t, w - l - rt, h - t - b)
}

// Open polyline (no Z) from absolute points.
export function pline(points: [number, number][]): string {
  return `M${points.map(([x, y]) => P(x, y)).join(' L')}`
}

// Point on an ellipse at an angle in degrees (0 = east, 90 = south — screen space).
export function onEllipse(cx: number, cy: number, rx: number, ry: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
}

// Arc segment command (no M) from the current point (assumed at a0) to a1, clockwise
// when a1 > a0.
function arcTo(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): string {
  const [x, y] = onEllipse(cx, cy, rx, ry, a1)
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  const sweep = a1 > a0 ? 1 : 0
  return `A${r(rx)},${r(ry)} 0 ${large} ${sweep} ${P(x, y)}`
}

// Open elliptical arc from angle a0 to a1 (degrees; |a1-a0| < 360).
export function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): string {
  const [x, y] = onEllipse(cx, cy, rx, ry, a0)
  return `M${P(x, y)} ${arcTo(cx, cy, rx, ry, a0, a1)}`
}

// Closed pie wedge from the centre.
export function wedge(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): string {
  const [x, y] = onEllipse(cx, cy, rx, ry, a0)
  return `M${P(cx, cy)} L${P(x, y)} ${arcTo(cx, cy, rx, ry, a0, a1)} Z`
}

// Closed band between two concentric arcs (block arc, circular arrow body).
export function band(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  ix: number,
  iy: number,
  a0: number,
  a1: number
): string {
  const [ox, oy] = onEllipse(cx, cy, rx, ry, a0)
  const [qx, qy] = onEllipse(cx, cy, ix, iy, a1)
  return `M${P(ox, oy)} ${arcTo(cx, cy, rx, ry, a0, a1)} L${P(qx, qy)} ${arcTo(cx, cy, ix, iy, a1, a0)} Z`
}

// Ellipse traced in the opposite direction to ellipse(), so it cuts a hole in a
// compound fill under either fill rule.
export function ellipseRev(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M${P(cx - rx, cy)} A${r(rx)},${r(ry)} 0 1 1 ${P(cx + rx, cy)} ` +
    `A${r(rx)},${r(ry)} 0 1 1 ${P(cx - rx, cy)} Z`
  )
}

// Full-circle helper for circles inside a box.
export const circle = (cx: number, cy: number, rad: number): string => ellipse(cx, cy, rad, rad)

// Full bounding rectangle — the outline for open / compound silhouettes.
export const bounds = (w: number, h: number): string => rect(0, 0, w, h)

// Folded-corner document body + fold triangle.
export function folded(w: number, h: number, k: number): { body: string; fold: string } {
  const c = Math.min(k, w / 2, h / 2)
  return {
    body: `M0,0 H${r(w - c)} L${P(w, c)} V${r(h)} H0 Z`,
    fold: `M${P(w - c, 0)} V${r(c)} H${r(w)} Z`
  }
}

// Common port sets.
export const PORTS_8: [number, number][] = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5],
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1]
]
export const PORTS_THIRDS: [number, number][] = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5],
  [0.25, 0],
  [0.75, 0],
  [1, 0.25],
  [1, 0.75],
  [0.75, 1],
  [0.25, 1],
  [0, 0.75],
  [0, 0.25]
]

// Generic constructor: keeps each shape a compact literal while staying a plain
// ShapeDef underneath.
export function shape(
  id: string,
  label: string,
  category: ShapeCategory,
  w: number,
  h: number,
  draw: (w: number, h: number) => ShapeGeometry,
  extra: Partial<ShapeDef> = {}
): ShapeDef {
  return { id, label, category, w, h, draw, ...extra }
}

// Single closed path shape with a text rect.
export function pathShape(
  id: string,
  label: string,
  category: ShapeCategory,
  w: number,
  h: number,
  d: (w: number, h: number) => string,
  text: (w: number, h: number) => Rect,
  extra: Partial<ShapeDef> = {}
): ShapeDef {
  return shape(id, label, category, w, h, (W, H) => ({ parts: [fill(d(W, H))], text: text(W, H) }), extra)
}

// Icon tile: rounded frame on top, label underneath. The renderer centres
// node.icon (default `icon`) inside the tile.
export const ICON_TILE = 0.7
export const ICON_PORTS: [number, number][] = [
  [0.5, 0],
  [1, ICON_TILE / 2],
  [0.5, 1],
  [0, ICON_TILE / 2]
]
export function iconShape(
  id: string,
  label: string,
  category: ShapeCategory,
  icon: string,
  keywords: string[],
  extra: Partial<ShapeDef> = {}
): ShapeDef {
  return {
    id,
    label,
    category,
    keywords,
    w: 80,
    h: 96,
    minW: 24,
    minH: 28,
    aspectLocked: true,
    special: 'icon',
    icon,
    defaultLabel: label,
    ports: ICON_PORTS,
    draw: (w, h) => {
      const th = h * ICON_TILE
      return {
        parts: [fill(rect(0, 0, w, th, Math.min(w, th) * 0.18))],
        text: box(w, h, 0, h * 0.72, w, h * 0.28)
      }
    },
    outline: (w, h) => rect(0, 0, w, h),
    ...extra
  }
}

// Path from fractional coordinates: fpath(w, h, 'M', 0, 0.5, 'C', ...). Pairs
// after M/L/C/Q are (x·w, y·h); numbers after H scale by w, after V by h.
// Arcs are not supported here (their radii are not points) — build those with
// the absolute helpers instead.
export function fpath(w: number, h: number, ...segs: (string | number)[]): string {
  const out: string[] = []
  let cmd = 'M'
  let pending: number | null = null
  for (const s of segs) {
    if (typeof s === 'string') {
      cmd = s
      out.push(s === 'Z' ? 'Z' : s)
      pending = null
      continue
    }
    if (cmd === 'H') out.push(r(s * w))
    else if (cmd === 'V') out.push(r(s * h))
    else if (pending === null) pending = s
    else {
      out.push(P(pending * w, s * h))
      pending = null
    }
  }
  // Join: a command letter is glued to its first argument, args are space-separated.
  let d = ''
  for (const t of out) {
    if (/^[A-Z]$/.test(t)) d += (d ? ' ' : '') + t
    else d += (/[A-Z]$/.test(d) ? '' : ' ') + t
  }
  return d
}

// Rescale points so their bounding box fills the w×h box exactly (regular
// polygons with odd side counts otherwise leave gaps at the edges).
export function fit(w: number, h: number, pts: [number, number][]): [number, number][] {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const sx = Math.max(...xs) - x0 || 1
  const sy = Math.max(...ys) - y0 || 1
  return pts.map(([x, y]) => [((x - x0) / sx) * w, ((y - y0) / sy) * h])
}
