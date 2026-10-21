import { describe, it, expect } from 'vitest'
import { layoutDiagram, type LayoutAlgorithm, type LayoutDirection } from '../../src/shared/diagram/layout'
import { nodeSize } from '../../src/shared/diagram/geom'
import { getShape } from '../../src/shared/diagram/shapes'
import type { MapEdge, MapNode } from '../../src/shared/types'

// ── fixtures ────────────────────────────────────────────────────────────────

const SHAPES = ['process', 'decision', 'terminator', 'database', 'circle', 'hexagon', 'data']

function node(id: string, extra: Partial<MapNode> = {}): MapNode {
  return { id, x: 0, y: 0, label: id, shape: 'process', color: '#2563eb', ...extra }
}
function edge(s: string, t: string): MapEdge {
  return { id: `e-${s}-${t}`, source: s, target: t }
}

// Deterministic PRNG for fixtures.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function chain(n: number): { nodes: MapNode[]; edges: MapEdge[] } {
  const nodes = Array.from({ length: n }, (_, i) => node(`c${i}`, { shape: SHAPES[i % SHAPES.length] }))
  const edges = nodes.slice(1).map((nd, i) => edge(nodes[i]!.id, nd.id))
  return { nodes, edges }
}

// A root with 6 children, each with 3 grandchildren (varied sizes).
function wideTree(): { nodes: MapNode[]; edges: MapEdge[] } {
  const nodes: MapNode[] = [node('root', { width: 200, height: 60 })]
  const edges: MapEdge[] = []
  for (let i = 0; i < 6; i++) {
    nodes.push(node(`k${i}`, { shape: SHAPES[i % SHAPES.length] }))
    edges.push(edge('root', `k${i}`))
    for (let j = 0; j < 3; j++) {
      nodes.push(node(`g${i}${j}`, { width: 60 + j * 40, height: 30 + j * 10 }))
      edges.push(edge(`k${i}`, `g${i}${j}`))
    }
  }
  return { nodes, edges }
}

function cyclic(): { nodes: MapNode[]; edges: MapEdge[] } {
  const ids = ['a', 'b', 'c', 'd', 'e']
  return {
    nodes: ids.map((id) => node(id)),
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd'), edge('d', 'e'), edge('e', 'c'), edge('b', 'b')]
  }
}

function disconnected(): { nodes: MapNode[]; edges: MapEdge[] } {
  const a = chain(3)
  const b = { nodes: ['x1', 'x2', 'x3'].map((id) => node(id, { shape: 'decision' })), edges: [edge('x1', 'x2'), edge('x1', 'x3')] }
  return { nodes: [...a.nodes, ...b.nodes, node('solo1'), node('solo2', { shape: 'circle' })], edges: [...a.edges, ...b.edges] }
}

function randomGraph(n: number, seed: number): { nodes: MapNode[]; edges: MapEdge[] } {
  const r = rng(seed)
  const nodes = Array.from({ length: n }, (_, i) =>
    node(`r${i}`, {
      shape: SHAPES[Math.floor(r() * SHAPES.length)],
      ...(r() < 0.3 ? { width: 60 + Math.floor(r() * 160), height: 30 + Math.floor(r() * 70) } : {}),
      x: Math.floor(r() * 1000),
      y: Math.floor(r() * 1000)
    })
  )
  const edges: MapEdge[] = []
  for (let i = 1; i < n; i++) {
    // mostly forward edges + some back edges (cycles) + some isolated nodes
    if (r() < 0.92) edges.push(edge(`r${Math.floor(r() * i)}`, `r${i}`))
    if (r() < 0.15) edges.push(edge(`r${i}`, `r${Math.floor(r() * i)}`))
  }
  return { nodes, edges }
}

// ── assertions ──────────────────────────────────────────────────────────────

function isContainer(n: MapNode): boolean {
  return !!getShape(n.shape).container
}

function overlapPairs(nodes: MapNode[]): string[] {
  const vis = nodes.filter((n) => !n.hidden && !isContainer(n))
  const out: string[] = []
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i]!
      const b = vis[j]!
      const sa = nodeSize(a)
      const sb = nodeSize(b)
      if (a.x < b.x + sb.w && a.x + sa.w > b.x && a.y < b.y + sb.h && a.y + sa.h > b.y) out.push(`${a.id}×${b.id}`)
    }
  }
  return out
}

function allInts(nodes: MapNode[]): boolean {
  return nodes.every((n) => Number.isInteger(n.x) && Number.isInteger(n.y))
}

const ALGOS: LayoutAlgorithm[] = ['layered', 'tree', 'radial', 'grid', 'organic', 'mindmap']
const DIRS: LayoutDirection[] = ['TB', 'LR', 'BT', 'RL']
const FIXTURES = {
  chain: () => chain(8),
  wideTree,
  cyclic,
  disconnected,
  random120: () => randomGraph(120, 42)
}

// ── matrix: every algorithm × direction × fixture ───────────────────────────

describe('layoutDiagram — invariants across algorithms, directions and graphs', () => {
  for (const algo of ALGOS) {
    for (const dir of DIRS) {
      for (const [name, make] of Object.entries(FIXTURES)) {
        it(`${algo} ${dir} on ${name}: no overlaps, integer coords, deterministic, all nodes kept`, () => {
          const { nodes, edges } = make()
          const t0 = performance.now()
          const out = layoutDiagram(nodes, edges, { algorithm: algo, direction: dir })
          const ms = performance.now() - t0
          expect(out).toHaveLength(nodes.length)
          expect(out.map((n) => n.id)).toEqual(nodes.map((n) => n.id))
          expect(overlapPairs(out)).toEqual([])
          expect(allInts(out)).toBe(true)
          const again = layoutDiagram(nodes, edges, { algorithm: algo, direction: dir })
          expect(again).toEqual(out)
          if (name === 'random120') expect(ms).toBeLessThan(2000)
          // Never mutates the input.
          expect(nodes.every((n) => n.x === make().nodes.find((m) => m.id === n.id)!.x)).toBe(true)
        })
      }
    }
  }
})

// ── layered: direction semantics on a DAG ───────────────────────────────────

describe('layoutDiagram — layered direction semantics', () => {
  const dag = (): { nodes: MapNode[]; edges: MapEdge[] } => {
    const t = wideTree()
    // add cross links and a long edge so dummies are exercised
    t.edges.push(edge('k0', 'g10'), edge('root', 'g52'), edge('k2', 'g31'))
    return t
  }
  const byId = (ns: MapNode[]): Map<string, MapNode> => new Map(ns.map((n) => [n.id, n]))

  it('TB: every edge points downward (parent bottom above child top)', () => {
    const { nodes, edges } = dag()
    const m = byId(layoutDiagram(nodes, edges, { algorithm: 'layered', direction: 'TB' }))
    for (const e of edges) {
      const s = m.get(e.source)!
      const t = m.get(e.target)!
      expect(s.y + nodeSize(s).h).toBeLessThanOrEqual(t.y)
    }
  })

  it('BT: every edge points upward', () => {
    const { nodes, edges } = dag()
    const m = byId(layoutDiagram(nodes, edges, { algorithm: 'layered', direction: 'BT' }))
    for (const e of edges) {
      const s = m.get(e.source)!
      const t = m.get(e.target)!
      expect(t.y + nodeSize(t).h).toBeLessThanOrEqual(s.y)
    }
  })

  it('LR: parents left of children', () => {
    const { nodes, edges } = dag()
    const m = byId(layoutDiagram(nodes, edges, { algorithm: 'layered', direction: 'LR' }))
    for (const e of edges) {
      const s = m.get(e.source)!
      const t = m.get(e.target)!
      expect(s.x + nodeSize(s).w).toBeLessThanOrEqual(t.x)
    }
  })

  it('RL: parents right of children', () => {
    const { nodes, edges } = dag()
    const m = byId(layoutDiagram(nodes, edges, { algorithm: 'layered', direction: 'RL' }))
    for (const e of edges) {
      const s = m.get(e.source)!
      const t = m.get(e.target)!
      expect(t.x + nodeSize(t).w).toBeLessThanOrEqual(s.x)
    }
  })

  it('centres a parent over its children in a simple tree', () => {
    const nodes = [node('p'), node('a'), node('b'), node('c')]
    const edges = [edge('p', 'a'), edge('p', 'b'), edge('p', 'c')]
    const m = byId(layoutDiagram(nodes, edges, { algorithm: 'layered', direction: 'TB' }))
    const cx = (n: MapNode): number => n.x + nodeSize(n).w / 2
    const kids = ['a', 'b', 'c'].map((id) => cx(m.get(id)!))
    expect(Math.abs(cx(m.get('p')!) - (Math.min(...kids) + Math.max(...kids)) / 2)).toBeLessThanOrEqual(1)
  })

  it('produces no crossings for a planar two-level graph given in a crossing order', () => {
    // a→y, b→x : the input order crosses; barycenter must untangle it.
    const nodes = [node('a'), node('b'), node('x'), node('y')]
    const edges = [edge('a', 'y'), edge('b', 'x')]
    // connect them so they are one component
    edges.push(edge('a', 'x'))
    const m = byId(layoutDiagram(nodes, edges, { algorithm: 'layered', direction: 'TB' }))
    // a→x and b→x share x; a→y must not cross b→x: order a<b ⇒ x<y? check via sign test
    const sign = (s: string, t: string): number => Math.sign(m.get(s)!.x - m.get(t)!.x)
    const crosses = sign('a', 'b') !== 0 && sign('a', 'b') !== sign('y', 'x') && sign('y', 'x') !== 0
    expect(crosses).toBe(false)
  })

  it('tree TB puts parents above children; LR puts them to the left', () => {
    const { nodes, edges } = wideTree()
    const tb = byId(layoutDiagram(nodes, edges, { algorithm: 'tree', direction: 'TB' }))
    const lr = byId(layoutDiagram(nodes, edges, { algorithm: 'tree', direction: 'LR' }))
    for (const e of edges) {
      expect(tb.get(e.source)!.y + nodeSize(tb.get(e.source)!).h).toBeLessThanOrEqual(tb.get(e.target)!.y)
      expect(lr.get(e.source)!.x + nodeSize(lr.get(e.source)!).w).toBeLessThanOrEqual(lr.get(e.target)!.x)
    }
  })
})

// ── fixed nodes: locked, hidden, containers ─────────────────────────────────

describe('layoutDiagram — fixed nodes', () => {
  for (const algo of ALGOS) {
    it(`${algo}: locked nodes never move and nothing overlaps them`, () => {
      const { nodes, edges } = randomGraph(40, 7)
      // lock a few, placing them where the layout is likely to want to go
      const spots: Record<string, [number, number]> = { r0: [0, 0], r5: [300, 40], r17: [150, 200] }
      const locked = new Set(Object.keys(spots))
      // Put the free nodes' current bounds at the origin so the layout lands on the locked ones.
      const input = nodes.map((n) =>
        locked.has(n.id) ? { ...n, locked: true, x: spots[n.id]![0], y: spots[n.id]![1] } : { ...n, x: n.x % 50, y: n.y % 50 }
      )
      const out = layoutDiagram(input, edges, { algorithm: algo, direction: 'TB' })
      for (const id of locked) {
        const a = input.find((n) => n.id === id)!
        const b = out.find((n) => n.id === id)!
        expect([b.x, b.y]).toEqual([a.x, a.y])
      }
      expect(overlapPairs(out)).toEqual([])
    })
  }

  it('hidden nodes are skipped (unchanged) and ignored for overlap', () => {
    const { nodes, edges } = chain(5)
    const input = nodes.map((n) => (n.id === 'c2' ? { ...n, hidden: true, x: 123.5, y: 77 } : n))
    const out = layoutDiagram(input, edges, { algorithm: 'layered' })
    const h = out.find((n) => n.id === 'c2')!
    expect([h.x, h.y]).toEqual([123.5, 77])
  })

  it('containers and their children stay put unless named in onlyIds', () => {
    const lane = node('lane1', { shape: 'lane', x: 0, y: 0, width: 600, height: 200 })
    const kid1 = node('k1', { parentId: 'lane1', x: 60, y: 40 })
    const kid2 = node('k2', { parentId: 'lane1', x: 260, y: 40 })
    const free = [node('f1'), node('f2'), node('f3')]
    const nodes = [lane, kid1, kid2, ...free]
    const edges = [edge('f1', 'f2'), edge('f2', 'f3'), edge('k1', 'f1')]
    const out = layoutDiagram(nodes, edges, { algorithm: 'layered' })
    const get = (id: string): MapNode => out.find((n) => n.id === id)!
    expect([get('lane1').x, get('lane1').y]).toEqual([0, 0])
    expect([get('k1').x, get('k1').y]).toEqual([60, 40])
    expect([get('k2').x, get('k2').y]).toEqual([260, 40])
    expect(overlapPairs(out)).toEqual([])
    // free nodes must not land inside the lane either
    for (const id of ['f1', 'f2', 'f3']) {
      const n = get(id)
      const inside = n.x < 600 && n.x + nodeSize(n).w > 0 && n.y < 200 && n.y + nodeSize(n).h > 0
      expect(inside).toBe(false)
    }
  })

  it('a container in onlyIds moves as a block and carries its children', () => {
    const lane = node('lane1', { shape: 'lane', x: 500, y: 500, width: 400, height: 160 })
    const kid = node('k1', { parentId: 'lane1', x: 560, y: 540 })
    const other = node('o1', { x: 0, y: 0 })
    const out = layoutDiagram([lane, kid, other], [edge('o1', 'lane1')], {
      algorithm: 'layered',
      onlyIds: ['lane1', 'o1'],
      origin: { x: 0, y: 0 }
    })
    const l = out.find((n) => n.id === 'lane1')!
    const k = out.find((n) => n.id === 'k1')!
    expect(k.x - l.x).toBe(60)
    expect(k.y - l.y).toBe(40)
    expect(l.x !== 500 || l.y !== 500).toBe(true)
  })
})

// ── onlyIds ─────────────────────────────────────────────────────────────────

describe('layoutDiagram — onlyIds', () => {
  it('moves only the subset and keeps it clear of the rest', () => {
    const { nodes, edges } = chain(6)
    const placedRest = nodes.map((n, i) => ({ ...n, x: i * 200, y: 0 }))
    const subset = ['c3', 'c4', 'c5']
    const out = layoutDiagram(placedRest, edges, { algorithm: 'layered', onlyIds: subset, origin: { x: 0, y: 0 } })
    for (const n of out) {
      if (subset.includes(n.id)) continue
      const before = placedRest.find((m) => m.id === n.id)!
      expect([n.x, n.y]).toEqual([before.x, before.y])
    }
    expect(overlapPairs(out)).toEqual([])
    // asked for origin 0,0 which collides; the subset steps right of the rest
    const rightOfRest = Math.max(...out.filter((n) => !subset.includes(n.id)).map((n) => n.x + nodeSize(n).w))
    for (const id of subset) expect(out.find((n) => n.id === id)!.x).toBeGreaterThanOrEqual(rightOfRest)
  })

  it('keeps the subset at its origin when there is room', () => {
    const nodes = [node('a', { x: 0, y: 0 }), node('b', { x: 0, y: 0 }), node('z', { x: 5000, y: 5000 })]
    const out = layoutDiagram(nodes, [edge('a', 'b')], { algorithm: 'layered', onlyIds: ['a', 'b'], origin: { x: 100, y: 100 } })
    const a = out.find((n) => n.id === 'a')!
    expect(a.y).toBe(100)
    expect(out.find((n) => n.id === 'z')!.x).toBe(5000)
  })
})

// ── algorithm-specific shapes ───────────────────────────────────────────────

describe('layoutDiagram — algorithm character', () => {
  const centre = (n: MapNode): { x: number; y: number } => ({ x: n.x + nodeSize(n).w / 2, y: n.y + nodeSize(n).h / 2 })

  it('radial puts the root at the centre and deeper nodes further out', () => {
    const { nodes, edges } = wideTree()
    const out = layoutDiagram(nodes, edges, { algorithm: 'radial' })
    const m = new Map(out.map((n) => [n.id, n]))
    const r = centre(m.get('root')!)
    const dist = (id: string): number => Math.hypot(centre(m.get(id)!).x - r.x, centre(m.get(id)!).y - r.y)
    const kids = [0, 1, 2, 3, 4, 5].map((i) => dist(`k${i}`))
    const grand = [0, 1, 2, 3, 4, 5].flatMap((i) => [0, 1, 2].map((j) => dist(`g${i}${j}`)))
    expect(Math.max(...kids)).toBeLessThan(Math.min(...grand))
  })

  it('mindmap splits the root’s children left and right', () => {
    const { nodes, edges } = wideTree()
    const out = layoutDiagram(nodes, edges, { algorithm: 'mindmap' })
    const m = new Map(out.map((n) => [n.id, n]))
    const rx = centre(m.get('root')!).x
    const sides = [0, 1, 2, 3, 4, 5].map((i) => Math.sign(centre(m.get(`k${i}`)!).x - rx))
    expect(sides.filter((s) => s > 0).length).toBe(3)
    expect(sides.filter((s) => s < 0).length).toBe(3)
    // grandchildren sit further out on the same side as their parent
    for (let i = 0; i < 6; i++) {
      const k = centre(m.get(`k${i}`)!).x - rx
      const g = centre(m.get(`g${i}0`)!).x - rx
      expect(Math.sign(g)).toBe(Math.sign(k))
      expect(Math.abs(g)).toBeGreaterThan(Math.abs(k))
    }
  })

  it('grid is near-square and follows reading order', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => node(`n${i}`, { x: (8 - i) * 10, y: i * 100 }))
    const out = layoutDiagram(nodes, [], { algorithm: 'grid' })
    const m = new Map(out.map((n) => [n.id, n]))
    const rows = new Set(out.map((n) => n.y)).size
    const cols = new Set(out.map((n) => n.x)).size
    expect(rows).toBe(3)
    expect(cols).toBe(3)
    expect(m.get('n0')!.y).toBeLessThan(m.get('n3')!.y)
    expect(m.get('n0')!.x).toBeLessThan(m.get('n1')!.x)
  })

  it('organic keeps linked nodes closer than unlinked ones on average', () => {
    const { nodes, edges } = randomGraph(40, 3)
    const out = layoutDiagram(nodes, edges, { algorithm: 'organic' })
    const m = new Map(out.map((n) => [n.id, centre(n)]))
    const d = (a: string, b: string): number => Math.hypot(m.get(a)!.x - m.get(b)!.x, m.get(a)!.y - m.get(b)!.y)
    const linked = edges.map((e) => d(e.source, e.target))
    const all: number[] = []
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) all.push(d(out[i]!.id, out[j]!.id))
    const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
    expect(avg(linked)).toBeLessThan(avg(all))
  })

  it('respects an explicit origin', () => {
    const { nodes, edges } = chain(4)
    const out = layoutDiagram(nodes, edges, { algorithm: 'layered', origin: { x: 300, y: 200 } })
    expect(Math.min(...out.map((n) => n.x))).toBe(300)
    expect(Math.min(...out.map((n) => n.y))).toBe(200)
  })

  it('handles empty input and edges to unknown nodes', () => {
    expect(layoutDiagram([], [], { algorithm: 'layered' })).toEqual([])
    const out = layoutDiagram([node('a'), node('b')], [edge('a', 'ghost'), edge('a', 'b')], { algorithm: 'tree' })
    expect(overlapPairs(out)).toEqual([])
  })
})
