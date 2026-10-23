// Rule 3 of the documentOps conversion: with no ops, the document items are
// ABSENT, not disabled.
//
// Why absent matters, and why it is worth a test of its own: a disabled item
// still reads as "this exists but not now", and the host that supplies no ops is
// a snippet session, where those actions do not exist at all — a snippet has no
// trash, no version history and no copy-as-document. The previous version showed
// them enabled and acted on whatever the documents store had open.
//
// And the mirror, which is the regression the optional prop invites: WITH ops
// the items must be there. `documentOps?:` means an unwired host silently loses
// six menu items and the typechecker says nothing.

import { act } from 'react'
import { documentCommands } from '../../src/renderer/src/lib/menus/officeCommand'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentOps } from '../../src/renderer/src/components/documents/editor/documentOps'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import DocMenuBar from '../../src/renderer/src/components/documents/editor/DocMenuBar'
import { writeCommandsFor } from './_writeCommands'
import { cellsCommandsFor } from './_cellsCommands'
import SheetMenuBar from '../../src/renderer/src/components/documents/editor/SheetMenuBar'

const ops = (): DocumentOps => ({
  id: 'doc-1',
  newDocument: vi.fn().mockResolvedValue(undefined),
  makeCopy: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  openHistory: vi.fn(),
  startMeeting: vi.fn(),
  moveToTrash: vi.fn().mockResolvedValue(undefined)
})

// Only the File and Insert menus are opened here, and neither reads the editor,
// so a stub with the few members the render path touches is enough — and keeps
// TipTap out of this file.
const stubEditor = (): unknown => ({
  chain: () => ({ focus: () => ({}) }),
  can: () => ({ undo: () => false, redo: () => false }),
  isActive: () => false,
  getAttributes: () => ({}),
  getHTML: () => '',
  state: { selection: { empty: true } }
})

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: { documents: { get: vi.fn(), create: vi.fn() } }
  }) as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const openMenu = async (testid: string): Promise<string> => {
  const btn = host.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null
  if (!btn) throw new Error(`no menu button [${testid}]`)
  await act(async () => btn.click())
  const list = host.querySelector(`[data-testid="${testid}-list"]`)
  return list?.textContent ?? ''
}

const DOC_ITEMS = ['New document', 'Make a copy', 'Rename', 'Version history', 'Move to Trash']
const SHEET_ITEMS = ['New spreadsheet', 'Make a copy', 'Rename', 'Version history', 'Move to Trash']

describe('PlexiiWrite', () => {
  const mount = async (documentOps?: DocumentOps): Promise<void> => {
    await act(async () => {
      root.render(
        <DocMenuBar commands={writeCommandsFor(stubEditor())} doc={documentCommands(documentOps, 'doc')} />
      )
    })
  }

  it('shows every document item when the host bound a document', async () => {
    await mount(ops())
    const file = await openMenu('doc-menu-file')
    for (const label of DOC_ITEMS) expect(file).toContain(label)
  })

  it('shows none of them when there is no document', async () => {
    await mount(undefined)
    const file = await openMenu('doc-menu-file')
    for (const label of DOC_ITEMS) expect(file).not.toContain(label)
  })

  it('still offers Download without a document', async () => {
    // Download acts on the editor's own content, so removing it would have been
    // the overcorrection: a snippet session can still export what it is showing.
    await mount(undefined)
    expect(await openMenu('doc-menu-file')).toContain('Download')
  })

  it('offers Print only where the host can really print', async () => {
    // The row this replaced was labelled "Print (PDF)" and ran the PDF export:
    // a menu row that said Print and did not print. Real printing is
    // documentCommands().print, which the host adds to its ops, so it is absent
    // with no document AND absent with ops that cannot print — never a row that
    // lies about what it does. Download ▸ PDF is still there in both cases.
    await mount(undefined)
    expect(await openMenu('doc-menu-file')).not.toContain('Print')
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount(ops())
    expect(await openMenu('doc-menu-file')).not.toContain('Print')
    // Positive control: with an ops that CAN print, the row is there, so the two
    // assertions above are about the gate and not about a row that never exists.
    await act(async () => root.unmount())
    root = createRoot(host)
    // `print` is read structurally: agent 19's print engine adds the optional op,
    // so it is not on DocumentOps in this tree yet.
    await mount({ ...ops(), print: vi.fn() } as unknown as DocumentOps)
    expect(await openMenu('doc-menu-file')).toContain('Print')
  })

  it('gates Insert > Meeting too, which is not in the File menu', async () => {
    // It went out as `launchMeeting({ id: active?.id ?? '' })` — the wrong
    // document, or an empty id — and it is the one item here that reaches other
    // people, so it must not survive the gate.
    expect(await (async () => { await mount(ops()); return openMenu('doc-menu-insert') })()).toContain('Meeting')
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount(undefined)
    expect(await openMenu('doc-menu-insert')).not.toContain('Meeting')
  })

  it('runs the ops rather than the store', async () => {
    const o = ops()
    await mount(o)
    await openMenu('doc-menu-file')
    const item = Array.from(host.querySelectorAll('[data-testid="doc-menu-file-list"] button')).find(
      (b) => b.textContent?.includes('Move to Trash')
    ) as HTMLElement
    await act(async () => item.click())
    expect(o.moveToTrash).toHaveBeenCalledTimes(1)
  })
})

describe('PlexiiCells', () => {
  const actions = (documentOps?: DocumentOps): unknown => ({
    title: 'A spreadsheet',
    activeFormat: undefined,
    undo: () => {},
    redo: () => {},
    canUndo: false,
    canRedo: false,
    format: () => {},
    numberFormat: () => {},
    insertRowAbove: () => {},
    insertRowBelow: () => {},
    insertColLeft: () => {},
    insertColRight: () => {},
    deleteRow: () => {},
    deleteCol: () => {},
    sort: () => {},
    toggleFilter: () => {},
    filterActive: false,
    insertChart: () => {},
    insertSparkline: () => {},
    insertPivot: () => {},
    conditionalFormat: () => {},
    dataValidation: () => {},
    addSheet: () => {},
    namedRanges: () => {},
    importFile: () => {},
    exportFile: () => {},
    aiFill: () => {},
    saveSnippet: () => {},
    insertSnippet: () => {},
    documentOps
  })
  const mount = async (documentOps?: DocumentOps): Promise<void> => {
    await act(async () => {
      root.render(<SheetMenuBar commands={cellsCommandsFor()} doc={documentCommands(documentOps, 'sheet')} />)
    })
  }

  it('shows every document item when the host bound a spreadsheet', async () => {
    await mount(ops())
    const file = await openMenu('sheet-menubar-file')
    for (const label of SHEET_ITEMS) expect(file).toContain(label)
  })

  it('shows none of them when there is no document', async () => {
    await mount(undefined)
    const file = await openMenu('sheet-menubar-file')
    for (const label of SHEET_ITEMS) expect(file).not.toContain(label)
  })

  it('keeps Import and Download, which are editor operations despite the menu', async () => {
    // Import replaces the editor's body and emits onChange — the host persists
    // it — so it never touches a document id and is correct with no document at
    // all. Gating it would have removed a working feature from desk widgets.
    await mount(undefined)
    const file = await openMenu('sheet-menubar-file')
    expect(file).toContain('Import')
    expect(file).toContain('Download')
  })
})
