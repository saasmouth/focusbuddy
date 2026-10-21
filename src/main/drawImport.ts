// PlexiiDraw import, the main-process half: the native Open dialog, reading
// the chosen files, and turning a PDF page into pixels.
//
// Everything that INTERPRETS a file -- what kind it is, its size, the SVG
// parser -- is shared, pure code (src/shared/draw/import) that runs in the
// renderer. This side only reads bytes the user picked, with a size cap, and
// renders a PDF page with the app's existing pdf-to-png-converter (pdf.js on
// @napi-rs/canvas), so a PDF (or an Illustrator .ai saved with PDF
// compatibility) can be placed as an image of one page.
//
// Linked placement is deliberately not offered: a drawing that points at a
// file on this disk would make every viewer of a shared drawing fetch it (see
// isDrawImageSrc). Placed files are always embedded in the drawing.

import { BrowserWindow, dialog } from 'electron'
import { readFile, stat } from 'fs/promises'
import { basename } from 'path'
import { MAX_PLACE_BYTES } from '@shared/draw/import/imageInfo'

export type DrawImportPurpose = 'place' | 'open' | 'import' | 'replace'

export interface DrawImportFile {
  name: string
  bytes: Uint8Array
}

export interface DrawPickResult {
  ok: boolean
  files: DrawImportFile[]
  /** Files that could not be read (too large, unreadable), by name. */
  skipped: Array<{ name: string; reason: string }>
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']
const VECTOR_EXT = ['svg', 'svgz']
const PDF_EXT = ['pdf', 'ai']

function filtersFor(purpose: DrawImportPurpose): Electron.FileFilter[] {
  if (purpose === 'open' || purpose === 'import') return [{ name: 'SVG', extensions: VECTOR_EXT }]
  if (purpose === 'replace') return [{ name: 'Images and PDF', extensions: [...IMAGE_EXT, ...PDF_EXT] }]
  return [
    { name: 'All placeable files', extensions: [...IMAGE_EXT, ...VECTOR_EXT, ...PDF_EXT] },
    { name: 'Images (PNG, JPEG, GIF, WebP)', extensions: IMAGE_EXT },
    { name: 'SVG', extensions: VECTOR_EXT },
    { name: 'PDF / Illustrator (PDF-compatible)', extensions: PDF_EXT }
  ]
}

const TITLES: Record<DrawImportPurpose, string> = { place: 'Place', open: 'Open SVG', import: 'Import SVG', replace: 'Replace image' }

/** Show the Open dialog and read what was picked. Only Place takes several files, as in Illustrator. */
export async function pickDrawImportFiles(input: { purpose: DrawImportPurpose }): Promise<DrawPickResult> {
  const purpose: DrawImportPurpose = ['place', 'open', 'import', 'replace'].includes(input?.purpose) ? input.purpose : 'place'
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts: Electron.OpenDialogOptions = {
    title: TITLES[purpose],
    properties: purpose === 'place' ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: filtersFor(purpose)
  }
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths.length) return { ok: false, files: [], skipped: [] }
  return readPicked(res.filePaths)
}

/** Read files by path, refusing any over the size cap rather than loading it. */
export async function readPicked(paths: string[]): Promise<DrawPickResult> {
  const files: DrawImportFile[] = []
  const skipped: DrawPickResult['skipped'] = []
  for (const p of paths.slice(0, 64)) {
    const name = basename(p)
    try {
      const st = await stat(p)
      if (!st.isFile()) {
        skipped.push({ name, reason: 'not a file' })
        continue
      }
      if (st.size > MAX_PLACE_BYTES) {
        skipped.push({ name, reason: `larger than ${Math.round(MAX_PLACE_BYTES / (1024 * 1024))} MB` })
        continue
      }
      const buf = await readFile(p)
      files.push({ name, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) })
    } catch (err) {
      skipped.push({ name, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { ok: files.length > 0, files, skipped }
}

// ── PDF pages ────────────────────────────────────────────────────────────────

export interface DrawPdfPageResult {
  ok: boolean
  /** PNG of the page. */
  dataUrl?: string
  /** The page's size in points (1/72 inch). */
  w?: number
  h?: number
  /** How many pages the PDF has. */
  pages?: number
  error?: string
}

/** The largest PDF that can be placed (the IPC payload cap). */
export const MAX_PDF_BYTES = 16 * 1024 * 1024

/** Pixels per point the page is rendered at: crisp at 2x zoom, bounded in memory. */
const PDF_SCALE = 2
const MAX_PDF_SIDE = 8000

type PdfToPng = (data: Uint8Array, opts: Record<string, unknown>) => Promise<Array<{ content?: Buffer; width: number; height: number; pageNumber: number }>>

async function loadPdfToPng(): Promise<PdfToPng> {
  const mod = (await import('pdf-to-png-converter')) as unknown as { pdfToPng?: PdfToPng; default?: { pdfToPng: PdfToPng } }
  const fn = mod.pdfToPng ?? mod.default?.pdfToPng
  if (!fn) throw new Error('The PDF renderer is not available in this build.')
  return fn
}

/**
 * pdf-parse and pdf-to-png-converter bundle different pdf.js versions that
 * share globalThis.pdfjsWorker (see ocr.ts); clear it around our call.
 */
async function withOwnPdfWorker<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { pdfjsWorker?: unknown }
  const prev = g.pdfjsWorker
  delete g.pdfjsWorker
  try {
    return await fn()
  } finally {
    if (prev !== undefined) g.pdfjsWorker = prev
    else delete g.pdfjsWorker
  }
}

/** One page of a PDF as a PNG, with the page's size in points and the page count. */
export async function renderDrawPdfPage(input: { bytes: Uint8Array; page?: number }): Promise<DrawPdfPageResult> {
  const bytes = input?.bytes instanceof Uint8Array ? input.bytes : null
  if (!bytes || bytes.byteLength === 0) return { ok: false, error: 'No PDF data.' }
  // The renderer hands the bytes over IPC, which carries at most 16 MB.
  if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, error: `The PDF is larger than ${MAX_PDF_BYTES / (1024 * 1024)} MB, too large to place.` }
  const page = Number.isInteger(input.page) && (input.page as number) >= 1 ? (input.page as number) : 1
  try {
    const pdfToPng = await loadPdfToPng()
    return await withOwnPdfWorker(async () => {
      // Every page's size first (no rendering), for the count and the scale.
      const meta = await pdfToPng(new Uint8Array(bytes), { returnMetadataOnly: true, viewportScale: 1, verbosityLevel: 0 })
      const pages = meta.length
      const m = meta.find((p) => p.pageNumber === page)
      if (!m) return { ok: false, pages, error: `The PDF has ${pages} page${pages === 1 ? '' : 's'}; there is no page ${page}.` }
      const scale = Math.max(0.1, Math.min(PDF_SCALE, MAX_PDF_SIDE / Math.max(m.width, m.height)))
      const [out] = await pdfToPng(new Uint8Array(bytes), { viewportScale: scale, pagesToProcess: [page], returnPageContent: true, verbosityLevel: 0, disableFontFace: false, useSystemFonts: true })
      if (!out?.content) return { ok: false, pages, error: 'The page could not be rendered.' }
      return { ok: true, dataUrl: `data:image/png;base64,${out.content.toString('base64')}`, w: m.width, h: m.height, pages }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: /password/i.test(msg) ? 'The PDF is password-protected.' : `The PDF could not be read: ${msg}` }
  }
}
