// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { polygonBoolean, booleanPath, ringsArea, ringArea, pointInRings, type Ring } from '../../src/shared/drawBoolean'
import { rectPath, ellipsePath, flattenPath, pathBounds, type Pt } from '../../src/shared/drawGeometry'

// Booleans are graded by AREA, not by eye. Every case below has an answer
// known from arithmetic, so a wrong result is a number that does not match
// rather than a picture someone has to squint at.

const rect = (x: number, y: number, w: number, h: number): Ring => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h }
]

const near = (got: number, want: number, tol = 0.01): void => expect(Math.abs(got - want)).toBeLessThan(tol)

describe('ring helpers', () => {
  it('measures area and ignores winding direction for the total', () => {
    near(Math.abs(ringArea(rect(0, 0, 10, 10))), 100)
    near(ringsArea([rect(0, 0, 10, 10)]), 100)
  })

  it('tests containment even-odd, so a ring inside a ring is a hole', () => {
    const shell = rect(0, 0, 100, 100)
    const hole = rect(40, 40, 20, 20)
    expect(pointInRings({ x: 10, y: 10 }, [shell, hole])).toBe(true)
    expect(pointInRings({ x: 50, y: 50 }, [shell, hole])).toBe(false)
    expect(pointInRings({ x: -5, y: 50 }, [shell, hole])).toBe(false)
  })
})

describe('two overlapping squares', () => {
  // 100x100 at 0,0 and 100x100 at 50,50. Overlap is 50x50 = 2500.
  const a = [rect(0, 0, 100, 100)]
  const b = [rect(50, 50, 100, 100)]

  it('unite covers both minus the double-counted overlap', () => {
    near(ringsArea(polygonBoolean(a, b, 'unite')), 100 * 100 * 2 - 2500)
  })

  it('intersect is the overlap alone', () => {
    near(ringsArea(polygonBoolean(a, b, 'intersect')), 2500)
  })

  it('subtract removes the overlap from the first', () => {
    near(ringsArea(polygonBoolean(a, b, 'subtract')), 10000 - 2500)
  })

  it('exclude is both minus twice the overlap', () => {
    near(ringsArea(polygonBoolean(a, b, 'exclude')), 20000 - 2 * 2500)
  })

  it('subtract is not symmetric', () => {
    const ab = ringsArea(polygonBoolean(a, b, 'subtract'))
    const ba = ringsArea(polygonBoolean(b, a, 'subtract'))
    near(ab, 7500)
    near(ba, 7500)
    // Same area here because the squares are the same size; the shapes differ.
    const abBox = polygonBoolean(a, b, 'subtract')[0]
    const baBox = polygonBoolean(b, a, 'subtract')[0]
    expect(Math.min(...abBox.map((p) => p.x))).toBeLessThan(Math.min(...baBox.map((p) => p.x)))
  })
})

describe('disjoint shapes', () => {
  const a = [rect(0, 0, 10, 10)]
  const b = [rect(100, 100, 10, 10)]

  it('unite keeps both', () => {
    const u = polygonBoolean(a, b, 'unite')
    expect(u).toHaveLength(2)
    near(ringsArea(u), 200)
  })

  it('intersect is empty', () => {
    expect(polygonBoolean(a, b, 'intersect')).toEqual([])
  })

  it('subtract leaves the first untouched', () => {
    near(ringsArea(polygonBoolean(a, b, 'subtract')), 100)
  })
})

describe('one shape inside another', () => {
  const outer = [rect(0, 0, 100, 100)]
  const inner = [rect(25, 25, 50, 50)]

  it('unite is the outer shape', () => {
    near(ringsArea(polygonBoolean(outer, inner, 'unite')), 10000)
  })

  it('intersect is the inner shape', () => {
    near(ringsArea(polygonBoolean(outer, inner, 'intersect')), 2500)
  })

  it('subtract punches a real hole, as two rings of opposite winding', () => {
    const res = polygonBoolean(outer, inner, 'subtract')
    expect(res).toHaveLength(2)
    near(ringsArea(res), 10000 - 2500)
    // The hole must oppose its shell, or it fills in under any fill rule that
    // cares about direction.
    const [r1, r2] = res
    expect(Math.sign(ringArea(r1))).not.toBe(Math.sign(ringArea(r2)))
  })
})

describe('curves', () => {
  it('subtracting a circle from a square removes about the circle', () => {
    // Flattened, so the answer is close rather than exact: a polygon inscribed
    // in a circle is slightly smaller than the circle.
    const square = rectPath(0, 0, 200, 200)
    const circle = ellipsePath(100, 100, 50, 50)
    const out = booleanPath(square, circle, 'subtract', 0.1)
    const area = ringsArea(flattenPath(out, 0.1))
    const expected = 200 * 200 - Math.PI * 50 * 50
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.01)
  })

  it('marks the result even-odd, so a hole is a property of the geometry', () => {
    const out = booleanPath(rectPath(0, 0, 100, 100), rectPath(25, 25, 50, 50), 'subtract')
    expect(out.fillRule).toBe('evenodd')
    expect(out.subpaths).toHaveLength(2)
  })

  it('keeps the result inside the bounds of its operands', () => {
    const a = rectPath(0, 0, 100, 60)
    const b = ellipsePath(80, 30, 40, 40)
    const u = booleanPath(a, b, 'unite', 0.1)
    const box = pathBounds(u, 0.1)
    expect(box.x).toBeGreaterThanOrEqual(-0.5)
    expect(box.x + box.w).toBeLessThanOrEqual(120.5)
  })
})

describe('degenerate input', () => {
  it('an empty operand leaves the other alone', () => {
    near(ringsArea(polygonBoolean([rect(0, 0, 10, 10)], [], 'unite')), 100)
    expect(polygonBoolean([rect(0, 0, 10, 10)], [], 'intersect')).toEqual([])
    near(ringsArea(polygonBoolean([], [rect(0, 0, 10, 10)], 'unite')), 100)
  })

  it('identical shapes intersect to themselves and subtract to nothing', () => {
    const a = [rect(0, 0, 50, 50)]
    const b = [rect(0, 0, 50, 50)]
    near(ringsArea(polygonBoolean(a, b, 'intersect')), 2500, 1)
    expect(ringsArea(polygonBoolean(a, b, 'subtract'))).toBeLessThan(1)
  })

  it('returns an empty path rather than throwing when nothing survives', () => {
    const out = booleanPath(rectPath(0, 0, 10, 10), rectPath(0, 0, 10, 10), 'subtract')
    expect(out.subpaths).toEqual([])
  })
})

describe('shapes that share an edge', () => {
  // The case a midpoint test cannot answer, and it is not exotic: two tiles
  // laid side by side, or a shape against a copy of itself.
  const left = [rect(0, 0, 10, 10)]
  const right = [rect(10, 0, 10, 10)]

  it('unite drops the seam and makes one rectangle', () => {
    const u = polygonBoolean(left, right, 'unite')
    near(ringsArea(u), 200)
    expect(u).toHaveLength(1)
  })

  it('intersect of two tiles meeting at a seam has no area', () => {
    expect(ringsArea(polygonBoolean(left, right, 'intersect'))).toBeLessThan(0.01)
  })

  it('subtracting a neighbour takes nothing away', () => {
    near(ringsArea(polygonBoolean(left, right, 'subtract')), 100)
  })

  it('a shape against its own copy: unite and intersect keep it, subtract empties it', () => {
    const a = [rect(0, 0, 10, 10)]
    const copy = [rect(0, 0, 10, 10)]
    near(ringsArea(polygonBoolean(a, copy, 'unite')), 100)
    near(ringsArea(polygonBoolean(a, copy, 'intersect')), 100)
    expect(ringsArea(polygonBoolean(a, copy, 'subtract'))).toBeLessThan(0.01)
    expect(ringsArea(polygonBoolean(a, copy, 'exclude'))).toBeLessThan(0.01)
  })
})

describe('area is conserved across the four operations', () => {
  it('unite + intersect equals the sum of the parts, for many layouts', () => {
    // |A ∪ B| + |A ∩ B| = |A| + |B| holds for any two regions, so it checks
    // unite and intersect against each other without a hand-computed answer.
    let seed = 4242
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    let checked = 0
    for (let i = 0; i < 120; i++) {
      const a = [rect(rnd(50), rnd(50), 20 + rnd(80), 20 + rnd(80))]
      const b = [rect(rnd(100), rnd(100), 20 + rnd(80), 20 + rnd(80))]
      const union = ringsArea(polygonBoolean(a, b, 'unite'))
      const inter = ringsArea(polygonBoolean(a, b, 'intersect'))
      near(union + inter, ringsArea(a) + ringsArea(b), 1)
      // |A ^ B| = |A ∪ B| − |A ∩ B|, and |A−B| + |B−A| must equal it, which
      // ties all four operations to one another without a single
      // hand-computed answer anywhere.
      const xor = ringsArea(polygonBoolean(a, b, 'exclude'))
      near(xor, union - inter, 1)
      near(
        ringsArea(polygonBoolean(a, b, 'subtract')) + ringsArea(polygonBoolean(b, a, 'subtract')),
        xor,
        1
      )
      checked++
    }
    expect(checked).toBe(120)
  })
})
