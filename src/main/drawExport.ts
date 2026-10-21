// PlexiDraw export: write the artwork out as a real PNG, SVG or PDF.
//
// SVG is written straight from the shared serializer — no rendering step, so the
// file is genuinely resolution-independent vector data (with any painted layers
// embedded as images). PNG and PDF go through the same offscreen-capture path
// PlexiDesign uses, drawing the document at its exact pixel size.

import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { CSS_DPI, drawDpi, type DrawBody } from '@shared/draw'
import { normalizeDrawDoc } from '@shared/draw/normalize'
import { drawDocToHtml, drawDocToPagesHtml, drawDocToSvg, exportArtboard } from '@shared/draw/svg'
import { artboardsBounds } from '@shared/draw/ops/artboards'
import type { DrawDoc } from '@shared/draw/model'

export interface DrawExportResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * The PDF page size, in inches, for a document of `width` x `height` pixels
 * at `dpi` pixels per inch. A 1240 x 1754 artboard made from the "A4 at
 * 150dpi" preset is 8.27 x 11.69 inches -- an A4 page -- not the 12.9 x 18.3
 * inches you get by assuming every pixel is a 96dpi CSS pixel, which is what
 * the export did while the stored dpi went unread. Inches, not microns:
 * Electron 44's printToPDF reads a custom pageSize in inches and fails on
 * microns (see pdfPageSize.ts).
 */
export function pdfPageInches(body: { width: number; height: number; dpi?: number }): { width: number; height: number } {
  const dpi = drawDpi(body)
  return { width: Math.max(body.width, 1) / dpi, height: Math.max(body.height, 1) / dpi }
}

/**
 * The CSS size the offscreen page lays the drawing out at so that Chromium's
 * printer, which always works at 96 CSS px to the inch, fills that page.
 */
export function pdfCssSize(body: { width: number; height: number; dpi?: number }): { w: number; h: number } {
  const k = CSS_DPI / drawDpi(body)
  return { w: body.width * k, h: body.height * k }
}

// ── PNG resolution metadata ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * The PNG with a pHYs chunk declaring `dpi`, so a print or layout app opens a
 * 1240 x 1754 "A4 at 150dpi" export as A4 rather than as a 72dpi poster. The
 * pixels are untouched. Any pHYs chunk already present is replaced; a buffer
 * that is not a PNG comes back as it was.
 */
export function pngWithDpi(png: Buffer, dpi: number): Buffer {
  const SIG = '89504e470d0a1a0a'
  if (png.length < 33 || png.subarray(0, 8).toString('hex') !== SIG || !(dpi > 0)) return png
  const chunks: Buffer[] = [png.subarray(0, 8)]
  let off = 8
  let inserted = false
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off)
    const end = off + 12 + len
    if (end > png.length) return png // truncated: leave it alone rather than guess
    const type = png.subarray(off + 4, off + 8).toString('latin1')
    if (type !== 'pHYs') chunks.push(png.subarray(off, end))
    if (type === 'IHDR' && !inserted) {
      const ppm = Math.round(dpi / 0.0254)
      const data = Buffer.alloc(9)
      data.writeUInt32BE(ppm, 0)
      data.writeUInt32BE(ppm, 4)
      data.writeUInt8(1, 8) // unit: the metre
      const typeAndData = Buffer.concat([Buffer.from('pHYs', 'latin1'), data])
      const chunk = Buffer.alloc(12 + 9)
      chunk.writeUInt32BE(9, 0)
      typeAndData.copy(chunk, 4)
      chunk.writeUInt32BE(crc32(typeAndData), 4 + typeAndData.length)
      chunks.push(chunk)
      inserted = true
    }
    off = end
  }
  return inserted ? Buffer.concat(chunks) : png
}

/** What an export covers when a drawing has several artboards. */
export type DrawExportScope = 'artboard' | 'each' | 'canvas' | 'pages'

/** One file name per artboard for "each artboard": "<stem> - <artboard name>.<ext>", unique and filesystem-safe. */
export function perArtboardPaths(filePath: string, names: string[]): string[] {
  const m = /^(.*?)(\.[^./\\]+)?$/.exec(filePath)!
  const stem = m[1]
  const ext = m[2] ?? ''
  const used = new Set<string>()
  return names.map((n, i) => {
    let base = `${stem} - ${(n || `Artboard ${i + 1}`).replace(/[/\\?%*:|"<>]/g, '-').trim() || `Artboard ${i + 1}`}`
    if (used.has(base.toLowerCase())) base = `${base} (${i + 1})`
    used.add(base.toLowerCase())
    return `${base}${ext}`
  })
}

/** An offscreen window of a given size; transparent when the page is. */
function captureWindow(w: number, h: number, transparent: boolean): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: Math.min(Math.max(w, 16), 8000),
    height: Math.min(Math.max(h, 16), 8000),
    useContentSize: true,
    // A transparent artboard must stay transparent in the captured PNG, which
    // needs the offscreen window itself to be transparent.
    transparent,
    backgroundColor: transparent ? '#00000000' : undefined,
    webPreferences: { offscreen: true }
  })
}

async function loadHtml(win: BrowserWindow, html: string): Promise<void> {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  // Give embedded raster layers and web fonts a beat to paint before capture.
  await new Promise((r) => setTimeout(r, 350))
}

/** The PNG of one frame (an artboard, or the whole canvas) at its pixel size. */
async function renderPng(doc: DrawDoc, frame: { artboardId?: string; canvas?: boolean }): Promise<Buffer> {
  const box = frame.canvas ? { ...artboardsBounds(doc), background: { type: 'none' } as const } : exportArtboard(doc, frame.artboardId)
  const w = Math.max(1, Math.round(box.w))
  const h = Math.max(1, Math.round(box.h))
  const transparent = frame.canvas ? true : box.background.type === 'none'
  const win = captureWindow(w, h, transparent)
  try {
    await loadHtml(win, drawDocToHtml(doc, frame))
    let img = await win.webContents.capturePage()
    // capturePage follows the DISPLAY's scale factor, so the same document
    // exported 400x300 on one machine and 800x600 on a Retina one. The
    // document declares its pixel size, so the export is normalised to it —
    // downscaling a hi-dpi capture, which also antialiases nicely.
    const shot = img.getSize()
    if (shot.width !== w || shot.height !== h) img = img.resize({ width: w, height: h, quality: 'best' })
    // The pixels are the artboard's; the pHYs chunk says how big they print.
    // A document that never stored a dpi gets no claim about one.
    const png = img.toPNG()
    const dpi = doc.settings.dpi
    return typeof dpi === 'number' && dpi > 0 ? pngWithDpi(png, dpi) : png
  } finally {
    win.destroy()
  }
}

/** A one-page PDF of one artboard, or a PDF with one page per artboard (`pages`). */
async function renderPdf(doc: DrawDoc, frame: { artboardId?: string; pages?: boolean }): Promise<Buffer> {
  const dpi = doc.settings.dpi
  const physical = typeof dpi === 'number' && dpi > 0
  if (frame.pages && doc.artboards.length > 1) {
    // Each page at its own size: named CSS @page rules, honoured with preferCSSPageSize.
    const size = (a: { w: number; h: number }): { w: number; h: number } => (physical ? pdfCssSize({ width: a.w, height: a.h, dpi }) : { w: a.w, h: a.h })
    const first = size(doc.artboards[0])
    const win = captureWindow(Math.ceil(first.w), Math.ceil(first.h), false)
    try {
      await loadHtml(win, drawDocToPagesHtml(doc, size))
      return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
    } finally {
      win.destroy()
    }
  }
  const board = exportArtboard(doc, frame.artboardId)
  const draw = { width: board.w, height: board.h, dpi }
  const css = physical ? pdfCssSize(draw) : undefined
  const win = captureWindow(css ? Math.ceil(css.w) : board.w, css ? Math.ceil(css.h) : board.h, board.background.type === 'none')
  try {
    // PDF is laid out at the physical size the document's dpi gives it
    // (vectors stay vectors). A document with no stored dpi is laid out
    // exactly as it always was.
    await loadHtml(win, drawDocToHtml(doc, { artboardId: board.id, cssSize: css }))
    return await win.webContents.printToPDF({ printBackground: true, pageSize: pdfPageInches(draw), margins: { top: 0, bottom: 0, left: 0, right: 0 } })
  } finally {
    win.destroy()
  }
}

/** The artboard a single-frame export covers: the one asked for, else the active one, else the first. */
function chosenArtboard(doc: DrawDoc, artboardId: string | undefined): string {
  const want = artboardId ?? doc.activeArtboardId
  return (want && doc.artboards.some((a) => a.id === want) ? want : doc.artboards[0].id) as string
}

export async function exportDraw(input: {
  draw: DrawBody | DrawDoc
  title: string
  format: 'png' | 'svg' | 'pdf'
  /** With several artboards: one artboard (default for PNG/SVG), each artboard to its own file, the whole canvas, or (PDF) every artboard as a page (default for PDF). */
  scope?: DrawExportScope
  artboardId?: string
}): Promise<DrawExportResult> {
  const { title, format } = input
  // Whatever the renderer sent -- a v1 body or a v2 document -- is normalised
  // here (the renderer is not trusted to have done it) and written by the v2
  // serializer, which is byte-identical to v1's for every v1 drawing.
  const doc = normalizeDrawDoc(input.draw)
  const multi = doc.artboards.length > 1
  const scope: DrawExportScope = !multi ? 'artboard' : input.scope && ['artboard', 'each', 'canvas', 'pages'].includes(input.scope) ? input.scope : format === 'pdf' ? 'pages' : 'artboard'
  const boardId = chosenArtboard(doc, typeof input.artboardId === 'string' ? input.artboardId : undefined)
  const safe = (title || 'artwork').replace(/[/\\?%*:|"<>]/g, '-')
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!parent) return { ok: false, error: 'No window is open to save from.' }

  const res = await dialog.showSaveDialog(parent, {
    title: scope === 'each' ? `Export each artboard as ${format.toUpperCase()}` : `Export ${format.toUpperCase()}`,
    defaultPath: `${safe}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }
  const filePath = res.filePath

  try {
    if (scope === 'each' && format !== 'pdf') {
      const paths = perArtboardPaths(filePath, doc.artboards.map((a) => a.name))
      for (let i = 0; i < doc.artboards.length; i++) {
        const id = doc.artboards[i].id
        await writeFile(paths[i], format === 'svg' ? drawDocToSvg(doc, { artboardId: id }) : await renderPng(doc, { artboardId: id }), format === 'svg' ? 'utf8' : undefined)
      }
      return { ok: true, path: paths.length === 1 ? paths[0] : `${paths[0]} and ${paths.length - 1} more` }
    }
    if (format === 'svg') {
      await writeFile(filePath, scope === 'canvas' ? drawDocToSvg(doc, { canvas: true }) : drawDocToSvg(doc, { artboardId: boardId }), 'utf8')
    } else if (format === 'png') {
      await writeFile(filePath, await renderPng(doc, scope === 'canvas' ? { canvas: true } : { artboardId: boardId }))
    } else {
      await writeFile(filePath, await renderPdf(doc, scope === 'pages' ? { pages: true } : { artboardId: boardId }))
    }
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
