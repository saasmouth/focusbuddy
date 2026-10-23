// An Excel workbook dropped out of Files, read in the main process
// (main/sheetXlsxRead.ts, `files:readSheet`) as the first sheet's snippet body.
// Every workbook here is a REAL one, written at test time (xlsxDropFixtures).

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { sheetFromXlsxBytes, readXlsxSheetForDrop } from '../../src/main/sheetXlsxRead'
import { L, firstSheetOf } from '../../src/shared/snippetForms/lossy'
import { XLSX_DROP_MAX_BYTES, XLSX_REASON, workbookTooLarge } from '../../src/shared/xlsxSheet'
import { budgetWorkbook, encryptedWorkbook, plainWorkbook, styledWorkbook, withChart, withMacros, withPivot } from './xlsxDropFixtures'

const files = vi.hoisted(() => ({
  rows: new Map<string, { id: string; ext: string; sizeBytes: number; mimeType: string }>(),
  bytes: new Map<string, Uint8Array>(),
  reads: [] as string[]
}))

vi.mock('../../src/main/db/files', () => ({
  getFile: (id: string) => files.rows.get(id) ?? null,
  readFileBytes: async (id: string) => {
    files.reads.push(id)
    const b = files.bytes.get(id)
    return b ? { mimeType: files.rows.get(id)?.mimeType ?? '', bytes: b } : null
  }
}))

function ok(r: ReturnType<typeof sheetFromXlsxBytes>): Extract<ReturnType<typeof sheetFromXlsxBytes>, { ok: true }> {
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  return r
}

describe('sheetFromXlsxBytes: the first sheet as a sheet snippet body', () => {
  it('keeps values, live formulas, the number format, the merge and the column width', () => {
    const r = ok(sheetFromXlsxBytes(budgetWorkbook()))
    expect(r.sheetName).toBe('Budget')
    expect(r.body.kind).toBe('sheet')
    expect(r.body.origin).toEqual({ r: 0, c: 0 })
    expect(r.body.rows[0]).toEqual(['Item', 'Qty', 'Price', 'Total', 'Rate'])
    // Formulas stay live, as PlexiiCells' Import keeps them.
    expect(r.body.rows[1]![3]).toBe('=B2*C2')
    expect(r.body.rows[4]![3]).toBe('=SUM(D2:D3)')
    // A currency cell keeps its TRUE value; the format shows it.
    expect(r.body.rows[1]![2]).toBe('1.5')
    expect((r.body.formats as Record<string, { numFmt?: unknown }>)['1,2']?.numFmt).toMatchObject({ kind: 'currency', decimals: 2 })
    expect(r.body.merges).toEqual([{ r1: 4, c1: 0, r2: 4, c2: 2 }])
    expect(r.body.colWidths?.[0]).toBe(140)
  })

  it('a formula that reads another sheet keeps the value Excel saved, and says so', () => {
    const r = ok(sheetFromXlsxBytes(budgetWorkbook()))
    expect(r.body.rows[1]![4]).toBe('0.1')
    expect(r.notes).toContain(L.otherSheetFormulas)
  })

  it('says "First sheet of N." when there are more sheets, and nothing it did not find', () => {
    const r = ok(sheetFromXlsxBytes(budgetWorkbook()))
    expect(r.notes).toEqual([firstSheetOf(3), L.otherSheetFormulas])
    expect(firstSheetOf(3)).toBe('First sheet of 3.')
    expect(ok(sheetFromXlsxBytes(plainWorkbook())).notes).toEqual([])
  })

  it('keeps bold, italic, alignment and a fill colour (styles SheetJS does not read)', async () => {
    const r = ok(sheetFromXlsxBytes(await styledWorkbook()))
    const f = r.body.formats as Record<string, Record<string, unknown>>
    expect(f['0,0']).toMatchObject({ bold: true })
    expect(f['0,1']).toMatchObject({ bold: true, italic: true, align: 'center' })
    expect(f['1,0']).toMatchObject({ bg: '#ffff00' })
    expect(f['1,1']).toBeUndefined()
    expect(r.notes).toEqual([])
  })

  it('names each thing it leaves out, only when the workbook has it', async () => {
    expect(ok(sheetFromXlsxBytes(await styledWorkbook({ comment: true }))).notes).toEqual([L.comments])
    expect(ok(sheetFromXlsxBytes(await styledWorkbook({ picture: true }))).notes).toEqual([L.pictures])
    expect(ok(sheetFromXlsxBytes(await styledWorkbook({ condFormat: true }))).notes).toEqual([L.conditionalFormatting])
    expect(ok(sheetFromXlsxBytes(await styledWorkbook({ validation: true }))).notes).toEqual([L.validation])
    expect(ok(sheetFromXlsxBytes(withChart(plainWorkbook()))).notes).toEqual([L.charts])
    expect(ok(sheetFromXlsxBytes(withPivot(plainWorkbook()))).notes).toEqual([L.pivotTables])
    expect(ok(sheetFromXlsxBytes(withMacros(plainWorkbook()))).notes).toEqual([L.macros])
  })

  it('refuses a password-protected workbook, plainly', () => {
    const r = sheetFromXlsxBytes(encryptedWorkbook())
    expect(r).toEqual({ ok: false, code: 'protected', reason: XLSX_REASON.protected })
  })

  it('refuses a damaged file or one that is not a workbook (never a blank or a crash)', () => {
    const notZip = sheetFromXlsxBytes(strToU8('Item,Qty\nPens,2\n'))
    expect(notZip).toEqual({ ok: false, code: 'unreadable', reason: XLSX_REASON.unreadable })
    const good = budgetWorkbook()
    const cut = sheetFromXlsxBytes(good.slice(0, Math.floor(good.length / 2)))
    expect(cut).toMatchObject({ ok: false, code: 'unreadable' })
    const otherZip = sheetFromXlsxBytes(zipSync({ 'readme.txt': strToU8('hello') }))
    expect(otherZip).toMatchObject({ ok: false, code: 'unreadable' })
  })

  it('refuses an empty first sheet', async () => {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Two')
    const r = sheetFromXlsxBytes(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })))
    expect(r).toEqual({ ok: false, code: 'empty', reason: XLSX_REASON.empty })
  })

  it('reads the used range, not a dimension that runs to the last formatted row', async () => {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([['a']], { origin: 'C3' })
    ws['!ref'] = 'A1:Z1048576'
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Wide')
    const r = ok(sheetFromXlsxBytes(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))))
    expect(r.body.rows).toEqual([['a']])
    expect(r.body.origin).toEqual({ r: 2, c: 2 })
  })

  it('refuses a sheet past the cell cap, saying how many', async () => {
    const XLSX = await import('xlsx')
    const ws: Record<string, unknown> = { A1: { t: 's', v: 'top' }, CV1001: { t: 's', v: 'far' }, '!ref': 'A1:CV1001' }
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws as never, 'Big')
    const r = sheetFromXlsxBytes(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })))
    expect(r).toEqual({ ok: false, code: 'too-large', reason: 'The first sheet has 100,100 cells. Up to 100,000 can be dropped in as a table.' })
  })
})

describe('readXlsxSheetForDrop (files:readSheet): checks in main, never trusting the renderer', () => {
  beforeEach(() => {
    files.rows.clear()
    files.bytes.clear()
    files.reads.length = 0
  })

  it('reads a Files item by id', async () => {
    files.rows.set('f1', { id: 'f1', ext: 'xlsx', sizeBytes: 9000, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    files.bytes.set('f1', budgetWorkbook())
    const r = await readXlsxSheetForDrop('f1')
    expect(r.ok && r.body.rows[0]).toEqual(['Item', 'Qty', 'Price', 'Total', 'Rate'])
  })

  it('refuses a bad id, an unknown file and a file that is not a workbook by its own row', async () => {
    expect(await readXlsxSheetForDrop(42)).toMatchObject({ ok: false, code: 'missing' })
    expect(await readXlsxSheetForDrop('../../etc/passwd')).toMatchObject({ ok: false, code: 'missing' })
    expect(await readXlsxSheetForDrop('x'.repeat(300))).toMatchObject({ ok: false, code: 'missing' })
    files.rows.set('png', { id: 'png', ext: 'png', sizeBytes: 10, mimeType: 'image/png' })
    files.bytes.set('png', budgetWorkbook())
    expect(await readXlsxSheetForDrop('png')).toMatchObject({ ok: false, code: 'unreadable' })
    expect(files.reads).toEqual([])
  })

  it('refuses a workbook over the cap WITHOUT reading it', async () => {
    const size = XLSX_DROP_MAX_BYTES + 1
    files.rows.set('big', { id: 'big', ext: 'xlsx', sizeBytes: size, mimeType: '' })
    files.bytes.set('big', budgetWorkbook())
    expect(await readXlsxSheetForDrop('big')).toEqual({ ok: false, code: 'too-large', reason: workbookTooLarge(size) })
    expect(workbookTooLarge(48 * 1024 * 1024)).toBe('This workbook is 48 MB. Workbooks up to 10 MB can be dropped in as a table.')
    expect(files.reads).toEqual([])
  })

  it('says when the contents are not on this device', async () => {
    files.rows.set('away', { id: 'away', ext: 'xlsm', sizeBytes: 100, mimeType: '' })
    expect(await readXlsxSheetForDrop('away')).toEqual({ ok: false, code: 'bytes', reason: XLSX_REASON.bytes })
  })
})
