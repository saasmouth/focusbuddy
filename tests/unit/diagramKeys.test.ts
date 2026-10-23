// ⌥⌘C / ⌥⌘V (copy / paste style) never fired on macOS: Option composes the
// character, so e.key is 'ç' / '√'. Shortcuts read the physical code only when
// Alt is held, so other layouts keep their own letters.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { shortcutKey } from '../../src/renderer/src/components/documents/diagram/keys'
import { matchCommand } from '../../src/renderer/src/lib/menus/commandKeys'

const ev = (key: string, code: string, altKey = false) => ({ key, code, altKey })

describe('shortcutKey', () => {
  it('reads the bracket keys by their code, so ⇧⌘] / ⇧⌘[ (front / back) match with Shift held', () => {
    expect(shortcutKey(ev('}', 'BracketRight'))).toBe(']')
    expect(shortcutKey(ev('{', 'BracketLeft'))).toBe('[')
    expect(shortcutKey(ev(']', 'BracketRight'))).toBe(']')
  })

  it('reads Option-composed letters on macOS by their physical key', () => {
    expect(shortcutKey(ev('ç', 'KeyC', true))).toBe('c') // ⌥⌘C → copy style
    expect(shortcutKey(ev('√', 'KeyV', true))).toBe('v') // ⌥⌘V → paste style
  })

  it('without Alt, follows the layout: AZERTY ⌘A stays A', () => {
    // On AZERTY the A key sits where US has Q; its code is KeyQ, its key 'a'.
    expect(shortcutKey(ev('a', 'KeyQ'))).toBe('a')
    expect(shortcutKey(ev('Z', 'KeyZ'))).toBe('z')
  })

  it('leaves non-letter keys alone', () => {
    expect(shortcutKey(ev('ArrowLeft', 'ArrowLeft'))).toBe('arrowleft')
    expect(shortcutKey(ev(']', 'BracketRight', true))).toBe(']')
    expect(shortcutKey(ev('Escape', 'Escape'))).toBe('escape')
  })

  it('the registry key matcher reads Option-composed letters too, so ⌥⌘C / ⌥⌘V reach Copy / Paste style', () => {
    // The style keys run from the command registry now (diagramCommands via
    // commandKeys), which must match what macOS really sends.
    const copyStyle = { id: 'dg-copy-style', label: 'Copy style', keys: ['alt', 'mod', 'c'] as const, run: () => undefined }
    const pasteStyle = { id: 'dg-paste-style', label: 'Paste style', keys: ['alt', 'mod', 'v'] as const, run: () => undefined }
    const ev = (key: string, code: string) => ({ key, code, metaKey: true, altKey: true })
    expect(matchCommand([copyStyle, pasteStyle], ev('ç', 'KeyC'), 'darwin')?.id).toBe('dg-copy-style')
    expect(matchCommand([copyStyle, pasteStyle], ev('√', 'KeyV'), 'darwin')?.id).toBe('dg-paste-style')
  })
})

describe('the command object is not rebuilt on every render', () => {
  it('settings fall back to a stable constant, and copy-style state lives in editor refs', () => {
    const ed = readFileSync(join(__dirname, '../../src/renderer/src/components/documents/diagram/DiagramEditor.tsx'), 'utf-8')
    expect(ed).toContain('body.settings ?? NO_SETTINGS')
    expect(ed).not.toMatch(/body\.settings \?\? \{\}/)
    const cmds = readFileSync(join(__dirname, '../../src/renderer/src/components/documents/diagram/commands.ts'), 'utf-8')
    expect(cmds).not.toMatch(/let styleClipboard|let lastPasteOffset/)
    expect(cmds).toContain('styleClip.current')
  })
})
