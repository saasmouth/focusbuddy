// Small REAL workbooks for the .xlsx drop tests, made at test time: SheetJS
// writes the structure (sheets, formulas with cached values, a merge, a number
// format, column widths), exceljs writes what SheetJS's community build cannot
// (bold, italic, alignment, a comment, a picture, conditional formatting, data
// validation), and fflate adds the parts neither writes (a chart, a pivot
// table, a macro project) to a real package, wired by relationships exactly as
// Excel wires them.

import * as XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'

/** Budget (first) with Rates and Notes after it. */
export function budgetWorkbook(): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Item', 'Qty', 'Price', 'Total', 'Rate'],
    ['Pens', 2, 1.5, null, null],
    ['Pads', 4, 2.25, null, null],
    [null, null, null, null, null],
    ['Total', null, null, null, null]
  ])
  ws['D2'] = { t: 'n', f: 'B2*C2', v: 3 }
  ws['D3'] = { t: 'n', f: 'B3*C3', v: 9 }
  ws['D5'] = { t: 'n', f: 'SUM(D2:D3)', v: 12 }
  // Reads another sheet: Excel saved 0.1 for it.
  ws['E2'] = { t: 'n', f: 'Rates!A1', v: 0.1 }
  ws['C2'].z = '"$"#,##0.00'
  ws['C3'].z = '"$"#,##0.00'
  ws['!merges'] = [XLSX.utils.decode_range('A5:C5')]
  ws['!cols'] = [{ wch: 20 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Budget')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[0.1]]), 'Rates')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Draft']]), 'Notes')
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
}

/** One sheet, one cell: nothing in it the drop leaves out. */
export function plainWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Score'], ['Ada', 9]]), 'Scores')
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
}

/** 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** exceljs: bold heading, italic, centred, a comment, a picture, conditional formatting, data validation. */
export async function styledWorkbook(opts: { comment?: boolean; picture?: boolean; condFormat?: boolean; validation?: boolean } = {}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Report')
  ws.addRow(['Region', 'Sales'])
  ws.addRow(['North', 120])
  ws.addRow(['South', 80])
  ws.getCell('A1').font = { bold: true }
  ws.getCell('B1').font = { bold: true, italic: true }
  ws.getCell('B1').alignment = { horizontal: 'center' }
  ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
  if (opts.comment) ws.getCell('A2').note = 'Check this'
  if (opts.picture) {
    const id = wb.addImage({ buffer: PNG as unknown as ExcelJS.Buffer, extension: 'png' })
    ws.addImage(id, { tl: { col: 3, row: 1 }, ext: { width: 10, height: 10 } })
  }
  if (opts.condFormat) {
    ws.addConditionalFormatting({ ref: 'B2:B3', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: ['100'], priority: 1, style: { font: { bold: true } } }] })
  }
  if (opts.validation) ws.getCell('B2').dataValidation = { type: 'whole', operator: 'greaterThan', formulae: [0], allowBlank: true }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

/** Add parts to a real package and wire them to its first sheet. */
function withParts(bytes: Uint8Array, edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(bytes) as Record<string, Uint8Array>
  edit(files)
  return zipSync(files)
}

function addSheetRel(files: Record<string, Uint8Array>, id: string, type: string, target: string): void {
  const key = 'xl/worksheets/_rels/sheet1.xml.rels'
  const rel = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
  const xml = files[key]
    ? strFromU8(files[key]).replace('</Relationships>', `${rel}</Relationships>`)
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`
  files[key] = strToU8(xml)
}

/** A chart on the first sheet: sheet → drawing → chart, as Excel wires it. */
export function withChart(bytes: Uint8Array): Uint8Array {
  return withParts(bytes, (files) => {
    addSheetRel(files, 'rIdChart', 'drawing', '../drawings/drawing9.xml')
    files['xl/drawings/drawing9.xml'] = strToU8('<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor><xdr:graphicFrame/></xdr:twoCellAnchor></xdr:wsDr>')
    files['xl/drawings/_rels/drawing9.xml.rels'] = strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>'
    )
    files['xl/charts/chart1.xml'] = strToU8('<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>')
  })
}

/** A pivot table on the first sheet. */
export function withPivot(bytes: Uint8Array): Uint8Array {
  return withParts(bytes, (files) => {
    addSheetRel(files, 'rIdPivot', 'pivotTable', '../pivotTables/pivotTable1.xml')
    files['xl/pivotTables/pivotTable1.xml'] = strToU8('<?xml version="1.0"?><pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="P1"/>')
  })
}

/** A macro project, as an .xlsm carries it. */
export function withMacros(bytes: Uint8Array): Uint8Array {
  return withParts(bytes, (files) => {
    files['xl/vbaProject.bin'] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
  })
}

/**
 * What a password-protected workbook IS on disk: not a zip but a compound file
 * whose directory names an EncryptedPackage stream (and EncryptionInfo). The
 * header and the UTF-16LE directory names are the real format's; the streams
 * themselves are empty, which is all a reader needs to see to refuse it.
 */
export function encryptedWorkbook(): Uint8Array {
  const out = new Uint8Array(4096)
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
  const name = (s: string, at: number): void => {
    for (let i = 0; i < s.length; i++) out[at + i * 2] = s.charCodeAt(i)
  }
  name('Root Entry', 512)
  name('EncryptionInfo', 640)
  name('EncryptedPackage', 768)
  return out
}
