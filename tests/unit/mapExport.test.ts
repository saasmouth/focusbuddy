import { describe, it, expect } from 'vitest'
import { mapToSvg } from '../../src/shared/mapExport'
import type { MapBody } from '../../src/shared/types'
// 4.3.32 lexicon standard: user-facing text says “work widget”. The string pins in
// this file that read “widget” were rewritten to the new wording (owner ruling).

function body(partial: Partial<MapBody>): MapBody {
  return { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, ...partial }
}

describe('mapToSvg', () => {
  it('renders an empty map as an honest small canvas, not a crash', () => {
    const { svg, width, height } = mapToSvg(body({}))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('</svg>')
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
  })

  it('sizes the canvas to the node bounds plus padding', () => {
    const { width, height } = mapToSvg(
      body({ nodes: [{ id: 'a', x: 100, y: 100, label: 'A', shape: 'process', color: '#2563eb' }] }),
      { padding: 40 }
    )
    // process default is 130x48; bounds 130x48 + 2*40 padding.
    expect(width).toBe(130 + 80)
    expect(height).toBe(48 + 80)
  })

  it('draws each shape with its distinctive primitive', () => {
    const shapes: Array<{ s: MapBody['nodes'][number]['shape']; needle: string }> = [
      { s: 'process', needle: '<rect' },
      { s: 'decision', needle: '<polygon' },
      { s: 'terminator', needle: 'rx="24"' }, // stadium: rx = h/2 = 24
      { s: 'data', needle: '<polygon' },
      { s: 'database', needle: '<ellipse' },
      { s: 'circle', needle: '<ellipse' },
      { s: 'widget', needle: 'live work widget' }
    ]
    for (const { s, needle } of shapes) {
      const { svg } = mapToSvg(body({ nodes: [{ id: 'n', x: 0, y: 0, label: 'X', shape: s, color: '#111827' }] }))
      expect(svg, `${s} should contain ${needle}`).toContain(needle)
    }
  })

  it('renders an edge as an arrowed line and includes its label', () => {
    const { svg } = mapToSvg(
      body({
        nodes: [
          { id: 'a', x: 0, y: 0, label: 'A', shape: 'process', color: '#2563eb' },
          { id: 'b', x: 300, y: 200, label: 'B', shape: 'process', color: '#2563eb' }
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', label: 'yes', style: 'solid' }]
      })
    )
    expect(svg).toContain('<line')
    expect(svg).toContain('marker-end="url(#arrow)"')
    expect(svg).toContain('>yes<')
    expect(svg).toContain('id="arrow"')
  })

  it('marks a dashed edge with a stroke-dasharray', () => {
    const { svg } = mapToSvg(
      body({
        nodes: [
          { id: 'a', x: 0, y: 0, label: 'A', shape: 'process', color: '#2563eb' },
          { id: 'b', x: 200, y: 0, label: 'B', shape: 'process', color: '#2563eb' }
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', style: 'dashed' }]
      })
    )
    expect(svg).toContain('stroke-dasharray="6 4"')
  })

  it('escapes XML-special characters in labels', () => {
    const { svg } = mapToSvg(body({ nodes: [{ id: 'a', x: 0, y: 0, label: 'A & <B>', shape: 'process', color: '#2563eb' }] }))
    expect(svg).toContain('A &amp; &lt;B&gt;')
    expect(svg).not.toContain('A & <B>')
  })

  it('honours a node\'s explicit width/height', () => {
    const { width } = mapToSvg(
      body({ nodes: [{ id: 'a', x: 0, y: 0, label: 'A', shape: 'process', color: '#111', width: 400, height: 200 }] }),
      { padding: 10 }
    )
    expect(width).toBe(400 + 20)
  })
})

describe('mapToSvg — lanes (swimlane containers)', () => {
  it('renders a lane as a banded container and paints it behind other shapes', () => {
    const { svg } = mapToSvg(
      body({
        nodes: [
          { id: 'p', x: 100, y: 40, label: 'Step', shape: 'process', color: '#2563eb' },
          { id: 'lane', x: 0, y: 0, width: 600, height: 200, label: 'Requester', shape: 'lane', color: '#2563eb' }
        ]
      })
    )
    // The lane's rotated header label is present.
    expect(svg).toContain('Requester')
    expect(svg).toContain('rotate(-90')
    // Painted first (behind): the lane's band rect appears before the process rect's label.
    expect(svg.indexOf('Requester')).toBeLessThan(svg.indexOf('>Step<'))
  })
})

import { polygonClipPath } from '../../src/shared/mapExport'

describe('polygon stencil shapes', () => {
  it('polygonClipPath returns a CSS polygon for stencil shapes, null otherwise', () => {
    for (const shape of ['hexagon', 'trapezoid', 'chevron', 'triangle', 'pentagon', 'star', 'cross', 'arrow', 'callout'] as const) {
      expect(polygonClipPath(shape), `${shape} clip-path`).toContain('polygon(')
    }
    expect(polygonClipPath('process')).toBeNull()
    expect(polygonClipPath('circle')).toBeNull()
  })

  it('mapToSvg renders every polygon stencil shape as a polygon with its label', () => {
    for (const shape of ['hexagon', 'trapezoid', 'chevron', 'triangle', 'pentagon', 'star', 'cross', 'arrow', 'callout'] as const) {
      const { svg } = mapToSvg(body({ nodes: [{ id: 'n', x: 0, y: 0, label: 'Step', shape, color: '#2563eb' }] }))
      expect(svg, `${shape} should render a polygon`).toContain('<polygon')
      expect(svg).toContain('>Step<')
    }
  })

  it('the editor clip-path and the SVG export draw the same star outline', () => {
    // Both consume the same POLYGON_POINTS entry, so the star has its 10 vertices
    // in each. The CSS clip-path lists them as percentages.
    const clip = polygonClipPath('star')!
    expect(clip.split(',').length).toBe(10)
    const { svg } = mapToSvg(body({ nodes: [{ id: 'n', x: 0, y: 0, label: '', shape: 'star', color: '#111' }] }))
    const points = svg.match(/points="([^"]+)"/)![1].trim().split(/\s+/)
    expect(points.length).toBe(10)
  })
})
