// OCR must keep working after Files has read a PDF's text.
//
// pdf-parse (Files' text extraction) and pdf-to-png-converter (OCR's page
// rasteriser, and Draw's PDF renderer) each bring their own @napi-rs/canvas,
// and pdf.js installs the first one's Path2D/DOMMatrix/ImageData as globals for
// the life of the process. Files runs pdf-parse on every PDF before OCR is
// considered, so pdf-parse always won. A scan made only of a picture still
// rasterised (no paths), but a scanned page with ANY vector mark on it -- a
// frame, a redaction bar, a signature line, which scanners and PDF tools add
// all the time -- failed with "Value is none of these types `String`, `Path`"
// inside OCR, which fileText.ts honestly swallows: the scan's words never
// reached search, the brain or the assistant. Before the fix this spec failed
// on the OCR tokens; through pdfCanvasGlobals.ts it passes.

import { test, expect } from '@playwright/test'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const OCR_TOKENS = ['PLEXIIDESK', 'SCANNED', 'INVOICE', '84210']

/** A PDF with a real text layer, well past fileText's "thin" thresholds. */
async function textLayerPdf(): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([400, 200]).drawText('Cynder quarterly report alpha bravo', { x: 20, y: 120, size: 18, font })
  return Buffer.from(await doc.save()).toString('hex')
}

/**
 * A scanned invoice: the words exist only as pixels of a page-sized picture,
 * with a vector frame round the page and a vector redaction bar below the
 * words, as a scanner's or PDF editor's output has. pdf-parse finds no text,
 * so Files falls back to OCR, and pdf.js draws the frame and bar with Path2D.
 */
async function scannedInvoiceWithMarksPdf(): Promise<string> {
  const c = createCanvas(1240, 1754)
  const x = c.getContext('2d')
  x.fillStyle = '#fff'
  x.fillRect(0, 0, 1240, 1754)
  x.fillStyle = '#111'
  x.font = '48px Helvetica'
  x.fillText('PLEXIIDESK SCANNED INVOICE', 90, 200)
  x.font = '36px Helvetica'
  x.fillText('Reference number 84210', 90, 300)

  const doc = await PDFDocument.create()
  const img = await doc.embedPng(c.toBuffer('image/png'))
  const page = doc.addPage([img.width, img.height])
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height })
  page.drawRectangle({ x: 20, y: 20, width: img.width - 40, height: img.height - 40, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 4 })
  page.drawRectangle({ x: 90, y: img.height - 520, width: 600, height: 60, color: rgb(0, 0, 0) })
  return Buffer.from(await doc.save()).toString('hex')
}

test('OCR reads a scanned PDF after Files has extracted a PDF’s text', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const r = await window.evaluate(
    async ({ textHex, scanHex }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const bytes = (hex: string): ArrayBuffer => {
        const b = new Uint8Array(hex.length / 2)
        for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        return b.buffer
      }
      // Files reads a normal PDF's text first (pdf-parse), as the brain and search do.
      const report = await api.files.ingestBuffer({ buffer: bytes(textHex), originalName: 'report.pdf', mimeType: 'application/pdf', parentId: null })
      const reportText = await api.files.extractText(report.id)
      // Then a scan: pdf-parse finds nothing, so this one is OCR'd.
      const scan = await api.files.ingestBuffer({ buffer: bytes(scanHex), originalName: 'scanned-invoice.pdf', mimeType: 'application/pdf', parentId: null })
      const scanText = await api.files.extractText(scan.id)
      // And the text reader still works after OCR's render.
      const reportAgain = await api.files.extractText(report.id)
      return { reportText, scanText, reportAgain }
    },
    { textHex: await textLayerPdf(), scanHex: await scannedInvoiceWithMarksPdf() }
  )
  expect(r.reportText).toContain('Cynder quarterly report alpha bravo')
  const hits = OCR_TOKENS.filter((t) => (r.scanText ?? '').includes(t))
  expect(hits.length, `expected at least 3 of [${OCR_TOKENS.join(', ')}] in the OCR text, got: ${JSON.stringify(r.scanText)}`).toBeGreaterThanOrEqual(3)
  expect(r.reportAgain).toContain('Cynder quarterly report alpha bravo')
})
