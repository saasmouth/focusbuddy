// DocumentOps.print / exportPdf: where Print… exists, and what it prints.
//
// Present for the five printable apps on the desktop; absent (not disabled) in
// the browser runtime, which has no printer, and for Draw, which keeps ⌘P
// (SPEC §9.5). print() sends the request the BOUND editor builds, so a desk
// widget prints its own document, and it never reads the store's `active`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/plexi/PromptDialog', () => ({ confirmDialog: async () => true, promptText: async () => null }))
vi.mock('../../src/renderer/src/lib/startMeeting', () => ({ launchMeeting: vi.fn() }))
vi.mock('../../src/renderer/src/components/documents/DocHistoryPanel', () => ({ openDocHistory: vi.fn() }))

import { createDocumentOps, PRINTABLE_DOC_TYPES } from '../../src/renderer/src/components/documents/editor/documentOps'
import { bindPrintSource, printSourceOf } from '../../src/renderer/src/components/documents/editor/printSource'
import { useNoticeStore } from '../../src/renderer/src/stores/notice'
import type { DocType } from '../../src/shared/types'
import type { PrintRequest } from '../../src/shared/printJob'

const printDocument = vi.fn(async (_req: PrintRequest) => ({ ok: true }))
const sheetPdf = vi.fn(async () => ({ ok: true, path: '/tmp/Budget.pdf' }))

const make = (docType: DocType, id = `doc-${docType}`) =>
  createDocumentOps({ id, docType, title: () => 'Budget', onOpen: vi.fn(), onTrashed: vi.fn() })

beforeEach(() => {
  printDocument.mockClear()
  sheetPdf.mockClear()
  ;(window as unknown as { api: unknown }).api = { documents: {}, print: { document: printDocument, sheetPdf } }
  delete (globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__
  useNoticeStore.getState().clear()
})
afterEach(() => {
  delete (globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__
})

describe('where Print… exists', () => {
  it('the five document office apps, on the desktop', () => {
    expect([...PRINTABLE_DOC_TYPES].sort()).toEqual(['design', 'doc', 'map', 'sheet', 'slides'])
    for (const t of PRINTABLE_DOC_TYPES) expect(typeof make(t).print, t).toBe('function')
  })

  it('not Draw: it reserves ⌘P', () => {
    expect('print' in make('draw')).toBe(false)
  })

  it('not in the browser runtime: absent, not disabled', () => {
    ;(globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__ = true
    for (const t of PRINTABLE_DOC_TYPES) {
      const ops = make(t)
      expect('print' in ops, t).toBe(false)
      expect('exportPdf' in ops, t).toBe(false)
    }
  })

  it('not where the preload has no print bridge', () => {
    ;(window as unknown as { api: unknown }).api = { documents: {} }
    expect('print' in make('doc')).toBe(false)
  })

  it('Download ▸ PDF through ops only for Cells, the app with no export of its own', () => {
    expect(typeof make('sheet').exportPdf).toBe('function')
    for (const t of ['doc', 'slides', 'design', 'map'] as DocType[]) expect('exportPdf' in make(t), t).toBe(false)
  })
})

describe('what it prints', () => {
  it("the bound editor's request, for THESE ops", async () => {
    const a = make('doc', 'doc-A')
    const b = make('doc', 'doc-B')
    bindPrintSource(a, () => ({ app: 'write', title: 'A', html: '<p>A</p>' }))
    bindPrintSource(b, () => ({ app: 'write', title: 'B', html: '<p>B</p>' }))
    await a.print!()
    expect(printDocument).toHaveBeenCalledTimes(1)
    expect(printDocument.mock.calls[0][0]).toMatchObject({ app: 'write', title: 'A', html: '<p>A</p>' })
  })

  it('an editor that has not bound yet says so, and nothing is sent', async () => {
    const ops = make('slides', 'doc-unbound')
    expect(printSourceOf(ops)).toBeUndefined()
    await ops.print!()
    expect(printDocument).not.toHaveBeenCalled()
    expect(useNoticeStore.getState().notice?.text).toMatch(/still opening/)
  })

  it("unbinding removes only the editor's own binding", () => {
    const ops = make('design', 'doc-D')
    const first = bindPrintSource(ops, () => null)
    const second = () => ({ app: 'design', title: 'D', design: {} }) as PrintRequest
    bindPrintSource(ops, second)
    first()
    expect(printSourceOf(ops)).toBe(second)
  })

  it('a refused job is shown; a dismissed dialog is not an error', async () => {
    const ops = make('doc', 'doc-E')
    bindPrintSource(ops, () => ({ app: 'write', title: 'E', html: '' }))
    printDocument.mockResolvedValueOnce({ ok: false, cancelled: true } as never)
    await ops.print!()
    expect(useNoticeStore.getState().notice).toBeNull()
    printDocument.mockResolvedValueOnce({ ok: false, error: 'Could not print: Printer out of paper' } as never)
    await ops.print!()
    expect(useNoticeStore.getState().notice?.text).toBe('Could not print: Printer out of paper')
  })

  it("Cells' Download ▸ PDF sends the same model and paper its print does", async () => {
    const ops = make('sheet', 'doc-S')
    const sheet = { sheetName: 'Sheet 1', cols: [], rows: [], cells: {}, showGridlines: true }
    bindPrintSource(ops, () => ({ app: 'cells', title: 'Budget', sheet, paper: 'a4' }))
    await ops.exportPdf!()
    expect(sheetPdf).toHaveBeenCalledWith({ title: 'Budget', sheet, paper: 'a4' })
    expect(useNoticeStore.getState().notice?.text).toBe('Saved /tmp/Budget.pdf')
  })
})
