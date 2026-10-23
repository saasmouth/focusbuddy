// Comment highlights drawn from stored ranges instead of a mark in the body.
//
// The point of the whole exercise is that showing a comment must not be a
// document write. Applying CommentMark is one: in a live document it mutates
// the shared Y.Doc and propagates, which the signal server now refuses for a
// viewer, and locally it is swallowed by DocEditor's readOnly guard so the
// highlight lasts until reload. A decoration is a view-level overlay, so a
// viewer can comment without writing anything.
//
// Everything here runs against a REAL ProseMirror editor rather than a stub,
// because every property that matters is a runtime one: whether a transaction
// changed the document, whether a decoration survived an edit, where it ended
// up afterwards. A stub would be asserting my own assumptions back at me.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import {
  CommentDecorations,
  commentDecorationsKey,
  commentIdAt,
  type CommentRange
} from '../../src/renderer/src/components/documents/editor/CommentDecorations'

let editor: Editor
let host: HTMLDivElement
/** Transactions the editor reported as CHANGING the document. */
let docChanges: number

// "Hello brave new world" — positions are 1-based inside the paragraph.
const TEXT = 'Hello brave new world'
const BRAVE = { from: 7, to: 12 }
const WORLD = { from: 17, to: 22 }

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  docChanges = 0
  editor = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text, CommentDecorations],
    content: `<p>${TEXT}</p>`,
    onUpdate: () => {
      docChanges += 1
    }
  })
})

afterEach(() => {
  editor.destroy()
  host.remove()
})

const set = (ranges: CommentRange[]): void => {
  editor.commands.setCommentRanges(ranges)
}
const decorated = (): { from: number; to: number; id: unknown }[] => {
  const s = commentDecorationsKey.getState(editor.state)
  if (!s) return []
  return s
    .find()
    .map((d) => ({ from: d.from, to: d.to, id: (d.spec as { commentId?: unknown }).commentId }))
    .sort((a, b) => a.from - b.from)
}

describe('the text really is where the test thinks it is', () => {
  it('finds "brave" and "world" at the positions used below', () => {
    // Without this, every range assertion could be measuring the wrong words
    // and still look self-consistent.
    expect(editor.state.doc.textBetween(BRAVE.from, BRAVE.to)).toBe('brave')
    expect(editor.state.doc.textBetween(WORLD.from, WORLD.to)).toBe('world')
  })
})

describe('showing a comment is not a document write', () => {
  it('setting ranges changes no document and fires no update', () => {
    // THE PROPERTY THE FEATURE RESTS ON. If this transaction counted as an
    // edit, the host would save, a live document would propagate it to every
    // peer, and a viewer's highlight would be refused by the server — which is
    // exactly what the mark did.
    const before = editor.state.doc
    set([{ id: 't1', ...BRAVE }])
    expect(editor.state.doc.eq(before)).toBe(true)
    expect(docChanges).toBe(0)
    // And it did something.
    expect(decorated()).toEqual([{ from: 7, to: 12, id: 't1' }])
  })

  it('leaves no mark behind in the body', () => {
    set([{ id: 't1', ...BRAVE }])
    let marks = 0
    editor.state.doc.descendants((node) => {
      marks += node.marks.length
    })
    expect(marks).toBe(0)
  })
})

describe('highlights follow the text as it is edited', () => {
  it('shifts when text is inserted before them', () => {
    set([{ id: 't1', ...WORLD }])
    editor.commands.insertContentAt(1, 'XX')
    const d = decorated()
    expect(d).toHaveLength(1)
    expect(editor.state.doc.textBetween(d[0]!.from, d[0]!.to)).toBe('world')
  })

  it('does not stretch over text typed at either edge', () => {
    // Matching CommentMark's `inclusive: false`. A comment on "brave" must not
    // swallow what is typed against it, or a thread slowly grows to cover a
    // paragraph nobody commented on.
    set([{ id: 't1', ...BRAVE }])
    editor.commands.insertContentAt(BRAVE.to, 'ZZ')
    const d = decorated()
    expect(editor.state.doc.textBetween(d[0]!.from, d[0]!.to)).toBe('brave')
  })

  it('disappears when the text it pointed at is deleted', () => {
    set([{ id: 't1', ...BRAVE }])
    editor.commands.deleteRange(BRAVE)
    // An empty range cannot be drawn, and silently drawing nothing is right:
    // there is no text left to point at.
    expect(decorated()).toEqual([])
  })
})

describe('a stale range cannot take the editor down', () => {
  it('clamps a range that runs past the end of the document', () => {
    // Stored ranges outlive the text they described — another editor on the same
    // document can shorten it, and this editor is remounted rather than
    // transaction-mapped. An out-of-range position throws inside
    // Decoration.inline, which would take the whole editor with it.
    const size = editor.state.doc.content.size
    expect(() => set([{ id: 't1', from: size - 2, to: size + 500 }])).not.toThrow()
    const d = decorated()
    expect(d).toHaveLength(1)
    expect(d[0]!.to).toBeLessThanOrEqual(size)
  })

  it('drops an inverted or empty range rather than throwing', () => {
    expect(() => set([{ id: 'a', from: 9, to: 9 }, { id: 'b', from: 12, to: 7 }])).not.toThrow()
    expect(decorated()).toEqual([])
  })

  it('keeps the good ranges in a batch that also contains a bad one', () => {
    // One rotten anchor must not cost every other thread its highlight.
    set([{ id: 'bad', from: 9, to: 9 }, { id: 'good', ...WORLD }])
    expect(decorated().map((d) => d.id)).toEqual(['good'])
  })
})

describe('resolved threads are not drawn', () => {
  it('skips them, as resolving a thread does today', () => {
    set([{ id: 't1', ...BRAVE, state: 'resolved' }, { id: 't2', ...WORLD, state: 'open' }])
    expect(decorated().map((d) => d.id)).toEqual(['t2'])
  })
})

describe('the click target', () => {
  it('finds the thread whose highlight covers a position', () => {
    set([{ id: 't1', ...BRAVE }])
    expect(commentIdAt(editor.state, 9)).toBe('t1')
  })

  it('finds nothing outside any highlight', () => {
    set([{ id: 't1', ...BRAVE }])
    expect(commentIdAt(editor.state, 2)).toBeNull()
  })

  it('picks the NARROWEST of overlapping threads', () => {
    // The most specific thing a click there can have meant. The mark version
    // took whichever mark came first, which with overlaps was arbitrary.
    set([
      { id: 'wide', from: 1, to: 22 },
      { id: 'narrow', ...BRAVE }
    ])
    expect(commentIdAt(editor.state, 9)).toBe('narrow')
  })
})

describe('a later push replaces the lot', () => {
  it('does not accumulate highlights across pushes', () => {
    // The host re-pushes whenever it has ranges — including after a remount,
    // and after a re-find corrects an anchor. If pushes merged, a corrected
    // range would be drawn alongside the wrong one it replaced.
    set([{ id: 't1', ...BRAVE }])
    set([{ id: 't1', ...WORLD }])
    const d = decorated()
    expect(d).toHaveLength(1)
    expect(editor.state.doc.textBetween(d[0]!.from, d[0]!.to)).toBe('world')
  })

  it('clears everything when pushed an empty list', () => {
    set([{ id: 't1', ...BRAVE }])
    set([])
    expect(decorated()).toEqual([])
  })
})

describe('it is actually REGISTERED, not merely written', () => {
  it('is in the document extension list, so a real editor has the plugin', async () => {
    // Without this nothing fails if the extension is left out: commentIdAt
    // returns null when its plugin state is absent, so DocEditor's click
    // fallback silently finds nothing and new comments simply never open.
    // Graceful degradation is right at runtime and useless as a signal, which
    // is exactly when a reachability test earns its place.
    const { buildDocExtensions } = await import(
      '../../src/renderer/src/components/documents/editor/extensions'
    )
    const names = buildDocExtensions({ interactive: true }).map(
      (e) => (e as { name?: string }).name
    )
    expect(names).toContain('commentDecorations')
    // And the mark is still there: existing threads must keep rendering while
    // new ones move to ranges.
    expect(names).toContain('comment')
  })
})
