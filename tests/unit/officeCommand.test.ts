// One definition per office action (SPEC §9): the adapters render the same
// label, hint and off-state reason on every surface, by construction.
import { describe, expect, it, vi } from 'vitest'
import { barProps, commandHint, ctxRow, menuItemOf, paletteEntries, paletteEntry, sharedCommand, type OfficeCommand } from '../../src/renderer/src/lib/menus/officeCommand'

vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { api: { platform: 'darwin' } }))

const run = vi.fn()
const group: OfficeCommand = { id: 'sl-group', label: 'Group', keys: ['mod', 'g'], icon: 'link', run, enabled: () => false, reason: () => 'Select two or more first' }

describe('OfficeCommand adapters', () => {
  it('every surface shows the same label and hint', () => {
    const m = menuItemOf(group)
    const r = ctxRow(group)
    const p = paletteEntry(group)
    const b = barProps(group)
    const labels = [m.kind === 'item' && m.label, r.label, p.label, b.label]
    const hints = [m.kind === 'item' && m.shortcut, r.shortcut, p.shortcut, b.shortcut]
    expect(new Set(labels)).toEqual(new Set(['Group']))
    expect(new Set(hints)).toEqual(new Set(['⌘G']))
  })

  it('formats the hint per platform from one key definition', () => {
    expect(commandHint(group, 'darwin')).toBe('⌘G')
    expect(commandHint(group, 'win32')).toBe('Ctrl+G')
    expect(commandHint({ id: 'x', label: 'X', run }, 'darwin')).toBeUndefined()
  })

  it('carries the off state and its reason to the menu bar, the ribbon and right-click', () => {
    expect(menuItemOf(group)).toMatchObject({ disabled: true, hint: 'Select two or more first' })
    expect(barProps(group)).toMatchObject({ disabled: true, disabledReason: 'Select two or more first' })
    expect(ctxRow(group)).toMatchObject({ disabled: true, hint: 'Select two or more first' })
  })

  it('ctxRow refuses a disabled row that does not say why (named in the error)', () => {
    expect(() => ctxRow({ ...group, reason: undefined })).toThrow(/"sl-group" is disabled without a reason/)
  })

  it('the palette lists only live commands', () => {
    expect(paletteEntries([group, { id: 'live', label: 'Live', run }]).map((e) => e.id)).toEqual(['live'])
  })

  it('a shared action takes its label, key and icon from the lexicon', () => {
    const d = sharedCommand('sl-dup', 'duplicate', run)
    expect(d).toMatchObject({ label: 'Duplicate', icon: 'control_point_duplicate' })
    expect(commandHint(d, 'darwin')).toBe('⌘D')
    expect(commandHint(sharedCommand('t', 'pasteAsPlainText', run), 'win32')).toBe('Ctrl+Shift+V')
  })
})
