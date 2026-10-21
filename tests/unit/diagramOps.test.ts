import { describe, expect, it } from 'vitest'
import {
  assignContainers,
  copySelection,
  deleteSelection,
  descendants,
  duplicate,
  expandGroups,
  flip,
  group,
  isClip,
  matchSize,
  nudge,
  pasteClip,
  placeBelow,
  patchStyle,
  reorder,
  rotateBy,
  selectAll,
  setLocked,
  slotBeside,
  ungroup,
  type Graph
} from '../../src/shared/diagram/ops'
import type { MapNode } from '../../src/shared/types'

const n = (id: string, x = 0, y = 0, extra: Partial<MapNode> = {}): MapNode => ({ id, x, y, label: id, shape: 'process', color: '#000', ...extra })
const graph = (): Graph => ({
  nodes: [n('lane', 0, 0, { shape: 'lane', width: 600, height: 300 }), n('a', 50, 50, { parentId: 'lane' }), n('b', 300, 50), n('c', 300, 200, { locked: true })],
  edges: [
    { id: 'ab', source: 'a', target: 'b' },
    { id: 'bc', source: 'b', target: 'c' }
  ]
})
const sel = (nodes: string[] = [], edges: string[] = []) => ({ nodes: new Set(nodes), edges: new Set(edges) })

describe('ops', () => {
  it('delete removes children of deleted containers and orphan edges, keeps locked', () => {
    const g = deleteSelection(graph(), sel(['lane', 'c']))
    expect(g.nodes.map((x) => x.id)).toEqual(['b', 'c'])
    expect(g.edges.map((e) => e.id)).toEqual(['bc'])
  })
  it('copy includes contained children; paste remaps ids, edges, parents and groups', () => {
    const g0 = group(graph(), new Set(['a', 'b'])).graph
    const clip = copySelection(g0, sel(['lane', 'b']))
    expect(isClip(clip)).toBe(true)
    expect(clip.nodes.map((x) => x.id).sort()).toEqual(['a', 'b', 'lane'])
    expect(clip.edges.map((e) => e.id)).toEqual(['ab'])
    const { graph: g, sel: s } = pasteClip(g0, clip, { x: 10, y: 20 })
    expect(g.nodes).toHaveLength(7)
    const pasted = g.nodes.filter((x) => s.nodes.has(x.id))
    const pa = pasted.find((x) => x.label === 'a')!
    const plane = pasted.find((x) => x.label === 'lane')!
    expect(pa.parentId).toBe(plane.id)
    expect(pa.x).toBe(60)
    expect(pa.groupId).toBeTruthy()
    expect(pa.groupId).not.toBe(g0.nodes.find((x) => x.id === 'a')!.groupId)
    const pe = g.edges.find((e) => s.edges.has(e.id))!
    expect(pasted.map((x) => x.id)).toContain(pe.source)
  })
  it('duplicate offsets and unlocks copies', () => {
    const { graph: g, sel: s } = duplicate(graph(), sel(['c']))
    const copy = g.nodes.find((x) => s.nodes.has(x.id))!
    expect(copy.x).toBe(320)
    expect(copy.locked).toBeUndefined()
  })
  it('z-order moves keep relative order', () => {
    const ids = (g: Graph) => g.nodes.map((x) => x.id).join('')
    const g = graph()
    expect(ids(reorder(g, new Set(['lane']), 'front'))).toBe('abclane')
    expect(ids(reorder(g, new Set(['c']), 'back'))).toBe('clanea' + 'b')
    expect(ids(reorder(g, new Set(['a']), 'forward'))).toBe('laneba' + 'c')
    expect(ids(reorder(g, new Set(['b']), 'backward'))).toBe('lanebac')
  })
  it('groups expand selection; ungroup clears', () => {
    const { graph: g } = group(graph(), new Set(['a', 'b']))
    expect([...expandGroups(g, ['a'])].sort()).toEqual(['a', 'b'])
    expect(ungroup(g, new Set(['b'])).nodes.every((x) => !x.groupId)).toBe(true)
    expect(group(graph(), new Set(['a'])).groupId).toBeNull()
  })
  it('lock, nudge (carrying children, skipping locked), flip, rotate, style, match size', () => {
    let g = setLocked(graph(), sel(['b'], ['ab']), true)
    expect(g.nodes.find((x) => x.id === 'b')!.locked).toBe(true)
    expect(g.edges.find((e) => e.id === 'ab')!.locked).toBe(true)
    g = nudge(graph(), new Set(['lane', 'c']), 5, 0)
    expect(g.nodes.find((x) => x.id === 'a')!.x).toBe(55)
    expect(g.nodes.find((x) => x.id === 'c')!.x).toBe(300)
    expect(flip(graph(), new Set(['a']), 'x').nodes.find((x) => x.id === 'a')!.flipX).toBe(true)
    expect(rotateBy(graph(), new Set(['a']), -90).nodes.find((x) => x.id === 'a')!.rotation).toBe(270)
    expect(rotateBy(graph(), new Set(['a']), 360).nodes.find((x) => x.id === 'a')!.rotation).toBeUndefined()
    const st = patchStyle(patchStyle(graph(), new Set(['a']), { bold: true, fill: '#fff' }), new Set(['a']), { fill: undefined })
    expect(st.nodes.find((x) => x.id === 'a')!.style).toEqual({ bold: true })
    const m = matchSize(graph(), ['lane', 'b'], 'width')
    expect(m.nodes.find((x) => x.id === 'b')!.width).toBe(600)
  })
  it('containers: smallest fully-containing container becomes the parent', () => {
    let g = graph()
    g = { ...g, nodes: g.nodes.map((x) => (x.id === 'b' ? { ...x, x: 100, y: 100 } : x)) }
    g = assignContainers(g, ['b', 'a'])
    expect(g.nodes.find((x) => x.id === 'b')!.parentId).toBe('lane')
    g = { ...g, nodes: g.nodes.map((x) => (x.id === 'a' ? { ...x, x: 900 } : x)) }
    g = assignContainers(g, ['a'])
    expect(g.nodes.find((x) => x.id === 'a')!.parentId).toBeUndefined()
    expect([...descendants(g, ['lane'])]).toEqual(['b'])
  })
  it('selectAll skips hidden layers; slotBeside avoids occupied space', () => {
    const g: Graph = { ...graph(), layers: [{ id: 'L', name: 'x', visible: false, locked: false }] }
    g.nodes[3] = { ...g.nodes[3]!, layerId: 'L' }
    expect([...selectAll(g).nodes]).not.toContain('c')
    const p = slotBeside(graph(), graph().nodes[2]!, 'down', { w: 120, h: 48 })
    // straight down from b is c's spot; it slides sideways instead
    expect(p.x).not.toBe(300)
  })

  it('placeBelow drops an inserted batch into clear space under the page', () => {
    const existing = graph().nodes
    const batch = [n('x', 0, 0), n('y', 180, 0)]
    const placed = placeBelow(existing, batch)
    // lane spans y 0..300 (the tallest); the batch starts 60 below it, left-aligned
    expect(placed.map((p) => [p.x, p.y])).toEqual([
      [0, 360],
      [180, 360]
    ])
    // relative layout is kept, and an empty page leaves the batch alone
    expect(placeBelow([], batch)).toBe(batch)
  })
})
