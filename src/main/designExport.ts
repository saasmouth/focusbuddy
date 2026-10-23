// PlexiDesign export: render a design to a real PNG or PDF at its exact pixel
// size. The design is turned into a standalone HTML page (designToHtml) and drawn
// in an offscreen window, then captured to PNG or printed to PDF. This is the
// "get it out" path that makes the studio a finished tool.

import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { designToHtml, designToHtmlAllPages, designPrintHtml, designPrintSize, type DesignBody } from '@shared/design'
import { pdfPageSize } from './pdfPageSize'
import { renderToPdf, withRenderWindow, type PrintRender } from './printRender'

export interface DesignExportResult {
  ok: boolean
  path?: string
  error?: string
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

  const render = designPrintRender(design, { format, printMarks })
  const pageW = render.window!.width
  const pageH = render.window!.height
  try {
    if (format === 'png') {
      await withRenderWindow(render, async (win) => {
        let img = await win.webContents.capturePage()
        // capturePage follows the DISPLAY's scale factor, so the same document
        // exported 400x300 on one machine and 800x600 on a Retina one. The
        // document declares its pixel size, so the export is normalised to it —
        // downscaling a hi-dpi capture, which also antialiases nicely.
        const shot = img.getSize()
        if (shot.width !== pageW || shot.height !== pageH) {
          img = img.resize({ width: pageW, height: pageH, quality: 'best' })
        }
        await writeFile(res.filePath!, img.toPNG())
      })
    } else {
      await writeFile(res.filePath, await renderToPdf(render))
    }
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: `Could not export: ${(e as Error).message}` }
  }
}

/**
 * Design's print-ready render. Print export uses the larger bleed+marks page; a
 * multi-page PDF stacks every page with page breaks; screen/PNG export is the
 * active trim page. Download ▸ PDF printToPDF()s it; Print… print()s the PDF
 * form of it (printRender.ts), so the paper holds the PDF's pages at their size.
 */
export function designPrintRender(design: DesignBody, opts: { format?: 'png' | 'pdf'; printMarks?: boolean } = {}): PrintRender {
  const format = opts.format ?? 'pdf'
  const printMarks = !!opts.printMarks
  const print = designPrintSize(design, { cropMarks: printMarks })
  const usePrint = printMarks && (print.bleed > 0 || print.markMargin > 0)
  const multiPage = !printMarks && format === 'pdf' && (design.pages?.length ?? 1) > 1
  const pageW = usePrint ? print.pageWidth : design.width
  const pageH = usePrint ? print.pageHeight : design.height
  const html = usePrint ? designPrintHtml(design, { cropMarks: true }) : multiPage ? designToHtmlAllPages(design) : designToHtml(design)
  return {
    // The page size as CSS too: print() takes the page from @page (printRender.ts).
    html: html.replace('</head>', `<style>@page{size:${pageW}px ${pageH}px;margin:0}</style></head>`),
    window: { width: pageW, height: pageH },
    // Give embedded images and web fonts a beat to paint before capture.
    settle: { ms: 350 },
    pdf: {
      printBackground: true,
      pageSize: pdfPageSize(pageW, pageH),
      // Electron 44 dropped `marginType`: explicit numbers ARE the custom
      // case now, so the zero margins below mean exactly what they did before.
      margins: { top: 0, right: 0, bottom: 0, left: 0 }
    }
  }
}
