// SVG transforms: the `transform` attribute (matrix, translate, scale, rotate
// about a point, skewX, skewY, in any combination), viewBox mapping with
// preserveAspectRatio, and taking a matrix apart into what a frame node can
// carry (position, size, rotation) plus whatever is left over.

import { multiplyMatrix } from '../../../drawGeometry'
import type { Matrix } from '../../model'
import { NumberScanner } from './numbers'

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export function mul(a: Matrix, b: Matrix): Matrix {
  return multiplyMatrix(a, b)
}

export function isIdentity(m: Matrix): boolean {
  return Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12 && Math.abs(m[3] - 1) < 1e-12 && Math.abs(m[4]) < 1e-12 && Math.abs(m[5]) < 1e-12
}

export function translate(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y]
}

export function scale(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0]
}

export function rotateDeg(deg: number, cx = 0, cy = 0): Matrix {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

export function det(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2]
}

/** How much a matrix scales lengths on average: sqrt(|det|) (exact for uniform scale and rotation). */
export function meanScale(m: Matrix): number {
  return Math.sqrt(Math.abs(det(m)))
}

/** True when the matrix scales differently along different directions (or skews). */
export function isAnisotropic(m: Matrix, tol = 0.01): boolean {
  const sx = Math.hypot(m[0], m[1])
  const sy = Math.hypot(m[2], m[3])
  const dot = m[0] * m[2] + m[1] * m[3]
  if (sx === 0 || sy === 0) return true
  return Math.abs(sx - sy) / Math.max(sx, sy) > tol || Math.abs(dot) / (sx * sy) > tol
}

/**
 * A transform attribute as one matrix, or null when it is malformed (a
 * browser then ignores the attribute entirely; so do we, and the caller notes it).
 */
export function parseTransform(v: string | null | undefined): Matrix | null {
  if (v == null) return IDENTITY
  const s = v.trim()
  if (!s || s === 'none') return IDENTITY
  let m: Matrix = IDENTITY
  const re = /\s*,?\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gy
  let consumed = 0
  let hit: RegExpExecArray | null
  while ((hit = re.exec(s)) !== null) {
    consumed = re.lastIndex
    // CSS-style units ("10px", "45deg", "1rad") show up in hand-written files.
    const raw = hit[2].replace(/(\d)(px|deg)\b/gi, '$1')
    const radian = /rad\b/i.test(hit[2]) && !/deg/i.test(hit[2])
    const sc = new NumberScanner(raw.replace(/(\d)(rad|turn)\b/gi, '$1'))
    const a: number[] = []
    for (;;) {
      const n = sc.number()
      if (n === null) break
      a.push(n)
    }
    if (!sc.done()) return null
    const ang = (x: number): number => (radian ? (x * 180) / Math.PI : x)
    let f: Matrix
    switch (hit[1]) {
      case 'matrix':
        if (a.length !== 6) return null
        f = [a[0], a[1], a[2], a[3], a[4], a[5]]
        break
      case 'translate':
        if (a.length !== 1 && a.length !== 2) return null
        f = translate(a[0], a[1] ?? 0)
        break
      case 'scale':
        if (a.length !== 1 && a.length !== 2) return null
        f = scale(a[0], a[1] ?? a[0])
        break
      case 'rotate':
        if (a.length !== 1 && a.length !== 3) return null
        f = rotateDeg(ang(a[0]), a[1] ?? 0, a[2] ?? 0)
        break
      case 'skewX':
        if (a.length !== 1) return null
        f = [1, 0, Math.tan((ang(a[0]) * Math.PI) / 180), 1, 0, 0]
        break
      default:
        if (a.length !== 1) return null
        f = [1, Math.tan((ang(a[0]) * Math.PI) / 180), 0, 1, 0, 0]
    }
    m = mul(m, f)
  }
  if (s.slice(consumed).trim()) return null
  return m.every(Number.isFinite) ? m : null
}

/** The viewBox -> viewport mapping of SVG's preserveAspectRatio. */
export function viewBoxTransform(
  vb: { x: number; y: number; w: number; h: number },
  vp: { x: number; y: number; w: number; h: number },
  par: string | null | undefined
): Matrix {
  if (!(vb.w > 0) || !(vb.h > 0)) return translate(vp.x, vp.y)
  const p = (par ?? '').trim().split(/\s+/)
  const align = p[0] === 'defer' ? (p[1] ?? 'xMidYMid') : p[0] || 'xMidYMid'
  const slice = (p[0] === 'defer' ? p[2] : p[1]) === 'slice'
  let sx = vp.w / vb.w
  let sy = vp.h / vb.h
  if (align !== 'none') {
    const k = slice ? Math.max(sx, sy) : Math.min(sx, sy)
    sx = sy = k
  }
  let tx = vp.x - vb.x * sx
  let ty = vp.y - vb.y * sy
  if (align !== 'none') {
    const fx = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0
    const fy = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0
    tx += (vp.w - vb.w * sx) * fx
    ty += (vp.h - vb.h * sy) * fy
  }
  return [sx, 0, 0, sy, tx, ty]
}

/**
 * A matrix as rotation x (scale along the rotated axes) x shear:
 *   L = R(theta) . [[sx, sx*k], [0, sy]]
 * (a QR split). `sy` is negative for a reflection. Exact for any invertible
 * linear part.
 */
export function decompose(m: Matrix): { theta: number; sx: number; sy: number; shear: number; tx: number; ty: number } {
  const [a, b, c, d, e, f] = m
  const sx = Math.hypot(a, b)
  const theta = Math.atan2(b, a)
  const dt = a * d - b * c
  const sy = sx > 0 ? dt / sx : 0
  const shear = sx > 0 && sy !== 0 ? (a * c + b * d) / (sx * sx) : 0
  return { theta: (theta * 180) / Math.PI, sx, sy, shear, tx: e, ty: f }
}

/**
 * Can a frame node (text, image) carry this matrix with its own fields --
 * position, size and rotation -- with no general matrix? Yes when there is no
 * shear and no reflection; text also needs the scale to be uniform, because a
 * font size has one value.
 */
export function frameRepresentable(m: Matrix, uniform: boolean, tol = 1e-3): boolean {
  const q = decompose(m)
  if (!(q.sx > 0) || !(q.sy > 0)) return false
  if (Math.abs(q.shear) > tol) return false
  if (uniform && Math.abs(q.sx - q.sy) / Math.max(q.sx, q.sy) > tol) return false
  return true
}
