// PlexiDiagrams export: turn a MapBody into a real .svg, .png, .jpg or .pdf. The SVG
// (mapToSvg) is the single source of truth — written verbatim for .svg, and drawn
// in an offscreen window then captured/printed for the raster and PDF formats.
// Mirrors designExport.ts so the whole suite exports through one shape of code.

import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { mapToSvg } from '@shared/mapExport'
import { getShape } from '@shared/diagram/shapes'
import type { MapBody } from '@shared/types'
import { pdfPageSize } from './pdfPageSize'

export interface MapExportResult {
  ok: boolean
  path?: string
  error?: string
  warning?: string
}

// Icon shapes draw Material Symbols glyphs, so an export that contains them
// embeds the font (as a data URL) to render identically outside the app. Looked
// up in node_modules (dev) or the built renderer assets (packaged).
let iconFont: string | null | undefined
function iconFontDataUrl(): string | null {
  if (iconFont !== undefined) return iconFont
  const candidates: string[] = []
  try {
    candidates.push(require.resolve('material-symbols/material-symbols-outlined.woff2'))
  } catch {
    /* not resolvable in this build */
  }
  const roots = [app.getAppPath(), join(app.getAppPath(), '..'), process.resourcesPath ?? '']
  for (const root of roots) {
    candidates.push(join(root, 'node_modules', 'material-symbols', 'material-symbols-outlined.woff2'))
    for (const dir of [join(root, 'out', 'renderer', 'assets'), join(root, 'renderer', 'assets')]) {
      try {
        for (const f of readdirSync(dir)) if (/^material-symbols-outlined.*\.woff2$/.test(f)) candidates.push(join(dir, f))
      } catch {
        /* no such dir */
      }
    }
  }
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) {
        iconFont = `data:font/woff2;base64,${readFileSync(c).toString('base64')}`
        return iconFont
      }
    } catch {
      /* try the next */
    }
  }
  iconFont = null
  return null
}

type MapFormat = 'svg' | 'png' | 'jpg' | 'pdf'


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

  const usesIcons = (map.nodes ?? []).some((n) => n.icon || getShape(n.shape).special === 'icon')
  const font = usesIcons ? iconFontDataUrl() : null
  const warning = usesIcons && !font ? 'Icons may not render in this export: the icon font was not found.' : undefined
  const { svg, width, height } = mapToSvg(map, font ? { iconFontUrl: font } : {})

  // Vector export is a direct write — no rasterisation, perfect fidelity.
  if (format === 'svg') {
    try {
      await writeFile(res.filePath, svg, 'utf-8')
      return { ok: true, path: res.filePath, ...(warning ? { warning } : {}) }
    } catch (e) {
      return { ok: false, error: `Could not export: ${(e as Error).message}` }
    }
  }

  // Raster / PDF: paint the SVG in an offscreen window at its exact pixel size.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${svg}</body></html>`
  const win = new BrowserWindow({
    show: false,
    width: Math.min(Math.max(width, 16), 8000),
    height: Math.min(Math.max(height, 16), 8000),
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // Wait for embedded fonts (icons) before capturing, then a beat for paint.
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true).catch(() => true)
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
        pageSize: pdfPageSize(width, height),
        // Electron 44 dropped `marginType`; explicit numbers are the custom case.
        margins: { top: 0, right: 0, bottom: 0, left: 0 }
      })
      await writeFile(res.filePath, pdf)
    }
    return { ok: true, path: res.filePath, ...(warning ? { warning } : {}) }
  } catch (e) {
    return { ok: false, error: `Could not export: ${(e as Error).message}` }
  } finally {
    win.destroy()
  }
}
