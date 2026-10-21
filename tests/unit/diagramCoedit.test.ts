// Live co-editing of a PlexiiDiagrams document goes through the id-keyed
// reconcile (yjsKeyedJson, built for PlexiiDraw in add0c824). A diagram is lists
// of things with ids: nodes (z-ordered, so "bring to front" reorders them),
// edges, layers and pages. Index alignment smeared one shape's fields onto
// another under a reorder or a mid-list delete; these pin that it no longer can.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { yToJson } from '@renderer/lib/yjsJson'
import { reconcileMapKeyed } from '@renderer/lib/yjsKeyedJson'
import type { MapBody, MapEdge, MapNode } from '../../src/shared/types'

const nd = (id: string, color: string, x: number, extra: Partial<MapNode> = {}): MapNode => ({ id, x, y: 0, label: id.toUpperCase(), shape: 'process', color, ...extra })
const ed = (id: string, source: string, target: string, label: string): MapEdge => ({ id, source, target, label })
const body = (nodes: MapNode[], edges: MapEdge[] = []): MapBody => ({ version: 1, nodes, edges })

function set(doc: Y.Doc, b: MapBody): void {
  Y.transact(doc, () => reconcileMapKeyed(doc.getMap('root'), b as unknown as Record<string, unknown>))
}
const get = (doc: Y.Doc): MapBody => yToJson(doc.getMap('root')) as MapBody
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
}
function pair(start: MapBody): [Y.Doc, Y.Doc] {
  const A = new Y.Doc()
  const B = new Y.Doc()
  set(A, start)
  sync(A, B)
  return [A, B]
}

describe('diagram co-editing reconciles by id', () => {
  const start = body([nd('a', '#ef4444', 0), nd('b', '#22c55e', 200), nd('c', '#3b82f6', 400)], [ed('ab', 'a', 'b', 'yes'), ed('bc', 'b', 'c', 'no')])

  it('bring-to-front in one window + recolour in another: each shape keeps its own fields', () => {
    const [A, B] = pair(start)
    // A brings `a` to the front (end of the z-order list).
    set(A, body([nd('b', '#22c55e', 200), nd('c', '#3b82f6', 400), nd('a', '#ef4444', 0)], start.edges))
    // B recolours `b`.
    set(B, body([nd('a', '#ef4444', 0), nd('b', '#a855f7', 200), nd('c', '#3b82f6', 400)], start.edges))
    sync(A, B)
    for (const doc of [A, B]) {
      const byId = Object.fromEntries(get(doc).nodes.map((n) => [n.id, n]))
      expect(byId.b!.color).toBe('#a855f7') // B's edit landed on b
      expect(byId.a!.color).toBe('#ef4444') // and on nothing else
      expect(byId.c!.color).toBe('#3b82f6')
      expect(byId.a!.x).toBe(0)
      expect(get(doc).nodes.map((n) => n.id)).toEqual(['b', 'c', 'a'])
    }
  })

  it('deleting a line mid-list in one window + relabelling another: labels stay on their own lines', () => {
    const three = body(start.nodes, [ed('ab', 'a', 'b', 'yes'), ed('bc', 'b', 'c', 'no'), ed('ca', 'c', 'a', 'maybe')])
    const [A, B] = pair(three)
    set(A, body(three.nodes, [ed('ab', 'a', 'b', 'yes'), ed('ca', 'c', 'a', 'maybe')])) // delete bc
    set(B, body(three.nodes, [ed('ab', 'a', 'b', 'yes'), ed('bc', 'b', 'c', 'no'), ed('ca', 'c', 'a', 'later')])) // relabel ca
    sync(A, B)
    for (const doc of [A, B]) {
      const edges = get(doc).edges
      expect(edges.map((e) => e.id)).toEqual(['ab', 'ca'])
      expect(edges.find((e) => e.id === 'ca')!.label).toBe('later')
      expect(edges.find((e) => e.id === 'ca')!.source).toBe('c')
    }
  })

  it('id-less lists (waypoints, table cells) still align by position', () => {
    const withLists = body([nd('t', '#000', 0, { shape: 'table', cells: [['h1', 'h2'], ['1', '2']] })], [{ ...ed('e', 't', 't', ''), waypoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }])
    const [A] = pair(withLists)
    set(A, body([nd('t', '#000', 0, { shape: 'table', cells: [['h1', 'H2'], ['1', '2']] })], [{ ...ed('e', 't', 't', ''), waypoints: [{ x: 1, y: 2 }, { x: 5, y: 6 }] }]))
    const got = get(A)
    expect(got.nodes[0]!.cells).toEqual([['h1', 'H2'], ['1', '2']])
    expect(got.edges[0]!.waypoints).toEqual([{ x: 1, y: 2 }, { x: 5, y: 6 }])
  })

  it('the live editor routes diagrams through the keyed reconcile', () => {
    const src = readFileSync(join(__dirname, '../../src/renderer/src/components/views/LiveDocEditorView.tsx'), 'utf-8')
    expect(src).toContain("meta.docType === 'draw' || meta.docType === 'map' ? reconcileMapKeyed : reconcileMap")
  })
})

// Undo in a shared diagram reverses YOUR steps only. The editor used to undo by
// restoring a whole local snapshot, which reconciled over the shared document
// and reverted a collaborator's concurrent edit. Live documents now pass the
// editor createLiveUndo (as PlexiiDraw does); its step boundaries are marked
// when the editor flushes a new step (History.record returning true).
describe('diagram undo in a shared document', () => {
  it('undo reverses only my last step, keeping a collaborator’s edit made after it', async () => {
    const { createLiveUndo } = await import('@renderer/lib/yjsKeyedJson')
    const LOCAL = {}
    const A = new Y.Doc()
    const B = new Y.Doc()
    const write = (doc: Y.Doc, b: MapBody, origin?: unknown): void =>
      Y.transact(doc, () => reconcileMapKeyed(doc.getMap('root'), b as unknown as Record<string, unknown>), origin)
    write(A, body([nd('a', '#ef4444', 0), nd('b', '#22c55e', 200)]))
    sync(A, B)
    const undo = createLiveUndo(A.getMap('root'), LOCAL)
    // My step 1: move a.  (editor: History.record -> new step -> checkpoint)
    undo.checkpoint()
    write(A, body([nd('a', '#ef4444', 50), nd('b', '#22c55e', 200)]), LOCAL)
    // My step 2: recolour a.
    undo.checkpoint()
    write(A, body([nd('a', '#000000', 50), nd('b', '#22c55e', 200)]), LOCAL)
    sync(A, B)
    // The collaborator then recolours b.
    write(B, body([nd('a', '#000000', 50), nd('b', '#a855f7', 200)]))
    sync(A, B)
    undo.undo()
    sync(A, B)
    for (const doc of [A, B]) {
      const byId = Object.fromEntries(get(doc).nodes.map((n) => [n.id, n]))
      expect(byId.a!.color).toBe('#ef4444') // my step 2 reversed
      expect(byId.a!.x).toBe(50) // my step 1 kept
      expect(byId.b!.color).toBe('#a855f7') // their edit untouched
    }
    undo.undo()
    expect(Object.fromEntries(get(A).nodes.map((n) => [n.id, n])).a!.x).toBe(0)
    undo.redo()
    expect(Object.fromEntries(get(A).nodes.map((n) => [n.id, n])).a!.x).toBe(50)
  })

  it('History.record says when a new step begins, which is where the boundary goes', async () => {
    const { History } = await import('../../src/shared/diagram/history')
    const h = new History<{ n: number }>()
    expect(h.record({ n: 1 }, undefined, 0)).toBe(true)
    expect(h.record({ n: 2 }, 'type', 10)).toBe(true)
    expect(h.record({ n: 3 }, 'type', 20)).toBe(false) // coalesced typing
    expect(h.record({ n: 3 }, undefined, 30)).toBe(true)
    expect(h.record({ n: 3 }, undefined, 40)).toBe(false) // nothing changed
  })

  it('the live editor hands diagrams the own-change undo, and the editor uses it', () => {
    const live = readFileSync(join(__dirname, '../../src/renderer/src/components/views/LiveDocEditorView.tsx'), 'utf-8')
    expect(live).toContain("meta.docType === 'draw' || meta.docType === 'map' ? createLiveUndo(root, LOCAL) : null")
    expect(live).toMatch(/<MapEditor[^>]*liveUndo=\{drawUndo \?\? undefined\}/)
    const cmds = readFileSync(join(__dirname, '../../src/renderer/src/components/documents/diagram/commands.ts'), 'utf-8')
    expect(cmds).toContain('live.undo()')
    expect(cmds).toContain('live.redo()')
    const ed = readFileSync(join(__dirname, '../../src/renderer/src/components/documents/diagram/DiagramEditor.tsx'), 'utf-8')
    expect(ed).toContain('history.current.record(b, key)) stepBoundary()')
  })
})
