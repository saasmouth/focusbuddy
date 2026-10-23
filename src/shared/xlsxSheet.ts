// An Excel workbook (.xlsx, .xlsm) dropped out of Files, read as a sheet
// snippet body. The reading happens in the main process (main/sheetXlsxRead.ts,
// over SheetJS, behind `files:readSheet`); this is the shape it answers with and
// the sentences both sides say, so the drop reader (renderer/src/lib/
// filesDragForms.ts) and the pure forms (shared/fileForms.ts) agree with it.
//
// Every line is plain, British, with no em dashes.

import type { SheetSnippetBody } from './snippets'

/** The largest workbook read for a drop. Larger ones are refused, or added as a link where links are held. */
export const XLSX_DROP_MAX_BYTES = 10 * 1024 * 1024
/** The most cells (rows × columns of the first sheet's used range) a drop takes as a table. */
export const XLSX_DROP_MAX_CELLS = 100_000
/** The most a package may unpack to: a small file that inflates past this is refused, never read. */
export const XLSX_DROP_MAX_UNPACKED_BYTES = 200 * 1024 * 1024

export type XlsxSheetRead =
  | {
      ok: true
      /** The first sheet's used range, as PlexiiCells' own snippet body (formulas as written, origin set). */
      body: SheetSnippetBody
      /** The sheet's name in the workbook. */
      sheetName: string
      /** What the workbook has that the body does not keep (shared/snippetForms/lossy.ts). Only what was found. */
      notes: string[]
    }
  | {
      ok: false
      /**
       * missing    the file is not in Files (any more)
       * bytes      its row is here but its contents are not on this device yet
       * too-large  over XLSX_DROP_MAX_BYTES, the cell cap or the unpacked cap
       * protected  password-protected (an encrypted package)
       * unreadable not an Excel workbook, or a damaged one
       * empty      the first sheet holds nothing
       */
      code: 'missing' | 'bytes' | 'too-large' | 'protected' | 'unreadable' | 'empty'
      /** Said verbatim. */
      reason: string
    }

export const XLSX_REASON = {
  missing: 'This file is no longer in Files.',
  protected: 'This workbook is password-protected, so it cannot be read. Remove the password in Excel and drop it again.',
  unreadable: 'This file could not be read as an Excel workbook. It may be damaged.',
  empty: 'The first sheet of this workbook is empty, so there is nothing to insert.',
  bytes: "This file's contents are not on this device yet."
} as const

function mb(n: number): string {
  const v = n / (1024 * 1024)
  return v >= 10 ? `${Math.round(v)} MB` : `${Math.round(v * 10) / 10} MB`
}

/** "This workbook is 48 MB. Workbooks up to 10 MB can be dropped in as a table." */
export function workbookTooLarge(bytes: number): string {
  return `This workbook is ${mb(bytes)}. Workbooks up to ${mb(XLSX_DROP_MAX_BYTES)} can be dropped in as a table.`
}

/** "The first sheet has 250,000 cells. Up to 100,000 can be dropped in as a table." */
export function sheetTooManyCells(cells: number): string {
  return `The first sheet has ${cells.toLocaleString('en-GB')} cells. Up to ${XLSX_DROP_MAX_CELLS.toLocaleString('en-GB')} can be dropped in as a table.`
}

/** The same workbook as a link, where the target holds links. */
export const NOTICE_WORKBOOK_LINK = 'This workbook is too large to insert as a table, so it was added as a link.'

/** File names and types read as an Excel workbook (never .xls: an older binary format SheetJS reads differently). */
export const XLSX_EXT = new Set(['xlsx', 'xlsm'])
export const XLSX_MIME = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel.sheet.macroenabled.12'])
