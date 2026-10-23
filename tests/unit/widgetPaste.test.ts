// ⌘V into work widgets and onto a desk, through the REAL clipboard reader
// (lib/clipboardForms.ts readClipboardForms) with the main-process read
// injected: what the pasteboard holds → forms → the widget's acceptor.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppClipboardRead } from '../../src/shared/appClipboard'
import { acceptForPage, acceptForTable, acceptForTextWidget, planDesk } from '../../src/shared/snippetWidgets'
import { readPasteForms } from '../../src/renderer/src/lib/widgetSnippetInsert'
import { markCellsCopy, resetCellsCopy } from '../../src/renderer/src/lib/clipboardForms'
import { DRAW_CLIPBOARD_KIND } from '../../src/shared/draw/clipboardFormat'

const w = window as unknown as { api?: unknown }
let next: AppClipboardRead = {}
beforeEach(() => {
  w.api = { snippets: { readClipboard: async () => next } }
})
afterEach(() => {
  delete w.api
  resetCellsCopy()
})

const EMPTY = { text: '', html: '', images: [] as File[] }

async function paste(read: AppClipboardRead) {
  next = read
  return readPasteForms(EMPTY)
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`refused: ${(r as unknown as { reason: string }).reason}`)
  return r as Extract<T, { ok: true }>
}

describe('paste on the desk', () => {
  it('plain text becomes a sticky, not a page', async () => {
    const r = await paste({ text: 'Call the bank\nabout fees' })
    expect(ok(planDesk(r.forms, r.ctx))).toMatchObject({ widget: 'sticky', text: 'Call the bank\nabout fees' })
  })

  it('a tab-separated grid becomes a table work widget', async () => {
    const r = await paste({ text: 'Plan\tPrice\nPro\t12' })
    expect(ok(planDesk(r.forms, r.ctx))).toMatchObject({ widget: 'table', rows: [['Plan', 'Price'], ['Pro', '12']], header: true })
  })

  it('a PlexiiCells copy is a sheet body: a table of what the formulas show, the loss named', async () => {
    markCellsCopy('A\tB\n2\t=A2*3', { r: 0, c: 0 })
    const r = await paste({ text: 'A\tB\n2\t=A2*3' })
    expect(r.ctx.body?.kind).toBe('sheet')
    const plan = ok(planDesk(r.forms, r.ctx))
    expect(plan).toMatchObject({ widget: 'table', rows: [['A', 'B'], ['2', '6']] })
    expect(plan.lossy).toContain('Formulas become their values.')
  })

  it('a styled HTML copy becomes a page', async () => {
    const r = await paste({ html: '<h2>Terms</h2><p>Pay <strong>now</strong>.</p>', text: 'Terms\nPay now.' })
    expect(ok(planDesk(r.forms, r.ctx)).widget).toBe('page')
  })

  it('an SVG or a picture becomes an image work widget', async () => {
    const svg = await paste({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>' })
    expect(ok(planDesk(svg.forms, svg.ctx)).widget).toBe('image')
    const png = await paste({ image: { dataUrl: 'data:image/png;base64,AAAA', w: 300, h: 200 } })
    expect(ok(planDesk(png.forms, png.ctx))).toMatchObject({ widget: 'image', width: 300, height: 200 })
  })

  it('a copy from a newer PlexiiDraw is refused, verbatim, and nothing is planned', async () => {
    const r = await paste({ drawNative: JSON.stringify({ kind: DRAW_CLIPBOARD_KIND, version: 99 }) })
    expect(r.refused).toBe('This was copied from a newer PlexiiDraw, which this version cannot read. Update PlexiiDraw to paste it here.')
    expect(r.forms).toEqual([])
  })
})

describe('paste into widgets', () => {
  it('a sticky takes a Cells copy as a pipe table, and refuses a picture in the paste wording', async () => {
    markCellsCopy('Plan\tPrice\nPro\t12', { r: 0, c: 0 })
    const cells = await paste({ text: 'Plan\tPrice\nPro\t12' })
    expect(ok(acceptForTextWidget('sticky', cells.forms, cells.ctx)).text).toBe('| Plan | Price |\n| --- | --- |\n| Pro | 12 |')
    resetCellsCopy()
    const pic = await paste({ image: { dataUrl: 'data:image/png;base64,AAAA', w: 3, h: 2 } })
    const r = acceptForTextWidget('sticky', pic.forms, pic.ctx)
    expect(r).toEqual({ ok: false, reason: 'Stickies hold text. Paste on the desk to add it as an image.' })
  })

  it('a page takes a picture as an image node and a grid as a table node', async () => {
    const pic = await paste({ image: { dataUrl: 'data:image/png;base64,AAAA', w: 3, h: 2 } })
    expect((ok(acceptForPage(pic.forms, pic.ctx)).nodes[0] as { type: string }).type).toBe('image')
    const grid = await paste({ text: 'A\tB\n1\t2' })
    expect((ok(acceptForPage(grid.forms, grid.ctx)).nodes[0] as { type: string }).type).toBe('table')
  })

  it('a table widget takes rows', async () => {
    const r = await paste({ text: 'Name\tQty\nPens\t2' })
    expect(ok(acceptForTable(r.forms, r.ctx))).toMatchObject({ rows: [['Name', 'Qty'], ['Pens', '2']], header: true })
  })

  it('an empty clipboard gives nothing to insert', async () => {
    const r = await paste({})
    expect(r.forms).toEqual([])
  })
})
