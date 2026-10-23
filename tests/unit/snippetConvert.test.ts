// Any snippet into any destination (shared/snippetConvert.ts): one test per
// cell of the matrix, against bodies captured with each app's own capture
// function, asserting the exact output kind, its structure, the lossy lines
// and the refusal reasons. Then the properties every cell must have: the
// requested kind or a refusal, never another kind; byte-identical on a re-run
// (a converted live instance is re-converted on every render); the source
// never mutated; honest behaviour when a renderer-only dep is missing.

import { describe, expect, it } from 'vitest'
import { convertSnippetBody, type SnippetConversion } from '../../src/shared/snippetConvert'
import type { DesignSnippetBody, DiagramSnippetBody, DocSnippetBody, DrawSnippetBody, SheetSnippetBody, SlideSnippetBody, SnippetBody, SnippetKind, WidgetSnippetBody } from '../../src/shared/snippets'
import type { MapNode, SlideElement, SlideImageElement, SlideTableElement, SlideTextElement } from '../../src/shared/types'
import { REASON } from '../../src/shared/snippetConvert/common'
import { SVG_DATA_PREFIX } from '../../src/shared/snippetForms/picture'
import * as F from './snippetConvertFixtures'

const KINDS: SnippetKind[] = ['doc', 'sheet', 'slide', 'design', 'diagram', 'draw', 'widget']

function conv(body: SnippetBody, to: SnippetKind, deps = F.DEPS): Extract<SnippetConversion, { ok: true }> {
  const r = convertSnippetBody(body, to, deps)
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  expect(r.body.kind).toBe(to)
  return r
}

function refused(body: SnippetBody, to: SnippetKind, deps = F.DEPS): string {
  const r = convertSnippetBody(body, to, deps)
  if (r.ok) throw new Error(`expected a refusal, got ${r.body.kind}`)
  return r.reason
}

/** The SVG inside a data: URL. */
function svgOf(url: string): string {
  expect(url.startsWith(SVG_DATA_PREFIX)).toBe(true)
  return new TextDecoder().decode(Uint8Array.from(atob(url.slice(SVG_DATA_PREFIX.length)), (c) => c.charCodeAt(0)))
}

const pic = (app: string): string => `It becomes a picture: edit it in ${app}.`
const SHEET_LOSSY = ['Formulas become their values.', 'Cell formatting is not kept.']
const SHEET_VALUES = [
  ['Item', 'Qty', 'Price', 'Total'],
  ['Pens', '2', '3', '6'],
  ['Pads', '4', '5', '20'],
  ['Sum', '', '', '26']
]
const CARD_REASON = (app: string): string => `A card work widget cannot be placed in ${app} yet. Insert it on a desk instead.`
const TABLE_REASON = (app: string): string => `A table work widget is linked to its table and cannot be copied into ${app} yet.`

function allSources(): Array<[string, SnippetBody]> {
  return [
    ['doc', F.doc()],
    ['sheet', F.sheet()],
    ['slide', F.slide()],
    ['design', F.design()],
    ['diagram', F.diagram()],
    ['draw', F.draw()],
    ['sticky', F.STICKY],
    ['markdown', F.MARKDOWN],
    ['page', F.PAGE],
    ['image', F.IMAGE],
    ['card', F.CARD],
    ['table', F.TABLE]
  ]
}

// ── → PlexiiWrite ────────────────────────────────────────────────────────────

describe('→ doc (PlexiiWrite)', () => {
  it('doc: native, unchanged', () => {
    const src = F.doc()
    const r = conv(src, 'doc')
    expect(r.body).toEqual(src)
    expect(r.body).not.toBe(src)
    expect(r.lossy).toEqual([])
  })

  it('sheet: a Write table of the COMPUTED values, heading row as tableHeader', () => {
    const r = conv(F.sheet(), 'doc')
    const b = r.body as DocSnippetBody
    expect(r.lossy).toEqual(SHEET_LOSSY)
    expect(b.content).toHaveLength(1)
    const table = b.content[0] as { type: string; content: Array<{ type: string; content: Array<{ type: string; attrs: unknown; content: Array<{ type: string; content?: Array<{ text: string }> }> }> }> }
    expect(table.type).toBe('table')
    expect(table.content.map((r) => r.type)).toEqual(['tableRow', 'tableRow', 'tableRow', 'tableRow'])
    expect(table.content[0].content.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader', 'tableHeader', 'tableHeader'])
    expect(table.content[1].content[0].type).toBe('tableCell')
    expect(table.content[1].content[0].attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: null })
    const text = table.content.map((row) => row.content.map((c) => c.content[0].content?.[0]?.text ?? ''))
    expect(text).toEqual(SHEET_VALUES)
    // An empty cell is an empty paragraph, never a text node holding ''.
    expect(table.content[3].content[1].content[0]).toEqual({ type: 'paragraph' })
    expect(b.text).toContain('Pens\t2\t3\t6')
  })

  it('sheet without the formula engine: formulas are shown as written, and it says so', () => {
    const r = conv(F.sheet(), 'doc', {})
    expect(r.lossy).toEqual(['Formulas are shown as written.', 'Cell formatting is not kept.'])
    expect(JSON.stringify(r.body)).toContain('=C3*D3')
  })

  it('slide: an image node holding an SVG picture of the elements (HTML in a foreignObject)', () => {
    const r = conv(F.slide(), 'doc')
    expect(r.lossy).toEqual([pic('PlexiiDeck')])
    const img = (r.body as DocSnippetBody).content[0] as { type: string; attrs: { src: string; alt: string; width: number } }
    expect(img.type).toBe('image')
    expect(img.attrs.alt).toBe('Picture from PlexiiDeck')
    expect(img.attrs.width).toBe(540)
    const svg = svgOf(img.attrs.src)
    expect(svg).toContain('<foreignObject')
    expect(svg).toContain('Quarterly ')
    expect(F.parseXml(svg).documentElement?.nodeName).toBe('svg')
  })

  it('design: a picture, with the story drawn once in its first frame', () => {
    const r = conv(F.design(), 'doc')
    expect(r.lossy).toEqual([pic('PlexiiDesign'), 'Text that flows through linked frames is drawn in the first frame.'])
    const svg = svgOf(((r.body as DocSnippetBody).content[0] as { attrs: { src: string } }).attrs.src)
    expect(svg.split('Annual report')).toHaveLength(2)
    expect(svg).toContain('Plain caption')
  })

  it('diagram: an SVG picture drawn by mapToSvg', () => {
    const r = conv(F.diagram(), 'doc')
    expect(r.lossy).toEqual([pic('PlexiiDiagrams')])
    const svg = svgOf(((r.body as DocSnippetBody).content[0] as { attrs: { src: string } }).attrs.src)
    expect(svg).toContain('Approved?')
    expect(svg).not.toContain('<foreignObject')
  })

  it('draw: the SVG Draw’s own Copy writes', () => {
    const r = conv(F.draw(), 'doc')
    expect(r.lossy).toEqual([pic('PlexiiDraw')])
    expect(svgOf(((r.body as DocSnippetBody).content[0] as { attrs: { src: string } }).attrs.src)).toContain('Logo mark')
  })

  it('draw without Draw’s SVG writer: refused, never a blank picture', () => {
    expect(refused(F.draw(), 'doc', {})).toBe(REASON.drawingNeedsApp)
  })

  it('sticky: its lines as paragraphs, the obvious bullets as a list', () => {
    const r = conv(F.STICKY, 'doc')
    expect(r.lossy).toEqual([])
    const c = (r.body as DocSnippetBody).content as Array<{ type: string; content: unknown[] }>
    expect(c.map((n) => n.type)).toEqual(['paragraph', 'bulletList'])
    expect(c[1].content).toHaveLength(2)
    expect((r.body as DocSnippetBody).text).toBe('Call the bank\nconfirm limit\nask about fees')
  })

  it('markdown: heading, a real table and bold text', () => {
    const r = conv(F.MARKDOWN, 'doc')
    expect(r.lossy).toEqual([])
    const c = (r.body as DocSnippetBody).content as Array<{ type: string; attrs?: { level?: number }; content: Array<{ marks?: Array<{ type: string }> }> }>
    expect(c.map((n) => n.type)).toEqual(['heading', 'table', 'paragraph'])
    expect(c[0].attrs?.level).toBe(2)
    expect(c[2].content.some((t) => t.marks?.[0]?.type === 'bold')).toBe(true)
  })

  it('page: its own TipTap nodes', () => {
    const r = conv(F.PAGE, 'doc')
    expect(r.lossy).toEqual([])
    expect((r.body as DocSnippetBody).content).toEqual(JSON.parse(F.PAGE.content).content)
  })

  it('image: an image node with the picture and its title as alt text', () => {
    const r = conv(F.IMAGE, 'doc')
    expect(r.lossy).toEqual([])
    expect((r.body as DocSnippetBody).content).toEqual([{ type: 'image', attrs: { src: 'https://example.test/logo.png', alt: 'Logo', title: null, width: null } }])
  })

  it('card and table work widgets are refused with their reasons', () => {
    expect(refused(F.CARD, 'doc')).toBe(CARD_REASON('PlexiiWrite'))
    expect(refused(F.TABLE, 'doc')).toBe('A table work widget is linked to its table and cannot be copied into a document yet.')
  })

  it('an empty sticky is refused as empty', () => {
    expect(refused(F.widget('sticky', '   '), 'doc')).toBe('This work widget is empty, so there is nothing to insert.')
  })
})

// ── → PlexiiCells ────────────────────────────────────────────────────────────

describe('→ sheet (PlexiiCells)', () => {
  it('doc: its first table as rows, written literally (no origin)', () => {
    const r = conv(F.doc(), 'sheet')
    expect(r.body).toEqual({ kind: 'sheet', rows: [['Item', 'Price'], ['Design', '1200']] })
    expect(r.lossy).toEqual(['Formatting is not kept.', 'Only the first table is kept.'])
  })

  it('doc with no table: one non-empty paragraph per row in column A', () => {
    const r = conv(F.docFrom('<p>One</p><p></p><p><em>Two</em></p>'), 'sheet')
    expect(r.body).toEqual({ kind: 'sheet', rows: [['One'], ['Two']] })
    expect(r.lossy).toEqual(['Formatting is not kept.'])
  })

  it('sheet: native, formulas kept as written', () => {
    const src = F.sheet()
    const r = conv(src, 'sheet')
    expect(r.body).toEqual(src)
    expect(r.lossy).toEqual([])
  })

  it.each(['slide', 'design', 'diagram', 'draw'] as const)('%s: refused, a sheet holds values', (k) => {
    const src = { slide: F.slide, design: F.design, diagram: F.diagram, draw: F.draw }[k]()
    expect(refused(src, 'sheet')).toBe('PlexiiCells holds values, not pictures.')
  })

  it('sticky: its lines in column A', () => {
    const r = conv(F.STICKY, 'sheet')
    expect(r.body).toEqual({ kind: 'sheet', rows: [['Call the bank'], ['- confirm limit'], ['- ask about fees']] })
    expect(r.lossy).toEqual([])
  })

  it('markdown: its pipe table as rows', () => {
    const r = conv(F.MARKDOWN, 'sheet')
    expect(r.body).toEqual({ kind: 'sheet', rows: [['Plan', 'Price'], ['Pro', '$12'], ['Team', '$15']] })
    expect(r.lossy).toEqual(['Formatting is not kept.', 'Only the table is kept.'])
  })

  it('page: its paragraphs in column A', () => {
    const r = conv(F.PAGE, 'sheet')
    expect(r.body).toEqual({ kind: 'sheet', rows: [['Plan'], ['Ship it.']] })
    expect(r.lossy).toEqual(['Formatting is not kept.'])
  })

  it('image, card and table work widgets are refused', () => {
    expect(refused(F.IMAGE, 'sheet')).toBe('PlexiiCells holds values, not pictures.')
    expect(refused(F.CARD, 'sheet')).toBe(CARD_REASON('PlexiiCells'))
    expect(refused(F.TABLE, 'sheet')).toBe(TABLE_REASON('PlexiiCells'))
  })
})

// ── → PlexiiDeck ─────────────────────────────────────────────────────────────

describe('→ slide (PlexiiDeck)', () => {
  it('doc: one text box keeping bold, heading size and bullets', () => {
    const r = conv(F.doc(), 'slide')
    expect(r.lossy).toEqual(['Links become plain text.', 'Tables become lines of text.'])
    const els = (r.body as SlideSnippetBody).elements as SlideTextElement[]
    expect(els).toHaveLength(1)
    expect(els[0].type).toBe('text')
    const ps = els[0].paragraphs
    expect(ps[0].runs[0]).toEqual({ text: 'Payment terms', fontSize: 32, bold: true })
    expect(ps[1].runs.find((r) => r.text === '30 days')?.bold).toBe(true)
    expect(ps.filter((p) => p.listStyle === 'bullet').map((p) => p.runs[0].text)).toEqual(['Bank transfer', 'Card'])
    expect(ps.map((p) => p.runs.map((r) => r.text).join(''))).toContain('Design\t1200')
  })

  it('sheet: Deck’s native table element with computed values', () => {
    const r = conv(F.sheet(), 'slide')
    expect(r.lossy).toEqual(SHEET_LOSSY)
    const t = (r.body as SlideSnippetBody).elements[0] as SlideTableElement
    expect(t).toMatchObject({ id: 'table-0', type: 'table', x: 0, y: 0, z: 0, headerRow: true, cells: SHEET_VALUES })
  })

  it('slide: native, unchanged', () => {
    const src = F.slide()
    expect(conv(src, 'slide')).toEqual({ ok: true, body: src, lossy: [] })
  })

  it('design: the same elements, each story one text box, design-only fields gone', () => {
    const r = conv(F.design(), 'slide')
    expect(r.lossy).toEqual(['Linked text frames become one text box holding the whole story.'])
    const els = (r.body as SlideSnippetBody).elements as SlideElement[]
    expect(els.map((e) => e.id)).toEqual(['s1', 'p1', 'f1'])
    const json = JSON.stringify(els)
    expect(json).not.toContain('storyId')
    expect(json).not.toContain('swatchId')
    const f1 = els[2] as SlideTextElement
    expect(f1.paragraphs.map((p) => p.runs[0].text)).toEqual(['Annual report', 'Revenue grew in every region.'])
    expect(f1.paragraphs[0].runs[0].bold).toBe(true)
    expect((els[0] as { fill: unknown }).fill).toEqual({ type: 'solid', color: '#ff0000' })
  })

  it('diagram: an image element of its real size, aspect locked', () => {
    const r = conv(F.diagram(), 'slide')
    expect(r.lossy).toEqual([pic('PlexiiDiagrams')])
    const img = (r.body as SlideSnippetBody).elements[0] as SlideImageElement
    expect(img).toMatchObject({ type: 'image', fit: 'contain', lockAspect: true, naturalW: img.w, naturalH: img.h, alt: 'Picture from PlexiiDiagrams' })
    expect(svgOf(img.src)).toContain('Start')
  })

  it('draw: an image element', () => {
    const r = conv(F.draw(), 'slide')
    expect(r.lossy).toEqual([pic('PlexiiDraw')])
    expect(((r.body as SlideSnippetBody).elements[0] as SlideImageElement).type).toBe('image')
  })

  it('sticky: a text box, bullets kept', () => {
    const r = conv(F.STICKY, 'slide')
    expect(r.lossy).toEqual([])
    const ps = ((r.body as SlideSnippetBody).elements[0] as SlideTextElement).paragraphs
    expect(ps.map((p) => [p.runs[0].text, p.listStyle ?? null])).toEqual([
      ['Call the bank', null],
      ['confirm limit', 'bullet'],
      ['ask about fees', 'bullet']
    ])
  })

  it('markdown: a text box; its table becomes lines', () => {
    expect(conv(F.MARKDOWN, 'slide').lossy).toEqual(['Tables become lines of text.'])
  })

  it('page: a text box with a heading-sized title', () => {
    const r = conv(F.PAGE, 'slide')
    expect(r.lossy).toEqual([])
    expect(((r.body as SlideSnippetBody).elements[0] as SlideTextElement).paragraphs[0].runs[0]).toEqual({ text: 'Plan', fontSize: 40, bold: true })
  })

  it('image widget: an image element that does not invent a natural size', () => {
    const r = conv(F.IMAGE, 'slide')
    expect(r.lossy).toEqual([])
    const img = (r.body as SlideSnippetBody).elements[0] as SlideImageElement
    expect(img.src).toBe('https://example.test/logo.png')
    expect(img.naturalW).toBeUndefined()
    expect(img.lockAspect).toBeUndefined()
  })

  it('card and table work widgets are refused', () => {
    expect(refused(F.CARD, 'slide')).toBe(CARD_REASON('PlexiiDeck'))
    expect(refused(F.TABLE, 'slide')).toBe(TABLE_REASON('PlexiiDeck'))
  })
})

// ── → PlexiiDesign ───────────────────────────────────────────────────────────

describe('→ design (PlexiiDesign)', () => {
  it('doc: a text frame reading a new story; headings and lists stay story blocks, table rows become paragraphs', () => {
    const r = conv(F.doc(), 'design')
    expect(r.lossy).toEqual(['Bold, italic and links become plain text.', 'Tables become paragraphs.'])
    const b = r.body as DesignSnippetBody
    expect(b.elements).toEqual([{ id: 'text-0', type: 'text', x: 0, y: 0, w: 600, h: expect.any(Number), z: 0, paragraphs: [], storyId: 'story-0', storyOrder: 1 }])
    expect(b.stories).toEqual({
      'story-0': {
        blocks: [
          { kind: 'heading', level: 1, text: 'Payment terms' },
          { kind: 'paragraph', text: 'Pay within 30 days of the invoice.' },
          { kind: 'list', ordered: false, items: ['Bank transfer', 'Card'] },
          { kind: 'paragraph', text: 'Item | Price' },
          { kind: 'paragraph', text: 'Design | 1200' }
        ]
      }
    })
  })

  it('sheet: a native table element (Design’s canvas and exporter draw tables)', () => {
    const r = conv(F.sheet(), 'design')
    expect(r.lossy).toEqual(SHEET_LOSSY)
    expect((r.body as DesignSnippetBody).elements[0]).toMatchObject({ type: 'table', cells: SHEET_VALUES, headerRow: true })
  })

  it('slide: the same elements; text boxes stay plain frames with their own styled runs', () => {
    const src = F.slide()
    const r = conv(src, 'design')
    expect(r.lossy).toEqual([])
    expect(r.body).toEqual({ kind: 'design', elements: src.elements })
  })

  it('design: native, unchanged (stories and swatches travel)', () => {
    const src = F.design()
    const r = conv(src, 'design')
    expect(r.body).toEqual(src)
    expect(r.lossy).toEqual([])
  })

  it('diagram and draw: an image element', () => {
    expect(conv(F.diagram(), 'design').lossy).toEqual([pic('PlexiiDiagrams')])
    const d = conv(F.draw(), 'design')
    expect(d.lossy).toEqual([pic('PlexiiDraw')])
    expect((d.body as DesignSnippetBody).elements[0]).toMatchObject({ type: 'image', lockAspect: true })
  })

  it('sticky: a story with a paragraph and a list', () => {
    const r = conv(F.STICKY, 'design')
    expect(r.lossy).toEqual([])
    expect((r.body as DesignSnippetBody).stories).toEqual({
      'story-0': { blocks: [{ kind: 'paragraph', text: 'Call the bank' }, { kind: 'list', ordered: false, items: ['confirm limit', 'ask about fees'] }] }
    })
  })

  it('markdown: a story; its table rows become paragraphs', () => {
    const r = conv(F.MARKDOWN, 'design')
    expect(r.lossy).toEqual(['Bold, italic and links become plain text.', 'Tables become paragraphs.'])
    expect(JSON.stringify((r.body as DesignSnippetBody).stories)).toContain('Plan | Price')
  })

  it('page: a story whose first heading is the title', () => {
    const r = conv(F.PAGE, 'design')
    expect(r.lossy).toEqual([])
    expect((r.body as DesignSnippetBody).stories?.['story-0']).toEqual({ blocks: [{ kind: 'title', text: 'Plan' }, { kind: 'paragraph', text: 'Ship it.' }] })
  })

  it('image widget: an image element; card and table refused', () => {
    expect(conv(F.IMAGE, 'design').body).toMatchObject({ elements: [{ type: 'image', src: 'https://example.test/logo.png' }] })
    expect(refused(F.CARD, 'design')).toBe(CARD_REASON('PlexiiDesign'))
    expect(refused(F.TABLE, 'design')).toBe(TABLE_REASON('PlexiiDesign'))
  })
})

// ── → PlexiiDraw ─────────────────────────────────────────────────────────────

type DrawObj = { type: string; text?: string; children?: DrawObj[]; assetId?: string }
function walkDraw(objs: DrawObj[], out: DrawObj[] = []): DrawObj[] {
  for (const o of objs) {
    out.push(o)
    if (o.children) walkDraw(o.children, out)
  }
  return out
}

describe('→ draw (PlexiiDraw)', () => {
  it('doc: one text object holding its words', () => {
    const r = conv(F.doc(), 'draw')
    expect(r.lossy).toEqual(['Styles become plain text.', 'Tables become lines of text.'])
    const b = r.body as DrawSnippetBody
    expect(b.objects).toEqual([{ id: 'text-0', type: 'text', x: 0, y: 0, w: 480, text: 'Payment terms\nPay within 30 days of the invoice.\nBank transfer\nCard\nItem\tPrice\nDesign\t1200', fontSize: 18, lineHeight: 1.3, fill: { type: 'solid', color: '#111827' } }])
  })

  it('sheet: a picture of its table (computed values), bytes in the asset store', () => {
    const s = conv(F.sheet(), 'draw')
    expect(s.lossy).toEqual([pic('PlexiiCells'), 'Formulas become their values.'])
    const b = s.body as DrawSnippetBody
    expect(b.objects).toHaveLength(1)
    const node = b.objects[0] as DrawObj
    expect(node.type).toBe('image')
    const asset = (b.assets as Record<string, { mime: string; dataUrl: string }>)[node.assetId!]
    expect(asset.mime).toBe('image/svg+xml')
    const svg = Buffer.from(asset.dataUrl.split(',')[1], 'base64').toString('utf8')
    expect(svg).toContain('>26</text>')
    expect(svg).not.toContain('SUM(')
  })

  it('slide and design: a picture (their HTML cannot be imported as vectors), bytes in the asset store', () => {
    const s = conv(F.slide(), 'draw')
    expect(s.lossy).toEqual([pic('PlexiiDeck')])
    const b = s.body as DrawSnippetBody
    const node = b.objects[0] as DrawObj
    expect(node.type).toBe('image')
    const asset = (b.assets as Record<string, { mime: string; dataUrl: string }>)[node.assetId!]
    expect(asset.mime).toBe('image/svg+xml')
    expect(svgOf(asset.dataUrl)).toContain('<foreignObject')
    expect(conv(F.design(), 'draw').lossy).toEqual([pic('PlexiiDesign'), 'Text that flows through linked frames is drawn in the first frame.'])
  })

  it('diagram: EDITABLE vector objects through Draw’s SVG importer; connectors become lines', () => {
    const r = conv(F.diagram(), 'draw')
    expect(r.lossy).toEqual(['Connectors become plain lines.'])
    const all = walkDraw((r.body as DrawSnippetBody).objects as DrawObj[])
    expect(all.some((o) => o.type === 'image')).toBe(false)
    expect(all.filter((o) => o.type === 'path').length).toBeGreaterThan(2)
    const words = all.filter((o) => o.type === 'text').map((o) => o.text)
    expect(words).toEqual(expect.arrayContaining(['Start', 'Approved?']))
    // No invisible page-sized rectangle under the art.
    expect(JSON.stringify((r.body as DrawSnippetBody).objects)).not.toMatch(/"fill":\{"type":"none"\},"shapeKind":"rect"/)
  })

  it('diagram without Draw’s importer: a picture, said so', () => {
    const r = conv(F.diagram(), 'draw', { ...F.DEPS, svgToDraw: undefined })
    expect(r.lossy).toEqual([pic('PlexiiDiagrams')])
    expect(((r.body as DrawSnippetBody).objects[0] as DrawObj).type).toBe('image')
  })

  it('draw: native, unchanged', () => {
    const src = F.draw()
    expect(conv(src, 'draw').body).toEqual(src)
  })

  it('sticky, markdown and page: a text object', () => {
    expect(conv(F.STICKY, 'draw')).toMatchObject({ lossy: [], body: { objects: [{ type: 'text', text: 'Call the bank\n- confirm limit\n- ask about fees' }] } })
    expect(conv(F.MARKDOWN, 'draw').lossy).toEqual(['Styles become plain text.'])
    expect(conv(F.PAGE, 'draw')).toMatchObject({ lossy: ['Styles become plain text.'], body: { objects: [{ text: 'Plan\nShip it.' }] } })
  })

  it('image widget: an image object when its bytes are stored, refused when it is only a link', () => {
    expect(refused(F.IMAGE, 'draw')).toBe('This picture is linked rather than stored in the work widget, so PlexiiDraw cannot hold it yet.')
    const r = conv(F.widget('image', F.PNG, 'Dot'), 'draw')
    expect(r.lossy).toEqual([])
    const b = r.body as DrawSnippetBody
    const node = b.objects[0] as DrawObj
    expect(node).toMatchObject({ type: 'image', alt: 'Dot' })
    expect((b.assets as Record<string, { dataUrl: string }>)[node.assetId!].dataUrl).toBe(F.PNG)
  })

  it('card and table work widgets are refused', () => {
    expect(refused(F.CARD, 'draw')).toBe(CARD_REASON('PlexiiDraw'))
    expect(refused(F.TABLE, 'draw')).toBe(TABLE_REASON('PlexiiDraw'))
  })
})

// ── → PlexiiDiagrams ─────────────────────────────────────────────────────────

describe('→ diagram (PlexiiDiagrams)', () => {
  it('doc: one note per paragraph', () => {
    const r = conv(F.doc(), 'diagram')
    expect(r.lossy).toEqual(['Styles become plain text.', 'Tables become lines of text.', 'Each paragraph becomes a note.'])
    const nodes = (r.body as DiagramSnippetBody).nodes as MapNode[]
    expect(nodes.map((n) => n.label)).toEqual(['Payment terms', 'Pay within 30 days of the invoice.', 'Bank transfer', 'Card', 'Item\tPrice', 'Design\t1200'])
    expect(nodes.every((n) => n.shape === 'note')).toBe(true)
    expect(nodes.map((n) => n.id)).toEqual(['note-0', 'note-1', 'note-2', 'note-3', 'note-4', 'note-5'])
    expect(new Set(nodes.map((n) => n.y)).size).toBe(nodes.length)
  })

  it('more than 50 paragraphs: 50 notes, and how many were left out', () => {
    const many = F.widget('sticky', Array.from({ length: 63 }, (_, i) => `Idea ${i + 1}`).join('\n'))
    const r = conv(many, 'diagram')
    expect((r.body as DiagramSnippetBody).nodes).toHaveLength(50)
    expect(r.lossy).toEqual(['Each paragraph becomes a note.', '13 more paragraphs are left out: a diagram takes up to 50 at once.'])
  })

  it('sheet: ONE table shape holding the computed cells ("Place as table")', () => {
    const r = conv(F.sheet(), 'diagram')
    expect(r.lossy).toEqual(SHEET_LOSSY)
    const nodes = (r.body as DiagramSnippetBody).nodes as MapNode[]
    expect(nodes).toEqual([{ id: 'table-0', x: 0, y: 0, label: '', shape: 'table-header', color: expect.any(String), width: 480, height: 128, cells: SHEET_VALUES }])
    expect((r.body as DiagramSnippetBody).edges).toEqual([])
  })

  it('a sheet block with no heading row uses the plain table shape', () => {
    const r = conv({ kind: 'sheet', rows: [['1', '2'], ['3', '4']] }, 'diagram')
    expect(((r.body as DiagramSnippetBody).nodes[0] as MapNode).shape).toBe('table-3x3')
    expect(r.lossy).toEqual([])
  })

  it('slide, design and draw: an image shape holding the picture', () => {
    for (const [src, app] of [[F.slide(), 'PlexiiDeck'], [F.draw(), 'PlexiiDraw']] as const) {
      const r = conv(src, 'diagram')
      expect(r.lossy).toEqual([pic(app)])
      const n = (r.body as DiagramSnippetBody).nodes[0] as MapNode
      expect(n).toMatchObject({ id: 'image-0', shape: 'image', description: `Picture from ${app}` })
      expect(n.image?.startsWith(SVG_DATA_PREFIX)).toBe(true)
    }
    expect(conv(F.design(), 'diagram').lossy).toEqual([pic('PlexiiDesign'), 'Text that flows through linked frames is drawn in the first frame.'])
  })

  it('diagram: native, unchanged', () => {
    const src = F.diagram()
    expect(conv(src, 'diagram').body).toEqual(src)
  })

  it('sticky, markdown and page: notes', () => {
    expect(conv(F.STICKY, 'diagram')).toMatchObject({ lossy: ['Each paragraph becomes a note.'], body: { nodes: [{ label: 'Call the bank' }, { label: '- confirm limit' }, { label: '- ask about fees' }] } })
    expect(conv(F.MARKDOWN, 'diagram').lossy).toEqual(['Styles become plain text.', 'Each paragraph becomes a note.'])
    expect(conv(F.PAGE, 'diagram').lossy).toEqual(['Styles become plain text.', 'Each paragraph becomes a note.'])
  })

  it('image widget: an image shape; card and table refused', () => {
    expect(conv(F.IMAGE, 'diagram')).toMatchObject({ lossy: [], body: { nodes: [{ shape: 'image', image: 'https://example.test/logo.png' }] } })
    expect(refused(F.CARD, 'diagram')).toBe(CARD_REASON('PlexiiDiagrams'))
    expect(refused(F.TABLE, 'diagram')).toBe(TABLE_REASON('PlexiiDiagrams'))
  })
})

// ── → a desk (work widget) ───────────────────────────────────────────────────

describe('→ widget (a desk)', () => {
  it('doc: a page widget holding its TipTap JSON', () => {
    const src = F.doc()
    const r = conv(src, 'widget')
    expect(r.lossy).toEqual([])
    const w = r.body as WidgetSnippetBody
    expect(w).toMatchObject({ widgetKind: 'page', title: '', width: 480, height: 400, color: null })
    expect(JSON.parse(w.content)).toEqual({ type: 'doc', content: src.content })
  })

  it('doc with a picture or centred text: a page widget keeps the picture and says what it cannot hold', () => {
    const r = conv(F.docFrom(`<p style="text-align: center">Hi</p><img src="${F.PNG}">`), 'widget')
    // Page and markdown work widgets draw images, so the picture travels.
    expect(r.lossy).toEqual(['Text alignment is not kept.'])
    const content = JSON.parse((r.body as WidgetSnippetBody).content) as { content: Array<{ type: string; attrs?: { src?: string } }> }
    expect(content.content.find((n) => n.type === 'image')?.attrs?.src).toBe(F.PNG)
  })

  it('sheet: a markdown widget with a GFM table of the values', () => {
    const r = conv(F.sheet(), 'widget')
    expect(r.lossy).toEqual(SHEET_LOSSY)
    expect(r.body).toMatchObject({ widgetKind: 'markdown', content: '| Item | Qty | Price | Total |\n| --- | --- | --- | --- |\n| Pens | 2 | 3 | 6 |\n| Pads | 4 | 5 | 20 |\n| Sum |   |   | 26 |' })
  })

  it.each([
    ['slide', 'PlexiiDeck'],
    ['design', 'PlexiiDesign'],
    ['diagram', 'PlexiiDiagrams'],
    ['draw', 'PlexiiDraw']
  ] as const)('%s: an image widget whose content is the picture', (k, app) => {
    const src = { slide: F.slide, design: F.design, diagram: F.diagram, draw: F.draw }[k]()
    const r = conv(src, 'widget')
    expect(r.lossy[0]).toBe(pic(app))
    const w = r.body as WidgetSnippetBody
    expect(w.widgetKind).toBe('image')
    expect(w.content.startsWith(SVG_DATA_PREFIX)).toBe(true)
  })

  it('every work widget, card and table included: native, unchanged', () => {
    for (const w of [F.STICKY, F.MARKDOWN, F.PAGE, F.IMAGE, F.CARD, F.TABLE]) expect(conv(w, 'widget')).toEqual({ ok: true, body: w, lossy: [] })
  })
})

// ── Properties of every cell ─────────────────────────────────────────────────

describe('every cell', () => {
  it('returns exactly the requested kind, or a refusal with a reason', () => {
    for (const [name, src] of allSources()) {
      for (const to of KINDS) {
        const r = convertSnippetBody(src, to, F.DEPS)
        if (r.ok) expect(r.body.kind, `${name} → ${to}`).toBe(to)
        else expect(r.reason.length, `${name} → ${to}`).toBeGreaterThan(10)
      }
    }
  })

  it('is deterministic: converting twice gives byte-identical output', () => {
    for (const [name, src] of allSources()) {
      for (const to of KINDS) {
        const a = convertSnippetBody(src, to, F.DEPS)
        const b = convertSnippetBody(structuredClone(src), to, F.DEPS)
        expect(b, `${name} → ${to}`).toEqual(a)
        expect(JSON.stringify(b), `${name} → ${to}`).toBe(JSON.stringify(a))
      }
    }
  })

  it('never mutates the source and shares no object with it', () => {
    for (const [name, src] of allSources()) {
      const before = JSON.stringify(src)
      for (const to of KINDS) {
        const r = convertSnippetBody(src, to, F.DEPS)
        if (r.ok && r.body.kind === src.kind) {
          expect(r.body, `${name} → ${to}`).not.toBe(src)
        }
      }
      expect(JSON.stringify(src), name).toBe(before)
    }
  })

  it('writes plain sentences: British, no em dashes, one per loss, each ending in a full stop', () => {
    for (const [, src] of allSources()) {
      for (const to of KINDS) {
        const r = convertSnippetBody(src, to, F.DEPS)
        const lines = r.ok ? r.lossy : [r.reason]
        for (const l of lines) {
          expect(l).not.toMatch(/[—–]/)
          expect(l).toMatch(/[.]$/)
          expect(l).not.toMatch(/\bcolor\b/)
        }
        if (r.ok) expect(new Set(r.lossy).size).toBe(r.lossy.length)
      }
    }
  })

  it('degrades honestly with no deps at all: no cell claims a picture or a value it could not make', () => {
    for (const [name, src] of allSources()) {
      for (const to of KINDS) {
        const r = convertSnippetBody(src, to)
        if (!r.ok) continue
        expect(r.body.kind, `${name} → ${to}`).toBe(to)
        if (src.kind === 'sheet' && to !== 'sheet') expect(r.lossy).toContain('Formulas are shown as written.')
      }
    }
    for (const to of ['doc', 'slide', 'design', 'diagram', 'widget'] as SnippetKind[]) expect(refused(F.draw(), to, {})).toBe(REASON.drawingNeedsApp)
  })
})
