import { test, expect, type Page } from '@playwright/test'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Verifies the NEW offline OCR fallback for scanned / image-only PDFs
// (src/main/ocr.ts + the fileText.ts "thin text layer" branch, plexi-4.0):
//
//   (a) a PDF with NO text layer (a full-page rasterised image, built with
//       @napi-rs/canvas + pdf-lib so the fixture is deterministic and has no
//       embedded text run) falls through pdf-parse's empty result into
//       ocrPdfBuffer() and window.api.files.extractText() returns the OCR'd
//       words — proving the bundled, offline (no network) tesseract.js +
//       tessdata path works end to end through the real IPC surface.
//   (b) a PDF WITH a real text layer is NOT regressed by the new branch: the
//       embedded text is well above fileText.ts's "thin" thresholds
//       (len<16 OR len/pageCount<8 — see fileText.ts's `thin` check), so by
//       construction OCR is never reached and extractText returns the
//       text-layer content untouched.
//   (d) the brain's first-time file ingest (brainIngest.ts's `walk`, which
//       only extracts a file the first time it sees it) picks up the OCR'd
//       text for a scanned PDF, proving OCR content actually reaches
//       window.api.knowledge.list() and not just extractText in isolation.
//
// Fixture generation (both PDFs) runs in the Playwright TEST process (real
// Node, not the renderer's sandboxed window context) because @napi-rs/canvas
// and pdf-lib are native/Node-only; the resulting bytes are hex-encoded and
// handed to window.api.files.ingestBuffer exactly like fileTextExtraction.spec.ts
// and brainIngest.spec.ts already do for their PDF/text fixtures.

const OCR_TOKENS = ['PLEXIIDESK', 'SCANNED', 'INVOICE', '84210']

// A full-page image PDF with no text run at all: draws known words onto a
// canvas, PNG-encodes it, and embeds that PNG as the entire content of a
// single PDF page via pdf-lib. pdf-parse's getText() on a PDF like this
// returns '' (there is no /Text operator anywhere in the content stream),
// which is exactly the "thin" condition the OCR fallback exists for.
async function scannedInvoicePdfHex(): Promise<string> {
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
  const bytes = Buffer.from(await doc.save())
  return bytes.toString('hex')
}

// A normal PDF with a real embedded text run, well past the "thin" thresholds
// (36+ chars on a single page => len/pageCount >= 8), so extractTextFromBuffer
// must return this text WITHOUT ever calling into ocr.ts.
async function textLayerPdfHex(): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 200])
  page.drawText('Cynder quarterly report alpha bravo', { x: 20, y: 120, size: 18, font })
  const bytes = Buffer.from(await doc.save())
  return bytes.toString('hex')
}

// A second, differently-worded scanned PDF (distinct tokens from
// OCR_TOKENS/scannedInvoicePdfHex) so a "does OCR still work on a SECOND call
// in the same process" test can prove real recognition happened again, not a
// cached/memoized result from the first call.
const OCR_TOKENS_2 = ['PLEXIIDESK', 'RECEIPT', 'ORDER', '99213']

async function scannedReceiptPdfHex(): Promise<string> {
  const c = createCanvas(1240, 1754)
  const x = c.getContext('2d')
  x.fillStyle = '#fff'
  x.fillRect(0, 0, 1240, 1754)
  x.fillStyle = '#111'
  x.font = '48px Helvetica'
  x.fillText('PLEXIIDESK RECEIPT', 90, 200)
  x.font = '36px Helvetica'
  x.fillText('Order number 99213', 90, 300)

  const doc = await PDFDocument.create()
  const img = await doc.embedPng(c.toBuffer('image/png'))
  const page = doc.addPage([img.width, img.height])
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height })
  const bytes = Buffer.from(await doc.save())
  return bytes.toString('hex')
}

async function extractTextFor(window: Page, id: string): Promise<string | null> {
  return window.evaluate(async (fileId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.files.extractText(fileId)
  }, id)
}

async function ingestHex(
  window: Page,
  hex: string,
  originalName: string,
  mimeType: string
): Promise<{ id: string; originalName: string }> {
  return window.evaluate(
    async ({ hex, originalName, mimeType }: { hex: string; originalName: string; mimeType: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const bytes = new Uint8Array(hex.length / 2)
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      const file = await api.files.ingestBuffer({
        buffer: bytes.buffer,
        originalName,
        mimeType
      })
      return { id: file.id, originalName: file.originalName }
    },
    { hex, originalName, mimeType }
  )
}

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── (a) scanned / image-only PDF → OCR fallback fires ───────────────────────

test('(a) extractText OCRs a scanned/image-only PDF with no text layer', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const hex = await scannedInvoicePdfHex()
  const file = await ingestHex(window, hex, 'scanned-invoice.pdf', 'application/pdf')

  const text = await window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.files.extractText(id)
  }, file.id)

  expect(text, 'OCR must have returned some text, not null/empty').toBeTruthy()
  const hits = OCR_TOKENS.filter((t) => (text ?? '').includes(t))
  expect(
    hits.length,
    `expected at least 3 of [${OCR_TOKENS.join(', ')}] in OCR output, got: ${JSON.stringify(text)}`
  ).toBeGreaterThanOrEqual(3)
})

// ── (b) text-layer PDF is not regressed by the new OCR branch ───────────────

test('(b) extractText still returns the real text layer for a normal (non-scanned) PDF', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const hex = await textLayerPdfHex()
  const file = await ingestHex(window, hex, 'quarterly-report.pdf', 'application/pdf')

  const text = await window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.files.extractText(id)
  }, file.id)

  expect(text).toContain('Cynder quarterly report alpha bravo')
})

// ── (d) the brain's first-time file ingest picks up OCR'd content ───────────

test('(d) brain.ingestWorkspace() indexes the OCR text of a scanned PDF (first-time file ingest)', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const hex = await scannedInvoicePdfHex()
  const file = await ingestHex(window, hex, 'brain-scanned-invoice.pdf', 'application/pdf')

  // First-time ingest of this exact file id in a fresh session — brainIngest.ts's
  // `walk()` only extracts a file the first time hasKnowledgeSource('file', id)
  // is false, so this is not hitting the "already indexed, skip" short-circuit.
  const stats = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.brain.ingestWorkspace()
  })
  expect(stats.files, 'ingestWorkspace must have seen the new file').toBeGreaterThanOrEqual(1)

  const entries = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })

  const entry = entries.find((e) => OCR_TOKENS.some((t) => e.body.includes(t)))
  expect(
    entry,
    `expected a knowledge entry whose body contains an OCR token; bodies were: ${JSON.stringify(
      entries.map((e) => ({ title: e.title, body: e.body.slice(0, 80) }))
    )}`
  ).toBeTruthy()
  expect(entry!.title).toBe('brain-scanned-invoice.pdf')

  const hits = OCR_TOKENS.filter((t) => entry!.body.includes(t))
  expect(hits.length, `expected at least 3 OCR tokens in the brain entry body: ${entry!.body}`).toBeGreaterThanOrEqual(
    3
  )
})

// ── (e) regression lock: a SECOND scanned PDF also OCRs in the same session ─
//
// The bug this guards against: ocr.ts used to leave globalThis.pdfjsWorker
// deleted (or in some other broken state) after the first OCR call, so only
// the FIRST scanned PDF in a process would ever OCR correctly. This proves
// the delete/try/finally-restore in ocrPdfBuffer() makes OCR repeatable —
// a second, differently-worded scanned PDF recognized correctly right after
// the first one, in the same Electron process / same OCR worker.

test('(e) a second scanned PDF also OCRs correctly in the same session (repeat OCR call)', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const hex1 = await scannedInvoicePdfHex()
  const file1 = await ingestHex(window, hex1, 'scanned-invoice-repeat-1.pdf', 'application/pdf')
  const text1 = await extractTextFor(window, file1.id)
  const hits1 = OCR_TOKENS.filter((t) => (text1 ?? '').includes(t))
  expect(
    hits1.length,
    `first OCR call in the session: expected >=3 of [${OCR_TOKENS.join(', ')}], got: ${JSON.stringify(text1)}`
  ).toBeGreaterThanOrEqual(3)

  const hex2 = await scannedReceiptPdfHex()
  const file2 = await ingestHex(window, hex2, 'scanned-receipt-repeat-2.pdf', 'application/pdf')
  const text2 = await extractTextFor(window, file2.id)
  const hits2 = OCR_TOKENS_2.filter((t) => (text2 ?? '').includes(t))
  expect(
    hits2.length,
    `second OCR call in the same session must ALSO recognize its own (different) tokens ` +
      `[${OCR_TOKENS_2.join(', ')}], got: ${JSON.stringify(text2)}`
  ).toBeGreaterThanOrEqual(3)
})

// ── (f) regression lock: a text-layer PDF read AFTER an OCR call still ─────
//     returns its text-layer content (reverse-poison guard)
//
// The bug this guards against: ocrPdfBuffer() deletes globalThis.pdfjsWorker
// so pdf-to-png-converter's pdfjs 6.x can initialise its own handler, then
// restores whatever was there before in a `finally`. If that restore were
// missing, wrong, or restored the WRONG value, a later pdf-parse (pdfjs 5.x)
// call in the same process would throw the same "API version does not match
// Worker version" error, just in the opposite direction. This proves a normal
// text-layer PDF read right after an OCR call still comes back via pdf-parse
// untouched, in the same Electron process / same globalThis.

test('(f) a text-layer PDF read AFTER an OCR call still returns its text-layer content (reverse-poison guard)', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // OCR first — this is what deletes-and-restores globalThis.pdfjsWorker.
  const ocrHex = await scannedInvoicePdfHex()
  const ocrFile = await ingestHex(window, ocrHex, 'scanned-invoice-before-textlayer.pdf', 'application/pdf')
  const ocrText = await extractTextFor(window, ocrFile.id)
  const ocrHits = OCR_TOKENS.filter((t) => (ocrText ?? '').includes(t))
  expect(
    ocrHits.length,
    `setup OCR call must itself succeed before the reverse-poison check is meaningful: ${JSON.stringify(ocrText)}`
  ).toBeGreaterThanOrEqual(3)

  // Now a plain text-layer PDF, read in the SAME session right after OCR ran.
  const textHex = await textLayerPdfHex()
  const textFile = await ingestHex(window, textHex, 'quarterly-report-after-ocr.pdf', 'application/pdf')
  const text = await extractTextFor(window, textFile.id)
  expect(text).toContain('Cynder quarterly report alpha bravo')
})
