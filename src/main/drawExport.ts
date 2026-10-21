// PlexiDraw export: write the artwork out as a real PNG, SVG or PDF.
//
// SVG is written straight from the shared serializer — no rendering step, so the
// file is genuinely resolution-independent vector data (with any painted layers
// embedded as images). PNG and PDF go through the same offscreen-capture path
// PlexiDesign uses, drawing the document at its exact pixel size.

import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { CSS_DPI, drawDpi, drawToHtml, drawToSvg, type DrawBody } from '@shared/draw'

export interface DrawExportResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * The PDF page size, in microns, for a document of `width` x `height` pixels
 * at `dpi` pixels per inch. A 1240 x 1754 artboard made from the "A4 at
 * 150dpi" preset is 8.27 x 11.69 inches -- an A4 page -- not the 12.9 x 18.3
 * inches you get by assuming every pixel is a 96dpi CSS pixel, which is what
 * the export did while the stored dpi went unread.
 */
export function pdfPageMicrons(body: { width: number; height: number; dpi?: number }): { width: number; height: number } {
  const dpi = drawDpi(body)
  return { width: Math.round((body.width * 25400) / dpi), height: Math.round((body.height * 25400) / dpi) }
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

export async function exportDraw(input: { draw: DrawBody; title: string; format: 'png' | 'svg' | 'pdf' }): Promise<DrawExportResult> {
  const { draw, title, format } = input
  const safe = (title || 'artwork').replace(/[/\\?%*:|"<>]/g, '-')
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!parent) return { ok: false, error: 'No window is open to save from.' }

  const res = await dialog.showSaveDialog(parent, {
    title: `Export ${format.toUpperCase()}`,
    defaultPath: `${safe}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }

  if (format === 'svg') {
    try {
      await writeFile(res.filePath, drawToSvg(draw), 'utf8')
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const win = new BrowserWindow({
    show: false,
    width: Math.min(Math.max(draw.width, 16), 8000),
    height: Math.min(Math.max(draw.height, 16), 8000),
    useContentSize: true,
    // A transparent artboard must stay transparent in the captured PNG, which
    // needs the offscreen window itself to be transparent.
    transparent: draw.background.type === 'none',
    backgroundColor: draw.background.type === 'none' ? '#00000000' : undefined,
    webPreferences: { offscreen: true }
  })
  try {
    // PNG is captured at the artboard's pixel size; PDF is laid out at the
    // physical size the document's dpi gives it (vectors stay vectors).
    // A document with no stored dpi is laid out exactly as it always was.
    const physical = format === 'pdf' && typeof draw.dpi === 'number' && draw.dpi > 0 ? pdfCssSize(draw) : undefined
    const html = drawToHtml(draw, physical)
    if (physical) win.setContentSize(Math.max(16, Math.min(8000, Math.ceil(physical.w))), Math.max(16, Math.min(8000, Math.ceil(physical.h))))
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // Give embedded raster layers and web fonts a beat to paint before capture.
    await new Promise((r) => setTimeout(r, 350))
    if (format === 'png') {
      let img = await win.webContents.capturePage()
      // capturePage follows the DISPLAY's scale factor, so the same document
      // exported 400x300 on one machine and 800x600 on a Retina one. The
      // document declares its pixel size, so the export is normalised to it —
      // downscaling a hi-dpi capture, which also antialiases nicely.
      const shot = img.getSize()
      if (shot.width !== draw.width || shot.height !== draw.height) {
        img = img.resize({ width: draw.width, height: draw.height, quality: 'best' })
      }
      // The pixels are the artboard's; the pHYs chunk says how big they print.
      // A document that never stored a dpi gets no claim about one.
      const png = img.toPNG()
      await writeFile(res.filePath, typeof draw.dpi === 'number' && draw.dpi > 0 ? pngWithDpi(png, draw.dpi) : png)
    } else {
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: pdfPageMicrons(draw),
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      })
      await writeFile(res.filePath, pdf)
    }
    return { ok: true, path: res.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    win.destroy()
  }
}
