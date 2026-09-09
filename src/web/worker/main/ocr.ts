// OCR, which the browser runtime does not do.
//
// The desktop rasterises PDF pages and runs Tesseract over them through a
// worker pool that reaches for native tooling and a writable temp directory.
// Neither exists in a tab. Text extraction still works for everything whose
// text is already text -- plain files, markdown, JSON, and PDFs with a real
// text layer -- because only the scanned-PDF fallback comes through here.
//
// Returning an empty string rather than throwing is what the caller wants: it
// treats "no text found" as a normal outcome for a scanned document, and an
// exception here would abandon extraction for the whole file.
export async function ocrPdfBuffer(_buf: Uint8Array, _maxPages?: number): Promise<string> {
  return ''
}

export async function terminateOcrWorker(): Promise<void> {
  // No worker pool to terminate.
}
