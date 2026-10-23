// GUARD: a key an office app SHOWS is a key that app BINDS (9d: close the class).
//
// Shown-but-unbound keys kept turning up (Cells ⌘B/I/U/⌘\, Write ⌘\ and ⌘/,
// Deck ⌘A and ⌘Y, Design ⌘B/I/U, then ⌘P). Every menu, ribbon and palette hint
// is formatted from an OfficeCommand's `keys`; the apps now also BIND from those
// keys (lib/menus/commandKeys, runCommandKey in each editor's key handler). This
// proves the two meet, for every keyed command in every app:
//  - the event a real keyboard sends for the shown key (Shift turns ] into },
//    Option composes letters) reaches exactly that command through the matcher
//    the editors use; no other command claims it first;
//  - keys bound elsewhere are bound there: the menu bar's own keys (⌘F ⇧⌘H ⌘P
//    ⌘/, MenuBarShell) and the clipboard's (⌘X ⌘C ⌘V arrive as the platform's
//    cut/copy/paste events) — the matcher leaves those alone so none runs twice;
//  - every editor dispatches its registry through the matcher (source rule);
//  - PlexiiDraw: its keymap (resolveKey, the dispatcher its keys go through)
//    resolves each shown key to that command.

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ShortcutKeys } from '../../src/shared/menus/shortcuts'
import { buildDeckCommands } from '../../src/renderer/src/components/documents/slides/deckCommands'
import { buildDesignCommands } from '../../src/renderer/src/components/documents/design/designCommands'
import { buildDiagramCommands } from '../../src/renderer/src/components/documents/diagram/diagramCommands'
import { documentCommands, type OfficeCommand } from '../../src/renderer/src/lib/menus/officeCommand'
import { matchCommand, type KeyLikeEvent } from '../../src/renderer/src/lib/menus/commandKeys'
import { drawOfficeCommands } from '../../src/renderer/src/components/documents/draw/commands/officeAdapter'
import { resolveKey, setKeyPlatform } from '../../src/renderer/src/components/documents/draw/commands/keys'
import { blank, harness, withDocument } from './drawTools/harness'
import { writeCommandsFor } from './_writeCommands'
import { cellsCommandsFor } from './_cellsCommands'

vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { api: { platform: 'darwin' } }))

const stub = <T>(flags: Record<string, unknown>): T =>
  new Proxy(flags, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as T
const anyEditor = new Proxy({}, { get: () => () => anyEditor })

const APPS: Record<string, OfficeCommand[]> = {
  Write: Object.values(writeCommandsFor(anyEditor)),
  Cells: Object.values(cellsCommandsFor()),
  Deck: Object.values(buildDeckCommands(stub({ selected: 3, anyGrouped: true, canUndo: true, canRedo: true, canPaste: true, singleSlide: false, textMarks: {} }))),
  Design: Object.values(buildDesignCommands(stub({ selected: 3, grouped: true, canPaste: true, textMarks: {} }))),
  Diagrams: Object.values(
    buildDiagramCommands({ cmd: stub({ hasStyleClipboard: () => true, textStyleOn: () => false }), nodes: 3, edges: 1, locked: false, grouped: true, openFind: () => undefined })
  )
}
const FILE = Object.values(documentCommands(stub({ id: 'd', print: () => undefined }), 'doc')!).filter(Boolean) as OfficeCommand[]

// What a keyboard sends for a combination: event.key as typed (Shift and
// Option change it), event.code the physical key.
const SHIFTED: Record<string, string> = { ']': '}', '[': '{', '/': '?', '\\': '|', '=': '+', '-': '_', '1': '!', '2': '@', '3': '#', '0': ')', ',': '<', '.': '>', ';': ':', "'": '"', '`': '~' }
const NAMED: Record<string, string> = { backspace: 'Backspace', delete: 'Delete', enter: 'Enter', escape: 'Escape', tab: 'Tab', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', space: ' ', plus: '+', minus: '-' }
const CODE: Record<string, string> = { ']': 'BracketRight', '[': 'BracketLeft', '/': 'Slash', '\\': 'Backslash', '=': 'Equal', '-': 'Minus', ',': 'Comma', '.': 'Period', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote', plus: 'Equal', minus: 'Minus' }
function eventFor(keys: ShortcutKeys, platform: 'darwin' | 'win32'): KeyLikeEvent & { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean } {
  const mods = new Set(keys.slice(0, -1) as string[])
  const raw = String(keys[keys.length - 1])
  const shift = mods.has('shift')
  const alt = mods.has('alt')
  const lower = raw.toLowerCase()
  let key = NAMED[lower] ?? raw
  if (!NAMED[lower] && raw.length === 1) {
    if (alt && /^[a-z]$/i.test(raw) && platform === 'darwin') key = 'ø' // Option composes the letter
    else if (shift && SHIFTED[raw]) key = SHIFTED[raw]!
    else if (/^[a-z]$/i.test(raw)) key = shift ? raw.toUpperCase() : raw.toLowerCase()
  }
  const code = /^[a-z]$/i.test(raw) ? `Key${raw.toUpperCase()}` : /^[0-9]$/.test(raw) ? `Digit${raw}` : (CODE[lower] ?? NAMED[lower] ?? raw)
  const mac = platform === 'darwin'
  return {
    key,
    code,
    metaKey: mac && mods.has('mod'),
    ctrlKey: mods.has('ctrl') || (!mac && mods.has('mod')),
    altKey: alt,
    shiftKey: shift
  }
}

const MENUBAR_OWNED = new Set(['⌘F', '⇧⌘H', '⌘P', '⌘/'])
const keyed = (cs: OfficeCommand[]) => cs.filter((c) => c.keys)

describe.each(Object.keys(APPS))('%s: every shown key is bound', (app) => {
  const cs = APPS[app]!
  // Key mapping, not enabled state: every command live for the match.
  const live = cs.map((c) => ({ ...c, enabled: undefined }))

  it.each(['darwin', 'win32'] as const)('on %s, each keyed command is reached by its own key, and by nothing else', (platform) => {
    const own = keyed(cs).filter((c) => !c.keyOwner)
    expect(own.length, `${app} has keyed commands to check`).toBeGreaterThan(4)
    const wrong: string[] = []
    for (const c of own) {
      const hit = matchCommand(live, eventFor(c.keys!, platform), platform)
      if (hit?.id !== c.id) wrong.push(`${c.id} (${c.keys!.join('+')}) → ${hit?.id ?? 'nothing'}`)
    }
    expect(wrong).toEqual([])
  })

  it('keys owned elsewhere are the menu bar’s or the clipboard’s, and the matcher leaves them alone', () => {
    for (const c of keyed(cs).filter((c) => c.keyOwner)) {
      if (c.keyOwner === 'menubar') expect(MENUBAR_OWNED, `${c.id}: the menu bar binds only ⌘F ⇧⌘H ⌘P ⌘/`).toContain(c.keys!.map((k) => ({ shift: '⇧', mod: '⌘', alt: '⌥', ctrl: '⌃' })[k as string] ?? k.toUpperCase()).join(''))
      expect(matchCommand(live, eventFor(c.keys!, 'darwin'), 'darwin')?.id, `${c.id} must not also run from the editor`).not.toBe(c.id)
    }
  })
})

it('File: Print… ⌘P is the menu bar’s key, not run twice by an editor', () => {
  const print = FILE.find((c) => c.id === 'file.print')!
  expect(print.keyOwner).toBe('menubar')
  expect(matchCommand(FILE.map((c) => ({ ...c, enabled: undefined })), eventFor(print.keys!, 'darwin'), 'darwin')).toBeNull()
})

describe('every editor dispatches its registry through the matcher', () => {
  const root = join(__dirname, '../../src/renderer/src/components/documents')
  const EDITORS: Record<string, [string, RegExp]> = {
    Write: ['DocEditor.tsx', /runCommandKey\(|matchCommand\(/],
    Cells: ['SheetEditor.tsx', /runCommandKey\(|matchCommand\(/],
    Deck: ['SlidesEditor.tsx', /runCommandKey\(Object\.values\(cmdsRef\.current\)/],
    Design: ['DesignEditor.tsx', /runCommandKey\(Object\.values\(c\)/],
    Diagrams: ['diagram/DiagramEditor.tsx', /runCommandKey\(Object\.values\(keyCmdsRef\.current\)/]
  }
  it.each(Object.keys(EDITORS))('%s', (app) => {
    const [file, pattern] = EDITORS[app]!
    expect(readFileSync(join(root, file), 'utf8'), `${app}'s key handler must run its commands by their keys`).toMatch(pattern)
  })
})

describe('PlexiiDraw: each shown key resolves, through its keymap, to that command', () => {
  it.each(['mac', 'win'] as const)('%s', (p) => {
    setKeyPlatform(p)
    const cs = drawOfficeCommands(withDocument(harness(blank())).ed.ctx)
    const wrong: string[] = []
    for (const c of keyed(cs)) {
      const hit = resolveKey(eventFor(c.keys!, p === 'mac' ? 'darwin' : 'win32'))
      if (!(hit && hit.kind === 'command' && hit.id === c.id)) wrong.push(`${c.id} (${c.keys!.join('+')}) → ${hit ? (hit.kind === 'command' ? hit.id : hit.kind) : 'nothing'}`)
    }
    setKeyPlatform('mac')
    expect(wrong).toEqual([])
  })
})
