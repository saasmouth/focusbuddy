// No diagram operation may put one object in a body twice. A shared reference
// means an in-place edit to one shape changes another, and local.6's IPC check
// refused such bodies as "cyclic data" (Draw's Duplicate hit it). Every
// operation that copies or builds is run here against a body rich in nested
// objects, and the result must be a tree.
import { describe, expect, it } from 'vitest'
import { sharedObjectPaths } from '../../src/shared/diagram/sharedRefs'
import * as ops from '../../src/shared/diagram/ops'
import { normalizeBody } from '../../src/shared/diagram/normalize'
import { generateFromTable, type GenerateKind } from '../../src/shared/diagram/data'
import { layoutDiagram } from '../../src/shared/diagram/layout'
import { tidyConnections } from '../../src/shared/diagram/tidy'
import { mermaidToMap, mapToMermaid } from '../../src/shared/diagram/mermaid'
import { drawioToMap, mapToDrawio } from '../../src/shared/diagram/drawio'
import { addPage, getPage } from '../../src/shared/diagram/pages'
import { mapTemplate, type MapTemplateId } from '../../src/renderer/src/components/documents/map/mapTemplates'
import type { FbRow, FbTable } from '../../src/shared/fields'
import type { MapBody, MapEdge, MapNode } from '../../src/shared/types'

const rich = (id: string, x: number, extra: Partial<MapNode> = {}): MapNode => ({
  id,
  x,
  y: 0,
  label: id,
  shape: 'process',
  color: '#2563eb',
  style: { fill: '#fff', bold: true },
  data: { owner: 'Ada' },
  binding: { source: { kind: 'table', tableId: 't', rowId: 'r1' }, rules: [{ columnId: 'c', op: 'eq', value: 'x', fill: '#f00' }] },
  ...extra
})
const graph = (): ops.Graph => ({
  nodes: [rich('a', 0), rich('b', 200), rich('t', 400, { shape: 'table', cells: [['h1', 'h2'], ['1', '2']] }), rich('lane', -50, { shape: 'lane', width: 900, height: 300 })],
  edges: [
    { id: 'ab', source: 'a', target: 'b', label: 'go', waypoints: [{ x: 100, y: 80 }] },
    { id: 'bt', source: 'b', target: 't', waypoints: [{ x: 300, y: 90 }, { x: 350, y: 90 }] }
  ]
})
const all = (g: ops.Graph): Set<string> => new Set(g.nodes.map((n) => n.id))
const tree = (v: unknown): void => expect(sharedObjectPaths(v)).toEqual([])
const sel = (nodes: string[], edges: string[] = []): ops.Sel => ({ nodes: new Set(nodes), edges: new Set(edges) })

describe('sharedObjectPaths', () => {
  it('reports an object reachable by two paths, and passes a tree', () => {
    const style = { fill: '#fff' }
    expect(sharedObjectPaths({ nodes: [{ style }, { style }] })).toEqual(['$.nodes[1].style (first seen at $.nodes[0].style)'])
    expect(sharedObjectPaths(graph())).toEqual([])
  })
})

describe('copying operations produce fresh objects', () => {
  it('duplicate', () => tree(ops.duplicate(graph(), sel(['a', 'b', 't'])).graph))
  it('duplicate twice', () => {
    const g1 = ops.duplicate(graph(), sel(['a'])).graph
    tree(ops.duplicate(g1, sel([g1.nodes[g1.nodes.length - 1]!.id])).graph)
  })
  it('paste the same clipboard twice', () => {
    const g = graph()
    const clip = ops.copySelection(g, sel(['a', 'b']))
    const once = ops.pasteClip(g, clip, { x: 20, y: 20 }).graph
    tree(ops.pasteClip(once, clip, { x: 40, y: 40 }).graph)
  })
  it('a clipboard is not live: editing the pasted copy cannot reach the clip or the original', () => {
    const g = graph()
    const clip = ops.copySelection(g, sel(['a']))
    const pasted = ops.pasteClip(g, clip, { x: 0, y: 0 }).graph
    const copy = pasted.nodes[pasted.nodes.length - 1]!
    expect(copy.style).not.toBe(g.nodes[0]!.style)
    expect(copy.style).not.toBe(clip.nodes[0]!.style)
  })
  it('multi-select patches with object values', () => {
    const g = graph()
    // One patch object for the whole selection, exactly as the inspector's
    // setNodes / setEdges commands pass it.
    const nodePatch = { style: { fill: '#000' }, data: { k: 'v' }, binding: { source: { kind: 'app' as const, appId: 'seg:mail' } } }
    tree(ops.patchNodes(g, all(g), () => nodePatch))
    const edgePatch = { waypoints: [{ x: 1, y: 2 }] }
    tree(ops.patchEdges(g, new Set(['ab', 'bt']), () => edgePatch))
    tree(ops.patchStyle(g, all(g), { fill: '#123456' }))
  })
})

describe('every other body-producing operation stays a tree', () => {
  it('arrange and structure ops', () => {
    const g = graph()
    const ids = all(g)
    tree(ops.group(g, new Set(['a', 'b'])).graph)
    tree(ops.ungroup(ops.group(g, new Set(['a', 'b'])).graph, new Set(['a'])))
    tree(ops.setLocked(g, sel(['a'], ['ab']), true))
    tree(ops.nudge(g, ids, 5, 5))
    tree(ops.reorder(g, new Set(['a']), 'front'))
    tree(ops.flip(g, ids, 'h'))
    tree(ops.rotateBy(g, ids, 90))
    tree(ops.matchSize(g, ids, 'both'))
    tree(ops.assignContainers(g, [...ids]))
    tree(ops.deleteSelection(g, sel(['b'])))
    tree({ nodes: ops.placeBelow(g.nodes, [rich('x', 0), rich('y', 100)]), edges: [] })
  })
  it('layout and tidy', () => {
    const g = graph()
    for (const algorithm of ['layered', 'tree', 'radial', 'grid', 'organic', 'mindmap'] as const) {
      tree({ nodes: layoutDiagram(g.nodes, g.edges, { algorithm, direction: 'TB' }), edges: g.edges })
    }
    const t = tidyConnections(g.nodes, g.edges)
    tree({ nodes: t.nodes, edges: t.edges })
  })
  it('normalize, pages and templates', () => {
    const body: MapBody = { version: 1, ...graph() }
    tree(normalizeBody(body))
    const { body: two } = addPage(body, 'Two', 'p2', graph())
    tree(two)
    // Duplicate page: a fresh, independent copy of a page, layers included.
    tree(addPage(two, 'Copy', 'p3', ops.copyPage({ ...getPage(two, 0), layers: [{ id: 'L1', name: 'One', visible: true, locked: false }] })).body)
    for (const id of ['flowchart', 'orgchart', 'mindmap', 'swimlane'] as MapTemplateId[]) tree(mapTemplate(id))
  })
  it('generate from a table', () => {
    const table: FbTable = {
      id: 'tbl',
      taskId: null,
      title: 'Team',
      createdAt: 0,
      updatedAt: 0,
      schema: { columns: [{ id: 'name', type: 'text-short', label: 'Name', config: {} }, { id: 'boss', type: 'text-short', label: 'Manager', config: {} }] }
    }
    const row = (id: string, cells: Record<string, unknown>): FbRow => ({ id, tableId: 'tbl', cells, sortOrder: 0, createdAt: 0, updatedAt: 0 })
    const rows = [row('r1', { name: 'Ada' }), row('r2', { name: 'Ben', boss: 'Ada' }), row('r3', { name: 'Cy', boss: 'Ada' })]
    for (const kind of ['orgchart', 'flow', 'cards', 'mindmap'] as GenerateKind[]) {
      const out = generateFromTable(table, rows, { kind, linkColumnId: 'boss', fieldColumnIds: ['boss'] })
      tree(out)
    }
  })
  it('imports', () => {
    const m = mermaidToMap('flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| A')
    tree(m)
    const g = graph()
    tree(mermaidToMap(mapToMermaid(g.nodes, g.edges)))
    tree(drawioToMap(mapToDrawio([{ name: 'P', nodes: g.nodes, edges: g.edges as MapEdge[] }])))
  })
})
