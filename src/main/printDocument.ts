// Print… and Cells' Download ▸ PDF, as main serves them (ipc/index.ts:
// 'print:document', 'print:sheetPdf').
//
// Each request is turned into its app's print-ready render by the SAME function
// that app's PDF export uses, then printed through the system dialog
// (printRender.ts). Cells, which had no PDF until now, gets its Download ▸ PDF
// here from the same render its print uses.

import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { isPrintRequest, type PrintRequest, type PrintResult, type SheetPdfRequest } from '@shared/printJob'
import { printRender, renderToPdf, sheetPrintRender, type PrintRender } from './printRender'
import { writePrintRender } from './officeDocx'
import { slidesPrintRender } from './slidesIo'
import { designPrintRender } from './designExport'
import { mapPrintRender } from './mapExport'

/** The render a print request prints: the app's own PDF render. */
export function renderForRequest(req: PrintRequest): PrintRender {
  switch (req.app) {
    case 'write':
      return writePrintRender({ html: req.html, page: req.page })
    case 'deck':
      return slidesPrintRender(req.body)
    case 'design':
      return designPrintRender(req.design, { format: 'pdf' })
    case 'diagram':
      return mapPrintRender(req.map)
    case 'cells':
      return sheetPrintRender(req.sheet, req.paper)
  }
}

export async function printDocument(req: PrintRequest): Promise<PrintResult> {
  if (!isPrintRequest(req)) return { ok: false, error: 'Nothing to print.' }
  let render: PrintRender
  try {
    render = renderForRequest(req)
  } catch (e) {
    return { ok: false, error: `Could not prepare the print: ${(e as Error).message}` }
  }
  return printRender(render, { app: req.app, title: req.title })
}

/** Cells' Download ▸ PDF: the save dialog, then the same render Print… uses. */
export async function exportSheetPdf(input: SheetPdfRequest): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!input || !input.sheet || (input.paper !== 'a4' && input.paper !== 'letter')) return { ok: false, error: 'Nothing to export.' }
  const safe = (input.title || 'spreadsheet').replace(/[/\\?%*:|"<>]/g, '-')
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showSaveDialog(parent!, {
    title: 'Export as PDF',
    defaultPath: `${safe}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }
  try {
    await writeFile(res.filePath, await renderToPdf(sheetPrintRender(input.sheet, input.paper)))
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: `Could not export PDF: ${(e as Error).message}` }
  }
}
