// GUARD for PlexiiCells' one command registry (SPEC §9, "no repeats"), the
// twin of writeCommandRegistry.test.tsx.
//
// What the copies had drifted on, and what each assertion below stops coming
// back:
//
//   menu bar                        ribbon
//   "Center"                        "Align center"   → "Align centre" / "Centre"
//   "Row above"                     "Insert row above"
//   "Save selection as snippet…"    "Save as snippet"
//   "Import (.xlsx / .csv)"         "Import .xlsx / .csv"
//   "Microsoft Excel (.xlsx)"       "Export .xlsx"
//   Chart ▸ offered three kinds     the chart menu offered five
//   Named ranges, under two labels (Insert ▸ "Named range", Data ▸ "Named ranges")
//   Undo / Redo again in the bar, with ⌘Z and ⇧⌘Z written out by hand
//
// And three things that were simply untrue:
//
//   - Bold ⌘B, Italic ⌘I, Underline ⌘U and Clear formatting ⌘\ were all
//     advertised, and the grid bound none of them.
//   - ⌘A ran its own copy of selectAllCells' first two lines rather than
//     calling it. One implementation now, so the menu row and the key cannot
//     diverge — though no behaviour changes by it, because the handler returns
//     at `if (editing)` before the omitted lines could matter.
//   - The ribbon's Import button was marked read-only safe, and `importFile`
//     returns early for a viewer: a button that did nothing.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuDef, MenuItem } from '../../src/renderer/src/components/documents/editor/menuBarKit'
import type { DocumentOps } from '../../src/renderer/src/components/documents/editor/documentOps'
import { runCommandKey } from '../../src/renderer/src/lib/menus/commandKeys'
import { commandHint, paletteEntries } from '../../src/renderer/src/lib/menus/officeCommand'
import { READ_ONLY_REASON } from '../../src/renderer/src/components/office/shell'
import { cellsCommandsFor, sheetActionSpies } from './_cellsCommands'

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

import SheetMenuBar from '../../src/renderer/src/components/documents/editor/SheetMenuBar'
import { CELLS_TABS, type CCtx } from '../../src/renderer/src/components/documents/sheet/cellsRibbon'
import { BarContext } from '../../src/renderer/src/components/office/shell'

const ops = (over: Partial<DocumentOps> = {}): DocumentOps =>
  ({
    id: 'sheet-1',
    newDocument: vi.fn(),
    makeCopy: vi.fn(),
    rename: vi.fn(),
    openHistory: vi.fn(),
    startMeeting: vi.fn(),
    moveToTrash: vi.fn(),
    ...over
  }) as unknown as DocumentOps

const flat = (list: MenuItem[]): Array<MenuItem & { kind: 'item' }> =>
  list.flatMap((i) => (i.kind === 'item' ? [i] : i.kind === 'submenu' ? flat(i.items) : []))
const allMenuRows = (): Array<MenuItem & { kind: 'item' }> =>
  flat((captured['sheet-menubar'] ?? []).flatMap((m) => m.build()))
const menuRows = (label: string): Array<MenuItem & { kind: 'item' }> =>
  flat((captured['sheet-menubar'] ?? []).find((m) => m.label === label)?.build() ?? [])

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

const mountMenuBar = async (commands = cellsCommandsFor(), documentOps?: DocumentOps): Promise<void> => {
  await act(async () => {
    root.render(<SheetMenuBar commands={commands} documentOps={documentOps} />)
  })
}

const mountTab = async (id: string, over: Partial<CCtx> = {}, readOnly = false): Promise<void> => {
  const tab = CELLS_TABS.find((t) => t.id === id)
  if (!tab) throw new Error(`the ribbon has no ${id} tab`)
  const ctx = new Proxy(
    {
      readOnly,
      a: sheetActionSpies(),
      commands: cellsCommandsFor({ readOnly }),
      isMerged: false,
      // Explicit, not through the proxy: FontPicker reads this as a string.
      activeFont: undefined,
      fmt: undefined,
      ...over
    } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : () => undefined) }
  ) as unknown as CCtx
  await act(async () => {
    root.render(<BarContext.Provider value={{ readOnly }}>{tab.render(ctx)}</BarContext.Provider>)
  })
}

const ribbonTips = (): string[] =>
  [...host.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label') ?? '')

describe('the labels the two surfaces had drifted on', () => {
  const c = cellsCommandsFor()

  it.each([
    ['sheet-align-center', 'Align centre', 'Centre'],
    ['sheet-row-above', 'Insert row above', 'Row above'],
    ['sheet-col-left', 'Insert column left', 'Column left'],
    ['sheet-export-xlsx', 'Download Excel (.xlsx)…', 'Microsoft Excel (.xlsx)']
  ])('%s reads "%s", and "%s" under its submenu', (id, label, shortLabel) => {
    expect(c[id]?.label).toBe(label)
    expect(c[id]?.shortLabel).toBe(shortLabel)
  })

  it('keeps the ribbon wording the other three office apps use', () => {
    // Design, Deck and Cells all hold their ribbons to these two, so they are
    // the convention, not drift — and they now live on the same command as the
    // lexicon label rather than in a separate file.
    expect(c['sheet-insert-snippet']?.barLabel).toBe('Saved snippet…')
    expect(c['sheet-insert-snippet']?.label).toBe('Insert snippet…')
    expect(c['sheet-save-snippet']?.barLabel).toBe('Save as snippet…')
    expect(c['sheet-save-snippet']?.label).toBe('Save selection as snippet…')
  })

  it('keeps no trace of the labels it replaced', () => {
    // "Row above" and "Export .xlsx" are not gone — they are the submenu and
    // ribbon forms, which now live on the same command as the standalone
    // label. What is gone is a label with no twin anywhere.
    const gone = ['Align center', 'Named range', 'Save as snippet', 'Saved snippet']
    const live = Object.values(c).flatMap((k) => [k.label, k.shortLabel ?? '', k.barLabel ?? ''])
    for (const bad of gone) expect(live).not.toContain(bad)
  })

  it('lists Named ranges exactly once in the whole menu bar', async () => {
    // It was in Insert as "Named range" and in Data as "Named ranges" — one
    // action, two rows, two labels.
    await mountMenuBar()
    const named = allMenuRows().filter((r) => /^Named range/.test(r.label))
    expect(named.map((r) => r.label)).toEqual(['Named ranges'])
    expect(menuRows('Data').map((r) => r.label)).toContain('Named ranges')
  })

  it('offers the same five chart kinds in the menu as the ribbon', async () => {
    await mountMenuBar()
    const charts = allMenuRows()
      .map((r) => r.label)
      .filter((l) => l.endsWith(' chart'))
    expect(charts).toEqual(['Bar chart', 'Line chart', 'Pie chart', 'Area chart', 'Scatter chart'])
  })
})

describe('the keys PlexiiCells advertised and never bound', () => {
  const run = (id: string, key: string, mods: Record<string, boolean> = { metaKey: true }): unknown => {
    const a = sheetActionSpies()
    const c = cellsCommandsFor({ a })
    const handled = runCommandKey(Object.values(c), { key, ...mods }, 'darwin')
    return { a, handled, cmd: c[id] }
  }

  it('binds ⌘B, ⌘I and ⌘U to the format the menu row runs', () => {
    for (const [key, field] of [
      ['b', 'bold'],
      ['i', 'italic'],
      ['u', 'underline']
    ] as const) {
      const { a, handled } = run(`sheet-${field}`, key) as { a: ReturnType<typeof sheetActionSpies>; handled: boolean }
      expect(handled, `⌘${key.toUpperCase()} is bound`).toBe(true)
      expect(a.format).toHaveBeenCalledWith({ [field]: true })
    }
  })

  it('binds Clear formatting to ⌘\\', () => {
    const { a, handled } = run('sheet-clear-format', '\\') as { a: ReturnType<typeof sheetActionSpies>; handled: boolean }
    expect(handled).toBe(true)
    expect(a.format).toHaveBeenCalledWith({ bold: false, italic: false, underline: false, numFmt: { kind: 'general' } })
  })

  it('shows the hint the binding really is', () => {
    const c = cellsCommandsFor()
    expect(commandHint(c['sheet-bold']!, 'darwin')).toBe('⌘B')
    expect(commandHint(c['sheet-italic']!, 'darwin')).toBe('⌘I')
    expect(commandHint(c['sheet-underline']!, 'darwin')).toBe('⌘U')
    expect(commandHint(c['sheet-clear-format']!, 'darwin')).toBe('⌘\\')
    expect(commandHint(c['sheet-select-all']!, 'darwin')).toBe('⌘A')
  })
})

describe('a viewer', () => {
  const ro = cellsCommandsFor({ readOnly: true })
  const rw = cellsCommandsFor({ readOnly: false })

  it.each(['sheet-bold', 'sheet-italic', 'sheet-underline', 'sheet-clear-format', 'sheet-align-center', 'sheet-row-above', 'sheet-delete-row', 'sheet-paste', 'sheet-cut', 'sheet-sort-asc', 'sheet-filter', 'sheet-ai-fill', 'sheet-merge', 'sheet-numfmt-percent'])(
    'cannot %s, and is told why',
    (id) => {
      expect(ro[id]?.enabled?.()).toBe(false)
      expect(ro[id]?.reason?.()).toBe(READ_ONLY_REASON)
      // Positive control from the same observation: the identical command is
      // live for an editor.
      expect(rw[id]?.enabled?.()).toBe(true)
      expect(rw[id]?.reason?.()).toBeUndefined()
    }
  )

  it('cannot Import either, which the ribbon used to let them press', () => {
    // `importFile` returns early when readOnly, so the read-only-safe button
    // was a control that did nothing. It is an edit.
    expect(ro['sheet-import']?.enabled?.()).toBe(false)
    expect(ro['sheet-import']?.reason?.()).toBe(READ_ONLY_REASON)
    expect(rw['sheet-import']?.enabled?.()).toBe(true)
  })

  it.each(['sheet-copy', 'sheet-select-all', 'sheet-find', 'sheet-export-xlsx', 'sheet-export-csv', 'sheet-save-snippet', 'sheet-named-ranges'])(
    'may still %s',
    (id) => {
      expect(ro[id]?.enabled?.() ?? true).toBe(true)
    }
  )

  it('gets Undo back in the palette once there is something to undo', () => {
    // Why the palette registration lists canUndo among its deps: the row's
    // presence depends on it, so a snapshot taken before the first edit would
    // keep Undo out of ⌘K afterwards.
    const none = cellsCommandsFor({ a: sheetActionSpies({ canUndo: false }) })
    expect(paletteEntries(Object.values(none)).map((e) => e.id)).not.toContain('sheet-undo')
    expect(paletteEntries(Object.values(cellsCommandsFor())).map((e) => e.id)).toContain('sheet-undo')
  })

  it('presses ⌘B and nothing is formatted', () => {
    // The grid's handler delegates every registry key to runCommandKey, so the
    // gate is here: the action that would change the sheet is never reached.
    const a = sheetActionSpies()
    const viewer = cellsCommandsFor({ a, readOnly: true })
    expect(runCommandKey(Object.values(viewer), { key: 'b', metaKey: true }, 'darwin')).toBe(false)
    expect(a.format).not.toHaveBeenCalled()

    // Positive control: the same press on an editable sheet does format.
    const b = sheetActionSpies()
    expect(runCommandKey(Object.values(cellsCommandsFor({ a: b })), { key: 'b', metaKey: true }, 'darwin')).toBe(true)
    expect(b.format).toHaveBeenCalledWith({ bold: true })
  })

  it('may still press ⌘A, because selecting changes nothing', () => {
    const a = sheetActionSpies()
    const viewer = cellsCommandsFor({ a, readOnly: true })
    expect(runCommandKey(Object.values(viewer), { key: 'a', metaKey: true }, 'darwin')).toBe(true)
    expect(a.selectAll).toHaveBeenCalledTimes(1)
  })

  it('sees the ribbon disabled with the same reason the menu gives', async () => {
    await mountTab('home', {}, true)
    expect(ribbonTips()).toContain(`Bold — ${READ_ONLY_REASON}`)
    expect(host.querySelector<HTMLButtonElement>('button[aria-label^="Bold"]')?.disabled).toBe(true)
  })

  it('keeps the read-only-safe Tools controls and loses Import', async () => {
    // `readOnlySafe` is DERIVED from the registry gate, so this proves the
    // derivation rather than a hand-placed flag — and both halves come from
    // the one read-only render.
    await mountTab('tools', {}, true)
    const byLabel = (prefix: string): HTMLButtonElement | null =>
      [...host.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((b) =>
        (b.getAttribute('aria-label') ?? '').startsWith(prefix)
      ) ?? null
    expect(byLabel('Export .xlsx')?.disabled).toBe(false)
    expect(byLabel('Export .csv')?.disabled).toBe(false)
    expect(byLabel('Import .xlsx')?.disabled).toBe(true)
    expect(byLabel('Import .xlsx')?.getAttribute('aria-label')).toContain(READ_ONLY_REASON)
  })
})

describe('Download ▸ PDF', () => {
  it('is there only where the host can really produce one', async () => {
    // Read structurally from the ops, like Print: absent rather than dead.
    await mountMenuBar(cellsCommandsFor(), ops())
    expect(menuRows('File').map((r) => r.label)).not.toContain('PDF document (.pdf)')

    await act(async () => root.unmount())
    root = createRoot(host)
    await mountMenuBar(cellsCommandsFor({ exportPdf: vi.fn() }), ops())
    expect(menuRows('File').map((r) => r.label)).toContain('PDF document (.pdf)')
  })

  it('offers Print only where the host can really print', async () => {
    await mountMenuBar(cellsCommandsFor(), ops())
    expect(menuRows('File').map((r) => r.label)).not.toContain('Print…')
    await act(async () => root.unmount())
    root = createRoot(host)
    await mountMenuBar(cellsCommandsFor(), ops({ print: vi.fn() } as unknown as Partial<DocumentOps>))
    expect(menuRows('File').map((r) => r.label)).toContain('Print…')
  })
})

describe('the surfaces render FROM the registry', () => {
  it('the menu bar shows whatever label the registry carries', async () => {
    const commands = cellsCommandsFor()
    commands['sheet-clear-format'] = { ...commands['sheet-clear-format']!, label: 'Registry-sourced' }
    await mountMenuBar(commands)
    expect(allMenuRows().map((r) => r.label)).toContain('Registry-sourced')
    expect(allMenuRows().map((r) => r.label)).not.toContain('Clear formatting')
  })

  it('the ribbon shows whatever label the registry carries', async () => {
    const commands = cellsCommandsFor()
    commands['sheet-bold'] = { ...commands['sheet-bold']!, label: 'Registry-sourced' }
    await mountTab('home', { commands })
    expect(ribbonTips().some((t) => t.startsWith('Registry-sourced'))).toBe(true)
    expect(ribbonTips().some((t) => t.startsWith('Bold'))).toBe(false)
  })

  it('names a missing id instead of rendering a blank control', async () => {
    const commands = cellsCommandsFor()
    delete commands['sheet-bold']
    await mountMenuBar(commands)
    expect(() => allMenuRows()).toThrow('SheetMenuBar: no command "sheet-bold"')

    const home = CELLS_TABS.find((t) => t.id === 'home')
    if (!home) throw new Error('the ribbon has no Home tab')
    expect(() => home.render({ readOnly: false, a: sheetActionSpies(), commands, isMerged: false } as unknown as CCtx)).toThrow(
      'cellsRibbon: no command "sheet-bold"'
    )
  })

  it('says why Undo is off instead of greying it silently', async () => {
    await mountMenuBar(cellsCommandsFor({ a: sheetActionSpies({ canUndo: false }) }))
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
  // The guard that actually bites, as in writeCommandRegistry.test.tsx: the
  // tests above compare labels inside the registry, so they cannot see a new
  // `<BarToggle label="Align center" …>` added straight to a tab — which is
  // how the drift happened the first time.
  //
  // Adding a control here is a deliberate act: if it has a twin in the menu bar
  // or the palette, it belongs in cellsCommands.ts instead.
  const RIBBON_ONLY = [
    'Font',
    'Text colour',
    'Fill colour',
    'Number format',
    'Insert chart',
    'Delete row',
    'Delete column'
  ]

  const formsOf = (tip: string): string[] => [tip, tip.replace(/ \([^)]*\)$/, ''), tip.replace(/ — .*$/, '')]

  it.each(['home', 'insert', 'data', 'tools'])('%s tab', async (id) => {
    const commands = cellsCommandsFor()
    const known = new Set<string>()
    for (const c of Object.values(commands)) {
      known.add(c.label)
      if (c.barLabel) known.add(c.barLabel)
      if (c.shortLabel) known.add(c.shortLabel)
    }
    await mountTab(id, { commands })
    // Not vacuous: a tab that rendered nothing has no strays either, and would
    // pass this while seeing none of the ribbon.
    expect(ribbonTips().length, `the ${id} tab rendered no buttons at all`).toBeGreaterThan(1)
    const strays = ribbonTips().filter(
      (tip) => tip && !formsOf(tip).some((f) => known.has(f) || RIBBON_ONLY.includes(f))
    )
    expect(strays, `hand-written in the ${id} tab — put it in cellsCommands.ts, or name it in RIBBON_ONLY`).toEqual([])
  })
})
