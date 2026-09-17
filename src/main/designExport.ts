// PlexiDesign export: render a design to a real PNG or PDF at its exact pixel
// size. The design is turned into a standalone HTML page (designToHtml) and drawn
// in an offscreen window, then captured to PNG or printed to PDF. This is the
// "get it out" path that makes the studio a finished tool.

import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { designToHtml, designToHtmlAllPages, designPrintHtml, designPrintSize, type DesignBody } from '@shared/design'

export interface DesignExportResult {
  ok: boolean
  path?: string
  error?: string
}

// CSS px to PDF microns: 1px at 96dpi = 1/96 inch = 25400/96 microns.
function pxToMicron(px: number): number {
  return Math.round((px * 25400) / 96)
}

export async function exportDesign(input: {
  design: DesignBody
  title: string
  format: 'png' | 'pdf'
  // Print output: extend the background into the bleed and draw crop marks.
  printMarks?: boolean
}): Promise<DesignExportResult> {
  const { design, title, format, printMarks } = input
  const safe = (title || 'design').replace(/[/\\?%*:|"<>]/g, '-')
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showSaveDialog(parent!, {
    title: printMarks ? 'Export print PDF' : `Export ${format.toUpperCase()}`,
    defaultPath: `${safe}${printMarks ? '-print' : ''}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }

  // Print export uses the larger bleed+marks page; a multi-page PDF stacks every
  // page with page breaks; screen/PNG export is the active trim page.
  const print = designPrintSize(design, { cropMarks: printMarks })
  const usePrint = !!printMarks && (print.bleed > 0 || print.markMargin > 0)
  const multiPage = !printMarks && format === 'pdf' && (design.pages?.length ?? 1) > 1
  const pageW = usePrint ? print.pageWidth : design.width
  const pageH = usePrint ? print.pageHeight : design.height
  const html = usePrint ? designPrintHtml(design, { cropMarks: true }) : multiPage ? designToHtmlAllPages(design) : designToHtml(design)
  const win = new BrowserWindow({
    show: false,
    width: Math.min(Math.max(pageW, 16), 8000),
    height: Math.min(Math.max(pageH, 16), 8000),
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // Give embedded images and web fonts a beat to paint before capture.
    await new Promise((r) => setTimeout(r, 350))
    if (format === 'png') {
      let img = await win.webContents.capturePage()
      // capturePage follows the DISPLAY's scale factor, so the same document
      // exported 400x300 on one machine and 800x600 on a Retina one. The
      // document declares its pixel size, so the export is normalised to it —
      // downscaling a hi-dpi capture, which also antialiases nicely.
      const shot = img.getSize()
      if (shot.width !== pageW || shot.height !== pageH) {
        img = img.resize({ width: pageW, height: pageH, quality: 'best' })
      }
      await writeFile(res.filePath, img.toPNG())
    } else {
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: pxToMicron(pageW), height: pxToMicron(pageH) },
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
