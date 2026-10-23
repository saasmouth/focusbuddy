import { describe, it, expect, beforeEach } from 'vitest'
import { filesUndoAction, type UndoKey } from '../../src/renderer/src/lib/filesUndoScope'

const key = (over: Partial<UndoKey> = {}): UndoKey => ({
  key: 'z',
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...over
})

describe('filesUndoAction: ⌘Z belongs to Files only when it should', () => {
  let files: HTMLDivElement
  let row: HTMLDivElement
  let editor: HTMLDivElement
  let input: HTMLInputElement
  beforeEach(() => {
    document.body.innerHTML = ''
    files = document.createElement('div')
    row = document.createElement('div')
    row.tabIndex = 0
    files.appendChild(row)
    input = document.createElement('input')
    files.appendChild(input)
    editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.tabIndex = 0
    document.body.append(files, editor)
  })

  it('focus on a Files row: undo, and ⇧ makes it redo', () => {
    expect(filesUndoAction(key(), { root: files, active: row, fullScreen: false })).toBe('undo')
    expect(filesUndoAction(key({ shiftKey: true }), { root: files, active: row, fullScreen: false })).toBe('redo')
    expect(filesUndoAction(key({ metaKey: false, ctrlKey: true }), { root: files, active: row, fullScreen: false })).toBe('undo')
  })

  it('the panel beside a Write document never takes the document’s undo', () => {
    expect(filesUndoAction(key(), { root: files, active: editor, fullScreen: false })).toBeNull()
    // Even the full view yields to a contentEditable that has focus.
    expect(filesUndoAction(key(), { root: files, active: editor, fullScreen: true })).toBeNull()
  })

  it('a contentEditable INSIDE Files (or the rename input) keeps its own undo', () => {
    const ce = document.createElement('span')
    ce.setAttribute('contenteditable', 'true')
    files.appendChild(ce)
    expect(filesUndoAction(key(), { root: files, active: ce, fullScreen: true })).toBeNull()
    expect(filesUndoAction(key(), { root: files, active: input, fullScreen: true })).toBeNull()
  })

  it('an unfocused press: the full view takes it, the panel does not', () => {
    expect(filesUndoAction(key(), { root: files, active: document.body, fullScreen: true })).toBe('undo')
    expect(filesUndoAction(key(), { root: files, active: document.body, fullScreen: false })).toBeNull()
    expect(filesUndoAction(key(), { root: files, active: null, fullScreen: true })).toBe('undo')
  })

  it('focus somewhere else that is not text (a desk button) is not Files’', () => {
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    expect(filesUndoAction(key(), { root: files, active: btn, fullScreen: true })).toBeNull()
  })

  it('other keys, ⌥⌘Z, and a press already taken are ignored', () => {
    expect(filesUndoAction(key({ key: 'y' }), { root: files, active: row, fullScreen: true })).toBeNull()
    expect(filesUndoAction(key({ metaKey: false }), { root: files, active: row, fullScreen: true })).toBeNull()
    expect(filesUndoAction(key({ altKey: true }), { root: files, active: row, fullScreen: true })).toBeNull()
    expect(filesUndoAction(key({ defaultPrevented: true }), { root: files, active: row, fullScreen: true })).toBeNull()
    expect(filesUndoAction(key({ key: 'Z', shiftKey: true }), { root: files, active: row, fullScreen: true })).toBe('redo')
  })
})
