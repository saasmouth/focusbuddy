// One definition per office action (SPEC §9): the adapters render the same
// label, hint and off-state reason on every surface, by construction.
import { describe, expect, it, vi } from 'vitest'
import { barProps, commandHint, ctxRow, documentCommands, menuItemOf, paletteEntries, paletteEntry, sharedCommand, type OfficeCommand } from '../../src/renderer/src/lib/menus/officeCommand'

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

describe('documentCommands: File acts on the document its host bound', () => {
  const opsFor = (id: string) => ({
    id,
    title: () => id,
    newDocument: vi.fn().mockResolvedValue(undefined),
    makeCopy: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    openHistory: vi.fn(),
    startMeeting: vi.fn(),
    moveToTrash: vi.fn().mockResolvedValue(undefined)
  })

  it('two hosts, two documents: each command reaches only its own document', () => {
    const a = opsFor('A')
    const b = opsFor('B')
    const ca = documentCommands(a, 'doc')!
    const cb = documentCommands(b, 'sheet')!
    // B built last, A used: a registry that kept "the current document" would hit B.
    for (const k of ['newDocument', 'makeCopy', 'rename', 'versionHistory', 'meeting', 'moveToTrash'] as const) ca[k].run()
    expect(a.moveToTrash).toHaveBeenCalledTimes(1)
    expect(a.makeCopy).toHaveBeenCalledTimes(1)
    expect(a.rename).toHaveBeenCalledTimes(1)
    expect(a.openHistory).toHaveBeenCalledTimes(1)
    expect(a.startMeeting).toHaveBeenCalledTimes(1)
    expect(a.newDocument).toHaveBeenCalledTimes(1)
    for (const f of [b.moveToTrash, b.makeCopy, b.rename, b.openHistory, b.startMeeting, b.newDocument]) expect(f).not.toHaveBeenCalled()
    cb.moveToTrash.run()
    expect(b.moveToTrash).toHaveBeenCalledTimes(1)
    expect(a.moveToTrash).toHaveBeenCalledTimes(1)
  })

  it('labels come from the lexicon and the app type', () => {
    const c = documentCommands(opsFor('A'), 'slides')!
    expect([c.newDocument.label, c.makeCopy.label, c.rename.label, c.versionHistory.label, c.meeting.label, c.moveToTrash.label]).toEqual([
      'New presentation',
      'Make a copy',
      'Rename',
      'Version history',
      'Meeting',
      'Move to Trash'
    ])
  })

  it('Print… ⌘P only where the host can really print', () => {
    expect(documentCommands(opsFor('A'), 'doc')!.print, 'no print op, no Print row').toBeUndefined()
    const print = vi.fn()
    const c = documentCommands({ ...opsFor('A'), print } as never, 'doc')!
    expect(c.print).toMatchObject({ label: 'Print…', id: 'file.print' })
    expect(commandHint(c.print!, 'darwin')).toBe('⌘P')
    c.print!.run()
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('no ops (a snippet session): no document commands, so the rows are absent', () => {
    expect(documentCommands(undefined, 'doc')).toBeNull()
  })
})
