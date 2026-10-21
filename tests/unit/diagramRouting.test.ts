import { describe, it, expect } from 'vitest'
import {
  routeEdge,
  routeAll,
  pathFromPoints,
  pointAlong,
  nearestT,
  trimPoints,
  type Route
} from '../../src/shared/diagram/routing'
import { arrowHeadPath, arrowInset, ARROW_HEADS } from '../../src/shared/diagram/arrowheads'
import type { Box, Pt } from '../../src/shared/diagram/geom'
import type { MapArrowHead, MapEdge, MapNode } from '../../src/shared/types'

// ── helpers ─────────────────────────────────────────────────────────────────

const box = (id: string, x: number, y: number, w = 120, h = 60, rotation?: number): Box => ({
  id,
  x,
  y,
  w,
  h,
  ...(rotation ? { rotation } : {})
})

const node = (id: string, x: number, y: number, extra: Partial<MapNode> = {}): MapNode => ({
  id,
  x,
  y,
  label: id,
  shape: 'process',
  color: '#333',
  width: 120,
  height: 60,
  ...extra
})

const edge = (id: string, source: string, target: string, extra: Partial<MapEdge> = {}): MapEdge => ({ id, source, target, ...extra })

function axisAligned(points: Pt[]): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) return false
  }
  return true
}

function samples(points: Pt[], step = 2): Pt[] {
  const out: Pt[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const l = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(l / step))
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
  }
  return out
}

const insideDeflated = (p: Pt, b: Box, d = 1): boolean => p.x > b.x + d && p.x < b.x + b.w - d && p.y > b.y + d && p.y < b.y + b.h - d

// Minimal SVG path validator: known commands with the right number of args.
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
function validPath(d: string): boolean {
  if (!/^\s*M/.test(d)) return false
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g)
  if (!tokens || tokens.join('').length === 0) return false
  if (/[^MLHVCSQTAZmlhvcsqtaz0-9.,\s\-e+]/.test(d)) return false
  let i = 0
  while (i < tokens.length) {
    const cmd = tokens[i]!.toUpperCase()
    if (!(cmd in ARGS)) return false
    i++
    const nums: number[] = []
    while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]!)) nums.push(Number(tokens[i++]))
    if (nums.some((n) => !Number.isFinite(n))) return false
    const need = ARGS[cmd]!
    if (need === 0 ? nums.length !== 0 : nums.length === 0 || nums.length % need !== 0) return false
  }
  return true
}

function onPolyline(p: Pt, points: Pt[], tol = 1e-6): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0
    if (Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t)) <= tol) return true
  }
  return false
}

const ortho = (source: Box, target: Box, obstacles: Box[] = [], extra: Record<string, unknown> = {}): Route =>
  routeEdge({ source, target, routing: 'orthogonal', ...extra }, obstacles)

// ── orthogonal ──────────────────────────────────────────────────────────────

describe('routing — orthogonal', () => {
  it('produces only horizontal and vertical segments', () => {
    const cases: [Box, Box][] = [
      [box('a', 0, 0), box('b', 300, 0)],
      [box('a', 0, 0), box('b', 300, 200)],
      [box('a', 0, 0), box('b', -250, 300)],
      [box('a', 0, 0), box('b', 40, 260)],
      [box('a', 0, 0), box('b', 0, -300)],
      [box('a', 0, 0, 120, 60, 30), box('b', 300, 140, 100, 80, 15)]
    ]
    for (const [s, t] of cases) {
      const r = ortho(s, t)
      expect(r.points.length).toBeGreaterThanOrEqual(2)
      expect(axisAligned(r.points)).toBe(true)
      expect(r.length).toBeGreaterThan(0)
    }
  })

  it('A left of B connects right side to left side with a straight line', () => {
    const r = ortho(box('a', 0, 0), box('b', 300, 0))
    expect(r.sourceSide).toBe('right')
    expect(r.targetSide).toBe('left')
    expect(r.sourcePort).toBe('right')
    expect(r.targetPort).toBe('left')
    expect(r.points).toEqual([
      { x: 120, y: 30 },
      { x: 300, y: 30 }
    ])
    expect(r.endAngle).toBeCloseTo(0)
    expect(r.startAngle).toBeCloseTo(180)
  })

  it('automatic ports face each other in every direction', () => {
    const a = box('a', 0, 0)
    expect(ortho(a, box('b', -300, 0))).toMatchObject({ sourceSide: 'left', targetSide: 'right' })
    expect(ortho(a, box('b', 0, 250))).toMatchObject({ sourceSide: 'bottom', targetSide: 'top' })
    expect(ortho(a, box('b', 0, -250))).toMatchObject({ sourceSide: 'top', targetSide: 'bottom' })
    // Mostly horizontal with an offset: still right → left (a centred Z).
    const z = ortho(a, box('b', 360, 90))
    expect(z).toMatchObject({ sourceSide: 'right', targetSide: 'left' })
    expect(z.points).toHaveLength(4)
    // The vertical run sits in the middle of the gap between the shapes.
    expect(z.points[1]!.x).toBeCloseTo((120 + 360) / 2)
  })

  it('respects explicit ports', () => {
    const r = ortho(box('a', 0, 0), box('b', 300, 0), [], { sourcePort: 'bottom', targetPort: 'top' })
    expect(r.sourcePort).toBe('bottom')
    expect(r.targetPort).toBe('top')
    expect(r.points[0]).toEqual({ x: 60, y: 60 })
    expect(r.points[r.points.length - 1]).toEqual({ x: 360, y: 0 })
    expect(axisAligned(r.points)).toBe(true)
    // Leaves downward and arrives downward.
    expect(r.points[1]!.y).toBeGreaterThan(60)
    expect(r.endAngle).toBeCloseTo(90)

    const f = ortho(box('a', 0, 0), box('b', 300, 0), [], { sourcePort: 'p:1:0.25', targetPort: 'p:0:0.75' })
    expect(f.points[0]).toEqual({ x: 120, y: 15 })
    expect(f.points[f.points.length - 1]).toEqual({ x: 300, y: 45 })
  })

  it('routes around obstacles instead of through them', () => {
    const s = box('a', 0, 100)
    const t = box('b', 500, 100)
    const obstacles = [box('o1', 220, 60, 100, 140), box('o2', 230, -200, 60, 200)]
    const r = ortho(s, t, obstacles)
    expect(axisAligned(r.points)).toBe(true)
    expect(r.points.length).toBeGreaterThan(2)
    for (const p of samples(r.points)) {
      for (const o of [...obstacles, s, t]) expect(insideDeflated(p, o)).toBe(false)
    }
    // Keeps its clearance from the obstacle.
    for (const p of samples(r.points)) expect(insideDeflated(p, { id: 'm', x: 220 - 10, y: 60 - 10, w: 120, h: 160 })).toBe(false)
  })

  it('never cuts through its own source or target box', () => {
    // Target behind the source forces a route around the source.
    const s = box('a', 300, 0)
    const t = box('b', 0, 0)
    const r = ortho(s, t, [], { sourcePort: 'right', targetPort: 'left' })
    expect(axisAligned(r.points)).toBe(true)
    for (const p of samples(r.points)) {
      expect(insideDeflated(p, s)).toBe(false)
      expect(insideDeflated(p, t)).toBe(false)
    }
  })

  it('walls of obstacles are passed through a gap or around the end', () => {
    const s = box('a', 0, 200)
    const t = box('b', 600, 200)
    const wall = [box('w1', 300, 0, 40, 180), box('w2', 300, 280, 40, 200)]
    const r = ortho(s, t, wall)
    for (const p of samples(r.points)) for (const o of wall) expect(insideDeflated(p, o)).toBe(false)
  })

  it('falls back to an elbow when boxed in completely', () => {
    const s = box('a', 0, 0)
    const t = box('b', 400, 0)
    // A ring of obstacles closing the target off.
    const ring = [box('n', 360, -60, 200, 30), box('s', 360, 90, 200, 30), box('w', 360, -60, 20, 180), box('e', 540, -60, 20, 180)]
    const r = ortho(s, t, ring)
    expect(r.points.length).toBeGreaterThanOrEqual(2)
    expect(axisAligned(r.points)).toBe(true)
    expect(validPath(r.path)).toBe(true)
  })

  it('passes through waypoints in order, still orthogonal', () => {
    const wps = [
      { x: 200, y: -100 },
      { x: 300, y: 200 }
    ]
    const r = ortho(box('a', 0, 0), box('b', 500, 0), [], { waypoints: wps })
    expect(axisAligned(r.points)).toBe(true)
    let lastT = -1
    for (const w of wps) {
      expect(onPolyline(w, r.points)).toBe(true)
      const t = nearestT(r.points, w)
      expect(t).toBeGreaterThan(lastT)
      lastT = t
    }
  })

  it('rounded corners use quadratic curves', () => {
    const r = routeEdge({ source: box('a', 0, 0), target: box('b', 300, 200), routing: 'orthogonal' }, [], { cornerRadius: 8 })
    expect(r.path).toMatch(/Q/)
    expect(validPath(r.path)).toBe(true)
  })
})

// ── straight & curved ───────────────────────────────────────────────────────

describe('routing — straight and curved', () => {
  it('straight attaches on the centre line at the box border', () => {
    const r = routeEdge({ source: box('a', 0, 0), target: box('b', 300, 140), routing: 'straight' }, [])
    expect(validPath(r.path)).toBe(true)
    expect(r.points).toHaveLength(2)
    // On the line between centres (60,30) → (360,170).
    const [p, q] = r.points as [Pt, Pt]
    const cross = (b: Pt): number => (360 - 60) * (b.y - 30) - (170 - 30) * (b.x - 60)
    expect(Math.abs(cross(p))).toBeLessThan(1e-6)
    expect(Math.abs(cross(q))).toBeLessThan(1e-6)
    expect(p.x).toBeCloseTo(120) // right border of a
    expect(q.x).toBeCloseTo(300) // left border of b
  })

  it('straight respects rotated boxes', () => {
    const s = box('a', 0, 0, 120, 60, 90) // now 60 wide, 120 tall around (60,30)
    const r = routeEdge({ source: s, target: box('b', 0, 300), routing: 'straight' }, [])
    // Leaves from the rotated box's bottom, 60px below the centre.
    expect(r.points[0]!.x).toBeCloseTo(60)
    expect(r.points[0]!.y).toBeCloseTo(90)
  })

  it('straight goes through waypoints', () => {
    const w = { x: 200, y: 300 }
    const r = routeEdge({ source: box('a', 0, 0), target: box('b', 400, 0), routing: 'straight', waypoints: [w] }, [])
    expect(r.points.some((p) => p.x === w.x && p.y === w.y)).toBe(true)
    expect(validPath(r.path)).toBe(true)
  })

  it('curved produces a cubic Bézier path and a sampled polyline', () => {
    const r = routeEdge({ source: box('a', 0, 0), target: box('b', 300, 200), routing: 'curved' }, [])
    expect(r.path).toMatch(/^M[\d.,-]+ C/)
    expect(validPath(r.path)).toBe(true)
    expect(r.points.length).toBeGreaterThan(10)
    expect(r.points[0]).toEqual({ x: 120, y: 30 })
    expect(r.sourceSide).toBe('right')
  })

  it('curved goes through waypoints', () => {
    const wps = [
      { x: 200, y: 200 },
      { x: 350, y: -80 }
    ]
    const r = routeEdge({ source: box('a', 0, 0), target: box('b', 500, 0), routing: 'curved', waypoints: wps }, [])
    expect(validPath(r.path)).toBe(true)
    for (const w of wps) expect(r.points.some((p) => Math.hypot(p.x - w.x, p.y - w.y) < 1e-6)).toBe(true)
  })

  it('pathFromPoints handles every routing', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 }
    ]
    expect(pathFromPoints(pts, 'orthogonal')).toBe('M0,0 L100,0 L100,100')
    expect(pathFromPoints(pts, 'straight')).toBe('M0,0 L100,0 L100,100')
    expect(pathFromPoints(pts, 'orthogonal', { cornerRadius: 10 })).toBe('M0,0 L90,0 Q100,0 100,10 L100,100')
    expect(validPath(pathFromPoints(pts, 'curved'))).toBe(true)
    expect(pathFromPoints(pts, 'curved')).toMatch(/C/)
    expect(pathFromPoints([], 'straight')).toBe('')
  })
})

// ── labels and polyline queries ─────────────────────────────────────────────

describe('routing — labels', () => {
  it('labelPoint lies on the path at labelPos', () => {
    for (const routing of ['orthogonal', 'straight', 'curved'] as const) {
      for (const labelPos of [0, 0.25, 0.5, 0.9, 1]) {
        const r = routeEdge({ source: box('a', 0, 0), target: box('b', 300, 220), routing, labelPos }, [])
        expect(onPolyline(r.labelPoint, r.points, 1e-6)).toBe(true)
        expect(nearestT(r.points, r.labelPoint)).toBeCloseTo(labelPos, 3)
      }
    }
  })

  it('pointAlong / nearestT round-trip and trimPoints shortens both ends', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 }
    ]
    expect(pointAlong(pts, 0.5)).toEqual({ x: 100, y: 0 })
    expect(pointAlong(pts, 0.75)).toEqual({ x: 100, y: 50 })
    expect(nearestT(pts, { x: 130, y: 50 })).toBeCloseTo(0.75)
    const t = trimPoints(pts, 10, 20)
    expect(t[0]).toEqual({ x: 10, y: 0 })
    expect(t[t.length - 1]).toEqual({ x: 100, y: 80 })
  })
})

// ── routeAll ────────────────────────────────────────────────────────────────

describe('routing — routeAll', () => {
  it('routes every edge and avoids other nodes but not containers', () => {
    const nodes = [
      node('a', 0, 100),
      node('b', 500, 100),
      node('block', 220, 60, { width: 100, height: 140 }),
      node('lane', -100, -100, { shape: 'lane', width: 900, height: 500 }),
      node('ghost', 120, 90, { hidden: true, width: 380, height: 80 })
    ]
    const routes = routeAll(nodes, [edge('e1', 'a', 'b'), edge('dangling', 'a', 'nope')])
    expect(routes.size).toBe(1)
    const r = routes.get('e1')!
    expect(axisAligned(r.points)).toBe(true)
    for (const p of samples(r.points)) expect(insideDeflated(p, box('block', 220, 60, 100, 140))).toBe(false)
  })

  it('uses the edge routing, then the default routing', () => {
    const nodes = [node('a', 0, 0), node('b', 300, 200)]
    const routes = routeAll(nodes, [edge('e1', 'a', 'b'), edge('e2', 'b', 'a', { routing: 'curved' })], { defaultRouting: 'straight' })
    expect(routes.get('e1')!.points).toHaveLength(2)
    expect(routes.get('e2')!.path).toMatch(/C/)
  })

  it('self-loops draw a loop and nested loops differ', () => {
    const nodes = [node('a', 0, 0)]
    const routes = routeAll(nodes, [edge('l1', 'a', 'a'), edge('l2', 'a', 'a'), edge('l3', 'a', 'a', { routing: 'curved' })])
    const l1 = routes.get('l1')!
    const l2 = routes.get('l2')!
    expect(axisAligned(l1.points)).toBe(true)
    expect(l1.points.length).toBeGreaterThanOrEqual(4)
    expect(l1.path).not.toBe(l2.path)
    expect(l1.sourceSide).toBe('right')
    expect(l1.targetSide).toBe('top')
    // The loop stays outside the node.
    for (const p of samples(l1.points)) expect(insideDeflated(p, box('a', 0, 0))).toBe(false)
    expect(validPath(routes.get('l3')!.path)).toBe(true)
  })

  it('self-loops on one side or one port still open into a loop', () => {
    const b = box('a', 0, 0)
    for (const [sp, tp] of [
      ['right', 'right'],
      ['p:1:0.2', 'p:1:0.8'],
      ['left', 'right'],
      ['top', 'bottom']
    ]) {
      const r = routeEdge({ source: b, target: b, routing: 'orthogonal', sourcePort: sp, targetPort: tp }, [])
      expect(axisAligned(r.points)).toBe(true)
      expect(r.points.length).toBeGreaterThanOrEqual(4)
      expect(r.length).toBeGreaterThan(40)
      expect(r.points[0]).not.toEqual(r.points[r.points.length - 1])
      for (const p of samples(r.points)) expect(insideDeflated(p, b)).toBe(false)
    }
  })

  it('parallel edges between the same pair do not overlap', () => {
    for (const routing of ['orthogonal', 'straight', 'curved'] as const) {
      const nodes = [node('a', 0, 0), node('b', 400, 120)]
      const routes = routeAll(nodes, [edge('e1', 'a', 'b', { routing }), edge('e2', 'a', 'b', { routing }), edge('e3', 'b', 'a', { routing })])
      const paths = ['e1', 'e2', 'e3'].map((id) => routes.get(id)!.path)
      expect(new Set(paths).size).toBe(3)
      const starts = ['e1', 'e2'].map((id) => routes.get(id)!.points[0]!)
      expect(Math.hypot(starts[0]!.x - starts[1]!.x, starts[0]!.y - starts[1]!.y)).toBeGreaterThanOrEqual(8)
    }
  })

  it('line jumps add arcs only when enabled and lines cross', () => {
    // e1 is vertical, e2 horizontal and crosses it.
    const nodes = [node('top', 200, 0), node('bottom', 200, 400), node('left', 0, 200), node('right', 400, 200)]
    const edges = [edge('v', 'top', 'bottom'), edge('h', 'left', 'right')]
    const off = routeAll(nodes, edges)
    expect(off.get('h')!.path).not.toMatch(/A/)
    const on = routeAll(nodes, edges, { lineJumps: true })
    expect(on.get('h')!.path).toMatch(/A5,5 0 0 1/)
    expect(validPath(on.get('h')!.path)).toBe(true)
    // The earlier (vertical) edge does not hop, and points are unchanged.
    expect(on.get('v')!.path).not.toMatch(/A/)
    expect(on.get('h')!.points).toEqual(off.get('h')!.points)
    // No crossing → no arcs even with jumps on.
    const apart = routeAll([node('a', 0, 0), node('b', 300, 0), node('c', 0, 300), node('d', 300, 300)], [edge('x', 'a', 'b'), edge('y', 'c', 'd')], {
      lineJumps: true
    })
    for (const r of apart.values()) expect(r.path).not.toMatch(/A/)
    // Custom radius.
    expect(routeAll(nodes, edges, { lineJumps: true, jumpRadius: 8 }).get('h')!.path).toMatch(/A8,8/)
  })

  it('routes 150 nodes / 200 edges quickly', () => {
    let seed = 42
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const nodes: MapNode[] = []
    for (let i = 0; i < 150; i++) {
      const col = i % 15
      const row = Math.floor(i / 15)
      nodes.push(node(`n${i}`, col * 220 + Math.floor(rand() * 40), row * 160 + Math.floor(rand() * 30)))
    }
    const edges: MapEdge[] = []
    for (let i = 0; i < 200; i++) {
      const a = Math.floor(rand() * 150)
      let b = Math.floor(rand() * 150)
      if (b === a) b = (a + 1) % 150
      edges.push(edge(`e${i}`, `n${a}`, `n${b}`))
    }
    const t0 = performance.now()
    const routes = routeAll(nodes, edges, { lineJumps: true })
    const ms = performance.now() - t0
    expect(routes.size).toBe(200)
    for (const r of routes.values()) {
      expect(axisAligned(r.points)).toBe(true)
      expect(validPath(r.path)).toBe(true)
    }
    expect(ms).toBeLessThan(3000)
  })
})

// ── arrowheads ──────────────────────────────────────────────────────────────

describe('arrowheads', () => {
  const kinds: MapArrowHead[] = [
    'none',
    'arrow',
    'open',
    'triangle',
    'diamond',
    'diamondOpen',
    'circle',
    'circleOpen',
    'bar',
    'crowOne',
    'crowMany',
    'crowOneOrMany',
    'crowZeroOrOne',
    'crowZeroOrMany'
  ]

  it('lists every kind', () => {
    expect([...ARROW_HEADS].sort()).toEqual([...kinds].sort())
  })

  it('every kind returns valid paths with a fill mode', () => {
    for (const k of kinds) {
      const pieces = arrowHeadPath(k, { x: 100, y: 50 }, 30, 12)
      if (k === 'none') {
        expect(pieces).toEqual([])
        continue
      }
      expect(pieces.length).toBeGreaterThan(0)
      for (const p of pieces) {
        expect(validPath(p.d)).toBe(true)
        expect(['stroke', 'none', 'background']).toContain(p.fill)
      }
      expect(arrowInset(k, 12)).toBeGreaterThanOrEqual(0)
    }
  })

  it('fills match the head style', () => {
    expect(arrowHeadPath('arrow', { x: 0, y: 0 }, 0, 10)[0]!.fill).toBe('stroke')
    expect(arrowHeadPath('triangle', { x: 0, y: 0 }, 0, 10)[0]!.fill).toBe('background')
    expect(arrowHeadPath('open', { x: 0, y: 0 }, 0, 10)[0]!.fill).toBe('none')
    expect(arrowHeadPath('diamond', { x: 0, y: 0 }, 0, 10)[0]!.fill).toBe('stroke')
    expect(arrowHeadPath('diamondOpen', { x: 0, y: 0 }, 0, 10)[0]!.fill).toBe('background')
    expect(arrowHeadPath('crowZeroOrMany', { x: 0, y: 0 }, 0, 10).map((p) => p.fill)).toEqual(['none', 'background'])
  })

  it('points along the angle with the tip at the endpoint', () => {
    // Pointing right (angle 0): the body lies to the LEFT of the tip.
    const d = arrowHeadPath('arrow', { x: 100, y: 50 }, 0, 10)[0]!.d
    expect(d.startsWith('M100,50')).toBe(true)
    const xs = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[1]))
    expect(Math.max(...xs)).toBeCloseTo(100)
    expect(Math.min(...xs)).toBeCloseTo(90)
    // Pointing down (angle 90): body above the tip.
    const dn = arrowHeadPath('arrow', { x: 100, y: 50 }, 90, 10)[0]!.d
    const ys = [...dn.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]))
    expect(Math.max(...ys)).toBeCloseTo(50)
    expect(Math.min(...ys)).toBeCloseTo(40)
  })

  it('insets solid and hollow heads, not open marks', () => {
    expect(arrowInset('none', 10)).toBe(0)
    expect(arrowInset('open', 10)).toBe(0)
    expect(arrowInset('crowMany', 10)).toBe(0)
    expect(arrowInset('arrow', 10)).toBeGreaterThan(0)
    expect(arrowInset('triangle', 10)).toBeGreaterThan(0)
    expect(arrowInset('diamond', 10)).toBeGreaterThan(arrowInset('arrow', 10))
  })
})
