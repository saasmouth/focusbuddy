import { describe, it, expect } from 'vitest'
import {
  addLayer,
  addObject,
  alignObjects,
  arrange,
  booleanObjects,
  deleteObjects,
  distributeObjects,
  duplicateLayer,
  duplicateObjects,
  editableIds,
  getObject,
  joinPaths,
  layerOf,
  mergeVectorLayerDown,
  moveLayer,
  moveObjects,
  removeLayer,
  reshape,
  reversePath,
  scaleObjects,
  setPathClosed
} from '../../src/shared/drawOps'
import {
  objectBounds,
  rasterLayer,
  shapePath,
  solid,
  vectorLayer,
  type DrawBody,
  type DrawObject,
  type DrawPathObject,
  type DrawVectorLayer
} from '../../src/shared/draw'
import { flattenPath, polygonArea } from '../../src/shared/drawGeometry'

function rect(id: string, x: number, y: number, w: number, h: number): DrawPathObject {
  return { id, type: 'path', path: shapePath('rect', { x, y, w, h }), fill: solid('#000'), shapeKind: 'rect' }
}

function doc(objects: DrawObject[] = []): DrawBody {
  const l = vectorLayer('L1')
  l.id = 'L1'
  l.objects = objects
  return { schemaVersion: 1, width: 500, height: 500, background: solid('#fff'), layers: [l], activeLayerId: 'L1' }
}

function objs(b: DrawBody, layerIndex = 0): DrawObject[] {
  return (b.layers[layerIndex] as DrawVectorLayer).objects
}

function area(o: DrawObject): number {
  if (o.type !== 'path') return 0
  return flattenPath(o.path, 0.05).reduce((s, r) => s + polygonArea(r), 0)
}

describe('drawOps — object lifecycle', () => {
  it('adds to the named layer', () => {
    const b = addObject(doc(), rect('a', 0, 0, 10, 10), 'L1')
    expect(objs(b)).toHaveLength(1)
    expect(layerOf(b, 'a')!.id).toBe('L1')
  })

  it('a locked target layer is skipped, not silently swallowed', () => {
    const base = doc()
    base.layers[0].locked = true
    const b = addObject(base, rect('a', 0, 0, 10, 10), 'L1')
    expect(getObject(b, 'a')).toBeTruthy()
    expect(layerOf(b, 'a')!.id).not.toBe('L1')
  })

  it('a raster-only document gains a vector layer rather than losing the object', () => {
    const r = rasterLayer('Paint')
    const base: DrawBody = { schemaVersion: 1, width: 100, height: 100, background: solid('#fff'), layers: [r], activeLayerId: r.id }
    const b = addObject(base, rect('a', 0, 0, 10, 10))
    expect(b.layers).toHaveLength(2)
    expect(getObject(b, 'a')).toBeTruthy()
  })

  it('delete removes only what was named', () => {
    const b = deleteObjects(doc([rect('a', 0, 0, 5, 5), rect('b', 0, 0, 5, 5)]), ['a'])
    expect(objs(b).map((o) => o.id)).toEqual(['b'])
  })

  it('duplicate offsets the copy and returns its new id', () => {
    const { body, newIds } = duplicateObjects(doc([rect('a', 0, 0, 10, 10)]), ['a'], 5, 5)
    expect(newIds).toHaveLength(1)
    expect(objs(body)).toHaveLength(2)
    expect(objectBounds(getObject(body, newIds[0])!)).toEqual({ x: 5, y: 5, w: 10, h: 10 })
  })

  it('move shifts bounds by exactly the delta', () => {
    const b = moveObjects(doc([rect('a', 10, 10, 10, 10)]), ['a'], -4, 6)
    expect(objectBounds(getObject(b, 'a')!)).toEqual({ x: 6, y: 16, w: 10, h: 10 })
  })

  it('editableIds filters out locked objects and locked layers', () => {
    const base = doc([rect('a', 0, 0, 5, 5), { ...rect('b', 0, 0, 5, 5), locked: true }])
    expect(editableIds(base, ['a', 'b'])).toEqual(['a'])
    base.layers[0].locked = true
    expect(editableIds(base, ['a', 'b'])).toEqual([])
  })
})

describe('drawOps — scaling', () => {
  it('scales a path selection onto the target box', () => {
    const b = scaleObjects(doc([rect('a', 0, 0, 100, 100)]), ['a'], { x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 50, h: 200 })
    const bb = objectBounds(getObject(b, 'a')!)
    expect(bb.x).toBeCloseTo(10, 6)
    expect(bb.w).toBeCloseTo(50, 6)
    expect(bb.h).toBeCloseTo(200, 6)
  })

  it('scaling text scales its point size with the vertical factor', () => {
    const t: DrawObject = { id: 't', type: 'text', x: 0, y: 0, w: 100, text: 'hi', fontSize: 20, fill: solid('#000') }
    const b = scaleObjects(doc([t]), ['t'], { x: 0, y: 0, w: 100, h: 24 }, { x: 0, y: 0, w: 200, h: 48 })
    expect((getObject(b, 't') as { fontSize: number }).fontSize).toBeCloseTo(40, 6)
  })

  it('a zero-extent source axis does not produce NaN geometry', () => {
    const b = scaleObjects(doc([rect('a', 0, 0, 100, 100)]), ['a'], { x: 0, y: 0, w: 0, h: 0 }, { x: 5, y: 5, w: 50, h: 50 })
    const bb = objectBounds(getObject(b, 'a')!)
    expect(Number.isFinite(bb.x)).toBe(true)
    expect(Number.isFinite(bb.w)).toBe(true)
  })
})

describe('drawOps — z-order', () => {
  const base = doc([rect('a', 0, 0, 5, 5), rect('b', 0, 0, 5, 5), rect('c', 0, 0, 5, 5)])
  const ids = (b: DrawBody): string[] => objs(b).map((o) => o.id)

  it('front and back move to the ends', () => {
    expect(ids(arrange(base, ['a'], 'front'))).toEqual(['b', 'c', 'a'])
    expect(ids(arrange(base, ['c'], 'back'))).toEqual(['c', 'a', 'b'])
  })

  it('forward and backward move exactly one step', () => {
    expect(ids(arrange(base, ['a'], 'forward'))).toEqual(['b', 'a', 'c'])
    expect(ids(arrange(base, ['c'], 'backward'))).toEqual(['a', 'c', 'b'])
  })

  it('an item already at the end does not move or vanish', () => {
    expect(ids(arrange(base, ['c'], 'forward'))).toEqual(['a', 'b', 'c'])
    expect(ids(arrange(base, ['a'], 'backward'))).toEqual(['a', 'b', 'c'])
  })

  it('a multi-selection keeps its own relative order', () => {
    expect(ids(arrange(base, ['a', 'b'], 'front'))).toEqual(['c', 'a', 'b'])
  })
})

describe('drawOps — align & distribute', () => {
  it('two objects align to the selection box', () => {
    const b = alignObjects(doc([rect('a', 0, 0, 10, 10), rect('b', 100, 50, 10, 10)]), ['a', 'b'], 'left')
    expect(objectBounds(getObject(b, 'b')!).x).toBe(0)
  })

  it('a single object aligns to the artboard', () => {
    const b = alignObjects(doc([rect('a', 0, 0, 100, 100)]), ['a'], 'center')
    expect(objectBounds(getObject(b, 'a')!).x).toBeCloseTo(200, 6)
  })

  it('distribute evens the gaps for three or more', () => {
    const b = distributeObjects(doc([rect('a', 0, 0, 10, 10), rect('b', 30, 0, 10, 10), rect('c', 100, 0, 10, 10)]), ['a', 'b', 'c'], 'h')
    const xs = ['a', 'b', 'c'].map((id) => objectBounds(getObject(b, id)!).x)
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 6)
  })

  it('distribute is a no-op below three objects', () => {
    const before = doc([rect('a', 0, 0, 10, 10), rect('b', 30, 0, 10, 10)])
    expect(distributeObjects(before, ['a', 'b'], 'h')).toBe(before)
  })
})

describe('drawOps — booleans & path ops', () => {
  it('union replaces both operands with one combined object', () => {
    const { body, newId } = booleanObjects(doc([rect('a', 0, 0, 100, 100), rect('b', 50, 0, 100, 100)]), ['a', 'b'], 'union')
    expect(objs(body)).toHaveLength(1)
    expect(newId).toBeTruthy()
    expect(Math.abs(area(getObject(body, newId!)!))).toBeCloseTo(15000, 0)
  })

  it('the result inherits the bottom operand’s appearance', () => {
    const a = { ...rect('a', 0, 0, 100, 100), fill: solid('#ff0000') }
    const b = { ...rect('b', 50, 0, 100, 100), fill: solid('#00ff00') }
    const out = booleanObjects(doc([a, b]), ['a', 'b'], 'union')
    expect((getObject(out.body, out.newId!) as DrawPathObject).fill).toEqual(solid('#ff0000'))
  })

  it('a subtraction that consumes the shape removes the operands honestly', () => {
    const { body, newId } = booleanObjects(doc([rect('a', 0, 0, 50, 50), rect('b', -10, -10, 100, 100)]), ['a', 'b'], 'subtract')
    expect(newId).toBeNull()
    expect(objs(body)).toHaveLength(0)
  })

  it('fewer than two paths is a no-op', () => {
    const before = doc([rect('a', 0, 0, 10, 10)])
    expect(booleanObjects(before, ['a'], 'union').body).toBe(before)
  })

  it('non-path objects in the selection are left alone', () => {
    const img: DrawObject = { id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'data:,' }
    const { body } = booleanObjects(doc([rect('a', 0, 0, 100, 100), rect('b', 50, 0, 100, 100), img]), ['a', 'b', 'i'], 'union')
    expect(getObject(body, 'i')).toBeTruthy()
    expect(objs(body)).toHaveLength(2)
  })

  it('join merges subpaths without changing geometry', () => {
    const { body, newId } = joinPaths(doc([rect('a', 0, 0, 10, 10), rect('b', 50, 0, 10, 10)]), ['a', 'b'])
    const merged = getObject(body, newId!) as DrawPathObject
    expect(merged.path.subpaths).toHaveLength(2)
    expect(objectBounds(merged)).toEqual({ x: 0, y: 0, w: 60, h: 10 })
  })

  it('reverse flips winding and swaps handles', () => {
    const before = doc([rect('a', 0, 0, 10, 10)])
    const signedBefore = area(getObject(before, 'a')!)
    const after = reversePath(before, 'a')
    expect(Math.sign(area(getObject(after, 'a')!))).toBe(-Math.sign(signedBefore))
  })

  it('open and close a path', () => {
    const opened = setPathClosed(doc([rect('a', 0, 0, 10, 10)]), 'a', false)
    expect((getObject(opened, 'a') as DrawPathObject).path.subpaths[0].closed).toBe(false)
    const closed = setPathClosed(opened, 'a', true)
    expect((getObject(closed, 'a') as DrawPathObject).path.subpaths[0].closed).toBe(true)
  })

  it('reshape re-derives a live shape and keeps its box', () => {
    const star: DrawPathObject = { id: 's', type: 'path', path: shapePath('star', { x: 0, y: 0, w: 100, h: 100 }, { sides: 5 }), fill: solid('#000'), shapeKind: 'star', sides: 5 }
    const b = reshape(doc([star]), 's', { sides: 8 })
    const out = getObject(b, 's') as DrawPathObject
    expect(out.sides).toBe(8)
    expect(out.path.subpaths[0].nodes).toHaveLength(16)
    // The 8-point star is refitted into the 5-point star's own bounds, which are
    // narrower than its circumscribed box (a 5-star's widest points sit at ±18°).
    const bb = objectBounds(out)
    expect(bb.w).toBeCloseTo(objectBounds(star).w, 3)
  })

  it('reshape refuses to touch a path that is no longer a live shape', () => {
    const before = doc([{ ...rect('a', 0, 0, 10, 10), shapeKind: 'path' as const }])
    expect(reshape(before, 'a', { sides: 9 })).toBe(before)
  })
})

describe('drawOps — layers', () => {
  it('a new layer lands above the named one and becomes active', () => {
    const b = addLayer(doc(), vectorLayer('L2'), 'L1')
    expect(b.layers).toHaveLength(2)
    expect(b.activeLayerId).toBe(b.layers[1].id)
  })

  it('the last layer can never be removed', () => {
    const before = doc()
    expect(removeLayer(before, 'L1')).toBe(before)
  })

  it('removing the active layer re-points active at a survivor', () => {
    const two = addLayer(doc(), vectorLayer('L2'), 'L1')
    const gone = removeLayer(two, two.activeLayerId!)
    expect(gone.layers).toHaveLength(1)
    expect(gone.activeLayerId).toBe('L1')
  })

  it('moveLayer reorders and clamps at the ends', () => {
    const two = addLayer(doc(), vectorLayer('L2'), 'L1')
    const upId = two.layers[1].id
    expect(moveLayer(two, upId, -1).layers[0].id).toBe(upId)
    expect(moveLayer(two, upId, +5).layers[1].id).toBe(upId)
  })

  it('duplicating a layer gives its objects fresh ids', () => {
    const b = duplicateLayer(doc([rect('a', 0, 0, 5, 5)]), 'L1')
    const copies = (b.layers[1] as DrawVectorLayer).objects
    expect(copies).toHaveLength(1)
    expect(copies[0].id).not.toBe('a')
  })

  it('merge down folds the upper vector layer into the lower one', () => {
    let b = doc([rect('a', 0, 0, 5, 5)])
    const l2 = vectorLayer('L2')
    l2.objects = [rect('b', 0, 0, 5, 5)]
    b = addLayer(b, l2, 'L1')
    const merged = mergeVectorLayerDown(b, l2.id)
    expect(merged.layers).toHaveLength(1)
    expect(objs(merged).map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('merge down refuses a raster layer rather than dropping its pixels', () => {
    let b = doc([rect('a', 0, 0, 5, 5)])
    const r = rasterLayer('Paint')
    r.src = 'data:image/png;base64,AAAA'
    b = addLayer(b, r, 'L1')
    expect(mergeVectorLayerDown(b, r.id)).toBe(b)
  })

  it('merge down at the bottom of the stack is a no-op', () => {
    const before = doc([rect('a', 0, 0, 5, 5)])
    expect(mergeVectorLayerDown(before, 'L1')).toBe(before)
  })
})
