// The registry that decides which surface answers the app window's text-menu
// Plexii rows (renderer lib/textMenuHandlers.ts, shared/textMenu.ts).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerTextMenuHandler, textMenuCaps, textMenuQuery, dispatchTextMenuCommand, installTextMenuQuery } from '../../src/renderer/src/lib/textMenuHandlers'
import { TEXT_MENU_QUERY, type TextMenuCommand } from '../../src/shared/textMenu'

const offs: Array<() => void> = []
afterEach(() => {
  while (offs.length) offs.pop()!()
  document.body.innerHTML = ''
})
const cmd = (action: TextMenuCommand['action'], selectionText = 'words'): TextMenuCommand => ({ action, selectionText, isEditable: true })

function tree(): { outer: HTMLElement; inner: HTMLElement; field: HTMLElement; other: HTMLElement } {
  document.body.innerHTML = '<div id="outer"><div id="inner"><textarea id="field"></textarea></div></div><input id="other">'
  const q = (id: string): HTMLElement => document.getElementById(id)!
  return { outer: q('outer'), inner: q('inner'), field: q('field'), other: q('other') }
}

describe('text menu handlers', () => {
  it('no surface registered: the generic ask route, no snippet row', () => {
    const { other } = tree()
    expect(textMenuCaps(other)).toEqual({ askAssist: true, saveSnippet: false })
    const ask = vi.fn()
    dispatchTextMenuCommand(cmd('askAssist', '  hello '), ask, other)
    expect(ask).toHaveBeenCalledWith('hello')
  })

  it('the innermost registered element answers; a snippet handler makes the row appear and receives the command', () => {
    const { outer, inner, field, other } = tree()
    const outerSave = vi.fn()
    const innerSave = vi.fn()
    const innerAsk = vi.fn()
    offs.push(registerTextMenuHandler(outer, { saveSnippet: outerSave }))
    offs.push(registerTextMenuHandler(inner, { askAssist: innerAsk, saveSnippet: innerSave }))
    expect(textMenuCaps(field)).toEqual({ askAssist: true, saveSnippet: true })
    expect(textMenuCaps(other)).toEqual({ askAssist: true, saveSnippet: false })
    const fallback = vi.fn()
    dispatchTextMenuCommand(cmd('saveSnippet'), fallback, field)
    dispatchTextMenuCommand(cmd('askAssist'), fallback, field)
    expect(innerSave).toHaveBeenCalledTimes(1)
    expect(innerAsk).toHaveBeenCalledTimes(1)
    expect(outerSave).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('askAssist: false hides the row and swallows nothing else; unregistering restores the default', () => {
    const { inner, field } = tree()
    const off = registerTextMenuHandler(inner, { askAssist: false })
    expect(textMenuCaps(field)).toEqual({ askAssist: false, saveSnippet: false })
    const fallback = vi.fn()
    dispatchTextMenuCommand(cmd('askAssist'), fallback, field)
    expect(fallback).not.toHaveBeenCalled()
    off()
    expect(textMenuCaps(field)).toEqual({ askAssist: true, saveSnippet: false })
  })

  it('a predicate target, and the page-global query main calls', () => {
    const { field } = tree()
    offs.push(registerTextMenuHandler((el) => el.id === 'field', { saveSnippet: () => undefined }))
    installTextMenuQuery()
    field.focus()
    const q = (window as unknown as Record<string, () => unknown>)[TEXT_MENU_QUERY]!
    expect(q()).toMatchObject({ askAssist: true, saveSnippet: true })
  })

  it('selectedBefore: a selection made before the right-button press counts; one the press made (macOS word select) does not', () => {
    document.body.innerHTML = '<p id="p">Some read-only words</p>'
    installTextMenuQuery()
    const p = document.getElementById('p')!
    window.getSelection()!.removeAllRanges()
    p.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }))
    expect(textMenuQuery().selectedBefore).toBe(false)
    const r = document.createRange()
    r.selectNodeContents(p)
    window.getSelection()!.addRange(r)
    p.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }))
    expect(textMenuQuery().selectedBefore).toBe(true)
  })
})
