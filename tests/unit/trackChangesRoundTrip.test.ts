import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import * as Y from 'yjs'
import { buildDocExtensions } from '../../src/renderer/src/components/documents/editor/extensions'
import type { PmNode } from '../../src/renderer/src/lib/trackChanges'

// Help audit: Docs Suggesting → "Accept all" left suggestions behind as plain
// underline / strikethrough. Cause: the suggestion marks rendered an inline
// `text-decoration` style, which the Underline and Strike extensions parse, so
// any HTML round trip gave each suggestion a second, ordinary mark that
// accept/reject never touched. These drive the real document schema (the full
// extension set the editor uses, with and without collaboration).

function typeLikeAPerson(ed: Editor, s: string): void {
  // One transaction per keystroke, as a human produces, each stamped separately.
  for (const ch of s) ed.view.dispatch(ed.state.tr.insertText(ch))
}

function marksOf(json: PmNode): string[] {
  const out: string[] = []
  const walk = (n: PmNode): void => {
    if (n.type === 'text') for (const m of n.marks ?? []) out.push(m.type)
    n.content?.forEach(walk)
  }
  walk(json)
  return out
}

function textOf(json: PmNode): string {
  if (json.type === 'text') return json.text ?? ''
  return (json.content ?? []).map(textOf).join('')
}

function suggest(collab: boolean): Editor {
  const ydoc = new Y.Doc()
  const ed = new Editor({
    extensions: buildDocExtensions({ interactive: false, collab: collab ? ydoc : undefined }) as never,
    ...(collab ? {} : { content: '<p>Hello world</p>' })
  })
  if (collab) ed.commands.setContent('<p>Hello world</p>')
  ed.commands.setSuggesting(true)
  ed.commands.setTextSelection(6)
  typeLikeAPerson(ed, ' big')
  ed.commands.setTextSelection(ed.state.doc.content.size - 1)
  // Through the view's real keydown path: editor.commands.keyboardShortcut
  // replays only the handler's steps, not the caret move it makes.
  for (let i = 0; i < 3; i++) {
    ed.view.someProp('handleKeyDown', (f) => f(ed.view, new KeyboardEvent('keydown', { key: 'Backspace' })))
  }
  return ed
}

function reopen(html: string): Editor {
  return new Editor({ extensions: buildDocExtensions({ interactive: false }) as never, content: html })
}

describe('Track Changes survive an HTML round trip', () => {
  for (const collab of [false, true]) {
    it(`renders suggestions without an inline text-decoration (collab=${collab})`, () => {
      const html = suggest(collab).getHTML()
      expect(html).toContain('<ins')
      expect(html).toContain('<del')
      expect(html).not.toMatch(/text-decoration/)
    })

    it(`a reopened document carries only the suggestion marks (collab=${collab})`, () => {
      const ed = reopen(suggest(collab).getHTML())
      const marks = marksOf(ed.getJSON() as PmNode)
      expect(marks).toContain('insertion')
      expect(marks).toContain('deletion')
      expect(marks).not.toContain('underline')
      expect(marks).not.toContain('strike')
    })

    it(`Accept all after a round trip leaves clean text (collab=${collab})`, () => {
      const ed = reopen(suggest(collab).getHTML())
      ed.commands.acceptAllChanges()
      const json = ed.getJSON() as PmNode
      expect(textOf(json)).toBe('Hello big wo')
      expect(marksOf(json)).toEqual([])
    })

    it(`Reject all after a round trip restores the original (collab=${collab})`, () => {
      const ed = reopen(suggest(collab).getHTML())
      ed.commands.rejectAllChanges()
      const json = ed.getJSON() as PmNode
      expect(textOf(json)).toBe('Hello world')
      expect(marksOf(json)).toEqual([])
    })
  }

  it('cleans documents already saved by the old styled-span renderer', () => {
    const legacy =
      '<p>Hello<span data-author="You" data-color="#2563eb" class="tc-insert" style="text-decoration: underline; text-decoration-color: #2563eb;"> big</span> worl' +
      '<span data-author="You" data-color="#2563eb" class="tc-delete" style="text-decoration: line-through; text-decoration-color: #2563eb;">d</span></p>'
    const accept = reopen(legacy)
    accept.commands.acceptAllChanges()
    expect(textOf(accept.getJSON() as PmNode)).toBe('Hello big worl')
    expect(marksOf(accept.getJSON() as PmNode)).toEqual([])

    const reject = reopen(legacy)
    reject.commands.rejectAllChanges()
    expect(textOf(reject.getJSON() as PmNode)).toBe('Hello world')
    expect(marksOf(reject.getJSON() as PmNode)).toEqual([])
  })

  it('striking already-struck text does not nest a second deletion mark', () => {
    const ed = reopen('<p>Hello world</p>')
    ed.commands.setSuggesting(true)
    ed.commands.setTextSelection({ from: 7, to: 12 })
    ed.view.someProp('handleKeyDown', (f) => f(ed.view, new KeyboardEvent('keydown', { key: 'Backspace' })))
    ed.commands.setTextSelection({ from: 7, to: 12 })
    ed.view.someProp('handleKeyDown', (f) => f(ed.view, new KeyboardEvent('keydown', { key: 'Backspace' })))
    expect(ed.getHTML()).not.toMatch(/<del[^>]*><del/)
  })

  it('keeps an underline the author really added to a current-format suggestion', () => {
    const ed = reopen('<p>Hi <ins class="tc-insert" data-author="A"><u>there</u></ins></p>')
    ed.commands.acceptAllChanges()
    expect(marksOf(ed.getJSON() as PmNode)).toEqual(['underline'])
  })
})
