// @vitest-environment node
// Print… prints the render each app's Download ▸ PDF already makes.
//
// For every printable app this drives BOTH real paths through a recording
// BrowserWindow: the PDF export (save dialog → offscreen window → printToPDF)
// and Print… (printDocument → hidden window → print). The two must load the
// identical HTML and use identical printToPDF options, which is what makes the
// paper's page count and page size the PDF's (tests/e2e/printDocument.spec.ts
// then checks real PDFs). It also pins how a render's page becomes print()
// options, and that the system dialog is shown, never silent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface Loaded {
  html: string
  size: { width?: number; height?: number }
  pdf: unknown[]
  print: unknown[]
  offscreen: boolean
}
const windows: Loaded[] = []
/** What the fake system dialog reports for the next print(). */
const dialogOutcome: { ok: boolean; reason: string } = { ok: true, reason: '' }

vi.mock('electron', () => {
  class FakeWindow {
    rec: Loaded
    webContents: Record<string, unknown>
    constructor(opts: { width?: number; height?: number; webPreferences?: { offscreen?: boolean } }) {
      this.rec = { html: '', size: { width: opts.width, height: opts.height }, pdf: [], print: [], offscreen: !!opts.webPreferences?.offscreen }
      windows.push(this.rec)
      const rec = this.rec
      this.webContents = {
        printToPDF: async (o: unknown) => {
          rec.pdf.push(o)
          return Buffer.from('%PDF-fake')
        },
        print: (o: unknown, cb: (ok: boolean, reason: string) => void) => {
          rec.print.push(o)
          cb(dialogOutcome.ok, dialogOutcome.reason)
        },
        executeJavaScript: async () => true,
        capturePage: async () => ({ getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.from(''), toJPEG: () => Buffer.from(''), resize: () => null })
      }
    }
    async loadURL(url: string): Promise<void> {
      this.rec.html = decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, ''))
    }
    destroy(): void {}
    static getFocusedWindow(): null {
      return null
    }
    static getAllWindows(): unknown[] {
      return [{}]
    }
  }
  return {
    BrowserWindow: FakeWindow,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/out.pdf' }), showOpenDialog: async () => ({ canceled: true }) },
    app: { getAppPath: () => '/nonexistent', getPath: () => '/tmp', isPackaged: false }
  }
})
vi.mock('fs/promises', async (orig) => ({ ...(await orig<typeof import('fs/promises')>()), writeFile: async () => undefined }))

import { exportPdf, writePrintRender } from '../../src/main/officeDocx'
import { exportSlides } from '../../src/main/slidesIo'
import { exportDesign } from '../../src/main/designExport'
import { exportMap } from '../../src/main/mapExport'
import { exportSheetPdf, printDocument } from '../../src/main/printDocument'
import { printOptionsFor, sheetPrintRender } from '../../src/main/printRender'
import type { PrintRequest } from '../../src/shared/printJob'
import type { SheetPrintModel } from '../../src/shared/sheetPrint'
import type { DesignBody } from '../../src/shared/design'
import type { MapBody, SlidesBody } from '../../src/shared/types'

const PAGE = { size: 'a4' as const, orientation: 'landscape' as const, margin: { top: 1, right: 0.75, bottom: 1, left: 0.75 } }
const SLIDES = { slides: [{ id: 's1', elements: [] }, { id: 's2', elements: [] }] } as unknown as SlidesBody
const DESIGN = { width: 600, height: 400, background: '#ffffff', elements: [] } as unknown as DesignBody
const MAP = { nodes: [{ id: 'n1', label: 'Start', x: 0, y: 0, w: 120, h: 60, shape: 'rect' }], edges: [] } as unknown as MapBody
const SHEET: SheetPrintModel = {
  sheetName: 'Sheet 1',
  cols: [{ c: 0, w: 64 }, { c: 1, w: 64 }],
  rows: [{ r: 0, h: 20 }],
  cells: { '0,0': { text: 'Hello' }, '0,1': { text: '42', align: 'right' } },
  showGridlines: true
}

/** Run the PDF export, then Print…, and return the window each loaded. */
async function bothPaths(exportFn: () => Promise<unknown>, req: PrintRequest): Promise<{ exported: Loaded; printed: Loaded }> {
  windows.length = 0
  await exportFn()
  const exported = windows.find((w) => w.pdf.length)!
  windows.length = 0
  const res = await printDocument(req)
  expect(res).toEqual({ ok: true })
  const printed = windows.find((w) => w.print.length || w.pdf.length)!
  return { exported, printed }
}

describe('Print… uses each app’s own PDF render', () => {
  beforeEach(() => {
    delete process.env.PLEXI_PRINT_CAPTURE
  })

  const cases: Array<[string, () => Promise<unknown>, PrintRequest]> = [
    ['Write', () => exportPdf({ html: '<h1>Report</h1><p>Body</p>', title: 'Report', page: PAGE }), { app: 'write', title: 'Report', html: '<h1>Report</h1><p>Body</p>', page: PAGE }],
    ['Deck', () => exportSlides({ body: SLIDES, title: 'Deck', format: 'pdf' }), { app: 'deck', title: 'Deck', body: SLIDES }],
    ['Design', () => exportDesign({ design: DESIGN, title: 'Flyer', format: 'pdf' }), { app: 'design', title: 'Flyer', design: DESIGN }],
    ['Diagrams', () => exportMap({ map: MAP, title: 'Flow', format: 'pdf' }), { app: 'diagram', title: 'Flow', map: MAP }],
    ['Cells', () => exportSheetPdf({ title: 'Budget', sheet: SHEET, paper: 'a4' }), { app: 'cells', title: 'Budget', sheet: SHEET, paper: 'a4' }]
  ]

  for (const [name, exportFn, req] of cases) {
    it(`${name}: Print… loads the PDF export's HTML at its size`, async () => {
      const { exported, printed } = await bothPaths(exportFn, req)
      expect(exported.html.length).toBeGreaterThan(50)
      expect(printed.html).toBe(exported.html)
      expect(printed.size).toEqual(exported.size)
    })

    it(`${name}: Print… sends the dialog the PDF's page, and shows the dialog`, async () => {
      const { exported, printed } = await bothPaths(exportFn, req)
      expect(printed.print).toHaveLength(1)
      const opts = printed.print[0] as Record<string, unknown>
      expect(opts.silent).toBe(false)
      const pdf = exported.pdf[0] as Record<string, unknown>
      expect(opts.landscape).toBe(!!pdf.landscape)
      if (typeof pdf.pageSize === 'string') expect(opts.pageSize).toBe(pdf.pageSize)
      // Print… prints from a real (hidden) window, not an offscreen one.
      expect(printed.offscreen).toBe(false)
    })

    it(`${name}: under the e2e seam the job is recorded from the same printToPDF, and no dialog opens`, async () => {
      process.env.PLEXI_PRINT_CAPTURE = '1'
      const g = globalThis as { __plexiiPrintJobs?: unknown[] }
      g.__plexiiPrintJobs = []
      const { exported, printed } = await bothPaths(exportFn, req)
      expect(printed.print).toHaveLength(0)
      expect(printed.pdf).toEqual(exported.pdf)
      expect(g.__plexiiPrintJobs).toHaveLength(1)
      expect(g.__plexiiPrintJobs![0]).toMatchObject({ app: req.app, title: req.title })
    })
  }
})

describe('printOptionsFor: the PDF page as the print dialog takes it', () => {
  beforeEach(() => {
    delete process.env.PLEXI_PRINT_CAPTURE
  })
  afterEach(() => vi.restoreAllMocks())

  it("Write: the named size, the orientation, and its own @page margins ('default')", () => {
    const r = writePrintRender({ html: '<p>x</p>', page: PAGE })
    expect(r.html).toContain('@page { size: A4 landscape; margin: 1in 0.75in 1in 0.75in; }')
    expect(printOptionsFor(r)).toEqual({ silent: false, printBackground: true, landscape: true, pageSize: 'A4', margins: { marginType: 'default' } })
  })

  it("Cells: A4 or Letter, full-bleed page ('none'): the margins are inside the page box", () => {
    expect(printOptionsFor(sheetPrintRender(SHEET, 'a4'))).toMatchObject({ pageSize: 'A4', margins: { marginType: 'none' } })
    expect(printOptionsFor(sheetPrintRender(SHEET, 'letter'))).toMatchObject({ pageSize: 'Letter', margins: { marginType: 'none' } })
  })

  it('a custom-sized page (Deck) leaves the size to its CSS @page and has no margins', async () => {
    windows.length = 0
    await printDocument({ app: 'deck', title: 'Deck', body: SLIDES })
    const html = windows[0].html
    expect(html).toMatch(/@page \{ size: \d+px \d+px; margin: 0; \}/)
    const opts = windows[0].print[0] as Record<string, unknown>
    expect(opts.pageSize).toBeUndefined()
    expect(opts.margins).toEqual({ marginType: 'none' })
  })

  it('Design and Diagrams carry their page size as CSS too, for the print dialog', async () => {
    windows.length = 0
    await printDocument({ app: 'design', title: 'Flyer', design: DESIGN })
    expect(windows[0].html).toContain('@page{size:600px 400px;margin:0}')
    windows.length = 0
    await printDocument({ app: 'diagram', title: 'Flow', map: MAP })
    expect(windows[0].html).toMatch(/@page\{size:\d+px \d+px;margin:0\}/)
  })

  it('refuses a malformed request without opening a window', async () => {
    windows.length = 0
    expect(await printDocument({ app: 'nope' } as never)).toEqual({ ok: false, error: 'Nothing to print.' })
    expect(windows).toHaveLength(0)
  })

  it('a dismissed dialog is a cancel, not an error; a refused job is an error that names the reason', async () => {
    Object.assign(dialogOutcome, { ok: false, reason: 'Print job canceled' })
    expect(await printDocument({ app: 'write', title: 'R', html: '<p>x</p>' })).toEqual({ ok: false, cancelled: true })
    Object.assign(dialogOutcome, { ok: false, reason: 'Printer out of paper' })
    expect(await printDocument({ app: 'write', title: 'R', html: '<p>x</p>' })).toEqual({ ok: false, error: 'Could not print: Printer out of paper' })
    Object.assign(dialogOutcome, { ok: true, reason: '' })
  })
})
