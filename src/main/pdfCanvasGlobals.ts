// The one door to pdf.js on Node. Every PDF render in the main process goes
// through here, and so does pdf-parse's text extraction, because the two
// libraries share process-wide globals that neither of them owns.
//
// The clash. pdf-parse (Files' text extraction, fileText.ts) and
// pdf-to-png-converter (Draw's PDF page renderer, drawImport.ts, and OCR,
// ocr.ts) each bundle their own pdf.js AND their own @napi-rs/canvas build
// (pdf-parse 0.1.x, pdf-to-png-converter 1.x). pdf.js on Node installs its
// canvas's Path2D, DOMMatrix and ImageData as globals only when they are
// missing, so whichever library loads first owns them for the life of the
// process. Files extracts the text of every PDF it is given, so once that had
// run, every later render drew 1.x paths with the 0.1.x Path2D and failed with
// "Value is none of these types `String`, `Path`": a placed or dropped PDF
// became nothing, and a scanned PDF with any vector mark on it (a frame, a
// redaction box, a signature stroke) OCR'd to nothing.
//
// The two pdf.js versions also share globalThis.pdfjsWorker, where each one
// looks for its in-process worker handler; pdf-parse's 5.x handler in place
// makes pdf-to-png-converter's 6.x getDocument() throw a version mismatch.
//
// What this module does:
//   - withPdfCanvasGlobals(fn) runs fn with the RENDERER's globals: the
//     pdf-to-png-converter build's Path2D, DOMMatrix and ImageData installed,
//     and pdfjsWorker cleared so 6.x uses its own handler. Everything is put
//     back as it was when the last overlapping render finishes.
//   - withPdfTextLayer(fn) runs pdf-parse's text extraction with the globals
//     as pdf-parse left them, never inside a render's window.
//   - withPdfRenderer(fn) is withPdfCanvasGlobals plus the converter itself,
//     handed to fn inside the window, so a caller cannot reach the renderer
//     without the globals in place.
//
// Concurrency. Calls of the SAME kind share the window (reference-counted):
// two renders want identical globals, so letting them overlap is safe, and it
// means a render nested inside a render cannot deadlock. Calls of the OTHER
// kind wait until the window closes, so an overlapping render can never
// restore globals out from under another, and a text extraction never runs
// with the renderer's worker handler installed. Waiters of one kind are
// released together, in arrival order of their kind.
//
// tests/unit/pdfCanvasGlobalsGuard.test.ts fails if any other module imports
// pdf.js, @napi-rs/canvas or either wrapper library without coming through
// here.

import { createRequire } from 'node:module'
import { join } from 'node:path'

/** The globals pdf.js on Node takes from its canvas build. */
export const PDF_CANVAS_GLOBALS = ['Path2D', 'DOMMatrix', 'ImageData'] as const

export type PdfToPngPage = { content?: Buffer; width: number; height: number; pageNumber: number }
export type PdfToPng = (data: Uint8Array, opts: Record<string, unknown>) => Promise<PdfToPngPage[]>

type WindowKind = 'render' | 'text'

/** Resolve a package from this module, in the bundled main process and under vitest alike. */
function requireHere(): NodeRequire {
  return createRequire(typeof __filename === 'string' ? __filename : join(process.cwd(), 'index.js'))
}

/**
 * The @napi-rs/canvas build pdf-to-png-converter renders with: resolved from
 * the converter's own location, so it is the copy nested under it, not the
 * top-level one pdf-parse gets. Null when it cannot be loaded; the render then
 * runs with whatever globals exist and reports its own error honestly.
 */
export function rendererCanvasBuild(): Record<string, unknown> | null {
  try {
    const converterEntry = requireHere().resolve('pdf-to-png-converter')
    return createRequire(converterEntry)('@napi-rs/canvas') as Record<string, unknown>
  } catch {
    return null
  }
}

// ── The window ───────────────────────────────────────────────────────────────

let openKind: WindowKind | null = null
let openCount = 0
let restore: (() => void) | null = null
let waiting: Array<{ kind: WindowKind; go: () => void }> = []

/** Install the renderer's globals; returns how to put back exactly what was there. */
function installRendererGlobals(): () => void {
  const g = globalThis as Record<string, unknown>
  const hadWorker = Object.prototype.hasOwnProperty.call(g, 'pdfjsWorker')
  const prevWorker = g.pdfjsWorker
  delete g.pdfjsWorker
  const canvas = rendererCanvasBuild()
  const saved = PDF_CANVAS_GLOBALS.map((k) => [k, Object.prototype.hasOwnProperty.call(g, k), g[k]] as const)
  if (canvas) for (const k of PDF_CANVAS_GLOBALS) if (canvas[k]) g[k] = canvas[k]
  return () => {
    if (hadWorker) g.pdfjsWorker = prevWorker
    else delete g.pdfjsWorker
    for (const [k, had, v] of saved) {
      if (had) g[k] = v
      else delete g[k]
    }
  }
}

function open(kind: WindowKind, count: number): void {
  openKind = kind
  openCount = count
  restore = kind === 'render' ? installRendererGlobals() : null
}

function acquire(kind: WindowKind): Promise<void> {
  if (openKind === null) {
    open(kind, 1)
    return Promise.resolve()
  }
  if (openKind === kind) {
    openCount++
    return Promise.resolve()
  }
  return new Promise<void>((go) => waiting.push({ kind, go }))
}

function release(): void {
  openCount--
  if (openCount > 0) return
  const put = restore
  restore = null
  openKind = null
  put?.()
  // Only the other kind can be waiting (same-kind callers join the open
  // window), but a window of the other kind may have queued callers of ours
  // behind it before it closed: take the first kind in line, all of it.
  if (waiting.length === 0) return
  const next = waiting[0].kind
  const batch = waiting.filter((w) => w.kind === next)
  waiting = waiting.filter((w) => w.kind !== next)
  open(next, batch.length)
  for (const w of batch) w.go()
}

async function within<T>(kind: WindowKind, fn: () => Promise<T>): Promise<T> {
  await acquire(kind)
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Run a pdf.js render with the renderer's canvas build installed as pdf.js's
 * Path2D, DOMMatrix and ImageData (and pdfjsWorker cleared), restoring the
 * previous globals when the last overlapping render ends.
 */
export function withPdfCanvasGlobals<T>(fn: () => Promise<T>): Promise<T> {
  return within('render', fn)
}

/** Run pdf-parse's text extraction outside any render's window. */
export function withPdfTextLayer<T>(fn: () => Promise<T>): Promise<T> {
  return within('text', fn)
}

async function loadPdfToPng(): Promise<PdfToPng> {
  const mod = (await import('pdf-to-png-converter')) as unknown as { pdfToPng?: PdfToPng; default?: { pdfToPng: PdfToPng } }
  const fn = mod.pdfToPng ?? mod.default?.pdfToPng
  if (!fn) throw new Error('The PDF renderer is not available in this build.')
  return fn
}

/** The PDF page renderer, handed to fn inside withPdfCanvasGlobals. Do not keep it past fn. */
export function withPdfRenderer<T>(fn: (pdfToPng: PdfToPng) => Promise<T>): Promise<T> {
  return withPdfCanvasGlobals(async () => fn(await loadPdfToPng()))
}

/** For tests: which window is open and how many calls share it. */
export function pdfGlobalsWindow(): { kind: WindowKind | null; count: number; waiting: number } {
  return { kind: openKind, count: openCount, waiting: waiting.length }
}
