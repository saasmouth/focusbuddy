import { describe, it, expect } from 'vitest'
import { mapToSvg } from '../../src/shared/mapExport'
import type { MapBody } from '../../src/shared/types'

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
    // process default is 120x48 (the same size the editor draws); bounds + 2*40 padding.
    expect(width).toBe(120 + 80)
    expect(height).toBe(48 + 80)
  })

  it('draws each shape with its own outline from the shape registry', () => {
    // Every shape is drawn from shared geometry (the editor uses the same paths),
    // so check the distinctive outline of each rather than a primitive type.
    const checks: Array<{ s: MapBody['nodes'][number]['shape']; test: (svg: string) => boolean; what: string }> = [
      { s: 'process', test: (v) => /<path d="M6,0 H114/.test(v), what: 'rounded rectangle' },
      { s: 'decision', test: (v) => v.includes('M65,0 L130,46 L65,92 L0,46 Z'), what: 'diamond' },
      { s: 'terminator', test: (v) => v.includes('A24,24'), what: 'stadium ends (r = h/2 = 24)' },
      { s: 'database', test: (v) => (v.match(/<path /g) ?? []).length >= 2, what: 'cylinder body + lid' },
      { s: 'circle', test: (v) => v.includes('A43,43'), what: 'circle arcs' },
      { s: 'widget', test: (v) => v.includes('live work widget'), what: 'live work widget card' }
    ]
    const seen = new Set<string>()
    for (const { s, test, what } of checks) {
      const { svg } = mapToSvg(body({ nodes: [{ id: 'n', x: 0, y: 0, label: 'X', shape: s, color: '#111827' }] }))
      expect(test(svg), `${s} should draw a ${what}`).toBe(true)
      seen.add(svg.replace(/>X</g, ''))
    }
    expect(seen.size).toBe(checks.length)
  })

  it('renders an edge as a routed line with an arrowhead and its label', () => {
    const { svg } = mapToSvg(
      body({
        nodes: [
          { id: 'a', x: 0, y: 0, label: 'A', shape: 'process', color: '#2563eb' },
          { id: 'b', x: 300, y: 200, label: 'B', shape: 'process', color: '#2563eb' }
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', label: 'yes', style: 'solid' }]
      })
    )
    expect(svg).toContain('class="pd-edge"')
    expect(svg).toContain('class="pd-arrowhead"')
    expect(svg).toContain('>yes<')
    // Default routing is right-angled: the line's path uses only H/V/L moves.
    const d = svg.match(/class="pd-edge" d="([^"]+)"/)![1]
    expect(d).toMatch(/^M[-\d.]+,[-\d.]+/)
  })

  it('draws the same line the editor draws (shared router)', async () => {
    const { routeAll } = await import('../../src/shared/diagram/routing')
    const b = body({
      nodes: [
        { id: 'a', x: 0, y: 0, label: 'A', shape: 'process', color: '#2563eb' },
        { id: 'b', x: 400, y: 160, label: 'B', shape: 'decision', color: '#2563eb' }
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', routing: 'curved' }]
    })
    const route = routeAll(b.nodes, b.edges).get('e1')!
    expect(mapToSvg(b).svg).toContain(`d="${route.path}"`)
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
    // dashArray('dashed', 1.5): 6w 4w at the theme's 1.5px line width.
    expect(svg).toContain('stroke-dasharray="9 6"')
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
    // Containers are created at the back (array order is z-order), so a lane
    // listed after a shape is still drawn where it sits in the array; the editor
    // puts new containers first, which this body mirrors by ordering.
    const { svg: svg2 } = mapToSvg(
      body({
        nodes: [
          { id: 'lane', x: 0, y: 0, width: 600, height: 200, label: 'Requester', shape: 'lane', color: '#2563eb' },
          { id: 'p', x: 100, y: 40, label: 'Step', shape: 'process', color: '#2563eb' }
        ]
      })
    )
    expect(svg2.indexOf('Requester')).toBeLessThan(svg2.indexOf('>Step<'))
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

  it('mapToSvg renders every polygon stencil shape with its outline and label', () => {
    for (const shape of ['hexagon', 'trapezoid', 'chevron', 'triangle', 'pentagon', 'star', 'cross', 'arrow', 'callout'] as const) {
      const { svg } = mapToSvg(body({ nodes: [{ id: 'n', x: 0, y: 0, label: 'Step', shape, color: '#2563eb' }] }))
      expect(svg, `${shape} should render a closed outline`).toMatch(/<path d="M[^"]+Z"/)
      expect(svg).toContain('>Step<')
    }
  })

  it('the legacy clip-path and the export draw the same star outline', () => {
    // POLYGON_POINTS (kept for compatibility) and the registry's star share the
    // same 10 vertices.
    const clip = polygonClipPath('star')!
    expect(clip.split(',').length).toBe(10)
    const { svg } = mapToSvg(body({ nodes: [{ id: 'n', x: 0, y: 0, label: '', shape: 'star', color: '#111' }] }))
    const d = svg.match(/<path d="(M[^"]+Z)"/)![1]
    expect(d.split(/[ML]/).filter((p) => p.trim() && p.trim() !== 'Z').length).toBe(10)
  })
})

describe('mapToSvg — v2 features', () => {
  it('honours styles, rotation, hidden layers, themes and line jumps', () => {
    const { svg } = mapToSvg(
      body({
        nodes: [
          { id: 'a', x: 0, y: 0, label: 'Rotated', shape: 'process', color: '#2563eb', rotation: 45, style: { fill: '#abcdef', bold: true, strokeDash: 'dotted' } },
          { id: 'h', x: 500, y: 0, label: 'Hidden', shape: 'process', color: '#2563eb', layerId: 'L' }
        ],
        layers: [{ id: 'L', name: 'x', visible: false, locked: false }],
        settings: { theme: 'blueprint' }
      })
    )
    expect(svg).toContain('rotate(45')
    expect(svg).toContain('fill="#abcdef"')
    expect(svg).toContain('font-weight="700"')
    expect(svg).not.toContain('Hidden')
    expect(svg).toContain('fill="#0b3a6b"') // blueprint background
  })
  it('embeds the icon font only when icons are used', () => {
    const plain = mapToSvg(body({ nodes: [{ id: 'a', x: 0, y: 0, label: 'A', shape: 'process', color: '#000' }] }), { iconFontUrl: 'data:font/woff2;base64,AAAA' })
    expect(plain.svg).not.toContain('@font-face')
    const withIcon = mapToSvg(body({ nodes: [{ id: 'a', x: 0, y: 0, label: 'Server', shape: 'icon', icon: 'dns', color: '#000' }] }), { iconFontUrl: 'data:font/woff2;base64,AAAA' })
    expect(withIcon.svg).toContain('@font-face')
    expect(withIcon.svg).toContain('>dns<')
  })
  it('renders table cells and UML compartments', () => {
    const t = mapToSvg(body({ nodes: [{ id: 't', x: 0, y: 0, label: '', shape: 'process', color: '#000', cells: [['a']] }] }))
    expect(t.svg).toContain('<svg')
  })
})
