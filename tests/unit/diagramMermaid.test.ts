import { describe, it, expect } from 'vitest'
import { mermaidToMap, mapToMermaid } from '../../src/shared/diagram/mermaid'
import { nodeSize } from '../../src/shared/diagram/geom'
import { SHAPES, getShape, isShapeId } from '../../src/shared/diagram/shapes'
import type { MapEdge, MapNode } from '../../src/shared/types'

const byId = (ns: MapNode[]): Map<string, MapNode> => new Map(ns.map((n) => [n.id, n]))

function overlapPairs(nodes: MapNode[]): string[] {
  const vis = nodes.filter((n) => !getShape(n.shape).container)
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

function edgeBetween(edges: MapEdge[], s: string, t: string): MapEdge | undefined {
  return edges.find((e) => e.source === s && e.target === t)
}

describe('mermaidToMap — flowchart shapes', () => {
  const src = `flowchart TD
    A[Rect] --> B(Rounded)
    B --> C([Stadium])
    C --> D[[Subroutine]]
    D --> E[(Database)]
    E --> F((Circle))
    F --> G>Asymmetric]
    G --> H{Decision}
    H --> I{{Hexagon}}
    I --> J[/Parallelogram/]
    J --> K[\\Alt\\]
    K --> L[/Trapezoid\\]
    L --> M[\\Inverted/]
    M --> N(((Double)))
    N --> O@{ shape: doc, label: "A document" }`

  const { nodes, edges, warnings } = mermaidToMap(src)
  const m = byId(nodes)

  it('creates every node with its label and every edge', () => {
    expect(nodes).toHaveLength(15)
    expect(edges).toHaveLength(14)
    expect(warnings).toEqual([])
    expect(m.get('A')!.label).toBe('Rect')
    expect(m.get('K')!.label).toBe('Alt')
    expect(m.get('L')!.label).toBe('Trapezoid')
    expect(m.get('N')!.label).toBe('Double')
    expect(m.get('O')!.label).toBe('A document')
  })

  it('maps shapes onto registered ids', () => {
    for (const n of nodes) expect(isShapeId(n.shape)).toBe(true)
    expect(m.get('A')!.shape).toBe('process')
    expect(m.get('C')!.shape).toBe('terminator')
    expect(['database', 'fc-database']).toContain(m.get('E')!.shape)
    expect(m.get('F')!.shape).toBe('circle')
    expect(m.get('H')!.shape).toBe('decision')
    expect(m.get('I')!.shape).toBe('hexagon')
    expect(m.get('J')!.shape).toBe('data')
    expect(m.get('L')!.shape).toBe('trapezoid')
    // fallbacks keep the look: rounded → process with a radius when no rounded shape exists
    const b = m.get('B')!
    if (b.shape === 'process') expect(b.style?.radius).toBeGreaterThan(0)
    // alt parallelogram / inverted trapezoid fall back to a flip
    const k = m.get('K')!
    if (k.shape === 'data') expect(k.flipX).toBe(true)
    const mm = m.get('M')!
    if (mm.shape === 'trapezoid') expect(mm.flipY).toBe(true)
  })

  it('lays the result out top-down without overlaps', () => {
    expect(overlapPairs(nodes)).toEqual([])
    for (const e of edges) {
      const s = m.get(e.source)!
      const t = m.get(e.target)!
      expect(s.y + nodeSize(s).h).toBeLessThanOrEqual(t.y)
    }
  })
})

describe('mermaidToMap — edges', () => {
  it('parses every operator and its styling', () => {
    const { edges, warnings } = mermaidToMap(`graph LR
      A --> B
      A --- C
      A -.-> D
      A ==> E
      A --o F
      A --x G
      A <--> H
      A -.- I
      A ===> J
      A ----> K
      A ~~~ L
      A o--o M`)
    expect(warnings).toEqual([])
    expect(edgeBetween(edges, 'A', 'B')!.endArrow).toBe('arrow')
    expect(edgeBetween(edges, 'A', 'C')!.endArrow).toBe('none')
    expect(edgeBetween(edges, 'A', 'D')!.dash).toBe('dashed')
    expect(edgeBetween(edges, 'A', 'D')!.endArrow).toBe('arrow')
    expect(edgeBetween(edges, 'A', 'E')!.strokeWidth).toBe(3)
    expect(edgeBetween(edges, 'A', 'F')!.endArrow).toBe('circle')
    expect(edgeBetween(edges, 'A', 'G')!.endArrow).toBe('bar')
    const h = edgeBetween(edges, 'A', 'H')!
    expect([h.startArrow, h.endArrow]).toEqual(['arrow', 'arrow'])
    expect(edgeBetween(edges, 'A', 'I')!.endArrow).toBe('none')
    expect(edgeBetween(edges, 'A', 'I')!.dash).toBe('dashed')
    expect(edgeBetween(edges, 'A', 'J')!.strokeWidth).toBe(3)
    expect(edgeBetween(edges, 'A', 'K')!.endArrow).toBe('arrow')
    expect(edgeBetween(edges, 'A', 'L')!.dash).toBe('none')
    const mm = edgeBetween(edges, 'A', 'M')!
    expect([mm.startArrow, mm.endArrow]).toEqual(['circle', 'circle'])
  })

  it('reads |pipe| labels and inline text labels', () => {
    const { edges } = mermaidToMap(`flowchart TD
      A -->|yes| B
      A -- no way --> C
      A == bold move ==> D
      A -. maybe .-> E
      A -->|"quoted | pipe"| F`)
    expect(edgeBetween(edges, 'A', 'B')!.label).toBe('yes')
    expect(edgeBetween(edges, 'A', 'C')!.label).toBe('no way')
    expect(edgeBetween(edges, 'A', 'D')!.label).toBe('bold move')
    expect(edgeBetween(edges, 'A', 'D')!.strokeWidth).toBe(3)
    expect(edgeBetween(edges, 'A', 'E')!.label).toBe('maybe')
    expect(edgeBetween(edges, 'A', 'E')!.dash).toBe('dashed')
    expect(edgeBetween(edges, 'A', 'F')).toBeDefined()
  })

  it('expands chains and & fan-out/fan-in', () => {
    const { nodes, edges } = mermaidToMap(`flowchart LR
      A --> B --> C
      C & D --> E & F`)
    expect(nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    expect(edges).toHaveLength(6)
    for (const [s, t] of [['A', 'B'], ['B', 'C'], ['C', 'E'], ['C', 'F'], ['D', 'E'], ['D', 'F']]) {
      expect(edgeBetween(edges, s!, t!)).toBeDefined()
    }
  })

  it('accepts semicolons, statements on the header line, glued ids and hyphenated ids', () => {
    const { nodes, edges, warnings } = mermaidToMap('graph TD; A-->B; B-.->my-node; my-node==>C')
    expect(warnings).toEqual([])
    expect(nodes.map((n) => n.id)).toEqual(['A', 'B', 'my-node', 'C'])
    expect(edges).toHaveLength(3)
  })

  it('LR layouts put sources left of targets', () => {
    const { nodes, edges } = mermaidToMap('flowchart LR\n A-->B-->C\n A-->C')
    const m = byId(nodes)
    for (const e of edges) expect(m.get(e.source)!.x + nodeSize(m.get(e.source)!).w).toBeLessThanOrEqual(m.get(e.target)!.x)
  })
})

describe('mermaidToMap — subgraphs, styles, text', () => {
  it('turns subgraphs into lane containers that enclose their members', () => {
    const { nodes, edges, warnings } = mermaidToMap(`flowchart TD
      start((Go)) --> a1
      subgraph one [First stage]
        a1[Step 1] --> a2[Step 2]
        subgraph inner["Inner bit"]
          i1 --> i2
        end
      end
      subgraph two
        b1 --> b2
      end
      a2 --> b1
      one --> two`)
    expect(warnings).toEqual([])
    const m = byId(nodes)
    expect(m.get('one')!.shape).toBe('lane')
    expect(m.get('one')!.label).toBe('First stage')
    expect(m.get('inner')!.label).toBe('Inner bit')
    expect(m.get('inner')!.parentId).toBe('one')
    expect(m.get('two')!.label).toBe('two')
    expect(m.get('a1')!.parentId).toBe('one')
    expect(m.get('i1')!.parentId).toBe('inner')
    expect(m.get('b2')!.parentId).toBe('two')
    expect(m.get('start')!.parentId).toBeUndefined()
    expect(edgeBetween(edges, 'one', 'two')).toBeDefined()
    // containment: every member's box lies inside its container
    for (const n of nodes) {
      if (!n.parentId) continue
      const p = m.get(n.parentId)!
      const ps = nodeSize(p)
      const s = nodeSize(n)
      expect(n.x).toBeGreaterThanOrEqual(p.x)
      expect(n.y).toBeGreaterThanOrEqual(p.y)
      expect(n.x + s.w).toBeLessThanOrEqual(p.x + ps.w)
      expect(n.y + s.h).toBeLessThanOrEqual(p.y + ps.h)
    }
    expect(overlapPairs(nodes)).toEqual([])
    // sibling containers do not overlap each other
    const a = m.get('one')!
    const b = m.get('two')!
    const sa = nodeSize(a)
    const sb = nodeSize(b)
    expect(a.x < b.x + sb.w && a.x + sa.w > b.x && a.y < b.y + sb.h && a.y + sa.h > b.y).toBe(false)
  })

  it('applies classDef/class/:::/style colours', () => {
    const { nodes, warnings } = mermaidToMap(`flowchart TD
      classDef hot fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px
      A:::hot --> B
      class B hot
      style C fill:#dcfce7,stroke:#16a34a
      C --> A`)
    const m = byId(nodes)
    expect(m.get('A')!.style).toMatchObject({ fill: '#fee2e2', stroke: '#dc2626', textColor: '#7f1d1d', strokeWidth: 2 })
    expect(m.get('A')!.color).toBe('#dc2626')
    expect(m.get('B')!.style?.fill).toBe('#fee2e2')
    expect(m.get('C')!.style?.fill).toBe('#dcfce7')
    expect(warnings).toEqual([])
  })

  it('decodes entities, <br>, quotes and markdown strings; strips comments', () => {
    const { nodes, edges } = mermaidToMap(`%% a comment
      flowchart TD
      A["He said #quot;hi#quot;"] --> B["line one<br>line two"] %% trailing
      B --> C["\`**bold** text\`"]
      C --> D["A (with) [brackets] {and} braces"]`)
    const m = byId(nodes)
    expect(m.get('A')!.label).toBe('He said "hi"')
    expect(m.get('B')!.label).toBe('line one\nline two')
    expect(m.get('C')!.label).toBe('bold text')
    expect(m.get('D')!.label).toBe('A (with) [brackets] {and} braces')
    expect(edges).toHaveLength(3)
  })

  it('imports click href links', () => {
    const { nodes } = mermaidToMap('flowchart TD\n A --> B\n click A href "https://example.com/a"')
    expect(byId(nodes).get('A')!.link).toBe('https://example.com/a')
  })

  it('skips YAML front matter', () => {
    const { nodes, warnings } = mermaidToMap('---\ntitle: Hello\n---\nflowchart LR\n A --> B')
    expect(nodes).toHaveLength(2)
    expect(warnings).toEqual([])
  })
})

describe('mermaidToMap — malformed input warns, never throws', () => {
  const cases: [string, string][] = [
    ['empty', ''],
    ['unsupported type', 'sequenceDiagram\n Alice->>Bob: hi'],
    ['dangling edge', 'flowchart TD\n A -->'],
    ['garbage', 'flowchart TD\n A --> B\n ??? !!! ###'],
    ['unclosed bracket', 'flowchart TD\n A[oops --> B'],
    ['unclosed subgraph', 'flowchart TD\n subgraph s1\n A --> B'],
    ['stray end', 'flowchart TD\n A --> B\n end'],
    ['linkStyle', 'flowchart TD\n A --> B\n linkStyle 0 stroke:#f00'],
    ['undefined class', 'flowchart TD\n A:::nope --> B'],
    ['bad er', 'erDiagram\n CUSTOMER }}--{{ ORDER\n ???'],
    ['bad class', 'classDiagram\n class A {\n +x'],
    ['binary junk', '\u0000\u0001flowchart\u0002'],
    ['unknown v11 shape', 'flowchart TD\n A@{ shape: blob }']
  ]
  for (const [name, src] of cases) {
    it(name, () => {
      let r: ReturnType<typeof mermaidToMap> | undefined
      expect(() => (r = mermaidToMap(src))).not.toThrow()
      expect(r!.warnings.length).toBeGreaterThan(0)
      expect(overlapPairs(r!.nodes)).toEqual([])
    })
  }
  it('handles non-string input defensively', () => {
    expect(() => mermaidToMap(undefined as unknown as string)).not.toThrow()
  })
})

describe('mermaidToMap — erDiagram and classDiagram', () => {
  it('parses entities, attributes and crow’s-foot relationships', () => {
    const { nodes, edges, warnings } = mermaidToMap(`erDiagram
      CUSTOMER ||--o{ ORDER : places
      ORDER ||--|{ LINE-ITEM : contains
      CUSTOMER }|..|{ DELIVERY-ADDRESS : uses
      PRODUCT |o--o| LINE-ITEM : "appears in"
      CUSTOMER {
        string name PK
        string email UK "login"
      }`)
    expect(warnings).toEqual([])
    expect(nodes.map((n) => n.id).sort()).toEqual(['CUSTOMER', 'DELIVERY-ADDRESS', 'LINE-ITEM', 'ORDER', 'PRODUCT'])
    const places = edgeBetween(edges, 'CUSTOMER', 'ORDER')!
    expect([places.startArrow, places.endArrow, places.label]).toEqual(['crowOne', 'crowZeroOrMany', 'places'])
    const contains = edgeBetween(edges, 'ORDER', 'LINE-ITEM')!
    expect(contains.endArrow).toBe('crowOneOrMany')
    const uses = edgeBetween(edges, 'CUSTOMER', 'DELIVERY-ADDRESS')!
    expect([uses.startArrow, uses.endArrow, uses.dash]).toEqual(['crowOneOrMany', 'crowOneOrMany', 'dashed'])
    const appears = edgeBetween(edges, 'PRODUCT', 'LINE-ITEM')!
    expect([appears.startArrow, appears.endArrow, appears.label]).toEqual(['crowZeroOrOne', 'crowZeroOrOne', 'appears in'])
    const cust = byId(nodes).get('CUSTOMER')!
    expect(cust.shape).toBe(isShapeId('erd-entity') ? 'erd-entity' : 'process')
    const text = cust.cells ? cust.cells.flat().join(' ') : cust.label
    expect(text).toContain('name')
    expect(text).toContain('email')
    expect(overlapPairs(nodes)).toEqual([])
  })

  it('parses classes, members and relationship arrows', () => {
    const { nodes, edges, warnings } = mermaidToMap(`classDiagram
      Animal <|-- Duck
      Animal <|-- Fish
      Duck --|> Bird
      Zoo *-- Animal
      Zoo o-- Keeper
      Keeper ..> Food : feeds
      Animal "1" --> "*" Leg
      Animal : +int age
      class Duck {
        +swim()
        +quack()
      }`)
    expect(warnings).toEqual([])
    const ids = nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['Animal', 'Bird', 'Duck', 'Fish', 'Food', 'Keeper', 'Leg', 'Zoo'])
    expect(edgeBetween(edges, 'Animal', 'Duck')!.startArrow).toBe('triangle')
    expect(edgeBetween(edges, 'Duck', 'Bird')!.endArrow).toBe('triangle')
    expect(edgeBetween(edges, 'Zoo', 'Animal')!.startArrow).toBe('diamond')
    expect(edgeBetween(edges, 'Zoo', 'Keeper')!.startArrow).toBe('diamondOpen')
    const feeds = edgeBetween(edges, 'Keeper', 'Food')!
    expect([feeds.endArrow, feeds.dash, feeds.label]).toEqual(['open', 'dashed', 'feeds'])
    expect(edgeBetween(edges, 'Animal', 'Leg')!.label).toBe('1 *')
    const duck = byId(nodes).get('Duck')!
    const text = duck.cells ? duck.cells.flat().join(' ') : duck.label
    expect(text).toContain('+swim()')
    expect(overlapPairs(nodes)).toEqual([])
  })
})

describe('mapToMermaid', () => {
  it('emits shapes, escaped labels, edge styles and subgraphs', () => {
    const nodes: MapNode[] = [
      { id: 'lane-1', x: 0, y: 0, label: 'Team "A"', shape: 'lane', color: '#64748b', width: 600, height: 200 },
      { id: 'n1', x: 50, y: 20, label: 'Start', shape: 'terminator', color: '#2563eb', parentId: 'lane-1' },
      { id: 'n2', x: 250, y: 20, label: 'Is it "ok"?\nReally', shape: 'decision', color: '#dc2626', parentId: 'lane-1' },
      { id: '3', x: 0, y: 300, label: 'Store | data', shape: 'database', color: '#2563eb', style: { fill: '#eef2ff' } },
      { id: 'end', x: 300, y: 300, label: 'End', shape: 'circle', color: '#2563eb' }
    ]
    const edges: MapEdge[] = [
      { id: 'a', source: 'n1', target: 'n2', label: 'go' },
      { id: 'b', source: 'n2', target: '3', dash: 'dashed', label: 'no' },
      { id: 'c', source: 'n2', target: 'end', strokeWidth: 3 },
      { id: 'd', source: '3', target: 'end', endArrow: 'none' },
      { id: 'e', source: 'end', target: 'n1', startArrow: 'arrow', endArrow: 'arrow' }
    ]
    const out = mapToMermaid(nodes, edges, 'LR')
    expect(out.startsWith('flowchart LR\n')).toBe(true)
    expect(out).toContain('subgraph lane_1["Team #quot;A#quot;"]')
    expect(out).toContain('n1(["Start"])')
    expect(out).toContain('n2{"Is it #quot;ok#quot;?<br>Really"}')
    expect(out).toContain('n_3[("Store #124; data")]')
    expect(out).toContain('end_(("End"))')
    expect(out).toContain('n1 -->|"go"| n2')
    expect(out).toContain('n2 -.->|"no"| n_3')
    expect(out).toContain('n2 ==> end_')
    expect(out).toContain('n_3 --- end_')
    expect(out).toContain('end_ <--> n1')
    expect(out).toContain('style n_3 fill:#eef2ff')
    expect(out).toContain('style n2 stroke:#dc2626')
  })

  it('round-trips mermaid → map → mermaid → map preserving counts and labels', () => {
    const src = `flowchart TD
      A[Start here] --> B{Choose?}
      B -->|left| C(Rounded)
      B -- right --> D[(DB)]
      C -.-> E([Done])
      D ==> E
      E --o F((Hub))
      F --x G[/In out/]
      G --> H{{Prep}}
      H --> I[[Sub]]
      I --> J[/Trap\\]
      subgraph grp [Group "one"]
        K["Quote #quot;me#quot; & more"] --> L>Flag]
      end
      J --> K
      L --> A
      A --> O@{ shape: doc, label: "Docs" }`
    const first = mermaidToMap(src)
    expect(first.warnings).toEqual([])
    const text = mapToMermaid(first.nodes, first.edges)
    const second = mermaidToMap(text)
    expect(second.warnings).toEqual([])
    expect(second.nodes).toHaveLength(first.nodes.length)
    expect(second.edges).toHaveLength(first.edges.length)
    const labels = (ns: MapNode[]): string[] => ns.map((n) => n.label).sort()
    expect(labels(second.nodes)).toEqual(labels(first.nodes))
    const elabels = (es: MapEdge[]): string[] => es.map((e) => e.label ?? '').sort()
    expect(elabels(second.edges)).toEqual(elabels(first.edges))
    // shapes, styles and containment survive too
    const shapes = (ns: MapNode[]): string[] => ns.map((n) => `${n.label}:${n.shape}:${n.flipX ? 'fx' : ''}${n.flipY ? 'fy' : ''}`).sort()
    expect(shapes(second.nodes)).toEqual(shapes(first.nodes))
    const estyle = (es: MapEdge[]): string[] => es.map((e) => `${e.label ?? ''}:${e.dash ?? ''}:${e.strokeWidth ?? ''}:${e.endArrow}`).sort()
    expect(estyle(second.edges)).toEqual(estyle(first.edges))
    const k2 = second.nodes.find((n) => n.label === 'Quote "me" & more')!
    expect(second.nodes.find((n) => n.id === k2.parentId)!.label).toBe('Group "one"')
    // and a third pass is textually stable
    expect(mapToMermaid(second.nodes, second.edges)).toBe(text)
  })
})

describe('mapToMermaid — every registered shape', () => {
  it('emits Mermaid that re-imports cleanly with every node and label', () => {
    const nodes: MapNode[] = SHAPES.filter((d) => !d.container).map((d, i) => ({
      id: d.id,
      x: i * 10,
      y: 0,
      label: `${d.label} #${i}`,
      shape: d.id,
      color: '#2563eb'
    }))
    const edges: MapEdge[] = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i]!.id, target: n.id }))
    const text = mapToMermaid(nodes, edges)
    const back = mermaidToMap(text)
    expect(back.warnings).toEqual([])
    expect(back.nodes).toHaveLength(nodes.length)
    expect(back.edges).toHaveLength(edges.length)
    expect(back.nodes.map((n) => n.label).sort()).toEqual(nodes.map((n) => n.label).sort())
  })
})
