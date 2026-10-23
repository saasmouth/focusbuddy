import { app } from 'electron'
import { join } from 'path'
import { withPdfRenderer } from './pdfCanvasGlobals'

// Offline OCR for scanned / image-only PDFs (the ones with no embedded text
// layer, where pdf-parse comes back empty). Pages are rasterised to PNG with
// pdf-to-png-converter (pdfjs + @napi-rs/canvas) and read with tesseract.js.
// Everything runs on-device: the English training data is bundled under
// resources/tessdata and read from disk, so no network call and nothing leaves
// the machine. Honest by construction — if OCR finds nothing (blank scan, or a
// hand-written page tesseract can't read), it returns an empty string and the
// caller keeps whatever real text it already had, never a fabricated summary.
//
// Heavy: rasterising + recognising a page is on the order of a second, so the
// page count is capped and this is only reached when a PDF's text layer is thin.

const MAX_OCR_PAGES = 12
const OCR_VIEWPORT_SCALE = 2.0 // ~150-200 DPI equivalent, enough for printed scans
const OCR_MAX_CHARS = 12000
const WORKER_IDLE_MS = 60_000

// Minimal structural types so we don't have to import tesseract.js's
// export-assignment namespace just for a type.
interface OcrWorker {
  recognize: (image: Buffer) => Promise<{ data: { text: string } }>
  terminate: () => Promise<unknown>
}

let workerPromise: Promise<OcrWorker> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

// Where the bundled eng.traineddata.gz lives: packaged it's copied into the
// app's Resources via electron-builder extraResources; in dev it sits in the
// repo under resources/tessdata.
function tessdataDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tessdata')
    : join(app.getAppPath(), 'resources', 'tessdata')
}

async function getWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    const mod = (await import('tesseract.js')) as unknown as {
      createWorker?: (...a: unknown[]) => Promise<OcrWorker>
      default?: { createWorker: (...a: unknown[]) => Promise<OcrWorker> }
    }
    const createWorker = mod.createWorker ?? mod.default?.createWorker
    if (!createWorker) throw new Error('tesseract.js createWorker unavailable')
    // langs 'eng', oem 1 (LSTM only). langPath points at the bundled data;
    // cacheMethod 'none' reads it straight from there each session with no
    // writes and no CDN fallback. corePath/workerPath resolve from the (unpacked)
    // node_modules by tesseract.js's Node defaults.
    workerPromise = createWorker('eng', 1, {
      langPath: tessdataDir(),
      cacheMethod: 'none',
      gzip: true,
      logger: () => {},
      errorHandler: () => {}
    })
  }
  return workerPromise
}

function bumpIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void terminateOcrWorker()
  }, WORKER_IDLE_MS)
  // Don't let an idle OCR worker keep the process alive on quit.
  idleTimer.unref?.()
}

// Tear the shared worker down (idle timeout, or on demand). Safe to call twice.
export async function terminateOcrWorker(): Promise<void> {
  const p = workerPromise
  workerPromise = null
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (p) {
    try {
      const w = await p
      await w.terminate()
    } catch {
      // already gone
    }
  }
}

// Render a PDF's first pages to PNG and OCR them. Returns the concatenated text
// (possibly empty). Never throws for a readable-but-empty scan; genuine failures
// (corrupt PDF, missing training data) propagate so the caller can fall back.
export async function ocrPdfBuffer(buf: Uint8Array, maxPages = MAX_OCR_PAGES): Promise<string> {
  // Rasterising goes through withPdfRenderer: fileText.ts has just run
  // pdf-parse on this very PDF, which bundles a different pdf.js and a
  // different @napi-rs/canvas build that share pdf.js's globals (Path2D,
  // DOMMatrix, ImageData, pdfjsWorker). Without the renderer's own globals in
  // place, a page with any vector mark on it (a frame, a redaction box, a
  // signature stroke) failed to render and the scan OCR'd to nothing. Only the
  // rasterising holds the window; recognition below runs outside it.
  const pages = await withPdfRenderer((pdfToPng) =>
    pdfToPng(new Uint8Array(buf), {
      viewportScale: OCR_VIEWPORT_SCALE,
      pagesToProcess: Array.from({ length: maxPages }, (_, i) => i + 1),
      returnPageContent: true,
      verbosityLevel: 0
    })
  )

  const worker = await getWorker()
  const parts: string[] = []
  try {
    for (const p of pages) {
      if (!p.content) continue
      const { data } = await worker.recognize(p.content)
      const t = (data.text || '').trim()
      if (t) parts.push(t)
      if (parts.join('\n').length > OCR_MAX_CHARS) break
    }
  } finally {
    bumpIdle()
  }
  return parts.join('\n\n').trim().slice(0, OCR_MAX_CHARS)
}
