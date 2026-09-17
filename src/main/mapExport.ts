// PlexiDiagrams export: turn a MapBody into a real .svg, .png, .jpg or .pdf. The SVG
// (mapToSvg) is the single source of truth — written verbatim for .svg, and drawn
// in an offscreen window then captured/printed for the raster and PDF formats.
// Mirrors designExport.ts so the whole suite exports through one shape of code.

import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { mapToSvg } from '@shared/mapExport'
import type { MapBody } from '@shared/types'

export interface MapExportResult {
  ok: boolean
  path?: string
  error?: string
}

type MapFormat = 'svg' | 'png' | 'jpg' | 'pdf'

// CSS px to PDF microns: 1px at 96dpi = 25400/96 microns.
function pxToMicron(px: number): number {
  return Math.round((px * 25400) / 96)
}

export async function exportMap(input: {
  map: MapBody
  title: string
  format: MapFormat
}): Promise<MapExportResult> {
  const { map, title, format } = input
  const ext = format === 'jpg' ? 'jpg' : format
  const safe = (title || 'diagram').replace(/[/\\?%*:|"<>]/g, '-')
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showSaveDialog(parent!, {
    title: `Export ${format.toUpperCase()}`,
    defaultPath: `${safe}.${ext}`,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }

  const { svg, width, height } = mapToSvg(map)

  // Vector export is a direct write — no rasterisation, perfect fidelity.
  if (format === 'svg') {
    try {
      await writeFile(res.filePath, svg, 'utf-8')
      return { ok: true, path: res.filePath }
    } catch (e) {
      return { ok: false, error: `Could not export: ${(e as Error).message}` }
    }
  }

  // Raster / PDF: paint the SVG in an offscreen window at its exact pixel size.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style></head><body>${svg}</body></html>`
  const win = new BrowserWindow({
    show: false,
    width: Math.min(Math.max(width, 16), 8000),
    height: Math.min(Math.max(height, 16), 8000),
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((r) => setTimeout(r, 250))
    if (format === 'png') {
      const img = await win.webContents.capturePage()
      await writeFile(res.filePath, img.toPNG())
    } else if (format === 'jpg') {
      const img = await win.webContents.capturePage()
      await writeFile(res.filePath, img.toJPEG(92))
    } else {
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: pxToMicron(width), height: pxToMicron(height) },
        margins: { marginType: 'custom', top: 0, right: 0, bottom: 0, left: 0 }
      })
      await writeFile(res.filePath, pdf)
    }
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: `Could not export: ${(e as Error).message}` }
  } finally {
    win.destroy()
  }
}
