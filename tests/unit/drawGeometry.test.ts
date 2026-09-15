import { describe, it, expect } from 'vitest'
import {
  booleanPath,
  ellipsePath,
  flattenPath,
  fitPathToBox,
  hitPath,
  pathBounds,
  pathFromPoints,
  pathToSvgD,
  pointInPath,
  polygonArea,
  polygonPath,
  rectPath,
  roundRectPath,
  simplifyPolyline,
  smoothPathFromPoints,
  starPath,
  transformPath,
  translatePath,
  pt,
  type DrawPath
} from '../../src/shared/drawGeometry'

// The total absolute area of every ring in a path, used to assert boolean
// results by measure rather than by exact vertex lists (which legitimately vary
// with where the flattener happened to split a curve).
function area(p: DrawPath): number {
  return flattenPath(p, 0.05).reduce((sum, ring) => sum + Math.abs(polygonArea(ring)), 0)
}
// Signed area, so a hole (wound the other way) cancels its outer ring.
function netArea(p: DrawPath): number {
  return Math.abs(flattenPath(p, 0.05).reduce((sum, ring) => sum + polygonArea(ring), 0))
}

describe('drawGeometry — shape builders', () => {
  it('a rect has exactly its own bounds and area', () => {
    const r = rectPath(10, 20, 100, 50)
    expect(pathBounds(r)).toEqual({ x: 10, y: 20, w: 100, h: 50 })
    expect(area(r)).toBeCloseTo(5000, 3)
  })

  it('a round rect keeps its bounds and loses only the corners', () => {
    const r = roundRectPath(0, 0, 100, 100, 20)
    const b = pathBounds(r)
    expect(b.x).toBeCloseTo(0, 2)
    expect(b.y).toBeCloseTo(0, 2)
    expect(b.w).toBeCloseTo(100, 2)
    expect(b.h).toBeCloseTo(100, 2)
    // Four quarter-circles of r=20 replace four 20x20 corners.
    const lost = 4 * (400 - Math.PI * 100)
    // Flattening inscribes the arcs, so the measured area is a hair under the
    // true one — assert within 0.1% rather than to a fixed number of decimals.
    expect(area(r)).toBeGreaterThan((10000 - lost) * 0.999)
    expect(area(r)).toBeLessThanOrEqual(10000 - lost)
  })

  it('a round rect with a radius bigger than the box clamps to a stadium', () => {
    const r = roundRectPath(0, 0, 40, 100, 999)
    const b = pathBounds(r)
    expect(b.w).toBeCloseTo(40, 2)
    expect(b.h).toBeCloseTo(100, 2)
  })

  it('an ellipse approximates pi*rx*ry', () => {
    const e = ellipsePath(50, 50, 40, 25)
    expect(area(e)).toBeGreaterThan(Math.PI * 40 * 25 * 0.999)
    expect(area(e)).toBeLessThanOrEqual(Math.PI * 40 * 25)
    expect(pathBounds(e).w).toBeCloseTo(80, 2)
  })

  it('a regular polygon has the inscribed-polygon area', () => {
    const hex = polygonPath(0, 0, 100, 6)
    expect(area(hex)).toBeCloseTo((6 / 2) * 100 * 100 * Math.sin((2 * Math.PI) / 6), 2)
  })

  it('a star alternates outer and inner radii', () => {
    const s = starPath(0, 0, 100, 5, 0.5)
    expect(s.subpaths[0].nodes).toHaveLength(10)
    expect(area(s)).toBeLessThan(area(polygonPath(0, 0, 100, 10)))
  })
})

describe('drawGeometry — transforms', () => {
  it('translate moves anchors and handles together', () => {
    const e = translatePath(ellipsePath(0, 0, 10, 10), 5, 7)
    const n = e.subpaths[0].nodes[0]
    expect(n.x).toBeCloseTo(5, 6)
    expect(n.y).toBeCloseTo(-3, 6)
    expect(n.outX! - n.x).toBeCloseTo(10 * 0.5522847498307936, 6)
  })

  it('a 90-degree rotation swaps the bounding box axes', () => {
    const r = rectPath(0, 0, 100, 40)
    const rot = transformPath(r, [0, 1, -1, 0, 0, 0])
    const b = pathBounds(rot)
    expect(b.w).toBeCloseTo(40, 6)
    expect(b.h).toBeCloseTo(100, 6)
  })

  it('fitPathToBox scales a path onto an exact target box', () => {
    const fitted = fitPathToBox(ellipsePath(0, 0, 10, 10), { x: 100, y: 200, w: 50, h: 80 })
    const b = pathBounds(fitted)
    expect(b.x).toBeCloseTo(100, 2)
    expect(b.y).toBeCloseTo(200, 2)
    expect(b.w).toBeCloseTo(50, 2)
    expect(b.h).toBeCloseTo(80, 2)
  })
})

describe('drawGeometry — hit testing', () => {
  it('points inside and outside a rect', () => {
    const r = rectPath(0, 0, 100, 100)
    expect(pointInPath(r, pt(50, 50))).toBe(true)
    expect(pointInPath(r, pt(150, 50))).toBe(false)
  })

  it('evenodd treats a nested ring as a hole', () => {
    const donut: DrawPath = {
      fillRule: 'evenodd',
      subpaths: [...rectPath(0, 0, 100, 100).subpaths, ...rectPath(25, 25, 50, 50).subpaths]
    }
    expect(pointInPath(donut, pt(10, 10))).toBe(true)
    expect(pointInPath(donut, pt(50, 50))).toBe(false)
  })

  it('an unfilled path is still clickable along its stroke', () => {
    const line = pathFromPoints([pt(0, 0), pt(100, 0)], false)
    expect(hitPath(line, pt(50, 2), { filled: false, strokeWidth: 2 })).toBe(true)
    expect(hitPath(line, pt(50, 40), { filled: false, strokeWidth: 2 })).toBe(false)
  })
})

describe('drawGeometry — svg serialization', () => {
  it('straight segments emit L, curved segments emit C, closed paths emit Z', () => {
    expect(pathToSvgD(rectPath(0, 0, 10, 10))).toBe('M 0 0 L 10 0 L 10 10 L 0 10 Z')
    const d = pathToSvgD(ellipsePath(0, 0, 10, 10))
    expect(d.startsWith('M 0 -10 C')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
  })

  it('an open path emits no Z', () => {
    expect(pathToSvgD(pathFromPoints([pt(0, 0), pt(5, 5)], false))).toBe('M 0 0 L 5 5')
  })
})

describe('drawGeometry — freehand fitting', () => {
  it('simplify drops points already on the line', () => {
    const straight = Array.from({ length: 20 }, (_, i) => pt(i * 5, 0))
    expect(simplifyPolyline(straight, 0.5)).toHaveLength(2)
  })

  it('simplify keeps a genuine corner', () => {
    const bent = [pt(0, 0), pt(10, 0), pt(20, 0), pt(20, 10), pt(20, 20)]
    expect(simplifyPolyline(bent, 0.5)).toHaveLength(3)
  })

  it('smoothing gives interior nodes handles and leaves open ends bare', () => {
    const p = smoothPathFromPoints([pt(0, 0), pt(10, 10), pt(20, 0)], false)
    const [a, b, c] = p.subpaths[0].nodes
    expect(a.inX).toBeUndefined()
    expect(b.inX).toBeDefined()
    expect(b.outX).toBeDefined()
    expect(c.outX).toBeUndefined()
  })
})

describe('drawGeometry — boolean operations', () => {
  const A = rectPath(0, 0, 100, 100)
  const B = rectPath(50, 50, 100, 100) // overlaps A in a 50x50 corner

  it('union of two overlapping squares is the L-shape', () => {
    const u = booleanPath(A, B, 'union')
    expect(area(u)).toBeCloseTo(10000 + 10000 - 2500, 1)
    expect(pathBounds(u)).toEqual({ x: 0, y: 0, w: 150, h: 150 })
  })

  it('intersection is the shared corner', () => {
    const i = booleanPath(A, B, 'intersect')
    expect(area(i)).toBeCloseTo(2500, 1)
    const b = pathBounds(i)
    expect(b.x).toBeCloseTo(50, 3)
    expect(b.w).toBeCloseTo(50, 3)
  })

  it('subtract removes only the overlap', () => {
    const d = booleanPath(A, B, 'subtract')
    expect(area(d)).toBeCloseTo(7500, 1)
    expect(pointInPath(d, pt(10, 10))).toBe(true)
    expect(pointInPath(d, pt(75, 75))).toBe(false)
  })

  it('exclude is both differences and excludes the shared part', () => {
    const x = booleanPath(A, B, 'exclude')
    expect(area(x)).toBeCloseTo(7500 + 7500, 1)
    expect(pointInPath(x, pt(75, 75))).toBe(false)
    expect(pointInPath(x, pt(10, 10))).toBe(true)
    expect(pointInPath(x, pt(140, 140))).toBe(true)
  })

  it('disjoint shapes: union keeps both, intersect is empty', () => {
    const far = rectPath(500, 500, 10, 10)
    expect(area(booleanPath(A, far, 'union'))).toBeCloseTo(10100, 1)
    expect(booleanPath(A, far, 'intersect').subpaths).toHaveLength(0)
  })

  it('subtracting a fully enclosed shape leaves a real hole', () => {
    const hole = rectPath(25, 25, 50, 50)
    const d = booleanPath(A, hole, 'subtract')
    expect(d.subpaths.length).toBe(2)
    // The hole winds against the outer ring, so the SIGNED total is the real area.
    expect(netArea(d)).toBeCloseTo(10000 - 2500, 1)
    expect(pointInPath(d, pt(50, 50))).toBe(false)
    expect(pointInPath(d, pt(5, 5))).toBe(true)
  })

  it('a shape that fully contains the other: union is the container', () => {
    const inner = rectPath(25, 25, 50, 50)
    expect(area(booleanPath(A, inner, 'union'))).toBeCloseTo(10000, 1)
    expect(area(booleanPath(A, inner, 'intersect'))).toBeCloseTo(2500, 1)
  })

  it('identical shapes: union and intersect are that shape, subtract is empty', () => {
    const copy = rectPath(0, 0, 100, 100)
    expect(area(booleanPath(A, copy, 'union'))).toBeCloseTo(10000, 1)
    expect(area(booleanPath(A, copy, 'intersect'))).toBeCloseTo(10000, 1)
    expect(area(booleanPath(A, copy, 'subtract'))).toBeCloseTo(0, 3)
  })

  it('shapes sharing exactly one edge union into one rectangle with no sliver', () => {
    const right = rectPath(100, 0, 100, 100)
    const u = booleanPath(A, right, 'union')
    expect(area(u)).toBeCloseTo(20000, 1)
    expect(pathBounds(u)).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect(u.subpaths).toHaveLength(1)
  })

  it('curves work too — a circle minus an overlapping circle', () => {
    const c1 = ellipsePath(0, 0, 50, 50)
    const c2 = ellipsePath(50, 0, 50, 50)
    const d = booleanPath(c1, c2, 'subtract')
    // Two unit circles at distance r overlap in 2r²(π/3 − √3/4).
    const lens = 2 * 50 * 50 * (Math.PI / 3 - Math.sqrt(3) / 4)
    expect(area(d)).toBeCloseTo(Math.PI * 2500 - lens, -1)
  })

  it('an empty operand is handled without throwing', () => {
    const empty: DrawPath = { subpaths: [] }
    expect(area(booleanPath(A, empty, 'union'))).toBeCloseTo(10000, 1)
    expect(booleanPath(A, empty, 'intersect').subpaths).toHaveLength(0)
    expect(area(booleanPath(empty, A, 'union'))).toBeCloseTo(10000, 1)
  })
})
