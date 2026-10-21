import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { drawBodyForStorage, drawToSvg, normalizeDrawBody, type DrawBody } from '../../src/shared/draw'
import { assetIdFor, sha256Hex } from '../../src/shared/draw/assets'
import { DRAW_V2_WRITES, drawDocCompatibility, drawDocForStorage, pruneAssets } from '../../src/shared/draw/compat'
import { isV1Representable, v1Obstacle, v1ToV2, v2ToV1 } from '../../src/shared/draw/migrate'
import type { DrawDoc } from '../../src/shared/draw/model'
import { normalizeDrawDoc, registerDrawField, unregisterDrawField } from '../../src/shared/draw/normalize'
import { drawDocToSvg } from '../../src/shared/draw/svg'

// Schema v2 and the v1 -> v2 migration.
//
// THE GATE (ARCHITECTURE §2.4): over a corpus of v1 drawings -- every object
// kind, every paint, every stroke option, text with and without measured
// lines, embedded images, work widgets, raster layers, hidden and locked
// layers, transparent and gradient pages, dpi, an unknown object, a hostile
// document, and the documents the existing e2e specs use -- the SVG of a v1
// body and of its migrated v2 document must be BYTE-IDENTICAL. No exceptions
// were needed, so none are listed.

const CORPUS_DIR = join(__dirname, '../fixtures/draw/v1')
const corpus = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ name: f.replace(/\.json$/, ''), raw: JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as unknown }))

describe('the v1 corpus', () => {
  it('covers every object kind and layer kind v1 has', () => {
    const types = new Set<string>()
    const kinds = new Set<string>()
    for (const { raw } of corpus) {
      for (const l of (raw as { layers?: Array<{ kind?: string; objects?: Array<{ type?: string }> }> }).layers ?? []) {
        kinds.add(l.kind ?? 'vector')
        for (const o of l.objects ?? []) types.add(o.type ?? 'path')
      }
    }
    for (const t of ['path', 'text', 'image', 'widget']) expect(types).toContain(t)
    expect(kinds).toEqual(new Set(['vector', 'raster']))
    expect(corpus.length).toBeGreaterThanOrEqual(15)
  })
})

describe.each(corpus)('v1 -> v2: $name', ({ raw }) => {
  const v1 = normalizeDrawBody(raw)
  const v2 = v1ToV2(v1)

  it('renders byte-identical SVG', () => {
    expect(drawDocToSvg(v2)).toBe(drawToSvg(v1))
  })

  it('the full load path (normalizeDrawDoc) agrees too', () => {
    // A body with ids this app could not have minted gets fresh ones on every
    // load, so those are compared by position (ARCHITECTURE: "ids normalised").
    const norm = (svg: string): string => {
      const seen = new Map<string, string>()
      return svg.replace(/(?:obj|lyr)-[a-z0-9]+-[a-z0-9]+/g, (m) => {
        if (!seen.has(m)) seen.set(m, `ID${seen.size}`)
        return seen.get(m)!
      })
    }
    expect(norm(drawDocToSvg(normalizeDrawDoc(raw)))).toBe(norm(drawToSvg(normalizeDrawBody(raw))))
  })

  it('round-trips back to the same v1 body, key order and all', () => {
    const back = v2ToV1(v2)
    expect(back).toEqual(v1)
    expect(JSON.stringify(back)).toBe(JSON.stringify(v1))
  })

  it('normalising is idempotent, in v1 and in v2', () => {
    expect(normalizeDrawBody(v1)).toEqual(v1)
    const once = normalizeDrawDoc(raw)
    expect(normalizeDrawDoc(once)).toEqual(once)
  })

  it('writes back exactly what v1 writes while v2 writes are off', () => {
    expect(DRAW_V2_WRITES).toBe(false)
    expect(JSON.stringify(drawDocForStorage(v2))).toBe(JSON.stringify(drawBodyForStorage(v1)))
  })

  it('is representable as v1 and judged the same by the v1 and v2 guards', () => {
    expect(isV1Representable(v2)).toBe(true)
    expect(drawDocCompatibility(raw).readOnly).toBe((raw as { layers?: Array<{ objects?: Array<{ type?: string }> }> }).layers?.some((l) => l.objects?.some((o) => o.type === 'hologram')) ?? false)
  })
})

describe('the migration itself', () => {
  const raw = JSON.parse(readFileSync(join(CORPUS_DIR, '08-images.json'), 'utf8'))
  const v1 = normalizeDrawBody(raw)
  const v2 = v1ToV2(v1)

  it('moves page size and background to artboards[0] and dpi to settings', () => {
    const v = v1ToV2(normalizeDrawBody(JSON.parse(readFileSync(join(CORPUS_DIR, '12-print-dpi.json'), 'utf8'))))
    expect(v.artboards).toEqual([{ id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 1240, h: 1754, background: { type: 'solid', color: '#ffffff' } }])
    expect(v.settings).toEqual({ dpi: 150 })
    expect(v.schemaVersion).toBe(2)
    expect(v.minWriterVersion).toBe(2)
  })

  it('stores each distinct image ONCE, under its content hash', () => {
    const imgs = (v2.layers[0] as { objects: Array<{ id: string; assetId?: string }> }).objects
    const one = imgs.find((o) => o.id === 'img1')!.assetId
    expect(imgs.find((o) => o.id === 'img-dup')!.assetId).toBe(one)
    expect(Object.keys(v2.assets)).toHaveLength(3)
    expect(one).toMatch(/^asset-[0-9a-f]{32}$/)
    // No image object carries bytes any more.
    expect(JSON.stringify(v2.layers)).not.toContain('data:image')
  })

  it('passes objects that hold no bytes through BY REFERENCE (undo keeps its structural sharing)', () => {
    const shapes = normalizeDrawBody(JSON.parse(readFileSync(join(CORPUS_DIR, '02-every-shape-kind.json'), 'utf8')))
    const migrated = v1ToV2(shapes)
    const a = (shapes.layers[0] as { objects: unknown[] }).objects
    const b = (migrated.layers[0] as { objects: unknown[] }).objects
    a.forEach((o, i) => expect(b[i]).toBe(o))
    const back = v2ToV1(migrated)
    ;(back.layers[0] as { objects: unknown[] }).objects.forEach((o, i) => expect(o).toBe(a[i]))
  })

  it('SHA-256 matches the published test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    // A multi-block input and a non-ASCII one, against Node's own implementation.
    for (const s of ['x'.repeat(1000), 'PlexiiDraw — ✏️ 漢字', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'))
    }
    expect(assetIdFor('data:image/png;base64,AA')).toBe(`asset-${createHash('sha256').update('data:image/png;base64,AA').digest('hex').slice(0, 32)}`)
  })
})

// ── v2-only content ──────────────────────────────────────────────────────────

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const sq = (x: number, y: number, w: number, h: number): unknown => ({ subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] })

function v2Doc(objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Front', x: 0, y: 0, w: 300, h: 200, background: { type: 'solid', color: '#ffffff' } }],
    layers: [{ id: 'L1', kind: 'vector', name: 'L', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {},
    ...extra
  }
}

describe('v2 rendering of what v1 could not hold', () => {
  it('a group renders as <g>, with its matrix', () => {
    const doc = normalizeDrawDoc(v2Doc([{ id: 'g', type: 'group', transform: [1, 0, 0, 1, 10, 20], children: [{ id: 'a', type: 'path', path: sq(0, 0, 10, 10), fill: { type: 'solid', color: '#ff0000' } }] }]))
    expect(drawDocToSvg(doc)).toContain('<g transform="matrix(1 0 0 1 10 20)"><path d="M 0 0 L 10 0 L 10 10 L 0 10 Z" fill="#ff0000"/></g>')
  })

  it('a clipping group clips with its TOPMOST member, which is not itself painted', () => {
    const doc = normalizeDrawDoc(
      v2Doc([
        {
          id: 'g',
          type: 'group',
          clip: true,
          children: [
            { id: 'art', type: 'path', path: sq(0, 0, 100, 100), fill: { type: 'solid', color: '#00ff00' } },
            { id: 'mask', type: 'path', path: sq(25, 25, 50, 50), fill: { type: 'solid', color: '#000000' } }
          ]
        }
      ])
    )
    const svg = drawDocToSvg(doc)
    expect(svg).toContain('<clipPath id="clip-g"><path d="M 25 25 L 75 25 L 75 75 L 25 75 Z"/></clipPath>')
    expect(svg).toContain('<g clip-path="url(#clip-g)"><path d="M 0 0 L 100 0 L 100 100 L 0 100 Z" fill="#00ff00"/></g>')
    expect(svg).not.toContain('fill="#000000"')
  })

  it('swatch references resolve to their colour, tints mix towards white, a missing swatch paints nothing', () => {
    const doc = normalizeDrawDoc(
      v2Doc(
        [
          { id: 'a', type: 'path', path: sq(0, 0, 10, 10), fill: { type: 'swatch', id: 'brand' } },
          { id: 'b', type: 'path', path: sq(20, 0, 10, 10), fill: { type: 'swatch', id: 'brand', tint: 0.5 } },
          { id: 'c', type: 'path', path: sq(40, 0, 10, 10), fill: { type: 'swatch', id: 'gone' } }
        ],
        { swatches: [{ id: 'brand', name: 'Brand', color: '#6d5dfc', global: true }] }
      )
    )
    const svg = drawDocToSvg(doc)
    expect(svg).toContain('fill="#6d5dfc"')
    expect(svg).toContain('fill="#b6aefe"')
    expect(svg).toMatch(/L 40 10 Z" fill="none"/)
  })

  it('gradient endpoints and radial centre/focal reach the file', () => {
    const doc = normalizeDrawDoc(
      v2Doc([
        { id: 'l', type: 'path', path: sq(0, 0, 10, 10), fill: { type: 'linear', from: { x: 0.1, y: 0.2 }, to: { x: 0.9, y: 0.8 }, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] } },
        { id: 'r', type: 'path', path: sq(0, 0, 10, 10), fill: { type: 'radial', center: { x: 0.3, y: 0.4 }, radius: 0.7, focal: { x: 0.2, y: 0.2 }, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] } }
      ])
    )
    const svg = drawDocToSvg(doc)
    expect(svg).toContain('<linearGradient id="grad-l" x1="0.1000" y1="0.2000" x2="0.9000" y2="0.8000">')
    expect(svg).toContain('<radialGradient id="grad-r" cx="0.3000" cy="0.4000" r="0.7000" fx="0.2000" fy="0.2000">')
  })

  it('an appearance stack paints its fills then its strokes, bottom-up', () => {
    const doc = normalizeDrawDoc(
      v2Doc([
        {
          id: 'p',
          type: 'path',
          path: sq(0, 0, 10, 10),
          fill: { type: 'solid', color: '#999999' },
          appearance: {
            fills: [
              { id: 'f1', paint: { type: 'solid', color: '#ff0000' } },
              { id: 'f2', paint: { type: 'solid', color: '#00ff00' }, opacity: 0.5 }
            ],
            strokes: [{ id: 's1', stroke: { paint: { type: 'solid', color: '#0000ff' }, width: 4 } }],
            effects: [{ id: 'e1', kind: 'dropShadow', dx: 2, dy: 2, blur: 3, color: '#000000', opacity: 0.4 }]
          }
        }
      ])
    )
    const svg = drawDocToSvg(doc)
    const f1 = svg.indexOf('fill="#ff0000"')
    const f2 = svg.indexOf('fill="#00ff00"')
    const s1 = svg.indexOf('stroke="#0000ff"')
    expect(f1).toBeGreaterThan(0)
    expect(f2).toBeGreaterThan(f1)
    expect(s1).toBeGreaterThan(f2)
    expect(svg).toContain('style="opacity:0.5"')
    // The legacy single fill is not ALSO drawn.
    expect(svg).not.toContain('#999999')
  })

  it('an image draws from the asset store; a template layer is left out of the export', () => {
    const id = assetIdFor(PNG)
    const doc = normalizeDrawDoc({
      ...v2Doc([{ id: 'i', type: 'image', x: 1, y: 2, w: 3, h: 4, assetId: id }]),
      assets: { [id]: { mime: 'image/png', dataUrl: PNG } },
      layers: [
        { id: 'L1', kind: 'vector', name: 'L', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [{ id: 'i', type: 'image', x: 1, y: 2, w: 3, h: 4, assetId: id }] },
        { id: 'T', kind: 'vector', name: 'Trace', template: true, visible: true, locked: true, opacity: 0.5, blend: 'normal', objects: [{ id: 't', type: 'path', path: sq(0, 0, 5, 5), fill: { type: 'solid', color: '#123456' } }] }
      ]
    })
    const svg = drawDocToSvg(doc)
    expect(svg).toContain(`<image href="${PNG}" x="1" y="2" width="3" height="4"`)
    expect(svg).not.toContain('#123456')
  })

  it('exports any artboard by id, framed on it', () => {
    const doc = normalizeDrawDoc(
      v2Doc([], {
        artboards: [
          { id: 'a1', name: 'One', x: 0, y: 0, w: 100, h: 100, background: { type: 'none' } },
          { id: 'a2', name: 'Two', x: 200, y: 50, w: 300, h: 150, background: { type: 'solid', color: '#000000' } }
        ]
      })
    )
    expect(drawDocToSvg(doc, { artboardId: 'a2' })).toContain('width="300" height="150" viewBox="200 50 300 150"><rect x="200" y="50" width="300" height="150" fill="#000000"/>')
  })
})

describe('v2 forward compatibility', () => {
  it('unknown node types inside groups are carried and restored verbatim', () => {
    const future = { id: 'f', type: 'symbol', symbolId: 's1', extra: { deep: [1, 2, 3] } }
    const raw = v2Doc([{ id: 'g', type: 'group', children: [future, { id: 'a', type: 'path', path: sq(0, 0, 1, 1), fill: { type: 'none' } }] }])
    const doc = normalizeDrawDoc(raw)
    const stored = drawDocForStorage(doc, { stored: 2 }) as DrawDoc
    const g = (stored.layers[0] as { objects: Array<{ children: unknown[] }> }).objects[0]
    expect(JSON.stringify(g.children[0])).toBe(JSON.stringify(future))
    expect(drawDocCompatibility(raw).unknownTypes).toEqual(['symbol'])
  })

  it('an unknown FIELD on a node, a layer, an artboard and the document survives load and save', () => {
    const raw = v2Doc([{ id: 'a', type: 'path', path: sq(0, 0, 1, 1), fill: { type: 'none' }, futureField: { keep: true } }], { futureDocField: 7 })
    ;(raw.layers as Array<Record<string, unknown>>)[0].futureLayerField = 'x'
    ;(raw.artboards as Array<Record<string, unknown>>)[0].bleed = 9
    const stored = drawDocForStorage(normalizeDrawDoc(raw), { stored: 2 }) as unknown as Record<string, unknown>
    const text = JSON.stringify(stored)
    for (const s of ['"futureField":{"keep":true}', '"futureDocField":7', '"futureLayerField":"x"', '"bleed":9']) expect(text).toContain(s)
    // ...and none of it can be written as v1.
    expect(v1Obstacle(normalizeDrawDoc(raw))).toBeTruthy()
  })

  it('an effect kind outside the closed list is kept verbatim and makes the document read-only', () => {
    const raw = v2Doc([{ id: 'a', type: 'path', path: sq(0, 0, 1, 1), fill: { type: 'none' }, appearance: { fills: [], strokes: [], effects: [{ id: 'e', kind: 'raytrace', samples: 64 }] } }])
    const c = drawDocCompatibility(raw)
    expect(c.readOnly).toBe(true)
    expect(c.unknownTypes).toEqual(['effect:raytrace'])
    const doc = normalizeDrawDoc(raw)
    expect(JSON.stringify(doc)).toContain('"kind":"raytrace","samples":64')
  })

  it('schema 3 is read-only for this reader; schema 2 is not', () => {
    expect(drawDocCompatibility(v2Doc([])).readOnly).toBe(false)
    expect(drawDocCompatibility({ ...v2Doc([]), schemaVersion: 3 }).reasons).toEqual(['newer-schema'])
    expect(drawDocCompatibility({ ...v2Doc([]), minWriterVersion: 3 }).readOnly).toBe(true)
  })

  it('a field hook normalises a package\'s field on every load', () => {
    registerDrawField('node', 'arrows', (v) => (v && typeof v === 'object' && typeof (v as { end?: unknown }).end === 'string' ? { end: (v as { end: string }).end.slice(0, 20) } : undefined))
    try {
      const doc = normalizeDrawDoc(v2Doc([
        { id: 'ok', type: 'path', path: sq(0, 0, 1, 1), fill: { type: 'none' }, arrows: { end: 'triangle', junk: 1 } },
        { id: 'bad', type: 'path', path: sq(0, 0, 1, 1), fill: { type: 'none' }, arrows: 42 }
      ]))
      const objs = (doc.layers[0] as { objects: Array<Record<string, unknown>> }).objects
      expect(objs[0].arrows).toEqual({ end: 'triangle' })
      expect('arrows' in objs[1]).toBe(false)
    } finally {
      unregisterDrawField('node', 'arrows')
    }
  })
})

describe('writing: v2 is gated behind the guard', () => {
  it('with writes off, a migrated v1 drawing is written as v1 -- an older app can open it', () => {
    const v1 = normalizeDrawBody(JSON.parse(readFileSync(join(CORPUS_DIR, '10-raster-layers.json'), 'utf8')))
    const out = drawDocForStorage(v1ToV2(v1)) as DrawBody
    expect(out.schemaVersion).toBe(1)
    expect(JSON.stringify(out)).toBe(JSON.stringify(drawBodyForStorage(v1)))
  })

  it('with writes on, it is written as v2 with minWriterVersion 2 -- which the guard release opens read-only', async () => {
    const v1 = normalizeDrawBody(JSON.parse(readFileSync(join(CORPUS_DIR, '08-images.json'), 'utf8')))
    const out = drawDocForStorage(v1ToV2(v1), { allowV2: true }) as DrawDoc
    expect(out.schemaVersion).toBe(2)
    expect(out.minWriterVersion).toBe(2)
    const { drawCompatibility } = await import('../../src/shared/draw')
    expect(drawCompatibility(out).readOnly).toBe(true)
    // ...but SHOWS it: the guard release reads the size and the images.
    const shown = normalizeDrawBody(out)
    expect(shown.width).toBe(400)
    expect(JSON.stringify(shown)).toContain('data:image/png')
  })

  it('a drawing that already IS v2 stays v2 even with writes off (writing it as v1 would lose it)', () => {
    const doc = normalizeDrawDoc(v2Doc([{ id: 'g', type: 'group', children: [] }]))
    expect((drawDocForStorage(doc, { stored: 2 }) as DrawDoc).schemaVersion).toBe(2)
  })

  it('v2ToV1 refuses rather than drops what v1 cannot hold', () => {
    const plainBoard = { artboards: [{ id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 300, h: 200, background: { type: 'solid', color: '#ffffff' } }] }
    const doc = normalizeDrawDoc(v2Doc([{ id: 'g', type: 'group', children: [] }], plainBoard))
    expect(() => v2ToV1(doc)).toThrow(/cannot be saved in the older format: it has a group/)
    expect(() => v2ToV1(normalizeDrawDoc(v2Doc([])))).toThrow(/a named artboard/)
    expect(v1Obstacle(normalizeDrawDoc(v2Doc([], { ...plainBoard, swatches: [{ id: 's', name: 's', color: '#000' }] })))).toBe('swatches')
  })

  it('assets nothing refers to are pruned on write, never while editing', () => {
    const v1 = normalizeDrawBody(JSON.parse(readFileSync(join(CORPUS_DIR, '08-images.json'), 'utf8')))
    const doc = v1ToV2(v1)
    const orphaned = { ...doc, assets: { ...doc.assets, 'asset-00000000000000000000000000000000': { mime: 'image/png', dataUrl: PNG } } }
    expect(Object.keys(pruneAssets(orphaned).assets)).toHaveLength(3)
    expect(pruneAssets(doc)).toBe(doc)
  })
})
