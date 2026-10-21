// Connector routing for PlexiDiagrams. Pure maths: no React, no DOM, no deps.
//
//   routeEdge  — one connector between two boxes (orthogonal / straight / curved)
//   routeAll   — every connector of a page, with obstacles, parallel-edge
//                spreading, self-loops and optional line jumps
//
// Orthogonal routing is an A* search over a sparse orthogonal visibility grid:
// the grid lines are the inflated obstacle edges, the port stub coordinates and
// the mid-lines of the free channels between obstacles. The search state is
// (grid point, heading) and the cost is length + bendPenalty per turn, so the
// result is short with few bends. All candidate ports of an automatic end are
// searched at once (multi-source / multi-target), with a small bias towards
// ports that face the other shape, so the best facing pair falls out of the
// same search that avoids the obstacles.

import type { MapEdge, MapNode, MapRouting } from '../types'
import { type Box, type Pt, type Side, center, nodeBox, parsePort, portId, portPoint, rotatePt, sideOf } from './geom'
import { getShape, shapePorts } from './shapes'

export interface Route {
  points: Pt[] // polyline (sampled for curves)
  path: string // SVG path data
  sourcePort: string
  targetPort: string
  sourceSide: Side
  targetSide: Side
  labelPoint: Pt
  length: number
  startAngle: number // degrees; direction of the first segment pointing INTO the source end
  endAngle: number // degrees; direction of the last segment pointing INTO the target end
}

export interface RouteRequest {
  source: Box
  target: Box
  sourcePort?: string | null
  targetPort?: string | null
  sourcePorts?: [number, number][]
  targetPorts?: [number, number][]
  routing: MapRouting
  waypoints?: Pt[]
  labelPos?: number
  // nth self-loop on the same node (nests loops instead of stacking them)
  loopIndex?: number
  // Shift the preferred mid-channel lines by this many px (parallel edges use
  // it so their middle runs sit side by side instead of on top of each other).
  channelOffset?: number
}

export interface RouteOptions {
  margin?: number // clearance kept around obstacles (default 12)
  gridStep?: number // when set, channel mid-lines snap to this grid where they fit
  stub?: number // perpendicular lead-out from a port (default 16)
  bendPenalty?: number // cost of one bend in px of length (default 20)
  cornerRadius?: number // rounded orthogonal corners in `path`
  // Also centre routes in every free channel between obstacles (nicer in tight
  // spaces, ~3-4x slower). The gap between source and target is always centred.
  centerChannels?: boolean
}

const DEFAULT_PORTS: [number, number][] = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5]
]

// Headings: 0 +x (right), 1 +y (down), 2 -x (left), 3 -y (up).
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]
const DIR_SIDE: Side[] = ['right', 'bottom', 'left', 'top']
const SIDE_DIR: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 }
const EPS = 1e-6

// ── small helpers ───────────────────────────────────────────────────────────

const fmt = (n: number): string => {
  const v = Math.round(n * 100) / 100
  return (Object.is(v, -0) ? 0 : v).toString()
}

const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y)

const angleOf = (from: Pt, to: Pt): number => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI

interface R {
  x1: number
  y1: number
  x2: number
  y2: number
}

function aabb(b: Box): R {
  if (!b.rotation) return { x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h }
  const c = center(b)
  const pts = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h }
  ].map((p) => rotatePt(p, c, b.rotation!))
  return {
    x1: Math.min(...pts.map((p) => p.x)),
    y1: Math.min(...pts.map((p) => p.y)),
    x2: Math.max(...pts.map((p) => p.x)),
    y2: Math.max(...pts.map((p) => p.y))
  }
}

const inflate = (r: R, m: number): R => ({ x1: r.x1 - m, y1: r.y1 - m, x2: r.x2 + m, y2: r.y2 + m })

const strictlyInside = (p: Pt, r: R): boolean =>
  p.x > r.x1 + EPS && p.x < r.x2 - EPS && p.y > r.y1 + EPS && p.y < r.y2 - EPS

const rectsTouch = (a: R, b: R): boolean => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1

// Unit vector a side points out of the box, rotated with the box.
function sideVec(b: Box, side: Side): Pt {
  const d = SIDE_DIR[side]
  const v = { x: DX[d]!, y: DY[d]! }
  return b.rotation ? rotatePt(v, { x: 0, y: 0 }, b.rotation) : v
}

// The world heading (axis-snapped) of a side once the box is rotated.
function worldDir(b: Box, side: Side): number {
  if (!b.rotation) return SIDE_DIR[side]
  const v = sideVec(b, side)
  return Math.abs(v.x) >= Math.abs(v.y) ? (v.x > 0 ? 0 : 2) : v.y > 0 ? 1 : 3
}

function polyLength(points: Pt[]): number {
  let l = 0
  for (let i = 1; i < points.length; i++) l += dist(points[i - 1]!, points[i]!)
  return l
}

// Drop duplicate points and interior points that lie on a straight run.
// A point where the line doubles back is kept (it changes the drawing).
export function simplifyPoints(points: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue
    out.push({ x: p.x, y: p.y })
  }
  let changed = true
  while (changed && out.length > 2) {
    changed = false
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]!
      const b = out[i]!
      const c = out[i + 1]!
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)
      if (Math.abs(cross) < 1e-6 && dot >= 0) {
        out.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return out
}

// ── polyline queries ────────────────────────────────────────────────────────

export function pointAlong(points: Pt[], t: number): Pt {
  if (!points.length) return { x: 0, y: 0 }
  if (points.length === 1) return { ...points[0]! }
  const total = polyLength(points)
  if (total <= 0) return { ...points[0]! }
  let target = Math.min(1, Math.max(0, t)) * total
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const l = dist(a, b)
    if (target <= l || i === points.length - 1) {
      const k = l > 0 ? Math.min(1, target / l) : 0
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
    }
    target -= l
  }
  return { ...points[points.length - 1]! }
}

export function nearestT(points: Pt[], p: Pt): number {
  if (points.length < 2) return 0
  const total = polyLength(points)
  if (total <= 0) return 0
  let best = Infinity
  let bestAt = 0
  let acc = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    const k = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0
    const q = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
    const d = dist(p, q)
    const l = Math.sqrt(l2)
    if (d < best) {
      best = d
      bestAt = acc + l * k
    }
    acc += l
  }
  return bestAt / total
}

// Shorten a polyline at either end (for arrowheads, see arrowInset).
export function trimPoints(points: Pt[], startInset: number, endInset: number): Pt[] {
  if (points.length < 2) return points.map((p) => ({ ...p }))
  const total = polyLength(points)
  if (startInset + endInset >= total) return points.map((p) => ({ ...p }))
  const out = points.map((p) => ({ ...p }))
  const cut = (pts: Pt[], amount: number): void => {
    let left = amount
    while (left > 0 && pts.length > 1) {
      const a = pts[0]!
      const b = pts[1]!
      const l = dist(a, b)
      if (l > left) {
        pts[0] = { x: a.x + ((b.x - a.x) * left) / l, y: a.y + ((b.y - a.y) * left) / l }
        return
      }
      left -= l
      pts.shift()
    }
  }
  if (startInset > 0) cut(out, startInset)
  if (endInset > 0) {
    out.reverse()
    cut(out, endInset)
    out.reverse()
  }
  return out
}

// ── path building ───────────────────────────────────────────────────────────

// Polyline → SVG path. Orthogonal routes may round their corners; `hops`
// (segment index → distances along that segment) draws line-jump semicircles.
function buildLinePath(points: Pt[], cornerRadius: number, hops?: Map<number, number[]>, hopRadius = 5): string {
  // Fewer than two points is not a line; a bare "M" would only hide that.
  if (points.length < 2) return ''
  const n = points.length
  const segLen = (i: number): number => dist(points[i]!, points[i + 1]!)
  // Corner trim at each interior vertex.
  const trim = new Array<number>(n).fill(0)
  if (cornerRadius > 0) {
    for (let i = 1; i < n - 1; i++) trim[i] = Math.min(cornerRadius, segLen(i - 1) / 2, segLen(i) / 2)
  }
  let d = `M${fmt(points[0]!.x)},${fmt(points[0]!.y)}`
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    const l = segLen(i)
    const ux = l > 0 ? (b.x - a.x) / l : 0
    const uy = l > 0 ? (b.y - a.y) / l : 0
    const at = (s: number): Pt => ({ x: a.x + ux * s, y: a.y + uy * s })
    const segHops = hops?.get(i)
    if (segHops?.length) {
      const sweep = b.x - a.x > 0 ? 1 : b.x - a.x < 0 ? 0 : b.y - a.y > 0 ? 0 : 1
      for (const s of [...segHops].sort((p, q) => p - q)) {
        const p1 = at(s - hopRadius)
        const p2 = at(s + hopRadius)
        d += ` L${fmt(p1.x)},${fmt(p1.y)} A${fmt(hopRadius)},${fmt(hopRadius)} 0 0 ${sweep} ${fmt(p2.x)},${fmt(p2.y)}`
      }
    }
    const end = at(l - trim[i + 1]!)
    d += ` L${fmt(end.x)},${fmt(end.y)}`
    if (trim[i + 1]! > 0 && i + 2 < n) {
      const c = points[i + 2]!
      const l2 = segLen(i + 1)
      const k = trim[i + 1]! / l2
      const next = { x: b.x + (c.x - b.x) * k, y: b.y + (c.y - b.y) * k }
      d += ` Q${fmt(b.x)},${fmt(b.y)} ${fmt(next.x)},${fmt(next.y)}`
    }
  }
  return d
}

// Catmull-Rom spline through points as cubic Béziers (uniform, tension 0.5).
function splineSegments(pts: Pt[], startTangent?: Pt, endTangent?: Pt): { a: Pt; c1: Pt; c2: Pt; b: Pt }[] {
  const n = pts.length
  if (n < 2) return []
  const tan: Pt[] = []
  for (let i = 0; i < n; i++) {
    if (i === 0) tan.push(startTangent ?? { x: pts[1]!.x - pts[0]!.x, y: pts[1]!.y - pts[0]!.y })
    else if (i === n - 1) tan.push(endTangent ?? { x: pts[n - 1]!.x - pts[n - 2]!.x, y: pts[n - 1]!.y - pts[n - 2]!.y })
    else tan.push({ x: (pts[i + 1]!.x - pts[i - 1]!.x) / 2, y: (pts[i + 1]!.y - pts[i - 1]!.y) / 2 })
  }
  const segs: { a: Pt; c1: Pt; c2: Pt; b: Pt }[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    segs.push({
      a,
      b,
      c1: { x: a.x + tan[i]!.x / 3, y: a.y + tan[i]!.y / 3 },
      c2: { x: b.x - tan[i + 1]!.x / 3, y: b.y - tan[i + 1]!.y / 3 }
    })
  }
  return segs
}

function cubicAt(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y
  }
}

function cubicPath(segs: { a: Pt; c1: Pt; c2: Pt; b: Pt }[]): string {
  if (!segs.length) return ''
  let d = `M${fmt(segs[0]!.a.x)},${fmt(segs[0]!.a.y)}`
  for (const s of segs) d += ` C${fmt(s.c1.x)},${fmt(s.c1.y)} ${fmt(s.c2.x)},${fmt(s.c2.y)} ${fmt(s.b.x)},${fmt(s.b.y)}`
  return d
}

function sampleCubics(segs: { a: Pt; c1: Pt; c2: Pt; b: Pt }[], perSeg: number): Pt[] {
  const out: Pt[] = []
  segs.forEach((s, i) => {
    for (let k = i === 0 ? 0 : 1; k <= perSeg; k++) out.push(cubicAt(s.a, s.c1, s.c2, s.b, k / perSeg))
  })
  return out
}

export function pathFromPoints(points: Pt[], routing: MapRouting, opts?: { cornerRadius?: number }): string {
  if (points.length < 2) return ''
  if (routing === 'curved' && points.length > 2) return cubicPath(splineSegments(points))
  return buildLinePath(points, routing === 'orthogonal' ? Math.max(0, opts?.cornerRadius ?? 0) : 0)
}

// ── ports ───────────────────────────────────────────────────────────────────

interface PortCand {
  fx: number
  fy: number
  id: string
  side: Side // local side
  explicit: boolean
}

function candidates(port: string | null | undefined, ports: [number, number][] | undefined): PortCand[] {
  const p = parsePort(port)
  if (p) return [{ ...p, id: portId(p.fx, p.fy), side: sideOf(p.fx, p.fy), explicit: true }]
  const list = ports?.length ? ports : DEFAULT_PORTS
  return list.map(([fx, fy]) => ({ fx, fy, id: portId(fx, fy), side: sideOf(fx, fy), explicit: false }))
}

// Where the line from the box centre towards `toward` leaves the box border.
function borderPoint(b: Box, toward: Pt): { p: Pt; fx: number; fy: number } {
  const c = center(b)
  const local = b.rotation ? rotatePt(toward, c, -b.rotation) : toward
  const dx = local.x - c.x
  const dy = local.y - c.y
  let fx = 0.5
  let fy = 0.5
  if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
    const sx = Math.abs(dx) > EPS ? b.w / 2 / Math.abs(dx) : Infinity
    const sy = Math.abs(dy) > EPS ? b.h / 2 / Math.abs(dy) : Infinity
    const s = Math.min(sx, sy)
    fx = 0.5 + (dx * s) / b.w
    fy = 0.5 + (dy * s) / b.h
  } else {
    fx = 1
  }
  fx = Math.min(1, Math.max(0, fx))
  fy = Math.min(1, Math.max(0, fy))
  return { p: portPoint(b, fx, fy), fx, fy }
}

// How much a port faces away from where the line wants to go (0 = facing).
function facingBias(dirVec: Pt, from: Pt, to: Pt, weight: number): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const l = Math.hypot(dx, dy)
  if (l < EPS) return 0
  return weight * (1 - (dirVec.x * dx + dirVec.y * dy) / l)
}

// ── orthogonal search ───────────────────────────────────────────────────────

interface Anchor {
  p: Pt
  dir: number // heading at a start / required arrival heading at a goal; -1 = any
  bias: number
}

interface Found {
  pts: Pt[]
  si: number
  gi: number
  cost: number
}

function uniqSorted(values: number[]): number[] {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const out: number[] = []
  for (const v of s) if (!out.length || v - out[out.length - 1]! > 1e-6) out.push(v)
  return out
}

function findIdx(arr: number[], v: number): number {
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m = arr[mid]!
    if (Math.abs(m - v) <= 1e-6) return mid
    if (m < v) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

// First index with arr[i] >= v - eps.
function lowerIdx(arr: number[], v: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! < v - 1e-6) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Last index with arr[i] <= v + eps.
function upperIdx(arr: number[], v: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! <= v + 1e-6) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

class Heap {
  private f: number[] = []
  private g: number[] = []
  private s: number[] = []
  get size(): number {
    return this.s.length
  }
  private less(i: number, j: number): boolean {
    const a = this.f[i]!
    const b = this.f[j]!
    return a < b - 1e-9 || (Math.abs(a - b) <= 1e-9 && this.g[i]! > this.g[j]!)
  }
  private swap(i: number, j: number): void {
    ;[this.f[i], this.f[j]] = [this.f[j]!, this.f[i]!]
    ;[this.g[i], this.g[j]] = [this.g[j]!, this.g[i]!]
    ;[this.s[i], this.s[j]] = [this.s[j]!, this.s[i]!]
  }
  push(f: number, g: number, s: number): void {
    this.f.push(f)
    this.g.push(g)
    this.s.push(s)
    let i = this.s.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): { g: number; s: number } {
    const top = { g: this.g[0]!, s: this.s[0]! }
    const last = this.s.length - 1
    this.swap(0, last)
    this.f.pop()
    this.g.pop()
    this.s.pop()
    let i = 0
    const n = this.s.length
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < n && this.less(l, m)) m = l
      if (r < n && this.less(r, m)) m = r
      if (m === i) break
      this.swap(i, m)
      i = m
    }
    return top
  }
}

interface SearchCfg {
  bend: number
  gridStep: number
  channelMids: boolean
}

function searchGrid(starts: Anchor[], goals: Anchor[], obs: R[], region: R, prefX: number[], prefY: number[], cfg: SearchCfg): Found | null {
  // Grid lines: anchors, obstacle edges, region bounds, preferred lines and
  // the mid-lines of the channels between obstacle edges.
  const ox = uniqSorted(obs.flatMap((o) => [o.x1, o.x2]))
  const oy = uniqSorted(obs.flatMap((o) => [o.y1, o.y2]))
  const snap = (v: number, lo: number, hi: number): number => {
    if (cfg.gridStep > 0) {
      const s = Math.round(v / cfg.gridStep) * cfg.gridStep
      if (s > lo + EPS && s < hi - EPS) return s
    }
    return v
  }
  const midX: number[] = []
  const midY: number[] = []
  const clipX = [region.x1, ...ox.filter((v) => v > region.x1 && v < region.x2), region.x2]
  const clipY = [region.y1, ...oy.filter((v) => v > region.y1 && v < region.y2), region.y2]
  if (cfg.channelMids) {
    for (let i = 1; i < clipX.length; i++) midX.push(snap((clipX[i - 1]! + clipX[i]!) / 2, clipX[i - 1]!, clipX[i]!))
    for (let i = 1; i < clipY.length; i++) midY.push(snap((clipY[i - 1]! + clipY[i]!) / 2, clipY[i - 1]!, clipY[i]!))
  }
  const anchors = [...starts, ...goals]
  const xs = uniqSorted([...anchors.map((a) => a.p.x), ...clipX, ...midX, ...prefX.filter((v) => v > region.x1 && v < region.x2)])
  const ys = uniqSorted([...anchors.map((a) => a.p.y), ...clipY, ...midY, ...prefY.filter((v) => v > region.y1 && v < region.y2)])
  const nx = xs.length
  const ny = ys.length
  const N = nx * ny
  const prefXFlag = new Uint8Array(nx)
  const prefYFlag = new Uint8Array(ny)
  for (const v of [...midX, ...prefX]) {
    const i = findIdx(xs, v)
    if (i >= 0) prefXFlag[i] = 1
  }
  for (const v of [...midY, ...prefY]) {
    const j = findIdx(ys, v)
    if (j >= 0) prefYFlag[j] = 1
  }

  // Blocked points (strictly inside an obstacle) and blocked unit segments.
  const ptB = new Uint8Array(N)
  const hB = new Uint8Array(N) // (i,j) → (i+1,j)
  const vB = new Uint8Array(N) // (i,j) → (i,j+1)
  for (const o of obs) {
    const ia = lowerIdx(xs, o.x1)
    const ib = upperIdx(xs, o.x2)
    const ja = lowerIdx(ys, o.y1)
    const jb = upperIdx(ys, o.y2)
    if (ia > ib || ja > jb) continue
    // strict interior index ranges
    const iIn0 = Math.abs(xs[ia]! - o.x1) <= 1e-6 ? ia + 1 : ia
    const iIn1 = Math.abs(xs[ib]! - o.x2) <= 1e-6 ? ib - 1 : ib
    const jIn0 = Math.abs(ys[ja]! - o.y1) <= 1e-6 ? ja + 1 : ja
    const jIn1 = Math.abs(ys[jb]! - o.y2) <= 1e-6 ? jb - 1 : jb
    for (let j = jIn0; j <= jIn1; j++) {
      const row = j * nx
      for (let i = iIn0; i <= iIn1; i++) ptB[row + i] = 1
      for (let i = ia; i < ib; i++) hB[row + i] = 1
    }
    for (let i = iIn0; i <= iIn1; i++) for (let j = ja; j < jb; j++) vB[j * nx + i] = 1
  }

  const sIdx = starts.map((a) => {
    const i = findIdx(xs, a.p.x)
    const j = findIdx(ys, a.p.y)
    return i < 0 || j < 0 ? -1 : j * nx + i
  })
  const gIdx = goals.map((a) => {
    const i = findIdx(xs, a.p.x)
    const j = findIdx(ys, a.p.y)
    return i < 0 || j < 0 ? -1 : j * nx + i
  })
  const goalAt = new Map<number, number[]>()
  gIdx.forEach((idx, m) => {
    if (idx < 0) return
    const l = goalAt.get(idx)
    if (l) l.push(m)
    else goalAt.set(idx, [m])
  })
  if (!goalAt.size) return null

  const bend = cfg.bend
  const S = N * 4 + goals.length
  const g = new Float64Array(S).fill(Infinity)
  const par = new Int32Array(S).fill(-1)
  const heap = new Heap()
  const h = (idx: number): number => {
    const x = xs[idx % nx]!
    const y = ys[(idx / nx) | 0]!
    let best = Infinity
    for (let m = 0; m < goals.length; m++) {
      if (gIdx[m]! < 0) continue
      const gp = goals[m]!.p
      const dx = Math.abs(gp.x - x)
      const dy = Math.abs(gp.y - y)
      const v = dx + dy + goals[m]!.bias + (dx > 1e-6 && dy > 1e-6 ? bend : 0)
      if (v < best) best = v
    }
    return best
  }
  starts.forEach((a, k) => {
    const idx = sIdx[k]!
    if (idx < 0 || ptB[idx]) return
    const dirs = a.dir < 0 ? [0, 1, 2, 3] : [a.dir]
    for (const d of dirs) {
      const s = idx * 4 + d
      if (a.bias < g[s]!) {
        g[s] = a.bias
        heap.push(a.bias + h(idx), a.bias, s)
      }
    }
  })

  let pops = 0
  const maxPops = Math.max(20000, S * 3)
  while (heap.size) {
    const { g: gs, s } = heap.pop()
    if (gs > g[s]! + 1e-9) continue
    if (++pops > maxPops) return null
    if (s >= N * 4) {
      // Reached a goal: rebuild the grid path.
      const gi = s - N * 4
      const idxs: number[] = []
      let firstState = -1
      let cur = par[s]!
      while (cur >= 0) {
        idxs.push(cur >> 2)
        firstState = cur
        cur = par[cur]!
      }
      idxs.reverse()
      const pts = idxs.map((idx) => ({ x: xs[idx % nx]!, y: ys[(idx / nx) | 0]! }))
      const firstIdx = firstState >> 2
      const firstDir = firstState & 3
      let si = -1
      let siBias = Infinity
      starts.forEach((a, k) => {
        if (sIdx[k] === firstIdx && (a.dir < 0 || a.dir === firstDir) && a.bias < siBias) {
          si = k
          siBias = a.bias
        }
      })
      if (si < 0) return null
      // Exact anchor coordinates at both ends.
      pts[0] = { ...starts[si]!.p }
      pts[pts.length - 1] = { ...goals[gi]!.p }
      return { pts, si, gi, cost: gs }
    }
    const idx = s >> 2
    const d = s & 3
    const i = idx % nx
    const j = (idx / nx) | 0
    const gl = goalAt.get(idx)
    if (gl) {
      for (const m of gl) {
        const gd = goals[m]!.dir
        const pen = gd < 0 || gd === d ? 0 : gd === ((d + 2) & 3) ? 2 * bend + 2 : bend + 1
        const ng = gs + pen + goals[m]!.bias
        const vs = N * 4 + m
        if (ng < g[vs]! - 1e-9) {
          g[vs] = ng
          par[vs] = s
          heap.push(ng, ng, vs)
        }
      }
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((d + 2) & 3)) continue
      let ni = i
      let nj = j
      if (nd === 0) {
        if (i + 1 >= nx || hB[j * nx + i]) continue
        ni = i + 1
      } else if (nd === 2) {
        if (i - 1 < 0 || hB[j * nx + i - 1]) continue
        ni = i - 1
      } else if (nd === 1) {
        if (j + 1 >= ny || vB[j * nx + i]) continue
        nj = j + 1
      } else {
        if (j - 1 < 0 || vB[(j - 1) * nx + i]) continue
        nj = j - 1
      }
      const nidx = nj * nx + ni
      if (ptB[nidx]) continue
      const len = Math.abs(xs[ni]! - xs[i]!) + Math.abs(ys[nj]! - ys[j]!)
      let turn = 0
      if (nd !== d) turn = bend + ((nd === 0 || nd === 2 ? prefYFlag[j] : prefXFlag[i]) ? 0 : 1)
      const ng = gs + len + turn
      const ns = nidx * 4 + nd
      if (ng < g[ns]! - 1e-9) {
        g[ns] = ng
        par[ns] = s
        heap.push(ng + h(nidx), ng, ns)
      }
    }
  }
  return null
}

// Every point a grid search returns must lie inside the region it searched. A
// frame-vs-page coordinate slip yields routes that still avoid every shape and
// still line up, yet sit somewhere they were never searched (d2 found that
// class surviving an 800-layout crossing sweep), so it is counted here where
// the region is known. Tests assert the count stays at zero; at runtime an
// escaping result is discarded and the search widens, never drawn.
export const routingInvariants = { regionEscapes: 0, fallbacks: 0 }
function insideRegion(found: Found, region: R): boolean {
  const ok = found.pts.every((p) => p.x >= region.x1 - 0.5 && p.x <= region.x2 + 0.5 && p.y >= region.y1 - 0.5 && p.y <= region.y2 + 0.5)
  if (!ok) routingInvariants.regionEscapes++
  return ok
}

// Search with a region that grows until a route is found.
function searchOrtho(starts: Anchor[], goals: Anchor[], obstacles: R[], focus: R, prefX: number[], prefY: number[], cfg: SearchCfg): Found | null {
  if (!starts.length || !goals.length) return null
  const anchors = [...starts, ...goals]
  // An anchor sitting inside an obstacle frees it (waypoints dropped on shapes,
  // crowded ports) — otherwise there could be no route at all.
  const usable = obstacles.filter((o) => !anchors.some((a) => strictlyInside(a.p, o)))
  let bx: R = { ...focus }
  for (const a of anchors) {
    bx = { x1: Math.min(bx.x1, a.p.x), y1: Math.min(bx.y1, a.p.y), x2: Math.max(bx.x2, a.p.x), y2: Math.max(bx.y2, a.p.y) }
  }
  for (const pad of [80, 400, Infinity]) {
    let region: R
    let obs: R[]
    if (pad === Infinity) {
      const all = usable.reduce<R>(
        (acc, o) => ({ x1: Math.min(acc.x1, o.x1), y1: Math.min(acc.y1, o.y1), x2: Math.max(acc.x2, o.x2), y2: Math.max(acc.y2, o.y2) }),
        bx
      )
      region = inflate(all, 40)
      obs = usable
    } else {
      region = inflate(bx, pad)
      obs = usable.filter((o) => rectsTouch(o, region))
    }
    const found = searchGrid(starts, goals, obs, region, prefX, prefY, cfg)
    if (found && insideRegion(found, region)) return found
    if (pad !== Infinity && obs.length === usable.length) {
      // Region already held every obstacle; only the outer ring can help.
      const wide = inflate(bx, pad * 3 + 200)
      const again = searchGrid(starts, goals, obs, wide, prefX, prefY, cfg)
      if (again && insideRegion(again, wide)) return again
      return null
    }
  }
  return null
}

// A plain elbow between two stubbed ends (used when no clear route exists).
function elbow(p0: Pt, p1: Pt, dS: number, q1: Pt, q0: Pt, dT: number): Pt[] {
  const sH = dS === 0 || dS === 2
  const tH = dT === 0 || dT === 2
  let mid: Pt[]
  if (sH && tH) {
    const mx = (p1.x + q1.x) / 2
    mid = [{ x: mx, y: p1.y }, { x: mx, y: q1.y }]
  } else if (!sH && !tH) {
    const my = (p1.y + q1.y) / 2
    mid = [{ x: p1.x, y: my }, { x: q1.x, y: my }]
  } else if (sH) {
    mid = [{ x: q1.x, y: p1.y }]
  } else {
    mid = [{ x: p1.x, y: q1.y }]
  }
  return [p0, p1, ...mid, q1, q0]
}

// Orthogonal corner between two free points, continuing the current heading.
function cornerBetween(a: Pt, b: Pt, heading: number): Pt[] {
  if (Math.abs(a.x - b.x) < EPS || Math.abs(a.y - b.y) < EPS) return [a, b]
  const horizontal = heading === 0 || heading === 2
  return [a, horizontal ? { x: b.x, y: a.y } : { x: a.x, y: b.y }, b]
}

function headingOf(a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2
  return dy >= 0 ? 1 : 3
}

function lastHeading(pts: Pt[], fallback: number): number {
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1]!
    const b = pts[i]!
    if (dist(a, b) > EPS) return headingOf(a, b)
  }
  return fallback
}

// ── routeEdge ───────────────────────────────────────────────────────────────

interface End {
  cand: PortCand
  p0: Pt // port point
  p1: Pt // stub end
  dir: number // world heading out of the port (axis-snapped)
  vec: Pt // exact outward vector (curves)
  side: Side // world side
}

function makeEnd(b: Box, cand: PortCand, stub: number, ownMargin: number): End {
  const p0 = portPoint(b, cand.fx, cand.fy)
  const dir = worldDir(b, cand.side)
  const box = aabb(b)
  let len = stub
  if (dir === 0) len = Math.max(stub, box.x2 + ownMargin + 1 - p0.x)
  else if (dir === 2) len = Math.max(stub, p0.x - (box.x1 - ownMargin - 1))
  else if (dir === 1) len = Math.max(stub, box.y2 + ownMargin + 1 - p0.y)
  else len = Math.max(stub, p0.y - (box.y1 - ownMargin - 1))
  return {
    cand,
    p0,
    p1: { x: p0.x + DX[dir]! * len, y: p0.y + DY[dir]! * len },
    dir,
    vec: sideVec(b, cand.side),
    side: DIR_SIDE[dir]!
  }
}

function finish(points: Pt[], path: string, src: { id: string; side: Side }, tgt: { id: string; side: Side }, labelPos: number, startAngle: number, endAngle: number): Route {
  return {
    points,
    path,
    sourcePort: src.id,
    targetPort: tgt.id,
    sourceSide: src.side,
    targetSide: tgt.side,
    labelPoint: pointAlong(points, labelPos),
    length: polyLength(points),
    startAngle,
    endAngle
  }
}

function lineAngles(points: Pt[]): { start: number; end: number } {
  const n = points.length
  if (n < 2) return { start: 0, end: 0 }
  let s = 1
  while (s < n - 1 && dist(points[0]!, points[s]!) < EPS) s++
  let e = n - 2
  while (e > 0 && dist(points[n - 1]!, points[e]!) < EPS) e--
  return { start: angleOf(points[s]!, points[0]!), end: angleOf(points[e]!, points[n - 1]!) }
}

export function routeEdge(req: RouteRequest, obstacles: Box[], opts?: RouteOptions): Route {
  const margin = Math.max(0, opts?.margin ?? 12)
  const stub = Math.max(1, opts?.stub ?? 16)
  const cfg: SearchCfg = { bend: Math.max(0, opts?.bendPenalty ?? 20), gridStep: Math.max(0, opts?.gridStep ?? 0), channelMids: !!opts?.centerChannels }
  const cornerRadius = Math.max(0, opts?.cornerRadius ?? 0)
  const labelPos = typeof req.labelPos === 'number' && Number.isFinite(req.labelPos) ? Math.min(1, Math.max(0, req.labelPos)) : 0.5
  const { source, target, routing } = req
  const waypoints = (req.waypoints ?? []).filter((w) => Number.isFinite(w.x) && Number.isFinite(w.y))
  const srcC = candidates(req.sourcePort, req.sourcePorts)
  const tgtC = candidates(req.targetPort, req.targetPorts)
  const cS = center(source)
  const cT = center(target)
  const selfLoop = !!source.id && source.id === target.id
  const explicitPair = srcC.length === 1 && tgtC.length === 1 && srcC[0]!.explicit && tgtC[0]!.explicit && srcC[0]!.id !== tgtC[0]!.id

  if (selfLoop && !explicitPair && !waypoints.length) return selfLoopRoute(req, labelPos, cornerRadius, stub)

  // ── straight ──
  if (routing === 'straight') {
    const towardS = waypoints[0] ?? cT
    const towardT = waypoints[waypoints.length - 1] ?? cS
    const sEnd = srcC[0]!.explicit ? { p: portPoint(source, srcC[0]!.fx, srcC[0]!.fy), fx: srcC[0]!.fx, fy: srcC[0]!.fy } : borderPoint(source, towardS)
    const tEnd = tgtC[0]!.explicit ? { p: portPoint(target, tgtC[0]!.fx, tgtC[0]!.fy), fx: tgtC[0]!.fx, fy: tgtC[0]!.fy } : borderPoint(target, towardT)
    const points = simplifyPoints([sEnd.p, ...waypoints, tEnd.p])
    if (points.length < 2) points.push({ ...points[0]! })
    const a = lineAngles(points)
    return finish(
      points,
      buildLinePath(points, 0),
      { id: portId(sEnd.fx, sEnd.fy), side: DIR_SIDE[worldDir(source, sideOf(sEnd.fx, sEnd.fy))]! },
      { id: portId(tEnd.fx, tEnd.fy), side: DIR_SIDE[worldDir(target, sideOf(tEnd.fx, tEnd.fy))]! },
      labelPos,
      a.start,
      a.end
    )
  }

  // ── curved ──
  if (routing === 'curved') {
    const pick = (b: Box, list: PortCand[], toward: Pt): End => {
      let best: End | null = null
      let bestScore = Infinity
      for (const c of list) {
        const e = makeEnd(b, c, stub, 0)
        const score = dist(e.p0, toward) + facingBias(e.vec, e.p0, toward, 40)
        if (score < bestScore) {
          bestScore = score
          best = e
        }
      }
      return best!
    }
    let sE: End
    let tE: End
    if (waypoints.length) {
      sE = pick(source, srcC, waypoints[0]!)
      tE = pick(target, tgtC, waypoints[waypoints.length - 1]!)
    } else {
      let best: [End, End] | null = null
      let bestScore = Infinity
      for (const a of srcC) {
        const ea = makeEnd(source, a, stub, 0)
        for (const b of tgtC) {
          const eb = makeEnd(target, b, stub, 0)
          const score = dist(ea.p0, eb.p0) + facingBias(ea.vec, ea.p0, eb.p0, 40) + facingBias(eb.vec, eb.p0, ea.p0, 40)
          if (score < bestScore) {
            bestScore = score
            best = [ea, eb]
          }
        }
      }
      ;[sE, tE] = best!
    }
    let segs: { a: Pt; c1: Pt; c2: Pt; b: Pt }[]
    if (!waypoints.length) {
      const k = Math.max(40, 0.4 * dist(sE.p0, tE.p0))
      segs = [
        {
          a: sE.p0,
          c1: { x: sE.p0.x + sE.vec.x * k, y: sE.p0.y + sE.vec.y * k },
          c2: { x: tE.p0.x + tE.vec.x * k, y: tE.p0.y + tE.vec.y * k },
          b: tE.p0
        }
      ]
    } else {
      const pts = [sE.p0, ...waypoints, tE.p0]
      const k0 = 3 * Math.max(40, 0.4 * dist(pts[0]!, pts[1]!))
      const k1 = 3 * Math.max(40, 0.4 * dist(pts[pts.length - 2]!, pts[pts.length - 1]!))
      segs = splineSegments(pts, { x: sE.vec.x * k0, y: sE.vec.y * k0 }, { x: -tE.vec.x * k1, y: -tE.vec.y * k1 })
    }
    const points = sampleCubics(segs, waypoints.length ? 12 : 24)
    const first = segs[0]!
    const last = segs[segs.length - 1]!
    const startAngle = dist(first.c1, first.a) > EPS ? angleOf(first.c1, first.a) : angleOf(first.b, first.a)
    const endAngle = dist(last.c2, last.b) > EPS ? angleOf(last.c2, last.b) : angleOf(last.a, last.b)
    return finish(points, cubicPath(segs), { id: sE.cand.id, side: sE.side }, { id: tE.cand.id, side: tE.side }, labelPos, startAngle, endAngle)
  }

  // ── orthogonal ──
  const ownM = Math.min(margin, Math.max(0, stub - 2))
  const sBox = inflate(aabb(source), ownM)
  const tBox = inflate(aabb(target), ownM)
  const others = obstacles.filter((o) => o.id !== source.id && o.id !== target.id).map((o) => inflate(aabb(o), margin))
  const obs: R[] = selfLoop ? [...others, sBox] : [...others, sBox, tBox]
  const sEnds = srcC.map((c) => makeEnd(source, c, stub, ownM))
  const tEnds = tgtC.map((c) => makeEnd(target, c, stub, ownM))
  // Prefer ports whose stub lands in free space.
  const free = (ends: End[]): End[] => {
    const ok = ends.filter((e) => !obs.some((o) => strictlyInside(e.p1, o)))
    return ok.length ? ok : ends
  }
  const sUse = free(sEnds)
  const tUse = free(tEnds)
  const towardS = waypoints[0] ?? cT
  const towardT = waypoints[waypoints.length - 1] ?? cS
  const dirVec = (d: number): Pt => ({ x: DX[d]!, y: DY[d]! })
  const bestEnd = (ends: End[], c: Pt, toward: Pt): End =>
    ends.reduce((best, e) => (facingBias(dirVec(e.dir), c, toward, 40) < facingBias(dirVec(best.dir), c, toward, 40) ? e : best), ends[0]!)
  const starts: Anchor[] = sUse.map((e) => ({ p: e.p1, dir: e.dir, bias: e.cand.explicit ? 0 : facingBias(dirVec(e.dir), cS, towardS, 40) }))
  const goals: Anchor[] = tUse.map((e) => ({ p: e.p1, dir: (e.dir + 2) & 3, bias: e.cand.explicit ? 0 : facingBias(dirVec(e.dir), cT, towardT, 40) }))
  const focus: R = {
    x1: Math.min(sBox.x1, tBox.x1),
    y1: Math.min(sBox.y1, tBox.y1),
    x2: Math.max(sBox.x2, tBox.x2),
    y2: Math.max(sBox.y2, tBox.y2)
  }
  // Mid-lines of the gap between the two shapes: Lucid-style centred elbows.
  const prefX: number[] = []
  const prefY: number[] = []
  const sA = aabb(source)
  const tA = aabb(target)
  if (sA.x2 < tA.x1) prefX.push((sA.x2 + tA.x1) / 2)
  else if (tA.x2 < sA.x1) prefX.push((tA.x2 + sA.x1) / 2)
  if (sA.y2 < tA.y1) prefY.push((sA.y2 + tA.y1) / 2)
  else if (tA.y2 < sA.y1) prefY.push((tA.y2 + sA.y1) / 2)
  if (cfg.gridStep > 0) {
    for (const arr of [prefX, prefY]) arr.forEach((v, i) => (arr[i] = Math.round(v / cfg.gridStep) * cfg.gridStep))
  }
  const chOff = Number.isFinite(req.channelOffset) ? req.channelOffset! : 0
  if (chOff) for (const arr of [prefX, prefY]) arr.forEach((v, i) => (arr[i] = v + chOff))

  let points: Pt[]
  let sE: End
  let tE: End
  if (!waypoints.length) {
    const found = searchOrtho(starts, goals, obs, focus, prefX, prefY, cfg)
    if (found) {
      sE = sUse[found.si]!
      tE = tUse[found.gi]!
      points = [sE.p0, ...found.pts, tE.p0]
    } else {
      // Fallback: the best facing pair (ignoring blocked stubs — nothing is
      // clear anyway), joined by a plain elbow.
      sE = bestEnd(sEnds, cS, towardS)
      tE = bestEnd(tEnds, cT, towardT)
      points = elbow(sE.p0, sE.p1, sE.dir, tE.p1, tE.p0, tE.dir)
      routingInvariants.fallbacks++
    }
  } else {
    // Route leg by leg through the waypoints, in order.
    const wps = waypoints
    const legs: Pt[][] = []
    // First leg: source ports → first waypoint.
    const first = searchOrtho(starts, [{ p: wps[0]!, dir: -1, bias: 0 }], obs, focus, prefX, prefY, cfg)
    if (first) {
      sE = sUse[first.si]!
      legs.push([sE.p0, ...first.pts])
    } else {
      sE = bestEnd(sEnds, cS, towardS)
      legs.push([sE.p0, ...cornerBetween(sE.p1, wps[0]!, sE.dir)])
    }
    let heading = lastHeading(legs[0]!, sE.dir)
    const headingStarts = (p: Pt, hd: number): Anchor[] =>
      [0, 1, 2, 3].map((d) => ({ p, dir: d, bias: d === hd ? 0 : d === ((hd + 2) & 3) ? 5 * cfg.bend + 50 : cfg.bend + 1 }))
    for (let k = 0; k + 1 < wps.length; k++) {
      const a = wps[k]!
      const b = wps[k + 1]!
      const legFocus: R = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) }
      const f = searchOrtho(headingStarts(a, heading), [{ p: b, dir: -1, bias: 0 }], obs, legFocus, [], [], cfg)
      const leg = f ? f.pts : cornerBetween(a, b, heading)
      legs.push(leg)
      heading = lastHeading(leg, heading)
    }
    const lastW = wps[wps.length - 1]!
    const lastFocus: R = {
      x1: Math.min(lastW.x, tBox.x1),
      y1: Math.min(lastW.y, tBox.y1),
      x2: Math.max(lastW.x, tBox.x2),
      y2: Math.max(lastW.y, tBox.y2)
    }
    const lastLeg = searchOrtho(headingStarts(lastW, heading), goals, obs, lastFocus, [], [], cfg)
    if (lastLeg) {
      tE = tUse[lastLeg.gi]!
      legs.push([...lastLeg.pts, tE.p0])
    } else {
      tE = bestEnd(tEnds, cT, towardT)
      const c = cornerBetween(lastW, tE.p1, heading)
      legs.push([...c, tE.p0])
    }
    points = legs.flat()
  }
  points = simplifyPoints(points)
  if (points.length < 2) points.push({ ...points[0]! })
  const a = lineAngles(points)
  return finish(points, buildLinePath(points, cornerRadius), { id: sE.cand.id, side: sE.side }, { id: tE.cand.id, side: tE.side }, labelPos, a.start, a.end)
}

// A loop off the top-right corner of a box. Nested loops grow outwards.
function selfLoopRoute(req: RouteRequest, labelPos: number, cornerRadius: number, stub: number): Route {
  const b = req.source
  const k = Math.max(0, Math.floor(req.loopIndex ?? 0))
  const fy = Math.min(0.9, 0.3 + 0.12 * k)
  const fx = Math.max(0.1, 0.7 - 0.12 * k)
  const d = Math.max(stub, 20) + 12 * k
  const sp = parsePort(req.sourcePort) ?? { fx: 1, fy }
  const tp = parsePort(req.targetPort) ?? { fx, fy: 0 }
  if (Math.abs(sp.fx - tp.fx) < 1e-6 && Math.abs(sp.fy - tp.fy) < 1e-6) {
    // Both ends on one port: spread them along that side so the loop opens.
    const side = sideOf(sp.fx, sp.fy)
    const along = (v: number, dv: number): number => Math.min(1, Math.max(0, v + dv))
    if (side === 'left' || side === 'right') {
      sp.fy = along(sp.fy, -0.2)
      tp.fy = along(tp.fy, 0.2)
    } else {
      sp.fx = along(sp.fx, 0.2)
      tp.fx = along(tp.fx, -0.2)
    }
  }
  const sSide = sideOf(sp.fx, sp.fy)
  const tSide = sideOf(tp.fx, tp.fy)
  const p0 = portPoint(b, sp.fx, sp.fy)
  const q0 = portPoint(b, tp.fx, tp.fy)
  const vS = sideVec(b, sSide)
  const vT = sideVec(b, tSide)
  if (req.routing === 'curved') {
    const kk = d * 2.5
    const seg = { a: p0, c1: { x: p0.x + vS.x * kk, y: p0.y + vS.y * kk }, c2: { x: q0.x + vT.x * kk, y: q0.y + vT.y * kk }, b: q0 }
    const points = sampleCubics([seg], 24)
    return finish(
      points,
      cubicPath([seg]),
      { id: portId(sp.fx, sp.fy), side: DIR_SIDE[worldDir(b, sSide)]! },
      { id: portId(tp.fx, tp.fy), side: DIR_SIDE[worldDir(b, tSide)]! },
      labelPos,
      angleOf(seg.c1, p0),
      angleOf(seg.c2, q0)
    )
  }
  const dS = worldDir(b, sSide)
  const dT = worldDir(b, tSide)
  const p1 = { x: p0.x + DX[dS]! * d, y: p0.y + DY[dS]! * d }
  const q1 = { x: q0.x + DX[dT]! * d, y: q0.y + DY[dT]! * d }
  let mid: Pt[]
  const sH = dS === 0 || dS === 2
  const tH = dT === 0 || dT === 2
  const bb = aabb(b)
  if (sH !== tH) {
    // Adjacent sides: one corner off the shared box corner.
    mid = sH ? [{ x: p1.x, y: q1.y }] : [{ x: q1.x, y: p1.y }]
  } else if (dS === dT) {
    // Same side: a bracket.
    if (sH) {
      const far = dS === 0 ? Math.max(p1.x, q1.x) : Math.min(p1.x, q1.x)
      mid = [{ x: far, y: p1.y }, { x: far, y: q1.y }]
    } else {
      const far = dS === 1 ? Math.max(p1.y, q1.y) : Math.min(p1.y, q1.y)
      mid = [{ x: p1.x, y: far }, { x: q1.x, y: far }]
    }
  } else if (sH) {
    // Opposite left/right sides: over the top.
    const yy = bb.y1 - d
    mid = [{ x: p1.x, y: yy }, { x: q1.x, y: yy }]
  } else {
    // Opposite top/bottom sides: round the right.
    const xx = bb.x2 + d
    mid = [{ x: xx, y: p1.y }, { x: xx, y: q1.y }]
  }
  const points = simplifyPoints([p0, p1, ...mid, q1, q0])
  const a = lineAngles(points)
  return finish(
    points,
    buildLinePath(points, req.routing === 'orthogonal' ? cornerRadius : 0),
    { id: portId(sp.fx, sp.fy), side: DIR_SIDE[dS]! },
    { id: portId(tp.fx, tp.fy), side: DIR_SIDE[dT]! },
    labelPos,
    a.start,
    a.end
  )
}

// ── routeAll ────────────────────────────────────────────────────────────────

// Proper crossing point of two segments (interiors only), or null.
export function segmentCrossing(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = d.x - c.x
  const sy = d.y - c.y
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-9) return null
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den
  const e = 1e-6
  if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return null
  return { x: a.x + rx * t, y: a.y + ry * t }
}

function isContainer(n: MapNode): boolean {
  return !!getShape(n.shape).container
}

export function routeAll(
  nodes: MapNode[],
  edges: MapEdge[],
  opts?: { lineJumps?: boolean; defaultRouting?: MapRouting; jumpRadius?: number; cornerRadius?: number; margin?: number; gridStep?: number }
): Map<string, Route> {
  const out = new Map<string, Route>()
  const byId = new Map<string, MapNode>()
  for (const n of nodes) byId.set(n.id, n)
  const boxes = new Map<string, Box>()
  for (const n of nodes) boxes.set(n.id, nodeBox(n))
  const obstacleList: Box[] = nodes.filter((n) => !n.hidden && !isContainer(n)).map((n) => boxes.get(n.id)!)
  const routeOpts: RouteOptions = { cornerRadius: opts?.cornerRadius, margin: opts?.margin, gridStep: opts?.gridStep }
  const routingOf = (e: MapEdge): MapRouting => e.routing ?? opts?.defaultRouting ?? 'orthogonal'
  // An edge may carry its own corner radius (0 = hard corners); else the page's.
  const cornerOf = (e: MapEdge): number => Math.max(0, e.cornerRadius ?? opts?.cornerRadius ?? 0)

  const valid = edges.filter((e) => {
    const s = byId.get(e.source)
    const t = byId.get(e.target)
    return !!s && !!t && !s.hidden && !t.hidden
  })

  const baseReq = (e: MapEdge): RouteRequest => {
    const s = byId.get(e.source)!
    const t = byId.get(e.target)!
    return {
      source: boxes.get(s.id)!,
      target: boxes.get(t.id)!,
      sourcePort: e.sourceHandle ?? null,
      targetPort: e.targetHandle ?? null,
      sourcePorts: shapePorts(s.shape),
      targetPorts: shapePorts(t.shape),
      routing: routingOf(e),
      waypoints: e.waypoints,
      labelPos: e.labelPos
    }
  }
  const obstaclesFor = (e: MapEdge): Box[] => obstacleList.filter((b) => b.id !== e.source && b.id !== e.target)

  // Self-loops count per node; parallel automatic edges grouped per pair.
  const loopCount = new Map<string, number>()
  const groups = new Map<string, MapEdge[]>()
  for (const e of valid) {
    if (e.source === e.target) continue
    const auto = !parsePort(e.sourceHandle) && !parsePort(e.targetHandle) && !(e.waypoints && e.waypoints.length)
    if (!auto) continue
    const key = e.source < e.target ? `${e.source}\u0000${e.target}` : `${e.target}\u0000${e.source}`
    const g = groups.get(key)
    if (g) g.push(e)
    else groups.set(key, [e])
  }
  const handled = new Set<string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    routeParallel(group, baseReq, obstaclesFor, routeOpts).forEach((r, id) => out.set(id, r))
    for (const e of group) handled.add(e.id)
  }
  for (const e of valid) {
    if (handled.has(e.id)) continue
    const req = baseReq(e)
    if (e.source === e.target) {
      const k = loopCount.get(e.source) ?? 0
      loopCount.set(e.source, k + 1)
      req.loopIndex = k
    }
    out.set(e.id, routeEdge(req, obstaclesFor(e), e.cornerRadius !== undefined ? { ...routeOpts, cornerRadius: e.cornerRadius } : routeOpts))
  }

  if (opts?.lineJumps) applyLineJumps(valid, out, routingOf, Math.max(1, opts.jumpRadius ?? 5), cornerOf)
  // Keep the caller's edge order in the map.
  const ordered = new Map<string, Route>()
  for (const e of edges) {
    const r = out.get(e.id)
    if (r) ordered.set(e.id, r)
  }
  return ordered
}

function countCrossings(a: Pt[], b: Pt[]): number {
  let n = 0
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) if (segmentCrossing(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) n++
  return n
}

// Parallel edges between one pair: route the first, then fan every edge out
// along the same two sides so they run side by side instead of on top of
// each other. Both fan orders are tried; the one with fewer crossings wins.
function routeParallel(group: MapEdge[], baseReq: (e: MapEdge) => RouteRequest, obstaclesFor: (e: MapEdge) => Box[], opts: RouteOptions): Map<string, Route> {
  const first = group[0]!
  const r0 = routeEdge(baseReq(first), obstaclesFor(first), opts)
  const aId = first.source
  const portA = parsePort(r0.sourcePort) ?? { fx: 0.5, fy: 0.5 }
  const portB = parsePort(r0.targetPort) ?? { fx: 0.5, fy: 0.5 }
  const reqA = baseReq(first)
  const boxA = reqA.source
  const boxB = reqA.target
  const spacing = 12
  const n = group.length
  const localSide = (fx: number, fy: number): Side => sideOf(fx, fy)
  const shifted = (box: Box, base: { fx: number; fy: number }, offset: number): string => {
    const side = localSide(base.fx, base.fy)
    if (side === 'left' || side === 'right') {
      const fy = Math.min(0.9, Math.max(0.1, base.fy + offset / Math.max(1, box.h)))
      return portId(side === 'left' ? 0 : 1, fy)
    }
    const fx = Math.min(0.9, Math.max(0.1, base.fx + offset / Math.max(1, box.w)))
    return portId(fx, side === 'top' ? 0 : 1)
  }
  let best: Map<string, Route> | null = null
  let bestCross = Infinity
  const combos: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ]
  for (const [sign, csign] of combos) {
    const res = new Map<string, Route>()
    group.forEach((e, i) => {
      const off = (i - (n - 1) / 2) * spacing
      const pa = shifted(boxA, portA, off)
      const pb = shifted(boxB, portB, off * sign)
      const req = baseReq(e)
      req.channelOffset = off * csign
      if (e.source === aId) {
        req.sourcePort = pa
        req.targetPort = pb
      } else {
        req.sourcePort = pb
        req.targetPort = pa
      }
      res.set(e.id, routeEdge(req, obstaclesFor(e), opts))
    })
    const list = [...res.values()]
    let cross = 0
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) cross += countCrossings(list[i]!.points, list[j]!.points)
    if (cross < bestCross) {
      bestCross = cross
      best = res
    }
    if (cross === 0) break
  }
  return best!
}

// Lucid-style line jumps: a later edge hops where its (more) horizontal
// segment crosses an earlier edge's (more) vertical segment. Only `path`
// changes; points, length and label stay on the real line.
function applyLineJumps(edges: MapEdge[], routes: Map<string, Route>, routingOf: (e: MapEdge) => MapRouting, radius: number, cornerOf: (e: MapEdge) => number): void {
  const eligible = edges.filter((e) => routingOf(e) !== 'curved' && routes.has(e.id))
  for (let i = 1; i < eligible.length; i++) {
    const e = eligible[i]!
    const route = routes.get(e.id)!
    const pts = route.points
    const cornerRadius = cornerOf(e)
    const hops = new Map<number, number[]>()
    for (let s = 1; s < pts.length; s++) {
      const a = pts[s - 1]!
      const b = pts[s]!
      const len = dist(a, b)
      if (Math.abs(b.x - a.x) < Math.abs(b.y - a.y) || len < 2 * radius + 2) continue
      const trimA = s - 1 > 0 ? cornerRadius : 0
      const trimB = s < pts.length - 1 ? cornerRadius : 0
      const found: number[] = []
      for (let j = 0; j < i; j++) {
        const other = routes.get(eligible[j]!.id)!.points
        for (let t = 1; t < other.length; t++) {
          const c = other[t - 1]!
          const d = other[t]!
          if (Math.abs(d.y - c.y) <= Math.abs(d.x - c.x)) continue
          const x = segmentCrossing(a, b, c, d)
          if (!x) continue
          const at = dist(a, x)
          if (at - radius < trimA + 1 || at + radius > len - trimB - 1) continue
          found.push(at)
        }
      }
      if (!found.length) continue
      found.sort((p, q) => p - q)
      const kept: number[] = []
      for (const f of found) if (!kept.length || f - kept[kept.length - 1]! >= 2 * radius + 1) kept.push(f)
      hops.set(s - 1, kept)
    }
    if (!hops.size) continue
    const corner = routingOf(e) === 'orthogonal' ? cornerRadius : 0
    routes.set(e.id, { ...route, path: buildLinePath(pts, corner, hops, radius) })
  }
}
