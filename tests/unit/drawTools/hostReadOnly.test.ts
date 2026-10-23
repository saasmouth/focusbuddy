// PlexiiDraw gets a read-only the HOST can set.
//
// The studio already enforced read-only centrally — history.commit, the command
// runner, tool selection and the key handler all check `state.readOnly` — but
// derived it from the DRAWING's own compatibility alone (made by a newer
// PlexiiDraw: shown, never written). So a viewer of a shared drawing could not
// be told: they were handed a full studio, drew, and the server dropped it.
//
// The case worth a test of its own is `fold`. It recomputes compatibility when
// a co-editing peer's body arrives, and recomputing readOnly from compatibility
// alone turned a viewer's studio writable the first time anybody else typed —
// silently, and only in a live session, which is the one place it matters.

import { describe, it, expect } from 'vitest'
import { harness } from './harness'
import type { DrawDoc } from '../../../src/shared/draw/model'

/**
 * A document declaring a schema no build of ours can write. The field is
 * `schemaVersion` — `schema: 99` parses as a document with no declaration at
 * all and is perfectly writable, which is why the test below asserts the
 * fixture is unwritable before it measures anything.
 */
function fromTheFuture(): unknown {
  return {
    schemaVersion: 99,
    minWriterVersion: 99,
    artboards: [{ id: 'a1', x: 0, y: 0, w: 400, h: 300, name: 'Artboard 1' }],
    layers: []
  }
}

describe('a host can make PlexiiDraw read-only', () => {
  it('drawing writes nothing and creates nothing', () => {
    const h = harness(undefined, { readOnly: true })
    expect(h.state().readOnly).toBe(true)
    expect(h.state().hostReadOnly).toBe(true)
    h.tool('rect')
    h.drag([20, 30], [120, 90])
    expect(h.objects(), 'no shape was created').toHaveLength(0)
    expect(h.emitted, 'and nothing was handed to the host').toHaveLength(0)
    expect(h.state().past, 'nor pushed onto the undo stack').toHaveLength(0)
  })

  it('commands and the keyboard write nothing', () => {
    const h = harness(undefined, { readOnly: true })
    h.run('object.delete')
    h.run('edit.paste')
    h.run('object.group')
    h.key('Delete')
    h.key('z', { meta: true })
    h.key('v', { meta: true })
    expect(h.emitted).toHaveLength(0)
  })

  it("STAYS read-only when a peer's body folds in — the silent one", () => {
    const h = harness(undefined, { readOnly: true })
    // A co-editor adds a rectangle; their merged body arrives here.
    const peer = harness()
    peer.tool('rect')
    peer.drag([10, 10], [60, 60])
    const theirDoc = peer.doc() as DrawDoc
    expect(peer.objects()).toHaveLength(1)

    h.ed.fold(theirDoc)
    expect(h.state().readOnly, 'folding must not grant write access').toBe(true)
    expect(h.state().hostReadOnly).toBe(true)
    // And it is still enforced afterwards, which is the part that was broken.
    h.tool('ellipse')
    h.drag([100, 100], [160, 160])
    expect(h.emitted).toHaveLength(0)
    expect(h.objects(), "the peer's shape is there, and only theirs").toHaveLength(1)
  })

  it('the drawing’s own compatibility still wins when the host allows writing', () => {
    // Granting write access must not make a newer-format drawing writable: the
    // two causes are OR'd, not replaced.
    const h = harness(fromTheFuture(), { readOnly: false })
    expect(h.state().compat.readOnly, 'the fixture really is unwritable').toBe(true)
    expect(h.state().readOnly).toBe(true)
    expect(h.state().hostReadOnly).toBe(false)
    h.tool('rect')
    h.drag([20, 30], [120, 90])
    expect(h.emitted).toHaveLength(0)
  })

  it('control: the same drag in a writable studio DOES emit', () => {
    const h = harness()
    expect(h.state().readOnly).toBe(false)
    h.tool('rect')
    h.drag([20, 30], [120, 90])
    expect(h.objects()).toHaveLength(1)
    expect(h.emitted.length).toBeGreaterThan(0)
  })
})
