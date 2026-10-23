// @vitest-environment node
// The shared menu modules (SPEC §9.4): one shortcut format, one lexicon, one
// text-field menu. Plain data, so main and the renderer agree.
import { describe, expect, it } from 'vitest'
import { shortcutLabel } from '../../src/shared/menus/shortcuts'
import { MENU, NEW_DOCUMENT_LABEL, removeFromLabel } from '../../src/shared/menus/lexicon'
import { editableFieldItems } from '../../src/shared/menus/editableField'

describe('shortcutLabel', () => {
  it('macOS: Apple modifier order ⌃⌥⇧⌘, as glyphs, whatever order they were named in', () => {
    expect(shortcutLabel(['shift', 'mod', 'z'], 'darwin')).toBe('⇧⌘Z')
    expect(shortcutLabel(['mod', 'shift', 'z'], 'darwin')).toBe('⇧⌘Z')
    expect(shortcutLabel(['mod', 'alt', 'shift', 'v'], 'darwin')).toBe('⌥⇧⌘V')
    expect(shortcutLabel(['ctrl', 'mod', 'f'], 'darwin')).toBe('⌃⌘F')
    expect(shortcutLabel(['backspace'], 'darwin')).toBe('⌫')
    expect(shortcutLabel(['shift', 'mod', ']'], 'darwin')).toBe('⇧⌘]')
  })
  it('elsewhere: Ctrl+Shift+Key, mod is Ctrl, Ctrl once', () => {
    expect(shortcutLabel(['shift', 'mod', 'z'], 'win32')).toBe('Ctrl+Shift+Z')
    expect(shortcutLabel(['mod', 'alt', 'shift', 'v'], 'linux')).toBe('Ctrl+Alt+Shift+V')
    expect(shortcutLabel(['ctrl', 'mod', 'f'], 'win32')).toBe('Ctrl+F')
    expect(shortcutLabel(['backspace'], 'win32')).toBe('Backspace')
  })
})

describe('the lexicon', () => {
  const labels = [...Object.values(MENU).map((a) => a.label), ...Object.values(NEW_DOCUMENT_LABEL)]
  it('uses the real ellipsis, never "..."', () => {
    expect(labels.filter((l) => l.includes('...'))).toEqual([])
  })
  it('is sentence case (named places and products excepted)', () => {
    const allowed = /\b(Trash|Focus|PlexiiAssist)\b/
    const offenders = labels.filter((l) => l.split(' ').slice(1).some((w) => /^[A-Z][a-z]/.test(w) && !allowed.test(w)))
    expect(offenders).toEqual([])
  })
  it('names the contract’s shared actions the contract’s way', () => {
    expect(MENU.duplicate.label).toBe('Duplicate')
    expect(MENU.delete.label).toBe('Delete')
    expect(MENU.saveAsSnippet.label).toBe('Save selection as snippet…')
    expect(MENU.insertSnippet.label).toBe('Insert snippet…')
    expect(MENU.moveToTrash.label).toBe('Move to Trash')
  })
})

describe('editableFieldItems', () => {
  const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id)
  it('editable, with a selection and something to paste: the full clipboard group, Select all after a separator', () => {
    const xs = editableFieldItems({ hasSelection: true, canPaste: true, isEditable: true }, 'darwin')
    expect(ids(xs)).toEqual(['cut', 'copy', 'paste', 'pasteAsPlainText', 'selectAll'])
    expect(xs.every((x) => x.enabled)).toBe(true)
    expect(xs.find((x) => x.id === 'selectAll')!.separatorBefore).toBe(true)
    expect(xs.find((x) => x.id === 'paste')!.shortcut).toBe('⌘V')
  })
  it('nothing selected: Cut and Copy are off, and say why', () => {
    const xs = editableFieldItems({ hasSelection: false, canPaste: true, isEditable: true }, 'win32')
    const cut = xs.find((x) => x.id === 'cut')!
    expect(cut.enabled).toBe(false)
    expect(cut.hint).toBe('Select some text first')
    expect(cut.shortcut).toBe('Ctrl+X')
  })
  it('Paste as plain text hints the key each platform binds: ⌥⇧⌘V on macOS, Ctrl+Shift+V elsewhere (Chromium)', () => {
    const at = (p: string): string => editableFieldItems({ hasSelection: true, canPaste: true, isEditable: true }, p).find((x) => x.id === 'pasteAsPlainText')!.shortcut
    expect(at('darwin')).toBe('⌥⇧⌘V')
    expect(at('win32')).toBe('Ctrl+Shift+V')
    expect(at('linux')).toBe('Ctrl+Shift+V')
  })
  it('read-only text: no Cut and no Paste at all (absent), Copy and Select all stay', () => {
    expect(ids(editableFieldItems({ hasSelection: true, canPaste: true, isEditable: false }, 'darwin'))).toEqual(['copy', 'selectAll'])
  })
  it('the Plexii group only with a selection, and only when asked for', () => {
    expect(ids(editableFieldItems({ hasSelection: true, canPaste: false, isEditable: true, plexii: true }, 'darwin')).slice(-2)).toEqual(['askAssistAboutThis', 'saveAsSnippet'])
    expect(ids(editableFieldItems({ hasSelection: false, canPaste: false, isEditable: true, plexii: true }, 'darwin'))).not.toContain('askAssistAboutThis')
  })
})

describe('lexicon icons and placements', () => {
  it('carries the §9.3 icon for the shared rows, so every menu draws them alike', () => {
    expect(MENU.cut.icon).toBe('content_cut')
    expect(MENU.duplicate.icon).toBe('control_point_duplicate')
    expect(MENU.bringToFront.icon).toBe('flip_to_front')
    expect(MENU.delete.icon).toBe('delete')
    expect(MENU.open.icon).toBe('open_in_new')
  })
  it('names each placement the way §9.4 says', () => {
    expect(removeFromLabel('desk')).toBe('Remove from this desk')
    expect(removeFromLabel('folder')).toBe('Remove from this folder')
    expect(removeFromLabel('dashboard')).toBe('Remove from this dashboard')
    expect(removeFromLabel('home')).toBe('Remove from Home')
    expect(removeFromLabel('focus')).toBe('Remove from Focus')
  })
})
