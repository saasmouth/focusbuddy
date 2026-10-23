// GUARD for PlexiiWrite's one command registry (SPEC §9, "no repeats").
//
// Write's actions used to be written out three times — the menu bar, the
// ContextBar ribbon and the Cmd+K palette each had their own copy — and the
// three had drifted. These are the divergences this registry removed, and the
// assertions below are what stops each one coming back:
//
//   menu bar              ribbon                  palette
//   "Normal text"         —                       "Body text"
//   "Center"              "Align center"          "Align centre"
//   "Bulleted list"       "Bullet list"           "Bulleted list"
//   "Horizontal line"     "Divider"               "Divider"
//   "Check accessibility" "Accessibility check"   —
//   "Insert snippet…"     "Insert saved snippet"  —
//   Find… ⌘F + Find and replace… ⇧⌘H              one row, "Find and
//                                                 replace" on ⌘F — a hint
//                                                 that was simply wrong
//   "Print (PDF)" running the PDF export: a row that said Print, and did not
//   print. Deleted; real printing is documentCommands().print.
//   The ribbon's Link button advertised ⌘K, which is the Command Center's.
//
// Written against the REAL registry and the REAL surfaces, never a lookalike.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import type { MenuDef, MenuItem } from '../../src/renderer/src/components/documents/editor/menuBarKit'
import { commandHint, documentCommands, paletteEntries } from '../../src/renderer/src/lib/menus/officeCommand'
import { runCommandKey } from '../../src/renderer/src/lib/menus/commandKeys'
import type { DocumentOps } from '../../src/renderer/src/components/documents/editor/documentOps'
import { READ_ONLY_REASON } from '../../src/renderer/src/components/office/shell'
import { writeCommandsFor } from './_writeCommands'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

const captured: Record<string, MenuDef[]> = {}
vi.mock('../../src/renderer/src/components/documents/editor/menuBarKit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/renderer/src/components/documents/editor/menuBarKit')>()
  return {
    ...real,
    MenuBarShell: ({ menus, testid }: { menus: MenuDef[]; testid: string }) => {
      captured[testid] = menus
      return null
    }
  }
})

import DocMenuBar from '../../src/renderer/src/components/documents/editor/DocMenuBar'
import { WRITE_TABS, type WCtx } from '../../src/renderer/src/components/documents/editor/writeRibbon'
import { BarContext } from '../../src/renderer/src/components/office/shell'

/** An editor that answers the few things the registry asks, and nothing more. */
function stubEditor(active: string[] = []): Editor {
  const chain: unknown = new Proxy(function () {}, {
    get: () => () => chain,
    apply: () => chain
  })
  return {
    isActive: (n: unknown) => typeof n === 'string' && active.includes(n),
    getAttributes: () => ({}),
    can: () => ({ undo: () => true, redo: () => true }),
    chain: () => chain,
    getHTML: () => '<p></p>',
    getText: () => '',
    getJSON: () => ({ type: 'doc', content: [] }),
    state: { selection: { empty: false } },
    storage: {}
  } as unknown as Editor
}

const flat = (list: MenuItem[]): Array<MenuItem & { kind: 'item' }> =>
  list.flatMap((i) => (i.kind === 'item' ? [i] : i.kind === 'submenu' ? flat(i.items) : []))

/** Every row of every Write menu, submenus included. */
const allMenuRows = (): Array<MenuItem & { kind: 'item' }> =>
  flat((captured['doc-menubar'] ?? []).flatMap((m) => m.build()))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: { platform: 'darwin' }
  }) as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  for (const k of Object.keys(captured)) delete captured[k]
})

const mountMenuBar = async (commands = writeCommandsFor(stubEditor())): Promise<void> => {
  await act(async () => {
    root.render(<DocMenuBar commands={commands} doc={null} />)
  })
}

const mountTab = async (id: string, over: Partial<WCtx> = {}, readOnly = false): Promise<void> => {
  const home = WRITE_TABS.find((t) => t.id === id)
  if (!home) throw new Error(`the ribbon has no ${id} tab`)
  const ctx = new Proxy(
    {
      editor: stubEditor(),
      readOnly,
      commands: writeCommandsFor(stubEditor(), { readOnly }),
      ...over
    } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : () => undefined) }
  ) as unknown as WCtx
  await act(async () => {
    root.render(
      <BarContext.Provider value={{ readOnly }}>{home.render(ctx)}</BarContext.Provider>
    )
  })
}

/** Every ribbon control's tooltip text, which is `label (⌘X)` or `label — reason`. */
const ribbonTips = (): string[] =>
  [...host.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label') ?? '')

describe('the registry is the single definition', () => {
  it('names a missing id instead of rendering a blank control', async () => {
    // Both surfaces, and both synchronously: the menus are built lazily by
    // `build()`, which this test calls itself, and a ribbon tab's render is a
    // plain function.
    const commands = writeCommandsFor(stubEditor())
    delete commands['doc-bold']
    await mountMenuBar(commands)
    expect(() => allMenuRows()).toThrow('DocMenuBar: no command "doc-bold"')

    const home = WRITE_TABS.find((t) => t.id === 'home')
    if (!home) throw new Error('the ribbon has no Home tab')
    const ctx = { editor: stubEditor(), readOnly: false, commands } as unknown as WCtx
    expect(() => home.render(ctx)).toThrow('writeRibbon: no command "doc-bold"')
  })
})

describe('the labels the three surfaces had drifted on', () => {
  const c = writeCommandsFor(stubEditor())

  it.each([
    ['doc-paragraph', 'Normal text'],
    ['doc-align-center', 'Align centre'],
    ['doc-bullets', 'Bulleted list'],
    ['doc-a11y', 'Check accessibility'],
    ['doc-insert-snippet', 'Insert snippet…'],
    ['doc-save-snippet', 'Save selection as snippet…'],
    ['doc-divider', 'Insert horizontal line']
  ])('%s is "%s" everywhere', (id, label) => {
    expect(c[id]?.label).toBe(label)
  })

  it('keeps no trace of the labels it replaced', () => {
    // The guard that actually bites: a future hand-written control reviving one
    // of these fails here, whichever surface it is added to.
    const gone = ['Body text', 'Bullet list', 'Accessibility check', 'Align center', 'Print (PDF)', 'Insert saved snippet', 'Divider']
    const live = Object.values(c).flatMap((k) => [k.label, k.shortLabel ?? ''])
    for (const bad of gone) expect(live).not.toContain(bad)
  })

  it('shortens a row only under a menu whose title supplies the verb', () => {
    // Align ▸ "Centre" and Download ▸ "Microsoft Word (.docx)" read correctly
    // under their titles, while the palette needs the standalone form. Both
    // forms live on the one command, so they cannot drift apart.
    expect(c['doc-align-center']?.shortLabel).toBe('Centre')
    expect(c['doc-export-docx']?.shortLabel).toBe('Microsoft Word (.docx)')
    expect(c['doc-export-docx']?.label).toBe('Download Word (.docx)…')
    // A command with no submenu home has no short form at all.
    expect(c['doc-clear-format']?.shortLabel).toBeUndefined()
  })
})

describe('the hints', () => {
  const c = writeCommandsFor(stubEditor())

  it('gives Find ⌘F and Find and replace ⇧⌘H, which the palette had wrong', () => {
    expect(c['doc-find']?.label).toBe('Find…')
    expect(commandHint(c['doc-find']!, 'darwin')).toBe('⌘F')
    expect(c['doc-find-replace']?.label).toBe('Find and replace…')
    expect(commandHint(c['doc-find-replace']!, 'darwin')).toBe('⇧⌘H')
  })

  it('binds Clear formatting to ⌘\\ from the shared lexicon', () => {
    // One lexicon entry, so PlexiiCells cannot drift to another key.
    expect(commandHint(c['doc-clear-format']!, 'darwin')).toBe('⌘\\')
  })

  it('gives Insert link no key, because ⌘K is the Command Center’s', () => {
    expect(commandHint(c['doc-insert-link']!, 'darwin')).toBeUndefined()
  })
})

describe('a viewer', () => {
  const ro = writeCommandsFor(stubEditor(), { readOnly: true })
  const rw = writeCommandsFor(stubEditor(), { readOnly: false })

  it.each(['doc-bold', 'doc-paragraph', 'doc-align-center', 'doc-clear-format', 'doc-insert-image', 'doc-insert-table', 'doc-paste', 'doc-cut', 'doc-find-replace', 'doc-ai-rewrite'])(
    'cannot %s, and is told why',
    (id) => {
      expect(ro[id]?.enabled?.()).toBe(false)
      expect(ro[id]?.reason?.()).toBe(READ_ONLY_REASON)
      // Positive control from the same observation: the identical command is
      // live for an editor, so the assertion above is about view-only access
      // and not about a command that is always off.
      expect(rw[id]?.enabled?.()).toBe(true)
      expect(rw[id]?.reason?.()).toBeUndefined()
    }
  )

  it.each(['doc-copy', 'doc-select-all', 'doc-find', 'doc-wordcount', 'doc-a11y', 'doc-outline', 'doc-comments', 'doc-export-docx', 'doc-export-pdf', 'doc-save-snippet'])(
    'may still %s',
    (id) => {
      expect(ro[id]?.enabled?.() ?? true).toBe(true)
    }
  )

  it('gets Undo back in the palette once there is something to undo', () => {
    // Why the palette registration lists `can().undo()` among its deps: the
    // row's presence depends on it, so a snapshot taken before the first
    // keystroke would keep Undo out of ⌘K afterwards.
    const cannot = stubEditor()
    ;(cannot as unknown as { can: () => unknown }).can = () => ({ undo: () => false, redo: () => false })
    expect(paletteEntries(Object.values(writeCommandsFor(cannot))).map((e) => e.id)).not.toContain('doc-undo')
    expect(paletteEntries(Object.values(writeCommandsFor(stubEditor()))).map((e) => e.id)).toContain('doc-undo')
  })

  it('is not offered the editing rows in the palette at all', () => {
    // A palette row cannot show why it is off, so paletteEntries drops it.
    const ids = paletteEntries(Object.values(ro)).map((e) => e.id)
    expect(ids).not.toContain('doc-bold')
    expect(ids).toContain('doc-wordcount')
    expect(paletteEntries(Object.values(rw)).map((e) => e.id)).toContain('doc-bold')
  })

  it('sees the ribbon disabled with the same reason the menu gives', async () => {
    await mountTab('home', {}, true)
    const bold = ribbonTips().find((t) => t.startsWith('Bold'))
    expect(bold).toBe(`Bold — ${READ_ONLY_REASON}`)
    expect(host.querySelector<HTMLButtonElement>('button[aria-label^="Bold"]')?.disabled).toBe(true)
  })

  it('still gets the read-only-safe ribbon controls', async () => {
    // `readOnlySafe` is DERIVED in the ribbon from the registry gate — a
    // command with no `enabled` changes nothing — so this proves the
    // derivation rather than a hand-placed flag. Word count and Check
    // accessibility only read, so they stay live on a view-only sheet.
    await mountTab('review', {}, true)
    const live = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label]')].filter((b) => !b.disabled)
    const labels = live.map((b) => b.getAttribute('aria-label'))
    expect(labels).toContain('Word count')
    expect(labels).toContain('Check accessibility')
    // Positive control from the same render: Suggesting edits the document, so
    // it is off — the tab is genuinely in its read-only state.
    const suggest = host.querySelector<HTMLButtonElement>('[data-testid="doc-suggest-toggle"]')
    expect(suggest?.disabled).toBe(true)
  })
})

describe('the ribbon renders FROM the registry', () => {
  it('shows whatever label the registry carries', async () => {
    // The fail-without proof for the ribbon wiring: a hand-written label would
    // ignore this and the test would go red.
    const commands = writeCommandsFor(stubEditor())
    commands['doc-bold'] = { ...commands['doc-bold']!, label: 'Registry-sourced' }
    await mountTab('home', { commands })
    expect(ribbonTips().some((t) => t.startsWith('Registry-sourced'))).toBe(true)
    expect(ribbonTips().some((t) => t.startsWith('Bold'))).toBe(false)
  })

  it('shows the registry hint beside the label', async () => {
    await mountTab('home', )
    expect(ribbonTips()).toContain('Bold (⌘B)')
    expect(ribbonTips()).toContain('Clear formatting (⌘\\)')
  })

  it('marks a toggle pressed from the registry state', async () => {
    const ed = stubEditor(['bold'])
    await mountTab('home', { editor: ed, commands: writeCommandsFor(ed) })
    expect(host.querySelector('button[aria-label^="Bold"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('button[aria-label^="Italic"]')?.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('the menu bar renders FROM the registry', () => {
  it('shows whatever label the registry carries', async () => {
    const commands = writeCommandsFor(stubEditor())
    commands['doc-clear-format'] = { ...commands['doc-clear-format']!, label: 'Registry-sourced' }
    await mountMenuBar(commands)
    expect(allMenuRows().map((r) => r.label)).toContain('Registry-sourced')
    expect(allMenuRows().map((r) => r.label)).not.toContain('Clear formatting')
  })

  it('says why Undo is off instead of greying it silently', async () => {
    const ed = stubEditor()
    ;(ed as unknown as { can: () => unknown }).can = () => ({ undo: () => false, redo: () => true })
    await mountMenuBar(writeCommandsFor(ed))
    const undo = allMenuRows().find((r) => r.label === 'Undo')
    expect(undo?.disabled).toBe(true)
    expect(undo?.hint).toBe('nothing to undo')
    // Positive control: Redo, from the same render, is live and unexplained.
    const redo = allMenuRows().find((r) => r.label === 'Redo')
    expect(redo?.disabled).toBe(false)
    expect(redo?.hint).toBeUndefined()
  })
})

describe('no surface may grow a hand-written copy', () => {
  // The guard that actually bites. The tests above compare labels INSIDE the
  // registry, so they cannot see a new `<BarToggle label="Bullet list" …>`
  // added straight to a tab — which is exactly how the drift happened the
  // first time. This walks every button the ribbon really renders and requires
  // each one to come from the registry, or to be named below as a control the
  // ribbon genuinely owns alone.
  //
  // Adding a control here is a deliberate act: if it has a twin in the menu bar
  // or the palette, it belongs in the registry instead.
  const RIBBON_ONLY = [
    'Styles — apply and customise paragraph styles',
    'Font',
    'Font size',
    'Text colour',
    'Highlight',
    'Line spacing',
    'Subscript',
    'Superscript',
    'View',
    'Toggle portrait / landscape',
    'Paper size',
    'Page margins',
    'Show the ruler — drag the markers to set page margins',
    'Suggesting — track every change',
    'Accept all changes',
    'Reject all changes',
    'Comments',
    'Outline',
    'Header & footer',
    'Link',
    'Add row below',
    'Add column right',
    'Delete row',
    'Delete table',
    'Insert work widget',
    'Office',
    'Ask PlexiiAssist',
    'Draft with AI'
  ]

  /**
   * The forms a tooltip can take: the label itself, `label (⌘X)`, or
   * `label — reason`. Both stripped forms are offered, because a label may
   * itself contain an em dash ("Styles — apply and customise paragraph
   * styles"), and stripping that would invent a control that is not there.
   */
  const formsOf = (tip: string): string[] => [tip, tip.replace(/ \([^)]*\)$/, ''), tip.replace(/ — .*$/, '')]

  it.each(['home', 'insert', 'layout', 'review', 'table'])('%s tab', async (id) => {
    const commands = writeCommandsFor(stubEditor())
    const known = new Set<string>()
    for (const c of Object.values(commands)) {
      known.add(c.label)
      if (c.barLabel) known.add(c.barLabel)
    }
    await mountTab(id, { commands })
    // Not vacuous: a tab that rendered nothing has no strays either, and would
    // pass this while seeing none of the ribbon.
    expect(ribbonTips().length, `the ${id} tab rendered no buttons at all`).toBeGreaterThan(1)
    const strays = ribbonTips().filter(
      (tip) => tip && !formsOf(tip).some((f) => known.has(f) || RIBBON_ONLY.includes(f))
    )
    expect(strays, `hand-written in the ${id} tab — put it in writeCommands.ts, or name it in RIBBON_ONLY`).toEqual([])
  })
})

const ops = (over: Partial<DocumentOps> = {}): DocumentOps =>
  ({
    id: 'doc-1',
    newDocument: vi.fn(),
    makeCopy: vi.fn(),
    rename: vi.fn(),
    openHistory: vi.fn(),
    startMeeting: vi.fn(),
    moveToTrash: vi.fn(),
    ...over
  }) as unknown as DocumentOps

describe('⌘P', () => {
  // The gap this closes (found by session 19 reading registry-41): Print
  // carries ⌘P through sharedCommand, so every File menu SHOWS the hint, and
  // outside PlexiiDraw nothing matched the key. The menu bar used to build its
  // own copy of documentCommands, so the object the hint came from was not an
  // object any matcher could see. The host builds them once now and hands the
  // same array to the menu and to the key handler.
  it('runs the host\u2019s print where it can print, and matches nothing where it cannot', () => {
    const print = vi.fn()
    const canPrint = documentCommands(ops({ print } as unknown as Partial<DocumentOps>), 'doc')
    expect(canPrint).not.toBeNull()
    expect(runCommandKey(Object.values(canPrint!), { key: 'p', metaKey: true }, 'darwin')).toBe(true)
    expect(print).toHaveBeenCalledTimes(1)

    // Without the op there is no Print command at all, so ⌘P matches nothing
    // rather than reaching a row that cannot print.
    const cannot = documentCommands(ops(), 'doc')
    expect(cannot).not.toBeNull()
    expect(Object.values(cannot!).some((c) => c.id === 'file.print')).toBe(false)
    expect(runCommandKey(Object.values(cannot!), { key: 'p', metaKey: true }, 'darwin')).toBe(false)
  })

  it('shows \u2318P as the hint, from the same command the key matched', () => {
    const doc = documentCommands(ops({ print: vi.fn() } as unknown as Partial<DocumentOps>), 'doc')
    expect(commandHint(doc!.print!, 'darwin')).toBe('\u2318P')
  })

  it('leaves a viewer alone, because moving to trash is not bound to a key', () => {
    // Positive control for the matcher's scope: the other document actions are
    // keyless, so passing the whole group to the matcher cannot fire them.
    const del = vi.fn()
    const doc = documentCommands(ops({ moveToTrash: del }), 'doc')
    for (const key of ['t', 'Backspace', 'Delete']) {
      expect(runCommandKey(Object.values(doc!), { key, metaKey: true }, 'darwin')).toBe(false)
    }
    expect(del).not.toHaveBeenCalled()
  })
})

describe('the hosts really hand their document commands to the key matcher', () => {
  // A source guard, like tests/unit/officeShellStackingGuard.test.ts. The ⌘P
  // tests above prove documentCommands + runCommandKey together, but they
  // cannot see whether DocEditor and SheetEditor actually pass the document
  // commands into the matcher — and that hookup is the whole fix. An end-to-end
  // press needs ops.print, which arrives with the print engine (print-41), so
  // until then this is what holds the wiring in place.
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

  it('DocEditor matches the document commands alongside the editor ones', () => {
    const src = read('src/renderer/src/components/documents/DocEditor.tsx')
    expect(src, 'DocEditor builds the document commands itself').toContain("documentCommands(documentOps, 'doc')")
    // The matched array must carry both halves. Sliced to the call rather than
    // matched with a lazy regex: the array literal contains `[]` of its own,
    // which a non-greedy match stops at.
    const from = src.indexOf('const bound = [')
    const to = src.indexOf('runCommandKey(bound', from)
    expect(from, 'DocEditor builds a `bound` array').toBeGreaterThan(-1)
    expect(to, '…and passes it to runCommandKey').toBeGreaterThan(from)
    const call = src.slice(from, to)
    expect(call, 'the editor commands are matched').toContain('KEY_BOUND_HERE')
    expect(call, 'the document commands are matched too — this is what binds ⌘P').toContain('docKeysRef.current')
    expect(src).toContain('runCommandKey(bound, event)')
  })

  it('SheetEditor matches the document commands alongside the sheet ones', () => {
    const src = read('src/renderer/src/components/documents/SheetEditor.tsx')
    expect(src, 'SheetEditor builds the document commands itself').toContain("documentCommands(documentOps, 'sheet')")
    const from = src.indexOf('runCommandKey([')
    const to = src.indexOf(', e)', from)
    expect(from, 'SheetEditor matches keys in its grid handler').toBeGreaterThan(-1)
    const call = src.slice(from, to)
    expect(call, 'the sheet commands are matched').toContain('Object.values(commands)')
    expect(call, 'the document commands are matched too — this is what binds ⌘P').toContain('docRef.current')
  })
})
