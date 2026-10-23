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
import { renderToPdf, withRenderWindow, type PrintRender } from './printRender'

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

  const render = mapPrintRender(map)
  const warning = render.warning

  // Vector export is a direct write — no rasterisation, perfect fidelity.
  if (format === 'svg') {
    try {
      await writeFile(res.filePath, render.svg, 'utf-8')
      return { ok: true, path: res.filePath, ...(warning ? { warning } : {}) }
    } catch (e) {
      return { ok: false, error: `Could not export: ${(e as Error).message}` }
    }
  }

  // Raster / PDF: paint the SVG in an offscreen window at its exact pixel size.
  try {
    if (format === 'pdf') {
      await writeFile(res.filePath, await renderToPdf(render))
    } else {
      await withRenderWindow(render, async (win) => {
        const img = await win.webContents.capturePage()
        await writeFile(res.filePath!, format === 'png' ? img.toPNG() : img.toJPEG(92))
      })
    }
    return { ok: true, path: res.filePath, ...(warning ? { warning } : {}) }
  } catch (e) {
    return { ok: false, error: `Could not export: ${(e as Error).message}` }
  }
}

/**
 * Diagrams' print-ready render: the page's SVG at its exact pixel size, the
 * paper sized to it (fit to page). Download ▸ PDF printToPDF()s it; Print…
 * print()s it (printRender.ts). `svg` is the vector form the SVG export writes.
 */
export function mapPrintRender(map: MapBody): PrintRender & { svg: string } {
  const usesIcons = (map.nodes ?? []).some((n) => n.icon || getShape(n.shape).special === 'icon')
  const font = usesIcons ? iconFontDataUrl() : null
  const warning = usesIcons && !font ? 'Icons may not render in this export: the icon font was not found.' : undefined
  const { svg, width, height } = mapToSvg(map, font ? { iconFontUrl: font } : {})
  // The page size as CSS too: print() takes the page from @page (printRender.ts).
  // svg{display:block}: an inline <svg> sits on the text baseline, so the body
  // was a few px taller than the page and every Diagrams PDF (and print) ran
  // onto a blank second page. A block svg is exactly the page.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}@page{size:${Math.max(width, 1)}px ${Math.max(height, 1)}px;margin:0}</style></head><body>${svg}</body></html>`
  return {
    svg,
    html,
    window: { width, height },
    // Wait for embedded fonts (icons) before capturing, then a beat for paint.
    settle: { fonts: true, ms: 250 },
    pdf: {
      printBackground: true,
      pageSize: pdfPageSize(width, height),
      // Electron 44 dropped `marginType`; explicit numbers are the custom case.
      margins: { top: 0, right: 0, bottom: 0, left: 0 }
    },
    ...(warning ? { warning } : {})
  }
}
