// The assistant composer's paste and what the assistant reads (lib/composerPaste,
// lib/mentionDoc). Owner, 2026-11-19: "check the ability to paste into the ai prompt".
//   - a line break (⇧↵, a pasted <br> or <pre> line) is a newline in what is sent;
//   - text with line breaks or tabs, or a table, goes in line by line, blank
//     lines and tabs kept (ProseMirror's HTML reading flattened a spreadsheet
//     range into one line);
//   - a one-line paste is left to the editor (a copied mention chip stays a chip).
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { linesSlice, pastedPlainText, wantsPlainLines } from '../../src/renderer/src/lib/composerPaste'
import { docToInput } from '../../src/renderer/src/lib/mentionDoc'

function composer(): Editor {
  return new Editor({ extensions: [StarterKit.configure({ heading: false, codeBlock: false, link: false })], content: '<p></p>' })
}

describe('what the assistant reads', () => {
  it('a hard break is a newline', () => {
    const e = composer()
    e.commands.setContent('<p>line one<br>line two<br>line three</p>')
    expect(docToInput(e.getJSON()).text).toBe('line one\nline two\nline three')
    e.destroy()
  })

  it('a pasted <pre> keeps its lines', () => {
    const e = composer()
    e.commands.setContent('<p>see:</p>')
    e.commands.insertContentAt(e.state.doc.content.size, '<pre>at foo()\n  at bar()</pre>')
    expect(docToInput(e.getJSON()).text).toContain('at foo()\n  at bar()')
    e.destroy()
  })
})

describe('a multi-line or tabbed paste goes in line by line', () => {
  it('keeps every line, blank lines and tabs', () => {
    const e = composer()
    e.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Here: ' }] }] })
    e.commands.focus('end')
    e.view.dispatch(e.state.tr.replaceSelection(linesSlice(e.state.schema, 'Name\tCity\nAnn\tNYC\n\nBob\tLA\n')))
    expect(docToInput(e.getJSON()).text).toBe('Here: Name\tCity\nAnn\tNYC\n\nBob\tLA')
    e.destroy()
  })

  it('which pastes are taken line by line', () => {
    expect(wantsPlainLines('one line', '')).toBe(false)
    expect(wantsPlainLines('a\nb', '')).toBe(true)
    expect(wantsPlainLines('a\tb', '')).toBe(true)
    expect(wantsPlainLines('A B', '<table><tr><td>A</td><td>B</td></tr></table>')).toBe(true)
  })

  it('a table with no plain text comes in as tab-separated lines', () => {
    expect(pastedPlainText('', '<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>')).toBe('A\tB\n1\t2')
    expect(pastedPlainText('kept', '<table><tr><td>x</td></tr></table>')).toBe('kept')
    expect(pastedPlainText('', '<p>no table</p>')).toBe('')
  })
})
