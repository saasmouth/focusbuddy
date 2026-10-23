import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, chooseCloudAiSource } from './_helpers'
import { readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Print… for the five document office apps (4.3.41).
//
// Driven through the test seam (PLEXI_PRINT_CAPTURE=1, NODE_ENV=test): main
// records each print job (the options print() would get, and the PDF of the very
// window it would print) instead of opening the OS dialog. No real dialog is
// ever shown, let alone confirmed. Print… is run by ops.print() through
// window.__fbPrint, the call the File menu row makes once the registries add it.
//
// The real-check: Write's page breaks land where Download ▸ PDF puts them. The
// exported PDF and the print job's PDF must have the same pages, page size and
// text on every page.

let launched: LaunchedApp | null = null
const written: string[] = []
test.afterEach(async () => {
  for (const p of written) if (existsSync(p)) rmSync(p)
  written.length = 0
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Job {
  app: string
  title: string
  options: Record<string, unknown>
  pdfBase64: string
}

async function pdfPages(buf: Buffer): Promise<Array<{ w: number; h: number; text: string }>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise
  const out: Array<{ w: number; h: number; text: string }> = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim()
    out.push({ w: Math.round(vp.width), h: Math.round(vp.height), text })
  }
  return out
}

async function jobs(app: ElectronApplication): Promise<Job[]> {
  return app.evaluate(() => ((globalThis as { __plexiiPrintJobs?: unknown[] }).__plexiiPrintJobs ?? []) as never)
}

/** Store a document, open it, and wait for its editor to bind its print source. */
async function openForPrint(window: Page, docType: string, title: string, body: unknown): Promise<string> {
  const id = await window.evaluate(
    async ({ d, t, b }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const doc = await api.documents.create({ docType: d, title: t, body: b } as never)
      ;(window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }).__fbView?.getState().goDocument(doc.id)
      return doc.id
    },
    { d: docType, t: title, b: body }
  )
  await expect
    .poll(
      () =>
        window.evaluate((docId) => {
          const p = (window as unknown as { __fbPrint?: { bound: () => Array<{ id: string; canPrint: boolean }> } }).__fbPrint
          return p?.bound().some((b) => b.id === docId && b.canPrint) ?? false
        }, id),
      { timeout: 15_000 }
    )
    .toBe(true)
  return id
}

async function printNow(window: Page, id: string): Promise<boolean> {
  return window.evaluate((docId) => (window as unknown as { __fbPrint: { print: (id: string) => Promise<boolean> } }).__fbPrint.print(docId), id)
}

async function stubSave(app: ElectronApplication, name: string): Promise<string> {
  const path = join(tmpdir(), `plexii-print-${process.pid}-${name}.pdf`)
  written.push(path)
  await app.evaluate(async ({ dialog }, filePath) => {
    // @ts-expect-error test override: the save dialog answers with this path
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, path)
  return path
}

// 120 numbered paragraphs: several A4 pages of Write text.
const PARAS = Array.from({ length: 120 }, (_, i) => ({
  type: 'paragraph',
  content: [{ type: 'text', text: `Paragraph ${i + 1}. The quarterly close checks every reconciliation against its source before the books are locked.` }]
}))
const WRITE_BODY = {
  doc: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Close checklist' }] }, ...PARAS] },
  headingStyles: {},
  page: { size: 'a4', orientation: 'portrait', margin: { top: 1, right: 1, bottom: 1, left: 1 } }
}

test.describe('Print…', () => {
  test.beforeEach(async () => {
    launched = await launchApp({ env: { PLEXI_PRINT_CAPTURE: '1' } })
    await waitForReady(launched.window)
    await chooseCloudAiSource(launched.window)
  })

  test('PRT-1 Write: the print job is the PDF export, page for page, and the dialog is not silent', async () => {
    const { window, app } = launched!
    const id = await openForPrint(window, 'doc', 'Close checklist', WRITE_BODY)
    expect(await printNow(window, id)).toBe(true)
    const [job] = await jobs(app)
    expect(job).toMatchObject({ app: 'write', title: 'Close checklist' })
    expect(job.options).toMatchObject({ silent: false, pageSize: 'A4', landscape: false, margins: { marginType: 'default' } })

    // Download ▸ PDF of the same document, as the File menu runs it.
    const path = await stubSave(app, 'write')
    const res = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ed = (window as unknown as { __docEditor: { getHTML: () => string } }).__docEditor
      return api.office.exportPdf({ html: ed.getHTML(), title: 'Close checklist', page: { size: 'a4', orientation: 'portrait', margin: { top: 1, right: 1, bottom: 1, left: 1 } } })
    })
    expect(res.ok).toBe(true)
    const exported = await pdfPages(readFileSync(path))
    const printed = await pdfPages(Buffer.from(job.pdfBase64, 'base64'))
    expect(exported.length).toBeGreaterThanOrEqual(3)
    expect(printed.length).toBe(exported.length)
    for (let i = 0; i < exported.length; i++) {
      expect(printed[i].w, `page ${i + 1} width`).toBe(exported[i].w)
      expect(printed[i].h, `page ${i + 1} height`).toBe(exported[i].h)
      // The same text on the same page: every break falls in the same place.
      expect(printed[i].text, `page ${i + 1} text`).toBe(exported[i].text)
    }
    // A4 is 595.3 × 841.9 pt (Chromium writes it as 596 × 843 after its own rounding).
    expect(Math.abs(exported[0].w - 595.3)).toBeLessThan(1.5)
    expect(Math.abs(exported[0].h - 841.9)).toBeLessThan(1.5)
  })

  test('PRT-2 Cells: a used range two pages wide prints two pages across, and Download ▸ PDF is the same render', async () => {
    const { window, app } = launched!
    const cols = Array.from({ length: 16 }, (_, c) => String.fromCharCode(65 + c))
    const rows = [cols.map((c) => `${c}1`), cols.map((c, i) => String(i * 10))]
    const id = await openForPrint(window, 'sheet', 'Wide budget', { version: 2, sheets: [{ id: 's1', name: 'Budget', columns: cols, rows }], activeSheet: 0 })
    expect(await printNow(window, id)).toBe(true)
    const [job] = await jobs(app)
    expect(job.options).toMatchObject({ silent: false, pageSize: 'A4', margins: { marginType: 'none' } })
    const printed = await pdfPages(Buffer.from(job.pdfBase64, 'base64'))
    expect(printed.length).toBe(2)
    // Columns A–J on page 1, K–P on page 2.
    expect(printed[0].text).toContain('A1')
    expect(printed[0].text).toContain('J1')
    expect(printed[0].text).not.toContain('K1')
    expect(printed[1].text).toContain('K1')
    expect(printed[1].text).toContain('P1')

    // Download ▸ PDF through ops.exportPdf, the call Cells' menu row makes:
    // the same render, so the same pages with the same cells on them.
    const path = await stubSave(app, 'cells')
    const ran = await window.evaluate(
      (docId) => (window as unknown as { __fbPrint: { exportPdf: (id: string) => Promise<boolean> } }).__fbPrint.exportPdf(docId),
      id
    )
    expect(ran).toBe(true)
    await expect.poll(() => existsSync(path), { timeout: 10_000 }).toBe(true)
    const exported = await pdfPages(readFileSync(path))
    expect(exported.map((p) => p.text)).toEqual(printed.map((p) => p.text))
    expect(exported.map((p) => [p.w, p.h])).toEqual(printed.map((p) => [p.w, p.h]))
  })

  for (const [name, docType, body, pages] of [
    ['PRT-3 Deck: one slide per page', 'slides', { slides: [{ id: 'a', elements: [] }, { id: 'b', elements: [] }, { id: 'c', elements: [] }] }, 3],
    ['PRT-4 Design: the design at its own size', 'design', { schemaVersion: 1, width: 800, height: 600, background: { type: 'solid', color: '#ffffff' }, elements: [] }, 1],
    // One page for a one-page diagram: the PDF export ran onto a blank second
    // page before 4.3.41 (an inline svg's baseline gap); print now matches 1.
    ['PRT-5 Diagrams: the page fitted to the paper', 'map', { nodes: [{ id: 'n1', label: 'Start', x: 0, y: 0, w: 140, h: 60, shape: 'rect' }], edges: [] }, 1]
  ] as const) {
    test(name as string, async () => {
      const { window, app } = launched!
      const id = await openForPrint(window, docType, String(name), body)
      expect(await printNow(window, id)).toBe(true)
      const [job] = await jobs(app)
      expect(job.options.silent).toBe(false)
      expect(job.options.margins).toEqual({ marginType: 'none' })
      // A custom-sized page takes its size from the render's CSS @page.
      expect(job.options.pageSize).toBeUndefined()
      const printed = await pdfPages(Buffer.from(job.pdfBase64, 'base64'))
      expect(printed.length).toBe(pages)
    })
  }
})
