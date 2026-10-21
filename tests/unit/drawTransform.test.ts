import { describe, it, expect } from 'vitest'
import { applyMatrix, pathBounds, type Matrix } from '../../src/shared/drawGeometry'
import {
  IDENTITY_MATRIX,
  REF_POINTS,
  about,
  boxToBox,
  compose,
  decompose,
  determinant,
  invertMatrix,
  isAxisAligned,
  lengthScale,
  matricesEqual,
  moveToPolar,
  normalizeAngle,
  polarMove,
  recompose,
  refPointOf,
  rotation,
  scaling,
  skewing,
  translation,
  uiReflect,
  uiRotate,
  uiScale,
  uiShear
} from '../../src/shared/draw/geometry/transform'
import { docUnits, evalField, evalLength, formatField, formatLength, keyIncrementPx, pxPerUnit } from '../../src/shared/draw/fieldExpr'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import type { DrawDoc, DrawImageNode, DrawNode, DrawPathNode, DrawTextNode } from '../../src/shared/draw/model'
import {
  TRANSFORM_EACH_DEFAULTS,
  alignTo,
  distributeEdges,
  distributeSpacing,
  duplicateObjects,
  frameFit,
  getObject,
  needsFrameMatrix,
  nodeBounds,
  nodeOrientation,
  resetBoundingBox,
  selectionNeedsFrameMatrix,
  transformEach,
  transformEachMatrix,
  transformNode,
  transformObjects
} from '../../src/shared/draw/ops'

/** A seeded PRNG (mulberry32), so the randomised tests are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps
const expectPt = (p: { x: number; y: number }, x: number, y: number, eps = 1e-9): void => {
  expect(close(p.x, x, eps) && close(p.y, y, eps), `(${p.x}, ${p.y}) ≈ (${x}, ${y})`).toBe(true)
}

function randomMatrix(r: () => number): Matrix {
  const d = { translateX: r() * 400 - 200, translateY: r() * 400 - 200, rotation: r() * 360 - 180, scaleX: 0.1 + r() * 5, scaleY: (r() < 0.3 ? -1 : 1) * (0.1 + r() * 5), skew: r() * 140 - 70 }
  return recompose(d)
}

describe('matrix composition', () => {
  it('compose applies right to left, and the identity is neutral', () => {
    const m = compose(translation(10, 0), scaling(2))
    expectPt(applyMatrix(m, { x: 1, y: 1 }), 12, 2)
    expect(matricesEqual(compose(), IDENTITY_MATRIX)).toBe(true)
    expect(matricesEqual(compose(m, IDENTITY_MATRIX), m)).toBe(true)
  })

  it('composition is associative and the inverse undoes (randomised)', () => {
    const r = prng(1)
    for (let i = 0; i < 200; i++) {
      const a = randomMatrix(r)
      const b = randomMatrix(r)
      const c = randomMatrix(r)
      expect(matricesEqual(compose(compose(a, b), c), compose(a, compose(b, c)), 1e-6)).toBe(true)
      const inv = invertMatrix(a)!
      expect(matricesEqual(compose(a, inv), IDENTITY_MATRIX, 1e-9)).toBe(true)
      expect(close(determinant(compose(a, b)), determinant(a) * determinant(b), 1e-6 * Math.abs(determinant(a) * determinant(b)) + 1e-9)).toBe(true)
    }
  })

  it('a singular matrix has no inverse', () => {
    expect(invertMatrix([1, 2, 2, 4, 0, 0])).toBeNull()
    expect(invertMatrix([0, 0, 0, 0, 5, 5])).toBeNull()
  })

  it('about() keeps its origin fixed', () => {
    const r = prng(2)
    for (let i = 0; i < 100; i++) {
      const o = { x: r() * 500, y: r() * 500 }
      expectPt(applyMatrix(about(o, randomMatrix(r)), o), o.x, o.y, 1e-7)
    }
  })

  it('lengthScale is √|det|: 1 for rotations, reflections and shears', () => {
    expect(lengthScale(rotation(37))).toBeCloseTo(1, 12)
    expect(lengthScale(uiReflect(20, { x: 3, y: 4 }))).toBeCloseTo(1, 12)
    expect(lengthScale(skewing(0.7, 0))).toBeCloseTo(1, 12)
    expect(lengthScale(scaling(4, 1))).toBeCloseTo(2, 12)
    expect(lengthScale(scaling(-3, 3))).toBeCloseTo(3, 12)
  })
})

describe('decompose and recompose', () => {
  it('round-trips random affine matrices, reflections and shears included', () => {
    const r = prng(3)
    for (let i = 0; i < 500; i++) {
      const m = randomMatrix(r)
      expect(matricesEqual(recompose(decompose(m)), m, 1e-7), `matrix ${m.join(',')}`).toBe(true)
    }
  })

  it('reads the parts back: turn, scale, skew and a flip as a negative scaleY', () => {
    const d = decompose(compose(translation(5, 6), rotation(30), scaling(2, 3)))
    expect(d.translateX).toBeCloseTo(5)
    expect(d.translateY).toBeCloseTo(6)
    expect(d.rotation).toBeCloseTo(30)
    expect(d.scaleX).toBeCloseTo(2)
    expect(d.scaleY).toBeCloseTo(3)
    expect(d.skew).toBeCloseTo(0)
    const flip = decompose(scaling(1, -1))
    expect(flip.scaleY).toBeCloseTo(-1)
    const sk = decompose(skewing(Math.tan((25 * Math.PI) / 180), 0))
    expect(sk.skew).toBeCloseTo(25)
  })
})

describe('reference points', () => {
  const box = { x: 10, y: 20, w: 100, h: 50 }
  it('the nine points sit at the corners, edge middles and centre', () => {
    expect(REF_POINTS.map((r) => refPointOf(box, r))).toEqual([
      { x: 10, y: 20 },
      { x: 60, y: 20 },
      { x: 110, y: 20 },
      { x: 10, y: 45 },
      { x: 60, y: 45 },
      { x: 110, y: 45 },
      { x: 10, y: 70 },
      { x: 60, y: 70 },
      { x: 110, y: 70 }
    ])
  })

  it('a reference-point resize keeps that point fixed, for all nine points (randomised)', () => {
    const r = prng(4)
    for (let i = 0; i < 100; i++) {
      for (const ref of REF_POINTS) {
        const from = { x: r() * 300, y: r() * 300, w: 1 + r() * 200, h: 1 + r() * 200 }
        const anchor = refPointOf(from, ref)
        const w = 1 + r() * 300
        const h = 1 + r() * 300
        // Typing W and H: the box keeps its reference point where it was.
        const to = { x: anchor.x - w * (refPointOf({ x: 0, y: 0, w: 1, h: 1 }, ref).x), y: anchor.y - h * refPointOf({ x: 0, y: 0, w: 1, h: 1 }, ref).y, w, h }
        const m = boxToBox(from, to, ref)
        expectPt(applyMatrix(m, anchor), anchor.x, anchor.y, 1e-7)
        expectPt(applyMatrix(m, { x: from.x, y: from.y }), to.x, to.y, 1e-7)
        expectPt(applyMatrix(m, { x: from.x + from.w, y: from.y + from.h }), to.x + to.w, to.y + to.h, 1e-7)
      }
    }
  })

  it('a zero-width box keeps that axis unscaled instead of dividing by zero', () => {
    const m = boxToBox({ x: 5, y: 0, w: 0, h: 10 }, { x: 5, y: 0, w: 50, h: 20 }, 'tl')
    expect(m.every(Number.isFinite)).toBe(true)
    expect(m[0]).toBe(1)
    expect(m[3]).toBe(2)
  })
})

describe('Illustrator angle conventions', () => {
  const o = { x: 0, y: 0 }
  it('a positive rotate turns counter-clockwise on screen (y down)', () => {
    // (1, 0) to the right; 90° CCW on screen is straight up, i.e. y = -1.
    expectPt(applyMatrix(uiRotate(90, o), { x: 1, y: 0 }), 0, -1)
  })

  it('reflect: 0° (horizontal axis) flips upside down, 90° (vertical axis) mirrors left to right', () => {
    expectPt(applyMatrix(uiReflect(0, o), { x: 3, y: 4 }), 3, -4)
    expectPt(applyMatrix(uiReflect(90, o), { x: 3, y: 4 }), -3, 4)
    // 45° CCW from horizontal is the screen line y = -x.
    expectPt(applyMatrix(uiReflect(45, o), { x: 1, y: 0 }), 0, -1)
  })

  it('reflecting twice about the same axis is the identity (randomised)', () => {
    const r = prng(5)
    for (let i = 0; i < 100; i++) {
      const m = uiReflect(r() * 360, { x: r() * 100, y: r() * 100 })
      expect(matricesEqual(compose(m, m), IDENTITY_MATRIX, 1e-9)).toBe(true)
      expect(determinant(m)).toBeCloseTo(-1, 9)
    }
  })

  it('a positive horizontal shear leans the top right; a positive vertical shear drops the right side', () => {
    const h = uiShear(45, 0, o)
    expectPt(applyMatrix(h, { x: 0, y: -10 }), 10, -10)
    expectPt(applyMatrix(h, { x: 0, y: 10 }), -10, 10)
    const v = uiShear(45, 90, o)
    expectPt(applyMatrix(v, { x: 10, y: 0 }), 10, 10, 1e-9)
    expect(isAxisAligned(h)).toBe(false)
    expect(determinant(h)).toBeCloseTo(1, 12)
  })

  it('a shear along an axis leaves points on that axis where they are', () => {
    const r = prng(6)
    for (let i = 0; i < 100; i++) {
      const axis = r() * 180
      const m = uiShear(r() * 120 - 60, axis, o)
      const a = (axis * Math.PI) / 180
      const onAxis = { x: Math.cos(a) * 7, y: -Math.sin(a) * 7 }
      expectPt(applyMatrix(m, onAxis), onAxis.x, onAxis.y, 1e-7)
    }
  })

  it('uiScale is percent about a point; move angles are polar with 90° up', () => {
    expectPt(applyMatrix(uiScale(200, 50, { x: 10, y: 10 }), { x: 20, y: 20 }), 30, 15)
    const mv = polarMove(10, 90)
    expectPt({ x: mv.dx, y: mv.dy }, 0, -10)
    const back = moveToPolar(3, -4)
    expect(back.distance).toBeCloseTo(5)
    expect(back.angle).toBeCloseTo(53.1301, 3)
    expect(normalizeAngle(270)).toBe(-90)
    expect(normalizeAngle(-180)).toBe(180)
  })
})

describe('field expressions and units', () => {
  const px = { unit: 'px' as const, dpi: 96, current: 100 }
  it('evaluates arithmetic, percentages and a leading multiply', () => {
    expect(evalField('100+20', px)).toBe(120)
    expect(evalField('50%', px)).toBe(50)
    expect(evalField('(40 + 8) / 2', px)).toBe(24)
    expect(evalField('*2', px)).toBe(200)
    expect(evalField('/4', px)).toBe(25)
    expect(evalField('-12.5', px)).toBe(-12.5)
    expect(evalField('2*-3', px)).toBe(-6)
    expect(evalField('3,5', px)).toBe(3.5)
  })

  it('converts units typed into a field', () => {
    expect(evalField('1in', px)).toBe(96)
    expect(evalField('25.4mm', px)).toBeCloseTo(96)
    expect(evalField('72pt', px)).toBeCloseTo(96)
    expect(evalField('1in + 4px', px)).toBe(100)
    expect(evalField('1cm', px)).toBeCloseTo(96 / 2.54)
    // A bare number in a mm field is mm; a px value converts into it.
    expect(evalField('96px', { unit: 'mm', dpi: 96 })).toBeCloseTo(25.4)
  })

  it('rejects what does not parse, and a division by zero', () => {
    for (const bad of ['', 'abc', '1+', '(1', '1/0', '5°', '10 apples']) expect(evalField(bad, px), bad).toBeNull()
    expect(evalField('5mm', { unit: 'deg', dpi: 96 })).toBeNull()
    expect(evalField('45°', { unit: 'deg', dpi: 96 })).toBe(45)
  })

  it('reads units, dpi and the keyboard increment from document settings', () => {
    expect(docUnits(undefined)).toBe('px')
    expect(docUnits({ units: 'mm' })).toBe('mm')
    expect(pxPerUnit('in', 150)).toBe(150)
    expect(evalLength('10', { units: 'mm', dpi: 254 })).toBeCloseTo(100)
    expect(formatLength(100, { units: 'mm', dpi: 254 })).toBe('10 mm')
    expect(formatLength(12.3456, {})).toBe('12.35 px')
    expect(formatField(45, 'deg')).toBe('45°')
    expect(keyIncrementPx({})).toBe(1)
    expect(keyIncrementPx({ keyIncrement: 0.5 })).toBe(0.5)
  })
})

// ── Node transforms ──────────────────────────────────────────────────────────

function doc(objects: unknown[], v2 = false): DrawDoc {
  const body: Record<string, unknown> = {
    schemaVersion: 1,
    width: 400,
    height: 300,
    background: { type: 'solid', color: '#ffffff' },
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }]
  }
  const d = normalizeDrawDoc(body)
  return v2 ? { ...d, settings: { ...d.settings, units: 'px' } } : d
}

function rect(id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'path',
    shapeKind: 'rect',
    path: { subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] },
    fill: { type: 'solid', color: '#6d5dfc' },
    ...extra
  }
}

const node = (d: DrawDoc, id: string): DrawNode => getObject(d, id)!

describe('transforming nodes', () => {
  it('paths re-bake through the matrix; strokes scale only with Scale Strokes & Effects', () => {
    const d = doc([rect('a', 0, 0, 10, 10, { stroke: { paint: { type: 'solid', color: '#000' }, width: 2, dash: [4, 2] } })])
    const m = scaling(3, 3)
    const plain = transformNode(node(d, 'a'), m) as DrawPathNode
    expect(pathBounds(plain.path)).toEqual({ x: 0, y: 0, w: 30, h: 30 })
    expect(plain.stroke!.width).toBe(2)
    const scaled = transformNode(node(d, 'a'), m, { scaleStrokes: true }) as DrawPathNode
    expect(scaled.stroke!.width).toBeCloseTo(6)
    expect(scaled.stroke!.dash).toEqual([12, 6])
    // A rotation is length-preserving: the stroke stays 2 either way.
    const turned = transformNode(node(d, 'a'), uiRotate(30, { x: 5, y: 5 }), { scaleStrokes: true }) as DrawPathNode
    expect(turned.stroke!.width).toBeCloseTo(2)
  })

  it('Scale Strokes & Effects also scales the appearance stack and effect distances', () => {
    const appearance = {
      fills: [],
      strokes: [{ id: 's1', stroke: { paint: { type: 'solid', color: '#000' }, width: 3 } }],
      effects: [{ id: 'e1', kind: 'dropShadow', dx: 2, dy: 4, blur: 5, color: '#000', opacity: 0.5 }, { id: 'e2', kind: 'blur', radius: 1 }]
    }
    const a = { ...(node(doc([rect('a', 0, 0, 10, 10)]), 'a') as DrawPathNode), appearance } as DrawPathNode
    const off = transformNode(a, scaling(2, 2)) as DrawPathNode
    expect(off.appearance).toEqual(appearance)
    const on = transformNode(a, scaling(2, 2), { scaleStrokes: true }) as DrawPathNode
    expect(on.appearance!.strokes[0].stroke.width).toBe(6)
    expect(on.appearance!.effects[0]).toMatchObject({ dx: 4, dy: 8, blur: 10 })
    expect(on.appearance!.effects[1]).toMatchObject({ radius: 2 })
    // A move scales nothing.
    expect((transformNode(a, translation(5, 5), { scaleStrokes: true }) as DrawPathNode).appearance).toBe(a.appearance)
  })

  it('a rounded rectangle keeps its corner radius unless Scale Corners is on', () => {
    const d = doc([rect('a', 0, 0, 100, 50, { shapeKind: 'roundRect', cornerRadius: 10 })])
    const off = transformNode(node(d, 'a'), scaling(2, 2)) as DrawPathNode
    expect(off.shapeKind).toBe('roundRect')
    expect(off.cornerRadius).toBe(10)
    expect(nodeBounds(off)).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    const on = transformNode(node(d, 'a'), scaling(2, 2), { scaleCorners: true }) as DrawPathNode
    expect(on.cornerRadius).toBeCloseTo(20)
    // The outline really has a 10px corner: the top edge starts 10px in.
    const top = off.path.subpaths[0].nodes.map((n) => n).filter((n) => Math.abs(n.y) < 1e-9)
    expect(Math.min(...top.map((n) => n.x))).toBeCloseTo(10)
  })

  it('a rotation or shear detaches a live shape into a plain path; a flipped star detaches, a flipped rectangle stays live', () => {
    const d = doc([rect('a', 0, 0, 10, 10), rect('s', 0, 0, 10, 10, { shapeKind: 'star', sides: 5, innerRatio: 0.5 })])
    expect((transformNode(node(d, 'a'), uiRotate(10, { x: 0, y: 0 })) as DrawPathNode).shapeKind).toBe('path')
    expect((transformNode(node(d, 'a'), uiShear(10, 0, { x: 0, y: 0 })) as DrawPathNode).shapeKind).toBe('path')
    expect((transformNode(node(d, 'a'), uiReflect(0, { x: 5, y: 5 })) as DrawPathNode).shapeKind).toBe('rect')
    const star = transformNode(node(d, 's'), uiReflect(0, { x: 5, y: 5 })) as DrawPathNode
    expect(star.shapeKind).toBe('path')
    expect(star.sides).toBeUndefined()
  })

  it('a linear gradient by angle follows a turn and a flip', () => {
    const d = doc([rect('a', 0, 0, 10, 10, { fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] } })])
    const turned = transformNode(node(d, 'a'), rotation(90)) as DrawPathNode
    expect(turned.fill).toMatchObject({ angle: 90 })
    const mirrored = transformNode(node(d, 'a'), uiReflect(90, { x: 5, y: 5 })) as DrawPathNode
    expect(mirrored.fill).toMatchObject({ angle: 180 })
    const scaled = transformNode(node(d, 'a'), scaling(3, 1)) as DrawPathNode
    expect(scaled.fill).toBe((node(d, 'a') as DrawPathNode).fill)
  })

  it('frames keep clean fields for a move, a turn with a uniform scale, and an unturned resize', () => {
    const img: DrawImageNode = { id: 'i', type: 'image', x: 0, y: 0, w: 100, h: 50, assetId: 'x' }
    const turned = transformNode(img, compose(uiRotate(-90, { x: 50, y: 25 }), uiScale(200, 200, { x: 50, y: 25 }))) as DrawImageNode
    expect(turned.rotation).toBeCloseTo(90)
    expect(turned.w).toBeCloseTo(200)
    expect(turned.h).toBeCloseTo(100)
    expect(turned.transform).toBeUndefined()
    expect(turned.x + turned.w / 2).toBeCloseTo(50)
    expect(frameFit(img, scaling(2, 3))).toBe('exact')
    expect(frameFit({ ...img, rotation: 10 }, scaling(2, 3))).toBe('approx')
    expect(frameFit(img, uiReflect(0, { x: 0, y: 0 }))).toBe('matrix')
    const text: DrawTextNode = { id: 't', type: 'text', x: 0, y: 0, w: 100, text: 'hi', fontSize: 10, fill: { type: 'solid', color: '#000' } }
    const big = transformNode(text, scaling(2, 2)) as DrawTextNode
    expect(big.fontSize).toBeCloseTo(20)
    expect(big.w).toBeCloseTo(200)
  })

  it('a reflect or shear of a frame needs a matrix, which is written only when allowed', () => {
    const img: DrawImageNode = { id: 'i', type: 'image', x: 0, y: 0, w: 100, h: 50, assetId: 'x' }
    const m = uiReflect(90, { x: 50, y: 25 })
    expect(needsFrameMatrix(img, m)).toBe(true)
    expect(needsFrameMatrix(img, translation(5, 5))).toBe(false)
    expect(transformNode(img, m)).toBe(img)
    const flipped = transformNode(img, m, { frameMatrix: true }) as DrawImageNode
    expect(flipped.transform).toEqual(m)
    const fb = nodeBounds(flipped)
    for (const [k, v] of Object.entries({ x: 0, y: 0, w: 100, h: 50 })) expect(fb[k as 'x']).toBeCloseTo(v, 9)
  })

  it('transformObjects skips locked and hidden nodes, and a copy lands directly above its original', () => {
    const d = doc([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10), rect('lk', 40, 0, 10, 10, { locked: true })])
    const moved = transformObjects(d, ['a', 'lk'], translation(5, 0))
    expect(nodeBounds(node(moved.doc, 'a')).x).toBe(5)
    expect(node(moved.doc, 'lk')).toBe(node(d, 'lk'))
    expect(node(moved.doc, 'b')).toBe(node(d, 'b'))
    const copied = transformObjects(d, ['a'], translation(0, 50), {}, true)
    expect(copied.newIds).toHaveLength(1)
    const ids = (copied.doc.layers[0] as { objects: DrawNode[] }).objects.map((o) => o.id)
    expect(ids).toEqual(['a', copied.newIds[0], 'b', 'lk'])
    expect(nodeBounds(node(copied.doc, copied.newIds[0])).y).toBe(50)
    expect(nodeBounds(node(copied.doc, 'a')).y).toBe(0)
  })

  it('a copy shares no object with its original, so the drawing can be saved (no repeated references)', () => {
    const d = doc([rect('a', 0, 0, 10, 10, { stroke: { paint: { type: 'solid', color: '#000' }, width: 1, dash: [2, 2] } })])
    const res = transformObjects(d, ['a'], translation(0, 0), {}, true)
    const seen = new Set<object>()
    const walk = (v: unknown): void => {
      if (!v || typeof v !== 'object') return
      expect(seen.has(v as object)).toBe(false)
      seen.add(v as object)
      for (const x of Object.values(v as object)) walk(x)
    }
    walk(res.doc.layers)
    // Edit › Duplicate makes the same promise.
    seen.clear()
    walk(duplicateObjects(d, ['a']).doc.layers)
  })

  it('selectionNeedsFrameMatrix finds a frame that only a matrix could hold', () => {
    const d = doc([rect('a', 0, 0, 10, 10), { id: 't', type: 'text', x: 0, y: 0, w: 50, text: 'x', fontSize: 12, fill: { type: 'solid', color: '#000' } }])
    expect(selectionNeedsFrameMatrix(d, ['a', 't'], uiReflect(90, { x: 0, y: 0 }))).toBe(true)
    expect(selectionNeedsFrameMatrix(d, ['a'], uiReflect(90, { x: 0, y: 0 }))).toBe(false)
    expect(selectionNeedsFrameMatrix(d, ['a', 't'], uiRotate(30, { x: 0, y: 0 }))).toBe(false)
  })

  it('reflecting twice is the identity on every kind of node', () => {
    const d = doc([rect('a', 3, 4, 50, 20), { id: 'i', type: 'image', x: 10, y: 10, w: 40, h: 30, src: 'data:image/png;base64,iVBORw0KGgo=' }])
    const m = uiReflect(33, { x: 25, y: 25 })
    const once = transformObjects(d, ['a', 'i'], m, { frameMatrix: true }).doc
    const twice = transformObjects(once, ['a', 'i'], m, { frameMatrix: true }).doc
    const a0 = node(d, 'a') as DrawPathNode
    const a2 = node(twice, 'a') as DrawPathNode
    a0.path.subpaths[0].nodes.forEach((n, i) => expectPt(a2.path.subpaths[0].nodes[i], n.x, n.y, 1e-9))
    const i2 = node(twice, 'i') as DrawImageNode
    expect(matricesEqual(i2.transform!, IDENTITY_MATRIX, 1e-9)).toBe(true)
  })

  it('nodeOrientation reads a frame\'s turn and shear; paths read 0', () => {
    const img: DrawImageNode = { id: 'i', type: 'image', x: 0, y: 0, w: 100, h: 50, assetId: 'x', rotation: 30 }
    expect(nodeOrientation(img).rotation).toBeCloseTo(30)
    const sheared = transformNode({ ...img, rotation: undefined }, uiShear(20, 0, { x: 0, y: 0 }), { frameMatrix: true })
    expect(nodeOrientation(sheared).rotation).toBeCloseTo(0)
    expect(nodeOrientation(sheared).skew).toBeCloseTo(-20)
    const d = doc([rect('a', 0, 0, 10, 10)])
    expect(nodeOrientation(node(d, 'a'))).toEqual({ rotation: 0, skew: 0 })
  })

  it('Reset Bounding Box moves a frame\'s turn into its matrix without changing how it looks', () => {
    const d = doc([{ id: 'i', type: 'image', x: 10, y: 10, w: 40, h: 30, rotation: 30, src: 'data:image/png;base64,iVBORw0KGgo=' }])
    const before = nodeBounds(node(d, 'i'))
    const reset = resetBoundingBox(d, ['i'])
    const after = node(reset, 'i') as DrawImageNode
    expect(after.rotation).toBeUndefined()
    expect(after.transform).toBeDefined()
    const b = nodeBounds(after)
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(b[k]).toBeCloseTo(before[k], 9)
    expect(nodeOrientation(after).rotation).toBeCloseTo(30)
    expect(resetBoundingBox(reset, ['i'])).toBe(reset)
  })
})

describe('Transform Each', () => {
  it('scales each object about its own reference point', () => {
    const d = doc([rect('a', 0, 0, 10, 10), rect('b', 100, 100, 20, 20)])
    const { doc: out } = transformEach(d, ['a', 'b'], { ...TRANSFORM_EACH_DEFAULTS, scaleH: 200, scaleV: 200, ref: 'c' })
    expect(nodeBounds(node(out, 'a'))).toEqual({ x: -5, y: -5, w: 20, h: 20 })
    expect(nodeBounds(node(out, 'b'))).toEqual({ x: 90, y: 90, w: 40, h: 40 })
  })

  it('moves, rotates and reflects each, and random stays between unchanged and the value', () => {
    const box = { x: 0, y: 0, w: 10, h: 10 }
    const m = transformEachMatrix(box, { ...TRANSFORM_EACH_DEFAULTS, moveH: 5, moveV: -5, reflectY: true, ref: 'tl' })
    expectPt(applyMatrix(m, { x: 10, y: 0 }), -5, -5)
    const r = prng(7)
    for (let i = 0; i < 200; i++) {
      const mm = transformEachMatrix(box, { ...TRANSFORM_EACH_DEFAULTS, scaleH: 300, scaleV: 300, ref: 'tl', random: true }, r)
      expect(mm[0]).toBeGreaterThanOrEqual(1)
      expect(mm[0]).toBeLessThanOrEqual(3)
    }
  })

  it('makes copies with Copy', () => {
    const d = doc([rect('a', 0, 0, 10, 10)])
    const res = transformEach(d, ['a'], { ...TRANSFORM_EACH_DEFAULTS, moveH: 30 }, {}, true)
    expect(res.newIds).toHaveLength(1)
    expect(nodeBounds(node(res.doc, res.newIds[0])).x).toBe(30)
    expect(nodeBounds(node(res.doc, 'a')).x).toBe(0)
  })
})

describe('align and distribute', () => {
  const three = (): DrawDoc => doc([rect('a', 0, 0, 10, 10), rect('b', 30, 20, 20, 20), rect('c', 100, 50, 40, 10)])
  it('aligns to the selection, to a key object (which never moves) and to the artboard', () => {
    const sel = alignTo(three(), ['a', 'b', 'c'], 'right')
    expect(['a', 'b', 'c'].map((id) => { const b = nodeBounds(node(sel, id)); return b.x + b.w })).toEqual([140, 140, 140])
    const key = alignTo(three(), ['a', 'b', 'c'], 'left', { kind: 'key', id: 'b' })
    expect(['a', 'b', 'c'].map((id) => nodeBounds(node(key, id)).x)).toEqual([30, 30, 30])
    expect(nodeBounds(node(key, 'b'))).toEqual(nodeBounds(node(three(), 'b')))
    const art = alignTo(three(), ['a', 'b'], 'bottom', { kind: 'artboard' })
    expect(['a', 'b'].map((id) => { const b = nodeBounds(node(art, id)); return b.y + b.h })).toEqual([300, 300])
    // One object on its own aligns to the artboard.
    const one = alignTo(three(), ['a'], 'center')
    expect(nodeBounds(node(one, 'a')).x).toBe(195)
  })

  it('distributes objects by each of the six edges and centres', () => {
    const lefts = distributeEdges(three(), ['a', 'b', 'c'], 'left')
    expect(['a', 'b', 'c'].map((id) => nodeBounds(node(lefts, id)).x)).toEqual([0, 50, 100])
    const rights = distributeEdges(three(), ['a', 'b', 'c'], 'right')
    expect(['a', 'b', 'c'].map((id) => { const b = nodeBounds(node(rights, id)); return b.x + b.w })).toEqual([10, 75, 140])
    const vc = distributeEdges(three(), ['a', 'b', 'c'], 'vcenter')
    expect(['a', 'b', 'c'].map((id) => { const b = nodeBounds(node(vc, id)); return b.y + b.h / 2 })).toEqual([5, 30, 55])
    expect(distributeEdges(three(), ['a', 'b'], 'left')).toEqual(three())
  })

  it('distributes spacing evenly, or by an exact value from the key object (randomised exact gaps)', () => {
    const even = distributeSpacing(three(), ['a', 'b', 'c'], 'h')
    const xs = ['a', 'b', 'c'].map((id) => nodeBounds(node(even, id)))
    expect(xs[1].x - (xs[0].x + xs[0].w)).toBeCloseTo(xs[2].x - (xs[1].x + xs[1].w))
    const r = prng(8)
    for (let t = 0; t < 50; t++) {
      const n = 2 + Math.floor(r() * 6)
      const objs = Array.from({ length: n }, (_, i) => rect(`o${i}`, r() * 500, r() * 500, 1 + r() * 60, 1 + r() * 60))
      const d = doc(objs)
      const ids = objs.map((o) => o.id as string)
      const key = ids[Math.floor(r() * n)]
      const gap = Math.round(r() * 40)
      const axis = r() < 0.5 ? 'h' : 'v'
      const keyBefore = nodeBounds(node(d, key))
      const out = distributeSpacing(d, ids, axis, { keyId: key, spacing: gap })
      const boxes = ids.map((id) => nodeBounds(node(out, id))).sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y))
      for (let i = 1; i < boxes.length; i++) {
        const g = axis === 'h' ? boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w) : boxes[i].y - (boxes[i - 1].y + boxes[i - 1].h)
        expect(g).toBeCloseTo(gap, 9)
      }
      expect(nodeBounds(node(out, key))).toEqual(keyBefore)
    }
  })

  it('an exact spacing without a key object does nothing beyond even spacing; a key outside the selection is ignored', () => {
    const d = three()
    expect(distributeSpacing(d, ['a', 'b'], 'h', { spacing: 5 })).toBe(d)
    expect(distributeSpacing(d, ['a', 'b'], 'h', { keyId: 'c', spacing: 5 })).toBe(d)
    const exact = distributeEdges(d, ['a', 'b'], 'left', { keyId: 'a', spacing: 15 })
    expect(nodeBounds(node(exact, 'b')).x).toBe(15)
  })
})
