import { describe, it, expect } from 'vitest'
import {
  caretDocEnd,
  caretDocStart,
  caretEnd,
  caretHome,
  caretLeft,
  caretRight,
  clampCaret,
  compareCarets,
  deleteBackward,
  deleteForward,
  insertBlocks,
  insertText,
  isCollapsed,
  selectAll,
  selectedText,
  setBlockKind,
  slotIndex,
  slots,
  splitAt,
  textAt,
  type DocCaret
} from '../../src/shared/designTextEdit'
import type { ContentDoc } from '../../src/shared/designContent'

const doc = (): ContentDoc => ({
  blocks: [
    { kind: 'heading', level: 1, text: 'Heading' },
    { kind: 'paragraph', text: 'Hello world' },
    { kind: 'list', ordered: false, items: ['one', 'two'] },
    { kind: 'image', src: 'data:,' },
    { kind: 'paragraph', text: 'Last' }
  ]
})
const at = (block: number, offset: number, item?: number): DocCaret => (item === undefined ? { block, offset } : { block, item, offset })
const collapsed = (c: DocCaret): { anchor: DocCaret; focus: DocCaret } => ({ anchor: c, focus: c })
const texts = (d: ContentDoc): string[] => slots(d).map((s) => s.text)

describe('designTextEdit — slots', () => {
  it('lists every editable run and skips what cannot be typed into', () => {
    expect(texts(doc())).toEqual(['Heading', 'Hello world', 'one', 'two', 'Last'])
  })

  it('an image contributes no slot, so the caret steps over it', () => {
    const d = doc()
    const i = slotIndex(d, at(4, 0))
    expect(i).toBe(4)
    expect(slots(d)[i].block).toBe(4)
  })

  it('textAt reads the right run, and nothing for a non-text block', () => {
    expect(textAt(doc(), at(2, 0, 1))).toBe('two')
    expect(textAt(doc(), at(3, 0))).toBe('')
  })

  it('an empty document still yields a usable caret', () => {
    expect(clampCaret({ blocks: [] }, at(9, 9))).toEqual({ block: 0, offset: 0 })
  })
})

describe('designTextEdit — typing', () => {
  it('inserts at the caret', () => {
    const { doc: d, caret } = insertText(doc(), collapsed(at(1, 5)), ' there')
    expect(texts(d)[1]).toBe('Hello there world')
    expect(caret.offset).toBe(11)
  })

  it('typing over a selection replaces it', () => {
    const { doc: d } = insertText(doc(), { anchor: at(1, 0), focus: at(1, 5) }, 'Goodbye')
    expect(texts(d)[1]).toBe('Goodbye world')
  })

  it('typing across blocks collapses them into the first, which keeps its kind', () => {
    const { doc: d, caret } = insertText(doc(), { anchor: at(0, 4), focus: at(1, 5) }, 'X')
    expect(d.blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'HeadX world' })
    expect(caret).toEqual({ block: 0, offset: 5 })
  })

  it('typing into a list item edits only that item', () => {
    const { doc: d } = insertText(doc(), collapsed(at(2, 3, 0)), '!')
    expect(texts(d)).toEqual(['Heading', 'Hello world', 'one!', 'two', 'Last'])
  })

  it('typing into an empty document creates a paragraph', () => {
    const { doc: d } = insertText({ blocks: [] }, collapsed(at(0, 0)), 'first words')
    expect(d.blocks).toEqual([{ kind: 'paragraph', text: 'first words' }])
  })
})

describe('designTextEdit — Enter', () => {
  it('splits a paragraph in two', () => {
    const { doc: d, caret } = splitAt(doc(), collapsed(at(1, 5)))
    expect(texts(d)).toEqual(['Heading', 'Hello', ' world', 'one', 'two', 'Last'])
    expect(caret).toEqual({ block: 2, offset: 0 })
  })

  it('Enter at the end of a heading gives a paragraph, not another heading', () => {
    const { doc: d } = splitAt(doc(), collapsed(at(0, 7)))
    expect(d.blocks[1].kind).toBe('paragraph')
  })

  it('Enter inside a list makes a new item', () => {
    const { doc: d, caret } = splitAt(doc(), collapsed(at(2, 3, 0)))
    expect(texts(d)).toEqual(['Heading', 'Hello world', 'one', '', 'two', 'Last'])
    expect(caret).toEqual({ block: 2, item: 1, offset: 0 })
  })

  it('Enter on an empty list item ends the list', () => {
    const d: ContentDoc = { blocks: [{ kind: 'list', ordered: false, items: ['a', ''] }] }
    const out = splitAt(d, collapsed(at(0, 0, 1)))
    expect(out.doc.blocks.map((b) => b.kind)).toEqual(['list', 'paragraph'])
    expect((out.doc.blocks[0] as { items: string[] }).items).toEqual(['a'])
  })

  it('Enter with a selection deletes it first', () => {
    const { doc: d } = splitAt(doc(), { anchor: at(1, 0), focus: at(1, 6) })
    expect(texts(d)[1]).toBe('')
    expect(texts(d)[2]).toBe('world')
  })
})

describe('designTextEdit — deleting', () => {
  it('backspace removes the character before the caret', () => {
    const { doc: d, caret } = deleteBackward(doc(), collapsed(at(1, 5)))
    expect(texts(d)[1]).toBe('Hell world')
    expect(caret.offset).toBe(4)
  })

  it('backspace at the start merges into the previous slot', () => {
    const { doc: d, caret } = deleteBackward(doc(), collapsed(at(1, 0)))
    expect(texts(d)).toEqual(['HeadingHello world', 'one', 'two', 'Last'])
    expect(caret).toEqual({ block: 0, offset: 7 })
  })

  it('backspace at the very start of the document does nothing', () => {
    const d = doc()
    expect(deleteBackward(d, collapsed(at(0, 0))).doc).toBe(d)
  })

  it('backspace with a selection deletes the selection', () => {
    const { doc: d } = deleteBackward(doc(), { anchor: at(1, 0), focus: at(1, 6) })
    expect(texts(d)[1]).toBe('world')
  })

  it('delete-forward pulls the next slot up', () => {
    const { doc: d } = deleteForward(doc(), collapsed(at(1, 11)))
    expect(texts(d)[1]).toBe('Hello worldone')
  })

  it('delete-forward at the end of the document does nothing', () => {
    const d = doc()
    expect(deleteForward(d, collapsed(caretDocEnd(d))).doc).toBe(d)
  })

  it('deleting a whole list item leaves the rest of the list intact', () => {
    const { doc: d } = insertText(doc(), { anchor: at(2, 0, 0), focus: at(2, 3, 0) }, '')
    expect(texts(d)).toEqual(['Heading', 'Hello world', '', 'two', 'Last'])
  })
})

describe('designTextEdit — selection', () => {
  it('knows reading order whichever way the selection was dragged', () => {
    const d = doc()
    expect(compareCarets(d, at(0, 0), at(1, 0))).toBe(-1)
    expect(compareCarets(d, at(1, 0), at(0, 0))).toBe(1)
    expect(compareCarets(d, at(1, 3), at(1, 3))).toBe(0)
    expect(isCollapsed(d, collapsed(at(1, 3)))).toBe(true)
  })

  it('reads selected text within one slot and across several', () => {
    const d = doc()
    expect(selectedText(d, { anchor: at(1, 0), focus: at(1, 5) })).toBe('Hello')
    expect(selectedText(d, { anchor: at(1, 6), focus: at(2, 3, 0) })).toBe('world\none')
  })

  it('a backwards selection reads the same as a forwards one', () => {
    const d = doc()
    expect(selectedText(d, { anchor: at(1, 5), focus: at(1, 0) })).toBe('Hello')
  })

  it('select-all spans the whole document', () => {
    const d = doc()
    const sel = selectAll(d)
    expect(sel.anchor).toEqual(caretDocStart(d))
    expect(sel.focus).toEqual(caretDocEnd(d))
    expect(selectedText(d, sel)).toContain('Heading')
    expect(selectedText(d, sel)).toContain('Last')
  })
})

describe('designTextEdit — caret movement', () => {
  const d = doc()

  it('left and right step through characters then across slots', () => {
    expect(caretRight(d, at(1, 10))).toEqual({ block: 1, offset: 11 })
    expect(caretRight(d, at(1, 11))).toEqual({ block: 2, item: 0, offset: 0 })
    expect(caretLeft(d, at(2, 0, 0))).toEqual({ block: 1, offset: 11 })
  })

  it('movement stops at the document ends rather than wrapping', () => {
    expect(caretLeft(d, caretDocStart(d))).toEqual(caretDocStart(d))
    expect(caretRight(d, caretDocEnd(d))).toEqual(caretDocEnd(d))
  })

  it('home and end jump within the slot', () => {
    expect(caretHome(at(1, 5)).offset).toBe(0)
    expect(caretEnd(d, at(1, 0)).offset).toBe(11)
  })

  it('the caret skips a block that has no text', () => {
    // Slot 3 is 'two'; the next slot is 'Last' — the image in between is stepped over.
    expect(caretRight(d, at(2, 3, 1))).toEqual({ block: 4, offset: 0 })
  })
})

describe('designTextEdit — pasting structure', () => {
  it('a single pasted paragraph merges into the caret’s run', () => {
    const { doc: d } = insertBlocks(doc(), collapsed(at(1, 5)), [{ kind: 'paragraph', text: ' THERE' }])
    expect(texts(d)[1]).toBe('Hello THERE world')
  })

  it('a multi-block paste keeps its headings and lists', () => {
    const { doc: d } = insertBlocks(doc(), collapsed(at(1, 11)), [
      { kind: 'paragraph', text: ' tail' },
      { kind: 'heading', level: 1, text: 'Pasted heading' },
      { kind: 'list', ordered: true, items: ['x', 'y'] }
    ])
    expect(d.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'list', 'list', 'image', 'paragraph'])
    expect(texts(d)).toContain('Pasted heading')
    expect(texts(d)).toContain('x')
  })

  it('pasting in the middle of a paragraph keeps the tail as its own paragraph', () => {
    const { doc: d } = insertBlocks(doc(), collapsed(at(1, 5)), [
      { kind: 'paragraph', text: 'A' },
      { kind: 'heading', level: 1, text: 'B' }
    ])
    expect(texts(d)[1]).toBe('HelloA')
    expect(texts(d)[2]).toBe('B')
    expect(texts(d)[3]).toBe(' world')
  })

  it('pasting nothing changes nothing', () => {
    const d = doc()
    expect(insertBlocks(d, collapsed(at(1, 2)), []).doc).toBe(d)
  })

  it('a page break in pasted content is dropped rather than becoming a stray block', () => {
    const { doc: d } = insertBlocks(doc(), collapsed(at(1, 11)), [{ kind: 'pagebreak' }])
    expect(d.blocks.every((b) => b.kind !== 'pagebreak')).toBe(true)
  })
})

describe('designTextEdit — changing a block’s kind', () => {
  it('a paragraph becomes a heading and keeps its words', () => {
    const { doc: d } = setBlockKind(doc(), at(1, 0), 'heading2')
    expect(d.blocks[1]).toEqual({ kind: 'heading', level: 2, text: 'Hello world' })
  })

  it('a paragraph becomes a bullet list of one', () => {
    const { doc: d } = setBlockKind(doc(), at(1, 0), 'bullet')
    expect(d.blocks[1]).toEqual({ kind: 'list', ordered: false, items: ['Hello world'] })
  })

  it('converting one list item splits the list around it', () => {
    const src: ContentDoc = { blocks: [{ kind: 'list', ordered: false, items: ['a', 'b', 'c'] }] }
    const { doc: d } = setBlockKind(src, at(0, 0, 1), 'heading1')
    expect(d.blocks.map((b) => b.kind)).toEqual(['list', 'heading', 'list'])
    expect((d.blocks[0] as { items: string[] }).items).toEqual(['a'])
    expect((d.blocks[2] as { items: string[] }).items).toEqual(['c'])
  })

  it('a heading becomes a quote and back to a paragraph', () => {
    let d = setBlockKind(doc(), at(0, 0), 'quote').doc
    expect(d.blocks[0]).toEqual({ kind: 'quote', text: 'Heading' })
    d = setBlockKind(d, at(0, 0), 'paragraph').doc
    expect(d.blocks[0]).toEqual({ kind: 'paragraph', text: 'Heading' })
  })
})
