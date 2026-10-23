// @vitest-environment node
// Everything on a PlexiiCells tab reaches the paper, drawn by the code that
// draws it on screen, or marked where it cannot be; never silently dropped.
// Repeat rows, conditional colour scales / data bars / icon sets, sparklines,
// charts, pivot tables and placed work widgets.
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { paginateSheet, paperGeometry, printableSize, sheetPrintHtml } from '../../src/shared/sheetPrint'
import { sheetPrintModel, parseRowRange, SHEET_DEFAULT_ROW_H } from '../../src/renderer/src/lib/sheetPrintModel'
import {
  setRepeatRows,
  remapRepeatRows,
  remapTabPageSetup,
  remapTabPrintArea,
  rowsToA1
} from '../../src/renderer/src/lib/sheetPageSetup'
import { colorScaleColor, dataBarPct, iconForValue } from '../../src/renderer/src/lib/sheetCond'
import { SparklineCell, ROW_HEADER_W, HEADER_H } from '../../src/renderer/src/components/documents/sheet/SheetGrid'
import type { SheetBodyV2, SheetCondRule, SheetTab } from '../../src/shared/types'

const A4 = paperGeometry('a4')
const tab = (rows: string[][], extra: Partial<SheetTab> = {}): SheetTab => {
  const n = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return { id: 't1', name: 'Sheet 1', columns: Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)), rows, ...extra }
}
const body = (t: SheetTab): SheetBodyV2 => ({ version: 2, sheets: [t], activeSheet: 0 })
const pages = (html: string): string[] => html.split('<section class="page"').slice(1)

describe('repeat rows', () => {
  const rows = [['Item', 'Cost'], ...Array.from({ length: 120 }, (_, i) => [`Line ${i + 1}`, String(i)])]

  it('print at the top of every page, once, and the pages make room for them', () => {
    const b = setRepeatRows(body(tab(rows)), 0, '1:1')
    expect(b.sheets[0].repeatRows).toBe('1:1')
    const m = sheetPrintModel(b)
    expect(m.repeatRows).toEqual([{ r: 0, h: SHEET_DEFAULT_ROW_H }])
    expect(m.rows.some((r) => r.r === 0)).toBe(false)
    const html = sheetPrintHtml(m, A4)
    const ps = pages(html)
    const perPage = Math.floor((printableSize(A4).height - SHEET_DEFAULT_ROW_H) / SHEET_DEFAULT_ROW_H)
    expect(paginateSheet(m, A4)[0].rows).toEqual({ start: 0, end: perPage - 1 })
    expect(ps.length).toBe(Math.ceil(120 / perPage))
    for (const p of ps) {
      expect(p.match(/data-cell="0,0"/g)?.length, 'header once per page').toBe(1)
      expect(p.indexOf('data-cell="0,0"')).toBeLessThan(p.indexOf('data-cell="', p.indexOf('data-cell="0,1"') + 1))
    }
  })

  it('absent means none', () => {
    const m = sheetPrintModel(body(tab(rows)))
    expect(m.repeatRows).toBeUndefined()
    expect(pages(sheetPrintHtml(m, A4))[1]).not.toContain('data-cell="0,0"')
  })

  it('set from A1 text or the selection; null clears it; nonsense is refused', () => {
    const b0 = body(tab(rows))
    expect(setRepeatRows(b0, 0, '$1:$2').sheets[0].repeatRows).toBe('1:2')
    expect(setRepeatRows(b0, 0, { r1: 2, r2: 0 }).sheets[0].repeatRows).toBe('1:3')
    expect(setRepeatRows(b0, 0, 'A1:B2')).toBe(b0)
    expect('repeatRows' in setRepeatRows(setRepeatRows(b0, 0, '1'), 0, null).sheets[0]).toBe(false)
    expect(parseRowRange('3')).toEqual({ r1: 2, r2: 2 })
    expect(rowsToA1({ r1: 0, r2: 0 })).toBe('1:1')
  })

  it('move with structural edits (the fixFormulas maps), and clear when every row is deleted', () => {
    const insertRow = (at: number) => (r: number) => (r >= at ? r + 1 : r)
    const deleteRow = (at: number) => (r: number) => (r === at ? null : r > at ? r - 1 : r)
    const id = (i: number) => i
    expect(remapRepeatRows('1:2', insertRow(0))).toBe('2:3')
    expect(remapRepeatRows('1:2', deleteRow(0))).toBe('1:1')
    expect(remapRepeatRows('1:1', deleteRow(0))).toBeUndefined()
    const t = tab([['a']], { printArea: 'B2:F30', repeatRows: '1:1' })
    const moved = remapTabPageSetup(t, insertRow(0), id)
    expect([moved.printArea, moved.repeatRows]).toEqual(['B3:F31', '2:2'])
    expect('repeatRows' in remapTabPageSetup(tab([['a']], { repeatRows: '1:1' }), deleteRow(0), id)).toBe(false)
    // The name ec already wired is the same function.
    expect(remapTabPrintArea).toBe(remapTabPageSetup)
  })
})

describe('conditional formats print as the grid draws them', () => {
  const vals = ['10', '20', '30', '40']
  const rule = (extra: Partial<SheetCondRule>): SheetCondRule => ({ id: 'r', range: 'A1:A4', op: 'gt', ...extra }) as SheetCondRule

  it('colour scale: the cell fill is colorScaleColor of its value', () => {
    const r = rule({ kind: 'colorScale', minColor: '#ffffff', maxColor: '#ff0000' })
    const m = sheetPrintModel(body(tab(vals.map((v) => [v]), { condRules: [r] })))
    vals.forEach((v, i) => expect(m.cells[`${i},0`].bg).toBe(colorScaleColor(r, Number(v), 10, 40)))
  })

  it('data bar: the same proportion and colour, drawn behind the value', () => {
    const r = rule({ kind: 'dataBar', barColor: '#3366ff' })
    const m = sheetPrintModel(body(tab(vals.map((v) => [v]), { condRules: [r] })))
    expect(m.cells['2,0'].bar).toEqual({ pct: dataBarPct(30, 10, 40), color: '#3366ff' })
    expect(sheetPrintHtml(m, A4)).toContain(`class="bar" style="width:${Math.round(dataBarPct(30, 10, 40) * 100)}%;background:#3366ff"`)
  })

  it('icon set: the same icon before the value', () => {
    const r = rule({ kind: 'iconSet', iconSet: 'arrows' })
    const m = sheetPrintModel(body(tab(vals.map((v) => [v]), { condRules: [r] })))
    const want = iconForValue(r, 40, 10, 40)!
    expect(m.cells['3,0'].icon).toEqual(want)
    expect(sheetPrintHtml(m, A4)).toContain(`class="icon" style="color:${want.color}">${want.char}</span>`)
  })
})

describe('sparklines print as the grid draws them', () => {
  it('a =SPARKLINE cell is the grid’s own SparklineCell markup', () => {
    const t = tab([['1', '5', '3', '8', '=SPARKLINE(A1:D1)']], { colWidths: { 4: 120 } })
    const m = sheetPrintModel(body(t))
    const cell = m.cells['0,4']
    expect(cell.text).toBe('')
    const want = renderToStaticMarkup(createElement(SparklineCell, { r: 0, c: 4, values: [1, 5, 3, 8], type: 'line', width: 104 }))
    expect(cell.svg).toBe(want)
    expect(sheetPrintHtml(m, A4)).toContain(want)
  })
})

describe('charts and pivot tables print after the cells', () => {
  const data = [['Region', 'Sales'], ['North', '10'], ['South', '20'], ['North', '5']]

  it('a chart prints the drawing the editor made', () => {
    const t = tab(data, { charts: [{ id: 'ch1', type: 'bar', range: 'A1:B4', title: 'Sales by region', headerRow: true }] })
    const html = '<div class="recharts-wrapper"><svg data-drawn="1"></svg></div>'
    const m = sheetPrintModel(body(t), undefined, { chartSnapshots: { ch1: { html, w: 500, h: 240 } } })
    expect(m.blocks).toEqual([{ label: 'Sales by region', html, w: 500, h: 240 }])
    const out = sheetPrintHtml(m, A4)
    expect(pages(out)).toHaveLength(2)
    expect(pages(out)[1]).toContain('<svg data-drawn="1">')
    expect(pages(out)[1]).toContain('<figcaption>Sales by region</figcaption>')
  })

  it('a chart the editor has not drawn prints as a marked placeholder, never as nothing', () => {
    const t = tab(data, { charts: [{ id: 'ch1', type: 'line', range: 'A1:B4' }] })
    const m = sheetPrintModel(body(t))
    expect(m.blocks![0].label).toBe('Line chart · chart not on screen, not printed')
    expect(sheetPrintHtml(m, A4)).toMatch(/<div class="ph"[^>]*><span>Line chart · chart not on screen, not printed<\/span>/)
  })

  it('a pivot table prints computePivot’s result in the table’s own number format', () => {
    const t = tab(data, { pivots: [{ id: 'p1', range: 'A1:B4', rowField: 0, valueField: 1, agg: 'sum', title: 'Sales pivot' }] })
    const m = sheetPrintModel(body(t))
    const b = m.blocks![0]
    expect(b.label).toBe('Sales pivot')
    expect(b.html).toContain('<td>North</td><td class="n b">15</td>')
    expect(b.html).toContain('<td>South</td><td class="n b">20</td>')
    expect(b.html).toContain('<td>Grand total</td><td class="n b">35</td>')
  })
})

describe('placed work widgets print as named boxes at their spot', () => {
  const grid = Array.from({ length: 10 }, () => Array.from({ length: 6 }, () => 'x'))

  it('an anchored widget sits on its cell, named, marked as not printed', () => {
    const t = tab(grid, { widgets: [{ id: 'pl1', widgetId: 'w-1', mode: 'cell', r: 2, c: 1, w: 200, h: 120 }] })
    const m = sheetPrintModel(body(t), undefined, { widgetNames: { 'w-1': 'Pipeline' } })
    expect(m.overlays).toEqual([{ x: 64, y: 40, w: 200, h: 120, label: 'Pipeline · live work widget, not printed' }])
    const html = sheetPrintHtml(m, A4)
    expect(html).toContain('data-overlay="Pipeline · live work widget, not printed" style="left:64px;top:40px;width:200px;height:120px"')
    expect(html).toContain('<span>Pipeline · live work widget, not printed</span>')
  })

  it('a floating widget maps from the editor surface (headers included) to printed space', () => {
    const t = tab(grid, { widgets: [{ id: 'pl2', widgetId: 'wf:file-9', mode: 'float', x: ROW_HEADER_W + 64 * 2 + 10, y: HEADER_H + 20 * 3 + 5, w: 100, h: 60 }] })
    const m = sheetPrintModel(body(t))
    expect(m.overlays![0]).toMatchObject({ x: 138, y: 65, label: 'Work widget · live work widget, not printed' })
  })

  it('a widget whose spot is outside the print area is outside the print', () => {
    const t = tab(grid, { printArea: 'A1:B2', widgets: [{ id: 'pl3', widgetId: 'w-1', mode: 'cell', r: 8, c: 4, w: 50, h: 50 }] })
    expect(sheetPrintModel(body(t)).overlays).toBeUndefined()
  })
})
