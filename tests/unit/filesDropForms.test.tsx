// The forms a Files drop adds to the conversion layer (Files panel plan §4.5):
// the `link` form and where it lands, the refusal wording per target and type,
// a picture that is already a row in Files (`fileId`) never stored twice, the
// SVG notice for "the original file", PDF_FIRST_PAGE, the 'drop' verb, and
// each work widget hook's dropForms (caret placement, refused passthrough, no
// notice of its own).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { Markdown } from 'tiptap-markdown'
import { conversionNotice, convertForms } from '../../src/shared/snippetConvert'
import { REASON, linkFileKind, linkReason } from '../../src/shared/snippetConvert/common'
import { linkedDocumentId } from '../../src/shared/snippetConvert/toDoc'
import { PDF_FIRST_PAGE, type Form, type LinkValue } from '../../src/shared/snippetForms'
import {
  acceptForImage,
  acceptForMarkdown,
  acceptForPage,
  acceptForTable,
  acceptForTextWidget,
  planDesk,
  textWidgetRefusal
} from '../../src/shared/snippetWidgets'
import type { SnippetBody } from '../../src/shared/snippets'
import type { Widget } from '../../src/shared/types'
import { pictureSrc, storeDataPicture, storeNodePictures } from '../../src/renderer/src/lib/widgetPictures'
import { NOTHING_DROPPED, placeDeskPlan, readDropForms } from '../../src/renderer/src/lib/widgetSnippetInsert'
import { textareaCaretAt } from '../../src/renderer/src/lib/textareaCaretAt'
import type { FormsRead } from '../../src/renderer/src/lib/clipboardForms'
import {
  useEditorWidgetSnippets,
  useImageWidgetSnippets,
  useTextWidgetSnippets,
  type WidgetSnippets
} from '../../src/renderer/src/components/widgets/useWidgetSnippets'
import { WIDGET_LINK_OPTIONS } from '../../src/renderer/src/components/widgets/widgetLink'
import { DocEmbedNode } from '../../src/renderer/src/components/documents/embed/DocEmbedNode'
import { useNoticeStore } from '../../src/renderer/src/stores/notice'
import { useWidgetStore } from '../../src/renderer/src/stores/widgets'
import * as F from './snippetConvertFixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FILE_ID = '0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e'
const link = (target: LinkValue['target'], href: string, title: string, mime?: string): Form => ({
  kind: 'link',
  value: { href, title, target, ...(mime ? { mime } : {}) },
  lossy: []
})
const fileLink = (title: string, mime?: string): Form => link('file', `plexii://file/${FILE_ID}`, title, mime)
const docLink = link('document', 'plexii://document/doc-42', 'Plan')
const folderLink = link('folder', 'plexii://folder/fold-7', 'Receipts')
const pictureFromFiles: Form = { kind: 'image', value: { src: F.PNG, width: 1, height: 1, alt: 'Receipt.png', fileId: FILE_ID }, lossy: [] }
const drop = { verb: 'drop' as const }

type Api = { files: { ingestBuffer: ReturnType<typeof vi.fn> } }
const w = window as unknown as { api?: Api }
let ingested: string[]
beforeEach(() => {
  ingested = []
  w.api = {
    files: {
      ingestBuffer: vi.fn(async (input: { originalName: string }) => {
        ingested.push(input.originalName)
        return { id: `stored-${ingested.length}` }
      })
    }
  }
})
afterEach(() => {
  delete w.api
})

// ── 1. The link form ─────────────────────────────────────────────────────────

describe('a link lands where links are held', () => {
  it('PlexiiWrite: a document is the DocEmbedNode insertDocEmbed makes', () => {
    const r = convertForms([docLink], 'doc')
    if (!r.ok) throw new Error(r.reason)
    expect(r.lossy).toEqual([])
    const body = r.body as Extract<SnippetBody, { kind: 'doc' }>
    expect(body.content).toEqual([{ type: 'docEmbed', attrs: { documentId: 'doc-42' } }])
    // The same document as Write's own command produces, node for node.
    const viaCommand = new Editor({ extensions: [StarterKit, DocEmbedNode] as never, content: '' })
    viaCommand.commands.insertDocEmbed('doc-42')
    const viaConvert = new Editor({ extensions: [StarterKit, DocEmbedNode] as never, content: '' })
    viaConvert.commands.insertContent(body.content as never)
    expect(viaConvert.getJSON()).toEqual(viaCommand.getJSON())
    viaCommand.destroy()
    viaConvert.destroy()
  })

  it('PlexiiWrite: a file or a folder is the title under a link mark', () => {
    for (const f of [fileLink('Demo.mp4', 'video/mp4'), folderLink]) {
      const r = convertForms([f], 'doc')
      if (!r.ok || f.kind !== 'link') throw new Error('refused')
      expect((r.body as { content: unknown[] }).content).toEqual([
        { type: 'paragraph', content: [{ type: 'text', text: f.value.title, marks: [{ type: 'link', attrs: { href: f.value.href } }] }] }
      ])
      expect((r.body as { text: string }).text).toBe(f.value.title)
    }
  })

  it('PlexiiWrite: a document link that names no document id is still a link, never a broken embed', () => {
    const r = convertForms([link('document', 'https://example.com/doc', 'Spec')], 'doc')
    expect(r.ok && JSON.stringify(r.body)).toContain('"href":"https://example.com/doc"')
    expect(linkedDocumentId('plexii://document/a%20b')).toBe('a b')
    expect(linkedDocumentId('plexii://file/x')).toBeNull()
  })

  it('a link with an address PlexiiDesk does not open is never written as a link', () => {
    const bad = link('file', 'javascript:alert(1)', 'x')
    expect(convertForms([bad], 'doc')).toEqual({ ok: false, reason: REASON.linkUnsafe })
    expect(acceptForPage([bad], drop)).toEqual({ ok: false, reason: REASON.linkUnsafe })
    expect(acceptForMarkdown([bad], drop)).toEqual({ ok: false, reason: REASON.linkUnsafe })
  })

  it('page and markdown work widgets: a link, documents included', () => {
    const page = acceptForPage([docLink], drop)
    expect(page).toEqual({
      ok: true,
      nodes: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plan', marks: [{ type: 'link', attrs: { href: 'plexii://document/doc-42' } }] }] }],
      lossy: []
    })
    expect(acceptForMarkdown([folderLink], drop)).toEqual({ ok: true, markdown: '[Receipts](plexii://folder/fold-7)', lossy: [] })
  })

  it('sticky and note: "title (href)" as text', () => {
    expect(acceptForTextWidget('sticky', [fileLink('Call.mp3', 'audio/mpeg')], drop)).toEqual({ ok: true, text: `Call.mp3 (plexii://file/${FILE_ID})`, lossy: [] })
    expect(acceptForTextWidget('note', [docLink], drop)).toEqual({ ok: true, text: 'Plan (plexii://document/doc-42)', lossy: [] })
  })

  it('a link written into a page or markdown widget survives its editor (plexii is a known scheme)', () => {
    const page = acceptForPage([docLink], drop)
    if (!page.ok) throw new Error(page.reason)
    const withOptions = new Editor({ extensions: [StarterKit.configure({ link: false }), Link.configure({ openOnClick: false, ...WIDGET_LINK_OPTIONS })] as never, content: { type: 'doc', content: page.nodes } })
    expect(withOptions.getHTML()).toContain('href="plexii://document/doc-42"')
    // Without the option TipTap's Link blanks the address: the reason the option exists.
    const without = new Editor({ extensions: [StarterKit.configure({ link: false }), Link.configure({ openOnClick: false })] as never, content: { type: 'doc', content: page.nodes } })
    expect(without.getHTML()).not.toContain('plexii://')
    withOptions.destroy()
    without.destroy()

    const md = acceptForMarkdown([docLink], drop)
    if (!md.ok) throw new Error(md.reason)
    const ed = new Editor({
      extensions: [StarterKit.configure({ link: false }), Link.configure({ openOnClick: false, ...WIDGET_LINK_OPTIONS }), Markdown.configure({ html: true })] as never,
      content: ''
    })
    ed.commands.insertContent(md.markdown)
    expect(JSON.stringify(ed.getJSON())).toContain('"href":"plexii://document/doc-42"')
    expect((ed.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown()).toBe('[Plan](plexii://document/doc-42)')
    ed.destroy()
  })

  it('a desk writes a link down as a sticky', () => {
    expect(planDesk([folderLink], drop)).toMatchObject({ ok: true, widget: 'sticky', text: 'Receipts (plexii://folder/fold-7)' })
    const r = convertForms([folderLink], 'widget')
    expect(r.ok && r.body).toMatchObject({ kind: 'widget', widgetKind: 'sticky', content: 'Receipts (plexii://folder/fold-7)' })
  })

  it('links are taken in the order the drop reader puts them (reference first for media, last for content)', () => {
    const text: Form = { kind: 'docNodes', value: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }], lossy: [] }
    const refFirst = convertForms([docLink, text], 'doc')
    expect(refFirst.ok && JSON.stringify(refFirst.body)).toContain('docEmbed')
    const contentFirst = convertForms([text, docLink], 'doc')
    expect(contentFirst.ok && JSON.stringify(contentFirst.body)).toContain('"text":"Body"')
  })
})

// ── 1b. Refusal wording per target and type ──────────────────────────────────

describe('a link refused names where it can go, by what it is', () => {
  const cases: Array<[string, Form, string]> = [
    ['video by type', fileLink('clip', 'video/quicktime'), 'PlexiiDeck cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.'],
    ['video by name', fileLink('Demo.MOV'), 'PlexiiDeck cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.'],
    ['audio', fileLink('Call.m4a', 'audio/mp4'), 'PlexiiDeck cannot hold an audio file. Drop it on a desk, or into PlexiiWrite as a link.'],
    ['a PDF, as a file', fileLink('Q3.pdf', 'application/pdf'), 'PlexiiDeck cannot hold this kind of file. Drop it on a desk, or into PlexiiWrite as a link.'],
    ['generic', fileLink('Budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'PlexiiDeck cannot hold this kind of file. Drop it on a desk, or into PlexiiWrite as a link.'],
    ['folder', folderLink, 'A folder cannot go into PlexiiDeck. Drop it on a desk for a Drive work widget.'],
    ['document', docLink, 'A document cannot go into PlexiiDeck as a link. Drop it on a desk, or into PlexiiWrite to embed it.']
  ]
  for (const [name, f, reason] of cases) {
    it(`PlexiiDeck, ${name}`, () => {
      expect(convertForms([f], 'slide')).toEqual({ ok: false, reason })
    })
  }

  it('every refusing app names itself, and PlexiiCells says it holds values', () => {
    const video = fileLink('Demo.mp4', 'video/mp4')
    expect(convertForms([video], 'design')).toEqual({ ok: false, reason: REASON.designVideo })
    expect(REASON.designVideo).toBe('PlexiiDesign cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.')
    expect(convertForms([video], 'draw')).toEqual({ ok: false, reason: 'PlexiiDraw cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.' })
    expect(convertForms([video], 'diagram')).toEqual({ ok: false, reason: 'PlexiiDiagrams cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.' })
    expect(convertForms([video], 'sheet')).toEqual({ ok: false, reason: 'PlexiiCells holds values, not files. Drop it on a desk, or into PlexiiWrite as a link.' })
    expect(convertForms([folderLink], 'sheet')).toEqual({ ok: false, reason: 'A folder cannot go into PlexiiCells. Drop it on a desk for a Drive work widget.' })
  })

  it('work widgets: table and image', () => {
    expect(acceptForTable([folderLink], drop)).toEqual({ ok: false, reason: 'A folder cannot go into a table work widget. Drop it on a desk for a Drive work widget.' })
    expect(acceptForTable([fileLink('Q3.pdf', 'application/pdf')], drop)).toEqual({ ok: false, reason: 'A table work widget holds values, and this file has none.' })
    expect(acceptForImage([fileLink('Demo.mp4', 'video/mp4')], drop)).toEqual({ ok: false, reason: 'An image work widget holds a picture, and this has none.' })
    expect(acceptForImage([folderLink], drop)).toEqual({ ok: false, reason: REASON.imageFolder })
  })

  it('a link beside a picture: the picture wins where pictures are held, the pictures line where they are not', () => {
    const pdf: Form[] = [fileLink('Q3.pdf', 'application/pdf'), { kind: 'image', value: { src: F.PNG }, lossy: [PDF_FIRST_PAGE] }]
    const deck = convertForms(pdf, 'slide')
    expect(deck.ok && deck.lossy).toEqual([PDF_FIRST_PAGE])
    expect(convertForms(pdf, 'sheet')).toEqual({ ok: false, reason: REASON.cellsNoPictures })
  })

  it('linkFileKind and linkReason read the type first, then the name', () => {
    expect(linkFileKind({ href: '', title: 'a.wav', target: 'file' })).toBe('audio')
    expect(linkFileKind({ href: '', title: 'a', target: 'file', mime: 'video/webm' })).toBe('video')
    expect(linkFileKind({ href: '', title: 'a.zip', target: 'file' })).toBe('file')
    expect(linkReason({ href: '', title: 'x', target: 'folder', mime: 'video/mp4' }, 'draw')).toBe(REASON.drawFolder)
  })

  it('no refusal line has an em dash, and every one says "work widget" where it names one', () => {
    for (const r of Object.values(REASON)) {
      expect(r).not.toMatch(/—/)
      expect(r).not.toMatch(/\bwidget\b(?<!work widget)/)
    }
  })
})

// ── 2. A picture from Files keeps its row ────────────────────────────────────

describe('a picture that is already a row in Files is never stored again', () => {
  it('work widget acceptors refer to fb-file://<id>', () => {
    const page = acceptForPage([pictureFromFiles], drop)
    expect(page.ok && JSON.stringify(page.nodes)).toContain(`"src":"fb-file://${FILE_ID}"`)
    const md = acceptForMarkdown([pictureFromFiles], drop)
    expect(md.ok && md.markdown).toBe(`![Receipt.png](fb-file://${FILE_ID})`)
    const img = acceptForImage([pictureFromFiles], drop)
    expect(img).toEqual({ ok: true, picture: { src: `fb-file://${FILE_ID}`, width: 1, height: 1, alt: 'Receipt.png' }, lossy: [] })
  })

  it('office builders keep the data: URL (a document carries its pictures inline)', () => {
    for (const to of ['doc', 'slide', 'design', 'diagram'] as const) {
      const r = convertForms([pictureFromFiles], to)
      expect(r.ok && JSON.stringify(r.body), to).toContain(F.PNG)
      expect(r.ok && JSON.stringify(r.body), to).not.toContain('fb-file://')
    }
  })

  it('storing the landed page nodes ingests nothing', async () => {
    const page = acceptForPage([pictureFromFiles], drop)
    if (!page.ok) throw new Error(page.reason)
    const out = await storeNodePictures(page.nodes)
    expect(JSON.stringify(out.nodes)).toContain(`fb-file://${FILE_ID}`)
    expect(ingested).toEqual([])
  })

  it('storeDataPicture, pictureSrc and storeNodePictures honour fileId directly', async () => {
    expect(await storeDataPicture(F.PNG, 'Receipt', FILE_ID)).toBe(`fb-file://${FILE_ID}`)
    expect(await pictureSrc({ src: F.PNG, alt: 'Receipt', fileId: FILE_ID })).toEqual({ src: `fb-file://${FILE_ID}`, alt: 'Receipt' })
    const out = await storeNodePictures([{ type: 'image', attrs: { src: F.PNG, alt: 'R', fileId: FILE_ID } }])
    expect(out.nodes).toEqual([{ type: 'image', attrs: { src: `fb-file://${FILE_ID}`, alt: 'R' } }])
    expect(ingested).toEqual([])
    // Without a fileId the same picture IS stored, once.
    expect(await storeDataPicture(F.PNG, 'Receipt')).toBe('fb-file://stored-1')
    expect(ingested).toEqual(['Receipt.png'])
  })

  it('an id that is not a file id is ignored, and the bytes are stored as before', async () => {
    const out = await storeNodePictures([{ type: 'image', attrs: { src: F.PNG, alt: 'R', fileId: '../../etc' } }])
    expect(out.nodes).toEqual([{ type: 'image', attrs: { src: 'fb-file://stored-1', alt: 'R' } }])
    const page = acceptForPage([{ kind: 'image', value: { src: F.PNG, fileId: 'a b' }, lossy: [] }], drop)
    expect(page.ok && JSON.stringify(page.nodes)).toContain(F.PNG)
  })

  it('a desk image from Files refers to the row and ingests nothing', async () => {
    const create = vi.fn(async (w: Record<string, unknown>) => ({ id: 'w1', ...w }) as unknown as Widget)
    useWidgetStore.setState({ createOptional: create } as never)
    const plan = planDesk([pictureFromFiles], drop)
    if (!plan.ok) throw new Error(plan.reason)
    const placed = await placeDeskPlan(plan, { taskId: 't' })
    expect(placed.ok).toBe(true)
    expect(create.mock.calls[0][0]).toMatchObject({ kind: 'image', content: `fb-file://${FILE_ID}` })
    expect(ingested).toEqual([])
  })
})

// ── 3 and 4. "the original file" and PDF_FIRST_PAGE ──────────────────────────

describe('the notices a file drop shows', () => {
  it('an SVG from Files: "It becomes a picture: edit it in the original file."', () => {
    const svg: Form = { kind: 'svg', value: { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', width: 10, height: 10, vector: false, app: 'the original file' }, lossy: [] }
    for (const to of ['doc', 'slide', 'design', 'diagram'] as const) {
      const r = convertForms([svg], to)
      if (!r.ok) throw new Error(r.reason)
      expect(conversionNotice(null, to, r.lossy), to).toBe('It becomes a picture: edit it in the original file.')
    }
    const page = acceptForPage([svg], drop)
    expect(page.ok && page.lossy).toEqual(['It becomes a picture: edit it in the original file.'])
  })

  it('a PDF page: the line composes with nothing else', () => {
    expect(PDF_FIRST_PAGE).toBe('Only the first page comes in, as a picture.')
    const r = convertForms([{ kind: 'image', value: { src: F.PNG }, lossy: [PDF_FIRST_PAGE] }], 'doc')
    expect(r.ok && conversionNotice(null, 'doc', r.lossy)).toBe(PDF_FIRST_PAGE)
  })
})

// ── 5. The verb 'drop' ───────────────────────────────────────────────────────

describe('a refusal worded for a drop', () => {
  it('sticky and note', () => {
    expect(textWidgetRefusal('sticky', 'drop').reason).toBe('Stickies hold text. Drop on the desk to add it as an image.')
    expect(textWidgetRefusal('note', 'drop').reason).toBe('Notes hold text. Drop on the desk to add it as an image.')
    expect(acceptForTextWidget('sticky', [pictureFromFiles], drop)).toEqual({ ok: false, reason: 'Stickies hold text. Drop on the desk to add it as an image.' })
    // The other verbs are unchanged.
    expect(textWidgetRefusal('sticky', 'paste').reason).toBe('Stickies hold text. Paste on the desk to add it as an image.')
    expect(textWidgetRefusal('sticky', 'insert').reason).toBe('Stickies hold text. Insert it on the desk to add it as an image.')
  })

  it('nothing usable says "dropped", never "clipboard"', () => {
    expect(acceptForPage([], drop)).toEqual({ ok: false, reason: 'Nothing that was dropped can go in a page.' })
    expect(acceptForMarkdown([], drop)).toEqual({ ok: false, reason: 'Nothing that was dropped can go in a markdown work widget.' })
    expect(acceptForTable([], drop)).toEqual({ ok: false, reason: 'Nothing that was dropped reads as rows for this table.' })
    expect(planDesk([], drop)).toEqual({ ok: false, reason: 'Nothing that was dropped can be placed on a desk.' })
    expect(acceptForPage([], { verb: 'paste' })).toEqual({ ok: false, reason: 'Nothing on the clipboard can go in a page.' })
  })

  it('readDropForms: verb drop, a refused read verbatim, our own body kept', () => {
    expect(readDropForms({ forms: [], source: null, refused: 'This was dragged from a newer PlexiiDesk.' })).toEqual({
      forms: [],
      ctx: { verb: 'drop' },
      refused: 'This was dragged from a newer PlexiiDesk.'
    })
    const body = F.sheet()
    const r = readDropForms({ forms: [{ kind: 'native', value: body, lossy: [] }], source: 'PlexiiCells', kind: 'sheet' })
    expect(r.ctx).toEqual({ body, verb: 'drop' })
  })
})

// ── 6. dropForms on each widget hook ─────────────────────────────────────────

const widget = (id: string, kind: string, content = ''): Widget => ({ id, kind, title: '', content }) as unknown as Widget
const read = (forms: Form[], extra: Partial<FormsRead> = {}): FormsRead => ({ forms, source: null, ...extra })
const textForm = (t: string): Form => ({ kind: 'text', value: t, lossy: [] })

describe('textareaCaretAt', () => {
  it('uses caretPositionFromPoint when it answers inside the textarea, clamped to the text', () => {
    const ta = document.createElement('textarea')
    ta.value = 'Hello'
    document.body.appendChild(ta)
    const doc = document as Document & { caretPositionFromPoint?: unknown }
    doc.caretPositionFromPoint = () => ({ offsetNode: ta, offset: 2 })
    expect(textareaCaretAt(ta, 1, 1)).toBe(2)
    doc.caretPositionFromPoint = () => ({ offsetNode: ta, offset: 99 })
    expect(textareaCaretAt(ta, 1, 1)).toBe(5)
    doc.caretPositionFromPoint = () => ({ offsetNode: document.body, offset: 0 })
    // Neither answer is about this textarea, and jsdom has no caretRangeFromPoint: unknown, not a guess.
    expect(textareaCaretAt(ta, 1, 1)).toBeNull()
    delete doc.caretPositionFromPoint
    ta.remove()
  })
})

describe('dropForms', () => {
  let api: WidgetSnippets | null = null
  let textNow = ''
  let taEl: HTMLTextAreaElement | null = null

  function Sticky(): JSX.Element {
    const [text, setText] = useState('Hello')
    const ref = useRef<HTMLTextAreaElement | null>(null)
    textNow = text
    api = useTextWidgetSnippets(widget('s1', 'sticky'), 'sticky', () => text, (t) => setText(t), () => ref.current)
    return createElement('textarea', { ref: (el: HTMLTextAreaElement | null) => { ref.current = el; taEl = el }, value: text, onChange: () => {} })
  }

  const noticeBefore = (): unknown => useNoticeStore.getState()

  it('sticky: the caret moves to the drop point, then the text lands there', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(createElement(Sticky)))
    const doc = document as Document & { caretPositionFromPoint?: unknown }
    doc.caretPositionFromPoint = () => ({ offsetNode: taEl, offset: 2 })
    const before = noticeBefore()
    let res: unknown
    await act(async () => {
      res = await api!.dropForms(read([textForm('X')]), { clientX: 10, clientY: 10 })
    })
    expect(res).toBe(true)
    expect(textNow).toBe('He\nX\nllo')
    expect(useNoticeStore.getState()).toBe(before)
    delete doc.caretPositionFromPoint
    act(() => root.unmount())
    host.remove()
  })

  it('sticky: a refused read is returned verbatim and nothing changes; a picture says "Drop"', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(createElement(Sticky)))
    let res: unknown
    await act(async () => {
      res = await api!.dropForms(read([textForm('X')], { refused: 'This was dragged from a newer PlexiiDesk.' }))
    })
    expect(res).toEqual({ ok: false, reason: 'This was dragged from a newer PlexiiDesk.' })
    await act(async () => {
      res = await api!.dropForms(read([pictureFromFiles]))
    })
    expect(res).toEqual({ ok: false, reason: 'Stickies hold text. Drop on the desk to add it as an image.' })
    await act(async () => {
      res = await api!.dropForms(read([]))
    })
    expect(res).toEqual({ ok: false, reason: NOTHING_DROPPED })
    expect(textNow).toBe('Hello')
    act(() => root.unmount())
    host.remove()
  })

  it('page: posAtCoords places the cursor first, and the link lands there', async () => {
    const ed = new Editor({
      extensions: [StarterKit.configure({ link: false }), Link.configure({ openOnClick: false, ...WIDGET_LINK_OPTIONS })] as never,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Last' }] }] }
    })
    // Position 6 is the end of "First", before the second paragraph.
    const posAtCoords = vi.spyOn(ed.view, 'posAtCoords').mockReturnValue({ pos: 6, inside: -1 })
    let page: WidgetSnippets | null = null
    function Page(): null {
      page = useEditorWidgetSnippets(widget('p1', 'page'), 'page', ed as never)
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Page)))
    let res: unknown
    await act(async () => {
      res = await page!.dropForms(read([docLink]), { clientX: 40, clientY: 12 })
    })
    expect(posAtCoords).toHaveBeenCalledWith({ left: 40, top: 12 })
    expect(res).toBe(true)
    const texts = (ed.getJSON().content ?? []).map((n) => JSON.stringify(n))
    expect(texts[0]).toContain('First')
    expect(texts[1]).toContain('plexii://document/doc-42')
    expect(texts[texts.length - 1]).toContain('Last')
    // Without a point it lands where an insert would: at the end of a page nobody has clicked into.
    act(() => root.unmount())
    ed.destroy()
  })

  it('page: a refused read is returned before the cursor moves', async () => {
    const ed = new Editor({ extensions: [StarterKit] as never, content: '<p>Hi</p>' })
    const posAtCoords = vi.spyOn(ed.view, 'posAtCoords')
    let page: WidgetSnippets | null = null
    function Page(): null {
      page = useEditorWidgetSnippets(widget('p2', 'page'), 'page', ed as never)
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Page)))
    let res: unknown
    await act(async () => {
      res = await page!.dropForms(read([], { refused: 'No.' }), { clientX: 1, clientY: 1 })
    })
    expect(res).toEqual({ ok: false, reason: 'No.' })
    expect(posAtCoords).not.toHaveBeenCalled()
    act(() => root.unmount())
    ed.destroy()
  })

  it('image: a picture from Files replaces the picture by reference, nothing ingested', async () => {
    const update = vi.fn(async () => {})
    useWidgetStore.setState({ update } as never)
    let image: WidgetSnippets | null = null
    function Image(): null {
      image = useImageWidgetSnippets(widget('i1', 'image', 'fb-file://old'))
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Image)))
    let res: unknown
    await act(async () => {
      res = await image!.dropForms(read([pictureFromFiles]), { clientX: 0, clientY: 0 })
    })
    expect(res).toBe(true)
    expect(update).toHaveBeenCalledWith('i1', { content: `fb-file://${FILE_ID}` })
    expect(ingested).toEqual([])
    await act(async () => {
      res = await image!.dropForms(read([folderLink]))
    })
    expect(res).toEqual({ ok: false, reason: REASON.imageFolder })
    act(() => root.unmount())
  })
})
