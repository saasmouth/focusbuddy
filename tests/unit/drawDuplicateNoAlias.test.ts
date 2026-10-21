// Duplicate must never leave two shapes sharing one paint object. A shallow copy
// in cloneWithNewIds did: the duplicate held the original's fill by reference,
// the IPC payload check saw that object twice and refused documents:update as
// "cyclic data", so Edit > Duplicate broke every later save of the drawing
// (4.3.39-local.6).
import { describe, expect, it } from 'vitest'
import { checkArgs } from '../../src/main/ipc/contracts'
import { shapePath, solid, vectorLayer, type DrawBody } from '../../src/shared/draw'
import { v1ToV2, v2ToV1 } from '../../src/shared/draw/migrate'
import { duplicateObjects } from '../../src/shared/draw/ops/objects'

function body(objects: unknown[]): DrawBody {
  const l = vectorLayer('L1')
  l.id = 'L1'
  l.objects = objects as never
  return { schemaVersion: 1, width: 500, height: 500, background: solid('#fff'), layers: [l], activeLayerId: 'L1' }
}

const rect = (id: string) => ({ id, type: 'path', path: shapePath('rect', { x: 0, y: 0, w: 10, h: 10 }), fill: solid('#000'), shapeKind: 'rect' })

/** Every object reachable from `v`, by identity. */
function objectsIn(v: unknown, out = new Set<object>()): Set<object> {
  if (v && typeof v === 'object' && !out.has(v)) {
    out.add(v)
    for (const x of Object.values(v)) objectsIn(x, out)
  }
  return out
}

describe('Draw duplicate shares nothing with the original', () => {
  it('a duplicated shape owns its own paint and geometry objects', () => {
    const { doc, newIds } = duplicateObjects(v1ToV2(body([rect('a')])), ['a'])
    const [orig, copy] = (doc.layers[0] as { objects: { id: string }[] }).objects
    expect(copy.id).toBe(newIds[0])
    const shared = [...objectsIn(copy)].filter((o) => objectsIn(orig).has(o))
    expect(shared).toEqual([])
  })

  it('a duplicated group shares nothing either, at any depth', () => {
    const group = { id: 'g', type: 'group', children: [rect('a'), rect('b')] }
    const { doc } = duplicateObjects(v1ToV2(body([group])), ['g'])
    const [orig, copy] = (doc.layers[0] as { objects: object[] }).objects
    expect([...objectsIn(copy)].filter((o) => objectsIn(orig).has(o))).toEqual([])
  })

  it('the drawing still saves after Duplicate (the documents:update payload is accepted)', () => {
    const { doc } = duplicateObjects(v1ToV2(body([rect('a')])), ['a'])
    expect(checkArgs([{ kind: 'string' }, { kind: 'any' }], ['doc-id', { body: v2ToV1(doc) }])).toBeNull()
  })
})
