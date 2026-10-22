// Landing generated work in a real document: its own layer, inside the
// artboard, and the paint layer carrying the frame that makes it follow that
// artboard. Built on Draw's own ops, so these tests are also a guard against
// those ops changing underneath generated art.

import { describe, expect, it } from 'vitest'
import { addGeneratedPaintLayer, addGeneratedVectorLayer, fitNodesToArtboard, replaceObjects, targetArtboard } from '../../src/shared/draw/generate/apply'
import { compileScene, sceneBounds } from '../../src/shared/draw/generate/compile'
import { validateScene } from '../../src/shared/draw/generate/scene'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import type { DrawDoc, DrawDocRasterLayer, DrawDocVectorLayer, DrawPathNode } from '../../src/shared/draw/model'

let n = 0
const newId = (): string => `nd-${++n}`

const doc = (): DrawDoc =>
  normalizeDrawDoc({
    schemaVersion: 2,
    artboards: [{ id: 'ab-1', name: 'Page 1', x: 0, y: 0, w: 800, h: 600, background: { type: 'solid', color: '#fff' } }],
    activeArtboardId: 'ab-1',
    layers: [{ id: 'lyr-1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] }],
    activeLayerId: 'lyr-1',
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  } as never) as DrawDoc

const sceneOf = (items: unknown[]): ReturnType<typeof compileScene> => {
  const { scene } = validateScene({ items })
  return compileScene(scene!, { newId })
}

describe('generated art lands on its own layer', () => {
  it('adds a vector layer above the active one, with the art on it', () => {
    const d = doc()
    const { nodes } = sceneOf([{ shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 }, fill: '#111' }])
    const next = addGeneratedVectorLayer(d, nodes, 'A logo')
    expect(next.layers).toHaveLength(2)
    const added = next.layers[1] as DrawDocVectorLayer
    expect(added.name).toBe('A logo')
    expect(added.objects).toHaveLength(1)
    // The original layer is untouched: generated work never merges into it.
    expect((next.layers[0] as DrawDocVectorLayer).objects).toHaveLength(0)
    expect(next.activeLayerId).toBe(added.id)
  })

  it('survives Draw’s own normalise, which is what a save and reopen does', () => {
    const d = doc()
    const { nodes } = sceneOf([
      { shape: { kind: 'star', cx: 0, cy: 0, r: 40, points: 5 }, fill: '#f59e0b' },
      { name: 'g', children: [{ shape: { kind: 'path', d: 'M0 0 L10 0 L5 9 Z' }, fill: '#10b981' }] }
    ])
    const next = normalizeDrawDoc(addGeneratedVectorLayer(d, nodes, 'Art') as never) as DrawDoc
    const layer = next.layers[1] as DrawDocVectorLayer
    expect(layer.objects).toHaveLength(2)
    expect(layer.objects[1]!.type).toBe('group')
  })

  it('centres art on the artboard and shrinks it to fit, never enlarges it', () => {
    const board = doc().artboards[0]!
    const { scene } = validateScene({ items: [{ shape: { kind: 'rect', x: 5000, y: 5000, w: 4000, h: 3000 }, fill: '#111' }] })
    const { nodes } = compileScene(scene!, { newId })
    const fitted = fitNodesToArtboard(nodes, sceneBounds(scene!), board) as DrawPathNode[]
    const xs = fitted[0]!.path.subpaths[0]!.nodes.map((p) => p.x)
    const ys = fitted[0]!.path.subpaths[0]!.nodes.map((p) => p.y)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(board.x - 1)
    expect(Math.max(...xs)).toBeLessThanOrEqual(board.x + board.w + 1)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(board.y - 1)
    expect(Math.max(...ys)).toBeLessThanOrEqual(board.y + board.h + 1)
  })

  it('leaves small art at its own size, only moving it onto the page', () => {
    const board = doc().artboards[0]!
    const { scene } = validateScene({ items: [{ shape: { kind: 'rect', x: 0, y: 0, w: 100, h: 50 }, fill: '#111' }] })
    const { nodes } = compileScene(scene!, { newId })
    const fitted = fitNodesToArtboard(nodes, sceneBounds(scene!), board) as DrawPathNode[]
    const xs = fitted[0]!.path.subpaths[0]!.nodes.map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 5)
  })
})

describe('a generated picture lands on a paint layer', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('stores the bytes once and frames the layer on its artboard', () => {
    const d = doc()
    const board = targetArtboard(d)!
    const next = addGeneratedPaintLayer(d, PNG, 'Painted sky', board, { w: 1024, h: 768 })
    const layer = next.layers[1] as DrawDocRasterLayer
    expect(layer.kind).toBe('raster')
    expect(layer.assetId).toBeDefined()
    expect(next.assets[layer.assetId!]!.dataUrl).toBe(PNG)
    // The frame is what makes paint follow its artboard (4.3.41).
    expect(layer.frame).toEqual({ x: board.x, y: board.y, w: board.w, h: board.h })
  })

  it('keeps the bytes once when the same picture lands twice', () => {
    const d = doc()
    const board = targetArtboard(d)!
    const once = addGeneratedPaintLayer(d, PNG, 'A', board)
    const twice = addGeneratedPaintLayer(once, PNG, 'B', board)
    expect(Object.keys(twice.assets)).toHaveLength(1)
  })
})

describe('regenerating a selection replaces it in place', () => {
  it('puts the new objects where the old ones were, in the same layer', () => {
    const d = doc()
    const { nodes: first } = sceneOf([
      { shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 }, fill: '#111', name: 'a' },
      { shape: { kind: 'rect', x: 20, y: 0, w: 10, h: 10 }, fill: '#111', name: 'b' },
      { shape: { kind: 'rect', x: 40, y: 0, w: 10, h: 10 }, fill: '#111', name: 'c' }
    ])
    const withArt = addGeneratedVectorLayer(d, first, 'Art')
    const layerId = withArt.layers[1]!.id
    const { nodes: replacement } = sceneOf([{ shape: { kind: 'ellipse', cx: 5, cy: 5, rx: 5, ry: 5 }, fill: '#2563eb', name: 'round' }])

    const next = replaceObjects(withArt, [first[1]!.id], replacement)
    const layer = next.layers.find((l) => l.id === layerId) as DrawDocVectorLayer
    expect(layer.objects.map((o) => o.name)).toEqual(['a', 'round', 'c'])
  })

  it('does nothing when the ids are not in the document', () => {
    const d = doc()
    expect(replaceObjects(d, ['nope'], [])).toEqual(d)
    expect(replaceObjects(d, [], [])).toBe(d)
  })
})
