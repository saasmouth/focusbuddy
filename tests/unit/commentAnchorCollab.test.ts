// A comment in a CO-EDITED document, where an offset cannot work.
//
// In a local document a stored range goes stale only when the body is rewritten
// by a path with no transaction to map through, and the quote recovers it. In a
// live document it goes stale the moment any other peer inserts text before it,
// and nothing tells this editor that the comment moved. Worse, the recovery
// that saves the local case is unavailable at the rate it would be needed: a
// re-find is exact-and-unique or nothing, so a document with two similar
// passages would orphan comments during ordinary typing by someone else.
//
// A Yjs RelativePosition references the ITEM rather than a count, so it
// survives concurrent insertion by construction. This file proves that against
// REAL concurrency — two editors, each bound to its own Y.Doc, exchanging
// updates — rather than by editing one document and calling it collaboration.
// The assertion that matters is `status: ok` with NO correction: the anchor was
// believed, not re-found, which is the thing an offset cannot achieve.

import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import { CommentDecorations, commentDecorationsKey } from '../../src/renderer/src/components/documents/editor/CommentDecorations'
import {
  isCollabEditor,
  localAnchorFor,
  positionText,
  resolveForEditor,
  upgradeAnchorForCollab,
  yjsAnchorFor,
  yjsCandidate
} from '../../src/renderer/src/components/documents/editor/commentPositions'

const TEXT = 'The second clause reads twice and should be cut.'

interface Peer {
  editor: Editor
  ydoc: Y.Doc
  host: HTMLDivElement
}

const peers: Peer[] = []

/** One co-editing peer, bound to its own Y.Doc. */
function peer(ydoc: Y.Doc): Peer {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text, Collaboration.configure({ document: ydoc }), CommentDecorations]
  })
  const p = { editor, ydoc, host }
  peers.push(p)
  return p
}

/** Hand every update one peer has to the other, both ways. */
function sync(a: Peer, b: Peer): void {
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)))
  Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)))
}

afterEach(() => {
  for (const p of peers.splice(0)) {
    p.editor.destroy()
    p.host.remove()
    p.ydoc.destroy()
  }
})

const textAt = (p: Peer, from: number, to: number): string => p.editor.state.doc.textBetween(from, to)
const decorated = (p: Peer): { from: number; to: number }[] => {
  const set = commentDecorationsKey.getState(p.editor.state)
  const out: { from: number; to: number }[] = []
  set?.find().forEach((d) => out.push({ from: d.from, to: d.to }))
  return out
}

describe('a live anchor survives what an offset cannot', () => {
  it("another peer's insert BEFORE the comment leaves it believed, not re-found", () => {
    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    const b = peer(new Y.Doc())
    sync(a, b)
    expect(b.editor.state.doc.textBetween(0, b.editor.state.doc.content.size)).toContain('second clause')

    // A anchors a comment on "second clause".
    const at = positionText(a.editor.state.doc).indexOf('second clause')
    const anchor = yjsAnchorFor(a.editor, at, at + 'second clause'.length)
    expect(anchor, 'a collab editor can make a live anchor').not.toBeNull()
    expect(anchor!.kind).toBe('yjs')
    expect(anchor!.quote?.text).toBe('second clause')

    // B, somewhere else entirely, types a whole sentence at the very start.
    b.editor.commands.setTextSelection(1)
    b.editor.commands.insertContent('A new opening sentence was added by somebody else. ')
    sync(a, b)

    // Every offset in A's document has shifted. The anchor has not: the
    // relative positions still point at the same items.
    const candidate = yjsCandidate(a.editor, anchor!)
    expect(candidate).not.toBeNull()
    expect(textAt(a, candidate!.from, candidate!.to)).toBe('second clause')

    const { ranges, orphans } = resolveForEditor(a.editor, [{ id: 'c1', anchor: JSON.stringify(anchor) }])
    expect(orphans).toHaveLength(0)
    expect(ranges[0]!.corrected, 'BELIEVED, not re-found — what an offset cannot do').toBeUndefined()
    a.editor.commands.setCommentRanges(ranges)
    expect(textAt(a, decorated(a)[0]!.from, decorated(a)[0]!.to)).toBe('second clause')

    // And it resolves identically for the OTHER peer, who never saw the
    // anchor being made. A comment that highlighted different words for each
    // reader would be worse than no highlight at all.
    const forB = resolveForEditor(b.editor, [{ id: 'c1', anchor: JSON.stringify(anchor) }])
    expect(forB.ranges[0]!.corrected).toBeUndefined()
    expect(textAt(b, forB.ranges[0]!.from, forB.ranges[0]!.to)).toBe('second clause')
  })

  it('a LOCAL anchor in the same situation has to be re-found — the contrast', () => {
    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    const b = peer(new Y.Doc())
    sync(a, b)
    const at = positionText(a.editor.state.doc).indexOf('second clause')
    const local = localAnchorFor(a.editor, at, at + 'second clause'.length)

    b.editor.commands.setTextSelection(1)
    b.editor.commands.insertContent('A new opening sentence was added by somebody else. ')
    sync(a, b)

    const { ranges } = resolveForEditor(a.editor, [{ id: 'c1', anchor: local }])
    // Still correct, because the quote saved it — but it had to be re-found,
    // and the host now owes a write-back. Do this on every keystroke of every
    // collaborator and the writes never stop, which is the argument for the
    // relative position rather than a preference.
    expect(ranges[0]!.corrected).toBe(true)
    expect(textAt(a, ranges[0]!.from, ranges[0]!.to)).toBe('second clause')
  })

  it('when the commented text is DELETED by another peer the thread orphans, not guesses', () => {
    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    const b = peer(new Y.Doc())
    sync(a, b)
    const at = positionText(a.editor.state.doc).indexOf('second clause')
    const anchor = yjsAnchorFor(a.editor, at, at + 'second clause'.length)!

    // B cuts the whole sentence.
    b.editor.commands.setContent('<p>Something else entirely.</p>')
    sync(a, b)

    const { ranges, orphans } = resolveForEditor(a.editor, [{ id: 'c1', anchor }])
    expect(ranges, 'never a highlight at a guess').toHaveLength(0)
    expect(orphans[0]!.id).toBe('c1')
    expect(orphans[0]!.reason).toBe('missing')
  })

  it('a non-collab editor makes no live anchor rather than one from nowhere', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const plain = new Editor({
      element: host,
      extensions: [Document, Paragraph, Text, CommentDecorations],
      content: `<p>${TEXT}</p>`
    })
    expect(isCollabEditor(plain)).toBe(false)
    expect(yjsAnchorFor(plain, 5, 11)).toBeNull()
    // A yjs anchor opened in such an editor gets no candidate, so the quote
    // decides alone — which still finds it, and says it was re-found.
    const at = positionText(plain.state.doc).indexOf('second clause')
    const faked = {
      kind: 'yjs' as const,
      start: { tname: 'default' },
      end: { tname: 'default' },
      quote: { text: 'second clause' }
    }
    const { ranges } = resolveForEditor(plain, [{ id: 'c1', anchor: faked }])
    expect(ranges[0]!.corrected).toBe(true)
    expect(plain.state.doc.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe('second clause')
    expect(at).toBeGreaterThan(0)
    plain.destroy()
    host.remove()
  })

  it('a malformed live anchor is absent, not a crash in the editor', () => {
    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    expect(isCollabEditor(a.editor)).toBe(true)
    // Everything here has been through a database and an HTTP boundary.
    for (const bad of [{ kind: 'yjs' as const, start: {}, end: {} }, { kind: 'yjs' as const, start: { type: 'nonsense' }, end: {} }]) {
      expect(() => yjsCandidate(a.editor, bad)).not.toThrow()
    }
    const { ranges, orphans } = resolveForEditor(a.editor, [
      { id: 'c1', anchor: { kind: 'yjs', start: {}, end: {} } }
    ])
    expect(ranges).toHaveLength(0)
    expect(orphans[0]!.reason).toBe('missing')
  })
})

// ── Upgrading a local anchor once the room is bound ─────────────────────────
// A live document really does acquire local anchors: yjsAnchorFor returns null
// before the binding exists, so a comment left in the gap between the editor
// mounting and the room syncing is anchored by offsets — which go stale the
// first time another peer types in front of them.

describe('upgradeAnchorForCollab converts only what it has verified', () => {
  it('converts a local anchor that still holds its quote, and the result survives concurrency', () => {
    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    const b = peer(new Y.Doc())
    sync(a, b)

    const at = positionText(a.editor.state.doc).indexOf('second clause')
    const local = localAnchorFor(a.editor, at, at + 'second clause'.length)
    const live = upgradeAnchorForCollab(a.editor, local)
    expect(live?.kind).toBe('yjs')
    expect(live!.quote?.text).toBe('second clause')

    // The thing the upgrade was for: another peer types in front of it, and the
    // upgraded anchor is BELIEVED where the local one would have been re-found.
    b.editor.commands.setTextSelection(1)
    b.editor.commands.insertContent('Another sentence from somebody else. ')
    sync(a, b)
    const { ranges } = resolveForEditor(a.editor, [{ id: 'c1', anchor: live }])
    expect(ranges[0]!.corrected).toBeUndefined()
    expect(textAt(a, ranges[0]!.from, ranges[0]!.to)).toBe('second clause')
  })

  it('converts a DRIFTED anchor at the text it re-found, not at its stale range', () => {
    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    const at = positionText(a.editor.state.doc).indexOf('second clause')
    const local = localAnchorFor(a.editor, at, at + 'second clause'.length)
    // The body gains text in front, by a path with no transaction: the stored
    // range now points at the wrong words.
    a.editor.commands.setContent(`<p>A sentence added in front. ${TEXT}</p>`)
    expect(textAt(a, local.from, local.to)).not.toBe('second clause')

    const live = upgradeAnchorForCollab(a.editor, local)
    expect(live, 'drift is re-found, not refused').not.toBeNull()
    const { ranges } = resolveForEditor(a.editor, [{ id: 'c1', anchor: live }])
    expect(textAt(a, ranges[0]!.from, ranges[0]!.to)).toBe('second clause')
  })

  it('refuses an ORPHAN rather than baking a guess into relative positions', () => {
    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    const at = positionText(a.editor.state.doc).indexOf('second clause')
    const local = localAnchorFor(a.editor, at, at + 'second clause'.length)
    a.editor.commands.setContent('<p>Replaced with something else entirely.</p>')
    expect(upgradeAnchorForCollab(a.editor, local)).toBeNull()
  })

  it('refuses an anchor with NO QUOTE, which is blind by definition', () => {
    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    // Conversion is irreversible — a relative position references an item, so
    // afterwards there is nothing left to check it against. An unverifiable
    // range keeps working as a local anchor instead.
    expect(upgradeAnchorForCollab(a.editor, { kind: 'local', from: 5, to: 18 })).toBeNull()
  })

  it('refuses when there is no binding, and does nothing to an already-live anchor', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const plain = new Editor({
      element: host,
      extensions: [Document, Paragraph, Text, CommentDecorations],
      content: `<p>${TEXT}</p>`
    })
    const at = positionText(plain.state.doc).indexOf('second clause')
    const local = localAnchorFor(plain, at, at + 'second clause'.length)
    expect(upgradeAnchorForCollab(plain, local)).toBeNull()
    plain.destroy()
    host.remove()

    const a = peer(new Y.Doc())
    a.editor.commands.setContent(`<p>${TEXT}</p>`)
    const live = yjsAnchorFor(a.editor, 5, 18)!
    expect(upgradeAnchorForCollab(a.editor, live), 'already live: nothing to convert').toBeNull()
    expect(upgradeAnchorForCollab(a.editor, null)).toBeNull()
    expect(upgradeAnchorForCollab(a.editor, 'not an anchor')).toBeNull()
  })
})
