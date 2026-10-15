// Office interop for the document editor: import a real .docx, export to .docx
// and PDF, and pick an image for insertion. All file dialogs and conversions
// run here in the main process. Conversions are best-effort and lossy by nature
// (Word's full feature set does not map onto a web editor), which the renderer
// communicates to the user; what we keep, we keep faithfully.

import { dialog, BrowserWindow } from 'electron'
import { basename, extname } from 'path'
import { readFile, writeFile } from 'fs/promises'
// mammoth and @turbodocx/html-to-docx are imported lazily inside the functions
// that use them. They are heavy and have packaging-sensitive transitive deps, so
// keeping them out of this module's load path means a missing dependency can only
// ever degrade docx import/export to an error, never crash app startup.

export interface OfficeImportResult {
  ok: boolean
  html?: string
  fileName?: string
  // Page setup recovered from the .docx (size, orientation, margins) plus the
  // running header/footer text. Absent when the file has none. mammoth converts
  // only the body, so without this the header/footer would be silently dropped.
  page?: PageSetupInput
  error?: string
}
export interface OfficeExportResult {
  ok: boolean
  path?: string
  error?: string
}
export interface OfficePickImageResult {
  ok: boolean
  dataUrl?: string
  error?: string
}

// The document's page setup, mirrored from the renderer's PageSetup. Margins are
// in inches; size and orientation drive the .docx/PDF page geometry so the export
// matches the on-screen sheet.
export interface PageSetupInput {
  size: 'letter' | 'a4'
  orientation: 'portrait' | 'landscape'
  margin: { top: number; right: number; bottom: number; left: number }
  header?: { text?: string; showPageNumber?: boolean }
  footer?: { text?: string; showPageNumber?: boolean }
}

const DEFAULT_PAGE: PageSetupInput = { size: 'letter', orientation: 'portrait', margin: { top: 1, right: 1, bottom: 1, left: 1 } }

// Paper dimensions in twips (1 inch = 1440 twips), portrait orientation.
function paperTwips(size: 'letter' | 'a4'): { width: number; height: number } {
  return size === 'a4' ? { width: 11906, height: 16838 } : { width: 12240, height: 15840 }
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

// Text runs (<w:t> or the unprefixed <t> that some writers, incl. turbodocx's
// header/footer parts, emit), joined and entity-decoded.
function docxText(xml: string): string {
  return [...xml.matchAll(/<(?:w:)?t\b[^>]*>([\s\S]*?)<\/(?:w:)?t>/g)]
    .map((m) => m[1])
    .join('')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// A header/footer part references an auto page number via a PAGE field, whether a
// simple field, a complex field's instruction text, or their unprefixed forms.
function hasPageNumberField(xml: string): boolean {
  return /instr="[^"]*\bPAGE\b/.test(xml) || /<(?:w:)?instrText[^>]*>[^<]*\bPAGE\b/.test(xml)
}

// Parse a .docx package's section properties into our PageSetupInput: paper size,
// orientation, margins, and the default running header/footer. Pure (takes the
// file bytes) so it can be unit-tested against a constructed package.
export async function parseDocxPageSetup(data: Uint8Array): Promise<PageSetupInput | undefined> {
  const { unzipSync, strFromU8 } = await import('fflate')
  const files = unzipSync(data) as Record<string, Uint8Array>
  const docKey = Object.keys(files).find((n) => /word\/document\.xml$/i.test(n))
  if (!docKey) return undefined
  const doc = strFromU8(files[docKey])
  const sect = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(doc)?.[0] ?? ''

  // Page size + orientation from pgSz (twips). Match to the nearest known paper.
  const pgSz = /<w:pgSz\b[^>]*>/.exec(sect)?.[0] ?? ''
  const w = Number(/w:w="(\d+)"/.exec(pgSz)?.[1] ?? 0)
  const orientAttr = /w:orient="([^"]+)"/.exec(pgSz)?.[1]
  const orientation: PageSetupInput['orientation'] = orientAttr === 'landscape' ? 'landscape' : 'portrait'
  // A4 portrait width is 11906 twips, Letter 12240. Compare on the short edge.
  const shortEdge = orientation === 'landscape' ? Number(/w:h="(\d+)"/.exec(pgSz)?.[1] ?? w) : w
  const size: PageSetupInput['size'] = shortEdge && Math.abs(shortEdge - 11906) < Math.abs(shortEdge - 12240) ? 'a4' : 'letter'

  // Margins from pgMar (twips → inches).
  const pgMar = /<w:pgMar\b[^>]*>/.exec(sect)?.[0] ?? ''
  const twipIn = (v: string | undefined): number => (v ? Math.round((Number(v) / 1440) * 100) / 100 : 1)
  const margin = {
    top: twipIn(/w:top="(-?\d+)"/.exec(pgMar)?.[1]),
    right: twipIn(/w:right="(\d+)"/.exec(pgMar)?.[1]),
    bottom: twipIn(/w:bottom="(-?\d+)"/.exec(pgMar)?.[1]),
    left: twipIn(/w:left="(\d+)"/.exec(pgMar)?.[1])
  }

  // Resolve the default header/footer references through the document rels.
  const relsKey = Object.keys(files).find((n) => /word\/_rels\/document\.xml\.rels$/i.test(n))
  const rels = new Map<string, string>()
  if (relsKey) {
    for (const rel of strFromU8(files[relsKey]).match(/<Relationship\b[^>]*\/?>/g) ?? []) {
      const id = /Id="([^"]+)"/.exec(rel)?.[1]
      const target = /Target="([^"]+)"/.exec(rel)?.[1]
      if (id && target) rels.set(id, target.replace(/^\//, ''))
    }
  }
  const refPart = (kind: 'header' | 'footer'): PageSetupInput['header'] => {
    // Prefer the default reference; fall back to the first of this kind. Search the
    // whole document rather than only the extracted sectPr so a differently-shaped
    // section (or an unmatched sectPr) still resolves the reference.
    const refs = doc.match(new RegExp(`<w:${kind}Reference\\b[^>]*>`, 'g')) ?? []
    const def = refs.find((r) => /w:type="default"/.test(r)) ?? refs[0]
    if (!def) return undefined
    const rId = /r:id="([^"]+)"/.exec(def)?.[1]
    if (!rId) return undefined
    const target = rels.get(rId)
    if (!target) return undefined
    const key = Object.keys(files).find((n) => n.toLowerCase() === `word/${target.toLowerCase()}`)
    if (!key) return undefined
    const xml = strFromU8(files[key])
    const text = docxText(xml)
    const showPageNumber = hasPageNumberField(xml)
    if (!text && !showPageNumber) return undefined
    return { ...(text ? { text } : {}), ...(showPageNumber ? { showPageNumber: true } : {}) }
  }

  const header = refPart('header')
  const footer = refPart('footer')
  return { size, orientation, margin, ...(header ? { header } : {}), ...(footer ? { footer } : {}) }
}

// Open a .docx and convert it to HTML with mammoth. The renderer turns the HTML
// into editor JSON. Images come through as base64 data URIs. The section
// properties (page size, margins, running header/footer) are parsed separately
// because mammoth converts only the body.
export async function importDocx(): Promise<OfficeImportResult> {
  const win = focusedWindow()
  const res = await dialog.showOpenDialog(win!, {
    title: 'Import Word document',
    properties: ['openFile'],
    filters: [{ name: 'Word document', extensions: ['docx'] }]
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false }
  const path = res.filePaths[0]
  if (extname(path).toLowerCase() !== '.docx') {
    return { ok: false, error: 'Only .docx files can be imported (legacy .doc is not supported).' }
  }
  try {
    const mammoth = (await import('mammoth')).default
    const buffer = await readFile(path)
    const out = await mammoth.convertToHtml({ buffer })
    const page = await parseDocxPageSetup(new Uint8Array(buffer)).catch(() => undefined)
    return { ok: true, html: out.value, fileName: basename(path), ...(page ? { page } : {}) }
  } catch (e) {
    return { ok: false, error: `Could not read that document: ${(e as Error).message}` }
  }
}


/**
 * Which tables in the editor's HTML asked to repeat their header row, in
 * document order. Exported for testing.
 */
export function repeatHeaderFlags(html: string): boolean[] {
  return [...html.matchAll(/<table\b[^>]*>/gi)].map((m) =>
    /data-header-repeat\s*=\s*"true"/i.test(m[0])
  )
}

/**
 * Write <w:tblHeader/> onto the first row of each flagged table in a docx's
 * document.xml — the element Word reads to repeat a header row across pages.
 *
 * html-to-docx has no notion of a repeating header (there is no "tblHeader"
 * anywhere in the library), so the flag cannot survive the conversion and has to
 * be written into the finished package afterwards.
 *
 * Tables are matched by ORDER: the nth <table> of the source HTML is the nth
 * <w:tbl> of the output, which holds because the converter walks the HTML once.
 * A nested table is not matched — the non-greedy block match stops at the inner
 * close tag — so it simply misses the flag, which is the safe way to be wrong.
 *
 * Pure and synchronous, so the XML rewrite is testable without a zip.
 */
export function withRepeatingHeaders(xml: string, wanted: boolean[]): string {
  let i = 0
  return xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const repeat = wanted[i++] === true
    if (!repeat) return tbl
    let done = false
    // The first row only — that is the header Word repeats. Merge into an
    // existing <w:trPr> rather than emitting a second one, which is invalid.
    return tbl.replace(/<w:tr\b[^>]*>(<w:trPr>)?/, (match, trPr: string | undefined) => {
      if (done) return match
      done = true
      return trPr ? `${match}<w:tblHeader/>` : `${match}<w:trPr><w:tblHeader/></w:trPr>`
    })
  })
}

/**
 * Reopen the finished .docx (a zip) and apply the header-repeat flags. Never
 * throws: a failure returns the original document rather than losing the user's
 * export over a formatting nicety.
 */
async function markRepeatingHeaders(buf: Buffer, html: string): Promise<Buffer> {
  try {
    const wanted = repeatHeaderFlags(html)
    if (!wanted.some(Boolean)) return buf
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(buf)
    const entry = zip.file('word/document.xml')
    if (!entry) return buf
    zip.file('word/document.xml', withRepeatingHeaders(await entry.async('string'), wanted))
    return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
  } catch {
    return buf
  }
}

// Save the editor's HTML as a .docx via html-to-docx, honouring the document's
// own page setup (size, orientation, per-side margins) so Word opens the file
// with the same pages the writer set on screen.
export async function exportDocx(input: { html: string; title: string; page?: PageSetupInput }): Promise<OfficeExportResult> {
  const win = focusedWindow()
  const safe = (input.title || 'document').replace(/[/\\?%*:|"<>]/g, '-')
  const res = await dialog.showSaveDialog(win!, {
    title: 'Export as Word document',
    defaultPath: `${safe}.docx`,
    filters: [{ name: 'Word document', extensions: ['docx'] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }
  try {
    const HTMLtoDOCX = (await import('@turbodocx/html-to-docx')).default
    const page = input.page ?? DEFAULT_PAGE
    const inch = (n: number): number => Math.round(n * 1440)
    const paper = paperTwips(page.size)
    const landscape = page.orientation === 'landscape'
    // Give tables a visible default border so a Plexii table doesn't arrive in Word
    // as an invisible grid, and wrap the body with a base font so the document
    // reads like a real Word file rather than browser default.
    const styledHtml = `<style>table,th,td{border:1px solid #999;border-collapse:collapse;padding:4px}</style>${input.html}`
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safe}</title></head><body>${styledHtml}</body></html>`
    // Running header / footer text from the document's page setup. turbodocx takes
    // the header HTML as the 2nd arg and the footer HTML as the 4th; pageNumber
    // renders in the footer. Legacy docs (no footer config) keep the page number
    // they've always had; a configured doc honours its showPageNumber toggle.
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const hfHtml = (t?: string): string | undefined =>
      t && t.trim() ? `<p style="text-align:center;font-size:9pt;color:#666">${esc(t.trim())}</p>` : undefined
    const headerHtml = hfHtml(page.header?.text)
    const footerHtml = hfHtml(page.footer?.text)
    const wantPageNumber = page.footer === undefined ? true : !!page.footer.showPageNumber || !!page.header?.showPageNumber
    const wantFooter = wantPageNumber || !!footerHtml
    const wantHeader = !!headerHtml
    const fileBuffer = (await HTMLtoDOCX(
      fullHtml,
      headerHtml,
      {
        title: safe,
        font: 'Calibri',
        fontSize: 22, // half-points = 11pt
        orientation: page.orientation,
        pageSize: landscape ? { width: paper.height, height: paper.width } : paper,
        margins: {
          top: inch(page.margin.top),
          right: inch(page.margin.right),
          bottom: inch(page.margin.bottom),
          left: inch(page.margin.left)
        },
        table: { row: { cantSplit: true } },
        header: wantHeader,
        footer: wantFooter,
        pageNumber: wantPageNumber
      },
      footerHtml
    )) as Buffer | ArrayBuffer
    const raw = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer as ArrayBuffer)
    const buf = await markRepeatingHeaders(raw, input.html)
    await writeFile(res.filePath, buf)
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: `Could not export: ${(e as Error).message}` }
  }
}

// Render the editor's HTML to a PDF using an offscreen window and Chromium's
// print engine, so the PDF matches what the user sees.
export async function exportPdf(input: { html: string; title: string; page?: PageSetupInput }): Promise<OfficeExportResult> {
  const win = focusedWindow()
  const safe = (input.title || 'document').replace(/[/\\?%*:|"<>]/g, '-')
  const res = await dialog.showSaveDialog(win!, {
    title: 'Export as PDF',
    defaultPath: `${safe}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }

  const setup = input.page ?? DEFAULT_PAGE
  const landscape = setup.orientation === 'landscape'
  const sizeName = setup.size === 'a4' ? 'A4' : 'Letter'
  const m = setup.margin
  // A print stylesheet that gives the PDF the document's own page geometry and
  // reuses basic prose typography. Kept self-contained so it needs no app CSS.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    @page { size: ${sizeName} ${setup.orientation}; margin: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in; }
    body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.5; color: #1c1917; }
    h1 { font-size: 22pt; } h2 { font-size: 17pt; } h3 { font-size: 14pt; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #999; padding: 4px 8px; }
    pre { background: #f5f5f4; padding: 10px; border-radius: 4px; white-space: pre-wrap; }
    img { max-width: 100%; }
    blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 12px; color: #555; }
  </style></head><body>${input.html}</body></html>`

  const offscreen = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  try {
    await offscreen.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const pdf = await offscreen.webContents.printToPDF({
      printBackground: true,
      pageSize: sizeName,
      landscape,
      // Electron 44 dropped `marginType`; explicit numbers are the custom case.
      margins: { top: m.top, right: m.right, bottom: m.bottom, left: m.left }
    })
    await writeFile(res.filePath, pdf)
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: `Could not export PDF: ${(e as Error).message}` }
  } finally {
    offscreen.destroy()
  }
}

// Pick an image file and return it as a base64 data URL, which embeds cleanly in
// the document and survives .docx export.
export async function pickImage(): Promise<OfficePickImageResult> {
  const win = focusedWindow()
  const res = await dialog.showOpenDialog(win!, {
    title: 'Insert image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false }
  try {
    const path = res.filePaths[0]
    const buf = await readFile(path)
    const ext = extname(path).slice(1).toLowerCase()
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
