// WP1b guard: work widget BODY menus (SPEC §9.3–§9.5, AUDIT M-e, M-f, M-g).
//
// Every menu a body draws or contributes is built by the same function the
// widget calls (components/widgets/bodyMenus.ts), and checked here against the
// contract with its exact groups. The bespoke renderers those builders replaced
// (the table's HeaderContextMenu, the speed deck's SlotContextMenu and
// DeckContextMenu) must not come back, and every text-bearing body must leave a
// right-click on text to the text menu (no preventDefault), which replaced the
// Shift-right-click bypass (E-5).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { expectMenuContract, groupsOf } from './_menuContract'
import type { CtxMenuItem } from '../../src/renderer/src/components/CanvasContextMenu'
import {
  SPEED_DECK_KEYS,
  customWidgetMenuExtras,
  isTextContextTarget,
  mindMapNodeMenuItems,
  speedDeckDeckMenuItems,
  speedDeckKeyAction,
  speedDeckTileMenuItems,
  tableHeaderMenuItems,
  webViewMenuExtras
} from '../../src/renderer/src/components/widgets/bodyMenus'
import { shortcutLabel } from '../../src/shared/menus/shortcuts'

const WIDGETS = join(__dirname, '../../src/renderer/src/components/widgets')
const src = (f: string): string => readFileSync(join(WIDGETS, f), 'utf8')
const noop = (): void => {}
const find = (items: CtxMenuItem[], label: string): CtxMenuItem => {
  const it = items.find((i) => i.label === label)
  if (!it) throw new Error(`no "${label}" in ${JSON.stringify(groupsOf(items))}`)
  return it
}

describe('table column header (was the bespoke HeaderContextMenu)', () => {
  const actions = { insert: vi.fn(), move: vi.fn(), edit: vi.fn(), toggleGroup: vi.fn(), remove: vi.fn() }

  it('object rows, then Delete column last and destructive; Cells’ labels where Cells has the action', () => {
    const items = tableHeaderMenuItems(
      { columnLabel: 'Name', index: 1, columnCount: 3, groupable: true, groupedByThis: false },
      actions
    )
    expectMenuContract(items, {
      groups: [
        ['Insert column left', 'Insert column right', 'Move column left', 'Move column right', 'Edit column…', 'Group rows by this column'],
        ['Delete column']
      ]
    })
    expect(find(items, 'Delete column').danger).toBe(true)
    // A toggle is a check mark, never text.
    expect(find(items, 'Group rows by this column').checked).toBe(false)
    // Insert left / right pick the new column's type in a submenu, and act on it.
    const left = find(items, 'Insert column left')
    expect(left.children?.map((c) => c.label)).toContain('Short text')
    left.children!.find((c) => c.label === 'Number')!.onClick!()
    expect(actions.insert).toHaveBeenCalledWith('left', 'number')
    find(items, 'Move column right').onClick!()
    expect(actions.move).toHaveBeenCalledWith(1)
  })

  it('says why an item is off, and leaves out what cannot apply', () => {
    const first = tableHeaderMenuItems(
      { columnLabel: 'A', index: 0, columnCount: 1, groupable: false, groupedByThis: false },
      actions
    )
    expectMenuContract(first, {
      groups: [
        ['Insert column left', 'Insert column right', 'Move column left', 'Move column right', 'Edit column…'],
        ['Delete column']
      ]
    })
    expect(find(first, 'Move column left')).toMatchObject({ disabled: true, hint: 'Already the first column' })
    expect(find(first, 'Move column right')).toMatchObject({ disabled: true, hint: 'Already the last column' })
    expect(find(first, 'Delete column')).toMatchObject({ disabled: true, hint: 'A table needs at least one column' })
    const grouped = tableHeaderMenuItems(
      { columnLabel: 'A', index: 0, columnCount: 2, groupable: true, groupedByThis: true },
      actions
    )
    expect(find(grouped, 'Group rows by this column').checked).toBe(true)
  })

  it('the table renders the header menu with the kit and the builder, not its own panel', () => {
    const table = src('TableWidget.tsx')
    expect(table).not.toMatch(/function HeaderContextMenu/)
    expect(table).toMatch(/<CanvasContextMenu[\s\S]{0,200}items=\{tableHeaderMenuItems\(/)
    // The header extras no longer end in a stray separator (AUDIT F-10).
    expect(table).not.toMatch(/headerMenuExtras=\{\[[\s\S]*?\{ separator: true \}\s*\]\}/)
  })
})

describe('speed deck (was SlotContextMenu and DeckContextMenu)', () => {
  const tileActions = {
    configure: vi.fn(),
    makeFolder: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn()
  }

  it('a tile with a button: Configure… | Cut · Copy · Paste · Duplicate | Delete', () => {
    const items = speedDeckTileMenuItems({ hasButton: true, hasClipboard: true }, tileActions, 'darwin')
    expectMenuContract(items, { groups: [['Configure…'], ['Cut', 'Copy', 'Paste', 'Duplicate'], ['Delete']] })
    expect(find(items, 'Delete').danger).toBe(true)
    expect(items.filter((i) => !i.separator).map((i) => i.shortcut ?? '')).toEqual(['', '⌘X', '⌘C', '⌘V', '⌘D', ''])
    // Windows / Linux spell the same keys out.
    const win = speedDeckTileMenuItems({ hasButton: true, hasClipboard: true }, tileActions, 'win32')
    expect(find(win, 'Duplicate').shortcut).toBe('Ctrl+D')
  })

  it('an empty slot: Add button… · New folder here | Paste, off with a reason when the clipboard is empty', () => {
    const items = speedDeckTileMenuItems({ hasButton: false, hasClipboard: false }, tileActions, 'darwin')
    expectMenuContract(items, { groups: [['Add button…', 'New folder here'], ['Paste']] })
    expect(find(items, 'Paste')).toMatchObject({ disabled: true, hint: 'Cut or copy a button first' })
  })

  it('shows a hint only for a key the tile really binds, and binds exactly those (§9.4)', () => {
    const items = speedDeckTileMenuItems({ hasButton: true, hasClipboard: true }, tileActions, 'darwin')
    const bound = Object.values(SPEED_DECK_KEYS).map((k) => shortcutLabel(k, 'darwin'))
    for (const it of items) if (it.shortcut) expect(bound).toContain(it.shortcut)
    const key = (k: string, mods: Partial<KeyboardEvent> = {}): Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> => ({
      key: k,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods
    })
    expect(speedDeckKeyAction(key('x', { metaKey: true }), 'darwin')).toBe('cut')
    expect(speedDeckKeyAction(key('c', { metaKey: true }), 'darwin')).toBe('copy')
    expect(speedDeckKeyAction(key('v', { metaKey: true }), 'darwin')).toBe('paste')
    expect(speedDeckKeyAction(key('d', { metaKey: true }), 'darwin')).toBe('duplicate')
    expect(speedDeckKeyAction(key('d', { ctrlKey: true }), 'win32')).toBe('duplicate')
    expect(speedDeckKeyAction(key('d', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(speedDeckKeyAction(key('v', { metaKey: true, shiftKey: true }), 'darwin')).toBeNull()
    expect(speedDeckKeyAction(key('c'), 'darwin')).toBeNull()
    // The widget wires the binding to the same predicate.
    expect(src('StreamDeckWidget.tsx')).toMatch(/onKeyDown=\{\(e\) => \{[\s\S]{0,300}speedDeckKeyAction\(e, menuPlatform\(\)\)/)
  })

  it('the deck background: the deck’s actions, then Reset deck… last and destructive', () => {
    const items = speedDeckDeckMenuItems(
      { editing: false },
      { toggleEditing: noop, copyJson: noop, exportFile: noop, importFile: noop, accessibility: noop, reset: noop }
    )
    expectMenuContract(items, {
      groups: [
        ['Edit buttons', 'Copy deck JSON', 'Export deck to file…', 'Import deck from file…', 'Accessibility permission…'],
        ['Reset deck…']
      ]
    })
    expect(find(items, 'Reset deck…').danger).toBe(true)
    expect(find(items, 'Edit buttons').checked).toBe(false)
  })

  it('the deck renders both menus with the kit, not its own dark-only panels', () => {
    const deck = src('StreamDeckWidget.tsx')
    expect(deck).not.toMatch(/function (SlotContextMenu|DeckContextMenu)/)
    expect(deck).toMatch(/items=\{speedDeckTileMenuItems\(/)
    expect(deck).toMatch(/items=\{speedDeckDeckMenuItems\(/)
    // The tile menu is no longer edit-mode only (it was silent outside it).
    expect(deck).not.toMatch(/onContextMenu=\{\(e\) => \{\s*if \(!editing\) return/)
  })
})

describe('mind-map node (new: a node had no menu of its own)', () => {
  const a = { addChild: noop, addSibling: noop, drillIn: noop, expand: noop, accept: noop, reject: noop, remove: noop }

  it('a node: the tree’s actions, then Delete', () => {
    const items = mindMapNodeMenuItems({ isRoot: false, pending: false, isViewRoot: false, busy: false }, a)
    expectMenuContract(items, { groups: [['Add child', 'Add sibling', 'Zoom into this branch', 'Expand with AI'], ['Delete']] })
    expect(find(items, 'Delete').danger).toBe(true)
  })

  it('the root has no sibling and no Delete; a busy map says why Expand is off; a proposal is Accept / Reject', () => {
    expectMenuContract(mindMapNodeMenuItems({ isRoot: true, pending: false, isViewRoot: true, busy: true }, a), {
      groups: [['Add child', 'Expand with AI']]
    })
    const busy = mindMapNodeMenuItems({ isRoot: true, pending: false, isViewRoot: true, busy: true }, a)
    expect(find(busy, 'Expand with AI')).toMatchObject({ disabled: true, hint: 'Already working on this map' })
    expectMenuContract(mindMapNodeMenuItems({ isRoot: false, pending: true, isViewRoot: false, busy: false }, a), {
      groups: [['Accept', 'Reject']]
    })
    expect(src('MindMapWidget.tsx')).toMatch(/items=\{mindMapNodeMenuItems\(/)
  })
})

describe('rows a body contributes to its work widget menu', () => {
  it('the browser work widget: object rows, no stray separator, Pin to Apps only while it would do something', () => {
    const a = { pinToApps: noop, reload: noop, openFullScreen: noop, changeUrl: noop }
    // "Apps" is a named place in the app, like Focus (reported to 2e for PROPER).
    const allowCase = ['Pin to Apps']
    expectMenuContract(webViewMenuExtras({ hasUrl: true, boundToApp: false }, a), {
      allowCase,
      groups: [['Open full screen', 'Reload', 'Change URL…', 'Pin to Apps']]
    })
    expectMenuContract(webViewMenuExtras({ hasUrl: true, boundToApp: true }, a), {
      groups: [['Open full screen', 'Reload', 'Change URL…']]
    })
    expectMenuContract(webViewMenuExtras({ hasUrl: false, boundToApp: false }, a), { groups: [['Reload', 'Change URL…']] })
  })

  it('the custom work widget: two inline rows, the rest under More actions, toggles as check marks', () => {
    const a = {
      changeWhatItDoes: noop,
      refine: noop,
      save: noop,
      revert: noop,
      toggleSource: noop,
      toggleNet: noop,
      toggleActs: noop,
      startOver: noop,
      library: noop
    }
    const items = customWidgetMenuExtras({ built: true, hasHistory: true, showSource: false, net: true, acts: false }, a)
    expectMenuContract(items, { groups: [['Change what it does…', 'Change this work widget…', 'More actions']] })
    const more = find(items, 'More actions').children!
    expectMenuContract(more, {
      groups: [
        ['Internet access', 'Can make changes', 'Show source'],
        ['Revert to previous version', 'Save to my work widgets…', 'My work widgets…'],
        ['Start over…']
      ]
    })
    expect(find(more, 'Internet access').checked).toBe(true)
    expect(find(more, 'Can make changes').checked).toBe(false)
    expect(find(more, 'Start over…').danger).toBe(true)
    expectMenuContract(customWidgetMenuExtras({ built: false, hasHistory: false, showSource: false, net: false, acts: false }, a), {
      groups: [['My work widgets…']]
    })
  })

  it('a link or file is never passed to the menu as if it were selected text', () => {
    // FileWidget seeded the title / URL, WebViewWidget the URL, as "selection";
    // AI Assist then answered "about this selection" with the address.
    for (const f of ['FileWidget.tsx', 'WebViewWidget.tsx']) {
      expect(src(f), f).not.toMatch(/selectionText:\s*\(?(widget\.title|seed|url|file\?\.originalName)/)
      expect(src(f), f).not.toMatch(/cellText: seed/)
    }
  })
})

describe('text precedence: a right-click on text is the text menu’s (§9.3, E-5)', () => {
  function mount(html: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return host
  }

  it('editable text and a selection are text; controls and plain body chrome are not', () => {
    const host = mount(`
      <textarea id="ta"></textarea>
      <input id="in" />
      <input id="num" type="number" />
      <input id="cb" type="checkbox" />
      <button id="btn">Run</button>
      <div contenteditable="true"><p id="pm">Rich <b id="b">text</b></p></div>
      <div id="chrome"><span id="read">Read-only words</span></div>`)
    const $ = (id: string): HTMLElement => host.querySelector(`#${id}`)!
    window.getSelection()?.removeAllRanges()
    expect(isTextContextTarget($('ta'))).toBe(true)
    expect(isTextContextTarget($('in'))).toBe(true)
    expect(isTextContextTarget($('num'))).toBe(true)
    expect(isTextContextTarget($('b'))).toBe(true) // inside a contenteditable (TipTap, Write)
    expect(isTextContextTarget($('b').firstChild)).toBe(true) // a text node target
    expect(isTextContextTarget($('cb'))).toBe(false)
    expect(isTextContextTarget($('btn'))).toBe(false)
    expect(isTextContextTarget($('read'))).toBe(false)
    // A selection over the read-only words makes a right-click on them text...
    const range = document.createRange()
    range.selectNodeContents($('read'))
    window.getSelection()!.addRange(range)
    expect(isTextContextTarget($('read'))).toBe(true)
    // ...but not a right-click somewhere the selection does not cover.
    expect(isTextContextTarget($('btn'))).toBe(false)
    window.getSelection()?.removeAllRanges()
    host.remove()
  })

  // Each text-bearing body, as the source the app runs: its right-click
  // handlers ask isTextContextTarget before they preventDefault, and none
  // keeps the Shift bypass.
  const TEXT_BODIES: Record<string, number> = {
    'StickyWidget.tsx': 1,
    'NoteWidget.tsx': 1,
    'MarkdownWidget.tsx': 1,
    'PageWidget.tsx': 1,
    'FieldWidget.tsx': 1,
    'FileWidget.tsx': 1,
    'WebViewWidget.tsx': 1,
    'MindMapWidget.tsx': 1,
    'TableWidget.tsx': 3 // a cell, the column header, and the header's own title focus
  }
  for (const [file, n] of Object.entries(TEXT_BODIES)) {
    it(`${file}: every text-reachable handler leaves text alone; no Shift bypass`, () => {
      const s = src(file)
      expect(s).not.toMatch(/if \(e\.shiftKey\) return/)
      expect(s).not.toMatch(/Shift-right-click|Shift bypass/)
      expect((s.match(/isTextContextTarget\(/g) ?? []).length).toBeGreaterThanOrEqual(n)
      // In each onContextMenu handler that asks, the question comes before the preventDefault.
      const handlers = s.split('onContextMenu={').slice(1).map((h) => h.slice(0, 600))
      for (const h of handlers) {
        const ask = h.indexOf('isTextContextTarget(')
        const prevent = h.indexOf('preventDefault()')
        if (ask >= 0 && prevent >= 0) expect(ask, `${file}: preventDefault before the text check`).toBeLessThan(prevent)
      }
    })
  }
})
