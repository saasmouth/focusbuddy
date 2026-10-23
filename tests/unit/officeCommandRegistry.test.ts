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
import { stubEditor, writeCommandsFor } from './_writeCommands'
import { cellsCommandsFor } from './_cellsCommands'
import { READ_ONLY_REASON } from '../../src/renderer/src/components/office/shell'
import { expectNotReadOnly } from './_notReadOnly'

vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { api: { platform: 'darwin' } }))

// Any deps object: flags as given, every function a stub.
const stub = <T>(flags: Record<string, unknown>): T =>
  new Proxy(flags, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as T

const cmdStub = stub<Parameters<typeof buildDiagramCommands>[0]['cmd']>({ hasStyleClipboard: () => true, textStyleOn: () => false })
const APPS: Record<string, OfficeCommand[]> = {
  Deck: Object.values(buildDeckCommands(stub({ readOnly: false, selected: 3, anyGrouped: true, canUndo: true, canRedo: true, canPaste: true, singleSlide: false, textMarks: {} }))),
  Design: Object.values(buildDesignCommands(stub({ readOnly: false, selected: 3, grouped: true, canPaste: true, textMarks: {} }))),
  Diagrams: Object.values(buildDiagramCommands({ cmd: cmdStub, readOnly: false, nodes: 3, edges: 1, locked: false, grouped: true, openFind: () => undefined })),
  File: Object.values(documentCommands(stub({ id: 'doc-1', print: () => undefined }), 'doc')!).filter(Boolean) as OfficeCommand[],
  // PlexiiDraw keeps its command registry; the adapter shows it as OfficeCommands.
  Draw: drawOfficeCommands(withDocument(harness(blank())).ed.ctx),
  // Write and Cells were missing from this map, which is exactly why their
  // lowercase "nothing to undo" reached the integration unnoticed: their own
  // registry tests check them app by app, and only this file compares apps.
  Write: Object.values(writeCommandsFor(stubEditor())),
  Cells: Object.values(cellsCommandsFor())
}

// The same two again as a VIEWER. Write's and Cells' reasons are conditional
// (`readOnly ? READ_ONLY_REASON : 'Nothing to undo'`), unlike every other app's,
// so one state only ever shows one of the two strings each can return.
const READ_ONLY_APPS: Record<string, OfficeCommand[]> = {
  'Write (view-only)': Object.values(writeCommandsFor(stubEditor(), { readOnly: true })),
  'Cells (view-only)': Object.values(cellsCommandsFor({ readOnly: true }))
}
const all = Object.entries(APPS).flatMap(([app, cs]) => cs.map((c) => ({ app, c })))

/** Every reason an app can actually show, with the app and command it came from. */
const REASONS = [...Object.entries(APPS), ...Object.entries(READ_ONLY_APPS)].flatMap(([app, cs]) =>
  cs.flatMap((c) => {
    const text = c.reason?.()
    return typeof text === 'string' && text ? [{ app, id: c.id, text }] : []
  })
)

describe('the fixtures are editable documents (readOnly: false, not a proxy\'s function)', () => {
  it('Deck, Design and Diagrams build their command records NOT read-only', () => {
    for (const app of ['Deck', 'Design', 'Diagrams']) expectNotReadOnly(app, APPS[app]!)
  })
})

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

  // 9d's ruling: every reason is a SENTENCE — a capital and a terminator —
  // suite-wide. It matches PlexiiDraw's 83 and the read-only wording 82 is
  // moving to ("This document is read-only."), and an imperative reads fine as
  // a sentence ("Select two or more things."). The census that produced the
  // ruling: 147 reasons, 147 capitalised, 83 terminated (Draw) against 64 not
  // (Deck 27, Design 15, Diagrams 18, Write 2, Cells 2). Draw did not change;
  // the other five gained full stops.
  //
  // READ_ONLY_REASON is matched by identity rather than exempted by pattern,
  // because it belongs to the office shell and 82 is changing it right now. By
  // value, so this needs no edit either way: once it reads "This document is
  // read-only." it satisfies the shape too, and the identity arm goes quiet.
  it('every reason is a sentence: a capital and a terminator', () => {
    expect(REASONS.length, 'there are reasons to check').toBeGreaterThan(100)
    const bad = REASONS.filter((r) => r.text !== READ_ONLY_REASON && !/^[A-Z].*[.!?]$/.test(r.text))
    expect(bad.map((r) => `${r.app} ${r.id}: "${r.text}"`)).toEqual([])
  })

  it('shows a reason for every app in the map, so none is silently uncovered', () => {
    // Non-vacuity per app: a registry that built no commands, or whose reasons
    // all returned undefined, would otherwise pass the rule above by default.
    const covered = new Set(REASONS.map((r) => r.app))
    for (const app of Object.keys(READ_ONLY_APPS)) expect(covered, `${app} contributes a reason`).toContain(app)
    for (const app of ['Deck', 'Design', 'Diagrams', 'Write', 'Cells']) {
      expect(covered, `${app} contributes a reason`).toContain(app)
    }
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

// A tooltip and its menu row must never differ in voice (9d). The ribbons'
// remaining hand-written `disabledReason` props are JSX string literals, so
// building commands cannot see them — this reads the source instead.
//
// None of them is a duplicate of a command's reason: checked control by
// control, every one sits on a BarButton with its own label and onClick, not on
// a `{...barProps(cmd)}` spread, and the actions they belong to (Design's align
// and distribute, Diagrams' "Show all hidden") have no command at all. So
// deleting one would leave a disabled control saying nothing, which is the
// §9.5 defect rather than the fix.
describe('the ribbons’ hand-written reasons read like the commands’', () => {
  const RIBBONS = [
    'documents/design/ribbon.tsx',
    'documents/diagram/ribbon.tsx',
    'documents/slides/ribbon.tsx',
    'documents/editor/writeRibbon.tsx',
    'documents/sheet/cellsRibbon.tsx',
    'documents/draw/bar/home.tab.tsx',
    'documents/draw/bar/object.tab.tsx'
  ]

  it.each(RIBBONS)('%s', (rel) => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/components', rel), 'utf8')
    const props = [...src.matchAll(/disabledReason="([^"]*)"/g)].map((m) => m[1])
    // Reason CONSTANTS in the same file, which the expression forms pass in.
    const consts = [...src.matchAll(/const (?:NOTHING|NONE_SELECTED|NO_STROKE|nothing) = '([^']*)'/g)].map((m) => m[1])
    const bad = [...props, ...consts].filter((t) => t && !/^[A-Z].*[.!?]$/.test(t))
    expect(bad, `${rel}: a hand-written reason must read as a sentence, like the commands’`).toEqual([])
  })

  it('reads ribbons that really carry hand-written reasons, so this is not vacuous', () => {
    const counted = RIBBONS.map((rel) => {
      const src = readFileSync(join(process.cwd(), 'src/renderer/src/components', rel), 'utf8')
      return [...src.matchAll(/disabledReason="[^"]*"/g)].length
    })
    expect(counted.reduce((a, b) => a + b, 0), 'the sweep found props to check').toBeGreaterThan(15)
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
