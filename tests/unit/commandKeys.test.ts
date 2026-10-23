// GUARD for keys driven by the command registry (SPEC §9.4).
//
// The defect this closes: PlexiiCells' Format ▸ Text advertised Bold ⌘B,
// Italic ⌘I and Underline ⌘U, and Clear formatting advertised ⌘\, and the grid
// bound none of the four — the menu promised a key that did nothing. PlexiiWrite
// advertised ⌘\ and ⌘/ the same way. Matching the event against the SAME `keys`
// the hint is formatted from is what makes that impossible.

import { describe, expect, it, vi } from 'vitest'
import { matchCommand, runCommandKey, type KeyLikeEvent } from '../../src/renderer/src/lib/menus/commandKeys'
import { commandHint, sharedCommand, type OfficeCommand } from '../../src/renderer/src/lib/menus/officeCommand'

const press = (key: string, mods: Partial<KeyLikeEvent> = {}): KeyLikeEvent => ({ key, ...mods })
const cmd = (over: Partial<OfficeCommand> = {}): OfficeCommand => ({
  id: 'x',
  label: 'X',
  run: vi.fn(),
  ...over
})

describe('matchCommand', () => {
  it('matches ⌘B on macOS and Ctrl+B elsewhere', () => {
    const bold = cmd({ id: 'bold', keys: ['mod', 'b'] })
    expect(matchCommand([bold], press('b', { metaKey: true }), 'darwin')).toBe(bold)
    expect(matchCommand([bold], press('b', { ctrlKey: true }), 'win32')).toBe(bold)
    // `mod` is one key or the other, never both: Ctrl+B on a Mac is not ⌘B.
    expect(matchCommand([bold], press('b', { ctrlKey: true }), 'darwin')).toBeNull()
    expect(matchCommand([bold], press('b', { metaKey: true }), 'win32')).toBeNull()
  })

  it('requires the modifiers to match exactly', () => {
    const bold = cmd({ id: 'bold', keys: ['mod', 'b'] })
    // ⇧⌘B is a different combination, and may belong to something else.
    expect(matchCommand([bold], press('b', { metaKey: true, shiftKey: true }), 'darwin')).toBeNull()
    expect(matchCommand([bold], press('b', { metaKey: true, altKey: true }), 'darwin')).toBeNull()
    expect(matchCommand([bold], press('b'), 'darwin')).toBeNull()
  })

  it('excludes ⌥ from a plain mod combination, which Write had to hand-code', () => {
    // ⌥⌘F opens Files beside, and on Windows Ctrl+Alt+F must not also open
    // Find. Write carried an explicit `!event.altKey` in both of its branches;
    // exact modifier matching is what replaces it. Shown on a command the menu
    // bar does NOT own, so this is about the modifiers and not about ownership
    // (Find itself is keyOwner 'menubar' — see the ownership tests below).
    const clear = sharedCommand('clear', 'clearFormatting', vi.fn())
    expect(matchCommand([clear], press('\\', { metaKey: true }), 'darwin')).toBe(clear)
    expect(matchCommand([clear], press('\\', { metaKey: true, altKey: true }), 'darwin')).toBeNull()
    expect(matchCommand([clear], press('\\', { ctrlKey: true, altKey: true }), 'win32')).toBeNull()
  })

  it('matches a shared lexicon combination it owns, and needs every modifier', () => {
    const group = sharedCommand('group', 'group', vi.fn())
    expect(matchCommand([group], press('g', { metaKey: true }), 'darwin')).toBe(group)
    const ungroup = sharedCommand('ungroup', 'ungroup', vi.fn())
    expect(matchCommand([ungroup], press('g', { metaKey: true, shiftKey: true }), 'darwin')).toBe(ungroup)
    // ⌘G is not ⇧⌘G: the two are different actions.
    expect(matchCommand([ungroup], press('g', { metaKey: true }), 'darwin')).toBeNull()
    expect(matchCommand([group], press('g', { metaKey: true, shiftKey: true }), 'darwin')).toBeNull()
  })

  it('uses the platform key where the two differ', () => {
    // Hand-built: the lexicon action with two platform keys (Paste as plain
    // text) is clipboard-owned, so the matcher skips it by design.
    const plain = cmd({ id: 'plain', keys: ['alt', 'shift', 'mod', 'v'], otherKeys: ['shift', 'mod', 'v'] })
    expect(matchCommand([plain], press('v', { metaKey: true, shiftKey: true, altKey: true }), 'darwin')).toBe(plain)
    expect(matchCommand([plain], press('v', { ctrlKey: true, shiftKey: true }), 'win32')).toBe(plain)
    // Each platform's combination is not the other's.
    expect(matchCommand([plain], press('v', { ctrlKey: true, shiftKey: true }), 'darwin')).toBeNull()
  })

  it('matches a named key by its event name', () => {
    const del = sharedCommand('del', 'delete', vi.fn())
    expect(matchCommand([del], press('Backspace'), 'darwin')).toBe(del)
    expect(matchCommand([del], press('b'), 'darwin')).toBeNull()
  })

  it('never matches a command with no key', () => {
    // A command with no `keys` shows no hint, and so has no binding either.
    const noKey = cmd({ id: 'nokey' })
    expect(matchCommand([noKey], press('n', { metaKey: true }), 'darwin')).toBeNull()
    expect(matchCommand([noKey], press('n'), 'darwin')).toBeNull()
  })

  it('takes the first match, so order decides a shared key', () => {
    const a = cmd({ id: 'a', keys: ['mod', 'k'] })
    const b = cmd({ id: 'b', keys: ['mod', 'k'] })
    expect(matchCommand([a, b], press('k', { metaKey: true }), 'darwin')).toBe(a)
    expect(matchCommand([b, a], press('k', { metaKey: true }), 'darwin')).toBe(b)
  })
})

describe('a key owned somewhere else', () => {
  // d8's keyOwner, added when ⌘P reached the menu bar: a command whose key is
  // bound by MenuBarShell or by the platform's clipboard events must not ALSO
  // be matched here, or one press fires twice — two print jobs, two pastes.
  it('is skipped, so one press cannot fire twice', () => {
    for (const action of ['find', 'findAndReplace', 'print', 'keyboardShortcuts'] as const) {
      const c = sharedCommand(action, action, vi.fn())
      expect(c.keyOwner, `${action} is the menu bar's`).toBe('menubar')
      const keys = c.keys!
      const hit = matchCommand(
        [c],
        press(String(keys[keys.length - 1]), { metaKey: true, shiftKey: keys.includes('shift') }),
        'darwin'
      )
      expect(hit, `${action} is not matched here`).toBeNull()
      expect(c.run).not.toHaveBeenCalled()
    }
    for (const action of ['cut', 'copy', 'paste'] as const) {
      const c = sharedCommand(action, action, vi.fn())
      expect(c.keyOwner, `${action} is the platform's`).toBe('clipboard')
      expect(matchCommand([c], press(String(c.keys![c.keys!.length - 1]), { metaKey: true }), 'darwin')).toBeNull()
    }
  })

  it('still shows its hint, because the key really is bound — elsewhere', () => {
    // The point of keyOwner is that the hint stays honest: the row advertises a
    // key that works, it is simply not this matcher that runs it.
    expect(commandHint(sharedCommand('file.print', 'print', vi.fn()), 'darwin')).toBe('⌘P')
    expect(commandHint(sharedCommand('find', 'find', vi.fn()), 'darwin')).toBe('⌘F')
  })

  it('does not shadow an unowned command sharing its key', () => {
    // Skipped with `continue`, so the search goes on — unlike a DISABLED match,
    // which stops it so nothing else can claim a viewer's key.
    const owned = sharedCommand('find', 'find', vi.fn())
    const mine = cmd({ id: 'mine', keys: ['mod', 'f'] })
    expect(matchCommand([owned, mine], press('f', { metaKey: true }), 'darwin')).toBe(mine)
  })
})

describe('a viewer pressing an editing key', () => {
  it('runs nothing, which is the same answer the greyed menu row gives', () => {
    const run = vi.fn()
    const viewer = cmd({ id: 'bold', keys: ['mod', 'b'], run, enabled: () => false, reason: () => 'read-only' })
    expect(matchCommand([viewer], press('b', { metaKey: true }), 'darwin')).toBeNull()
    expect(runCommandKey([viewer], press('b', { metaKey: true }), 'darwin')).toBe(false)
    expect(run).not.toHaveBeenCalled()

    // Positive control, the same command with editing access: the key IS bound,
    // so the assertion above is about view-only access and not about a key that
    // never worked.
    const editorRun = vi.fn()
    const editor = cmd({ id: 'bold', keys: ['mod', 'b'], run: editorRun, enabled: () => true })
    expect(runCommandKey([editor], press('b', { metaKey: true }), 'darwin')).toBe(true)
    expect(editorRun).toHaveBeenCalledTimes(1)
  })

  it('does not let a later command claim a disabled one’s key', () => {
    // Falling through would hand ⌘B to whatever came next in the registry,
    // which is worse than nothing happening.
    const blocked = cmd({ id: 'bold', keys: ['mod', 'b'], enabled: () => false, reason: () => 'read-only' })
    const other = cmd({ id: 'other', keys: ['mod', 'b'] })
    expect(runCommandKey([blocked, other], press('b', { metaKey: true }), 'darwin')).toBe(false)
    expect(other.run).not.toHaveBeenCalled()
  })
})

describe('runCommandKey', () => {
  it('reports whether it handled the event, so the caller knows to stop', () => {
    const run = vi.fn()
    const bold = cmd({ id: 'bold', keys: ['mod', 'b'], run })
    expect(runCommandKey([bold], press('b', { metaKey: true }), 'darwin')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    // Nothing matched: the event goes on to whatever else wants it — the
    // printable-character branch that starts editing a cell, for instance.
    expect(runCommandKey([bold], press('q'), 'darwin')).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs an always-enabled command with no `enabled` gate', () => {
    const run = vi.fn()
    expect(runCommandKey([cmd({ keys: ['mod', 'b'], run })], press('b', { metaKey: true }), 'darwin')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
