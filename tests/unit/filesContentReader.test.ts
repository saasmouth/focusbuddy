import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as F from './snippetConvertFixtures'

// The renderer half of a content drop from Files:
//   readFilesDragForms   reads only what the target uses, under the caps,
//                        renders a PDF's first page with Draw's renderer,
//                        and returns a FormsRead with verb 'drop';
//   documentSnippetBody  a whole stored document as a snippet body, per type;
//   runContentDrop       one line per drop, gathered from each item;
//   openMention          folder, file and document links go where they name.

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 99, 162, 74, 174, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><circle cx="5" cy="5" r="4"/></svg>'

const store = new Map<string, { mimeType: string; bytes: Uint8Array }>()
const docs = new Map<string, unknown>()
const api = {
  files: { read: vi.fn(async (id: string) => {
    const f = store.get(id)
    return f ? { mimeType: f.mimeType, buffer: f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) } : null
  }) },
  draw: { pdfPage: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,AAAA', w: 595, h: 842, pages: 3 })) },
  documents: { get: vi.fn(async (id: string) => docs.get(id) ?? null) },
  fileManager: { get: vi.fn(async (id: string) => ({ id, parentId: 'parent-1', kind: 'file', name: 'x', createdAt: 0, updatedAt: 0 })), list: vi.fn(async () => []), path: vi.fn(async () => []) }
}
;(window as unknown as { api: unknown }).api = api

beforeEach(() => {
  store.clear()
  docs.clear()
  for (const f of [api.files.read, api.draw.pdfPage, api.documents.get]) f.mockClear()
})

const ref = (o: Record<string, unknown>) => ({ entryId: 'f1', kind: 'file', name: 'x', ...o }) as never

describe('readFilesDragForms', () => {
  it('a picture: bytes read, sniffed by what they are, data URL with its pixel size and the same file id', async () => {
    store.set('f1', { mimeType: 'image/png', bytes: PNG_BYTES })
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    const r = await readFilesDragForms(ref({ name: 'dot.png', mimeType: 'image/png', sizeBytes: PNG_BYTES.length }), { target: 'doc' })
    expect(r.verb).toBe('drop')
    expect(r.forms[0]).toMatchObject({ kind: 'image', value: { width: 2, height: 3, fileId: 'f1', alt: 'dot.png' } })
    expect((r.forms[0] as { value: { src: string } }).value.src).toMatch(/^data:image\/png;base64,/)
  })

  it('an SVG: its markup and its size from the viewBox, edited in the original file', async () => {
    store.set('f1', { mimeType: 'image/svg+xml', bytes: new TextEncoder().encode(SVG) })
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    const r = await readFilesDragForms(ref({ name: 'logo.svg', mimeType: 'image/svg+xml' }), { target: 'slide' })
    expect(r.forms[0]).toMatchObject({ kind: 'svg', value: { width: 64, height: 32, app: 'the original file', vector: true } })
  })

  it("a PDF: its first page rendered by Draw's renderer, with the plan's lossy line", async () => {
    store.set('f1', { mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%%EOF') })
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    const r = await readFilesDragForms(ref({ name: 'brief.pdf', mimeType: 'application/pdf' }), { target: 'slide' })
    expect(api.draw.pdfPage).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }))
    expect(r.forms[0]).toMatchObject({ kind: 'image', lossy: ['Only the first page comes in, as a picture.'], value: { width: 595, height: 842 } })
    expect(r.forms[1]).toMatchObject({ kind: 'link' })
  })

  it('reads nothing when the target takes only the link (a PDF into Write, a folder anywhere)', async () => {
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    const r = await readFilesDragForms(ref({ name: 'brief.pdf', mimeType: 'application/pdf' }), { target: 'doc' })
    expect(api.files.read).not.toHaveBeenCalled()
    expect(r.forms.map((f) => f.kind)).toEqual(['link'])
    await readFilesDragForms({ entryId: 'd', kind: 'folder', name: 'Plans' } as never, { target: 'slide' })
    expect(api.files.read).not.toHaveBeenCalled()
  })

  it('never reads a text file over 1 MB or a picture over the cap', async () => {
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    const t = await readFilesDragForms(ref({ name: 'big.txt', mimeType: 'text/plain', sizeBytes: 3 * 1024 * 1024 }), { target: 'doc' })
    expect(t.forms[0]).toMatchObject({ kind: 'link', lossy: ['This file is too long to insert, so it was added as a link.'] })
    const p = await readFilesDragForms(ref({ name: 'huge.png', mimeType: 'image/png', sizeBytes: 30 * 1024 * 1024 }), { target: 'slide' })
    expect(p.refused).toBe('This picture is 30 MB. PlexiiDeck takes pictures up to 20 MB.')
    expect(api.files.read).not.toHaveBeenCalled()
  })

  it('bytes not on this device: the link, said so', async () => {
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    const r = await readFilesDragForms(ref({ name: 'gone.png', mimeType: 'image/png', sizeBytes: 10 }), { target: 'page' })
    expect(r.forms).toEqual([expect.objectContaining({ kind: 'link', lossy: ["This file's contents are not on this device yet, so it can only be added as a link."] })])
  })

  it('read-only and a document into itself refuse before anything is read', async () => {
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    expect((await readFilesDragForms(ref({ name: 'a.png', mimeType: 'image/png' }), { target: 'doc', readOnly: true })).refused).toBe('This document is read-only, so nothing can be added to it.')
    expect((await readFilesDragForms({ entryId: 'e', kind: 'doc', name: 'Me', docId: 'me', docType: 'doc' } as never, { target: 'doc', alt: true, ownDocumentId: 'me' })).refused).toBe('A document cannot go inside itself.')
    expect(api.files.read).not.toHaveBeenCalled()
    expect(api.documents.get).not.toHaveBeenCalled()
  })

  it('a document with ⌥: its stored body through its app’s own capture, native first, with what the copy leaves out', async () => {
    docs.set('deck-1', { id: 'deck-1', docType: 'slides', title: 'Pitch', body: { slides: [
      { id: 's1', elements: F.slide().elements, notes: '' },
      { id: 's2', elements: [], notes: '' }
    ] } })
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    const r = await readFilesDragForms({ entryId: 'e', kind: 'doc', name: 'Pitch', docId: 'deck-1', docType: 'slides' } as never, { target: 'doc', alt: true })
    expect(r.kind).toBe('slide')
    expect(r.forms[0]).toMatchObject({ kind: 'native', value: { kind: 'slide' } })
    expect(r.forms.slice(1).every((f) => f.kind === 'link' || f.lossy.includes('Only the first slide comes in.'))).toBe(true)
  })
})

describe('documentSnippetBody: each stored type as its app captures it', () => {
  it('doc, sheet (first tab used range), map (page 1), widget file', async () => {
    const { documentSnippetBody } = await import('../../src/renderer/src/lib/documentSnippetBody')
    const doc = documentSnippetBody({ docType: 'doc', title: 'D', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] } as never })
    expect(doc.body).toMatchObject({ kind: 'doc', text: 'Hi' })
    const sheet = documentSnippetBody({ docType: 'sheet', title: 'S', body: { version: 2, activeSheet: 0, sheets: [
      { id: 't1', name: 'One', columns: ['A', 'B', 'C'], rows: [['a', 'b', ''], ['1', '=A2*2', ''], ['', '', '']] },
      { id: 't2', name: 'Two', columns: ['A'], rows: [['x']] }
    ] } as never })
    expect(sheet.body).toMatchObject({ kind: 'sheet', rows: [['a', 'b'], ['1', '=A2*2']] })
    expect(sheet.lossy).toEqual(['Only the first sheet comes in.'])
    const map = documentSnippetBody({ docType: 'map', title: 'M', body: { nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: { label: 'Start' } }], edges: [] } as never })
    expect(map.body).toMatchObject({ kind: 'diagram' })
    const wf = documentSnippetBody({ docType: 'widget', title: 'Call the bank', body: { v: 1, kind: 'sticky', content: 'Call the bank', color: null, titleSource: 'user' } as never })
    expect(wf.body).toMatchObject({ kind: 'widget', widgetKind: 'sticky', title: 'Call the bank', content: 'Call the bank' })
  })
  it('a body this build cannot read is no content, never a guess', async () => {
    const { documentSnippetBody } = await import('../../src/renderer/src/lib/documentSnippetBody')
    expect(documentSnippetBody({ docType: 'widget', title: 'x', body: 'not json' as never }).body).toBeNull()
    expect(documentSnippetBody({ docType: 'sheet', title: 'x', body: { version: 2, sheets: [] } as never }).body).toBeNull()
  })
})

describe('one line per drop', () => {
  it('composes what landed, what could not, and what was lost', async () => {
    const { dropLine } = await import('../../src/renderer/src/lib/filesContentDrop')
    const r = (name: string) => ({ entryId: name, kind: 'file', name }) as never
    expect(dropLine([{ ref: r('a'), landed: true, lines: [] }])).toBeNull()
    expect(dropLine([{ ref: r('a'), landed: true, lines: ['Only the first page comes in, as a picture.'] }])).toBe('Only the first page comes in, as a picture.')
    expect(dropLine([{ ref: r('a'), landed: false, reason: 'PlexiiCells holds values, not pictures.', lines: [] }])).toBe('PlexiiCells holds values, not pictures.')
    expect(
      dropLine([
        { ref: r('a'), landed: true, lines: [] },
        { ref: r('b'), landed: true, lines: [] },
        { ref: r('c'), landed: true, lines: [] },
        { ref: r('d'), landed: false, reason: 'PlexiiCells holds values, not pictures.', lines: [] },
        { ref: r('e'), landed: false, reason: 'PlexiiCells holds values, not pictures.', lines: [] }
      ])
    ).toBe('3 added. 2 could not go in: PlexiiCells holds values, not pictures.')
  })
  it("the app's own announcements during a drop are gathered, not shown", async () => {
    const { collectNotices, announceConverted, announceRefused } = await import('../../src/renderer/src/lib/convertedNotice')
    const { useNoticeStore } = await import('../../src/renderer/src/stores/notice')
    useNoticeStore.getState().clear()
    const { notices } = await collectNotices(async () => {
      announceConverted('Formulas become their values.')
      announceRefused('Nope.')
    })
    expect(notices).toEqual([{ kind: 'converted', text: 'Formulas become their values.' }, { kind: 'refused', text: 'Nope.' }])
    expect(useNoticeStore.getState().notice).toBeNull()
    announceConverted('Shown again.')
    expect(useNoticeStore.getState().notice?.text).toBe('Shown again.')
  })
})

describe('plexii:// links dropped from Files open what they name', () => {
  it('a folder opens Files at it; a document opens it; a file opens Files at its folder, selected', async () => {
    const { openPlexiiHref } = await import('../../src/renderer/src/components/MentionText')
    const { useViewStore } = await import('../../src/renderer/src/stores/view')
    const { useFileManagerStore } = await import('../../src/renderer/src/stores/fileManager')
    const go = { goFiles: vi.fn(), goDocument: vi.fn() }
    useViewStore.setState(go as never)
    const openFolder = vi.fn(async () => undefined)
    const select = vi.fn()
    useFileManagerStore.setState({ openFolder, select } as never)
    expect(openPlexiiHref('plexii://folder/dir%201')).toBe(true)
    expect(go.goFiles).toHaveBeenCalled()
    expect(openFolder).toHaveBeenCalledWith('dir 1')
    expect(openPlexiiHref('plexii://document/doc-9')).toBe(true)
    expect(go.goDocument).toHaveBeenCalledWith('doc-9')
    expect(openPlexiiHref('plexii://file/f-7')).toBe(true)
    await vi.waitFor(() => expect(select).toHaveBeenCalledWith('f-7'))
    expect(openFolder).toHaveBeenLastCalledWith('parent-1')
    expect(openPlexiiHref('https://example.com')).toBe(false)
  })
})

describe('a stored body the converters cannot read', () => {
  it('is no content: the link stands, the drop does not break', async () => {
    docs.set('bad', { id: 'bad', docType: 'slides', title: 'Bad', body: { slides: [{ id: 's', elements: [{ id: 'e', type: 'text', x: 0, y: 0, w: 10, h: 10, paragraphs: [{}] }], notes: '' }] } })
    const { readFilesDragForms } = await import('../../src/renderer/src/lib/filesDragForms')
    const r = await readFilesDragForms({ entryId: 'e', kind: 'doc', name: 'Bad', docId: 'bad', docType: 'slides' } as never, { target: 'slide' })
    expect(r.forms.map((f) => f.kind)).toEqual(['link'])
  })
})
