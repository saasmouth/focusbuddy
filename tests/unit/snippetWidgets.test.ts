// Any content into a work widget, and onto a desk: the pure acceptors
// (src/shared/snippetWidgets.ts). Real bodies captured the way each app
// captures them, with the renderer's real conversion deps.

import { describe, expect, it } from 'vitest'
import { formsOf, type Form } from '../../src/shared/snippetForms'
import type { SnippetBody } from '../../src/shared/snippets'
import {
  acceptForImage,
  acceptForMarkdown,
  acceptForPage,
  acceptForTable,
  acceptForTextWidget,
  isArt,
  lossyLine,
  nodesToStickyText,
  pasteForms,
  planDesk,
  textWidgetRefusal,
  IMAGE_NEEDS_PICTURE,
  TABLE_NO_PICTURES
} from '../../src/shared/snippetWidgets'
import { splitStickyBlocks } from '../../src/renderer/src/lib/stickyText'
import * as F from './snippetConvertFixtures'

const ins = (body: SnippetBody) => ({ body, verb: 'insert' as const })
const forms = (body: SnippetBody): Form[] => formsOf(body, F.DEPS)
const PASTE = { verb: 'paste' as const }

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`refused: ${(r as unknown as { reason: string }).reason}`)
  return r as Extract<T, { ok: true }>
}
function reason(r: { ok: boolean }): string {
  if (r.ok) throw new Error('expected a refusal')
  return (r as { reason: string }).reason
}

describe('sticky and note: text', () => {
  it('a Cells block lands as a GFM pipe table of its values, which the sticky renders as a table', () => {
    const s = F.sheet()
    const r = ok(acceptForTextWidget('sticky', forms(s), ins(s)))
    expect(r.text.split('\n')[0]).toBe('| Item | Qty | Price | Total |')
    expect(r.text).toContain('| Pens | 2 | 3 | 6 |')
    expect(r.text).toContain('| Sum |   |   | 26 |')
    expect(r.lossy).toContain('Formulas become their values.')
    const blocks = splitStickyBlocks(r.text)
    expect(blocks[0]).toMatchObject({ type: 'table', headers: ['Item', 'Qty', 'Price', 'Total'] })
  })

  it('a value holding a pipe survives as one cell in the sticky table', () => {
    const b: SnippetBody = { kind: 'sheet', rows: [['Plan', 'Note'], ['Pro', 'a | b']] }
    const r = ok(acceptForTextWidget('sticky', forms(b), ins(b)))
    expect(splitStickyBlocks(r.text)[0]).toEqual({ type: 'table', headers: ['Plan', 'Note'], rows: [['Pro', 'a | b']] })
  })

  it('a document becomes sticky markdown-lite: bold kept, bullets, a pipe table, the rest named', () => {
    const d = F.doc()
    const r = ok(acceptForTextWidget('note', forms(d), ins(d)))
    expect(r.text).toBe(
      ['**Payment terms**', 'Pay within **30 days** of the invoice.', '- Bank transfer', '- Card', '', '| Item | Price |', '| --- | --- |', '| Design | 1200 |'].join('\n')
    )
    expect(r.lossy).toEqual(['Some text styles are not kept.'])
  })

  it('a task list keeps its ticks in the sticky checkbox syntax', () => {
    const nodes = [{ type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }] },
      { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Todo' }] }] }
    ] }]
    expect(nodesToStickyText(nodes)).toEqual({ text: '[x] Done\n[ ] Todo', lossy: [] })
  })

  it('a sticky into a note keeps exactly what was typed', () => {
    const r = ok(acceptForTextWidget('note', forms(F.STICKY), ins(F.STICKY)))
    expect(r).toEqual({ ok: true, text: F.STICKY.content, lossy: [] })
  })

  it('a drawing, a diagram, a slide, a design or an image widget is REFUSED with where it can go', () => {
    for (const b of [F.draw(), F.diagram(), F.slide(), F.design(), F.IMAGE]) {
      expect(reason(acceptForTextWidget('sticky', forms(b), ins(b)))).toBe('Stickies hold text. Insert it on the desk to add it as an image.')
      expect(reason(acceptForTextWidget('note', forms(b), ins(b)))).toBe('Notes hold text. Insert it on the desk to add it as an image.')
    }
  })

  it('a pasted picture is refused in the paste wording', () => {
    const pic: Form[] = [{ kind: 'image', value: { src: F.PNG }, lossy: [] }]
    expect(reason(acceptForTextWidget('sticky', pic, PASTE))).toBe('Stickies hold text. Paste on the desk to add it as an image.')
    expect(textWidgetRefusal('note', 'paste').reason).toBe('Notes hold text. Paste on the desk to add it as an image.')
  })

  it('a pasted tab-separated grid becomes a pipe table', () => {
    const f = pasteForms([
      { kind: 'text', value: 'A\tB\n1\t2', lossy: [] },
      { kind: 'rows', value: { rows: [['A', 'B'], ['1', '2']], header: true }, lossy: [] }
    ])
    expect(ok(acceptForTextWidget('sticky', f, PASTE)).text).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
  })
})

describe('page: TipTap nodes, pictures included', () => {
  it('a Cells block is a table node of its values', () => {
    const s = F.sheet()
    const r = ok(acceptForPage(forms(s), ins(s)))
    expect((r.nodes[0] as { type: string }).type).toBe('table')
    expect(JSON.stringify(r.nodes)).toContain('"text":"26"')
  })

  it('a drawing is an image node (no longer "Pictures are not kept"), naming where to edit it', () => {
    const b = F.draw()
    const r = ok(acceptForPage(forms(b), ins(b)))
    const img = r.nodes[0] as { type: string; attrs: { src: string; alt: string } }
    expect(img.type).toBe('image')
    expect(img.attrs.src.startsWith('data:image/svg+xml')).toBe(true)
    expect(img.attrs.alt).toBe('Picture from PlexiiDraw')
    expect(r.lossy).toEqual(['It becomes a picture: edit it in PlexiiDraw.'])
  })

  it('a document with a picture keeps it and names nothing lost for it', () => {
    const d = F.docFrom(`<p>Logo</p><img src="${F.PNG}" alt="logo">`)
    const r = ok(acceptForPage(forms(d), ins(d)))
    expect(r.nodes.some((n) => (n as { type: string }).type === 'image')).toBe(true)
    expect(r.lossy).not.toContain('Pictures are not kept.')
  })

  it('a pasted PNG lands as an image node', () => {
    const r = ok(acceptForPage([{ kind: 'image', value: { src: F.PNG, width: 900 }, lossy: [] }], PASTE))
    expect(r.nodes).toEqual([{ type: 'image', attrs: { src: F.PNG, alt: '', title: null, width: 560 } }])
  })
})

describe('markdown: markdown, pictures as ![alt](src), GFM tables', () => {
  it('a Cells block is a GFM table', () => {
    const s = F.sheet()
    expect(ok(acceptForMarkdown(forms(s), ins(s))).markdown.split('\n')[0]).toBe('| Item | Qty | Price | Total |')
  })

  it('a drawing is an image in markdown syntax', () => {
    const b = F.draw()
    const r = ok(acceptForMarkdown(forms(b), ins(b)))
    expect(r.markdown).toMatch(/^!\[Picture from PlexiiDraw\]\(data:image\/svg\+xml;charset=utf-8,[^)\s]+\)$/)
    expect(r.lossy).toEqual(['It becomes a picture: edit it in PlexiiDraw.'])
  })

  it('a markdown widget into another keeps its source exactly', () => {
    expect(ok(acceptForMarkdown(forms(F.MARKDOWN), ins(F.MARKDOWN))).markdown).toBe(F.MARKDOWN.content)
  })
})

describe('table: rows', () => {
  it('a Cells block is its rows with a heading row', () => {
    const s = F.sheet()
    const r = ok(acceptForTable(forms(s), ins(s)))
    expect(r.header).toBe(true)
    expect(r.rows[0]).toEqual(['Item', 'Qty', 'Price', 'Total'])
    expect(r.rows[3]).toEqual(['Sum', '', '', '26'])
  })

  it('a document gives its first table', () => {
    const d = F.doc()
    expect(ok(acceptForTable(forms(d), ins(d))).rows).toEqual([['Item', 'Price'], ['Design', '1200']])
  })

  it('pictures are refused', () => {
    const b = F.draw()
    expect(reason(acceptForTable(forms(b), ins(b)))).toBe(TABLE_NO_PICTURES)
  })
})

describe('image: one picture', () => {
  it('a drawing is its SVG; an image widget its src; a document without a picture is refused', () => {
    const b = F.draw()
    const r = ok(acceptForImage(forms(b), ins(b)))
    expect('svg' in r.picture && r.picture.svg.app).toBe('PlexiiDraw')
    expect(ok(acceptForImage(forms(F.IMAGE), ins(F.IMAGE))).picture).toEqual({ src: 'https://example.test/logo.png', alt: 'Logo' })
    const d = F.doc()
    expect(reason(acceptForImage(forms(d), ins(d)))).toBe(IMAGE_NEEDS_PICTURE)
  })

  it('without the drawing deps a drawing is refused with the app-window reason, never faked', () => {
    const b = F.draw()
    expect(reason(acceptForImage(formsOf(b, {}), ins(b)))).toBe('A picture of this drawing can only be made in the app window.')
  })
})

describe('the desk', () => {
  it('maps every kind to the work widget that holds it natively', () => {
    const plan = (b: SnippetBody) => ok(planDesk(forms(b), ins(b)))
    expect(plan(F.doc()).widget).toBe('page')
    const t = plan(F.sheet())
    expect(t.widget).toBe('table')
    expect(t.widget === 'table' && t.rows[0]).toEqual(['Item', 'Qty', 'Price', 'Total'])
    for (const b of [F.draw(), F.diagram(), F.slide(), F.design()]) expect(plan(b).widget).toBe('image')
    const img = plan(F.draw())
    expect(img.lossy).toEqual(['It becomes a picture: edit it in PlexiiDraw.'])
  })

  it('the clipboard: text is a sticky, a tab grid is a table, a picture an image, a page of HTML a page', () => {
    expect(ok(planDesk([{ kind: 'text', value: 'Call the bank', lossy: [] }], PASTE))).toMatchObject({ widget: 'sticky', text: 'Call the bank' })
    expect(
      ok(planDesk([{ kind: 'text', value: 'A\tB\n1\t2', lossy: [] }, { kind: 'rows', value: { rows: [['A', 'B'], ['1', '2']], header: true }, lossy: [] }], PASTE))
    ).toMatchObject({ widget: 'table', rows: [['A', 'B'], ['1', '2']], header: true })
    expect(ok(planDesk([{ kind: 'image', value: { src: F.PNG }, lossy: [] }], PASTE)).widget).toBe('image')
    expect(ok(planDesk([{ kind: 'docNodes', value: [{ type: 'paragraph' }], lossy: [] }], PASTE)).widget).toBe('page')
    expect(reason(planDesk([], PASTE))).toBe('There is nothing on the clipboard that can be placed on a desk.')
  })

  it('art never lands as its words on the desk', () => {
    const b = F.draw()
    expect(reason(planDesk(formsOf(b, {}), ins(b)))).toBe('A picture of this drawing can only be made in the app window.')
  })
})

describe('helpers', () => {
  it('isArt reads the source kind, or the best clipboard form', () => {
    expect(isArt([], F.draw())).toBe(true)
    expect(isArt([], F.doc())).toBe(false)
    expect(isArt([{ kind: 'svg', value: { svg: '<svg/>', width: 1, height: 1, vector: true, app: 'PlexiiDraw' }, lossy: [] }])).toBe(true)
  })
  it('lossyLine is the unique sentences, one line', () => {
    expect(lossyLine(['A.', 'B.', 'A.'])).toBe('A. B.')
    expect(lossyLine([])).toBe('')
  })
})
