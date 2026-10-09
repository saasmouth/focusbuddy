// A drawing from somewhere else must not be able to add markup.
//
// PlexiDraw renders a document's objects as SVG, on screen and in the exported
// file -- and a document can arrive from a public share link or a co-editing
// peer, written by someone else. Two places built that SVG by string
// interpolation: the editor's gradient <defs> (dangerouslySetInnerHTML) and the
// exporter (drawToSvg/drawToHtml, which the desktop loads into a window to
// capture PNG and PDF). An object id or a colour like `x"/><img onerror=…>`
// went into both unescaped.
//
// What is asserted here is the outcome, not the mechanism: whatever the
// document says, the rendered and exported markup contains only the elements
// and attributes PlexiDraw itself writes, and none of the hostile text gets in
// as structure.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
// The menu bar reaches into the documents and view stores; it is not what is
// under test and nothing in it renders document content.
vi.mock('../../src/renderer/src/components/documents/editor/DrawStudioMenuBar', () => ({
  default: () => <div data-testid="menubar-stub" />
}))
// No network from a unit test: the studio asks Google Fonts for each family a
// document names, and this document names a hostile one on purpose.
vi.mock('../../src/renderer/src/lib/googleFonts', () => ({
  loadGoogleFont: vi.fn(),
  familyLabel: (v: string | undefined) => v ?? 'Default'
}))
// happy-dom has no 2D canvas. Raster pixels are not what is under test (the
// raster layer's src is asserted at the model boundary below).
vi.mock('../../src/renderer/src/components/documents/draw/raster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/documents/draw/raster')>()),
  loadIntoCanvas: vi.fn(async () => {})
}))

import DrawStudio from '../../src/renderer/src/components/documents/DrawStudio'
import {
  DRAW_ID_PATTERN,
  drawToHtml,
  drawToSvg,
  gradientId,
  normalizeDrawBody,
  objectGradients,
  paintToCss,
  svgPaint,
  type DrawBody,
  type DrawObject
} from '../../src/shared/draw'

const PWN = 'window.__drawPwned=1'
const HOSTILE_ID = `x"/><foreignObject><img src="x" onerror="${PWN}"></foreignObject><linearGradient id="y`
const HOSTILE_COLOR = `red"/><img src="x" onerror="${PWN}"><path fill="`
const HOSTILE_CSS_COLOR = 'red;background:url(https://tracker.example/p.gif)'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const triangle = { subpaths: [{ closed: true, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] }

/** A document as an attacker would write it: every string slot carries markup. */
function hostileDoc(): Record<string, unknown> {
  return {
    width: 200,
    height: 200,
    background: { type: 'solid', color: HOSTILE_COLOR },
    activeLayerId: HOSTILE_ID,
    layers: [
      {
        id: `L1"><script>${PWN}</script>`,
        kind: 'vector',
        objects: [
          {
            id: HOSTILE_ID,
            type: 'path',
            path: triangle,
            fill: {
              type: 'linear',
              stops: [
                { offset: 0, color: HOSTILE_COLOR },
                { offset: 1, color: `#fff" onload="${PWN}` }
              ]
            },
            stroke: { width: 2, paint: { type: 'radial', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: HOSTILE_CSS_COLOR }] } }
          },
          { id: `${HOSTILE_ID}2`, type: 'path', path: triangle, fill: { type: 'solid', color: HOSTILE_COLOR } },
          {
            id: 'txt"onmouseover="x',
            type: 'text',
            x: 0,
            y: 0,
            w: 100,
            text: `<img src=x onerror="${PWN}">`,
            fontSize: 12,
            fontFamily: `Inter"/><script>${PWN}</script>`,
            fill: { type: 'solid', color: HOSTILE_CSS_COLOR }
          },
          { id: 'img-remote', type: 'image', x: 0, y: 0, w: 5, h: 5, src: 'https://tracker.example/pixel.gif' },
          { id: 'img-js', type: 'image', x: 0, y: 0, w: 5, h: 5, src: `javascript:${PWN}` },
          { id: 'img-ok', type: 'image', x: 0, y: 0, w: 5, h: 5, src: PNG }
        ]
      },
      { id: 'R1', kind: 'raster', src: 'https://tracker.example/layer.png' }
    ]
  }
}

// Everything PlexiDraw itself writes. Anything outside these sets got there
// from the document.
const SVG_TAGS = new Set(['svg', 'defs', 'g', 'linearGradient', 'radialGradient', 'stop', 'path', 'text', 'tspan', 'image', 'rect'])
const SVG_ATTRS = new Set([
  'xmlns', 'xmlns:xlink', 'width', 'height', 'viewBox', 'data-testid', 'class', 'style',
  'id', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'offset', 'stop-color', 'stop-opacity',
  'd', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-miterlimit',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'transform',
  'x', 'y', 'href', 'preserveAspectRatio'
])

function assertOnlyOwnMarkup(root: Element): void {
  const all = [root, ...Array.from(root.querySelectorAll('*'))]
  for (const el of all) {
    expect(SVG_TAGS, `unexpected element <${el.tagName}>`).toContain(el.tagName)
    for (const a of Array.from(el.attributes)) {
      expect(SVG_ATTRS, `unexpected attribute ${a.name} on <${el.tagName}>`).toContain(a.name)
      expect(a.name.toLowerCase().startsWith('on')).toBe(false)
    }
    // Every gradient reference resolves to a sanitized id.
    for (const attr of ['fill', 'stroke']) {
      const v = el.getAttribute(attr)
      if (v && v.startsWith('url(')) expect(v).toMatch(/^url\(#grad-[A-Za-z0-9_-]+\)$/)
    }
    const href = el.getAttribute('href')
    if (href !== null) expect(href.startsWith('data:image/')).toBe(true)
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  ;(window as unknown as { __drawPwned?: number }).__drawPwned = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  expect((window as unknown as { __drawPwned?: number }).__drawPwned).toBe(0)
})

describe('PlexiDraw on screen: a hostile document cannot add elements or attributes', () => {
  it('renders only its own SVG vocabulary, with gradients present and referenced', async () => {
    await act(async () => {
      root.render(<DrawStudio content={hostileDoc()} title="t" onChange={() => {}} />)
    })
    const layers = Array.from(host.querySelectorAll('svg[data-testid^="draw-vector-"]'))
    expect(layers).toHaveLength(1)
    const layer = layers[0]
    assertOnlyOwnMarkup(layer)

    // The hostile layer id was replaced before it reached a data-testid.
    expect(layer.getAttribute('data-testid')).toMatch(/^draw-vector-lyr-[A-Za-z0-9-]+$/)
    // No markup smuggled through any string field.
    expect(host.querySelector('foreignObject, script, img, iframe')).toBeNull()
    for (const el of Array.from(host.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) expect(a.name.toLowerCase().startsWith('on'), `${a.name} on <${el.tagName}>`).toBe(false)
    }
    // Neither the remote image, the remote raster layer nor the url() smuggled
    // in a "colour" reached anything that would make the viewer fetch it.
    expect(host.innerHTML).not.toContain('tracker.example')

    // The gradient defs are real elements now (they used to be written into an
    // innerHTML string that was always empty), and every reference resolves.
    const gradIds = new Set(Array.from(layer.querySelectorAll('linearGradient, radialGradient')).map((g) => g.id))
    expect(gradIds.size).toBe(2)
    for (const el of Array.from(layer.querySelectorAll('[fill^="url("], [stroke^="url("]'))) {
      const ref = (el.getAttribute('fill') ?? '').startsWith('url(') ? el.getAttribute('fill')! : el.getAttribute('stroke')!
      expect(gradIds.has(ref.slice(5, -1))).toBe(true)
    }

    // The hostile text is text: escaped by React, present as characters, inert.
    const tspan = layer.querySelector('tspan')
    expect(tspan?.textContent).toContain('<img src=x onerror=')
    expect(tspan?.children).toHaveLength(0)

    // Only the embedded image survived; the remote and javascript: ones are gone.
    const images = Array.from(layer.querySelectorAll('image'))
    expect(images.map((i) => i.getAttribute('href'))).toEqual([PNG])
  })
})

describe('normalizeDrawBody — the model boundary', () => {
  it('replaces every id that drawId could not have produced', () => {
    const b = normalizeDrawBody(hostileDoc())
    for (const l of b.layers) {
      expect(l.id).toMatch(DRAW_ID_PATTERN)
      if (l.kind === 'vector') for (const o of l.objects) expect(o.id).toMatch(DRAW_ID_PATTERN)
    }
    // activeLayerId pointed at a hostile id that no longer exists, so it falls
    // back to a real layer rather than carrying the string forward.
    expect(b.layers.map((l) => l.id)).toContain(b.activeLayerId)
  })

  it('keeps ids the app mints, untouched', () => {
    const b = normalizeDrawBody({
      layers: [{ id: 'lyr-mv0abc-1', kind: 'vector', objects: [{ id: 'obj-mv0abc-2', type: 'path', path: triangle, fill: { type: 'none' } }] }]
    })
    expect(b.layers[0].id).toBe('lyr-mv0abc-1')
    expect((b.layers[0] as { objects: DrawObject[] }).objects[0].id).toBe('obj-mv0abc-2')
  })

  it('drops colours that are not colours and keeps the ones the editors produce', () => {
    const b = normalizeDrawBody(hostileDoc())
    expect(b.background).toEqual({ type: 'solid', color: '#ffffff' })
    const objs = (b.layers[0] as { objects: DrawObject[] }).objects
    const grad = objs[0].type === 'path' ? objs[0].fill : null
    expect(grad && grad.type === 'linear' ? grad.stops.map((s) => s.color) : null).toEqual(['#000000', '#000000'])
    // A solid fill with a hostile colour falls back to the object's default.
    expect(objs[1].type === 'path' ? objs[1].fill : null).toEqual({ type: 'none' })

    const ok = normalizeDrawBody({
      background: { type: 'solid', color: 'rgba(109, 93, 252, 0.12)' },
      layers: [
        {
          kind: 'vector',
          objects: [
            { type: 'path', path: triangle, fill: { type: 'solid', color: '#6D5DFC' } },
            { type: 'path', path: triangle, fill: { type: 'solid', color: 'transparent' } },
            { type: 'path', path: triangle, fill: { type: 'solid', color: 'hsl(250 96% 68% / 50%)' } }
          ]
        }
      ]
    })
    expect(ok.background).toEqual({ type: 'solid', color: 'rgba(109, 93, 252, 0.12)' })
    const fills = (ok.layers[0] as { objects: DrawObject[] }).objects.map((o) => (o.type === 'path' ? o.fill : null))
    expect(fills).toEqual([
      { type: 'solid', color: '#6D5DFC' },
      { type: 'solid', color: 'transparent' },
      { type: 'solid', color: 'hsl(250 96% 68% / 50%)' }
    ])
  })

  it('keeps only embedded image bytes, for image objects and raster layers', () => {
    const b = normalizeDrawBody(hostileDoc())
    const images = (b.layers[0] as { objects: DrawObject[] }).objects.filter((o) => o.type === 'image')
    expect(images.map((i) => (i.type === 'image' ? i.src : ''))).toEqual([PNG])
    const raster = b.layers[1]
    expect(raster.kind === 'raster' ? raster.src : null).toBe('')
    const kept = normalizeDrawBody({ layers: [{ kind: 'raster', src: PNG }] }).layers[0]
    expect(kept.kind === 'raster' ? kept.src : null).toBe(PNG)
  })

  it('accepts only the shape kinds the editor knows', () => {
    const b = normalizeDrawBody({
      layers: [{ kind: 'vector', objects: [{ type: 'path', path: triangle, shapeKind: 'star"><x', fill: { type: 'none' } }, { type: 'path', path: triangle, shapeKind: 'star', fill: { type: 'none' } }] }]
    })
    const objs = (b.layers[0] as { objects: DrawObject[] }).objects
    expect(objs.map((o) => (o.type === 'path' ? o.shapeKind : null))).toEqual([undefined, 'star'])
  })
})

describe('the serializers escape at render, even for a body that skipped normalisation', () => {
  // Built by hand, NOT normalised: what a caller holding a raw body would pass.
  function rawBody(): DrawBody {
    return {
      schemaVersion: 1,
      width: 100,
      height: 100,
      background: { type: 'solid', color: HOSTILE_COLOR },
      layers: [
        {
          id: 'L',
          kind: 'vector',
          name: 'L',
          visible: true,
          locked: false,
          opacity: 0.5,
          blend: 'multiply;x:y' as never,
          objects: [
            {
              id: HOSTILE_ID,
              type: 'path',
              path: triangle,
              fill: { type: 'linear', stops: [{ offset: 0, color: HOSTILE_COLOR }, { offset: 1, color: '#fff', opacity: '1"/><x' as never }] },
              stroke: { width: 1, paint: { type: 'solid', color: HOSTILE_COLOR }, cap: 'round" onload="x' as never },
              blend: 'screen" onload="x' as never,
              opacity: 0.4
            },
            {
              id: HOSTILE_ID,
              type: 'text',
              x: 0,
              y: 0,
              w: 50,
              text: '</text><script>x</script>',
              fontSize: 10,
              fontFamily: `"/><script>${PWN}</script>`,
              fill: { type: 'solid', color: '#000' }
            },
            { id: 'i', type: 'image', x: 0, y: 0, w: 1, h: 1, src: `javascript:${PWN}` }
          ]
        },
        { id: 'R', kind: 'raster', name: 'R', visible: true, locked: false, opacity: 1, blend: 'normal', src: `"/><script>${PWN}</script>` }
      ]
    }
  }

  it('drawToSvg parses back to PlexiDraw elements and attributes only', () => {
    const svg = drawToSvg(rawBody())
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    assertOnlyOwnMarkup(doc.documentElement)
    expect(doc.querySelector('script, foreignObject, img')).toBeNull()
    // The hostile strings are still there -- as attribute VALUES and text,
    // which is the point: escaped, not dropped silently into structure.
    expect(doc.querySelector('tspan')?.textContent).toContain('<script>')
  })

  it('drawToHtml — the page the desktop loads to capture PNG/PDF — carries no script', () => {
    const html = drawToHtml(rawBody())
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelectorAll('script')).toHaveLength(0)
    expect(doc.querySelectorAll('img, foreignObject, iframe')).toHaveLength(0)
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) expect(a.name.toLowerCase().startsWith('on')).toBe(false)
    }
  })

  it('a gradient id is always a plain token, whatever id it was built from', () => {
    expect(gradientId(HOSTILE_ID)).toMatch(/^grad-[A-Za-z0-9_-]+$/)
    const p = svgPaint({ type: 'radial', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }, HOSTILE_ID)
    expect(p.value).toMatch(/^url\(#grad-[A-Za-z0-9_-]+\)$/)
    expect(p.gradient?.id).toBe(p.value.slice(5, -1))
    const raw = rawBody().layers[0]
    const gs = raw.kind === 'vector' ? raw.objects.flatMap(objectGradients) : []
    for (const g of gs) {
      expect(g.id).toMatch(/^grad-[A-Za-z0-9_-]+$/)
      for (const s of g.stops) expect(s.color).not.toContain('"')
    }
  })

  it('paintToCss never emits a hostile colour into a style value', () => {
    expect(paintToCss({ type: 'solid', color: HOSTILE_CSS_COLOR })).toBe('transparent')
    expect(paintToCss({ type: 'linear', stops: [{ offset: 0, color: HOSTILE_CSS_COLOR }, { offset: 1, color: '#fff' }] })).not.toContain('url(')
  })
})
