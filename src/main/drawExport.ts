// PlexiDraw export: write the artwork out as a real PNG, SVG or PDF.
//
// SVG is written straight from the shared serializer — no rendering step, so the
// file is genuinely resolution-independent vector data (with any painted layers
// embedded as images). PNG and PDF go through the same offscreen-capture path
// PlexiDesign uses, drawing the document at its exact pixel size.

import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { drawToHtml, drawToSvg, type DrawBody } from '@shared/draw'

export interface DrawExportResult {
  ok: boolean
  path?: string
  error?: string
}

// CSS px to PDF microns: 1px at 96dpi = 1/96 inch = 25400/96 microns.
function pxToMicron(px: number): number {
  return Math.round((px * 25400) / 96)
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
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(drawToHtml(draw))}`)
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
      await writeFile(res.filePath, img.toPNG())
    } else {
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: pxToMicron(draw.width), height: pxToMicron(draw.height) },
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
