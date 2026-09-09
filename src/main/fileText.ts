import { getFile, readFileBytes } from './db/files'

// Extract readable plain text from a file so a wire / desk agent / the brain can
// reason over its CONTENTS, not just its name. Best-effort + defensive: any parse
// failure returns an honest "(couldn't read…)" note rather than throwing, so a
// wire never crashes on a weird file. Heavy parsers are imported lazily so they
// only load when a matching file is actually read.
//
// Supported: PDF (pdf-parse for the text layer, falling back to offline OCR via
// ./ocr for scanned / image-only PDFs), Word .docx (mammoth), spreadsheets
// .xlsx/.xls/.csv (xlsx), and plain-text families (txt/md/json/csv/log/tsv/html/
// xml/yaml). Other binaries (images, video, audio, zips) have no text and return null.

const MAX_CHARS = 12000

// The core: bytes + a type hint → text (or null if it's a binary with no text).
//
// Uint8Array rather than Buffer, because this runs in the browser too, where
// Buffer is not a global. Every parser below is fed the shape it wants from
// that one input; only mammoth genuinely differs between the runtimes, and it
// says so at the call.
export async function extractTextFromBuffer(
  buf: Uint8Array,
  ext: string,
  mime: string
): Promise<string | null> {
  const e = ext.toLowerCase().replace(/^\./, '')
  const m = (mime || '').toLowerCase()
  try {
    if (e === 'pdf' || m.includes('pdf')) {
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: buf })
      let text = ''
      let pageCount = 0
      try {
        const res = await parser.getText()
        text = (res.text || '').trim()
        pageCount = res.total ?? 0
      } finally {
        await parser.destroy?.()
      }
      // A scanned / image-only PDF has no embedded text layer, so pdf-parse
      // returns little or nothing. When the text is thin relative to the page
      // count, OCR the rendered pages instead (offline, on-device). Only replace
      // the extracted text if OCR actually found more — never fabricate, and
      // never crash a wire/brain sync if OCR is unavailable.
      const thin = text.length < 16 || (pageCount > 0 && text.length / pageCount < 8)
      if (thin) {
        try {
          const { ocrPdfBuffer } = await import('./ocr')
          const ocr = await ocrPdfBuffer(buf)
          if (ocr.length > text.length) return ocr.slice(0, MAX_CHARS)
        } catch {
          // OCR unavailable or failed — fall back to whatever text layer exists.
        }
      }
      return text.slice(0, MAX_CHARS)
    }
    if (e === 'docx' || m.includes('wordprocessingml')) {
      const mammoth = (await import('mammoth')).default
      // mammoth's Node entry takes a Buffer and its browser entry an
      // ArrayBuffer; there is no single input both accept.
      const res = await mammoth.extractRawText(
        typeof Buffer !== 'undefined'
          ? { buffer: Buffer.from(buf) }
          : ({ arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as never)
      )
      return (res.value || '').trim().slice(0, MAX_CHARS)
    }
    if (e === 'xlsx' || e === 'xls' || e === 'csv' || m.includes('spreadsheet') || m.includes('excel')) {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(buf, { type: 'array' })
      const parts: string[] = []
      for (const name of wb.SheetNames.slice(0, 8)) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name])
        if (csv.trim()) parts.push(`# ${name}\n${csv}`)
      }
      return parts.join('\n\n').trim().slice(0, MAX_CHARS)
    }
    if (
      /^(txt|md|markdown|json|csv|tsv|log|html?|xml|yaml|yml|rtf)$/.test(e) ||
      m.startsWith('text/') ||
      m.includes('json')
    ) {
      return new TextDecoder().decode(buf).trim().slice(0, MAX_CHARS)
    }
  } catch (err) {
    return `(couldn't read this ${e || 'file'}: ${err instanceof Error ? err.message : String(err)})`
  }
  return null // a binary with no extractable text (image, video, audio, archive)
}

// Extract text from a locally-stored file by its files-store id.
export async function extractFileText(fileId: string): Promise<string | null> {
  const file = getFile(fileId)
  if (!file) return null
  const read = await readFileBytes(fileId)
  if (!read) return null
  return extractTextFromBuffer(read.bytes, file.ext ?? '', read.mimeType)
}
