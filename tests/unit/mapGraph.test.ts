import { describe, it, expect } from 'vitest'
import { starterMapBody, normalizeMapBody, autoLayout } from '../../src/shared/mapGraph'
import { SHAPES } from '../../src/shared/diagram/shapes'
import { mapTemplate } from '../../src/renderer/src/components/documents/map/mapTemplates'
import type { MapBody } from '../../src/shared/types'

describe('mapGraph — body factories', () => {
  it('starterMapBody seeds a single Start node', () => {
    const b = starterMapBody()
    expect(b.nodes).toHaveLength(1)
    expect(b.nodes[0].shape).toBe('terminator')
    expect(b.edges).toEqual([])
  })
})

describe('mapGraph — normalizeMapBody', () => {
  it('keeps good nodes and edges', () => {
    const raw: MapBody = {
      version: 1,
      nodes: [
        { id: 'a', x: 1, y: 2, label: 'A', shape: 'process', color: '#111' },
        { id: 'b', x: 3, y: 4, label: 'B', shape: 'decision', color: '#222' }
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', label: 'go' }]
    }
    const out = normalizeMapBody(raw)
    expect(out.nodes).toHaveLength(2)
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0].label).toBe('go')
  })

  it('drops edges that reference a missing node', () => {
    const out = normalizeMapBody({
      version: 1,
      nodes: [{ id: 'a', x: 0, y: 0, label: 'A', shape: 'process', color: '#111' }],
      edges: [{ id: 'e1', source: 'a', target: 'ghost' }]
    } as MapBody)
    expect(out.edges).toHaveLength(0)
  })

  it('defaults missing shape/color/coords and dedupes node ids', () => {
    const out = normalizeMapBody({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'dup' },
        { id: 'b', label: 'B', shape: 'not-a-shape' }
      ]
    })
    expect(out.nodes).toHaveLength(2)
    const a = out.nodes.find((n) => n.id === 'a')!
    expect(a.x).toBe(0)
    expect(a.y).toBe(0)
    expect(a.color).toMatch(/^#/)
    expect(SHAPES.map((s) => s.id)).toContain(a.shape)
    const b = out.nodes.find((n) => n.id === 'b')!
    expect(b.shape).toBe('process') // invalid shape falls back to process
  })

  it('tolerates garbage input', () => {
    expect(normalizeMapBody(null).nodes).toEqual([])
    expect(normalizeMapBody(undefined).edges).toEqual([])
    expect(normalizeMapBody('nope').nodes).toEqual([])
  })
})

describe('mapGraph — autoLayout', () => {
  it('places a chain in increasing layers (top-down)', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0, label: 'A', shape: 'terminator' as const, color: '#1' },
      { id: 'b', x: 0, y: 0, label: 'B', shape: 'process' as const, color: '#1' },
      { id: 'c', x: 0, y: 0, label: 'C', shape: 'process' as const, color: '#1' }
    ]
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' }
    ]
    const out = autoLayout(nodes, edges)
    const y = Object.fromEntries(out.map((n) => [n.id, n.y]))
    expect(y.a).toBeLessThan(y.b)
    expect(y.b).toBeLessThan(y.c)
  })

  it('puts sibling branches on the same layer', () => {
    const nodes = [
      { id: 'root', x: 0, y: 0, label: 'R', shape: 'decision' as const, color: '#1' },
      { id: 'l', x: 0, y: 0, label: 'L', shape: 'process' as const, color: '#1' },
      { id: 'r', x: 0, y: 0, label: 'R2', shape: 'process' as const, color: '#1' }
    ]
    const edges = [
      { id: 'e1', source: 'root', target: 'l' },
      { id: 'e2', source: 'root', target: 'r' }
    ]
    const out = autoLayout(nodes, edges)
    const byId = Object.fromEntries(out.map((n) => [n.id, n]))
    expect(byId.l.y).toBe(byId.r.y) // same layer
    expect(byId.l.x).not.toBe(byId.r.x) // spread horizontally
  })

  it('terminates on a cycle', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0, label: 'A', shape: 'process' as const, color: '#1' },
      { id: 'b', x: 0, y: 0, label: 'B', shape: 'process' as const, color: '#1' }
    ]
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' }
    ]
    const out = autoLayout(nodes, edges)
    expect(out).toHaveLength(2)
    expect(out.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
  })
})

describe('mapTemplates', () => {
  for (const id of ['flowchart', 'orgchart', 'mindmap', 'swimlane'] as const) {
    it(`${id} is a valid, self-consistent graph`, () => {
      const tpl = mapTemplate(id)
      const norm = normalizeMapBody(tpl)
      // No edges were dropped — every edge references a real node.
      expect(norm.edges.length).toBe(tpl.edges.length)
      expect(norm.nodes.length).toBe(tpl.nodes.length)
      expect(norm.nodes.length).toBeGreaterThan(0)
    })
  }
})
