// Obstacle-avoiding orthogonal connector routing for the diagram app.
//
// What was there before: edgeSvg drew a straight line between two node border
// points. With three boxes in a row, the connector from the first to the third
// went straight through the second. That single behaviour is most of why the
// diagram app reads as weak next to Lucidchart, whose connectors leave a shape
// at a sensible side, turn at right angles, and go around whatever is in the
// way.
//
// Pure and dependency-free, like mapAlign.ts beside it: no React, no DOM, no
// document model. It takes rectangles and returns points, which is what makes
// it testable without a canvas.
//
// The algorithm is the standard one for this problem rather than anything
// clever, because "clever" here means "routes differently on Tuesdays":
//
//   1. Pick which side of each box the connector leaves and enters, from their
//      relative positions.
//   2. Step off each box by a clearance so the line never hugs an edge.
//   3. Build a sparse grid from the interesting coordinates only — every
//      obstacle's edges expanded by the clearance, plus the two stubs. A full
//      pixel grid would be thousands of nodes for the same answer.
//   4. A* across that grid, refusing any segment that crosses an obstacle, with
//      a penalty per turn so the result prefers few bends over a short path.
//   5. Drop collinear points, so the output is the corner list a person would
//      have drawn.
//
// When no route exists — a box fully enclosed by others, say — it returns a
// straight line rather than nothing. A connector in the wrong place is a
// cosmetic problem; a connector that vanishes looks like data loss.

export interface RouteRect {
  x: number
  y: number
  w: number
  h: number
}

export interface RoutePoint {
  x: number
  y: number
}

export type RouteSide = 'left' | 'right' | 'top' | 'bottom'

export interface RouteOptions {
  /** Gap kept between the line and any box. Also the stub length. */
  clearance?: number
  /** Added cost per corner, in pixels of path length. Higher = straighter. */
  turnPenalty?: number
  /** Force the side the line leaves/enters, instead of deriving it. */
  fromSide?: RouteSide
  toSide?: RouteSide
}

const DEFAULT_CLEARANCE = 16
const DEFAULT_TURN_PENALTY = 40

const cx = (r: RouteRect): number => r.x + r.w / 2
const cy = (r: RouteRect): number => r.y + r.h / 2

/** Grow a rectangle on every side. */
function inflate(r: RouteRect, by: number): RouteRect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 }
}

/**
 * Which side a connector should leave `a` by, heading for `b`.
 *
 * Compares the gaps on each axis rather than the raw centre delta, so two boxes
 * that overlap vertically but sit side by side connect left-to-right, which is
 * what someone drawing it would do.
 */
export function sideToward(a: RouteRect, b: RouteRect): RouteSide {
  const dx = cx(b) - cx(a)
  const dy = cy(b) - cy(a)
  // Overlap on an axis means that axis is not the one to travel along.
  const overlapX = b.x < a.x + a.w && a.x < b.x + b.w
  const overlapY = b.y < a.y + a.h && a.y < b.y + b.h
  if (overlapX && !overlapY) return dy > 0 ? 'bottom' : 'top'
  if (overlapY && !overlapX) return dx > 0 ? 'right' : 'left'
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top'
}

/** The point on a box's border for a given side, and the stub outside it. */
export function anchorOn(r: RouteRect, side: RouteSide, clearance: number): { at: RoutePoint; stub: RoutePoint } {
  switch (side) {
    case 'left':
      return { at: { x: r.x, y: cy(r) }, stub: { x: r.x - clearance, y: cy(r) } }
    case 'right':
      return { at: { x: r.x + r.w, y: cy(r) }, stub: { x: r.x + r.w + clearance, y: cy(r) } }
    case 'top':
      return { at: { x: cx(r), y: r.y }, stub: { x: cx(r), y: r.y - clearance } }
    default:
      return { at: { x: cx(r), y: r.y + r.h }, stub: { x: cx(r), y: r.y + r.h + clearance } }
  }
}

/** True when the point is strictly inside the rectangle. */
function inside(p: RoutePoint, r: RouteRect): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h
}

/**
 * True when an axis-aligned segment passes through a rectangle's interior.
 *
 * Touching an edge is allowed: the stubs sit exactly on the inflated boundary,
 * and treating that as a collision would make every route impossible.
 */
export function segmentHitsRect(a: RoutePoint, b: RoutePoint, r: RouteRect): boolean {
  const x1 = Math.min(a.x, b.x)
  const x2 = Math.max(a.x, b.x)
  const y1 = Math.min(a.y, b.y)
  const y2 = Math.max(a.y, b.y)
  return x1 < r.x + r.w && x2 > r.x && y1 < r.y + r.h && y2 > r.y
}

function uniqSorted(values: number[]): number[] {
  return [...new Set(values.map((v) => Math.round(v * 100) / 100))].sort((p, q) => p - q)
}

/**
 * Route one connector.
 *
 * `obstacles` should include the two endpoint boxes; they are skipped
 * automatically for the stubs that touch them.
 */
export function routeOrthogonal(
  from: RouteRect,
  to: RouteRect,
  obstacles: RouteRect[] = [],
  opts: RouteOptions = {}
): RoutePoint[] {
  const clearance = opts.clearance ?? DEFAULT_CLEARANCE
  const turnPenalty = opts.turnPenalty ?? DEFAULT_TURN_PENALTY
  const others = obstacles.filter((r) => r !== from && r !== to)

  /**
   * The side to use, preferring the natural one but moving to another port
   * when that stub would start inside a shape.
   *
   * A stub inside an obstacle cannot be routed away from, so the obstacle ends
   * up ignored and the connector drives straight through it. Picking a free
   * port instead is both the correct fix and what a person would do: if a box
   * is pressed against your target's left edge, you come in from below.
   */
  const pickSide = (box: RouteRect, toward: RouteRect, forced?: RouteSide): RouteSide => {
    if (forced) return forced
    const natural = sideToward(box, toward)
    const free = (side: RouteSide): boolean => {
      const { stub } = anchorOn(box, side, clearance)
      return !others.some((r) => inside(stub, r))
    }
    if (free(natural)) return natural
    // Try the remaining sides nearest-first, so a forced change is the
    // smallest one that works.
    const order: RouteSide[] =
      natural === 'left' || natural === 'right'
        ? ['top', 'bottom', natural === 'left' ? 'right' : 'left']
        : ['left', 'right', natural === 'top' ? 'bottom' : 'top']
    return order.find(free) ?? natural
  }

  const fromSide = pickSide(from, to, opts.fromSide)
  const toSide = pickSide(to, from, opts.toSide)

  const a = anchorOn(from, fromSide, clearance)
  const b = anchorOn(to, toSide, clearance)
  // The fallback is an ELBOW, not a straight line. A diagonal would be the one
  // non-orthogonal thing this module can emit, and callers that round corners
  // or draw arrowheads from the last segment would quietly mis-render it.
  const fallback = [a.at, a.stub, { x: b.stub.x, y: a.stub.y }, b.stub, b.at]

  // Obstacles are inflated so the line keeps its distance. The two endpoint
  // boxes are included but NOT inflated, which is the whole trick: inflating
  // them would swallow their own stubs, and excluding them altogether lets a
  // route run back through the box it just left — visible immediately when a
  // side is forced, where the connector leaves leftward and then crosses its
  // own shape to reach a target on the right.
  //
  // Inflation is applied per obstacle and backed off when it would swallow an
  // endpoint stub. Without that back-off the router fails in the most ordinary
  // layout there is: a box sitting near the target, whose inflated region
  // contains the target's own stub. A* then has an unreachable goal, gives up,
  // and the caller gets the fallback elbow — which goes straight through the
  // obstacle. So the visible symptom of over-inflation was "avoidance stops
  // working entirely", not "lines sit a bit close".
  const stubs = [a.stub, b.stub]
  const swallowsStub = (r: RouteRect): boolean => stubs.some((p) => inside(p, r))
  const fit = (r: RouteRect): RouteRect | null => {
    const padded = inflate(r, clearance)
    if (!swallowsStub(padded)) return padded
    // Keep avoiding the real shape, just without the breathing room.
    return swallowsStub(r) ? null : r
  }
  const blockers = [
    ...others.map(fit).filter((r): r is RouteRect => r !== null),
    from,
    to
  ]

  const blocked = (p: RoutePoint, q: RoutePoint): boolean => blockers.some((r) => segmentHitsRect(p, q, r))

  // Nothing in the way: the simple elbow is the right answer and costs nothing
  // to check.
  if (!blocked(a.stub, { x: b.stub.x, y: a.stub.y }) && !blocked({ x: b.stub.x, y: a.stub.y }, b.stub))
    return simplify([a.at, a.stub, { x: b.stub.x, y: a.stub.y }, b.stub, b.at])
  if (!blocked(a.stub, { x: a.stub.x, y: b.stub.y }) && !blocked({ x: a.stub.x, y: b.stub.y }, b.stub))
    return simplify([a.at, a.stub, { x: a.stub.x, y: b.stub.y }, b.stub, b.at])

  // Sparse grid: only coordinates where a turn could usefully happen.
  const xs = uniqSorted([
    a.stub.x,
    b.stub.x,
    ...blockers.flatMap((r) => [r.x, r.x + r.w, cx(r)]),
    (a.stub.x + b.stub.x) / 2
  ])
  const ys = uniqSorted([
    a.stub.y,
    b.stub.y,
    ...blockers.flatMap((r) => [r.y, r.y + r.h, cy(r)]),
    (a.stub.y + b.stub.y) / 2
  ])

  const key = (xi: number, yi: number): number => yi * xs.length + xi
  const startX = xs.indexOf(Math.round(a.stub.x * 100) / 100)
  const startY = ys.indexOf(Math.round(a.stub.y * 100) / 100)
  const goalX = xs.indexOf(Math.round(b.stub.x * 100) / 100)
  const goalY = ys.indexOf(Math.round(b.stub.y * 100) / 100)
  if (startX < 0 || startY < 0 || goalX < 0 || goalY < 0) return simplify(fallback)

  const pointAt = (xi: number, yi: number): RoutePoint => ({ x: xs[xi], y: ys[yi] })
  const passable = (xi: number, yi: number): boolean => {
    const p = pointAt(xi, yi)
    return !blockers.some((r) => inside(p, r))
  }

  interface Node {
    xi: number
    yi: number
    g: number
    f: number
    dir: 'h' | 'v' | null
    prev: Node | null
  }
  const h = (xi: number, yi: number): number =>
    Math.abs(xs[xi] - b.stub.x) + Math.abs(ys[yi] - b.stub.y)

  // The first step may not go back the way the stub came. Without this the
  // router happily leaves a box on its left, returns immediately through the
  // anchor it just used, and carries on right — correct by every collision
  // test and obviously wrong to look at. Most visible when a side is forced,
  // but it can happen whenever doubling back is the shorter path.
  const back: RoutePoint = { x: a.at.x - a.stub.x, y: a.at.y - a.stub.y }
  const open: Node[] = [{ xi: startX, yi: startY, g: 0, f: h(startX, startY), dir: null, prev: null }]
  const best = new Map<number, number>([[key(startX, startY), 0]])
  let goal: Node | null = null
  // Bounded so a pathological graph cannot hang the renderer; the grid is
  // small, so this is a safety net rather than a real limit.
  let guard = 20000

  while (open.length && guard-- > 0) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i
    const cur = open.splice(bi, 1)[0]
    if (cur.xi === goalX && cur.yi === goalY) {
      goal = cur
      break
    }
    const steps: Array<[number, number, 'h' | 'v']> = [
      [cur.xi + 1, cur.yi, 'h'],
      [cur.xi - 1, cur.yi, 'h'],
      [cur.xi, cur.yi + 1, 'v'],
      [cur.xi, cur.yi - 1, 'v']
    ]
    for (const [nx, ny, dir] of steps) {
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue
      if (!passable(nx, ny)) continue
      const p = pointAt(cur.xi, cur.yi)
      const q = pointAt(nx, ny)
      if (!cur.prev && Math.sign(q.x - p.x) === Math.sign(back.x) && Math.sign(q.y - p.y) === Math.sign(back.y))
        continue
      if (blocked(p, q)) continue
      const step = Math.abs(q.x - p.x) + Math.abs(q.y - p.y)
      const g = cur.g + step + (cur.dir && cur.dir !== dir ? turnPenalty : 0)
      const k = key(nx, ny)
      if (best.has(k) && (best.get(k) as number) <= g) continue
      best.set(k, g)
      open.push({ xi: nx, yi: ny, g, f: g + h(nx, ny), dir, prev: cur })
    }
  }

  if (!goal) return simplify(fallback)
  const path: RoutePoint[] = []
  for (let n: Node | null = goal; n; n = n.prev) path.unshift(pointAt(n.xi, n.yi))
  return simplify([a.at, ...path, b.at])
}

/**
 * Drop points that sit on a straight run between their neighbours, and
 * collapse exact duplicates. The grid produces many collinear steps; a person
 * reading the shape only cares about the corners.
 */
export function simplify(points: RoutePoint[]): RoutePoint[] {
  const same = (p: RoutePoint, q: RoutePoint): boolean =>
    Math.abs(p.x - q.x) < 0.01 && Math.abs(p.y - q.y) < 0.01
  const dedupe = (pts: RoutePoint[]): RoutePoint[] => {
    const acc: RoutePoint[] = []
    for (const p of pts) if (!acc.length || !same(acc[acc.length - 1], p)) acc.push(p)
    return acc
  }
  // Deduped BEFORE and AFTER the collinear pass. Removing a collinear midpoint
  // can leave its neighbours adjacent and identical — a there-and-back pair
  // around a dropped point — so one pass up front is not enough.
  const out = dedupe(points)
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1]
    const b = out[i]
    const c = out[i + 1]
    const collinear =
      (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) ||
      (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)
    if (collinear) out.splice(i, 1)
  }
  return dedupe(out)
}

/** An SVG path `d` for a point list, with optional rounded corners. */
export function routeToPath(points: RoutePoint[], radius = 0): string {
  if (points.length < 2) return ''
  if (radius <= 0) return points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
  const parts: string[] = [`M${points[0].x} ${points[0].y}`]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]
    // Never round by more than half of either leg, or adjacent corners overlap
    // and the line visibly kinks.
    const r = Math.min(
      radius,
      Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2
    )
    if (r < 0.5) {
      parts.push(`L${cur.x} ${cur.y}`)
      continue
    }
    const t1 = { x: cur.x + Math.sign(prev.x - cur.x) * r, y: cur.y + Math.sign(prev.y - cur.y) * r }
    const t2 = { x: cur.x + Math.sign(next.x - cur.x) * r, y: cur.y + Math.sign(next.y - cur.y) * r }
    parts.push(`L${t1.x} ${t1.y}`, `Q${cur.x} ${cur.y} ${t2.x} ${t2.y}`)
  }
  const last = points[points.length - 1]
  parts.push(`L${last.x} ${last.y}`)
  return parts.join(' ')
}
