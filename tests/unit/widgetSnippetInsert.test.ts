// The renderer's half of content into work widgets and onto a desk: pictures
// stored in the file store, rows written into an fb_table, desk widgets
// created, and pictures round-tripping through the page and markdown editors.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from 'tiptap-markdown'
import type { TableSchema } from '../../src/shared/fields'
import { formsOf } from '../../src/shared/snippetForms'
import { acceptForMarkdown, planDesk } from '../../src/shared/snippetWidgets'
import { dataUrlBytes, markdownRefusesSrc, storeMarkdownPictures, storeNodePictures } from '../../src/renderer/src/lib/widgetPictures'
import { planRowsIntoTable, rowsToGrid, uniqueHeaders } from '../../src/renderer/src/lib/widgetSnippetTable'
import {
  appendRowsToTable,
  isTsvGrid,
  placeDeskPlan,
  spliceText,
  textForms,
  widgetAccepts,
  TABLE_FALLBACK_NOTE
} from '../../src/renderer/src/lib/widgetSnippetInsert'
import { WidgetImage } from '../../src/renderer/src/components/widgets/widgetImage'
import { useTablesStore } from '../../src/renderer/src/stores/tables'
import { useWidgetStore } from '../../src/renderer/src/stores/widgets'
import { useActionHistory } from '../../src/renderer/src/stores/actionHistory'
import * as F from './snippetConvertFixtures'

type Api = { files: { ingestBuffer: ReturnType<typeof vi.fn> } }
const w = window as unknown as { api?: Api }
let ingested: Array<{ originalName: string; mimeType: string; bytes: number }>

beforeEach(() => {
  ingested = []
  w.api = {
    files: {
      ingestBuffer: vi.fn(async (input: { buffer: ArrayBuffer; originalName: string; mimeType: string }) => {
        ingested.push({ originalName: input.originalName, mimeType: input.mimeType, bytes: input.buffer.byteLength })
        return { id: `file-${ingested.length}` }
      })
    }
  }
  useActionHistory.setState({ beginBatch: () => {}, endBatch: () => {} } as never)
})
afterEach(() => {
  delete w.api
})

describe('pictures are stored, not carried inline', () => {
  it('reads base64 and percent-encoded data: URLs', () => {
    expect(dataUrlBytes(F.PNG)?.mime).toBe('image/png')
    const svg = dataUrlBytes(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg>(é)</svg>')}`)
    expect(svg && new TextDecoder().decode(svg.bytes)).toBe('<svg>(é)</svg>')
    expect(dataUrlBytes('https://x')).toBeNull()
  })

  it('markdown refuses an SVG data: URL but takes a PNG one (markdown-it validateLink)', () => {
    expect(markdownRefusesSrc('data:image/svg+xml;base64,AA')).toBe(true)
    expect(markdownRefusesSrc(F.PNG)).toBe(false)
    expect(markdownRefusesSrc('fb-file://abc')).toBe(false)
  })

  it('page nodes: every data: picture becomes fb-file://, nested ones too, the input untouched', async () => {
    const nodes = [{ type: 'paragraph' }, { type: 'blockquote', content: [{ type: 'image', attrs: { src: F.PNG, alt: 'Logo' } }] }]
    const before = JSON.stringify(nodes)
    const out = await storeNodePictures(nodes)
    expect(out.unstored).toBe(0)
    expect(JSON.stringify(out.nodes)).toContain('"src":"fb-file://file-1"')
    expect(JSON.stringify(nodes)).toBe(before)
    expect(ingested).toEqual([{ originalName: 'Logo.png', mimeType: 'image/png', bytes: 70 }])
  })

  it('markdown: a drawing\'s SVG picture is stored and the markdown points at the file', async () => {
    const b = F.draw()
    const r = acceptForMarkdown(formsOf(b, F.DEPS), { body: b, verb: 'insert' })
    if (!r.ok) throw new Error(r.reason)
    const out = await storeMarkdownPictures(r.markdown)
    expect(out).toEqual({ markdown: '![Picture from PlexiiDraw](fb-file://file-1)', failed: 0 })
    expect(ingested[0].mimeType).toBe('image/svg+xml')
    expect(ingested[0].originalName).toBe('Picture from PlexiiDraw.svg')
  })

  it('without a file store, a picture markdown cannot hold is reported, never inserted as text', async () => {
    delete w.api
    const out = await storeMarkdownPictures('![x](data:image/svg+xml;base64,PHN2Zy8+)')
    expect(out.failed).toBe(1)
  })
})

describe('pictures round-trip through the page and markdown editors', () => {
  const mdEditor = (content = ''): Editor =>
    new Editor({
      extensions: [StarterKit.configure({ link: false }), TableKit.configure({ table: { resizable: false } }), WidgetImage, Markdown.configure({ html: true, transformPastedText: true })] as never,
      content
    })

  it('markdown: ![alt](fb-file://…) inserted, read back as an image node, written out again as ![alt](src)', () => {
    const ed = mdEditor('Before')
    ed.commands.focus('end')
    ed.commands.insertContent('![Picture from PlexiiDraw](fb-file://file-1)')
    const json = JSON.stringify(ed.getJSON())
    expect(json).toContain('"type":"image"')
    expect(json).toContain('"src":"fb-file://file-1"')
    const md = (ed.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown()
    expect(md).toContain('![Picture from PlexiiDraw](fb-file://file-1)')
    // And the saved markdown loads back to the same picture.
    const again = mdEditor(md)
    expect(JSON.stringify(again.getJSON())).toContain('"src":"fb-file://file-1"')
    ed.destroy()
    again.destroy()
  })

  it('page: an image node in the stored JSON survives load and save', () => {
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { src: 'fb-file://file-1', alt: 'Logo', title: null, width: 320 } }] }
    const ed = new Editor({ extensions: [StarterKit, TableKit.configure({ table: { resizable: false } }), WidgetImage] as never, content: doc })
    expect(ed.getJSON().content).toEqual([{ type: 'image', attrs: { ...doc.content[0].attrs, height: null } }])
    ed.destroy()
  })

  it('a GFM table inserted into markdown stays a table', () => {
    const ed = mdEditor()
    ed.commands.insertContent('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(JSON.stringify(ed.getJSON())).toContain('"type":"table"')
    ed.destroy()
  })
})

describe('rows into a table work widget', () => {
  const schema: TableSchema = { columns: [{ id: 'c-name', type: 'text-short', label: 'Name', config: {} } as never, { id: 'c-qty', type: 'number', label: 'Qty', config: {} } as never] }

  it('headings made unique and never empty', () => {
    expect(uniqueHeaders(['A', '', 'a', 'A'])).toEqual(['A', 'Column 2', 'a 2', 'A 3'])
  })

  it('with a heading row: matched by name, new columns added, cells coerced', () => {
    const plan = planRowsIntoTable(schema, [['qty', 'Name', 'Note'], ['3', 'Pens', 'blue']], true, (h) => `new-${h}`)
    expect(plan.newColumns.map((c) => c.label)).toEqual(['Note'])
    expect(plan.ops).toEqual([{ op: 'insert', cells: { 'c-qty': 3, 'c-name': 'Pens', 'new-Note': 'blue' } }])
  })

  it('without one: by position, past the end as new columns', () => {
    const g = rowsToGrid(schema, [['Pens', '3', 'x']], false)
    expect(g.headers).toEqual(['Name', 'Qty', 'Column 3'])
    const plan = planRowsIntoTable(schema, [['Pens', '3', 'x']], false, () => 'c-new')
    expect(plan.ops[0]).toEqual({ op: 'insert', cells: { 'c-name': 'Pens', 'c-qty': 3, 'c-new': 'x' } })
  })

  it('appendRowsToTable writes the schema once and every row, through the tables store', async () => {
    const setSchema = vi.fn(async () => {})
    const addRow = vi.fn(async () => ({ id: 'r' }))
    useTablesStore.setState({ tables: { t1: { id: 't1', title: 'T', schema } }, setSchema, addRow } as never)
    const r = await appendRowsToTable('t1', [['Name', 'Qty', 'Price'], ['Pens', '2', '3'], ['Pads', '4', '5']], true)
    expect(r).toEqual({ ok: true, added: 2 })
    expect(setSchema).toHaveBeenCalledTimes(1)
    const cols = (setSchema.mock.calls[0] as unknown as [string, TableSchema])[1].columns.map((c) => c.label)
    expect(cols).toEqual(['Name', 'Qty', 'Price'])
    expect(addRow).toHaveBeenCalledTimes(2)
    expect((addRow.mock.calls[1] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({ 'c-name': 'Pads', 'c-qty': 4 })
  })

  it('declines honestly when the table is not there', async () => {
    useTablesStore.setState({ tables: {}, ensureTableLoaded: async () => null } as never)
    expect(await appendRowsToTable('gone', [['a']], false)).toEqual({ ok: false, reason: 'This table work widget has no table yet. Try again in a moment.' })
  })
})

describe('the desk creates the native widget', () => {
  let created: Array<Record<string, unknown>>
  beforeEach(() => {
    created = []
    useWidgetStore.setState({
      createOptional: vi.fn(async (d: Record<string, unknown>) => {
        created.push(d)
        return { id: `w${created.length}`, ...d }
      })
    } as never)
  })

  it('a Cells block becomes a REAL table work widget with its own table and rows', async () => {
    const createTable = vi.fn(async (d: { schema: TableSchema }) => ({ id: 'tbl-1', title: 'T', schema: d.schema }))
    const addRow = vi.fn(async () => ({ id: 'r' }))
    useTablesStore.setState({ createTable, addRow } as never)
    const s = F.sheet()
    const plan = planDesk(formsOf(s, F.DEPS), { body: s, verb: 'insert' })
    if (!plan.ok) throw new Error(plan.reason)
    const r = await placeDeskPlan(plan, { taskId: 'desk', title: 'Prices', at: () => ({ x: 10, y: 20 }) })
    expect(r.ok).toBe(true)
    expect(created[0]).toMatchObject({ taskId: 'desk', kind: 'table', content: 'tbl-1', x: 10, y: 20, title: 'Prices' })
    expect(createTable.mock.calls[0][0].schema.columns.map((c) => c.label)).toEqual(['Item', 'Qty', 'Price', 'Total'])
    expect(addRow).toHaveBeenCalledTimes(3)
  })

  it('when the table cannot be created it lands as a markdown table and says which', async () => {
    useTablesStore.setState({ createTable: vi.fn(async () => { throw new Error('db') }) } as never)
    const s = F.sheet()
    const plan = planDesk(formsOf(s, F.DEPS), { body: s, verb: 'insert' })
    if (!plan.ok) throw new Error(plan.reason)
    const r = await placeDeskPlan(plan, { taskId: 'desk' })
    expect(created[0]).toMatchObject({ kind: 'markdown' })
    expect(String(created[0].content).split('\n')[0]).toBe('| Item | Qty | Price | Total |')
    expect(r.ok && r.lossy).toContain(TABLE_FALLBACK_NOTE)
  })

  it('a drawing becomes an image work widget whose picture is in the file store', async () => {
    const b = F.draw()
    const plan = planDesk(formsOf(b, F.DEPS), { body: b, verb: 'insert' })
    if (!plan.ok) throw new Error(plan.reason)
    await placeDeskPlan(plan, { taskId: 'desk' })
    expect(created[0]).toMatchObject({ kind: 'image', content: 'fb-file://file-1', title: 'Picture from PlexiiDraw' })
    expect(ingested[0].mimeType).toBe('image/svg+xml')
  })

  it('a document becomes a page; clipboard text a sticky', async () => {
    const d = F.doc()
    const p = planDesk(formsOf(d, F.DEPS), { body: d, verb: 'insert' })
    if (!p.ok) throw new Error(p.reason)
    await placeDeskPlan(p, { taskId: 'desk' })
    expect(created[0].kind).toBe('page')
    expect(JSON.parse(String(created[0].content)).type).toBe('doc')
    const t = planDesk(textForms('Call the bank'), { verb: 'paste' })
    if (!t.ok) throw new Error(t.reason)
    await placeDeskPlan(t, { taskId: 'desk' })
    expect(created[1]).toMatchObject({ kind: 'sticky', content: 'Call the bank' })
  })
})

describe('small pieces', () => {
  it('spliceText puts an insert on its own lines at the caret', () => {
    expect(spliceText('ab', 'X', { start: 1, end: 1 })).toEqual({ text: 'a\nX\nb', caret: 3 })
    expect(spliceText('ab', 'X', null)).toEqual({ text: 'ab\nX', caret: 4 })
    expect(spliceText('', 'X', null)).toEqual({ text: 'X', caret: 1 })
  })

  it('isTsvGrid: two or more tab-separated columns', () => {
    expect(isTsvGrid('a\tb\n1\t2')).toBe(true)
    expect(isTsvGrid('just text')).toBe(false)
  })

  it('what each work widget offers in its library is derived from what really lands', () => {
    expect(widgetAccepts('table')).toEqual(['doc', 'widget', 'sheet'])
    expect(widgetAccepts('image')).toEqual(['widget', 'sheet', 'slide', 'design', 'diagram', 'draw'])
    expect(widgetAccepts('page')).toEqual(['doc', 'widget', 'sheet', 'slide', 'design', 'diagram', 'draw'])
    // Stickies list pictures too, so inserting one shows the owner's refusal.
    expect(widgetAccepts('sticky')).toEqual(['doc', 'widget', 'sheet', 'slide', 'design', 'diagram', 'draw'])
  })
})
