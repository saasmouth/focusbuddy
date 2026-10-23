// An Excel workbook dragged out of Files into each office app and the image
// work widget, over the REAL path: a real .xlsx (xlsxDropFixtures) → the main
// process reader (main/sheetXlsxRead.ts, behind files:readSheet, here called
// in-process) → the renderer's drop reader (readFilesDragForms) → each app's
// converted paste (convertClipboard, as pasteConverted runs it) or the image
// work widget's acceptor. Before this, a workbook was a generic file: refused
// by PlexiiDraw, PlexiiDeck and PlexiiDesign ("cannot hold this kind of
// file"), and only a link in PlexiiWrite.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sheetFromXlsxBytes } from '../../src/main/sheetXlsxRead'
import { convertClipboard } from '../../src/renderer/src/lib/clipboardPaste'
import { acceptFor, readDropForms } from '../../src/renderer/src/lib/widgetSnippetInsert'
import { readFilesDragForms } from '../../src/renderer/src/lib/filesDragForms'
import { sourceKindOf, type FileDragRef } from '../../src/shared/filesDragPayload'
import { L, firstSheetOf, tidyNotes } from '../../src/shared/snippetForms/lossy'
import { conversionNotice } from '../../src/shared/snippetConvert'
import { NOTICE_WORKBOOK_LINK, XLSX_REASON, workbookTooLarge } from '../../src/shared/xlsxSheet'
import { NOTICE_BYTES_MISSING } from '../../src/shared/fileForms'
import type { SnippetKind } from '../../src/shared/snippets'
import { budgetWorkbook, encryptedWorkbook, styledWorkbook, withChart } from './xlsxDropFixtures'

vi.mock('../../src/main/db/files', () => ({ getFile: () => null, readFileBytes: async () => null }))

const store = new Map<string, Uint8Array>()
const api = {
  files: {
    readSheet: vi.fn(async (id: string) => {
      const b = store.get(id)
      return b ? sheetFromXlsxBytes(b) : { ok: false, code: 'bytes', reason: XLSX_REASON.bytes }
    }),
    read: vi.fn(async () => null)
  }
}
;(window as unknown as { api: unknown }).api = api

beforeEach(() => {
  store.clear()
  api.files.readSheet.mockClear()
  api.files.read.mockClear()
})

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ref = (id: string, name = 'Budget.xlsx', size = 9000): FileDragRef => ({ entryId: id, kind: 'file', name, mimeType: XLSX_MIME, ext: name.split('.').pop(), sizeBytes: size })

async function dropInto(target: SnippetKind, id = 'wb', alt = false, r: FileDragRef = ref(id)) {
  const read = await readFilesDragForms(r, { target: target as never, alt })
  return { read, out: convertClipboard(read, target) }
}

function landed(out: ReturnType<typeof convertClipboard>): Extract<NonNullable<ReturnType<typeof convertClipboard>>, { ok: true }> {
  if (!out || !out.ok) throw new Error(`not landed: ${out ? out.reason : 'nothing'}`)
  return out
}

describe('a .xlsx in Files is a workbook, not a generic file', () => {
  it('by its name or its type', () => {
    expect(sourceKindOf(ref('a'))).toBe('sheet')
    expect(sourceKindOf({ entryId: 'b', kind: 'file', name: 'Macros.XLSM' })).toBe('sheet')
    expect(sourceKindOf({ entryId: 'c', kind: 'file', name: 'export', mimeType: XLSX_MIME })).toBe('sheet')
    // An older binary .xls is not read this way.
    expect(sourceKindOf({ entryId: 'd', kind: 'file', name: 'old.xls', mimeType: 'application/vnd.ms-excel' })).toBe('generic')
  })
})

describe('a workbook dropped into each office app lands as its first sheet', () => {
  beforeEach(() => store.set('wb', budgetWorkbook()))

  it('PlexiiCells: the range itself, formulas live, formats and the merge kept, and the notes said', async () => {
    const { read, out } = await dropInto('sheet')
    expect(api.files.readSheet).toHaveBeenCalledWith('wb')
    const o = landed(out)
    if (o.body.kind !== 'sheet') throw new Error(o.body.kind)
    expect(o.body.rows[1]).toEqual(['Pens', '2', '1.5', '=B2*C2', '0.1'])
    expect(o.body.rows[4]![3]).toBe('=SUM(D2:D3)')
    expect(o.body.merges).toEqual([{ r1: 4, c1: 0, r2: 4, c2: 2 }])
    expect((o.body.formats as Record<string, { numFmt?: { kind: string } }>)['1,2']?.numFmt?.kind).toBe('currency')
    // Not one of our apps' content, so the notes are said in Cells too.
    expect(read.kind).toBeNull()
    expect(o.notice).toBe(`${firstSheetOf(3)} ${L.otherSheetFormulas}`)
  })

  it('PlexiiWrite: a real table of the values the sheet shows', async () => {
    const o = landed((await dropInto('doc')).out)
    if (o.body.kind !== 'doc') throw new Error(o.body.kind)
    const table = (o.body.content as Array<{ type: string }>).find((n) => n.type === 'table')
    expect(table).toBeTruthy()
    const json = JSON.stringify(table)
    expect(json).toContain('"text":"Pens"')
    // Under its number format, as the grid shows it.
    expect(json).toContain('"text":"$1.50"')
    // The formulas' values (3, 9 and their sum 12), not the formulas.
    expect(json).toContain('"text":"12"')
    expect(json).not.toContain('=SUM')
    expect(o.notice).toContain(firstSheetOf(3))
    expect(o.notice).toContain(L.formulasValues)
  })

  it('PlexiiWrite with ⌥: a link to the file, nothing read', async () => {
    const o = landed((await dropInto('doc', 'wb', true)).out)
    expect(JSON.stringify(o.body)).toContain('plexii://file/wb')
    expect(api.files.readSheet).not.toHaveBeenCalled()
  })

  it.each([['slide' as const], ['design' as const]])('%s: a table element', async (target) => {
    const o = landed((await dropInto(target)).out)
    const els = (o.body as { elements: Array<{ type: string; cells?: string[][]; headerRow?: boolean }> }).elements
    expect(els).toHaveLength(1)
    expect(els[0]!.type).toBe('table')
    expect(els[0]!.cells![0]).toEqual(['Item', 'Qty', 'Price', 'Total', 'Rate'])
    expect(els[0]!.cells![1]).toEqual(['Pens', '2', '$1.50', '3', '0.1'])
    expect(els[0]!.cells![4]![3]).toBe('12')
    expect(els[0]!.headerRow).toBe(true)
    expect(o.notice).toContain(firstSheetOf(3))
    // Only number formats here, and they are kept: no "Cell formatting is not kept."
    expect(o.notice).not.toContain(L.cellFormatting)
  })

  it('PlexiiDraw: a picture of the table, number formats and the merge drawn', async () => {
    const o = landed((await dropInto('draw')).out)
    if (o.body.kind !== 'draw') throw new Error(o.body.kind)
    expect(o.body.objects).toHaveLength(1)
    const node = o.body.objects[0] as { type: string; assetId: string; alt?: string }
    expect(node.type).toBe('image')
    const asset = (o.body.assets as Record<string, { src?: string; dataUrl?: string }>)[node.assetId]!
    const src = String(asset.src ?? asset.dataUrl)
    expect(src).toMatch(/^data:image\/svg\+xml;base64,/)
    const svg = Buffer.from(src.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8')
    expect(svg).toContain('>$1.50<')
    expect(svg).toContain('>12<')
    expect(o.notice).toContain('It becomes a picture: edit it in the original file.')
    expect(o.notice).toContain(firstSheetOf(3))
  })

  it('an image work widget: the same picture (a workbook is a content file, as a .csv is)', async () => {
    for (const alt of [false, true]) {
      const read = await readFilesDragForms(ref('wb'), { target: 'image', alt })
      const r = readDropForms(read)
      const a = acceptFor('image', r.forms, r.ctx) as { ok: boolean; picture?: { svg?: { svg: string; app: string } }; lossy?: string[] }
      expect(a.ok, `⌥ ${alt}`).toBe(true)
      expect(a.picture?.svg?.svg).toContain('>12<')
      expect(a.picture?.svg?.app).toBe('the original file')
      expect(a.lossy).toContain(firstSheetOf(3))
    }
  })
})

describe('one formula note per target, never two saying the same loss', () => {
  beforeEach(() => store.set('wb', budgetWorkbook()))

  it('PlexiiCells keeps formulas live: only the cross-sheet note', async () => {
    const o = landed((await dropInto('sheet')).out)
    expect(o.notice).toContain(L.otherSheetFormulas)
    expect(o.notice).not.toContain(L.formulasValues)
  })

  it.each([['doc' as const], ['slide' as const], ['design' as const], ['draw' as const]])('%s: only "Formulas become their values."', async (target) => {
    const o = landed((await dropInto(target)).out)
    expect(o.notice).toContain(L.formulasValues)
    expect(o.notice).not.toContain(L.otherSheetFormulas)
  })

  it('an image work widget: only "Formulas become their values."', async () => {
    const read = await readFilesDragForms(ref('wb'), { target: 'image' })
    const r = readDropForms(read)
    const a = acceptFor('image', r.forms, r.ctx) as { ok: boolean; lossy?: string[] }
    expect(a.lossy).toContain(L.formulasValues)
    expect(a.lossy).not.toContain(L.otherSheetFormulas)
  })

  it('tidyNotes holds for any combination of notes', () => {
    expect(tidyNotes([L.otherSheetFormulas, firstSheetOf(2), L.formulasValues, L.formulasValues])).toEqual([firstSheetOf(2), L.formulasValues])
    expect(tidyNotes([firstSheetOf(2), L.otherSheetFormulas])).toEqual([firstSheetOf(2), L.otherSheetFormulas])
    expect(conversionNotice(null, 'doc', [L.otherSheetFormulas, L.formulasValues])).toBe(L.formulasValues)
  })
})

describe('what a workbook loses is said, only when it has it', () => {
  it('a chart on the first sheet', async () => {
    store.set('c', withChart(await styledWorkbook()))
    const o = landed((await dropInto('doc', 'c')).out)
    expect(o.notice).toContain(L.charts)
    expect(o.notice).not.toContain('First sheet')
  })

  it('bold and alignment reach PlexiiCells; the picture draws them', async () => {
    store.set('s', await styledWorkbook())
    const o = landed((await dropInto('sheet', 's')).out)
    expect((o.body as { formats?: Record<string, unknown> }).formats?.['0,1']).toMatchObject({ bold: true, italic: true, align: 'center' })
    expect(o.notice).toBeNull()
    const d = landed((await dropInto('draw', 's')).out)
    const asset = Object.values((d.body as { assets: Record<string, { src?: string; dataUrl?: string }> }).assets)[0]!
    const svg = Buffer.from(String(asset.src ?? asset.dataUrl).split(',')[1]!, 'base64').toString('utf8')
    expect(svg).toContain('font-weight="700" font-style="italic" fill="#111827" clip-path="url(#k1-1)">Sales<')
    expect(svg).toContain('fill="#ffff00"')
    // A table in PlexiiWrite cannot hold bold or a fill, and says so.
    const w = landed((await dropInto('doc', 's')).out)
    expect(w.notice).toContain(L.cellFormatting)
  })
})

describe('a workbook that cannot be read is refused with why, never a blank', () => {
  it.each([['sheet' as const], ['doc' as const], ['slide' as const], ['design' as const], ['draw' as const]])('password-protected, into %s', async (target) => {
    store.set('p', encryptedWorkbook())
    const { read, out } = await dropInto(target, 'p')
    expect(read.refused).toBe(XLSX_REASON.protected)
    expect(out).toEqual({ ok: false, reason: XLSX_REASON.protected })
  })

  it('damaged', async () => {
    store.set('d', budgetWorkbook().slice(0, 300))
    const { read } = await dropInto('draw', 'd')
    expect(read.refused).toBe(XLSX_REASON.unreadable)
  })

  it('too large: a link in PlexiiWrite, said so; refused with the size elsewhere; never read', async () => {
    const big = ref('big', 'Huge.xlsx', 48 * 1024 * 1024)
    const w = landed((await dropInto('doc', 'big', false, big)).out)
    expect(JSON.stringify(w.body)).toContain('plexii://file/big')
    expect(w.notice).toBe(NOTICE_WORKBOOK_LINK)
    const { read } = await dropInto('draw', 'big', false, big)
    expect(read.refused).toBe(workbookTooLarge(48 * 1024 * 1024))
    expect(api.files.readSheet).not.toHaveBeenCalled()
  })

  it("contents not on this device: the link, said so, as any file's", async () => {
    const w = landed((await dropInto('doc', 'away')).out)
    expect(JSON.stringify(w.body)).toContain('plexii://file/away')
    expect(w.notice).toBe(NOTICE_BYTES_MISSING)
  })
})
