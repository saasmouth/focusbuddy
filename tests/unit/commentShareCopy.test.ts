// Bringing a local document's comments with it when it is shared.
//
// The default is the point: a comment on a document only you can see is a
// private note, so this runs only when the share dialog's box is ticked. The
// first test here is the one that matters most — unticked copies NOTHING — and
// it is written against the copy function rather than the dialog, so it asserts
// the behaviour rather than the absence of a click.
//
// Everything else is about what is TRUE in a copy that other people will read
// as fact: the real creation time rather than now, the resolved state, the
// anchor converted with its quote verified, and a comment whose text has gone
// travelling with NO anchor rather than a guessed one.

import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import * as Y from 'yjs'
import { buildDocExtensions } from '../../src/renderer/src/components/documents/editor/extensions'
import { initProseMirrorDoc } from '@tiptap/y-tiptap'
import { COLLAB_FIELD, seedYDocFromPm } from '../../src/renderer/src/lib/yjsSeed'
import { positionText } from '../../src/renderer/src/components/documents/editor/commentPositions'
import { convertAnchorsForShare } from '../../src/renderer/src/lib/commentShareConvert'
import {
  copyCommentsToLiveDoc,
  describeCopy,
  EMPTY_COPY,
  type LocalCommentRow
} from '../../src/renderer/src/lib/commentShareCopy'
import { readCommentAnchor, resolveThreads } from '../../src/shared/commentAnchor'

const schema = getSchema(buildDocExtensions({ interactive: false }))

const PM = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The committee resolved to defer the matter.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'A second paragraph with the contentious clause in it.' }] }
  ]
}

/** The positions a local editor on this body would have produced. */
function rangeOf(phrase: string): { from: number; to: number; text: string } {
  const ydoc = new Y.Doc()
  seedYDocFromPm(ydoc, PM, schema)
  const { doc } = initProseMirrorDoc(ydoc.getXmlFragment(COLLAB_FIELD), schema)
  const text = positionText(doc)
  const from = text.indexOf(phrase)
  if (from < 0) throw new Error(`fixture does not contain ${phrase}`)
  return { from, to: from + phrase.length, text }
}

const localAnchor = (phrase: string): string => {
  const r = rangeOf(phrase)
  return JSON.stringify({ kind: 'local', from: r.from, to: r.to, quote: { text: phrase } })
}

const row = (o: Partial<LocalCommentRow> & { id: string }): LocalCommentRow => ({
  parentId: null,
  anchor: null,
  body: 'a comment',
  resolved: false,
  createdAt: 1_700_000_000_000,
  ...o
})

/** A fake live-doc API that records exactly what was posted. */
function fakeApi(opts: { failThread?: string; ignoresCreatedAt?: boolean } = {}): {
  api: Parameters<typeof copyCommentsToLiveDoc>[1]
  posted: Array<{ body: string; parentId?: string; anchor?: string | null; createdAt?: number; id: string }>
  resolved: string[]
} {
  const posted: Array<{ body: string; parentId?: string; anchor?: string | null; createdAt?: number; id: string }> = []
  const resolved: string[] = []
  let n = 0
  return {
    posted,
    resolved,
    api: {
      addComment: (async (_t: string, _d: string, body: string, o?: Record<string, unknown>) => {
        if (opts.failThread && body === opts.failThread) return null
        const id = `live_${++n}`
        posted.push({ id, body, ...(o ?? {}) } as (typeof posted)[number])
        // A real server answers with the row it stored. `ignoresCreatedAt`
        // models a server WITHOUT the field (v124 and earlier): it drops what
        // was asked for and times the comment itself.
        const createdAt = opts.ignoresCreatedAt ? SERVER_NOW : ((o?.createdAt as number) ?? SERVER_NOW)
        return { id, body, createdAt } as never
      }) as never,
      resolveComment: (async (_t: string, id: string) => {
        resolved.push(id)
      }) as never
    }
  }
}

/** What a server's own clock says, in the fake. */
const SERVER_NOW = 1_800_000_000_000

const base = { token: 'tok', liveDocId: 'live1', pmJSON: PM, schema }

describe('nothing is invented when there is nothing to bring', () => {
  // The DEFAULT — unticked copies nothing — is a property of the dialog, not of
  // this function, and is tested where it lives: shareIncludeComments.test.tsx
  // drives the real component against a stubbed network and asserts that no
  // POST to /comments is made. Asserting it here instead would have been a test
  // of my own re-implementation of the dialog's guard, which cannot fail.
  it('posts nothing, and claims nothing, for a document with no comments', async () => {
    const { api, posted, resolved } = fakeApi()
    const out = await copyCommentsToLiveDoc({ ...base, comments: [] }, api)
    expect(posted).toEqual([])
    expect(resolved).toEqual([])
    expect(out).toEqual(EMPTY_COPY)
    expect(describeCopy(out), 'no "0 comments shared" either').toBeNull()
  })

  it('posts nothing when every row is a reply with no thread of its own', async () => {
    // A corrupt or partially-deleted local set. A reply with no root must not
    // become a comment of its own.
    const { api, posted } = fakeApi()
    const out = await copyCommentsToLiveDoc(
      { ...base, comments: [row({ id: 'r1', body: 'orphan reply', parentId: 'gone' })] },
      api
    )
    expect(posted).toEqual([])
    expect(out).toEqual(EMPTY_COPY)
  })
})

describe('what a copied comment says about itself', () => {
  it('keeps the REAL creation time, not the moment of sharing', async () => {
    const WEEK_AGO = Date.now() - 7 * 86_400_000
    const { api, posted } = fakeApi()
    await copyCommentsToLiveDoc(
      { ...base, comments: [row({ id: 'c1', body: 'written last week', createdAt: WEEK_AGO })] },
      api
    )
    expect(posted).toHaveLength(1)
    expect(posted[0]!.createdAt, 'the server honours this for the owner').toBe(WEEK_AGO)
  })

  it('says so when the SERVER timed the copy itself, rather than showing a false date', async () => {
    // A server without the createdAt field ignores it and returns its own now.
    // Detected from the row it hands back, not from a version number, so this
    // stops being reported the moment the server honours the field — with no
    // client change.
    const WEEK_AGO = Date.now() - 7 * 86_400_000
    const { api } = fakeApi({ ignoresCreatedAt: true })
    const out = await copyCommentsToLiveDoc(
      { ...base, comments: [row({ id: 'c1', body: 'written last week', createdAt: WEEK_AGO })] },
      api
    )
    expect(out.threads).toBe(1)
    expect(out.timeNotKept).toBe(1)
    expect(describeCopy(out)).toContain('shown as added when shared')
  })

  it('and says nothing about times when the server DID keep them', async () => {
    const { api } = fakeApi()
    const out = await copyCommentsToLiveDoc(
      { ...base, comments: [row({ id: 'c1', createdAt: Date.now() - 86_400_000 })] },
      api
    )
    expect(out.timeNotKept).toBe(0)
    expect(describeCopy(out)).not.toContain('added when shared')
  })

  it('carries the resolved state, so a resolved thread does not arrive open', async () => {
    const { api, posted, resolved } = fakeApi()
    const out = await copyCommentsToLiveDoc(
      {
        ...base,
        comments: [row({ id: 'c1', body: 'done with this', resolved: true }), row({ id: 'c2', body: 'still open' })]
      },
      api
    )
    expect(posted.map((p) => p.body)).toEqual(['done with this', 'still open'])
    expect(resolved, 'only the resolved one').toEqual([posted[0]!.id])
    expect(out.notResolved).toBe(0)
  })

  it('posts oldest first, and attaches replies to the id the SERVER gave', async () => {
    const t0 = 1_700_000_000_000
    const { api, posted } = fakeApi()
    const out = await copyCommentsToLiveDoc(
      {
        ...base,
        comments: [
          row({ id: 'newer', body: 'second thread', createdAt: t0 + 2000 }),
          row({ id: 'older', body: 'first thread', createdAt: t0 }),
          row({ id: 'r1', body: 'a reply', parentId: 'older', createdAt: t0 + 1000 })
        ]
      },
      api
    )
    expect(posted.map((p) => p.body)).toEqual(['first thread', 'second thread', 'a reply'])
    const olderLiveId = posted.find((p) => p.body === 'first thread')!.id
    expect(posted.find((p) => p.body === 'a reply')!.parentId).toBe(olderLiveId)
    // Local ids are NOT reused: doc_comments.id is a primary key across the
    // whole table, so reusing them would collide the second time the same
    // local document is shared.
    expect(posted.map((p) => p.id)).not.toContain('older')
    expect(out).toMatchObject({ threads: 2, replies: 1, failedThreads: 0, failedReplies: 0 })
  })

  it('a reply whose thread was refused is not posted as a thread of its own', async () => {
    const { api, posted } = fakeApi({ failThread: 'first thread' })
    const out = await copyCommentsToLiveDoc(
      {
        ...base,
        comments: [
          row({ id: 'older', body: 'first thread' }),
          row({ id: 'r1', body: 'a reply', parentId: 'older', createdAt: 1_700_000_001_000 })
        ]
      },
      api
    )
    expect(posted.map((p) => p.body)).toEqual([])
    expect(out).toMatchObject({ threads: 0, replies: 0, failedThreads: 1, failedReplies: 1 })
    expect(describeCopy(out)).toContain('could not be copied')
  })
})

describe('the anchor is converted, and only when it has been verified', () => {
  it('a verified anchor becomes a live one that resolves on its own words', async () => {
    const { api, posted } = fakeApi()
    const out = await copyCommentsToLiveDoc(
      { ...base, comments: [row({ id: 'c1', anchor: localAnchor('the contentious clause') })] },
      api
    )
    expect(out.unanchored).toBe(0)
    const sent = readCommentAnchor(posted[0]!.anchor)
    expect(sent?.kind, 'converted to relative positions').toBe('yjs')
    expect(sent?.quote?.text).toBe('the contentious clause')

    // Resolve it the way the live editor will: against a Y.Doc seeded from the
    // same body, which is a DIFFERENT Y.Doc from the one conversion used.
    const ydoc = new Y.Doc()
    seedYDocFromPm(ydoc, PM, schema)
    const { doc, mapping } = initProseMirrorDoc(ydoc.getXmlFragment(COLLAB_FIELD), schema)
    const { relativePositionToAbsolutePosition } = await import('@tiptap/y-tiptap')
    const frag = ydoc.getXmlFragment(COLLAB_FIELD)
    const yjs = sent as { start: Record<string, unknown>; end: Record<string, unknown> }
    const from = relativePositionToAbsolutePosition(ydoc, frag, Y.createRelativePositionFromJSON(yjs.start), mapping)
    const to = relativePositionToAbsolutePosition(ydoc, frag, Y.createRelativePositionFromJSON(yjs.end), mapping)
    expect(doc.textBetween(from!, to!), 'the words, in the room that will really hold them').toBe(
      'the contentious clause'
    )
  })

  it('a comment whose text has GONE travels with no anchor rather than a guess', async () => {
    const stale = JSON.stringify({
      kind: 'local',
      from: 4,
      to: 24,
      quote: { text: 'a sentence deleted before sharing' }
    })
    const { api, posted } = fakeApi()
    const out = await copyCommentsToLiveDoc({ ...base, comments: [row({ id: 'c1', anchor: stale })] }, api)
    expect(out).toMatchObject({ threads: 1, unanchored: 1 })
    expect(posted[0]!.anchor, 'the comment travels; the highlight does not').toBeNull()
    expect(describeCopy(out)).toContain('without a highlight')
  })

  it('a DRIFTED anchor is converted at the text it was re-found at', () => {
    // The range is wrong but the words are still there: re-found, then
    // converted, because converting the stale range would bake the drift into
    // relative positions permanently.
    const good = rangeOf('the contentious clause')
    const drifted = { kind: 'local', from: good.from + 25, to: good.to + 25, quote: { text: 'the contentious clause' } }
    const { converted, unanchored } = convertAnchorsForShare(PM, schema, [{ id: 'c1', anchor: drifted }])
    expect(unanchored).toEqual([])
    expect(converted.get('c1')?.quote?.text).toBe('the contentious clause')
  })

  it('refuses to convert an anchor with no quote, or one already live', () => {
    const noQuote = { kind: 'local', from: 1, to: 9 }
    const already = { kind: 'yjs', start: { tname: 'default' }, end: { tname: 'default' } }
    const { converted, unanchored } = convertAnchorsForShare(PM, schema, [
      { id: 'a', anchor: noQuote },
      { id: 'b', anchor: already },
      { id: 'c', anchor: 'not json' }
    ])
    expect(converted.size).toBe(0)
    expect(unanchored).toEqual([
      { id: 'a', reason: 'no-quote' },
      { id: 'b', reason: 'already-live' },
      { id: 'c', reason: 'malformed' }
    ])
  })

  it('an ambiguous quote is an orphan, not a highlight on the wrong copy', () => {
    const TWICE = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Please review this.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Please review this.' }] }
      ]
    }
    const anchor = { kind: 'local', from: 500, to: 519, quote: { text: 'Please review this.' } }
    const { converted, unanchored } = convertAnchorsForShare(TWICE, schema, [{ id: 'c1', anchor }])
    expect(converted.size).toBe(0)
    expect(unanchored[0]!.reason).toBe('ambiguous')
  })
})

describe('the local document is left alone', () => {
  it('resolveThreads still reads the ORIGINAL local anchors after a copy', async () => {
    // Sharing promotes a copy; the local document and its comments stay as
    // they were, so a sharer who goes back to the local file finds it intact.
    const anchor = localAnchor('the contentious clause')
    const comments = [row({ id: 'c1', anchor })]
    const { api } = fakeApi()
    await copyCommentsToLiveDoc({ ...base, comments }, api)
    expect(comments[0]!.anchor, 'the local row is untouched').toBe(anchor)
    const r = rangeOf('the contentious clause')
    const { ranges } = resolveThreads([{ id: 'c1', anchor }], r.text)
    expect(ranges[0]).toMatchObject({ id: 'c1', from: r.from, to: r.to })
  })
})
