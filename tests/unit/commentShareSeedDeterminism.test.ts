// The property that makes share-time anchor conversion possible at all.
//
// When a local document is shared it becomes a live document whose Yjs room is
// EMPTY; the content is poured in later, by whoever opens it first, through
// seedYDocFromPm. So at share time there is no Y.Doc to compute a relative
// position against — and a relative position computed against the wrong Y.Doc
// is worthless, because it names an ITEM by client id and clock.
//
// seedYDocFromPm pins the seeding clientID to a constant, so that two clients
// seeding identical content produce byte-identical items and Yjs merges the
// duplicate seed idempotently instead of doubling the document. That pin was
// put there to stop content doubling. It has a second consequence, which this
// file exists to establish: a THROWAWAY Y.Doc seeded from the same content at
// share time produces the same item ids as the real room will, so relative
// positions computed against the throwaway resolve correctly in the real one.
//
// If this ever stops holding, share-time conversion silently produces anchors
// that resolve nowhere, and every copied comment loses its highlight. So it is
// asserted here rather than relied upon, and asserted by RESOLVING in the other
// document and reading the words back.

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import { initProseMirrorDoc, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap'
import { seedYDocFromPm, COLLAB_FIELD } from '../../src/renderer/src/lib/yjsSeed'
import { buildDocExtensions } from '../../src/renderer/src/components/documents/editor/extensions'

const schema = getSchema(buildDocExtensions({ interactive: false }))

const PM = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The committee resolved to defer the matter.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Second section' }] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First point of order' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second point of order' }] }] }
      ]
    }
  ]
}

/** A Y.Doc seeded exactly the way the live room will be, plus a mapping. */
function seeded(): { ydoc: Y.Doc; frag: Y.XmlFragment; doc: ReturnType<typeof initProseMirrorDoc>['doc']; mapping: Map<unknown, unknown> } {
  const ydoc = new Y.Doc()
  seedYDocFromPm(ydoc, PM, schema)
  const frag = ydoc.getXmlFragment(COLLAB_FIELD)
  const { doc, mapping } = initProseMirrorDoc(frag, schema)
  return { ydoc, frag, doc, mapping: mapping as Map<unknown, unknown> }
}

describe('two independently seeded Y.Docs agree on item identity', () => {
  it('produces byte-identical state, which is what the pinned clientID is for', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    seedYDocFromPm(a, PM, schema)
    seedYDocFromPm(b, PM, schema)
    expect(Array.from(Y.encodeStateAsUpdate(a))).toEqual(Array.from(Y.encodeStateAsUpdate(b)))
  })

  it('a relative position made against one RESOLVES in the other, on the same words', () => {
    const at = seeded()
    const real = seeded()

    // Find a passage in the first, the way share-time conversion will.
    const text = at.doc.textBetween(0, at.doc.content.size, '\n', '\n')
    expect(text).toContain('Second point of order')

    // Convert a range to relative positions against the THROWAWAY document.
    let from = -1
    at.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('Second point of order')) from = pos + node.text.indexOf('Second point of order')
      return true
    })
    expect(from).toBeGreaterThan(0)
    const to = from + 'Second point of order'.length
    expect(at.doc.textBetween(from, to)).toBe('Second point of order')

    const relFrom = absolutePositionToRelativePosition(from, at.frag, at.mapping as never)
    const relTo = absolutePositionToRelativePosition(to, at.frag, at.mapping as never)
    const json = { start: Y.relativePositionToJSON(relFrom), end: Y.relativePositionToJSON(relTo) }

    // Resolve them in the OTHER document — the one the room will actually hold.
    const rf = relativePositionToAbsolutePosition(
      real.ydoc,
      real.frag,
      Y.createRelativePositionFromJSON(json.start),
      real.mapping as never
    )
    const rt = relativePositionToAbsolutePosition(
      real.ydoc,
      real.frag,
      Y.createRelativePositionFromJSON(json.end),
      real.mapping as never
    )
    expect(rf, 'the start resolves in a document it was not made against').not.toBeNull()
    expect(rt).not.toBeNull()
    // The assertion that matters: the WORDS, not the numbers.
    expect(real.doc.textBetween(rf!, rt!)).toBe('Second point of order')
  })

  it('and still resolves after that document is edited in front of the passage', () => {
    const at = seeded()
    const real = seeded()
    let from = -1
    at.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('Second section')) from = pos + node.text.indexOf('Second section')
      return true
    })
    const to = from + 'Second section'.length
    const relFrom = absolutePositionToRelativePosition(from, at.frag, at.mapping as never)
    const relTo = absolutePositionToRelativePosition(to, at.frag, at.mapping as never)

    // Somebody types at the very start of the live document, as a peer would.
    const firstPara = real.frag.get(0) as Y.XmlElement
    const t = firstPara.get(0) as Y.XmlText
    real.ydoc.transact(() => t.insert(0, 'A new opening clause was added here. '))

    // Re-derive the document and mapping, as a reopened editor would.
    const after = initProseMirrorDoc(real.frag, schema)
    const rf = relativePositionToAbsolutePosition(
      real.ydoc,
      real.frag,
      Y.createRelativePositionFromJSON(Y.relativePositionToJSON(relFrom)),
      after.mapping as never
    )
    const rt = relativePositionToAbsolutePosition(
      real.ydoc,
      real.frag,
      Y.createRelativePositionFromJSON(Y.relativePositionToJSON(relTo)),
      after.mapping as never
    )
    expect(after.doc.textBetween(rf!, rt!), 'the anchor followed the text, not the offset').toBe('Second section')
  })
})
