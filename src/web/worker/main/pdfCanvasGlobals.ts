// pdf.js's shared globals, which the browser runtime does not have to manage.
//
// On the desktop, pdf-parse and the PDF renderer bundle different pdf.js and
// @napi-rs/canvas builds that fight over Path2D, DOMMatrix, ImageData and
// pdfjsWorker (src/main/pdfCanvasGlobals.ts). In a tab pdf.js draws with the
// browser's own canvas and nothing native is loaded, so text extraction runs
// as it is. There is no page renderer here: Draw's PDF placement and OCR are
// desktop features (OCR's browser variant, ./ocr.ts, already returns no text),
// and asking for the renderer says so rather than half-working.

export const PDF_CANVAS_GLOBALS = ['Path2D', 'DOMMatrix', 'ImageData'] as const

export type PdfToPngPage = { content?: Uint8Array; width: number; height: number; pageNumber: number }
export type PdfToPng = (data: Uint8Array, opts: Record<string, unknown>) => Promise<PdfToPngPage[]>

export function rendererCanvasBuild(): Record<string, unknown> | null {
  return null
}

export function withPdfCanvasGlobals<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}

export function withPdfTextLayer<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}

export function withPdfRenderer<T>(_fn: (pdfToPng: PdfToPng) => Promise<T>): Promise<T> {
  return Promise.reject(new Error('PDF pages are rendered by the desktop app; the browser has no PDF renderer.'))
}

export function pdfGlobalsWindow(): { kind: null; count: number; waiting: number } {
  return { kind: null, count: 0, waiting: 0 }
}
