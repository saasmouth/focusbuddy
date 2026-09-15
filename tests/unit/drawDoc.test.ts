import { describe, it, expect } from 'vitest'
import {
  DRAW_SIZES,
  activeLayer,
  blankDrawBody,
  drawToSvg,
  estimateWrap,
  findDrawSize,
  moveObject,
  normalizeDrawBody,
  objectBounds,
  objectsBounds,
  paintToCss,
  rasterLayer,
  shapePath,
  solid,
  vectorLayer,
  type DrawBody,
  type DrawObject,
  type DrawVectorLayer
} from '../../src/shared/draw'
import { pathBounds } from '../../src/shared/drawGeometry'

function bodyWith(objects: DrawObject[]): DrawBody {
  const l = vectorLayer('L')
  l.objects = objects
  return { schemaVersion: 1, width: 400, height: 300, background: solid('#ffffff'), layers: [l], activeLayerId: l.id }
}

describe('draw — sizes & blank documents', () => {
  it('every preset has a positive size and a unique id', () => {
    const ids = new Set(DRAW_SIZES.map((s) => s.id))
    expect(ids.size).toBe(DRAW_SIZES.length)
    for (const s of DRAW_SIZES) {
      expect(s.w).toBeGreaterThan(0)
      expect(s.h).toBeGreaterThan(0)
    }
  })

  it('a blank document opens with one empty vector layer already active', () => {
    const b = blankDrawBody(findDrawSize('social-post')!)
    expect(b.width).toBe(1080)
    expect(b.layers).toHaveLength(1)
    expect(b.layers[0].kind).toBe('vector')
    expect(activeLayer(b)!.id).toBe(b.layers[0].id)
  })

  it('an icon preset opens genuinely transparent, not white', () => {
    const b = blankDrawBody(findDrawSize('icon-1024')!)
    expect(b.background.type).toBe('none')
    expect(drawToSvg(b)).not.toContain('<rect')
  })
})

describe('draw — normalisation', () => {
  it('garbage in still yields a usable document', () => {
    const b = normalizeDrawBody(null)
    expect(b.layers).toHaveLength(1)
    expect(b.layers[0].kind).toBe('vector')
    expect(b.width).toBeGreaterThan(0)
  })

  it('a layerless body gets a layer rather than an undrawable canvas', () => {
    expect(normalizeDrawBody({ width: 100, height: 100, layers: [] }).layers).toHaveLength(1)
  })

  it('dimensions clamp into a sane range', () => {
    expect(normalizeDrawBody({ width: -5, height: 99999 }).width).toBe(16)
    expect(normalizeDrawBody({ width: -5, height: 99999 }).height).toBe(12000)
  })

  it('objects with no geometry are dropped, valid ones survive a round trip', () => {
    const src = bodyWith([
      { id: 'a', type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 10, h: 10 }), fill: solid('#f00') },
      { id: 'bad', type: 'path', path: { subpaths: [] }, fill: solid('#0f0') }
    ])
    const out = normalizeDrawBody(JSON.parse(JSON.stringify(src)))
    const objs = (out.layers[0] as DrawVectorLayer).objects
    expect(objs).toHaveLength(1)
    expect(objs[0].id).toBe('a')
  })

  it('an image object with no src is dropped — never rendered as a broken frame', () => {
    const out = normalizeDrawBody({ layers: [{ kind: 'vector', objects: [{ id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10 }] }] })
    expect((out.layers[0] as DrawVectorLayer).objects).toHaveLength(0)
  })

  it('a stroke with zero width or no paint becomes no stroke at all', () => {
    const out = normalizeDrawBody({
      layers: [
        {
          kind: 'vector',
          objects: [
            { id: 'a', type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 4, h: 4 }), fill: solid('#000'), stroke: { width: 0, paint: solid('#000') } },
            { id: 'b', type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 4, h: 4 }), fill: solid('#000'), stroke: { width: 3, paint: { type: 'none' } } }
          ]
        }
      ]
    })
    const objs = (out.layers[0] as DrawVectorLayer).objects
    expect((objs[0] as { stroke?: unknown }).stroke).toBeUndefined()
    expect((objs[1] as { stroke?: unknown }).stroke).toBeUndefined()
  })

  it('gradient stops are sorted and a one-stop gradient falls back', () => {
    const out = normalizeDrawBody({
      layers: [
        {
          kind: 'vector',
          objects: [
            {
              id: 'g',
              type: 'path',
              path: shapePath('rect', { x: 0, y: 0, w: 4, h: 4 }),
              fill: { type: 'linear', stops: [{ offset: 1, color: '#fff' }, { offset: 0, color: '#000' }] }
            }
          ]
        }
      ]
    })
    const fill = (out.layers[0] as DrawVectorLayer).objects[0] as { fill: { type: string; stops: Array<{ offset: number }> } }
    expect(fill.fill.type).toBe('linear')
    expect(fill.fill.stops.map((s) => s.offset)).toEqual([0, 1])
  })

  it('an unknown blend mode falls back to normal instead of emitting invalid CSS', () => {
    const out = normalizeDrawBody({ layers: [{ kind: 'vector', blend: 'plaid', objects: [] }] })
    expect(out.layers[0].blend).toBe('normal')
  })

  it('raster layers keep their pixels', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const out = normalizeDrawBody({ layers: [{ kind: 'raster', src: png }] })
    expect(out.layers[0].kind).toBe('raster')
    expect((out.layers[0] as { src: string }).src).toBe(png)
  })

  it('an activeLayerId pointing at a deleted layer is repaired', () => {
    const out = normalizeDrawBody({ activeLayerId: 'gone', layers: [{ id: 'real', kind: 'vector', objects: [] }] })
    expect(out.activeLayerId).toBe('real')
  })
})

describe('draw — shapes & object maths', () => {
  it('shapePath fills the requested box for every live shape', () => {
    const box = { x: 10, y: 20, w: 80, h: 60 }
    for (const kind of ['rect', 'roundRect', 'ellipse', 'polygon', 'star'] as const) {
      const b = pathBounds(shapePath(kind, box, { sides: 5 }))
      expect(b.w).toBeLessThanOrEqual(box.w + 0.01)
      expect(b.h).toBeLessThanOrEqual(box.h + 0.01)
    }
    expect(pathBounds(shapePath('rect', box))).toEqual(box)
  })

  it('moving an object moves its bounds and nothing else', () => {
    const o: DrawObject = { id: 'a', type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 10, h: 10 }), fill: solid('#000') }
    const b = objectBounds(moveObject(o, 5, 7))
    expect(b).toEqual({ x: 5, y: 7, w: 10, h: 10 })
  })

  it('multi-object bounds is the union', () => {
    const a: DrawObject = { id: 'a', type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 10, h: 10 }), fill: solid('#000') }
    const b: DrawObject = { id: 'b', type: 'image', x: 100, y: 50, w: 20, h: 20, src: 'data:,' }
    expect(objectsBounds([a, b])).toEqual({ x: 0, y: 0, w: 120, h: 70 })
  })
})

describe('draw — rendering', () => {
  it('svg carries the artboard, the fill and the path data', () => {
    const svg = drawToSvg(bodyWith([{ id: 'a', type: 'path', path: shapePath('rect', { x: 1, y: 2, w: 3, h: 4 }), fill: solid('#ff0000') }]))
    expect(svg).toContain('viewBox="0 0 400 300"')
    expect(svg).toContain('fill="#ff0000"')
    expect(svg).toContain('M 1 2')
  })

  it('a hidden object and an invisible layer both render nothing', () => {
    const hidden = bodyWith([{ id: 'a', type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 5, h: 5 }), fill: solid('#000'), hidden: true }])
    expect(drawToSvg(hidden)).not.toContain('<path')
    const off = bodyWith([{ id: 'a', type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 5, h: 5 }), fill: solid('#000') }])
    off.layers[0].visible = false
    expect(drawToSvg(off)).not.toContain('<path')
  })

  it('a gradient fill emits a matching def and reference', () => {
    const svg = drawToSvg(
      bodyWith([
        {
          id: 'g1',
          type: 'path',
          path: shapePath('rect', { x: 0, y: 0, w: 10, h: 10 }),
          fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }
        }
      ])
    )
    expect(svg).toContain('<linearGradient id="grad-g1"')
    expect(svg).toContain('fill="url(#grad-g1)"')
  })

  it('layer blend mode and opacity reach the output', () => {
    const b = bodyWith([{ id: 'a', type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 5, h: 5 }), fill: solid('#000') }])
    b.layers[0].blend = 'multiply'
    b.layers[0].opacity = 0.4
    const svg = drawToSvg(b)
    expect(svg).toContain('mix-blend-mode:multiply')
    expect(svg).toContain('opacity:0.4')
  })

  it('a raster layer is embedded at the artboard size', () => {
    const r = rasterLayer('Paint')
    r.src = 'data:image/png;base64,AAAA'
    const b = bodyWith([])
    b.layers.push(r)
    const svg = drawToSvg(b)
    expect(svg).toContain('href="data:image/png;base64,AAAA"')
    expect(svg).toContain('width="400" height="300"')
  })

  it('an empty raster layer contributes nothing', () => {
    const b = bodyWith([])
    b.layers.push(rasterLayer('Paint'))
    expect(drawToSvg(b)).not.toContain('<image')
  })

  it('text is escaped, never injected', () => {
    const svg = drawToSvg(bodyWith([{ id: 't', type: 'text', x: 0, y: 0, w: 300, text: '<script>x</script>', fontSize: 20, fill: solid('#000') }]))
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })
})

describe('draw — paint to CSS', () => {
  it('solid, none and gradients each map to a real CSS value', () => {
    expect(paintToCss(solid('#abc'))).toBe('#abc')
    expect(paintToCss({ type: 'none' })).toBe('transparent')
    expect(paintToCss({ type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] })).toContain('linear-gradient(90deg')
  })
})

describe('draw — export text wrapping', () => {
  it('explicit newlines always break', () => {
    expect(estimateWrap('a\nb', 1000, 20)).toEqual(['a', 'b'])
  })

  it('a long run of words wraps into several lines', () => {
    const lines = estimateWrap('one two three four five six seven eight', 80, 20)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ')).toBe('one two three four five six seven eight')
  })

  it('a single word wider than the box is never dropped', () => {
    expect(estimateWrap('supercalifragilistic', 10, 20)).toEqual(['supercalifragilistic'])
  })
})
