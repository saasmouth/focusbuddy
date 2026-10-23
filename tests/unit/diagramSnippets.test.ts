import { describe, expect, it, vi } from 'vitest'
import {
  diagramBodyFromSelection,
  diagramSnippetTarget,
  diagramSnippetTargetId,
  insertSnippetIntoDiagram,
  placeDiagramSnippet,
  suggestedDiagramSnippetName,
  type DiagramSnippetHost
} from '../../src/renderer/src/components/documents/diagram/diagramSnippets'
import { linkModesFor, snippetBodyIsEmpty, type DiagramSnippetBody, type Snippet } from '../../src/shared/snippets'
import { sharedObjectPaths } from '../../src/shared/diagram/sharedRefs'
import type { Graph, Sel } from '../../src/shared/diagram/ops'
import type { MapEdge, MapNode } from '../../src/shared/types'

// PlexiiDiagrams as a snippet surface (docs/saved-snippets.md, "Adding a
// snippet target"): capture is pure, insertion is a paste with fresh ids and
// remapped connectors that never touches the snippet, a viewer declines, and
// the link modes the target claims are the ones it has.

const n = (id: string, x: number, y: number, extra: Partial<MapNode> = {}): MapNode => ({
  id,
  x,
  y,
  label: id,
  shape: 'process',
  color: '#2563eb',
  width: 100,
  height: 60,
  ...extra
})
const e = (id: string, source: string, target: string, extra: Partial<MapEdge> = {}): MapEdge => ({ id, source, target, ...extra })
const sel = (nodes: string[], edges: string[] = []): Sel => ({ nodes: new Set(nodes), edges: new Set(edges) })

const page = (): Graph => ({
  nodes: [
    n('lane', 200, 100, { shape: 'lane', width: 500, height: 300 }),
    n('a', 240, 160, { parentId: 'lane', style: { bold: true }, layerId: 'L1' }),
    n('b', 420, 160, { parentId: 'lane', locked: true }),
    n('c', 900, 500),
    n('d', 1100, 500, { binding: { source: { kind: 'table', tableId: 't1', rowId: 'r9' }, labelTemplate: '{name}', fields: ['c1'] } })
  ],
  edges: [
    e('ab', 'a', 'b', { label: 'next', waypoints: [{ x: 360, y: 190 }] }),
    e('bc', 'b', 'c'),
    e('cd', 'c', 'd')
  ],
  layers: [{ id: 'L1', name: 'Notes', visible: true, locked: false }]
})

const snippetOf = (body: DiagramSnippetBody): Snippet =>
  ({
    id: 'snip-1',
    kind: 'diagram',
    name: 'Fragment',
    description: '',
    body,
    tags: [],
    scope: 'personal',
    orgId: 'personal',
    authorId: null,
    revision: 1,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0
  }) as unknown as Snippet

const nodeOf = (body: DiagramSnippetBody, id: string): MapNode => (body.nodes as MapNode[]).find((x) => x.id === id)!

describe('capture: diagramBodyFromSelection', () => {
  it('returns null for an empty selection, a connector alone, or ids not on the page', () => {
    expect(diagramBodyFromSelection(page(), sel([]))).toBeNull()
    expect(diagramBodyFromSelection(page(), sel([], ['ab']))).toBeNull()
    expect(diagramBodyFromSelection(page(), sel(['ghost']))).toBeNull()
  })

  it('keeps only connectors whose BOTH ends are in the fragment', () => {
    const body = diagramBodyFromSelection(page(), sel(['c', 'd'], ['bc']))!
    expect(body.kind).toBe('diagram')
    expect((body.nodes as MapNode[]).map((x) => x.id).sort()).toEqual(['c', 'd'])
    expect((body.edges as MapEdge[]).map((x) => x.id)).toEqual(['cd'])
  })

  it('makes positions relative to the fragment top-left, waypoints included', () => {
    const body = diagramBodyFromSelection(page(), sel(['c', 'd']))!
    expect(nodeOf(body, 'c')).toMatchObject({ x: 0, y: 0 })
    expect(nodeOf(body, 'd')).toMatchObject({ x: 200, y: 0 })
    const withLane = diagramBodyFromSelection(page(), sel(['lane']))!
    expect(nodeOf(withLane, 'lane')).toMatchObject({ x: 0, y: 0 })
    expect(nodeOf(withLane, 'a')).toMatchObject({ x: 40, y: 60 })
    expect((withLane.edges as MapEdge[])[0]!.waypoints).toEqual([{ x: 160, y: 90 }])
  })

  it('a container carries its children and the connectors between them', () => {
    const body = diagramBodyFromSelection(page(), sel(['lane']))!
    expect((body.nodes as MapNode[]).map((x) => x.id).sort()).toEqual(['a', 'b', 'lane'])
    expect(nodeOf(body, 'a').parentId).toBe('lane')
    expect((body.edges as MapEdge[]).map((x) => x.id)).toEqual(['ab'])
  })

  it('a child picked without its container loses the dangling parent, and locks are dropped', () => {
    const body = diagramBodyFromSelection(page(), sel(['a', 'b']))!
    expect(nodeOf(body, 'a').parentId).toBeUndefined()
    expect(nodeOf(body, 'b').locked).toBeUndefined()
  })

  it('is pure: the page is untouched and the body shares no object with it', () => {
    const g = page()
    const before = JSON.stringify(g)
    const body = diagramBodyFromSelection(g, sel(['lane', 'd']))!
    expect(JSON.stringify(g)).toBe(before)
    nodeOf(body, 'a').style!.bold = false
    expect(g.nodes.find((x) => x.id === 'a')!.style!.bold).toBe(true)
    expect(sharedObjectPaths({ g, body })).toEqual([])
  })

  it('keeps data bindings and is a non-empty body the store will accept', () => {
    const body = diagramBodyFromSelection(page(), sel(['d']))!
    const binding = { source: { kind: 'table', tableId: 't1', rowId: 'r9' }, labelTemplate: '{name}', fields: ['c1'] }
    expect(nodeOf(body, 'd').binding).toEqual(binding)
    expect(snippetBodyIsEmpty(body)).toBe(false)
    // ...and the binding is still there once inserted: it names a table, which
    // is just as valid in another diagram.
    const placed = placeDiagramSnippet({ nodes: [], edges: [] }, body, { x: 0, y: 0 })!
    expect(placed.graph.nodes[0]!.binding).toEqual(binding)
  })

  it('suggests a name from the first labelled shape', () => {
    expect(suggestedDiagramSnippetName(diagramBodyFromSelection(page(), sel(['c', 'd']))!)).toBe('c and 1 more')
    expect(suggestedDiagramSnippetName({ kind: 'diagram', nodes: [{ id: 'x', label: '  ' }], edges: [] })).toBe('Diagram fragment')
  })
})

describe('insertion: placeDiagramSnippet', () => {
  const body = (): DiagramSnippetBody => diagramBodyFromSelection(page(), sel(['lane']))!

  it('adds fresh ids with connectors and parents remapped onto the new shapes', () => {
    const g = page()
    const placed = placeDiagramSnippet(g, body(), { x: 2000, y: 2000 })!
    const added = placed.graph.nodes.slice(g.nodes.length)
    const addedEdges = placed.graph.edges.slice(g.edges.length)
    expect(added).toHaveLength(3)
    expect(addedEdges).toHaveLength(1)
    const oldIds = new Set(g.nodes.map((x) => x.id))
    for (const x of added) expect(oldIds.has(x.id)).toBe(false)
    expect(g.edges.some((x) => x.id === addedEdges[0]!.id)).toBe(false)
    const newIds = new Set(added.map((x) => x.id))
    expect(newIds.has(addedEdges[0]!.source)).toBe(true)
    expect(newIds.has(addedEdges[0]!.target)).toBe(true)
    const lane = added.find((x) => x.shape === 'lane')!
    for (const child of added.filter((x) => x.shape !== 'lane')) expect(child.parentId).toBe(lane.id)
    // The inserted shapes are the selection afterwards, as after a paste.
    expect([...placed.sel.nodes].sort()).toEqual([...newIds].sort())
    expect([...placed.sel.edges]).toEqual([addedEdges[0]!.id])
    // The original page content is still there, unchanged.
    expect(placed.graph.nodes.slice(0, g.nodes.length)).toEqual(g.nodes)
  })

  it('centres the block on the requested point, snapped to the grid', () => {
    const placed = placeDiagramSnippet({ nodes: [], edges: [] }, body(), { x: 1000, y: 1000 }, 16)!
    const lane = placed.graph.nodes.find((x) => x.shape === 'lane')!
    // Lane is 500 x 300: top-left at (750, 850) snapped to 16.
    expect(lane.x).toBe(Math.round(750 / 16) * 16)
    expect(lane.y).toBe(Math.round(850 / 16) * 16)
    const edge = placed.graph.edges[0]!
    expect(edge.waypoints![0]).toEqual({ x: lane.x + 160, y: lane.y + 90 })
  })

  it('inserting twice at the same spot gives two visible copies, not a stack', () => {
    const first = placeDiagramSnippet({ nodes: [], edges: [] }, body(), { x: 500, y: 500 })!
    const second = placeDiagramSnippet(first.graph, body(), { x: 500, y: 500 })!
    const lanes = second.graph.nodes.filter((x) => x.shape === 'lane')
    expect(lanes).toHaveLength(2)
    expect(lanes[0]!.x === lanes[1]!.x && lanes[0]!.y === lanes[1]!.y).toBe(false)
  })

  it('never mutates the snippet body, and the page shares no object with it', () => {
    const b = body()
    const before = JSON.stringify(b)
    const placed = placeDiagramSnippet(page(), b, { x: 0, y: 0 })!
    expect(JSON.stringify(b)).toBe(before)
    const inserted = placed.graph.nodes.find((x) => x.label === 'a' && !page().nodes.some((p) => p.id === x.id))!
    inserted.style!.bold = false
    expect(nodeOf(b, 'a').style!.bold).toBe(true)
    expect(sharedObjectPaths({ g: placed.graph, b })).toEqual([])
  })

  it('drops a layer the destination page does not have, and keeps one it does', () => {
    const b = body()
    const without = placeDiagramSnippet({ nodes: [], edges: [] }, b, { x: 0, y: 0 })!
    expect(without.graph.nodes.find((x) => x.label === 'a')!.layerId).toBeUndefined()
    const withLayer = placeDiagramSnippet({ nodes: [], edges: [], layers: [{ id: 'L1', name: 'Notes', visible: true, locked: false }] }, b, { x: 0, y: 0 })!
    expect(withLayer.graph.nodes.find((x) => x.label === 'a')!.layerId).toBe('L1')
  })

  it('treats the stored body as untrusted: junk is skipped, and nothing usable returns null', () => {
    expect(placeDiagramSnippet(page(), { kind: 'diagram', nodes: [], edges: [] }, { x: 0, y: 0 })).toBeNull()
    expect(placeDiagramSnippet(page(), { kind: 'diagram', nodes: [42, null, { x: 1 }], edges: [] }, { x: 0, y: 0 })).toBeNull()
    const placed = placeDiagramSnippet(
      { nodes: [], edges: [] },
      { kind: 'diagram', nodes: [{ id: 'k', x: 0, y: 0, label: 'Keep' }, 'junk'], edges: [{ id: 'dangle', source: 'k', target: 'gone' }] },
      { x: 0, y: 0 }
    )!
    expect(placed.graph.nodes.map((x) => x.label)).toEqual(['Keep'])
    expect(placed.graph.edges).toEqual([])
  })
})

describe('the target', () => {
  const host = (readOnly = false): DiagramSnippetHost & { insertBody: ReturnType<typeof vi.fn> } => ({ readOnly, insertBody: vi.fn(() => true) })
  const body = (): DiagramSnippetBody => diagramBodyFromSelection(page(), sel(['c', 'd']))!

  it('claims exactly duplicate, for diagram and every kind with a conversion into it', () => {
    const t = diagramSnippetTarget('r1', 'Flow', host())
    expect(t.host).toBe('diagram')
    expect(linkModesFor(t, 'diagram')).toEqual(['duplicate'])
    expect(linkModesFor(t, 'doc')).toEqual(['duplicate'])
    expect(linkModesFor(t, 'design')).toEqual(['duplicate'])
    expect(linkModesFor(t, 'draw')).toEqual(['duplicate'])
  })

  it('is identified by the mounted surface, so two open diagrams are two destinations', () => {
    expect(diagramSnippetTarget('r1', 'Flow', host()).id).toBe(diagramSnippetTargetId('r1'))
    expect(diagramSnippetTargetId('r1')).not.toBe(diagramSnippetTargetId('r2'))
    expect(diagramSnippetTarget('r1', 'Flow', host()).label).toBe('“Flow”')
    expect(diagramSnippetTarget('r1', '  ', host()).label).toBe('This diagram')
  })

  it('a read-only diagram declines without touching the canvas', () => {
    const h = host(true)
    expect(insertSnippetIntoDiagram(h, snippetOf(body()), 'duplicate')).toBe(false)
    expect(diagramSnippetTarget('r1', 'Flow', h).insert(snippetOf(body()), 'duplicate')).toBe(false)
    expect(h.insertBody).not.toHaveBeenCalled()
  })

  it('declines live, and a body of another kind', () => {
    const h = host()
    expect(insertSnippetIntoDiagram(h, snippetOf(body()), 'live')).toBe(false)
    const doc = { ...snippetOf(body()), kind: 'doc', body: { kind: 'doc', content: [{}], text: 'x' } } as unknown as Snippet
    expect(insertSnippetIntoDiagram(h, doc, 'duplicate')).toBe(false)
    expect(h.insertBody).not.toHaveBeenCalled()
  })

  it('an editable diagram inserts the body and reports what the host did', () => {
    const h = host()
    const b = body()
    expect(insertSnippetIntoDiagram(h, snippetOf(b), 'duplicate')).toBe(true)
    expect(h.insertBody).toHaveBeenCalledWith(b)
    const refusing: DiagramSnippetHost = { readOnly: false, insertBody: () => false }
    expect(insertSnippetIntoDiagram(refusing, snippetOf(b), 'duplicate')).toBe(false)
  })
})
