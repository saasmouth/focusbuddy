// Where a comment is, after the document has changed underneath it.
//
// The rule every case here serves: a comment must be drawn in the right place,
// or honestly not drawn. Never in the wrong place. A missing highlight is a
// nuisance; a confidently wrong one attaches a thread to words nobody
// commented on, and reads as if they did.
//
// The cases are the real ways a body changes without a transaction: an AI
// PREPEND that shifts every offset (actionExecutor rebuilds the content
// wholesale), a version-history restore, an MCP write, and a second editor —
// a desk widget saving the same fb_documents row that the Documents view has
// open. The first three were found by 9d's review, the fourth by ec's; I had
// argued a local document has one editor and was wrong.

import { describe, expect, it } from 'vitest'
import {
  QUOTE_MAX,
  clampRange,
  quoteFor,
  readCommentAnchor,
  rebaseLocalAnchor,
  refindQuote,
  resolveAnchor,
  type LocalCommentAnchor
} from '../../src/shared/commentAnchor'

const DOC = 'The quarterly numbers landed on a Tuesday and nobody quite believed them. Revenue had climbed.'
const AT = DOC.indexOf('nobody quite believed them')
const TO = AT + 'nobody quite believed them'.length

const anchored = (): LocalCommentAnchor => ({
  kind: 'local',
  from: AT,
  to: TO,
  quote: quoteFor(DOC, AT, TO)!
})

describe('quoteFor', () => {
  it('stores the text with a little context either side', () => {
    const q = quoteFor(DOC, AT, TO)!
    expect(q.text).toBe('nobody quite believed them')
    expect(q.before).toMatch(/Tuesday and $/)
    expect(q.after).toMatch(/^\. Revenue/)
    expect(q.truncated).toBeUndefined()
  })

  it('caps a long passage rather than storing pages of someone’s document', () => {
    const long = 'word '.repeat(200)
    const q = quoteFor(long, 0, long.length)!
    expect(q.text.length).toBe(QUOTE_MAX)
    expect(q.truncated).toBe(true)
  })

  it('refuses a range with nothing in it', () => {
    expect(quoteFor(DOC, 5, 5)).toBeNull()
    expect(quoteFor('   ', 0, 3)).toBeNull()
  })
})

describe('readCommentAnchor: everything has been through a database', () => {
  it('reads a local and a yjs anchor', () => {
    expect(readCommentAnchor({ kind: 'local', from: 3, to: 9 })).toEqual({ kind: 'local', from: 3, to: 9 })
    const y = readCommentAnchor({ kind: 'yjs', start: { a: 1 }, end: { b: 2 } })
    expect(y?.kind).toBe('yjs')
  })

  it('treats a malformed anchor as absent rather than highlighting an arbitrary span', () => {
    expect(readCommentAnchor(null)).toBeNull()
    expect(readCommentAnchor({ kind: 'local', from: 5 })).toBeNull()
    expect(readCommentAnchor({ kind: 'local', from: -1, to: 4 })).toBeNull()
    expect(readCommentAnchor({ kind: 'local', from: 7, to: 7 })).toBeNull()
    expect(readCommentAnchor({ kind: 'yjs', start: { a: 1 } })).toBeNull()
    expect(readCommentAnchor({ kind: 'martian', from: 1, to: 2 })).toBeNull()
  })

  it('normalises an inverted range, which is a caller’s slip rather than corruption', () => {
    expect(readCommentAnchor({ kind: 'local', from: 9, to: 3 })).toEqual({ kind: 'local', from: 3, to: 9 })
  })
})

describe('rebaseLocalAnchor: the editor that made the edit', () => {
  it('moves both ends through the mapping', () => {
    const out = rebaseLocalAnchor(anchored(), (pos) => pos + 10)!
    expect(out.from).toBe(AT + 10)
    expect(out.to).toBe(TO + 10)
    expect(out.quote).toBeDefined()
  })

  it('reports a collapsed range as lost rather than a point', () => {
    expect(rebaseLocalAnchor(anchored(), () => 4)).toBeNull()
  })
})

describe('resolveAnchor: the body changed with no transaction', () => {
  it('believes an anchor whose text is still there', () => {
    const out = resolveAnchor(anchored(), DOC, { from: AT, to: TO })
    expect(out).toEqual({ status: 'ok', range: { from: AT, to: TO } })
  })

  it('AN AI PREPEND — every offset is short, and the comment still finds its passage', () => {
    // actionExecutor's `prepend` puts new content above everything, so a
    // stored from/to now points at the wrong words. This is the worst case
    // 9d asked to be sure of.
    const added = 'A summary the assistant wrote. '
    const after = added + DOC
    const out = resolveAnchor(anchored(), after, { from: AT, to: TO })
    expect(out.status).toBe('moved')
    if (out.status === 'moved') {
      expect(after.slice(out.range.from, out.range.to)).toBe('nobody quite believed them')
      expect(out.range.from).toBe(AT + added.length)
    }
  })

  it('A SECOND EDITOR — a desk widget typed above the comment, and the highlight is still right', () => {
    // OfficeDocWidget saves the same fb_documents row directly, so this edit
    // never passed through the Documents view's mapping.
    const after = DOC.replace('The quarterly', 'In the end, the quarterly')
    const out = resolveAnchor(anchored(), after, { from: AT, to: TO })
    expect(out.status).toBe('moved')
    if (out.status === 'moved') expect(after.slice(out.range.from, out.range.to)).toBe('nobody quite believed them')
  })

  it('A RESTORE that removed the text — an honest orphan, not a guess', () => {
    const after = 'The quarterly numbers landed on a Tuesday. Revenue had climbed.'
    const out = resolveAnchor(anchored(), after, { from: AT, to: TO })
    expect(out).toEqual({ status: 'orphan', reason: 'missing' })
  })

  it('TWO IDENTICAL PASSAGES with no way to choose — ambiguous, and still not drawn', () => {
    const twice = `${DOC}\n\n${DOC}`
    // Strip the context so neither copy can be told from the other.
    const bare = { kind: 'local' as const, from: AT, to: TO, quote: { text: 'nobody quite believed them' } }
    const out = resolveAnchor(bare, twice, { from: 9999, to: 10_000 })
    expect(out).toEqual({ status: 'orphan', reason: 'ambiguous' })
  })

  it('two identical passages ARE separated by the stored context', () => {
    const twice = `${DOC}\n\nAgain: nobody quite believed them, said nobody.`
    const out = resolveAnchor(anchored(), twice, { from: 9999, to: 10_000 })
    expect(out.status).toBe('moved')
    if (out.status === 'moved') expect(twice.slice(out.range.from, out.range.to)).toBe('nobody quite believed them')
  })

  it('a reflowed paragraph is the same words: whitespace differences do not lose a comment', () => {
    const reflowed = DOC.replace('nobody quite believed them', 'nobody quite\n  believed them')
    const out = resolveAnchor(anchored(), reflowed, { from: AT, to: TO })
    // 'moved', specifically: the stored range no longer holds the quote
    // literally (the newline), so it is re-found through the whitespace pass
    // and re-anchored. Asserted exactly rather than as "ok or moved", which
    // would have passed whatever happened.
    expect(out.status).toBe('moved')
    if (out.status === 'moved') {
      expect(reflowed.slice(out.range.from, out.range.to).replace(/\s+/g, ' ')).toBe('nobody quite believed them')
    }
  })

  it('an anchor with NO quote is believed, because there is nothing to check it against', () => {
    // Written before quotes existed, or by an older client. Refusing to draw
    // would lose a comment that is probably fine.
    const out = resolveAnchor({ kind: 'local', from: 4, to: 9 }, DOC, { from: 4, to: 9 })
    expect(out).toEqual({ status: 'ok', range: { from: 4, to: 9 } })
  })

  it('a Yjs anchor whose positions no longer resolve falls back to its quote', () => {
    const out = resolveAnchor({ kind: 'yjs', start: { a: 1 }, end: { b: 2 }, quote: quoteFor(DOC, AT, TO)! }, DOC, null)
    expect(out.status).toBe('moved')
  })

  it('no anchor at all is an orphan, never a highlight at position zero', () => {
    expect(resolveAnchor(null, DOC, null)).toEqual({ status: 'orphan', reason: 'malformed' })
  })
})

describe('refindQuote is exact and unique, never fuzzy', () => {
  it('does not re-attach to a passage that merely resembles the original', () => {
    // Edit-distance matching would "find" this. That is the confidently-wrong
    // case the whole mechanism exists to prevent.
    const similar = 'The quarterly numbers landed on a Tuesday and everybody quite believed them.'
    expect(refindQuote(similar, { text: 'nobody quite believed them' })).toBeNull()
  })

  it('finds a single exact occurrence', () => {
    expect(refindQuote(DOC, { text: 'Revenue had climbed' })).toEqual({
      from: DOC.indexOf('Revenue had climbed'),
      to: DOC.indexOf('Revenue had climbed') + 'Revenue had climbed'.length
    })
  })
})

describe('clampRange', () => {
  it('keeps a stale position from throwing inside the editor', () => {
    expect(clampRange({ from: 10, to: 9999 }, 50)).toEqual({ from: 10, to: 50 })
    expect(clampRange({ from: 80, to: 90 }, 50)).toBeNull()
  })
})

describe('the tripwire for synced bodies', () => {
  // 9d's requirement, because a comment at the line is easy to miss. Today
  // crdtSync publishes only `title` and `archived` as document attributes, so
  // a body edited on another device does NOT stream in attribute by
  // attribute, and anchors are safe from that path. The day someone adds
  // `body` to that list, every stored offset can change with no transaction
  // and no re-verify, so this fails until the anchor path is wired for it.
  it('crdtSync does not publish a document BODY as an attribute', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/renderer/src/lib/crdtSync.ts', 'utf8')
    const list = /for \(const attr of \[([^\]]*)\] as const\)/g
    const lists = [...src.matchAll(list)].map((m) => m[1]!)
    const docAttrs = lists.find((l) => l.includes("'title'"))
    expect(docAttrs, 'the document attribute list moved; find it and re-point this tripwire').toBeDefined()
    expect(
      docAttrs!.includes("'body'"),
      'body is synced as a document attribute now: comment anchors must be re-verified against the incoming body (resolveAnchor) before this can pass'
    ).toBe(false)
  })
})
