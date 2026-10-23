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
import { drawOfficeCommands } from '../../src/renderer/src/components/documents/draw/commands/officeAdapter'
import { blank, harness, withDocument } from './drawTools/harness'

vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { api: { platform: 'darwin' } }))

// Any deps object: flags as given, every function a stub.
const stub = <T>(flags: Record<string, unknown>): T =>
  new Proxy(flags, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as T

const cmdStub = stub<Parameters<typeof buildDiagramCommands>[0]['cmd']>({ hasStyleClipboard: () => true, textStyleOn: () => false })
const APPS: Record<string, OfficeCommand[]> = {
  Deck: Object.values(buildDeckCommands(stub({ selected: 3, anyGrouped: true, canUndo: true, canRedo: true, canPaste: true, singleSlide: false, textMarks: {} }))),
  Design: Object.values(buildDesignCommands(stub({ selected: 3, grouped: true, canPaste: true, textMarks: {} }))),
  Diagrams: Object.values(buildDiagramCommands({ cmd: cmdStub, nodes: 3, edges: 1, locked: false, grouped: true, openFind: () => undefined })),
  File: Object.values(documentCommands(stub({ id: 'doc-1', print: () => undefined }), 'doc')!).filter(Boolean) as OfficeCommand[],
  // PlexiiDraw keeps its command registry; the adapter shows it as OfficeCommands.
  Draw: drawOfficeCommands(withDocument(harness(blank())).ed.ctx)
}
const all = Object.entries(APPS).flatMap(([app, cs]) => cs.map((c) => ({ app, c })))

describe('one definition per action', () => {
  it('every id is unique within its app', () => {
    for (const [app, cs] of Object.entries(APPS)) {
      const ids = cs.map((c) => c.id)
      expect(ids.filter((id, i) => ids.indexOf(id) !== i), `${app}: duplicate ids`).toEqual([])
    }
  })

  // The only id two records may share is a File document action: Draw's
  // registry defines its own (session-aware) rows under documentCommands' ids,
  // running through the same host-bound ops. Then it must be the same action
  // by name too. Any other shared id is two implementations of one action.
  it('no id is defined by two apps, except the shared File actions, which then match by name', () => {
    const fileIds = new Set(APPS.File!.map((c) => c.id))
    const first = new Map<string, { app: string; c: OfficeCommand }>()
    const clashes: string[] = []
    for (const e of all) {
      const prev = first.get(e.c.id)
      if (prev && prev.app !== e.app) {
        if (!fileIds.has(e.c.id)) clashes.push(`${e.c.id}: ${prev.app} and ${e.app}`)
        else if (prev.c.id !== 'file.new' && prev.c.label !== e.c.label) clashes.push(`${e.c.id}: "${prev.c.label}" (${prev.app}) vs "${e.c.label}" (${e.app})`)
      }
      if (!prev) first.set(e.c.id, e)
    }
    expect(clashes).toEqual([])
  })

  it('a command that can be off says why', () => {
    const silent = all.filter(({ app, c }) => app !== 'Draw' && c.enabled && typeof c.reason !== 'function').map(({ app, c }) => `${app} ${c.id}`)
    expect(silent).toEqual([])
  })

  // PlexiiDraw's adapter always hands over a reason function, so the rule above
  // cannot see a silent one there; this asks it. It was a ratchet at 76 (of 141
  // menu commands in a blank drawing: distribute, artboard actions…); d1 gave
  // every one a reason from the same predicate as its `enabled` (Draw's
  // commands/gate.ts), so it is now zero, blank and read-only (E-16).
  it.each([
    ['a blank drawing', () => drawOfficeCommands(withDocument(harness(blank())).ed.ctx)],
    ['a read-only drawing', () => drawOfficeCommands(withDocument(harness(blank(), { readOnly: true })).ed.ctx)]
  ])('PlexiiDraw: no command is off without a reason, in %s', (_state, commands) => {
    const silent = commands()
      .filter((c) => c.enabled && !c.enabled() && !c.reason?.()?.trim())
      .map((c) => c.id)
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
