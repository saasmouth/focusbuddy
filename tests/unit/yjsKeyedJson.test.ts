import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { reconcileMap, yToJson } from '@renderer/lib/yjsJson'
import { createLiveUndo, reconcileMapKeyed } from '@renderer/lib/yjsKeyedJson'

// Live co-editing of a drawing (GAP-MATRIX bugs 7 and 9).
//
// Bug 7: the index-aligned reconcile treated a z-ordered list of shapes like a
// grid. A reorder or a mid-list delete in one window, merged with an edit in
// another, blended two objects' fields into one. The keyed reconcile matches
// objects by id.
//
// Bug 9: undo restored a whole local snapshot, which then reconciled over the
// shared document and reverted a collaborator's concurrent edit. The own-change
// stack (Y.UndoManager on the local origin) only ever reverses your own steps.

type Reconcile = (map: Y.Map<unknown>, obj: Record<string, unknown>) => void
type Obj = { id: string; fill: string; x: number }
type Body = { layers: Array<{ id: string; objects: Obj[] }> }

function setBody(doc: Y.Doc, body: Body, reconcile: Reconcile, origin?: unknown): void {
  Y.transact(doc, () => reconcile(doc.getMap('root'), body as unknown as Record<string, unknown>), origin)
}
function getBody(doc: Y.Doc): Body {
  return yToJson(doc.getMap('root')) as Body
}
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
}
const o = (id: string, fill: string, x: number): Obj => ({ id, fill, x })
const base = (): Body => ({ layers: [{ id: 'L1', objects: [o('a', 'red', 0), o('b', 'green', 10), o('c', 'blue', 20)] }] })
const objs = (b: Body): Obj[] => b.layers[0].objects

/** The scenario from the audit: A brings `a` to the front while B recolours `b`. */
function reorderVsRecolour(reconcile: Reconcile): { A: Body; B: Body } {
  const A = new Y.Doc()
  const B = new Y.Doc()
  setBody(A, base(), reconcile)
  sync(A, B)
  setBody(A, { layers: [{ id: 'L1', objects: [o('b', 'green', 10), o('c', 'blue', 20), o('a', 'red', 0)] }] }, reconcile)
  setBody(B, { layers: [{ id: 'L1', objects: [o('a', 'red', 0), o('b', 'PURPLE', 10), o('c', 'blue', 20)] }] }, reconcile)
  sync(A, B)
  return { A: getBody(A), B: getBody(B) }
}

describe('keyed reconcile — objects are matched by id, never by position', () => {
  it('the OLD index-aligned engine blends objects under reorder + recolour (the bug, kept as a witness)', () => {
    const { A } = reorderVsRecolour(reconcileMap)
    // Slot 0 now holds `b`'s id after the reorder, and B's recolour landed on
    // whatever map sits in slot 1 -- not on object `b`. Either `b` lost its
    // colour or some other object gained it.
    const b = objs(A).find((x) => x.id === 'b')
    const blended = b?.fill !== 'PURPLE' || objs(A).some((x) => x.id !== 'b' && x.fill === 'PURPLE')
    expect(blended).toBe(true)
  })

  it('reorder in one window + recolour in the other converge with no blending', () => {
    const { A, B } = reorderVsRecolour(reconcileMapKeyed)
    expect(A).toEqual(B)
    expect(objs(A).map((x) => x.id)).toEqual(['b', 'c', 'a'])
    expect(objs(A)).toEqual([o('b', 'PURPLE', 10), o('c', 'blue', 20), o('a', 'red', 0)])
  })

  it('a delete in A while B edits a LATER object leaves B\'s edit on the right object', () => {
    const A = new Y.Doc()
    const B = new Y.Doc()
    setBody(A, base(), reconcileMapKeyed)
    sync(A, B)
    setBody(A, { layers: [{ id: 'L1', objects: [o('b', 'green', 10), o('c', 'blue', 20)] }] }, reconcileMapKeyed)
    setBody(B, { layers: [{ id: 'L1', objects: [o('a', 'red', 0), o('b', 'green', 10), o('c', 'blue', 999)] }] }, reconcileMapKeyed)
    sync(A, B)
    expect(getBody(A)).toEqual(getBody(B))
    expect(objs(getBody(A))).toEqual([o('b', 'green', 10), o('c', 'blue', 999)])
  })

  it('two people adding shapes at once both keep their shape', () => {
    const A = new Y.Doc()
    const B = new Y.Doc()
    setBody(A, base(), reconcileMapKeyed)
    sync(A, B)
    setBody(A, { layers: [{ id: 'L1', objects: [...objs(base()), o('fromA', 'black', 1)] }] }, reconcileMapKeyed)
    setBody(B, { layers: [{ id: 'L1', objects: [...objs(base()), o('fromB', 'white', 2)] }] }, reconcileMapKeyed)
    sync(A, B)
    expect(getBody(A)).toEqual(getBody(B))
    expect(objs(getBody(A)).map((x) => x.id).sort()).toEqual(['a', 'b', 'c', 'fromA', 'fromB'])
  })

  it('an unchanged object keeps its Yjs identity across a reorder of others (only movers are re-inserted)', () => {
    const d = new Y.Doc()
    setBody(d, base(), reconcileMapKeyed)
    const arr = ((d.getMap('root').get('layers') as Y.Array<Y.Map<unknown>>).get(0).get('objects')) as Y.Array<Y.Map<unknown>>
    const bMap = arr.get(1)
    const cMap = arr.get(2)
    setBody(d, { layers: [{ id: 'L1', objects: [o('b', 'green', 10), o('c', 'blue', 20), o('a', 'red', 0)] }] }, reconcileMapKeyed)
    expect(arr.get(0)).toBe(bMap)
    expect(arr.get(1)).toBe(cMap)
  })

  it('positional lists (no ids) still reconcile by index', () => {
    const d = new Y.Doc()
    const root = d.getMap('root')
    Y.transact(d, () => reconcileMapKeyed(root, { nodes: [{ x: 1 }, { x: 2 }], dash: [4, 2] }))
    Y.transact(d, () => reconcileMapKeyed(root, { nodes: [{ x: 1 }, { x: 5 }, { x: 7 }], dash: [3] }))
    expect(yToJson(root)).toEqual({ nodes: [{ x: 1 }, { x: 5 }, { x: 7 }], dash: [3] })
  })

  it('a list with duplicate ids falls back to position rather than guessing', () => {
    const d = new Y.Doc()
    const root = d.getMap('root')
    Y.transact(d, () => reconcileMapKeyed(root, { list: [{ id: 'x', v: 1 }, { id: 'x', v: 2 }] }))
    Y.transact(d, () => reconcileMapKeyed(root, { list: [{ id: 'x', v: 3 }, { id: 'x', v: 2 }] }))
    expect(yToJson(root)).toEqual({ list: [{ id: 'x', v: 3 }, { id: 'x', v: 2 }] })
  })
})

describe('own-change undo — undo in A never reverts B', () => {
  function pair(): { A: Y.Doc; B: Y.Doc; LOCAL_A: object } {
    const A = new Y.Doc()
    const B = new Y.Doc()
    const LOCAL_A = {}
    setBody(A, base(), reconcileMapKeyed, LOCAL_A)
    sync(A, B)
    return { A, B, LOCAL_A }
  }

  it('A moves a shape, B recolours another, A undoes: A\'s move is gone, B\'s colour stays', () => {
    const { A, B, LOCAL_A } = pair()
    const undo = createLiveUndo(A.getMap('root'), LOCAL_A)
    undo.checkpoint()
    setBody(A, { layers: [{ id: 'L1', objects: [o('a', 'red', 500), o('b', 'green', 10), o('c', 'blue', 20)] }] }, reconcileMapKeyed, LOCAL_A)
    setBody(B, { layers: [{ id: 'L1', objects: [o('a', 'red', 0), o('b', 'green', 10), o('c', 'ORANGE', 20)] }] }, reconcileMapKeyed)
    sync(A, B)
    expect(undo.canUndo()).toBe(true)
    undo.undo()
    sync(A, B)
    expect(getBody(A)).toEqual(getBody(B))
    expect(objs(getBody(A))).toEqual([o('a', 'red', 0), o('b', 'green', 10), o('c', 'ORANGE', 20)])
    // And redo puts A's own step back, still without touching B's.
    undo.redo()
    sync(A, B)
    expect(objs(getBody(B))).toEqual([o('a', 'red', 500), o('b', 'green', 10), o('c', 'ORANGE', 20)])
  })

  it('a peer edit to the SAME field after A\'s survives A\'s undo', () => {
    const { A, B, LOCAL_A } = pair()
    const undo = createLiveUndo(A.getMap('root'), LOCAL_A)
    setBody(A, { layers: [{ id: 'L1', objects: [o('a', 'YELLOW', 0), o('b', 'green', 10), o('c', 'blue', 20)] }] }, reconcileMapKeyed, LOCAL_A)
    sync(A, B)
    setBody(B, { layers: [{ id: 'L1', objects: [o('a', 'PINK', 0), o('b', 'green', 10), o('c', 'blue', 20)] }] }, reconcileMapKeyed)
    sync(A, B)
    undo.undo()
    sync(A, B)
    expect(objs(getBody(A))[0].fill).toBe('PINK')
  })

  it('steps are delimited by checkpoints, not time: a streamed drag is one step', () => {
    const { A, LOCAL_A } = pair()
    const undo = createLiveUndo(A.getMap('root'), LOCAL_A)
    undo.checkpoint()
    for (let x = 1; x <= 5; x++) setBody(A, { layers: [{ id: 'L1', objects: [o('a', 'red', x * 10), o('b', 'green', 10), o('c', 'blue', 20)] }] }, reconcileMapKeyed, LOCAL_A)
    undo.checkpoint()
    setBody(A, { layers: [{ id: 'L1', objects: [o('a', 'black', 50), o('b', 'green', 10), o('c', 'blue', 20)] }] }, reconcileMapKeyed, LOCAL_A)
    undo.undo()
    expect(objs(getBody(A))[0]).toEqual(o('a', 'red', 50))
    undo.undo()
    expect(objs(getBody(A))[0]).toEqual(o('a', 'red', 0))
    expect(undo.canUndo()).toBe(false)
  })

  it('remote changes are never on the local stack', () => {
    const { A, B, LOCAL_A } = pair()
    const undo = createLiveUndo(A.getMap('root'), LOCAL_A)
    setBody(B, { layers: [{ id: 'L1', objects: [o('a', 'red', 0)] }] }, reconcileMapKeyed)
    sync(A, B)
    expect(undo.canUndo()).toBe(false)
  })

  it('subscribers hear about stack changes; clear forgets every step', () => {
    const { A, LOCAL_A } = pair()
    const undo = createLiveUndo(A.getMap('root'), LOCAL_A)
    let heard = 0
    const off = undo.subscribe(() => heard++)
    setBody(A, { layers: [{ id: 'L1', objects: [o('a', 'red', 1)] }] }, reconcileMapKeyed, LOCAL_A)
    expect(heard).toBeGreaterThan(0)
    undo.clear()
    expect(undo.canUndo()).toBe(false)
    off()
    undo.destroy()
  })
})
