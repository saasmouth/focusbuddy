import { describe, it, expect } from 'vitest'
import {
  DRAW_SCHEMA_VERSION,
  drawBodyForStorage,
  drawCompatibility,
  drawToSvg,
  normalizeDrawBody,
  refusesDrawOverwrite,
  type DrawVectorLayer
} from '../../src/shared/draw'

// The forward-compatibility guard. An older PlexiiDraw that opens a drawing a
// newer one made must (1) notice, (2) never write it back, and (3) never drop
// what it does not understand on the way through. Before the guard the
// normaliser dropped every object of an unknown type, so merely opening a newer
// drawing and saving -- or co-editing it live -- destroyed the newer work.

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function rect(id: string): Record<string, unknown> {
  return {
    id,
    type: 'path',
    path: { subpaths: [{ closed: true, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }] },
    fill: { type: 'solid', color: '#ff0000' }
  }
}

/** What a v2 writer is planned to produce (ARCHITECTURE §2), as far as a v1 reader can see it. */
function newerBody(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 640, h: 480, background: { type: 'solid', color: '#ffffff' } }],
    assets: { 'asset-abc': { mime: 'image/png', dataUrl: PNG, w: 1, h: 1 } },
    swatches: [{ id: 'sw1', name: 'Brand', color: '#6d5dfc', global: true }],
    layers: [
      {
        id: 'L1',
        kind: 'vector',
        name: 'Layer 1',
        visible: true,
        locked: false,
        opacity: 1,
        blend: 'normal',
        objects: [
          rect('r1'),
          { id: 'g1', type: 'group', clip: true, children: [rect('r2'), rect('r3')], transform: [1, 0, 0, 1, 5, 5] },
          { id: 'img1', type: 'image', x: 1, y: 2, w: 3, h: 4, assetId: 'asset-abc' }
        ]
      }
    ]
  }
}

describe('drawCompatibility — the guard', () => {
  it('this build is schema version 1', () => {
    expect(DRAW_SCHEMA_VERSION).toBe(1)
  })

  it('a v1 body, and a body that declares no version, are fully editable', () => {
    expect(drawCompatibility({ schemaVersion: 1, layers: [{ kind: 'vector', objects: [rect('a')] }] }).readOnly).toBe(false)
    expect(drawCompatibility({ layers: [] }).readOnly).toBe(false)
    expect(drawCompatibility(null).readOnly).toBe(false)
  })

  it('a newer schemaVersion opens read-only', () => {
    const c = drawCompatibility({ schemaVersion: 2, layers: [] })
    expect(c.readOnly).toBe(true)
    expect(c.reasons).toContain('newer-schema')
    expect(c.schemaVersion).toBe(2)
  })

  it('a higher minWriterVersion opens read-only even when the shape version is old', () => {
    const c = drawCompatibility({ schemaVersion: 1, minWriterVersion: 3, layers: [] })
    expect(c.readOnly).toBe(true)
    expect(c.minWriterVersion).toBe(3)
  })

  it('an unknown object type opens read-only and is counted by type', () => {
    const c = drawCompatibility({ schemaVersion: 1, layers: [{ kind: 'vector', objects: [rect('a'), { id: 'g', type: 'group' }, { id: 's', type: 'symbol' }, { id: 'g2', type: 'group' }] }] })
    expect(c.readOnly).toBe(true)
    expect(c.reasons).toEqual(['unknown-objects'])
    expect(c.unknownTypes).toEqual(['group', 'symbol'])
    expect(c.unknownCount).toBe(3)
  })

  it('an unknown layer kind opens read-only', () => {
    expect(drawCompatibility({ layers: [{ kind: 'adjustment', id: 'x' }] }).reasons).toEqual(['unknown-layers'])
  })

  it('every object kind this build makes is known (no false read-only)', () => {
    const body = {
      layers: [
        {
          kind: 'vector',
          objects: [
            rect('p'),
            { id: 't', type: 'text', x: 0, y: 0, w: 10, text: 'x', fontSize: 10, fill: { type: 'none' } },
            { id: 'i', type: 'image', x: 0, y: 0, w: 1, h: 1, src: PNG },
            { id: 'w', type: 'widget', x: 0, y: 0, w: 1, h: 1, widgetId: 'wf:abc' }
          ]
        },
        { kind: 'raster', src: '' }
      ]
    }
    expect(drawCompatibility(body).readOnly).toBe(false)
  })
})

describe('unknown objects survive a load/save round trip', () => {
  it('an unknown object is carried, not dropped, and is written back byte-for-byte', () => {
    const raw = newerBody()
    const loaded = normalizeDrawBody(raw)
    const objs = (loaded.layers[0] as DrawVectorLayer).objects
    // The group is still there, as an opaque object holding its original JSON.
    const g = objs.find((o) => o.id === 'g1')
    expect(g?.type).toBe('opaque')
    const stored = drawBodyForStorage(loaded)
    const storedObjs = (stored.layers[0] as DrawVectorLayer).objects as unknown[]
    const original = ((raw.layers as Array<Record<string, unknown>>)[0].objects as unknown[])[1]
    expect(JSON.stringify(storedObjs.find((o) => (o as { id: string }).id === 'g1'))).toBe(JSON.stringify(original))
  })

  it('normalising twice never wraps an opaque object twice', () => {
    const once = normalizeDrawBody(newerBody())
    const twice = normalizeDrawBody(once)
    const a = (once.layers[0] as DrawVectorLayer).objects.find((o) => o.id === 'g1')
    const b = (twice.layers[0] as DrawVectorLayer).objects.find((o) => o.id === 'g1')
    expect(b).toEqual(a)
    expect(JSON.stringify(drawBodyForStorage(twice))).toBe(JSON.stringify(drawBodyForStorage(once)))
  })

  it('an opaque object never reaches the exported SVG, whatever it holds', () => {
    const hostile = normalizeDrawBody({
      layers: [{ kind: 'vector', objects: [{ id: 'x', type: 'future', markup: '<script>alert(1)</script>', d: 'M0 0' }] }]
    })
    const svg = drawToSvg(hostile)
    expect(svg).not.toContain('script')
    expect(svg).not.toContain('future')
  })

  it('a body with no opaque objects is returned untouched by drawBodyForStorage (identity)', () => {
    const b = normalizeDrawBody({ layers: [{ kind: 'vector', objects: [rect('a')] }] })
    expect(drawBodyForStorage(b)).toBe(b)
  })
})

describe('a newer drawing is still SHOWN at its real size with its pictures', () => {
  it('reads the size from the first artboard and images from the asset store', () => {
    const shown = normalizeDrawBody(newerBody())
    expect(shown.width).toBe(640)
    expect(shown.height).toBe(480)
    const img = (shown.layers[0] as DrawVectorLayer).objects.find((o) => o.id === 'img1')
    expect(img?.type).toBe('image')
    expect(img && img.type === 'image' ? img.src : '').toBe(PNG)
  })

  it('an asset that is not embedded image bytes is not shown', () => {
    const raw = newerBody()
    ;(raw.assets as Record<string, unknown>)['asset-abc'] = { dataUrl: 'https://tracker.example/p.gif' }
    const shown = normalizeDrawBody(raw)
    expect((shown.layers[0] as DrawVectorLayer).objects.find((o) => o.id === 'img1')).toBeUndefined()
  })
})

describe('refusesDrawOverwrite — the store never downgrades a newer drawing', () => {
  it('refuses an older-format body over a newer one', () => {
    const older = { schemaVersion: 1, layers: [{ kind: 'vector', objects: [] }] }
    expect(refusesDrawOverwrite(newerBody(), older)).toBe(true)
  })

  it('allows a newer body to arrive over a newer one (sync, version history)', () => {
    expect(refusesDrawOverwrite(newerBody(), newerBody())).toBe(false)
  })

  it('allows ordinary saves of ordinary drawings', () => {
    const v1 = { schemaVersion: 1, layers: [{ kind: 'vector', objects: [rect('a')] }] }
    expect(refusesDrawOverwrite(v1, v1)).toBe(false)
  })
})

describe('work widgets placed on a drawing survive being opened again', () => {
  // Found while building the guard: normObject had no widget branch, so a
  // widget fell through to the path branch, had no geometry and was dropped
  // on every load -- the current build destroying its own object kind.
  it('normalizeDrawBody keeps a widget object', () => {
    const b = normalizeDrawBody({ layers: [{ kind: 'vector', objects: [{ id: 'w1', type: 'widget', x: 10, y: 20, w: 300, h: 200, widgetId: 'wf:file-1', rotation: 15 }] }] })
    const o = (b.layers[0] as DrawVectorLayer).objects[0]
    expect(o).toEqual({ id: 'w1', type: 'widget', x: 10, y: 20, w: 300, h: 200, widgetId: 'wf:file-1', rotation: 15 })
  })

  it('a widget id that is not a plain id is dropped, not carried', () => {
    const b = normalizeDrawBody({ layers: [{ kind: 'vector', objects: [{ id: 'w1', type: 'widget', x: 0, y: 0, w: 1, h: 1, widgetId: '"><img src=x>' }] }] })
    expect((b.layers[0] as DrawVectorLayer).objects).toHaveLength(0)
  })
})
