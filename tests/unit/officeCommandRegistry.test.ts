// GUARD for one-definition-per-action (SPEC §9, 9d's "no repeats").
//
// Every office app's shared actions are OfficeCommands, and the menu bar,
// ribbon, right-click menu and palette render them through the adapters, so a
// label or hint cannot differ between surfaces by construction. This guards the
// construction itself:
//  - each command id is defined once, in one app's record, and never twice;
//  - a command that can be off says why (SPEC §9.5);
//  - labels use the owner's spelling ("centre", "colour"; 9d ruling);
//  - hints are formatted per platform from keys: on Windows no Mac glyph;
//  - the converted surfaces carry no hard-coded glyph hint (source rule), so a
//    new button cannot slip back to `shortcut="⌘G"`.

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDeckCommands } from '../../src/renderer/src/components/documents/slides/deckCommands'
import { buildDesignCommands } from '../../src/renderer/src/components/documents/design/designCommands'
import { buildDiagramCommands } from '../../src/renderer/src/components/documents/diagram/diagramCommands'
import { commandHint, documentCommands, type OfficeCommand } from '../../src/renderer/src/lib/menus/officeCommand'
import { MENU } from '../../src/shared/menus/lexicon'

vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { api: { platform: 'darwin' } }))

// Any deps object: flags as given, every function a stub.
const stub = <T>(flags: Record<string, unknown>): T =>
  new Proxy(flags, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as T

const cmdStub = stub<Parameters<typeof buildDiagramCommands>[0]['cmd']>({ hasStyleClipboard: () => true, textStyleOn: () => false })
const APPS: Record<string, OfficeCommand[]> = {
  Deck: Object.values(buildDeckCommands(stub({ selected: 3, anyGrouped: true, canUndo: true, canRedo: true, canPaste: true, singleSlide: false, textMarks: {} }))),
  Design: Object.values(buildDesignCommands(stub({ selected: 3, grouped: true, canPaste: true, textMarks: {} }))),
  Diagrams: Object.values(buildDiagramCommands({ cmd: cmdStub, nodes: 3, edges: 1, locked: false, grouped: true, openFind: () => undefined })),
  File: Object.values(documentCommands(stub({ id: 'doc-1', print: () => undefined }), 'doc')!).filter(Boolean) as OfficeCommand[]
}
const all = Object.entries(APPS).flatMap(([app, cs]) => cs.map((c) => ({ app, c })))

describe('one definition per action', () => {
  it('every id is unique within its app', () => {
    for (const [app, cs] of Object.entries(APPS)) {
      const ids = cs.map((c) => c.id)
      expect(ids.filter((id, i) => ids.indexOf(id) !== i), `${app}: duplicate ids`).toEqual([])
    }
  })

  it('no id is defined by two apps (shared File commands come from documentCommands only)', () => {
    const owner = new Map<string, string>()
    const clashes: string[] = []
    for (const { app, c } of all) {
      const prev = owner.get(c.id)
      if (prev && prev !== app) clashes.push(`${c.id}: ${prev} and ${app}`)
      owner.set(c.id, app)
    }
    expect(clashes).toEqual([])
  })

  it('a command that can be off says why', () => {
    const silent = all.filter(({ c }) => c.enabled && typeof c.reason !== 'function').map(({ app, c }) => `${app} ${c.id}`)
    expect(silent).toEqual([])
  })

  it('labels use the owner’s spelling: centre, colour', () => {
    const labels = [...all.map(({ app, c }) => [app, c.label] as const), ...Object.values(MENU).map((m) => ['lexicon', m.label] as const)]
    // The US stems, with any ending ("centers", "colored"); "centre" and "colour" never match.
    const wrong = labels.filter(([, l]) => /\b(color|center)/i.test(l))
    expect(wrong.map(([a, l]) => `${a}: "${l}"`)).toEqual([])
  })

  it('hints come from keys, formatted per platform: no Mac glyph on Windows', () => {
    const mac = all.filter(({ c }) => /[⌘⌥⇧⌃]/.test(commandHint(c, 'win32') ?? '')).map(({ app, c }) => `${app} ${c.id}: ${commandHint(c, 'win32')}`)
    expect(mac).toEqual([])
    // And they exist where a key is bound.
    expect(commandHint(APPS.Deck!.find((c) => c.id === 'sl-group')!, 'win32')).toBe('Ctrl+G')
  })
})

describe('no hard-coded glyph hints on the converted surfaces', () => {
  const root = join(__dirname, '../../src/renderer/src/components/documents')
  const FILES = [
    'slides/ribbon.tsx',
    'SlidesEditor.tsx',
    'editor/SlidesMenuBar.tsx',
    'diagram/ribbon.tsx',
    'diagram/DiagramChrome.tsx',
    'diagram/ContextMenu.tsx',
    'design/ribbon.tsx',
    'DesignEditor.tsx'
  ]
  it.each(FILES)('%s', (f) => {
    const src = readFileSync(join(root, f), 'utf8')
    // A literal hint: shortcut="⌘…", shortcut: '⇧…' and the like. Hints come
    // from a command (barProps / menuItemOf / ctxRow) or hint([...]) instead.
    const hits = src.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /shortcut(=|:\s*)["'`][^"'`]*[⌘⌥⇧⌃⌫]/.test(l))
    expect(hits.map(([n, l]) => `${f}:${n} ${l.trim()}`)).toEqual([])
  })
})
