import { describe, it, expect } from 'vitest'
import { tidyConnections, edgeCrossings } from '../../src/shared/diagram/tidy'
import { parsePort } from '../../src/shared/diagram/geom'
import type { MapEdge, MapNode } from '../../src/shared/types'

const node = (id: string, x: number, y: number, extra: Partial<MapNode> = {}): MapNode => ({
  id,
  x,
  y,
  label: id,
  shape: 'process',
  color: '#333',
  width: 120,
  height: 60,
  ...extra
})

const edge = (id: string, source: string, target: string, extra: Partial<MapEdge> = {}): MapEdge => ({ id, source, target, ...extra })

const overlap = (a: MapNode, b: MapNode): boolean =>
  a.x < b.x + (b.width ?? 0) && a.x + (a.width ?? 0) > b.x && a.y < b.y + (b.height ?? 0) && a.y + (a.height ?? 0) > b.y

const byId = (nodes: MapNode[], id: string): MapNode => nodes.find((n) => n.id === id)!

describe('tidyConnections — ports', () => {
  it('spreads three edges leaving one side across distinct ports, in non-crossing order', () => {
    const nodes = [node('a', 0, 200), node('b', 400, 0), node('c', 400, 200), node('d', 400, 400)]
    // Deliberately listed out of order.
    const edges = [edge('ad', 'a', 'd'), edge('ab', 'a', 'b'), edge('ac', 'a', 'c')]
    const out = tidyConnections(nodes, edges, { alignNodes: false })
    const h = (id: string): string => out.edges.find((e) => e.id === id)!.sourceHandle!
    const ports = ['ab', 'ac', 'ad'].map(h)
    expect(new Set(ports).size).toBe(3)
    for (const p of ports) expect(parsePort(p)!.fx).toBe(1) // all on the right side
    const fy = ports.map((p) => parsePort(p)!.fy)
    expect(fy[0]).toBeLessThan(fy[1]!)
    expect(fy[1]).toBeLessThan(fy[2]!)
    expect(fy).toEqual([0.25, 0.5, 0.75])
    // Targets enter on their facing (left) side.
    for (const e of out.edges) expect(parsePort(e.targetHandle)!.fx).toBe(0)
    expect(out.changes.portsReassigned).toBe(6)
  })

  it('picks facing sides from relative position', () => {
    const nodes = [node('a', 0, 0), node('below', 0, 300), node('left', -400, 0)]
    const out = tidyConnections(nodes, [edge('e1', 'a', 'below'), edge('e2', 'a', 'left')], { alignNodes: false })
    const e1 = out.edges.find((e) => e.id === 'e1')!
    const e2 = out.edges.find((e) => e.id === 'e2')!
    expect([e1.sourceHandle, e1.targetHandle]).toEqual(['bottom', 'top'])
    expect([e2.sourceHandle, e2.targetHandle]).toEqual(['left', 'right'])
  })

  it('clears stale waypoints, defaults routing, and leaves locked edges alone', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 0)]
    const edges = [
      edge('e1', 'a', 'b', { waypoints: [{ x: 50, y: 400 }], sourceHandle: 'top', targetHandle: 'bottom' }),
      edge('e2', 'a', 'b', { locked: true, waypoints: [{ x: 50, y: 400 }], sourceHandle: 'top' }),
      edge('e3', 'a', 'b', { routing: 'curved', waypoints: [{ x: 1, y: 1 }] })
    ]
    const out = tidyConnections(nodes, edges)
    const [e1, e2, e3] = out.edges as [MapEdge, MapEdge, MapEdge]
    expect(e1.waypoints).toBeUndefined()
    expect(e1.routing).toBe('orthogonal')
    expect(e2).toEqual(edges[1])
    expect(e3.routing).toBe('curved') // only unset routing changes
    expect(e3.waypoints).toBeUndefined()
    const kept = tidyConnections(nodes, edges, { clearWaypoints: false })
    expect(kept.edges[0]!.waypoints).toEqual([{ x: 50, y: 400 }])
  })

  it('spreadPorts:false keeps side midpoints', () => {
    const nodes = [node('a', 0, 200), node('b', 400, 0), node('c', 400, 400)]
    const out = tidyConnections(nodes, [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')], { spreadPorts: false, alignNodes: false })
    expect(out.edges.map((e) => e.sourceHandle)).toEqual(['right', 'right'])
  })
})

describe('tidyConnections — nodes', () => {
  it('straightens nearly aligned connectors', () => {
    const nodes = [node('a', 0, 0), node('b', 7, 240)]
    const out = tidyConnections(nodes, [edge('e', 'a', 'b')])
    const a = byId(out.nodes, 'a')
    const b = byId(out.nodes, 'b')
    expect(a.x + 60).toBe(b.x + 60) // centres share an x: a perfectly vertical line
    expect(out.changes.nodesNudged).toBe(1)
    expect(out.edges[0]!.sourceHandle).toBe('bottom')
    expect(out.edges[0]!.targetHandle).toBe('top')
    // Horizontal case.
    const h = tidyConnections([node('a', 0, 0), node('b', 300, -9)], [edge('e', 'a', 'b')])
    expect(byId(h.nodes, 'a').y).toBe(byId(h.nodes, 'b').y)
  })

  it('moves the node with fewer connections', () => {
    const nodes = [node('hub', 0, 0), node('leaf', 10, 240), node('x', 400, 0), node('y', 400, 300)]
    const edges = [edge('e1', 'hub', 'leaf'), edge('e2', 'hub', 'x'), edge('e3', 'hub', 'y')]
    const out = tidyConnections(nodes, edges)
    expect(byId(out.nodes, 'hub').x).toBe(0)
    expect(byId(out.nodes, 'leaf').x).toBe(0)
  })

  it('never moves locked nodes', () => {
    const lockedTarget = tidyConnections([node('a', 0, 0), node('b', 7, 240, { locked: true })], [edge('e', 'a', 'b')])
    expect(byId(lockedTarget.nodes, 'b').x).toBe(7)
    expect(byId(lockedTarget.nodes, 'a').x).toBe(7) // the free one moved instead
    const bothLocked = tidyConnections(
      [node('a', 0, 0, { locked: true }), node('b', 7, 240, { locked: true })],
      [edge('e', 'a', 'b')]
    )
    expect(byId(bothLocked.nodes, 'a').x).toBe(0)
    expect(byId(bothLocked.nodes, 'b').x).toBe(7)
    expect(bothLocked.changes.nodesNudged).toBe(0)
  })

  it('leaves clearly offset nodes alone', () => {
    const out = tidyConnections([node('a', 0, 0), node('b', 40, 240)], [edge('e', 'a', 'b')])
    expect(byId(out.nodes, 'b').x).toBe(40)
    expect(out.changes.nodesNudged).toBe(0)
  })

  it('resolves an overlap minimally and reports it', () => {
    const nodes = [node('a', 0, 0), node('b', 100, 10)]
    const out = tidyConnections(nodes, [])
    expect(overlap(byId(out.nodes, 'a'), byId(out.nodes, 'b'))).toBe(false)
    expect(out.changes.overlapsResolved).toBe(1)
    expect(out.changes.nodesNudged).toBe(1)
    // Smallest move: b goes right (needs 36px), not down (66px) or left/up.
    const b = byId(out.nodes, 'b')
    expect(b.y).toBe(10)
    expect(b.x).toBe(136)
  })

  it('respects locks and the grid when resolving overlaps', () => {
    const nodes = [node('a', 0, 0), node('b', 100, 10, { locked: true })]
    const out = tidyConnections(nodes, [], { gridSize: 20 })
    expect(byId(out.nodes, 'b')).toEqual(nodes[1])
    const a = byId(out.nodes, 'a')
    expect(overlap(a, byId(out.nodes, 'b'))).toBe(false)
    expect(Number.isInteger(a.x / 20)).toBe(true)
    expect(Number.isInteger(a.y / 20)).toBe(true)
    // Two locked shapes stay overlapped — and the count says so.
    const stuck = tidyConnections([node('a', 0, 0, { locked: true }), node('b', 100, 10, { locked: true })], [])
    expect(stuck.changes.overlapsResolved).toBe(0)
    expect(stuck.changes.nodesNudged).toBe(0)
  })

  it('ignores containers and hidden nodes for overlaps', () => {
    const nodes = [node('lane', -50, -50, { shape: 'lane', width: 600, height: 300 }), node('a', 0, 0), node('ghost', 20, 20, { hidden: true })]
    const out = tidyConnections(nodes, [])
    expect(out.nodes).toEqual(nodes)
    expect(out.changes).toEqual({ edgesRerouted: 0, portsReassigned: 0, nodesNudged: 0, overlapsResolved: 0 })
  })

  it('resolveOverlaps:false leaves overlaps', () => {
    const out = tidyConnections([node('a', 0, 0), node('b', 100, 10)], [], { resolveOverlaps: false })
    expect(byId(out.nodes, 'b').x).toBe(100)
    expect(out.changes.overlapsResolved).toBe(0)
  })
})

describe('tidyConnections — purity and effect', () => {
  const messy = (): { nodes: MapNode[]; edges: MapEdge[] } => ({
    nodes: [node('a', 0, 200), node('b', 400, 0), node('c', 400, 200), node('d', 400, 400), node('e', 90, 230), node('f', 405, 600)],
    edges: [
      edge('ab', 'a', 'b', { sourceHandle: 'bottom', targetHandle: 'left' }),
      edge('ad', 'a', 'd', { sourceHandle: 'top', targetHandle: 'left' }),
      edge('ac', 'a', 'c', { sourceHandle: 'left', targetHandle: 'right', waypoints: [{ x: 250, y: 500 }] }),
      edge('df', 'd', 'f', { sourceHandle: 'right', targetHandle: 'right' })
    ]
  })

  it('never mutates its input', () => {
    const { nodes, edges } = messy()
    const before = JSON.stringify({ nodes, edges })
    const out = tidyConnections(nodes, edges, { gridSize: 16 })
    expect(JSON.stringify({ nodes, edges })).toBe(before)
    expect(out.nodes).not.toBe(nodes)
    expect(out.edges).not.toBe(edges)
    out.nodes.forEach((n, i) => expect(n).not.toBe(nodes[i]))
    out.edges.forEach((e, i) => expect(e).not.toBe(edges[i]))
  })

  it('reduces crossings on a messy graph', () => {
    const { nodes, edges } = messy()
    const before = edgeCrossings(nodes, edges)
    expect(before).toBeGreaterThan(0)
    const out = tidyConnections(nodes, edges)
    const after = edgeCrossings(out.nodes, out.edges)
    expect(after).toBeLessThan(before)
    expect(after).toBe(0)
    expect(out.changes.edgesRerouted).toBe(4)
    expect(out.changes.overlapsResolved).toBe(1) // e overlapped a
    expect(byId(out.nodes, 'f').x).toBe(400) // d→f straightened
  })

  it('is idempotent: a second pass reports no changes', () => {
    const { nodes, edges } = messy()
    const once = tidyConnections(nodes, edges)
    const twice = tidyConnections(once.nodes, once.edges)
    expect(twice.changes).toEqual({ edgesRerouted: 0, portsReassigned: 0, nodesNudged: 0, overlapsResolved: 0 })
    expect(twice.nodes).toEqual(once.nodes)
    expect(twice.edges).toEqual(once.edges)
  })

  it('edgeCrossings counts a simple cross', () => {
    const nodes = [node('top', 200, 0), node('bottom', 200, 400), node('left', 0, 200), node('right', 400, 200)]
    expect(edgeCrossings(nodes, [edge('v', 'top', 'bottom'), edge('h', 'left', 'right')])).toBe(1)
    expect(edgeCrossings(nodes, [edge('v', 'top', 'bottom')])).toBe(0)
  })
})
