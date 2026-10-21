import { describe, it, expect } from 'vitest'
import {
  frameBounds,
  hitObject,
  objectBounds,
  selectableObjectIds,
  shapePath,
  solid,
  vectorLayer,
  type DrawBody,
  type DrawImageObject,
  type DrawObject,
  type DrawPathObject,
  type DrawTextObject,
  type DrawVectorLayer
} from '../../src/shared/draw'
import {
  alignObjects,
  arrange,
  artboardResizeOffset,
  distributeObjects,
  getObject,
  moveNode,
  reshape,
  resizeArtboard,
  scaleObjects
} from '../../src/shared/drawOps'
import { scrollToKeepPoint, wheelZoom } from '../../src/renderer/src/components/documents/draw/viewport'

// Regression tests for the Phase 0 audit bugs (GAP-MATRIX "Bugs found during
// the audit"). Each one failed before its fix.

function rect(id: string, x: number, y: number, w: number, h: number, extra: Partial<DrawPathObject> = {}): DrawPathObject {
  return { id, type: 'path', path: shapePath('rect', { x, y, w, h }), fill: solid('#000'), shapeKind: 'rect', ...extra }
}

function doc(objects: DrawObject[]): DrawBody {
  const l = vectorLayer('L1')
  l.id = 'L1'
  l.objects = objects
  return { schemaVersion: 1, width: 500, height: 400, background: solid('#fff'), layers: [l], activeLayerId: 'L1' }
}

describe('bug 1 — locked or hidden objects are never moved by Align', () => {
  const body = (): DrawBody =>
    doc([rect('free', 100, 100, 20, 20), rect('locked', 300, 50, 20, 20, { locked: true }), rect('hidden', 200, 250, 20, 20, { hidden: true })])

  it('Select all picks only what can be edited', () => {
    expect(selectableObjectIds(body())).toEqual(['free'])
  })

  it('align ignores locked and hidden objects even when a stale selection names them', () => {
    const before = body()
    const after = alignObjects(before, ['free', 'locked', 'hidden'], 'left')
    expect(objectBounds(getObject(after, 'locked')!).x).toBe(300)
    expect(objectBounds(getObject(after, 'hidden')!).x).toBe(200)
  })

  it('distribute and arrange ignore them too', () => {
    const b = doc([rect('a', 0, 0, 10, 10), rect('b', 50, 0, 10, 10, { locked: true }), rect('c', 400, 0, 10, 10), rect('d', 60, 0, 10, 10)])
    const dist = distributeObjects(b, ['a', 'b', 'c', 'd'], 'h')
    expect(objectBounds(getObject(dist, 'b')!).x).toBe(50)
    const front = arrange(b, ['b'], 'front')
    expect((front.layers[0] as DrawVectorLayer).objects.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('bug 2 — ⌘/Ctrl-wheel zooms about the pointer', () => {
  it('scrolls so the point under the pointer stays under it', () => {
    // At zoom 1 the artboard point (200, 100) is under the pointer at (260, 160)
    // with the stage at (60, 60). After zooming to 1.1 with the stage still at
    // (60, 60) in the layout, that point sits at (280, 170): scroll by (20, 10).
    const z = wheelZoom(1, -100)
    expect(z).toBeCloseTo(1.1, 10)
    const s = scrollToKeepPoint({ docX: 200, docY: 100, clientX: 260, clientY: 160, stageLeft: 60, stageTop: 60, zoom: z, scrollLeft: 0, scrollTop: 0 })
    expect(s.scrollLeft).toBeCloseTo(20, 6)
    expect(s.scrollTop).toBeCloseTo(10, 6)
    // And the same point is then exactly back under the pointer.
    expect(60 - (s.scrollLeft - 0) + 200 * z).toBeCloseTo(260, 6)
  })

  it('zoom stays within the studio range', () => {
    expect(wheelZoom(16, -1)).toBe(16)
    expect(wheelZoom(0.05, 1)).toBe(0.05)
  })
})

describe('bug 5 — editing a live shape node detaches it into a path', () => {
  it('the hand edit survives a later change to Points', () => {
    const star: DrawPathObject = { id: 's', type: 'path', shapeKind: 'star', sides: 5, innerRatio: 0.5, path: shapePath('star', { x: 0, y: 0, w: 100, h: 100 }, { sides: 5, innerRatio: 0.5 }), fill: solid('#f00') }
    const edited = moveNode(doc([star]), 's', 0, 0, 'anchor', { x: 50, y: -40 })
    const o = getObject(edited, 's') as DrawPathObject
    expect(o.shapeKind).toBe('path')
    expect(o.sides).toBeUndefined()
    expect(o.innerRatio).toBeUndefined()
    expect(o.path.subpaths[0].nodes[0]).toMatchObject({ x: 50, y: -40 })
    // A later "Points" change can no longer regenerate the outline.
    const after = reshape(edited, 's', { sides: 8 })
    expect(after).toBe(edited)
  })

  it('a pen or pencil path keeps its kind (it was never live)', () => {
    const pen: DrawPathObject = { id: 'p', type: 'path', shapeKind: 'pen', path: shapePath('rect', { x: 0, y: 0, w: 10, h: 10 }), fill: solid('#000') }
    expect((getObject(moveNode(doc([pen]), 'p', 0, 1, 'anchor', { x: 30, y: 0 }), 'p') as DrawPathObject).shapeKind).toBe('pen')
  })

  it('dragging a handle mirrors its partner unless the pair is broken', () => {
    const curve: DrawPathObject = {
      id: 'c',
      type: 'path',
      path: { subpaths: [{ closed: false, nodes: [{ x: 0, y: 0, inX: -10, inY: 0, outX: 10, outY: 0 }, { x: 100, y: 0 }] }] },
      fill: { type: 'none' }
    }
    const mirrored = (getObject(moveNode(doc([curve]), 'c', 0, 0, 'out', { x: 0, y: 20 }), 'c') as DrawPathObject).path.subpaths[0].nodes[0]
    expect(mirrored).toMatchObject({ outX: 0, outY: 20, inX: 0, inY: -20 })
    const broken = (getObject(moveNode(doc([curve]), 'c', 0, 0, 'out', { x: 0, y: 20 }, true), 'c') as DrawPathObject).path.subpaths[0].nodes[0]
    expect(broken).toMatchObject({ outX: 0, outY: 20, inX: -10, inY: 0 })
  })
})

describe('bug 6 — rotated text and images are bounded and hit where they are drawn', () => {
  const img: DrawImageObject = { id: 'i', type: 'image', x: 100, y: 100, w: 200, h: 100, src: 'data:image/png;base64,AA', rotation: 90 }

  it('the visible bounds of a quarter-turned image swap its width and height about its centre', () => {
    const b = objectBounds(img)
    expect(b.x).toBeCloseTo(150, 6)
    expect(b.y).toBeCloseTo(50, 6)
    expect(b.w).toBeCloseTo(100, 6)
    expect(b.h).toBeCloseTo(200, 6)
    // The frame itself is unchanged, for scaling and the text editor.
    expect(frameBounds(img)).toEqual({ x: 100, y: 100, w: 200, h: 100 })
  })

  it('a click on the turned image hits it; a click where the unturned frame was does not', () => {
    expect(hitObject(img, { x: 200, y: 60 })).toBe(true) // inside the turned image, outside the old frame
    expect(hitObject(img, { x: 110, y: 110 })).toBe(false) // inside the old frame, outside the turned image
  })

  it('text turns about the middle of its top edge, as both renderers draw it', () => {
    const t: DrawTextObject = { id: 't', type: 'text', x: 0, y: 0, w: 100, text: 'x', fontSize: 10, lineHeight: 1, fill: solid('#000'), rotation: 180 }
    const b = objectBounds(t)
    expect(b.x).toBeCloseTo(0, 6)
    expect(b.y).toBeCloseTo(-10, 6)
    expect(b.h).toBeCloseTo(10, 6)
  })

  it('scaling a turned image keeps it on its pivot and turned', () => {
    const body = doc([img as DrawObject])
    const from = objectBounds(img)
    const to = { x: from.x, y: from.y, w: from.w * 2, h: from.h * 2 }
    const out = getObject(scaleObjects(body, ['i'], from, to), 'i') as DrawImageObject
    expect(out.rotation).toBe(90)
    expect(objectBounds(out).x).toBeCloseTo(to.x, 6)
    expect(objectBounds(out).y).toBeCloseTo(to.y, 6)
    expect(objectBounds(out).w).toBeCloseTo(to.w, 6)
    expect(objectBounds(out).h).toBeCloseTo(to.h, 6)
  })

  it('an unrotated frame scales exactly as before', () => {
    const plain: DrawImageObject = { ...img, rotation: undefined }
    const out = getObject(scaleObjects(doc([plain]), ['i'], { x: 100, y: 100, w: 200, h: 100 }, { x: 0, y: 0, w: 100, h: 50 }), 'i') as DrawImageObject
    expect(out).toMatchObject({ x: 0, y: 0, w: 100, h: 50 })
  })
})

describe('bug 4 — resizing the artboard never stretches or loses the artwork', () => {
  it('the anchor offset is nothing for top-left, half for centre, all for the far edge', () => {
    expect(artboardResizeOffset({ w: 100, h: 100 }, { w: 300, h: 200 }, 'nw')).toEqual({ dx: 0, dy: 0 })
    expect(artboardResizeOffset({ w: 100, h: 100 }, { w: 300, h: 200 }, 'c')).toEqual({ dx: 100, dy: 50 })
    expect(artboardResizeOffset({ w: 100, h: 100 }, { w: 300, h: 200 }, 'se')).toEqual({ dx: 200, dy: 100 })
    expect(artboardResizeOffset({ w: 300, h: 200 }, { w: 100, h: 100 }, 'e')).toEqual({ dx: -200, dy: -50 })
  })

  it('vector art moves with the anchor, locked and hidden objects included', () => {
    const b = doc([rect('a', 10, 10, 10, 10), rect('l', 50, 50, 10, 10, { locked: true })])
    const out = resizeArtboard(b, 700, 600, 'c')
    expect(out.width).toBe(700)
    expect(out.height).toBe(600)
    expect(objectBounds(getObject(out, 'a')!).x).toBe(110)
    expect(objectBounds(getObject(out, 'l')!).y).toBe(150)
  })

  it('paint layers take the re-laid pixels the editor hands in, and only those', () => {
    const b: DrawBody = {
      ...doc([]),
      layers: [
        { id: 'R1', kind: 'raster', name: 'Paint', visible: true, locked: false, opacity: 1, blend: 'normal', src: 'data:image/png;base64,OLD' },
        { id: 'R2', kind: 'raster', name: 'Empty', visible: true, locked: false, opacity: 1, blend: 'normal', src: '' }
      ]
    }
    const out = resizeArtboard(b, 800, 800, 'nw', { R1: 'data:image/png;base64,NEW' })
    expect(out.layers.map((l) => (l.kind === 'raster' ? l.src : null))).toEqual(['data:image/png;base64,NEW', ''])
  })
})
