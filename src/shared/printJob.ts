// What Print… sends to main: per app, the SAME input that app's Download ▸ PDF
// sends, so main builds the same render (src/main/printRender.ts) and the paper
// matches the PDF the user already knows. Write's page view with its page setup,
// Deck one slide per page, Design every page at its own size, Diagrams the page
// fitted to the paper, Cells the active tab paged over-then-down.

import type { DesignBody } from './design'
import type { MapBody, SlidesBody } from './types'
import type { Paper, SheetPrintModel } from './sheetPrint'

/** Write's page setup, exactly as officeDocx.exportPdf takes it (PageSetupInput). */
export interface PrintPageSetup {
  size: 'letter' | 'a4'
  orientation: 'portrait' | 'landscape'
  margin: { top: number; right: number; bottom: number; left: number }
  header?: { text?: string; showPageNumber?: boolean }
  footer?: { text?: string; showPageNumber?: boolean }
}

export type PrintRequest =
  | { app: 'write'; title: string; html: string; page?: PrintPageSetup }
  | { app: 'deck'; title: string; body: SlidesBody }
  | { app: 'design'; title: string; design: DesignBody }
  | { app: 'diagram'; title: string; map: MapBody }
  | { app: 'cells'; title: string; sheet: SheetPrintModel; paper: Paper }

export type PrintApp = PrintRequest['app']

export interface PrintResult {
  ok: boolean
  /** The person closed the print dialog without printing. Not an error. */
  cancelled?: boolean
  error?: string
}

/** Cells' Download ▸ PDF: the same model and paper as its print. */
export interface SheetPdfRequest {
  title: string
  sheet: SheetPrintModel
  paper: Paper
}

/** True for a value that has the shape of a PrintRequest (main checks before rendering). */
export function isPrintRequest(v: unknown): v is PrintRequest {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  if (typeof r.title !== 'string') return false
  switch (r.app) {
    case 'write':
      return typeof r.html === 'string'
    case 'deck':
      return !!r.body && typeof r.body === 'object'
    case 'design':
      return !!r.design && typeof r.design === 'object'
    case 'diagram':
      return !!r.map && typeof r.map === 'object'
    case 'cells':
      return !!r.sheet && typeof r.sheet === 'object' && (r.paper === 'a4' || r.paper === 'letter')
    default:
      return false
  }
}
