// Print… for the office apps: the print-ready render each app's Download ▸ PDF
// already produces, sent to the printer through the system print dialog.
//
// A PrintRender is the HTML an export loads into an offscreen window plus the
// printToPDF options it prints that window with. Each app's exporter builds its
// render through ONE function (writePrintRender in officeDocx, slidesPrintRender
// in slidesIo, designPrintRender in designExport, mapPrintRender in mapExport,
// sheetPrintRender below), and both paths use it:
//
//   Download ▸ PDF   withRenderWindow(render) → printToPDF(render.pdf) → file
//   Print…           withRenderWindow(render) → print(printOptionsFor(render))
//
// so the paper cannot drift from the PDF: same HTML, same page size, same
// margins, same page breaks. There is no second renderer.
//
// The system dialog is shown (silent: false): the person picks the printer and
// copies. The page geometry travels in the render's own CSS @page rule, which
// Chromium's print honours, and as a named size where the app uses one (Write's
// Letter/A4, Cells' A4/Letter); a custom-sized page (a slide, a design, a
// diagram) relies on @page alone rather than guess print()'s unit for a custom
// size (printToPDF's moved from microns to inches in Electron 44).
//
// Test seam (e2e, NODE_ENV=test with PLEXI_PRINT_CAPTURE=1): instead of opening
// the OS dialog, the job is recorded on globalThis.__plexiiPrintJobs with the
// options print() would have been given and the PDF of the very window it would
// have printed. Nothing ever auto-confirms a real dialog.

import { BrowserWindow, type PrintToPDFOptions, type WebContentsPrintOptions } from 'electron'
import { paperGeometry, sheetPrintHtml, type Paper, type SheetPrintModel } from '@shared/sheetPrint'
import type { PrintRequest, PrintResult } from '@shared/printJob'

export interface PrintRender {
  /** The full HTML document the export loads. */
  html: string
  /** The offscreen window's content size (px); absent = Electron's default. */
  window?: { width: number; height: number }
  /** Wait for web fonts (icon fonts) before printing, then this many ms for paint. */
  settle?: { fonts?: boolean; ms?: number }
  /** Exactly what the PDF export passes to printToPDF. */
  pdf: PrintToPDFOptions
  /** A note the export also returns (Diagrams: the icon font was not found). */
  warning?: string
}

const clampWin = (v: number): number => Math.min(Math.max(Math.round(v), 16), 8000)

/** Load a render in a window, run `fn` on it, and always destroy the window. */
export async function withRenderWindow<T>(
  render: PrintRender,
  fn: (win: BrowserWindow) => Promise<T>,
  opts: { offscreen?: boolean } = {}
): Promise<T> {
  const size = render.window ? { width: clampWin(render.window.width), height: clampWin(render.window.height), useContentSize: true } : {}
  const win = new BrowserWindow({ show: false, ...size, webPreferences: { offscreen: opts.offscreen !== false } })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(render.html)}`)
    if (render.settle?.fonts) {
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true).catch(() => true)
    }
    if (render.settle?.ms) await new Promise((r) => setTimeout(r, render.settle!.ms))
    return await fn(win)
  } finally {
    win.destroy()
  }
}

/** The PDF bytes of a render, exactly as Download ▸ PDF writes them. */
export function renderToPdf(render: PrintRender): Promise<Buffer> {
  return withRenderWindow(render, (win) => win.webContents.printToPDF(render.pdf))
}

/** True when every printToPDF margin is zero (a full-bleed page: a slide, a design, a diagram, a Cells page). */
function zeroMargins(pdf: PrintToPDFOptions): boolean {
  const m = pdf.margins as { top?: number; right?: number; bottom?: number; left?: number } | undefined
  if (!m) return !!pdf.preferCSSPageSize
  return [m.top, m.right, m.bottom, m.left].every((v) => !v)
}

/**
 * The print() options for a render: the PDF export's page, as the print dialog
 * takes it. A named size (A4, Letter) and the orientation pass straight through;
 * a custom size is the render's CSS @page; zero margins are 'none', and real
 * margins are the render's own @page margins ('default' honours them).
 */
export function printOptionsFor(render: PrintRender): WebContentsPrintOptions {
  const o: WebContentsPrintOptions = {
    silent: false,
    printBackground: render.pdf.printBackground !== false,
    landscape: !!render.pdf.landscape,
    margins: { marginType: zeroMargins(render.pdf) ? 'none' : 'default' }
  }
  if (typeof render.pdf.pageSize === 'string') o.pageSize = render.pdf.pageSize as WebContentsPrintOptions['pageSize']
  return o
}

// ── Cells ─────────────────────────────────────────────────────────────────────

/** Cells' render: the active tab paged over-then-down on the locale's paper, gridlines as the sheet sets them. */
export function sheetPrintRender(sheet: SheetPrintModel, paper: Paper): PrintRender {
  const g = paperGeometry(paper)
  return {
    html: sheetPrintHtml(sheet, g),
    window: { width: g.width, height: g.height },
    pdf: { printBackground: true, pageSize: g.name, landscape: false, margins: { top: 0, right: 0, bottom: 0, left: 0 } }
  }
}

// ── The dialog ────────────────────────────────────────────────────────────────

export interface CapturedPrintJob {
  app: PrintRequest['app']
  title: string
  options: WebContentsPrintOptions
  /** The PDF of the same window print() would have printed, base64. */
  pdfBase64: string
}

const captureMode = (): boolean => process.env.NODE_ENV === 'test' && process.env.PLEXI_PRINT_CAPTURE === '1'

/** Print a render through the system dialog (or, under the e2e seam, record the job). */
export async function printRender(render: PrintRender, meta: { app: PrintRequest['app']; title: string }): Promise<PrintResult> {
  const options = printOptionsFor(render)
  try {
    // A hidden window, not an offscreen one: print() needs a real window to
    // print from. Its content is the same HTML at the same size.
    return await withRenderWindow(
      render,
      async (win) => {
        if (captureMode()) {
          const pdf = await win.webContents.printToPDF(render.pdf)
          const jobs = ((globalThis as { __plexiiPrintJobs?: CapturedPrintJob[] }).__plexiiPrintJobs ??= [])
          jobs.push({ app: meta.app, title: meta.title, options, pdfBase64: Buffer.from(pdf).toString('base64') })
          return { ok: true }
        }
        return await new Promise<PrintResult>((resolve) => {
          win.webContents.print(options, (success, failureReason) => {
            if (success) resolve({ ok: true })
            // Chromium reports a dismissed dialog as a failure named "Print job canceled".
            else if (/cancel/i.test(failureReason ?? '')) resolve({ ok: false, cancelled: true })
            else resolve({ ok: false, error: `Could not print: ${failureReason || 'the printer refused the job'}` })
          })
        })
      },
      { offscreen: false }
    )
  } catch (e) {
    return { ok: false, error: `Could not print: ${(e as Error).message}` }
  }
}
