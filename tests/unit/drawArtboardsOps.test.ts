// WP-ARTBOARD, the pure half: artboard operations on a v2 document
// (src/shared/draw/ops/artboards.ts) and how the serializer frames them.

import { describe, expect, it } from 'vitest'
import type { DrawArtboard, DrawDoc, DrawNode } from '../../src/shared/draw/model'
import {
  addArtboard,
  artboardAt,
  artboardsBounds,
  artOnArtboard,
  deleteArtboards,
  duplicateArtboard,
  fitArtboardTo,
  moveArtboards,
  nextArtboardName,
  nodeBounds,
  patchArtboard,
  rasterFrame,
  rearrangeArtboards,
  rearrangePositions,
  renameArtboard,
  reorderArtboard,
  resizeArtboard
} from '../../src/shared/draw/ops'
import { drawDocToPagesHtml, drawDocToSvg } from '../../src/shared/draw/svg'
import { isV1Representable } from '../../src/shared/draw/migrate'

const WHITE = { type: 'solid', color: '#ffffff' } as const

function board(id: string, x: number, y: number, w: number, h: number, name = id): DrawArtboard {
  return { id, name, x, y, w, h, background: WHITE }
}

function rect(id: string, x: number, y: number, w: number, h: number, extra: Partial<DrawNode> = {}): DrawNode {
  return { id, type: 'path', path: { subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] }, fill: { type: 'solid', color: '#6d5dfc' }, ...extra } as DrawNode
}

function doc(artboards: DrawArtboard[], objects: DrawNode[] = [], extra: Partial<DrawDoc> = {}): DrawDoc {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards,
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {},
    ...extra
  }
}

const objs = (d: DrawDoc): DrawNode[] => (d.layers[0].kind === 'vector' ? d.layers[0].objects : [])
const box = (d: DrawDoc, id: string) => nodeBounds(objs(d).find((o) => o.id === id)!)

describe('adding, naming, deleting and ordering artboards', () => {
  it('a new artboard is "Artboard N", takes the active one\'s background, and becomes active', () => {
    const d0 = doc([board('a1', 0, 0, 400, 300, 'Artboard 1')])
    const d1 = addArtboard(d0, 'a2', { x: 500, y: 0, w: -200, h: 100.4 })
    expect(d1.artboards[1]).toEqual({ id: 'a2', name: 'Artboard 2', x: 300, y: 0, w: 200, h: 100, background: WHITE })
    expect(d1.activeArtboardId).toBe('a2')
    expect(nextArtboardName(renameArtboard(d1, 'a2', 'Artboard 7'))).toBe('Artboard 8')
    expect(isV1Representable(d1)).toBe(false)
  })

  it('delete keeps the art and never the last artboard; the active one moves to a neighbour', () => {
    const d = doc([board('a', 0, 0, 100, 100), board('b', 200, 0, 100, 100), board('c', 400, 0, 100, 100)], [rect('r', 210, 10, 20, 20)], { activeArtboardId: 'b' })
    const after = deleteArtboards(d, ['b'])
    expect(after.artboards.map((a) => a.id)).toEqual(['a', 'c'])
    expect(after.activeArtboardId).toBe('a')
    expect(objs(after)).toBe(objs(d))
    expect(deleteArtboards(d, ['a', 'b', 'c'])).toBe(d)
  })

  it('rename refuses a blank name; reorder clamps', () => {
    const d = doc([board('a', 0, 0, 1, 1), board('b', 2, 0, 1, 1), board('c', 4, 0, 1, 1)])
    expect(renameArtboard(d, 'a', '   ')).toBe(d)
    expect(reorderArtboard(d, 'c', 0).artboards.map((a) => a.id)).toEqual(['c', 'a', 'b'])
    expect(reorderArtboard(d, 'a', 99).artboards.map((a) => a.id)).toEqual(['b', 'c', 'a'])
  })

  it('patch normalises the frame and drops a preset whose size no longer matches', () => {
    const d = doc([{ ...board('a', 0, 0, 1080, 1080), presetId: 'social-post' }])
    const p = patchArtboard(d, 'a', { w: 500.6 })
    expect(p.artboards[0]).toMatchObject({ w: 501, h: 1080 })
    expect(p.artboards[0].presetId).toBeUndefined()
    expect(patchArtboard(d, 'a', { w: 1080 })).toBe(d)
  })

  it('artboardAt finds the topmost artboard under a point; the union frames them all', () => {
    const d = doc([board('a', 0, 0, 100, 100), board('b', 50, 50, 100, 100)])
    expect(artboardAt(d, { x: 60, y: 60 })?.id).toBe('b')
    expect(artboardAt(d, { x: 10, y: 10 })?.id).toBe('a')
    expect(artboardAt(d, { x: 300, y: 10 })).toBeUndefined()
    expect(artboardsBounds(d)).toEqual({ x: 0, y: 0, w: 150, h: 150 })
  })
})

describe('moving artboards moves only the art on them', () => {
  it('art wholly inside moves; art straddling, outside, or locked stays (Move/Copy Artwork with Artboard)', () => {
    const d = doc(
      [board('a', 0, 0, 100, 100), board('b', 200, 0, 100, 100)],
      [rect('in', 10, 10, 20, 20), rect('edge', 90, 10, 30, 20), rect('other', 210, 10, 20, 20), rect('locked', 40, 40, 10, 10, { locked: true })]
    )
    const m = moveArtboards(d, ['a'], 0, 300)
    expect(m.artboards[0]).toMatchObject({ x: 0, y: 300 })
    expect(box(m, 'in')).toMatchObject({ x: 10, y: 310 })
    expect(box(m, 'edge')).toMatchObject({ y: 10 })
    expect(box(m, 'other')).toMatchObject({ y: 10 })
    expect(box(m, 'locked')).toMatchObject({ y: 40 })
    // With the option off, the page moves alone.
    expect(box(moveArtboards(d, ['a'], 0, 300, false), 'in')).toMatchObject({ y: 10 })
    expect(artOnArtboard(d, d.artboards[1]).map((x) => x.node.id)).toEqual(['other'])
  })

  it('duplicate copies the artboard and its art, each copy above its original, with fresh ids', () => {
    const d = doc([board('a', 0, 0, 100, 100, 'Cover')], [rect('r', 10, 10, 20, 20), rect('far', 500, 500, 5, 5)])
    let n = 0
    const r = duplicateArtboard(d, 'a', 'a2', 150, 0, { copyNode: (x) => ({ ...structuredClone(x), id: `copy${++n}` }) })
    expect(r.doc.artboards.map((a) => [a.id, a.name, a.x])).toEqual([
      ['a', 'Cover', 0],
      ['a2', 'Cover copy', 150]
    ])
    expect(objs(r.doc).map((o) => o.id)).toEqual(['r', 'copy1', 'far'])
    expect(box(r.doc, 'copy1')).toMatchObject({ x: 160, y: 10 })
    expect(r.newNodeIds).toEqual(['copy1'])
    expect(r.doc.activeArtboardId).toBe('a2')
  })

  it('fit to artwork covers the art in whole pixels', () => {
    const d = doc([board('a', 0, 0, 100, 100)])
    expect(fitArtboardTo(d, 'a', { x: 10.5, y: 20.2, w: 30, h: 40 }).artboards[0]).toMatchObject({ x: 10, y: 20, w: 31, h: 41 })
  })
})

describe('Rearrange All', () => {
  const sizes = [
    { w: 100, h: 50 },
    { w: 60, h: 80 },
    { w: 100, h: 100 },
    { w: 40, h: 40 },
    { w: 10, h: 10 }
  ]

  it('grid by row: columns as wide as their widest, rows as tall as their tallest, spacing between', () => {
    expect(rearrangePositions(sizes, { layout: 'grid-by-row', count: 2, spacing: 10 })).toEqual([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 0, y: 90 },
      { x: 110, y: 90 },
      { x: 0, y: 200 }
    ])
  })

  it('grid by column, a single row, a single column, and right-to-left', () => {
    expect(rearrangePositions(sizes.slice(0, 3), { layout: 'grid-by-column', count: 2, spacing: 0 })).toEqual([
      { x: 0, y: 0 },
      // Row 0 is as tall as its tallest artboard, the 100 px one in column 1.
      { x: 0, y: 100 },
      { x: 100, y: 0 }
    ])
    expect(rearrangePositions(sizes.slice(0, 3), { layout: 'row', count: 1, spacing: 5 }).map((p) => p.x)).toEqual([0, 105, 170])
    expect(rearrangePositions(sizes.slice(0, 3), { layout: 'column', count: 1, spacing: 5 }).map((p) => p.y)).toEqual([0, 55, 140])
    expect(rearrangePositions(sizes.slice(0, 2), { layout: 'row', count: 1, spacing: 0, rtl: true })).toEqual([
      { x: 60, y: 0 },
      { x: 0, y: 0 }
    ])
  })

  it('no two artboards overlap after any layout, for random sizes (property)', () => {
    let seed = 7
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(rnd() * 9)
      const bs = Array.from({ length: n }, () => ({ w: 1 + Math.floor(rnd() * 500), h: 1 + Math.floor(rnd() * 500) }))
      const layout = (['grid-by-row', 'grid-by-column', 'row', 'column'] as const)[Math.floor(rnd() * 4)]
      const pos = rearrangePositions(bs, { layout, count: 1 + Math.floor(rnd() * 4), spacing: Math.floor(rnd() * 30), rtl: rnd() < 0.3 })
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const a = { ...pos[i], ...bs[i] }
          const b = { ...pos[j], ...bs[j] }
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
          expect(overlap, `${layout} ${i},${j}`).toBe(false)
        }
    }
  })

  it('rearranging carries each artboard\'s own art with it, and only that art', () => {
    const d = doc(
      [board('a', 0, 0, 100, 100), board('b', 500, 500, 100, 100), board('c', 1000, 0, 100, 100)],
      [rect('onB', 510, 520, 10, 10), rect('loose', 300, 300, 10, 10)]
    )
    const r = rearrangeArtboards(d, { layout: 'row', count: 1, spacing: 20, withArt: true })
    expect(r.artboards.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [120, 0],
      [240, 0]
    ])
    expect(box(r, 'onB')).toMatchObject({ x: 130, y: 20 })
    expect(box(r, 'loose')).toMatchObject({ x: 300, y: 300 })
    // In the artboard's frame the art is exactly where it was.
    expect(box(r, 'onB').x - r.artboards[1].x).toBe(box(d, 'onB').x - d.artboards[1].x)
  })
})

describe('sizes and frames with several artboards', () => {
  it('resizing one of several artboards moves the PAGE by the anchor, not the art', () => {
    const d = doc([board('a', 0, 0, 100, 100), board('b', 200, 0, 100, 100)], [rect('r', 220, 20, 10, 10)], { activeArtboardId: 'b' })
    const r = resizeArtboard(d, 200, 100, 'c')
    expect(r.artboards[1]).toMatchObject({ x: 150, y: 0, w: 200, h: 100 })
    expect(box(r, 'r')).toMatchObject({ x: 220, y: 20 })
    // One artboard (a v1 drawing): the page stays at the origin and the art moves, as before.
    const one = resizeArtboard(doc([board('a', 0, 0, 100, 100)], [rect('r', 20, 20, 10, 10)]), 200, 100, 'c')
    expect(one.artboards[0]).toMatchObject({ x: 0, y: 0, w: 200 })
    expect(box(one, 'r')).toMatchObject({ x: 70 })
  })

  it('paint layers keep the first page\'s frame whichever artboard is active', () => {
    const d = doc([board('artboard-1', 0, 0, 400, 300), board('b', 500, 0, 100, 100)], [], { activeArtboardId: 'b' })
    expect(rasterFrame(d)).toEqual({ x: 0, y: 0, w: 400, h: 300 })
    expect(rasterFrame(reorderArtboard(d, 'b', 0))).toEqual({ x: 0, y: 0, w: 400, h: 300 })
  })

  it('SVG export frames one artboard, or the whole canvas with every page\'s background', () => {
    const d = doc([board('a', 0, 0, 100, 100), { ...board('b', 200, 50, 50, 50), background: { type: 'solid', color: '#ff0000' } }], [rect('r', 210, 60, 10, 10)])
    expect(drawDocToSvg(d, { artboardId: 'b' })).toMatch(/^<svg [^>]*width="50" height="50" viewBox="200 50 50 50">/)
    const canvas = drawDocToSvg(d, { canvas: true })
    expect(canvas).toMatch(/viewBox="0 0 250 100"/)
    expect(canvas).toContain('<rect x="0" y="0" width="100" height="100" fill="#ffffff"/>')
    expect(canvas).toContain('<rect x="200" y="50" width="50" height="50" fill="#ff0000"/>')
  })

  it('the PDF page HTML has one page per artboard, each with its own size, in panel order', () => {
    const d = doc([board('a', 0, 0, 100, 200), board('b', 300, 0, 400, 50), board('c', 0, 300, 10, 10)])
    const html = drawDocToPagesHtml(reorderArtboard(d, 'c', 0), (a) => ({ w: a.w, h: a.h }))
    expect(html.match(/<div class="ab\d">/g)).toHaveLength(3)
    expect(html).toContain('@page ab0{size:10px 10px;margin:0}')
    expect(html).toContain('@page ab1{size:100px 200px;margin:0}')
    expect(html).toContain('@page ab2{size:400px 50px;margin:0}')
    expect(html.indexOf('viewBox="0 300 10 10"')).toBeLessThan(html.indexOf('viewBox="0 0 100 200"'))
  })
})
