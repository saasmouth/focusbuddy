// Which anchors may be written back, and as what.
//
// The rule guarded here is the one place in viewer comments where getting it
// wrong is a SILENT, PERMANENT data loss rather than a visual glitch: writing a
// live document's anchor back as a local one replaces its Yjs relative
// positions with plain offsets. Relative positions are the entire reason a live
// anchor survives other people typing; offsets go stale the moment any peer
// inserts before them, and nothing tells the other peers it happened.
//
// And it is not an edge case. A yjs anchor that resolved by its quote comes
// back `corrected` as a matter of course, so a host without this rule would
// convert every live comment into a fragile one the first time anyone opened
// the document.

import { describe, it, expect } from 'vitest'
import { anchorToPersist } from '../../src/renderer/src/components/documents/editor/commentWriteBack'

const DOC = 'Hello brave new world'
// "brave" sits at 6..11 in that string.
const BRAVE = { from: 6, to: 11 }

const localAnchor = (from: number, to: number, text: string): string =>
  JSON.stringify({ kind: 'local', from, to, quote: { text } })

const yjsAnchor = (text: string): string =>
  JSON.stringify({ kind: 'yjs', start: { a: 1 }, end: { b: 2 }, quote: { text } })

describe('a live document\'s anchor is never written back', () => {
  it('refuses a yjs anchor even when the range moved to real text', () => {
    // THE RULE. Its relative positions must survive, and this is the only
    // thing standing between them and a one-way conversion to offsets.
    //
    // The range is DELIBERATELY one with text under it and a quote that does
    // not match. A first version used an out-of-range range, which the requote
    // rejects on its own — so the test passed with the yjs guard DELETED and
    // was proving nothing about the rule it names.
    const out = anchorToPersist({ id: 't1', anchor: yjsAnchor('world') }, BRAVE, DOC)
    expect(out).toBeNull()
  })

  it('refuses a yjs anchor whose quote no longer matches either', () => {
    // The commonest shape: no binding, so the resolver found it by quote and
    // reported it corrected. Routine, and still not a reason to write.
    const out = anchorToPersist({ id: 't1', anchor: yjsAnchor('gone') }, BRAVE, DOC)
    expect(out).toBeNull()
  })
})

describe('a thread with nothing stored is left alone', () => {
  it('refuses when the anchor is null — an old mark-anchored comment', () => {
    // Those comments are fine and keep their CommentMark highlight. Giving one
    // an anchor behind the user's back would be inventing data.
    expect(anchorToPersist({ id: 't1', anchor: null }, BRAVE, DOC)).toBeNull()
  })

  it('refuses when the anchor is unparseable rubbish', () => {
    expect(anchorToPersist({ id: 't1', anchor: 'not json' }, BRAVE, DOC)).toBeNull()
    expect(anchorToPersist({ id: 't1', anchor: '{"kind":"weird"}' }, BRAVE, DOC)).toBeNull()
  })
})

describe('a local anchor is written back only when something changed', () => {
  it('writes when the resolver re-found the text elsewhere', () => {
    const out = anchorToPersist({ id: 't1', anchor: localAnchor(0, 5, 'brave') }, BRAVE, DOC)
    expect(out).not.toBeNull()
    expect(out!.reason).toBe('moved')
    const stored = JSON.parse(out!.json) as { kind: string; from: number; to: number; quote: { text: string } }
    expect(stored.kind).toBe('local')
    expect(stored.from).toBe(6)
    expect(stored.to).toBe(11)
    // The quote comes from the text, not from what was stored — that is the
    // whole point of refreshing it.
    expect(stored.quote.text).toBe('brave')
  })

  it('writes when the range is the same but the text under it was edited', () => {
    // Someone comments "fix this typo", the typo gets fixed, and the stored
    // quote no longer describes the passage. Without this the thread orphans
    // on the next open even though its text is right there.
    const out = anchorToPersist({ id: 't1', anchor: localAnchor(6, 11, 'brvae') }, BRAVE, DOC)
    expect(out).not.toBeNull()
    expect(out!.reason).toBe('requoted')
    expect((JSON.parse(out!.json) as { quote: { text: string } }).quote.text).toBe('brave')
  })

  it('writes NOTHING when the range and the quote both still hold', () => {
    // A write per thread per open otherwise — and on a live document an HTTP
    // request most readers are not even permitted to make.
    expect(anchorToPersist({ id: 't1', anchor: localAnchor(6, 11, 'brave') }, BRAVE, DOC)).toBeNull()
  })

  it('keeps the stored anchor when there is no text under the range at all', () => {
    // The comment will orphan on the next open, which is the truth. Writing a
    // quoteless anchor would destroy the only means of ever finding it again.
    const out = anchorToPersist({ id: 't1', anchor: localAnchor(6, 11, 'brave') }, { from: 9999, to: 10000 }, DOC)
    expect(out).toBeNull()
  })
})
