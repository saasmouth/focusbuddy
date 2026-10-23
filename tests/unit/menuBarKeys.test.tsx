// The keys the shared menu items advertise are bound by the bar itself
// (menuBarKit, SPEC §9.2), so a hint is never a lie:
//  - ⌘/ runs the bar's "Keyboard shortcuts", ahead of App's global ⌘/ sheet;
//  - ⌘F runs its "Find…" and ⇧⌘H its "Find and replace…" (E-14), unless the
//    editor already took the press or the caret is in a form field;
//  - only a key the item itself shows (PlexiiDraw's ⌘/ is Add new fill);
//  - neither fires for a bar that is not on screen (a hidden editor's bar).

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: () => null }))

import { MenuBarShell, type MenuDef } from '../../src/renderer/src/components/documents/editor/menuBarKit'
import { MENU } from '../../src/shared/menus/lexicon'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let visible = true
const shortcuts = vi.fn()
const find = vi.fn()
const replace = vi.fn()
const appGlobal = vi.fn()
const onAppKey = (e: KeyboardEvent): void => {
  if ((e.metaKey || e.ctrlKey) && e.key === '/' && !e.defaultPrevented) appGlobal()
}

let helpShortcut = '⌘/'
const menus: MenuDef[] = [
  {
    id: 'edit',
    label: 'Edit',
    build: () => [
      { kind: 'item', label: MENU.find.label, shortcut: '⌘F', run: find },
      { kind: 'item', label: MENU.findAndReplace.label, shortcut: '⇧⌘H', run: replace }
    ]
  },
  { id: 'help', label: 'Help', build: () => [{ kind: 'item', label: MENU.keyboardShortcuts.label, shortcut: helpShortcut, run: shortcuts }] }
]

const press = (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

beforeEach(() => {
  visible = true
  helpShortcut = '⌘/'
  shortcuts.mockReset()
  find.mockReset()
  replace.mockReset()
  appGlobal.mockReset()
  ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
  // happy-dom lays nothing out; "on screen" is what this test says it is.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => (visible ? [{}] : []) as unknown as DOMRectList)
  // App's global ⌘/ sheet: registered first, on the window, in the bubble phase.
  window.addEventListener('keydown', onAppKey)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<MenuBarShell menus={menus} testid="bar" />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.removeEventListener('keydown', onAppKey)
  vi.restoreAllMocks()
})

describe('menu bar keys', () => {
  it('⌘/ opens this app’s shortcuts, not the global sheet', () => {
    press('/')
    expect(shortcuts).toHaveBeenCalledTimes(1)
    expect(appGlobal).not.toHaveBeenCalled()
  })

  it('⌘F opens Find…, ⇧⌘H Find and replace…', () => {
    expect(press('f').defaultPrevented).toBe(true)
    expect(find).toHaveBeenCalledTimes(1)
    press('H', document.body, { shiftKey: true })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('claims only a key the item shows: a shortcuts item on ⌥⇧⌘K leaves ⌘/ alone', () => {
    helpShortcut = '⌥⇧⌘K'
    act(() => root.render(<MenuBarShell menus={[...menus]} testid="bar" />))
    press('/')
    expect(shortcuts).not.toHaveBeenCalled()
    expect(appGlobal).toHaveBeenCalledTimes(1)
  })

  it('⌘F yields to an editor that already handled it, and to form fields', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    press('f', input)
    const editor = document.createElement('div')
    editor.addEventListener('keydown', (e) => e.preventDefault())
    document.body.appendChild(editor)
    press('f', editor)
    expect(find).not.toHaveBeenCalled()
    input.remove()
    editor.remove()
  })

  it('leaves ⌥⌘F and ⇧⌘F alone (⌥⌘F is Files beside)', () => {
    press('f', document.body, { altKey: true })
    press('F', document.body, { shiftKey: true })
    expect(find).not.toHaveBeenCalled()
  })

  it('a bar that is not on screen answers neither key', () => {
    visible = false
    press('/')
    press('f')
    expect(shortcuts).not.toHaveBeenCalled()
    expect(find).not.toHaveBeenCalled()
    expect(appGlobal).toHaveBeenCalledTimes(1)
  })
})
