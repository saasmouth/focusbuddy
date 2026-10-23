// The coordinate space a stored comment anchor lives in.
//
// shared/commentAnchor.ts is pure: it takes a string and indexes it with the
// anchor's own from/to. ec's decoration plugin places highlights at PROSEMIRROR
// POSITIONS, where every node boundary costs one position and an atom (an
// image) costs one while contributing no character. So the string handed to the
// resolver decides, silently, whether every highlight lands on the right words.
//
// Hand it `editor.getText()` and it does not: that string packs the characters
// together with a two-character separator per block, which only coincidentally
// matches a paragraph boundary's cost and matches nothing else. ec measured the
// drift on a document of a paragraph, an image and a bullet list and got +1,
// -2, -2 — not constant, not even one sign — while a document of plain
// paragraphs drifts a uniform +1 and hides the whole problem from any test
// written against one paragraph.
//
// `positionText` removes the second coordinate space instead of converting
// between two: the string is INDEXED BY POSITION, so the resolver's offsets ARE
// document positions and nothing is converted anywhere. This file is the proof,
// and every assertion is a ROUND TRIP — take a range out of the resolver, and
// ask the DOCUMENT what text is actually there. A one-character error fails
// with the wrong words rather than an uninterpretable number.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Heading from '@tiptap/extension-heading'
import Image from '@tiptap/extension-image'
import BulletList from '@tiptap/extension-bullet-list'
import ListItem from '@tiptap/extension-list-item'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import {
  CommentDecorations,
  commentDecorationsKey
} from '../../src/renderer/src/components/documents/editor/CommentDecorations'
import {
  localAnchorFor,
  positionText,
  resolveForEditor,
  requote
} from '../../src/renderer/src/components/documents/editor/commentPositions'

// A paragraph, an ATOM, a two-item list and a table — every structure that
// costs positions differently from characters. ec's fixture plus a table,
// because our schema has them and a cell boundary costs three positions.
// The image is a BLOCK and its src is an ordinary URL: Image is `inline:
// false`, so one inside a <p> is invalid and dropped, and `allowBase64` is off
// by default, so a data: src is dropped wherever it sits. A fixture that hit
// either silently tests a document with no image in it, which is why the atom
// test below asserts the image is really there before measuring it.
const CONTENT = `
<h2>Echo is a heading</h2>
<p>Alpha opens the document</p>
<img src="https://example.invalid/a.png" />
<ul><li><p>Bravo is the first bullet</p></li><li><p>Charlie is the second bullet</p></li></ul>
<table><tbody><tr><td><p>Delta sits in a cell</p></td></tr></tbody></table>
`

const EXTENSIONS = [
  Document,
  Paragraph,
  Text,
  Heading,
  Image,
  BulletList,
  ListItem,
  Table.configure({ resizable: false }),
  TableRow,
  TableCell,
  TableHeader,
  CommentDecorations
]

let editor: Editor
let host: HTMLDivElement
/** Editors a single test made for itself, torn down with the shared one. */
let extra: { editor: Editor; host: HTMLDivElement }[] = []

/** A second editor, for the documents that cannot be the shared fixture. */
function makeEditor(content: string): Editor {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = new Editor({ element: el, extensions: EXTENSIONS, content })
  extra.push({ editor: ed, host: el })
  return ed
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  extra = []
  editor = new Editor({ element: host, extensions: EXTENSIONS, content: CONTENT })
})

afterEach(() => {
  for (const e of extra) {
    e.editor.destroy()
    e.host.remove()
  }
  editor.destroy()
  host.remove()
})

const WORDS = ['Echo', 'Alpha', 'Bravo', 'Charlie', 'Delta'] as const

/** What the DOCUMENT says is at a range — the only honest check. */
const textAt = (from: number, to: number): string => editor.state.doc.textBetween(from, to)

const decorated = (): { from: number; to: number; id: string }[] => {
  const set = commentDecorationsKey.getState(editor.state)
  const out: { from: number; to: number; id: string }[] = []
  set?.find().forEach((d) => out.push({ from: d.from, to: d.to, id: String((d.spec as { commentId?: unknown }).commentId) }))
  return out.sort((a, b) => a.from - b.from)
}

describe('positionText is indexed by document position', () => {
  it('is exactly as long as the document, so one clamp bound serves both ends', () => {
    expect(positionText(editor.state.doc)).toHaveLength(editor.state.doc.content.size)
  })

  it('round-trips every word with NO conversion: its index in the string is its position', () => {
    const text = positionText(editor.state.doc)
    for (const word of WORDS) {
      const at = text.indexOf(word)
      expect(at, `${word} is in the position-indexed text`).toBeGreaterThan(-1)
      // The index used DIRECTLY as a ProseMirror position. No table, no offset.
      expect(textAt(at, at + word.length), `${word} at position ${at}`).toBe(word)
    }
  })

  it('and getText() does NOT — which is why this module exists', () => {
    const plain = editor.getText()
    const wrong = WORDS.filter((w) => {
      const at = plain.indexOf(w)
      if (at < 0) return true
      try {
        return textAt(at, at + w.length) !== w
      } catch {
        return true
      }
    })
    // If this ever comes back empty the drift is gone and the module can go
    // with it. Recorded as a list so the failure names the words that moved.
    expect(wrong.length, `words getText() misplaces: ${wrong.join(', ')}`).toBeGreaterThan(0)
  })

  it('an atom costs one position and contributes no character', () => {
    const text = positionText(editor.state.doc)
    let img: { pos: number; size: number; atom: boolean } | null = null
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') img = { pos, size: node.nodeSize, atom: node.isAtom }
      return true
    })
    expect(img, 'the fixture really has an image in it').not.toBeNull()
    expect(img!.size).toBe(1)
    expect(img!.atom).toBe(true)
    // Its one position holds filler, not text, so no quote can ever match an
    // image — and the character count stays equal to the position count, which
    // is the whole invariant.
    expect(text[img!.pos]).toBe('\n')
    expect(text).toHaveLength(editor.state.doc.content.size)
  })
})

describe('the whole path: anchor, body rewritten with no transaction, highlight', () => {
  /** Rebuild the editor's body the way an AI action or a restore does. */
  const replaceBody = (html: string): void => {
    editor.commands.setContent(html)
  }

  it('a comment survives a PREPEND and still highlights its own words', () => {
    const text = positionText(editor.state.doc)
    const at = text.indexOf('Charlie is the second bullet')
    const anchor = localAnchorFor(editor, at, at + 'Charlie is the second bullet'.length)
    expect(anchor.quote?.text).toBe('Charlie is the second bullet')

    // The failure this mechanism exists for: a whole new block in FRONT, by a
    // path with no transaction to map through. Every stored position is stale.
    replaceBody(`<p>An introduction the AI added</p>${CONTENT}`)

    const { ranges, orphans } = resolveForEditor(editor, [{ id: 'c1', anchor: JSON.stringify(anchor) }])
    expect(orphans).toHaveLength(0)
    expect(ranges[0]!.corrected, 'the range was re-found, so the host must save it back').toBe(true)
    // Straight into ec's plugin, unconverted.
    editor.commands.setCommentRanges(ranges)
    const drawn = decorated()
    expect(drawn).toHaveLength(1)
    expect(textAt(drawn[0]!.from, drawn[0]!.to)).toBe('Charlie is the second bullet')
  })

  it('a believed anchor is drawn on the right words when the body is unchanged', () => {
    const text = positionText(editor.state.doc)
    const at = text.indexOf('Delta sits in a cell')
    const anchor = localAnchorFor(editor, at, at + 'Delta sits in a cell'.length)
    const { ranges } = resolveForEditor(editor, [{ id: 'c1', anchor }])
    expect(ranges[0]!.corrected, 'nothing moved, so nothing to write back').toBeUndefined()
    editor.commands.setCommentRanges(ranges)
    expect(textAt(decorated()[0]!.from, decorated()[0]!.to)).toBe('Delta sits in a cell')
  })

  it('a comment on text that was deleted is an orphan, not a highlight somewhere else', () => {
    const text = positionText(editor.state.doc)
    const at = text.indexOf('Bravo is the first bullet')
    const anchor = localAnchorFor(editor, at, at + 'Bravo is the first bullet'.length)
    replaceBody('<p>Alpha opens the document</p><p>Charlie is the second bullet</p>')
    const { ranges, orphans } = resolveForEditor(editor, [{ id: 'c1', anchor }])
    expect(ranges).toHaveLength(0)
    expect(orphans).toEqual([{ id: 'c1', reason: 'missing' }])
    editor.commands.setCommentRanges(ranges)
    expect(decorated()).toHaveLength(0)
  })

  it('requote tracks the text under an anchor after it is edited in place', () => {
    const before = positionText(editor.state.doc)
    const at = before.indexOf('Alpha opens the document')
    const anchor = localAnchorFor(editor, at, at + 'Alpha opens the document'.length)
    // Type inside the commented passage. The decorations map themselves; the
    // STORED quote is what goes stale, and requote is what keeps it true.
    editor.commands.insertContentAt(at + 'Alpha'.length, ' indeed')
    const grown = { ...anchor, to: anchor.to + ' indeed'.length }
    const fresh = requote(positionText(editor.state.doc), grown)
    expect(fresh?.quote?.text).toBe('Alpha indeed opens the document')
    // And the refreshed anchor resolves without correction, because it is true.
    const { ranges } = resolveForEditor(editor, [{ id: 'c1', anchor: fresh }])
    expect(ranges[0]!.corrected).toBeUndefined()
    expect(textAt(ranges[0]!.from, ranges[0]!.to)).toBe('Alpha indeed opens the document')
  })
})

// ── The four cases ec salvaged from the map they dropped ────────────────────
// Their fixtures outlived their module, which is the right way round: a
// deleted implementation takes its tests with it, and these four test the
// COORDINATE SPACE rather than either implementation of it.

describe('the edges, where an off-by-one is a crash rather than a wrong word', () => {
  it('a stored range PAST THE END stays resolvable instead of throwing in the editor', () => {
    // Decoration.inline throws on an out-of-range position, which would take
    // the whole editor down over one stale comment — so the resolver clamps
    // and the plugin clamps again. A range from a document that has since
    // been truncated is the ordinary way to get here.
    const size = editor.state.doc.content.size
    const past = { kind: 'local' as const, from: size + 40, to: size + 80 }
    const { ranges, orphans } = resolveForEditor(editor, [{ id: 'c1', anchor: past }])
    // No quote to check, and nothing left in range: an honest orphan, not a
    // highlight at the end of the document.
    expect(ranges).toHaveLength(0)
    expect(orphans).toEqual([{ id: 'c1', reason: 'missing' }])

    // And with a quote it is re-found rather than lost.
    const text = positionText(editor.state.doc)
    const at = text.indexOf('Bravo is the first bullet')
    const stale = {
      ...localAnchorFor(editor, at, at + 'Bravo is the first bullet'.length),
      from: size + 40,
      to: size + 80
    }
    const out = resolveForEditor(editor, [{ id: 'c2', anchor: stale }])
    expect(out.ranges[0]!.corrected).toBe(true)
    expect(() => editor.commands.setCommentRanges(out.ranges)).not.toThrow()
    const drawn = decorated()
    expect(drawn[0]!.to).toBeLessThanOrEqual(editor.state.doc.content.size)
    expect(textAt(drawn[0]!.from, drawn[0]!.to)).toBe('Bravo is the first bullet')
  })

  it('an EMPTY document resolves nothing and throws nothing', () => {
    const empty = makeEditor('<p></p>')
    const text = positionText(empty.state.doc)
    expect(text).toHaveLength(empty.state.doc.content.size)
    // Nothing to quote in an empty document, so no anchor can be made for one.
    expect(localAnchorFor(empty, 0, 1).quote).toBeUndefined()
    const { ranges, orphans } = resolveForEditor(empty, [
      { id: 'c1', anchor: { kind: 'local', from: 1, to: 9, quote: { text: 'anything' } } }
    ])
    expect(ranges).toHaveLength(0)
    expect(orphans).toEqual([{ id: 'c1', reason: 'missing' }])
    expect(() => empty.commands.setCommentRanges(ranges)).not.toThrow()
  })

  it('round-trips EVERY character of a word, because an end off-by-one hides at the last one', () => {
    const text = positionText(editor.state.doc)
    for (const word of WORDS) {
      const at = text.indexOf(word)
      for (let i = 0; i < word.length; i++) {
        expect(textAt(at + i, at + i + 1), `${word}[${i}] at position ${at + i}`).toBe(word[i])
      }
      // And the whole span, from its last character's far edge.
      expect(textAt(at, at + word.length)).toBe(word)
    }
  })

  it('a heading costs what a heading costs, and a comment in one lands on its own words', () => {
    const text = positionText(editor.state.doc)
    const at = text.indexOf('Echo is a heading')
    expect(editor.state.doc.content.child(0).type.name).toBe('heading')
    const anchor = localAnchorFor(editor, at, at + 'Echo is a heading'.length)
    expect(anchor.quote?.text).toBe('Echo is a heading')
    // Prepend a paragraph so the heading is no longer the first block, which
    // is where a per-block boundary cost would show up as drift.
    editor.commands.setContent(`<p>Added above</p>${CONTENT}`)
    const { ranges } = resolveForEditor(editor, [{ id: 'c1', anchor }])
    editor.commands.setCommentRanges(ranges)
    expect(textAt(decorated()[0]!.from, decorated()[0]!.to)).toBe('Echo is a heading')
  })
})
