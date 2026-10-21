// SVG path data ("M 10 10 C ...") to PlexiiDraw's path model, every command:
// M L H V C S Q T A Z, absolute and relative.
//
// The model has one segment kind -- a cubic with ABSOLUTE handles, where a
// missing handle means a straight side -- so:
//   - lines stay handle-free (they round-trip back to L);
//   - quadratics are raised to the exact equivalent cubic;
//   - elliptical arcs are converted to cubics with the endpoint-to-centre
//     conversion of the SVG spec (implementation notes, F.6.5) and one cubic per
//     quarter turn or less, which is within 0.03% of the true ellipse.
// A closing segment that lands back on the start point is folded into the
// start node, so a closed outline never carries a zero-length segment (which
// would show as a cusp under a stroke and confuse every edit tool).
//
// Like a browser, a syntax error ends the path where it occurred: everything
// before it is kept, and the caller is told.

import type { DrawNode, DrawPath, DrawSubpath } from '../../../drawGeometry'
import { MAX_COORD, NumberScanner } from './numbers'

export interface PathParseResult {
  path: DrawPath
  /** The data had an error; `path` holds everything before it. */
  error?: string
}

const EPS = 1e-9

function same(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) <= 1e-6 && Math.abs(ay - by) <= 1e-6
}

/**
 * The cubic pieces of an SVG elliptical arc from (x1, y1) to (x2, y2), as
 * [c1x, c1y, c2x, c2y, x, y] tuples. Empty when the endpoints coincide (the
 * spec says to draw nothing); a single straight piece when a radius is zero.
 */
export function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number
): Array<[number, number, number, number, number, number]> {
  if (same(x1, y1, x2, y2)) return []
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx < EPS || ry < EPS) return [[x1, y1, x2, y2, x2, y2]]
  const phi = ((phiDeg % 360) * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  // F.6.5.1: the start point in the ellipse's own (unrotated, centred) frame.
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  // F.6.6: radii too small to span the endpoints are scaled up just enough.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  // F.6.5.2: the centre in that frame.
  const rx2 = rx * rx
  const ry2 = ry * ry
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p
  let coef = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0
  if (largeArc === sweep) coef = -coef
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  // F.6.5.3: back to user space.
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  // F.6.5.5-6: start angle and sweep.
  const ux = (x1p - cxp) / rx
  const uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx
  const vy = (-y1p - cyp) / ry
  const angle = (ax: number, ay: number, bx: number, by: number): number => {
    const a = Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
    return a
  }
  const theta1 = angle(1, 0, ux, uy)
  let dTheta = angle(ux, uy, vx, vy)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI
  // One cubic per quarter turn (or less).
  const n = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2) - 1e-9))
  const delta = dTheta / n
  const k = (4 / 3) * Math.tan(delta / 4)
  const map = (px: number, py: number): [number, number] => [cx + rx * px * cos - ry * py * sin, cy + rx * px * sin + ry * py * cos]
  const out: Array<[number, number, number, number, number, number]> = []
  let a = theta1
  for (let i = 0; i < n; i++) {
    const b = a + delta
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const cb = Math.cos(b)
    const sb = Math.sin(b)
    const [c1x, c1y] = map(ca - k * sa, sa + k * ca)
    const [c2x, c2y] = map(cb + k * sb, sb - k * cb)
    const [ex, ey] = i === n - 1 ? [x2, y2] : map(cb, sb)
    out.push([c1x, c1y, c2x, c2y, ex, ey])
    a = b
  }
  return out
}

/** Path data to a DrawPath in the element's own coordinates. */
export function parsePathData(d: string, maxNodes = 1_000_000): PathParseResult {
  const sc = new NumberScanner(d)
  const subpaths: DrawSubpath[] = []
  let cur: DrawNode[] | null = null
  let curClosed = false
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  // The previous segment's second control point, for S and T reflection.
  let lastCubicCtrl: [number, number] | null = null
  let lastQuadCtrl: [number, number] | null = null
  let nodes = 0
  let error: string | undefined

  const flush = (): void => {
    if (cur && cur.length) {
      if (curClosed && cur.length > 1) {
        const first = cur[0]
        const last = cur[cur.length - 1]
        if (same(first.x, first.y, last.x, last.y)) {
          // The closing segment already arrived home: fold the duplicate end
          // node into the start, keeping its incoming handle.
          cur.pop()
          if (last.inX !== undefined && last.inY !== undefined) {
            first.inX = last.inX
            first.inY = last.inY
          } else {
            delete first.inX
            delete first.inY
          }
        }
      }
      subpaths.push({ closed: curClosed, nodes: cur })
    }
    cur = null
    curClosed = false
  }
  const ensure = (): DrawNode[] => {
    if (!cur) {
      // A drawing command straight after Z (or with no M at all after one)
      // starts a new subpath at the last start point.
      cur = [{ x: startX, y: startY }]
      nodes++
    }
    return cur
  }
  const lineTo = (nx: number, ny: number): void => {
    ensure().push({ x: nx, y: ny })
    nodes++
    x = nx
    y = ny
  }
  const cubicTo = (c1x: number, c1y: number, c2x: number, c2y: number, nx: number, ny: number): void => {
    const list = ensure()
    const prev = list[list.length - 1]
    prev.outX = c1x
    prev.outY = c1y
    list.push({ x: nx, y: ny, inX: c2x, inY: c2y })
    nodes++
    x = nx
    y = ny
  }

  let cmd = ''
  let first = true
  while (!sc.done()) {
    if (nodes > maxNodes) {
      error = 'too many points'
      break
    }
    const c = sc.s[sc.i]
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      cmd = c
      sc.i++
    } else if (!cmd) {
      error = `path data must start with a move (found "${c}")`
      break
    } else if (cmd === 'Z' || cmd === 'z') {
      error = `numbers after a close`
      break
    }
    if (first && cmd !== 'M' && cmd !== 'm') {
      error = 'path data must start with a move'
      break
    }
    first = false
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    const nums = (count: number): number[] | null => {
      const out: number[] = []
      for (let i = 0; i < count; i++) {
        const n = sc.number()
        if (n === null) return null
        out.push(n)
      }
      return out
    }
    let ok = true
    switch (cmd) {
      case 'M':
      case 'm': {
        const p = nums(2)
        if (!p) {
          ok = false
          break
        }
        flush()
        x = ox + p[0]
        y = oy + p[1]
        startX = x
        startY = y
        cur = [{ x, y }]
        nodes++
        // Extra pairs after a move are lines.
        cmd = rel ? 'l' : 'L'
        lastCubicCtrl = lastQuadCtrl = null
        continue
      }
      case 'L':
      case 'l': {
        const p = nums(2)
        if (!p) ok = false
        else lineTo(ox + p[0], oy + p[1])
        lastCubicCtrl = lastQuadCtrl = null
        break
      }
      case 'H':
      case 'h': {
        const p = nums(1)
        if (!p) ok = false
        else lineTo(ox + p[0], y)
        lastCubicCtrl = lastQuadCtrl = null
        break
      }
      case 'V':
      case 'v': {
        const p = nums(1)
        if (!p) ok = false
        else lineTo(x, oy + p[0])
        lastCubicCtrl = lastQuadCtrl = null
        break
      }
      case 'C':
      case 'c': {
        const p = nums(6)
        if (!p) {
          ok = false
          break
        }
        cubicTo(ox + p[0], oy + p[1], ox + p[2], oy + p[3], ox + p[4], oy + p[5])
        lastCubicCtrl = [ox + p[2], oy + p[3]]
        lastQuadCtrl = null
        break
      }
      case 'S':
      case 's': {
        const p = nums(4)
        if (!p) {
          ok = false
          break
        }
        const c1: [number, number] = lastCubicCtrl ? [2 * x - lastCubicCtrl[0], 2 * y - lastCubicCtrl[1]] : [x, y]
        cubicTo(c1[0], c1[1], ox + p[0], oy + p[1], ox + p[2], oy + p[3])
        lastCubicCtrl = [ox + p[0], oy + p[1]]
        lastQuadCtrl = null
        break
      }
      case 'Q':
      case 'q': {
        const p = nums(4)
        if (!p) {
          ok = false
          break
        }
        const qx = ox + p[0]
        const qy = oy + p[1]
        const ex = ox + p[2]
        const ey = oy + p[3]
        cubicTo(x + ((qx - x) * 2) / 3, y + ((qy - y) * 2) / 3, ex + ((qx - ex) * 2) / 3, ey + ((qy - ey) * 2) / 3, ex, ey)
        lastQuadCtrl = [qx, qy]
        lastCubicCtrl = null
        break
      }
      case 'T':
      case 't': {
        const p = nums(2)
        if (!p) {
          ok = false
          break
        }
        const qx = lastQuadCtrl ? 2 * x - lastQuadCtrl[0] : x
        const qy = lastQuadCtrl ? 2 * y - lastQuadCtrl[1] : y
        const ex = ox + p[0]
        const ey = oy + p[1]
        cubicTo(x + ((qx - x) * 2) / 3, y + ((qy - y) * 2) / 3, ex + ((qx - ex) * 2) / 3, ey + ((qy - ey) * 2) / 3, ex, ey)
        lastQuadCtrl = [qx, qy]
        lastCubicCtrl = null
        break
      }
      case 'A':
      case 'a': {
        const r = nums(3)
        const large = r ? sc.flag() : null
        const sweepF = large !== null ? sc.flag() : null
        const e = sweepF !== null ? nums(2) : null
        if (!r || large === null || sweepF === null || !e) {
          ok = false
          break
        }
        const ex = ox + e[0]
        const ey = oy + e[1]
        const pieces = arcToCubics(x, y, r[0], r[1], r[2], large === 1, sweepF === 1, ex, ey)
        for (const [c1x, c1y, c2x, c2y, px, py] of pieces) {
          if (c1x === x && c1y === y && c2x === px && c2y === py) lineTo(px, py)
          else cubicTo(c1x, c1y, c2x, c2y, px, py)
        }
        x = ex
        y = ey
        lastCubicCtrl = lastQuadCtrl = null
        break
      }
      case 'Z':
      case 'z': {
        if (cur) {
          curClosed = true
          flush()
        }
        x = startX
        y = startY
        lastCubicCtrl = lastQuadCtrl = null
        cmd = ''
        // A command letter must follow a close.
        continue
      }
    }
    if (!ok) {
      error = `bad numbers for "${cmd}"`
      break
    }
    if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
      error = 'a coordinate is out of range'
      cur = null
      break
    }
  }
  flush()
  return { path: { subpaths: subpaths.filter((s) => s.nodes.length > 1) }, ...(error ? { error } : {}) }
}
