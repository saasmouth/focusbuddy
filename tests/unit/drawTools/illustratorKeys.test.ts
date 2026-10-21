// WP-KEYS: PlexiiDraw's keys are Illustrator's defaults. This holds the
// keymap, the tools' keys and the reserved list to Adobe's published table
// (commands/illustratorKeys.ts), and drives every new binding through the real
// editor.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ILLUSTRATOR_SHORTCUTS } from '../../../src/renderer/src/components/documents/draw/commands/illustratorKeys'
import {
  KEYMAP,
  RESERVED_KEYS
} from '../../../src/renderer/src/components/documents/draw/commands/keymap'
import {
  baseKey,
  checkRemap,
  commandShortcutLabel,
  effectiveKeymap,
  eventKeyString,
  formatKey,
  keyOverrides,
  OVERRIDES_STORAGE_KEY,
  parseKeyString,
  reloadKeyOverrides,
  resolveKey,
  setKeyOverrides,
  setKeyPlatform,
  toolKeyString,
  toolShortcutLabel
} from '../../../src/renderer/src/components/documents/draw/commands/keys'
import {
  changeNote,
  dismissNotice,
  KEY_CHANGES,
  NOTICE_STORAGE_KEY,
  noticeDismissed
} from '../../../src/renderer/src/components/documents/draw/commands/keyChanges'
import {
  arrivesWith,
  filterRows,
  shortcutRows
} from '../../../src/renderer/src/components/documents/draw/commands/keyCatalog'
import {
  commandById,
  commandRegistryProblems,
  drawCommands,
  withoutReplacedPending
} from '../../../src/renderer/src/components/documents/draw/commands/registry'
import {
  drawTools,
  toolRegistryProblems
} from '../../../src/renderer/src/components/documents/draw/tools/registry'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import type { Command } from '../../../src/renderer/src/components/documents/draw/editor/types'
import { blank, harness, rect } from './harness'

const ev = (
  key: string,
  m: { code?: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}
) => ({
  key,
  code: m.code,
  metaKey: !!m.meta,
  ctrlKey: !!m.ctrl,
  altKey: !!m.alt,
  shiftKey: !!m.shift
})

const toolKeyOf = (id: string): string | null =>
  toolKeyString(drawTools().find((t) => t.id === id)?.key)

beforeEach(() => {
  setKeyPlatform('mac')
  localStorage.clear()
  reloadKeyOverrides()
})
afterEach(() => {
  setKeyOverrides({ commands: {}, tools: {} })
  setKeyPlatform('mac')
})

describe("the keymap is Illustrator's published table", () => {
  const global = ILLUSTRATOR_SHORTCUTS.filter((r) => r.context === 'global')

  it('holds every row of the page, cited, with its source on record', () => {
    // 373 distinct rows on the 2026-10-15 capture, plus Fit Artboard in Window from the View menu.
    expect(ILLUSTRATOR_SHORTCUTS).toHaveLength(374)
    expect(new Set(ILLUSTRATOR_SHORTCUTS.map((r) => r.section))).toEqual(
      new Set([
        'Popular shortcuts',
        'Work with documents',
        'Select tools',
        'View artwork',
        'Work with selections',
        'Draw',
        'Edit shapes',
        'Work with Live Paint groups',
        'Work with objects',
        'Create variable width points',
        'Work with type',
        'Use panels',
        'Actions panel',
        'Brushes panel',
        'Character and Paragraph panels',
        'Color panel',
        'Gradient panel',
        'Layers panel',
        'Swatches panel',
        'Transform panel',
        'Transparency panel',
        'Function keys',
        'View menu'
      ])
    )
    const src = readFileSync(
      join(__dirname, '../../../src/renderer/src/components/documents/draw/commands/keymap.ts'),
      'utf8'
    )
    expect(src).toContain(
      'https://helpx.adobe.com/illustrator/using/default-keyboard-shortcuts.html'
    )
    // Every row outside the page says where it comes from.
    for (const r of ILLUSTRATOR_SHORTCUTS.filter((x) => x.section === 'View menu'))
      expect(r.source).toBeTruthy()
  })

  it('every one of the 41 tool keys on the page is a tool here or reserved for the tool still to come', () => {
    const tools = ILLUSTRATOR_SHORTCUTS.filter(
      (r) => r.section === 'Select tools' && r.context === 'global'
    )
    expect(tools).toHaveLength(41)
    for (const r of tools) {
      const [kind, id] = r.target!.startsWith('res:')
        ? ['res', r.target!.slice(4)]
        : r.target!.split(':')
      if (kind === 'tool') expect(toolKeyOf(id), r.action).toBe(r.key)
      else expect(RESERVED_KEYS[r.key!]?.[0], r.action).toBe(id)
    }
  })

  it('every canvas chord on the page is bound to its command, a tool key, reserved, or left to the app', () => {
    expect(global.length).toBeGreaterThan(180)
    for (const r of global) {
      const keys = [r.key!, ...(r.winKey ? [r.winKey] : [])]
      for (const k of keys) {
        const t = r.target!
        if (t.startsWith('cmd:')) expect(KEYMAP[k]?.[0], `${r.action} (${k})`).toBe(t.slice(4))
        else if (t.startsWith('tool:')) expect(toolKeyOf(t.slice(5)), r.action).toBe(k)
        else if (t.startsWith('res:'))
          expect(RESERVED_KEYS[k]?.[0], `${r.action} (${k})`).toBe(t.slice(4))
        else {
          expect(t, r.action).toBe('app')
          expect(KEYMAP[k], r.action).toBeUndefined()
          expect(RESERVED_KEYS[k], r.action).toBeUndefined()
        }
      }
    }
  })

  it('no binding gives an Illustrator key a different meaning', () => {
    const meaning = new Map<string, string>()
    for (const r of global) meaning.set(r.key!, r.target!)
    for (const [k, [id]] of Object.entries(KEYMAP)) {
      const t = meaning.get(k)
      if (t) expect(t, k).toBe(`cmd:${id}`)
    }
    for (const t of drawTools()) {
      const k = toolKeyString(t.key)
      const m = k ? meaning.get(k) : undefined
      if (m) expect(m, t.id).toBe(`tool:${t.id}`)
    }
  })

  it('every reserved key comes from the page (numpad + is the one alias), names an id, a label and a package', () => {
    const pageKeys = new Set(global.flatMap((r) => [r.key, r.winKey]).filter(Boolean))
    for (const [k, [id, label, pkg]] of Object.entries(RESERVED_KEYS)) {
      if (k !== 'shift+=') expect(pageKeys.has(k), k).toBe(true)
      expect(id).toMatch(/^(tool:)?[a-z]+[.A-Za-z:]*$/)
      expect(label.length).toBeGreaterThan(2)
      expect(pkg).toMatch(/^(WP-[A-Z-]+|-)$/)
    }
    // Main-row Shift+= is the Add Anchor Point tool's second key (its own key is numpad +).
    expect(RESERVED_KEYS['shift+=']?.[0]).toBe('tool:addAnchor')
    expect(toolKeyOf('addAnchor')).toBe('+')
    const keys = Object.keys(RESERVED_KEYS)
    expect(keys).toEqual([...keys].sort())
    for (const k of keys) expect(KEYMAP[k], k).toBeUndefined()
  })

  it('the registry reports a reserved key bound to the wrong thing', () => {
    expect(commandRegistryProblems()).toEqual([])
    expect(toolRegistryProblems()).toEqual([])
    const [a] = drawTools()
    expect(toolRegistryProblems([{ ...a, key: 'Ctrl+V' }])).toEqual([
      'shortcut "Ctrl+V" of select is not one key or Shift with one key'
    ])
  })

  it('the tools carry Illustrator’s keys: M, L, \\, Shift+E, K, and WP-PATH’s Q, Shift+~, +, -, Shift+C, C; Rounded rectangle, Polygon, Star, Knife, Smooth, Path Eraser and Join none', () => {
    expect(drawTools().filter((t) => !t.hidden).map((t) => `${t.id}:${t.key ?? ''}`)).toEqual([
      'select:V',
      'groupSelect:',
      'direct:A',
      'lasso:Q',
      'pen:P',
      'curvature:Shift+`',
      'addAnchor:+',
      'deleteAnchor:-',
      'anchorConvert:Shift+C',
      'scissors:C',
      'knife:',
      'pencil:N',
      'smooth:',
      'pathEraser:',
      'join:',
      'rect:M',
      'roundRect:',
      'ellipse:L',
      'polygon:',
      'star:',
      'line:\\',
      'text:T',
      'rotate:R',
      'reflect:O',
      'scale:S',
      'shear:',
      'reshape:',
      'freeTransform:E',
      'brush:B',
      'eraser:Shift+E',
      'bucket:K',
      'eyedropper:I',
      'artboard:Shift+O',
      'hand:H'
    ])
  })
})

describe('reading a key press', () => {
  it('names the physical key whatever the layout or modifier types', () => {
    expect(eventKeyString(ev('∂', { code: 'KeyD', alt: true, meta: true }))).toBe('mod+alt+d') // ⌥⌘D on a Mac
    expect(eventKeyString(ev('}', { code: 'BracketRight', shift: true, meta: true }))).toBe(
      'mod+shift+]'
    )
    expect(eventKeyString(ev('&', { code: 'Digit1', ctrl: true }))).toBe('mod+1') // AZERTY Ctrl+1
    expect(eventKeyString(ev('a', { code: 'KeyQ' }))).toBe('a') // AZERTY A sits on the Q key
    expect(eventKeyString(ev('Z', { code: 'KeyZ', shift: true, ctrl: true }))).toBe('mod+shift+z')
    expect(eventKeyString(ev('+', { code: 'Equal', shift: true }))).toBe('shift+=')
    expect(eventKeyString(ev('+', { code: 'NumpadAdd' }))).toBe('+')
    expect(eventKeyString(ev('"', { code: 'Quote', shift: true, meta: true }))).toBe("mod+shift+'")
    expect(eventKeyString(ev('|', { code: 'Backslash', shift: true }))).toBe('shift+\\')
    expect(eventKeyString(ev('Dead', { code: 'KeyE', alt: true }))).toBe('alt+e')
    expect(eventKeyString(ev('F1', { code: 'F1' }))).toBe('f1')
    expect(eventKeyString(ev('ArrowLeft', { code: 'ArrowLeft', shift: true }))).toBe(
      'shift+arrowleft'
    )
    expect(baseKey({ key: ' ', code: 'Space' })).toBe('space')
    expect(parseKeyString('mod+alt+shift++')).toEqual({
      mod: true,
      alt: true,
      shift: true,
      key: '+'
    })
  })

  it('writes keys the way each platform does', () => {
    expect(formatKey('mod+alt+shift+k', 'mac')).toBe('⌥⇧⌘K')
    expect(formatKey('mod+alt+shift+k', 'win')).toBe('Alt+Shift+Ctrl+K')
    expect(formatKey('shift+e', 'mac')).toBe('⇧E')
    expect(formatKey('shift+e', 'win')).toBe('Shift+E')
    expect(formatKey('\\', 'win')).toBe('\\')
    expect(formatKey("mod+'", 'mac')).toBe("⌘'")
    expect(formatKey('backspace', 'mac')).toBe('⌫')
    expect(formatKey('delete', 'win')).toBe('Del')
    expect(formatKey('f1', 'win')).toBe('F1')
    expect(formatKey('arrowup', 'mac')).toBe('↑')
  })

  it('a key Illustrator reserves does nothing, and never falls through to the plain letter', () => {
    expect(resolveKey(ev('M', { shift: true }))).toMatchObject({
      kind: 'reserved',
      id: 'tool:shapeBuilder'
    })
    expect(resolveKey(ev('m'))).toEqual({ kind: 'tool', id: 'rect' })
    expect(resolveKey(ev('H', { shift: true }))).toEqual({ kind: 'tool', id: 'hand' }) // Shift+H is nothing in Illustrator
    expect(resolveKey(ev('ArrowLeft', { alt: true, shift: true }))).toMatchObject({
      kind: 'command',
      id: 'object.nudgeLeft'
    })
    expect(resolveKey(ev('b', { code: 'KeyB', meta: true, alt: true }))).toMatchObject({
      kind: 'reserved',
      id: 'object.blendMake'
    })
    expect(resolveKey(ev('Dead', { code: 'KeyD', alt: true, meta: true }))).toBeNull()
  })
})

describe('the keys, in the editor', () => {
  it('M, L, \\, Shift+E and K pick Rectangle, Ellipse, Line, Eraser and Paint bucket; R, O, S, U, G and E pick nothing', () => {
    const picks: Array<[string, { shift?: boolean; code?: string }, string]> = [
      ['m', {}, 'rect'],
      ['l', {}, 'ellipse'],
      ['\\', { code: 'Backslash' }, 'line'],
      ['E', { shift: true, code: 'KeyE' }, 'eraser'],
      ['k', {}, 'bucket']
    ]
    for (const [key, m, tool] of picks) {
      const h = harness()
      h.key(key, m)
      expect(h.state().tool, key).toBe(tool)
    }
    // R, O, S and E are WP-TRANSFORM's Rotate, Reflect, Scale and Free Transform.
    for (const [key, tool] of [['r', 'rotate'], ['o', 'reflect'], ['s', 'scale'], ['e', 'freeTransform']]) {
      const h = harness()
      h.key(key)
      expect(h.state().tool, key).toBe(tool)
    }
    for (const key of ['u', 'g', 'd']) {
      const h = harness()
      h.key(key)
      expect(h.state().tool, key).toBe('select')
    }
  })

  it('⌘D is Transform Again (WP-TRANSFORM): with nothing transformed yet it duplicates nothing, and Duplicate stays in the Edit menu', () => {
    const h = harness(blank([rect('a', 10, 10, 20, 20)]))
    h.ed.ctx.select(['a'])
    expect(h.key('d', { meta: true }).prevented).toBe(true)
    expect(h.objects()).toHaveLength(1)
    expect(h.state().past).toHaveLength(0)
    h.run('edit.duplicate')
    expect(h.objects()).toHaveLength(2)
    const transform = buildMenu(h.ed.ctx, 'object').find((i) => i.kind === 'submenu' && i.label === 'Transform')
    expect(transform && transform.kind === 'submenu' && transform.items[0]).toMatchObject({
      kind: 'item',
      label: 'Transform Again',
      shortcut: '⌘D',
      disabled: true
    })
  })

  it('the real Transform again replaces the stand-in with no edit anywhere', () => {
    const stand: Command = {
      id: 'object.transformAgain',
      label: 'x',
      pending: 'later',
      enabled: () => false,
      run: () => {}
    }
    const real: Command = { id: 'object.transformAgain', label: 'Transform Again', run: () => {} }
    expect(withoutReplacedPending([stand, real])).toEqual([real])
    expect(withoutReplacedPending([stand])).toEqual([stand])
    // WP-TRANSFORM delivered it: the registry holds the real one.
    expect(commandById('object.transformAgain')?.pending).toBeUndefined()
    expect(commandById('object.transformAgain')?.label).toBe('Transform Again')
  })

  it('⌘Y no longer redoes (it is Outline view in Illustrator); ⇧⌘Z does', () => {
    const h = harness(blank([rect('a', 10, 10, 20, 20)]))
    h.ed.ctx.select(['a'])
    h.key('ArrowRight')
    h.key('z', { meta: true })
    h.key('y', { meta: true })
    expect(h.state().future).toHaveLength(1)
    h.key('z', { meta: true, shift: true })
    expect(h.state().future).toHaveLength(0)
  })

  it('⌘] ⌘[ ⇧⌘] ⇧⌘[ arrange; ⇧⌘A deselects', () => {
    const h = harness(
      blank([rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10), rect('c', 0, 0, 10, 10)])
    )
    const order = (): string =>
      h
        .objects()
        .map((o) => o.id)
        .join('')
    h.ed.ctx.select(['a'])
    h.key(']', { meta: true, code: 'BracketRight' })
    expect(order()).toBe('bac')
    h.key('}', { meta: true, shift: true, code: 'BracketRight' })
    expect(order()).toBe('bca')
    h.key('[', { meta: true, code: 'BracketLeft' })
    expect(order()).toBe('bac')
    h.key('{', { meta: true, shift: true, code: 'BracketLeft' })
    expect(order()).toBe('abc')
    expect(h.state().past).toHaveLength(4)
    h.key('A', { meta: true, shift: true, code: 'KeyA' })
    expect(h.state().selection).toEqual([])
  })

  it("⌘= ⌘- zoom, ⌘0 fits, ⌘1 is 100%, ⌘' grid, ⌘U smart guides, ⌘L a layer, F1 help, ⌥⇧⌘K the shortcuts", () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.key('=', { meta: true, code: 'Equal' })
    expect(h.state().zoom).toBeCloseTo(1.25)
    h.key('-', { meta: true, code: 'Minus' })
    h.key('-', { meta: true, code: 'Minus' })
    expect(h.state().zoom).toBeCloseTo(0.8)
    h.key('1', { meta: true, code: 'Digit1' })
    expect(h.state().zoom).toBe(1)
    h.ed.store.setState({ zoom: 3 })
    h.key('0', { meta: true, code: 'Digit0' })
    expect(h.state().zoom).toBe(1) // the harness viewport fits to 1
    h.key('+', { meta: true, shift: true, code: 'Equal' }) // ⌘+ (Shift+=) zooms too
    expect(h.state().zoom).toBeCloseTo(1.25)
    const grid = h.state().showGrid
    h.key("'", { meta: true, code: 'Quote' })
    expect(h.state().showGrid).toBe(!grid)
    const snap = h.state().snapOn
    h.key('u', { meta: true })
    expect(h.state().snapOn).toBe(!snap)
    const layers = h.doc().layers.length
    h.key('l', { meta: true })
    expect(h.doc().layers.length).toBe(layers + 1)
    h.key('F1', { code: 'F1' })
    expect(h.state().dialog).toEqual({ id: 'help' })
    h.ed.store.setState({ dialog: null })
    h.key('˚', { meta: true, alt: true, shift: true, code: 'KeyK' })
    expect(h.state().dialog).toEqual({ id: 'keyboard-shortcuts' })
  })

  it('Windows: Ctrl is the modifier, and the menus say so', () => {
    setKeyPlatform('win')
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.key('u', { ctrl: true })
    expect(h.state().snapOn).toBe(false)
    const edit = buildMenu(h.ed.ctx, 'edit')
    expect(
      edit
        .filter((i) => i.kind === 'item')
        .map((i) => (i.kind === 'item' ? `${i.label}=${i.shortcut ?? ''}` : ''))
    ).toEqual([
      'Undo=Ctrl+Z',
      'Redo=Shift+Ctrl+Z',
      // Cut, Copy and Paste also have F2, F3 and F4; the menu names the Ctrl chord.
      'Cut=Ctrl+X',
      'Copy=Ctrl+C',
      'Paste=Ctrl+V',
      'Paste in Front=Ctrl+F',
      'Paste in Back=Ctrl+B',
      'Paste in Place=Shift+Ctrl+V',
      'Paste on All Artboards=Alt+Shift+Ctrl+V',
      'Duplicate=',
      'Delete=Del',
      'Select all=Ctrl+A',
      'Deselect=Shift+Ctrl+A',
      'Select all on active artboard=Alt+Ctrl+A',
      'Keyboard shortcuts…=Alt+Shift+Ctrl+K'
    ])
    expect(toolShortcutLabel('eraser')).toBe('Shift+E')
  })

  it('no key fires while text is being edited on the canvas, even with focus off the text box; Escape still ends it', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.ed.store.setState({ editingText: 'a' })
    for (const [k, m] of [
      ['m', {}],
      ['Delete', {}],
      ['d', { meta: true }],
      ['a', { meta: true }]
    ] as const)
      h.key(k, m)
    expect(h.state().tool).toBe('select')
    expect(h.objects()).toHaveLength(1)
    expect(h.state().selection).toEqual(['a'])
    h.key('Escape')
    expect(h.state().selection).toEqual([])
  })

  it('keys typed into a field stay in the field', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    for (const k of ['m', 'l', 'Backspace']) h.key(k, { inField: true })
    h.key('a', { meta: true, shift: true, inField: true })
    expect(h.state().tool).toBe('select')
    expect(h.state().selection).toEqual(['a'])
  })

  it('an open dialog owns the keyboard, and Escape closes it', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.store.setState({ dialog: { id: 'keyboard-shortcuts' } })
    h.key('m')
    h.key('Delete')
    expect(h.state().tool).toBe('select')
    h.key('Escape')
    expect(h.state().dialog).toBeNull()
  })

  it('read-only: the view keys and Deselect work, editing keys and drawing tools do not', () => {
    const h = harness({ ...blank([rect('a', 0, 0, 10, 10)]), schemaVersion: 3 })
    h.key('a', { meta: true })
    expect(h.state().selection).toEqual(['a'])
    h.key('A', { meta: true, shift: true, code: 'KeyA' })
    expect(h.state().selection).toEqual([])
    h.key('=', { meta: true, code: 'Equal' })
    expect(h.state().zoom).toBeCloseTo(1.25)
    h.key('m')
    h.key('l', { meta: true })
    expect(h.state().tool).toBe('select')
    expect(h.doc().layers).toHaveLength(1)
    h.key('h')
    expect(h.state().tool).toBe('hand')
    expect(h.emitted).toHaveLength(0)
  })
})

describe('changing a key (per profile)', () => {
  it('a remapped tool key works, the old one stops, and it survives a reload from storage', () => {
    setKeyOverrides({ commands: {}, tools: { rect: 'r' } })
    let h = harness()
    h.key('r')
    expect(h.state().tool).toBe('rect')
    h = harness()
    h.key('m')
    expect(h.state().tool).toBe('select')
    expect(JSON.parse(localStorage.getItem(OVERRIDES_STORAGE_KEY)!)).toEqual({
      commands: {},
      tools: { rect: 'r' }
    })
    reloadKeyOverrides()
    expect(keyOverrides().tools).toEqual({ rect: 'r' })
    expect(toolShortcutLabel('rect')).toBe('R')
  })

  it('a command can take a new key or none, and the menu shows it', () => {
    setKeyOverrides({ commands: { 'edit.duplicate': 'mod+alt+d', 'edit.undo': null }, tools: {} })
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('∂', { meta: true, alt: true, code: 'KeyD' })
    expect(h.objects()).toHaveLength(2)
    h.key('z', { meta: true })
    expect(h.objects()).toHaveLength(2)
    expect(commandShortcutLabel('edit.duplicate')).toBe('⌥⌘D')
    expect(commandShortcutLabel('edit.undo')).toBeNull()
  })

  it('a clash is refused, app keys are refused, a reserved Illustrator key comes with a note', () => {
    const describe = (t: { kind: string; id: string }): string => `${t.kind}:${t.id}`
    expect(checkRemap('tool', 'rect', 'v', describe).error).toBe(
      'V is already used by tool:select.'
    )
    expect(checkRemap('command', 'edit.duplicate', 'mod+z', describe).error).toBe(
      '⌘Z is already used by command:edit.undo.'
    )
    expect(checkRemap('command', 'edit.duplicate', 'mod+q', describe).error).toMatch(
      /kept for the app/
    )
    expect(checkRemap('tool', 'rect', 'mod+alt+j', describe).error).toMatch(/single key/)
    expect(checkRemap('tool', 'rect', 'shift', describe).error).toMatch(/Press a key/)
    expect(checkRemap('tool', 'rect', 'm', describe)).toEqual({})
    expect(checkRemap('command', 'edit.duplicate', 'mod+alt+b', describe)).toEqual({
      note: 'Illustrator uses ⌥⌘B for Blend objects, which PlexiiDraw does not have yet.'
    })
  })

  it('storage that is missing or corrupt means the defaults', () => {
    localStorage.setItem(OVERRIDES_STORAGE_KEY, '{nope')
    reloadKeyOverrides()
    expect(keyOverrides()).toEqual({ commands: {}, tools: {} })
    localStorage.setItem(
      OVERRIDES_STORAGE_KEY,
      JSON.stringify({ commands: { 'edit.undo': 42, ok: 'mod+k' }, tools: [] })
    )
    reloadKeyOverrides()
    expect(keyOverrides()).toEqual({ commands: { ok: 'mod+k' }, tools: {} })
    setKeyOverrides({ commands: {}, tools: {} })
    expect(localStorage.getItem(OVERRIDES_STORAGE_KEY)).toBeNull()
  })

  it('the defaults have no key bound twice', () => {
    const seen = new Map<string, string>()
    for (const [k, t] of effectiveKeymap()) {
      expect(seen.has(k), k).toBe(false)
      seen.set(k, t.id)
    }
  })
})

describe('the one-time notice lists exactly what moved', () => {
  // The defaults at draw-p0 (3015cc6b), before the switch.
  const OLD_TOOLS: Record<string, string> = {
    select: 'v',
    // WP-PATH renamed the Direct Selection tool from node to direct; its key, A, did not move.
    direct: 'a',
    pen: 'p',
    pencil: 'n',
    rect: 'r',
    roundRect: 'd',
    ellipse: 'o',
    polygon: 'u',
    star: 's',
    line: 'l',
    text: 't',
    brush: 'b',
    eraser: 'e',
    bucket: 'g',
    eyedropper: 'i',
    hand: 'h'
  }
  const OLD_KEYMAP: Record<string, string> = {
    '[': 'brush.smaller',
    ']': 'brush.larger',
    arrowdown: 'object.nudgeDown',
    arrowleft: 'object.nudgeLeft',
    arrowright: 'object.nudgeRight',
    arrowup: 'object.nudgeUp',
    backspace: 'edit.delete',
    delete: 'edit.delete',
    enter: 'pen.finish',
    escape: 'edit.escape',
    'mod+a': 'edit.selectAll',
    'mod+d': 'edit.duplicate',
    'mod+shift+z': 'edit.redo',
    'mod+y': 'edit.redo',
    'mod+z': 'edit.undo'
  }

  it('every old key that no longer does the same thing is listed, with its new key; nothing else is', () => {
    const moved: string[] = []
    for (const [id, k] of Object.entries(OLD_TOOLS))
      if (toolKeyOf(id) !== k) moved.push(`tool:${id}:${k}->${toolKeyOf(id)}`)
    for (const [k, id] of Object.entries(OLD_KEYMAP)) {
      if (KEYMAP[k]?.[0] === id) continue
      const now = Object.entries(KEYMAP)
        .filter(([, [c]]) => c === id)
        .map(([key]) => key)
      const stillHas =
        now.length > 0 &&
        Object.entries(OLD_KEYMAP).some(([ok, oid]) => oid === id && KEYMAP[ok]?.[0] === id)
      moved.push(`command:${id}:${k}->${stillHas ? null : (now[0] ?? null)}`)
    }
    expect(KEY_CHANGES.map((c) => `${c.kind}:${c.id}:${c.from}->${c.to}`).sort()).toEqual(
      moved.sort()
    )
  })

  it('says it in words people use, written for the platform', () => {
    expect(KEY_CHANGES.map((c) => c.what)).toEqual([
      'Rectangle',
      'Ellipse',
      'Line',
      'Eraser',
      'Paint bucket',
      'Rounded rectangle',
      'Polygon',
      'Star',
      'Duplicate',
      'Redo'
    ])
    const dup = KEY_CHANGES.find((c) => c.id === 'edit.duplicate')!
    expect(changeNote(dup, 'mac')).toBe('Edit › Duplicate; ⌘D is now Transform again')
    expect(changeNote(dup, 'win')).toBe('Edit › Duplicate; Ctrl+D is now Transform again')
  })

  it('is dismissed once per profile', () => {
    expect(noticeDismissed()).toBe(false)
    dismissNotice()
    expect(noticeDismissed()).toBe(true)
    expect(localStorage.getItem(NOTICE_STORAGE_KEY)).toBe('dismissed')
  })
})

describe('the Keyboard shortcuts dialog’s rows', () => {
  it('Tools hold every tool and Illustrator’s tools still to come; Menu commands hold every menu item and the canvas keys', () => {
    const rows = shortcutRows()
    const tools = rows.filter((r) => r.group === 'tools')
    expect(tools.filter((r) => r.kind === 'tool').map((r) => r.id)).toEqual(
      drawTools().filter((t) => !t.hidden).map((t) => t.id)
    )
    expect(tools.find((r) => r.id === 'tool:gradient')).toMatchObject({
      kind: 'reserved',
      keys: ['g'],
      reason: 'Arrives with gradients and patterns',
      remappable: false
    })
    expect(tools.find((r) => r.id === 'rotate')).toMatchObject({ kind: 'tool', keys: ['r'], remappable: true })
    expect(tools.find((r) => r.id === 'tool:mesh')).toMatchObject({
      reason: 'Not in PlexiiDraw yet'
    })
    const menu = rows.filter((r) => r.group === 'menu' && r.kind === 'command')
    const menuIds = drawCommands()
      .filter((c) => c.menu)
      .map((c) => c.id)
    for (const id of menuIds)
      expect(
        menu.some((r) => r.id === id),
        id
      ).toBe(true)
    expect(menu.find((r) => r.id === 'edit.keyboardShortcuts')).toMatchObject({
      section: 'Edit',
      keys: ['mod+alt+shift+k'],
      remappable: true
    })
    expect(menu.find((r) => r.id === 'object.arrange.front')).toMatchObject({
      section: 'Object › Arrange',
      keys: ['mod+shift+]']
    })
    expect(menu.find((r) => r.id === 'object.transformAgain')).toMatchObject({
      section: 'Object › Transform',
      keys: ['mod+d'],
      remappable: true
    })
    expect(menu.find((r) => r.id === 'object.nudgeLeft')).toMatchObject({
      section: 'Canvas keys',
      remappable: false
    })
    // Rulers hold two keys (Windows and Mac) in one row.
    expect(rows.find((r) => r.id === 'view.rulers')?.keys.sort()).toEqual(['mod+alt+r', 'mod+r'])
  })

  it('search finds by name, by key as either platform writes it, and says when nothing matches', () => {
    const rows = shortcutRows()
    expect(filterRows(rows, 'transform again', 'mac').map((r) => r.id)).toEqual([
      'object.transformAgain'
    ])
    expect(filterRows(rows, '⌘D', 'mac').map((r) => r.id)).toEqual(['object.transformAgain'])
    expect(filterRows(rows, 'ctrl+d', 'mac').map((r) => r.id)).toEqual(['object.transformAgain'])
    expect(filterRows(rows, 'group', 'mac').map((r) => r.id)).toContain('object.group')
    expect(filterRows(rows, 'rect', 'mac').map((r) => r.id)).toContain('rect')
    expect(filterRows(rows, 'qqqq', 'mac')).toEqual([])
    expect(arrivesWith('-')).toBe('Not in PlexiiDraw yet')
  })
})
