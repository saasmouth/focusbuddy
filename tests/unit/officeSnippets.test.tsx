// Any snippet into every office app (renderer/src/lib/officeSnippets.ts and
// the six targets): a same-kind insert runs the target's own insert UNCHANGED;
// another kind is converted to the host's kind and goes through that same
// insert, returning the conversion's one line; a refused pair returns the
// builder's reason verbatim; and what each target offers is exactly
// acceptsFor(host), so the library can never offer what conversion refuses.

import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildDocExtensions } from '../../src/renderer/src/components/documents/editor/extensions'
import { insertIntoOffice, officeAccepts, prepareSnippetBody } from '../../src/renderer/src/lib/officeSnippets'
import { docSnippetTarget, DOC_LIVE_CONVERTED } from '../../src/renderer/src/components/documents/editor/docSnippets'
import { cellsSnippetTarget } from '../../src/renderer/src/components/documents/sheet/cellsSnippets'
import { deckSnippetTarget } from '../../src/renderer/src/components/documents/slides/deckSnippets'
import { designSnippetTarget } from '../../src/renderer/src/components/documents/design/designSnippets'
import { diagramSnippetTarget } from '../../src/renderer/src/components/documents/diagram/diagramSnippets'
import { drawSnippetTarget } from '../../src/renderer/src/components/documents/draw/editor/drawSnippets'
import { acceptsFor } from '../../src/shared/snippetConvert/accepts'
import { REASON } from '../../src/shared/snippetConvert/common'
import { snippetConvertDeps } from '../../src/renderer/src/lib/snippetConvertDeps'
import { linkModesFor, type Snippet, type SnippetBody, type SnippetHostKind, type SnippetInsertResult, type SnippetTarget } from '../../src/shared/snippets'
import { harness } from './drawTools/harness'
import * as F from './snippetConvertFixtures'

function snip(body: SnippetBody, name = 'Block'): Snippet {
  return { id: `s-${body.kind}`, kind: body.kind, name, description: null, body, tags: [], scope: 'personal', orgId: 'personal', authorId: null, revision: 1, usageCount: 0, createdAt: 0, updatedAt: 0 } as unknown as Snippet
}

const PIC = 'It becomes a picture: edit it in PlexiiDraw.'

describe('insertIntoOffice', () => {
  it('a native snippet goes to the target’s own insert untouched, sync result and all', () => {
    const s = snip(F.sheet())
    const own = vi.fn(() => true as SnippetInsertResult)
    expect(insertIntoOffice(s, 'duplicate', 'sheet', own)).toBe(true)
    expect(own).toHaveBeenCalledWith(s, 'duplicate')
    const refuse = (): SnippetInsertResult => ({ ok: false, reason: 'A1 would point above row 1.' })
    expect(insertIntoOffice(s, 'duplicate', 'sheet', refuse)).toEqual({ ok: false, reason: 'A1 would point above row 1.' })
  })

  it('another kind is converted, inserted through the same path, and says so in one line', () => {
    const own = vi.fn((_s: Snippet) => true as SnippetInsertResult)
    const out = insertIntoOffice(snip(F.draw(), 'Logo'), 'duplicate', 'doc', own)
    expect(out).toEqual({ ok: true, notice: PIC })
    const passed = own.mock.calls[0][0]
    expect(passed.kind).toBe('doc')
    expect(passed.body.kind).toBe('doc')
    expect(passed.name).toBe('Logo')
  })

  it('a refused pair returns the builder’s reason verbatim and never calls the insert', () => {
    const own = vi.fn(() => true as SnippetInsertResult)
    expect(insertIntoOffice(snip(F.slide()), 'duplicate', 'sheet', own)).toEqual({ ok: false, reason: REASON.cellsNoPictures })
    expect(own).not.toHaveBeenCalled()
  })

  it('a converted insert the target declines stays declined; a live request for a converted kind is refused', async () => {
    expect(insertIntoOffice(snip(F.doc()), 'duplicate', 'slide', () => false)).toBe(false)
    expect(await insertIntoOffice(snip(F.doc()), 'duplicate', 'slide', async () => true)).toEqual({ ok: true, notice: expect.any(String) })
    expect(insertIntoOffice(snip(F.doc()), 'live', 'slide', () => true)).toEqual({ ok: false, reason: 'This kind of snippet can only be inserted here as a copy.' })
  })

  it('prepareSnippetBody: native as is, converted with its line, refused with its reason', () => {
    const d = F.doc()
    expect(prepareSnippetBody(d, 'doc')).toEqual({ ok: true, body: d, notice: null })
    const c = prepareSnippetBody(F.sheet(), 'slide')
    expect(c.ok && c.body.kind).toBe('slide')
    expect(prepareSnippetBody(F.draw(), 'sheet')).toEqual({ ok: false, reason: REASON.cellsNoPictures })
  })
})

describe('what every office target offers is acceptsFor(host)', () => {
  const targets: Array<[SnippetHostKind, SnippetTarget]> = [
    ['sheet', cellsSnippetTarget('i', 'T', () => true)],
    ['slide', deckSnippetTarget('i', 'T', () => true)],
    ['design', designSnippetTarget('i', 'T', () => true)],
    ['diagram', diagramSnippetTarget('i', 'T', { readOnly: false, insertBody: () => true })]
  ]
  it.each(targets)('%s', (host, t) => {
    expect(t.host).toBe(host)
    expect(t.accepts).toEqual(acceptsFor(host, snippetConvertDeps()))
    expect(officeAccepts(host)).toBe(officeAccepts(host)) // one array, so the library does not refresh each render
    for (const k of t.accepts) expect(linkModesFor(t, k)).toEqual(['duplicate'])
  })
})

describe('each target’s cross-kind insert', () => {
  it('PlexiiCells: a document’s table lands as rows through the sheet insert; a picture is refused', () => {
    const insert = vi.fn((_s: Snippet) => true as SnippetInsertResult)
    const t = cellsSnippetTarget('i', 'Budget', insert)
    expect(t.insert(snip(F.doc()), 'duplicate')).toEqual({ ok: true, notice: expect.any(String) })
    const body = insert.mock.calls[0][0].body as { kind: string; rows: string[][]; origin?: unknown }
    expect(body.kind).toBe('sheet')
    expect(body.rows).toEqual([['Item', 'Price'], ['Design', '1200']])
    expect(body.origin).toBeUndefined() // written literally, as an external paste
    expect(t.insert(snip(F.diagram()), 'duplicate')).toEqual({ ok: false, reason: REASON.cellsNoPictures })
  })

  it('PlexiiDeck: a sheet block lands as Deck’s table with computed values', () => {
    const insert = vi.fn((_s: Snippet) => true)
    const t = deckSnippetTarget('i', 'Q3', insert)
    expect(t.insert(snip(F.sheet()), 'duplicate')).toEqual({ ok: true, notice: 'Formulas become their values. Cell formatting is not kept.' })
    const el = (insert.mock.calls[0][0].body as { elements: Array<{ type: string; cells: string[][] }> }).elements[0]
    expect(el.type).toBe('table')
    expect(el.cells[3]).toEqual(['Sum', '', '', '26'])
  })

  it('PlexiiDesign: a document lands as a text frame reading a new story', () => {
    const insert = vi.fn((_s: Snippet) => true)
    const t = designSnippetTarget('i', 'Brochure', insert)
    const out = t.insert(snip(F.doc()), 'duplicate') as { ok: true; notice: string }
    expect(out.ok).toBe(true)
    const body = insert.mock.calls[0][0].body as { kind: string; elements: Array<{ storyId?: string }>; stories: Record<string, unknown> }
    expect(body.kind).toBe('design')
    expect(Object.keys(body.stories)).toEqual([body.elements[0].storyId])
  })

  it('PlexiiDiagrams: a sheet block lands as a table shape through the diagram insert; a read-only diagram still declines', () => {
    const insertBody = vi.fn(() => true)
    const t = diagramSnippetTarget('i', 'Flow', { readOnly: false, insertBody })
    expect(t.insert(snip(F.sheet()), 'duplicate')).toMatchObject({ ok: true })
    const body = (insertBody.mock.calls[0] as unknown as [{ nodes: Array<{ shape: string; cells: string[][] }> }])[0]
    expect(body.nodes[0].shape).toBe('table-header')
    expect(body.nodes[0].cells[1]).toEqual(['Pens', '2', '3', '6'])
    const ro = diagramSnippetTarget('i', 'Flow', { readOnly: true, insertBody })
    expect(ro.insert(snip(F.sheet()), 'duplicate')).toBe(false)
  })

  it('PlexiiDraw: a slide lands in the drawing as a picture object with its bytes; a sheet as a picture of its table', () => {
    const h = harness({ schemaVersion: 2, minWriterVersion: 2, artboards: [{ id: 'ab1', name: 'A', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#fff' } }], activeLayerId: 'L1', layers: [{ id: 'L1', kind: 'vector', name: 'L', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] }], assets: {}, swatches: [], guides: [], settings: {} })
    const t = drawSnippetTarget(h.ed.ctx, 'Poster')
    expect(t.accepts).toEqual(acceptsFor('draw', snippetConvertDeps()))
    const out = t.insert(snip(F.slide()), 'duplicate')
    expect(out).toEqual({ ok: true, notice: 'It becomes a picture: edit it in PlexiiDeck.' })
    const objs = h.objects()
    expect(objs).toHaveLength(1)
    expect(objs[0].type).toBe('image')
    const assetId = (objs[0] as { assetId: string }).assetId
    expect(h.doc().assets[assetId].dataUrl.startsWith('data:image/svg+xml')).toBe(true)
    const sheet = t.insert(snip(F.sheet()), 'duplicate')
    expect(sheet).toMatchObject({ ok: true })
    expect((sheet as { notice?: string }).notice).toContain('It becomes a picture: edit it in PlexiiCells.')
    const after = h.objects()
    expect(after).toHaveLength(2)
    expect(after[1].type).toBe('image')
    expect(h.doc().assets[(after[1] as { assetId: string }).assetId].dataUrl.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('PlexiiWrite: a drawing lands as an image node and a sheet as a table, in a real editor', () => {
    const editor = new Editor({ extensions: buildDocExtensions({ interactive: false }) as never, content: '<p>Intro</p>' })
    try {
      const t = docSnippetTarget(editor as never, 'i', 'Report')
      expect(t.host).toBe('doc')
      expect(t.accepts).toEqual(acceptsFor('doc', snippetConvertDeps()))
      editor.commands.focus('end')
      expect(t.insert(snip(F.draw(), 'Logo'), 'duplicate')).toEqual({ ok: true, notice: PIC })
      editor.commands.focus('end')
      expect(t.insert(snip(F.sheet()), 'duplicate')).toMatchObject({ ok: true })
      const json = JSON.stringify(editor.getJSON())
      const img = (editor.getJSON().content ?? []).find((n) => n.type === 'image')
      expect(String(img?.attrs?.src)).toMatch(/^data:image\/svg\+xml;base64,/)
      expect(json).toContain('"type":"table"')
      expect(json).toContain('"text":"26"')
    } finally {
      editor.destroy()
    }
  })

  it('PlexiiWrite: Live is offered for a doc snippet only until converted live instances are proven', () => {
    const editor = new Editor({ extensions: buildDocExtensions({ interactive: false }) as never, content: '<p>x</p>' })
    try {
      const t = docSnippetTarget(editor as never, 'i', '')
      expect(linkModesFor(t, 'doc')).toEqual(['duplicate', 'live'])
      expect(linkModesFor(t, 'sheet')).toEqual(DOC_LIVE_CONVERTED ? ['duplicate', 'live'] : ['duplicate'])
      if (!DOC_LIVE_CONVERTED) {
        expect(t.insert(snip(F.sheet()), 'live')).toEqual({ ok: false, reason: 'This kind of snippet can only be inserted into a document as a copy for now.' })
      }
    } finally {
      editor.destroy()
    }
  })
})
