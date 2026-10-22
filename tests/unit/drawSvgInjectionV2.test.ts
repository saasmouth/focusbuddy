import { describe, it, expect } from 'vitest'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import { drawDocToHtml, drawDocToSvg } from '../../src/shared/draw/svg'
import type { DrawDoc } from '../../src/shared/draw/model'

// The injection suite (drawSvgInjection.test.tsx) extended to every field v2
// adds. A shared drawing is untrusted input: whatever a v2 document says --
// in artboards, swatches, gradient endpoints, transforms, clip groups,
// appearance stacks, effects, the asset store, layer colours, guides,
// settings -- the exported markup contains only the elements and attributes
// PlexiiDraw itself writes. Checked twice: after normalising, and with the
// raw hostile document handed straight to the serializer (which must not
// trust its caller to have normalised).

const PWN = 'window.__pwned=1'
const HOSTILE = `x"/><img src="x" onerror="${PWN}"><path fill="`
const HOSTILE_URL = 'red;background:url(https://tracker.example/p.gif)'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const tri = { subpaths: [{ closed: true, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] }

function hostileV2(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: HOSTILE, name: HOSTILE, x: HOSTILE, y: 0, w: 200, h: 200, background: { type: 'solid', color: HOSTILE } }],
    assets: {
      [HOSTILE]: { mime: HOSTILE, dataUrl: `javascript:${PWN}` },
      'asset-remote': { mime: 'image/png', dataUrl: 'https://tracker.example/x.png' },
      'asset-ok': { mime: 'image/png', dataUrl: PNG }
    },
    swatches: [{ id: 'sw', name: HOSTILE, color: HOSTILE }, { id: 'sw2', name: 'ok', color: HOSTILE_URL }, { id: HOSTILE, name: 'x', color: '#00ff00' }],
    guides: [{ id: HOSTILE, axis: 'x', at: HOSTILE }],
    settings: { units: HOSTILE, dpi: HOSTILE, grid: { size: HOSTILE } },
    layers: [
      {
        id: HOSTILE,
        kind: 'vector',
        name: HOSTILE,
        color: HOSTILE,
        objects: [
          {
            id: HOSTILE,
            type: 'group',
            clip: true,
            transform: [1, 0, 0, 1, HOSTILE, 0],
            children: [
              {
                id: `${HOSTILE}a`,
                type: 'path',
                path: tri,
                fill: { type: 'swatch', id: 'sw' },
                stroke: { width: 2, paint: { type: 'swatch', id: HOSTILE }, dash: [HOSTILE, 2] },
                appearance: {
                  fills: [{ id: HOSTILE, paint: { type: 'linear', from: { x: HOSTILE, y: 0 }, to: { x: 1, y: 1 }, stops: [{ offset: 0, color: HOSTILE }, { offset: 1, color: '#fff' }] }, blend: HOSTILE }],
                  strokes: [{ id: 'k', stroke: { width: HOSTILE, paint: { type: 'radial', center: { x: HOSTILE, y: 1 }, focal: { x: 0, y: HOSTILE }, radius: HOSTILE, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: HOSTILE_URL }] } } }],
                  effects: [{ id: 'e', kind: 'dropShadow', color: HOSTILE, dx: HOSTILE }, { id: 'f', kind: HOSTILE, filter: `<filter onload="${PWN}">` }]
                }
              },
              { id: `${HOSTILE}t`, type: 'text', x: 0, y: 0, w: 100, text: `<script>${PWN}</script>`, fontSize: 12, fill: { type: 'swatch', id: 'sw2' }, transform: [HOSTILE, 0, 0, 1, 0, 0], rotation: HOSTILE },
              { id: 'img', type: 'image', x: 0, y: 0, w: 5, h: 5, assetId: HOSTILE },
              { id: 'img-remote', type: 'image', x: 0, y: 0, w: 5, h: 5, assetId: 'asset-remote' },
              { id: 'img-ok', type: 'image', x: 0, y: 0, w: 5, h: 5, assetId: 'asset-ok', transform: [1, 0, 0, 1, 0, 0] },
              { id: 'img-inline-js', type: 'image', x: 0, y: 0, w: 5, h: 5, src: `javascript:${PWN}` },
              { id: 'clipper', type: 'path', path: tri, fill: { type: 'solid', color: '#000' } }
            ]
          },
          { id: 'opq', type: 'hologram', markup: `<svg onload="${PWN}">` }
        ]
      },
      { id: 'R', kind: 'raster', assetId: 'asset-remote' },
      // A paint layer's own frame (4.3.41) reaches the <image>'s x, y, width and height.
      { id: 'R2', kind: 'raster', assetId: 'asset-ok', frame: { x: HOSTILE, y: `1${HOSTILE}`, w: HOSTILE, h: 5 } },
      { id: 'R3', kind: 'raster', assetId: 'asset-ok', frame: { x: 3, y: 4, w: 5, h: `6" onload="${PWN}` } }
    ]
  }
}

const TAGS = new Set(['svg', 'defs', 'g', 'linearGradient', 'radialGradient', 'stop', 'path', 'text', 'tspan', 'image', 'rect', 'clipPath'])
const ATTRS = new Set([
  'xmlns', 'xmlns:xlink', 'width', 'height', 'viewBox', 'style',
  'id', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'fx', 'fy', 'offset', 'stop-color', 'stop-opacity',
  'd', 'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'clip-path', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-miterlimit',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'transform',
  'x', 'y', 'href', 'preserveAspectRatio'
])

function assertOwnMarkup(svg: string): void {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  expect(root.tagName).toBe('svg')
  const all = [root, ...Array.from(root.querySelectorAll('*'))]
  for (const el of all) {
    expect(TAGS, `unexpected <${el.tagName}>`).toContain(el.tagName)
    for (const a of Array.from(el.attributes)) {
      expect(ATTRS, `unexpected ${a.name} on <${el.tagName}>`).toContain(a.name)
      expect(a.name.toLowerCase().startsWith('on')).toBe(false)
    }
    for (const attr of ['fill', 'stroke', 'clip-path']) {
      const v = el.getAttribute(attr)
      if (v && v.startsWith('url(')) expect(v).toMatch(/^url\(#(grad|clip)-[A-Za-z0-9_-]+\)$/)
    }
    const href = el.getAttribute('href')
    if (href !== null) expect(href.startsWith('data:image/')).toBe(true)
    for (const numeric of ['x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'fx', 'fy', 'stroke-width']) {
      const v = el.getAttribute(numeric)
      if (v !== null && el.tagName !== 'tspan') expect(v, `${numeric} on <${el.tagName}>`).toMatch(/^-?[0-9.e+-]+%?$/)
    }
  }
  expect(svg).not.toContain('tracker.example')
  expect(svg).not.toContain('javascript:')
  expect(svg).not.toContain('<script')
  expect(svg).not.toContain('onerror=')
}

describe('v2 export: a hostile document cannot add markup', () => {
  it('after normalising', () => {
    const doc = normalizeDrawDoc(hostileV2())
    const svg = drawDocToSvg(doc)
    assertOwnMarkup(svg)
    // The embedded image that IS image bytes still made it.
    expect(svg).toContain(`href="${PNG}"`)
  })

  it('even when the serializer is handed the raw document', () => {
    const svg = drawDocToSvg(hostileV2() as unknown as DrawDoc)
    assertOwnMarkup(svg)
  })

  it('the HTML wrapper adds nothing either', () => {
    const html = drawDocToHtml(normalizeDrawDoc(hostileV2()))
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror=')
  })

  it('every id that reaches markup is in the safe alphabet', () => {
    const svg = drawDocToSvg(hostileV2() as unknown as DrawDoc)
    for (const m of svg.matchAll(/ id="([^"]*)"/g)) expect(m[1]).toMatch(/^(grad|clip)-[A-Za-z0-9_-]+$/)
  })
})

describe('v2 normalising: hostile values do not survive into the model', () => {
  const doc = normalizeDrawDoc(hostileV2())

  it('ids, colours and numbers are replaced or dropped', () => {
    const text = JSON.stringify(doc)
    for (const l of doc.layers) expect(l.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(doc.artboards[0].id).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(doc.artboards[0].x).toBe(0)
    expect(doc.artboards[0].background).toEqual({ type: 'solid', color: '#ffffff' })
    // Swatches that are not colours are gone; the good one is kept under a fresh id.
    expect(doc.swatches.map((s) => s.color)).toEqual(['#00ff00'])
    expect(doc.guides).toEqual([])
    expect(doc.settings).toEqual({})
    // Assets that are not embedded image bytes are gone.
    expect(Object.keys(doc.assets)).toEqual(['asset-ok'])
    expect(text).not.toContain('tracker.example')
    expect(text).not.toContain('javascript:')
  })

  it('the unknown effect is kept verbatim only as data (and the doc is read-only), never rendered', () => {
    expect(JSON.stringify(doc)).toContain('"filter":"<filter onload=')
    expect(drawDocToSvg(doc)).not.toContain('filter')
  })
})
