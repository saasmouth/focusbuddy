// Every content cell of the Files plan's matrix (§4.3 office apps, §4.4 work
// widgets), plain drop AND ⌥, end to end over the REAL code: a ref and what
// the reader read (tiny real fixtures) → shared/fileForms formsForTarget →
// the real office builders (convertForms, verb 'drop') or the real work widget
// acceptors (acceptFor via readDropForms, as dropForms runs them).
//
// Each cell names what must happen: the target holds a LINK (a Write link or
// DocEmbed card, a page or markdown link, "title (href)" in a sticky), a COPY
// of the content, or a REFUSAL with its sentence verbatim. So the matrix in
// the plan, the choice of forms here, and 2e's builders cannot drift apart
// without this failing.

import { describe, expect, it, vi } from 'vitest'
import { convertForms } from '../../src/shared/snippetConvert'
import { formsOf, PDF_FIRST_PAGE, type Form } from '../../src/shared/snippetForms'
import { REASON } from '../../src/shared/snippetConvert/common'
import { IMAGE_NEEDS_PICTURE, TABLE_NO_PICTURES, type WidgetTargetKind } from '../../src/shared/snippetWidgets'
import { acceptFor, readDropForms } from '../../src/renderer/src/lib/widgetSnippetInsert'
import {
  NOTICE_BYTES_MISSING,
  NOTICE_TOO_LONG,
  REASON_INTO_ITSELF,
  REASON_READ_ONLY,
  formsForTarget,
  nativeKind,
  parseDelimited,
  type ContentTarget,
  type FileContent
} from '../../src/shared/fileForms'
import type { FileDragRef } from '../../src/shared/filesDragPayload'
import type { SnippetKind } from '../../src/shared/snippets'
import * as F from './snippetConvertFixtures'
import { formsOfSheet } from '../../src/shared/snippetForms/fromSheet'
import { sheetFromXlsxBytes } from '../../src/main/sheetXlsxRead'
import { plainWorkbook } from './xlsxDropFixtures'

// The main-process reader is driven in-process with a real workbook; its file
// store is not reached (the bytes are handed to it).
vi.mock('../../src/main/db/files', () => ({ getFile: () => null, readFileBytes: async () => null }))

/** What the drop reader makes of a real .xlsx: its first sheet's forms (filesDragForms readWorkbook). */
function xlsxForms(): Form[] {
  const r = sheetFromXlsxBytes(plainWorkbook())
  if (!r.ok) throw new Error(r.reason)
  return formsOfSheet(r.body, F.DEPS, { app: 'the original file' })
}

// ── Sources: a ref, and what the reader would have read for it ──────────────

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#36c"/></svg>'
const CSV = 'name,score\nAda,"9,5"\n'

interface Source {
  ref: FileDragRef
  content: FileContent
}

const file = (id: string, name: string, mime: string, size = 100): FileDragRef => ({ entryId: id, kind: 'file', name, mimeType: mime, ext: name.split('.').pop(), sizeBytes: size })
const docRef = (id: string, docType: FileDragRef['docType'], name: string): FileDragRef => ({ entryId: `e-${id}`, kind: 'doc', name, docId: id, docType })
const docForms = (b: Parameters<typeof formsOf>[0]): Form[] => formsOf(b, F.DEPS)

const SRC: Record<string, Source> = {
  image: { ref: file('png1', 'dot.png', 'image/png', 68), content: { sizeBytes: 68, picture: { src: F.PNG, width: 1, height: 1 } } },
  svg: { ref: file('svg1', 'logo.svg', 'image/svg+xml', SVG.length), content: { sizeBytes: SVG.length, svg: { text: SVG, width: 40, height: 20 } } },
  pdf: { ref: file('pdf1', 'brief.pdf', 'application/pdf', 900), content: { sizeBytes: 900, picture: { src: F.PNG, width: 595, height: 842 } } },
  write: { ref: docRef('d-doc', 'doc', 'Plan'), content: { docForms: docForms(F.doc()) } },
  cells: { ref: docRef('d-sheet', 'sheet', 'Budget'), content: { docForms: docForms(F.sheet()) } },
  deck: { ref: docRef('d-slides', 'slides', 'Pitch'), content: { docForms: docForms(F.slide()) } },
  design: { ref: docRef('d-design', 'design', 'Flyer'), content: { docForms: docForms(F.design()) } },
  draw: { ref: docRef('d-draw', 'draw', 'Logo art'), content: { docForms: docForms(F.draw()) } },
  diagram: { ref: docRef('d-map', 'map', 'Flow'), content: { docForms: docForms(F.diagram()) } },
  widget: { ref: docRef('d-wf', 'widget', 'Call the bank'), content: { docForms: docForms(F.STICKY) } },
  video: { ref: file('mp4', 'demo.mp4', 'video/mp4', 5_000_000), content: {} },
  audio: { ref: file('m4a', 'memo.m4a', 'audio/mp4', 900_000), content: {} },
  md: { ref: file('md1', 'notes.md', 'text/markdown', 40), content: { sizeBytes: 40, text: '# Notes\n\nShip **today**.\n' } },
  csv: { ref: file('csv1', 'scores.csv', 'text/csv', CSV.length), content: { sizeBytes: CSV.length, text: CSV } },
  xlsx: { ref: file('xlsx1', 'scores.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 9000), content: { sizeBytes: 9000, docForms: xlsxForms() } },
  txt: { ref: file('txt1', 'todo.txt', 'text/plain', 20), content: { sizeBytes: 20, text: 'Buy milk\nCall Ada' } },
  generic: { ref: file('zip1', 'bundle.zip', 'application/zip', 9000), content: {} },
  folder: { ref: { entryId: 'dir1', kind: 'folder', name: 'Brand assets' }, content: {} }
}

// ── What a target did with the forms ────────────────────────────────────────

type Verdict = 'link' | 'copy' | `refuse:${string}`

const OFFICE = new Set<ContentTarget>(['doc', 'sheet', 'slide', 'design', 'diagram', 'draw'])

function hasLinkMark(nodes: unknown): boolean {
  const json = JSON.stringify(nodes)
  return json.includes('"docEmbed"') || /"type":"link","attrs":\{"href":"plexii:\/\//.test(json)
}

function verdict(target: ContentTarget, forms: Form[]): Verdict {
  if (OFFICE.has(target)) {
    const out = convertForms(forms, target as SnippetKind, F.DEPS, undefined, { verb: 'drop' })
    if (!out.ok) return `refuse:${out.reason}`
    if (out.body.kind === 'doc' && hasLinkMark(out.body.content)) return 'link'
    return 'copy'
  }
  const r = readDropForms({ forms, source: null, kind: (nativeKind(forms) as SnippetKind | null) ?? null, verb: 'drop' })
  const a = acceptFor(target as WidgetTargetKind, r.forms, r.ctx) as { ok: boolean; reason?: string; nodes?: unknown; markdown?: string; text?: string }
  if (!a.ok) return `refuse:${a.reason}`
  if (a.nodes !== undefined) return hasLinkMark(a.nodes) ? 'link' : 'copy'
  if (a.markdown !== undefined) return a.markdown.includes('](plexii://') ? 'link' : 'copy'
  if (a.text !== undefined) return a.text.includes('(plexii://') ? 'link' : 'copy'
  return 'copy'
}

function run(source: string, target: ContentTarget, alt: boolean): Verdict {
  const s = SRC[source]!
  const r = formsForTarget(s.ref, s.content, { target, alt })
  if (r.refused) return `refuse:${r.refused}`
  return verdict(target, r.forms)
}

// ── The matrix: [plain drop, ⌥ drop] per source, per target ─────────────────

const L: Verdict = 'link'
const C: Verdict = 'copy'
const R = (s: string): Verdict => `refuse:${s}`

const cannot = (app: string, what: string): Verdict => R(`${app} cannot hold ${what}. Drop it on a desk, or into PlexiiWrite as a link.`)
const folderTo = (where: string): Verdict => R(`A folder cannot go into ${where}. Drop it on a desk for a Drive work widget.`)

type Row = Record<string, [Verdict, Verdict]>

const MATRIX: Record<ContentTarget, Row> = {
  // §4.3 PlexiiWrite: content files copy (⌥ link); documents and media link (⌥ copy).
  doc: {
    image: [C, L], svg: [C, L], pdf: [L, C],
    write: [L, C], cells: [L, C], deck: [L, C], design: [L, C], draw: [L, C], diagram: [L, C], widget: [L, C],
    video: [L, L], audio: [L, L], md: [C, L], csv: [C, L], xlsx: [C, L], txt: [C, L], generic: [L, L], folder: [L, L]
  },
  // PlexiiDeck: content, never a link; what it cannot hold is refused with where it can go.
  slide: {
    image: [C, C], svg: [C, C], pdf: [C, C],
    write: [C, C], cells: [C, C], deck: [C, C], design: [C, C], draw: [C, C], diagram: [C, C], widget: [C, C],
    video: [cannot('PlexiiDeck', 'a video file'), cannot('PlexiiDeck', 'a video file')],
    audio: [cannot('PlexiiDeck', 'an audio file'), cannot('PlexiiDeck', 'an audio file')],
    md: [C, C], csv: [C, C], xlsx: [C, C], txt: [C, C],
    generic: [cannot('PlexiiDeck', 'this kind of file'), cannot('PlexiiDeck', 'this kind of file')],
    folder: [folderTo('PlexiiDeck'), folderTo('PlexiiDeck')]
  },
  design: {
    image: [C, C], svg: [C, C], pdf: [C, C],
    write: [C, C], cells: [C, C], deck: [C, C], design: [C, C], draw: [C, C], diagram: [C, C], widget: [C, C],
    video: [cannot('PlexiiDesign', 'a video file'), cannot('PlexiiDesign', 'a video file')],
    audio: [cannot('PlexiiDesign', 'an audio file'), cannot('PlexiiDesign', 'an audio file')],
    md: [C, C], csv: [C, C], xlsx: [C, C], txt: [C, C],
    generic: [cannot('PlexiiDesign', 'this kind of file'), cannot('PlexiiDesign', 'this kind of file')],
    folder: [folderTo('PlexiiDesign'), folderTo('PlexiiDesign')]
  },
  draw: {
    image: [C, C], svg: [C, C], pdf: [C, C],
    // The plan's "Cells sheet → Draw: COPY picture": a picture of its table.
    write: [C, C], cells: [C, C], deck: [C, C], design: [C, C], draw: [C, C], diagram: [C, C], widget: [C, C],
    video: [cannot('PlexiiDraw', 'a video file'), cannot('PlexiiDraw', 'a video file')],
    audio: [cannot('PlexiiDraw', 'an audio file'), cannot('PlexiiDraw', 'an audio file')],
    md: [C, C], csv: [C, C], xlsx: [C, C], txt: [C, C],
    generic: [cannot('PlexiiDraw', 'this kind of file'), cannot('PlexiiDraw', 'this kind of file')],
    folder: [folderTo('PlexiiDraw'), folderTo('PlexiiDraw')]
  },
  diagram: {
    image: [C, C], svg: [C, C], pdf: [C, C],
    write: [C, C], cells: [C, C], deck: [C, C], design: [C, C], draw: [C, C], diagram: [C, C], widget: [C, C],
    video: [cannot('PlexiiDiagrams', 'a video file'), cannot('PlexiiDiagrams', 'a video file')],
    audio: [cannot('PlexiiDiagrams', 'an audio file'), cannot('PlexiiDiagrams', 'an audio file')],
    md: [C, C], csv: [C, C], xlsx: [C, C], txt: [C, C],
    generic: [cannot('PlexiiDiagrams', 'this kind of file'), cannot('PlexiiDiagrams', 'this kind of file')],
    folder: [folderTo('PlexiiDiagrams'), folderTo('PlexiiDiagrams')]
  },
  // PlexiiCells holds values: pictures and visual documents are refused.
  sheet: {
    image: [R(REASON.cellsNoPictures), R(REASON.cellsNoPictures)],
    svg: [R(REASON.cellsNoPictures), R(REASON.cellsNoPictures)],
    pdf: [R(REASON.cellsNoPictures), R(REASON.cellsNoPictures)],
    write: [C, C], cells: [C, C],
    deck: [R(REASON.cellsNoPictures), R(REASON.cellsNoPictures)],
    design: [R(REASON.cellsNoPictures), R(REASON.cellsNoPictures)],
    draw: [R(REASON.cellsNoPictures), R(REASON.cellsNoPictures)],
    diagram: [R(REASON.cellsNoPictures), R(REASON.cellsNoPictures)],
    widget: [C, C],
    video: [R(REASON.cellsFiles), R(REASON.cellsFiles)], audio: [R(REASON.cellsFiles), R(REASON.cellsFiles)],
    md: [C, C], csv: [C, C], xlsx: [C, C], txt: [C, C],
    generic: [R(REASON.cellsFiles), R(REASON.cellsFiles)],
    folder: [folderTo('PlexiiCells'), folderTo('PlexiiCells')]
  },
  // §4.4 page and markdown: like PlexiiWrite.
  page: {
    image: [C, L], svg: [C, L], pdf: [L, C],
    write: [L, C], cells: [L, C], deck: [L, C], design: [L, C], draw: [L, C], diagram: [L, C], widget: [L, C],
    video: [L, L], audio: [L, L], md: [C, L], csv: [C, L], xlsx: [C, L], txt: [C, L], generic: [L, L], folder: [L, L]
  },
  markdown: {
    image: [C, L], svg: [C, L], pdf: [L, C],
    write: [L, C], cells: [L, C], deck: [L, C], design: [L, C], draw: [L, C], diagram: [L, C], widget: [L, C],
    video: [L, L], audio: [L, L], md: [C, L], csv: [C, L], xlsx: [C, L], txt: [C, L], generic: [L, L], folder: [L, L]
  },
  // Stickies and notes hold text: pictures are refused, links become "title (href)".
  sticky: {
    // ⌥ copies the WORDS (the fixture drawing has text; a PDF page has none, so its link stays).
    image: [R(STICKY_PICTURES()), L], svg: [R(STICKY_PICTURES()), L], pdf: [L, L],
    write: [L, C], cells: [L, C], deck: [L, C], design: [L, C], draw: [L, C], diagram: [L, C], widget: [L, C],
    video: [L, L], audio: [L, L], md: [C, L], csv: [C, L], xlsx: [C, L], txt: [C, L], generic: [L, L], folder: [L, L]
  },
  note: {
    // ⌥ copies the WORDS (the fixture drawing has text; a PDF page has none, so its link stays).
    image: [R(NOTE_PICTURES()), L], svg: [R(NOTE_PICTURES()), L], pdf: [L, L],
    write: [L, C], cells: [L, C], deck: [L, C], design: [L, C], draw: [L, C], diagram: [L, C], widget: [L, C],
    video: [L, L], audio: [L, L], md: [C, L], csv: [C, L], xlsx: [C, L], txt: [C, L], generic: [L, L], folder: [L, L]
  },
  // A table work widget takes rows. A .md or .txt file is its lines, one per
  // row (as in PlexiiCells); the plan's stricter "csv/tsv only" cell would
  // refuse lines PlexiiCells takes, so the acceptor's rule stands.
  table: {
    image: [R(TABLE_NO_PICTURES), R(TABLE_NO_PICTURES)], svg: [R(TABLE_NO_PICTURES), R(TABLE_NO_PICTURES)],
    pdf: [R(TABLE_NO_PICTURES), R(TABLE_NO_PICTURES)],
    write: [C, C], cells: [C, C],
    deck: [R(TABLE_NO_PICTURES), R(TABLE_NO_PICTURES)], design: [R(TABLE_NO_PICTURES), R(TABLE_NO_PICTURES)],
    draw: [R(TABLE_NO_PICTURES), R(TABLE_NO_PICTURES)], diagram: [R(TABLE_NO_PICTURES), R(TABLE_NO_PICTURES)],
    widget: [C, C],
    video: [R(REASON.tableFile), R(REASON.tableFile)], audio: [R(REASON.tableFile), R(REASON.tableFile)],
    md: [C, C], csv: [C, C], xlsx: [C, C], txt: [C, C],
    generic: [R(REASON.tableFile), R(REASON.tableFile)],
    folder: [folderTo('a table work widget'), folderTo('a table work widget')]
  },
  // An image work widget takes a picture; a document's or a PDF's only with ⌥.
  // A sheet (a Cells document with ⌥, a CSV or an Excel workbook) is a picture of its table.
  image: {
    image: [C, C], svg: [C, C], pdf: [R(IMAGE_NEEDS_PICTURE), C],
    write: [R(IMAGE_NEEDS_PICTURE), R(IMAGE_NEEDS_PICTURE)], cells: [R(IMAGE_NEEDS_PICTURE), C],
    deck: [R(IMAGE_NEEDS_PICTURE), C], design: [R(IMAGE_NEEDS_PICTURE), C], draw: [R(IMAGE_NEEDS_PICTURE), C], diagram: [R(IMAGE_NEEDS_PICTURE), C],
    widget: [R(IMAGE_NEEDS_PICTURE), R(IMAGE_NEEDS_PICTURE)],
    video: [R(IMAGE_NEEDS_PICTURE), R(IMAGE_NEEDS_PICTURE)], audio: [R(IMAGE_NEEDS_PICTURE), R(IMAGE_NEEDS_PICTURE)],
    md: [R(IMAGE_NEEDS_PICTURE), R(IMAGE_NEEDS_PICTURE)], csv: [C, C], xlsx: [C, C], txt: [R(IMAGE_NEEDS_PICTURE), R(IMAGE_NEEDS_PICTURE)],
    generic: [R(IMAGE_NEEDS_PICTURE), R(IMAGE_NEEDS_PICTURE)],
    folder: [folderTo('an image work widget'), folderTo('an image work widget')]
  }
}

function STICKY_PICTURES(): string {
  return stickyLine('sticky')
}
function NOTE_PICTURES(): string {
  return stickyLine('note')
}
/** The text widgets' own picture refusal, as their acceptor words it for a drop. */
function stickyLine(kind: 'sticky' | 'note'): string {
  const a = acceptFor(kind, [{ kind: 'image', value: { src: F.PNG }, lossy: [] }], { verb: 'drop' }) as { ok: boolean; reason?: string }
  return a.reason ?? ''
}

describe('Files content drop matrix (plan §4.3 and §4.4), over the real builders and acceptors', () => {
  for (const [target, row] of Object.entries(MATRIX) as Array<[ContentTarget, Row]>) {
    for (const [source, [plain, alt]] of Object.entries(row)) {
      it(`${source} → ${target}: plain ${plain.split(':')[0]}, ⌥ ${alt.split(':')[0]}`, () => {
        expect(run(source, target, false), 'plain drop').toBe(plain)
        expect(run(source, target, true), '⌥ drop').toBe(alt)
      })
    }
  }
  it('covers every source for every target', () => {
    for (const row of Object.values(MATRIX)) expect(Object.keys(row).sort()).toEqual(Object.keys(SRC).sort())
  })
})

describe('what a drop carries along', () => {
  it('a picture from Files is the SAME row in a work widget (fb-file://), and inline bytes in an office document', () => {
    const forms = formsForTarget(SRC.image!.ref, SRC.image!.content, { target: 'page' }).forms
    const r = readDropForms({ forms, source: null, verb: 'drop' })
    const page = acceptFor('page', r.forms, r.ctx) as { ok: true; nodes: unknown[] }
    expect(JSON.stringify(page.nodes)).toContain('fb-file://png1')
    const img = acceptFor('image', r.forms, r.ctx) as { ok: true; picture: { src?: string; fileId?: string } }
    expect(img.picture.fileId ?? img.picture.src).toMatch(/png1/)
    const doc = convertForms(formsForTarget(SRC.image!.ref, SRC.image!.content, { target: 'doc' }).forms, 'doc', F.DEPS, undefined, { verb: 'drop' })
    expect(doc.ok && JSON.stringify(doc.body)).toContain('data:image/png;base64')
  })
  it('an SVG names the original file as where it is edited', () => {
    const forms = formsForTarget(SRC.svg!.ref, SRC.svg!.content, { target: 'doc' }).forms
    expect(forms[0]).toMatchObject({ kind: 'svg', value: { app: 'the original file', vector: true, width: 40, height: 20 } })
    const out = convertForms(forms, 'doc', F.DEPS, undefined, { verb: 'drop' })
    expect(out.ok && out.lossy).toContain('It becomes a picture: edit it in the original file.')
  })
  it("a PDF's first page carries the plan's lossy line", () => {
    const out = convertForms(formsForTarget(SRC.pdf!.ref, SRC.pdf!.content, { target: 'slide' }).forms, 'slide', F.DEPS, undefined, { verb: 'drop' })
    expect(out.ok && out.lossy).toContain(PDF_FIRST_PAGE)
  })
  it('a document into PlexiiWrite is its live DocEmbed card', () => {
    const out = convertForms(formsForTarget(SRC.write!.ref, SRC.write!.content, { target: 'doc' }).forms, 'doc', F.DEPS, undefined, { verb: 'drop' })
    expect(out.ok && out.body.kind === 'doc' && out.body.content).toEqual([{ type: 'docEmbed', attrs: { documentId: 'd-doc' } }])
  })
  it('a folder link is plexii://folder/<id>; a file link plexii://file/<id>', () => {
    const f = formsForTarget(SRC.folder!.ref, {}, { target: 'doc' }).forms[0]!
    expect(f).toMatchObject({ kind: 'link', value: { href: 'plexii://folder/dir1', target: 'folder', title: 'Brand assets' } })
    const v = formsForTarget(SRC.video!.ref, {}, { target: 'doc' }).forms[0]!
    expect(v).toMatchObject({ kind: 'link', value: { href: 'plexii://file/mp4', target: 'file', mime: 'video/mp4' } })
  })
})

describe('guards and fallbacks, with their lines verbatim', () => {
  it('read-only refuses before anything is read', () => {
    expect(formsForTarget(SRC.image!.ref, SRC.image!.content, { target: 'doc', readOnly: true })).toEqual({ forms: [], refused: REASON_READ_ONLY })
    expect(REASON_READ_ONLY).toBe('This document is read-only, so nothing can be added to it.')
  })
  it('a document cannot go inside itself', () => {
    expect(formsForTarget(SRC.write!.ref, SRC.write!.content, { target: 'doc', ownDocumentId: 'd-doc' }).refused).toBe(REASON_INTO_ITSELF)
    expect(REASON_INTO_ITSELF).toBe('A document cannot go inside itself.')
    expect(formsForTarget(SRC.write!.ref, SRC.write!.content, { target: 'doc', ownDocumentId: 'other' }).refused).toBeUndefined()
  })
  it("bytes not on this device: a link, said so", () => {
    const r = formsForTarget(SRC.image!.ref, { bytesMissing: true }, { target: 'doc' })
    expect(r.forms).toHaveLength(1)
    expect(r.forms[0]).toMatchObject({ kind: 'link', lossy: [NOTICE_BYTES_MISSING] })
    expect(NOTICE_BYTES_MISSING).toBe("This file's contents are not on this device yet, so it can only be added as a link.")
    // Where links are not held, the link's own refusal names where it can go.
    expect(run('image', 'slide', false)).toBe('copy')
    expect(verdict('slide', formsForTarget(SRC.image!.ref, { bytesMissing: true }, { target: 'slide' }).forms)).toBe(cannot('PlexiiDeck', 'this kind of file'))
  })
  it('a text file over 1 MB is a link, said so', () => {
    const big = { ...SRC.txt!.ref, sizeBytes: 2 * 1024 * 1024 }
    const r = formsForTarget(big, { sizeBytes: big.sizeBytes, text: 'x' }, { target: 'doc' })
    expect(r.forms).toEqual([expect.objectContaining({ kind: 'link', lossy: [NOTICE_TOO_LONG] })])
    expect(NOTICE_TOO_LONG).toBe('This file is too long to insert, so it was added as a link.')
  })
  it('a picture over the target cap: the exact refusal, or a link where links are held', () => {
    const huge = { ...SRC.image!.ref, sizeBytes: 48 * 1024 * 1024 }
    const content = { ...SRC.image!.content, sizeBytes: huge.sizeBytes }
    expect(formsForTarget(huge, content, { target: 'slide' }).refused).toBe('This picture is 48 MB. PlexiiDeck takes pictures up to 20 MB.')
    expect(formsForTarget(huge, content, { target: 'diagram' }).refused).toBe('This picture is 48 MB. PlexiiDiagrams takes pictures up to 2.5 MB.')
    expect(formsForTarget(huge, content, { target: 'doc' }).forms).toEqual([expect.objectContaining({ kind: 'link' })])
    // Work widgets refer to the row, so there is no cap.
    expect(formsForTarget(huge, content, { target: 'image' }).forms[0]).toMatchObject({ kind: 'image' })
  })
})

describe('CSV and TSV (RFC 4180)', () => {
  it('quotes, doubled quotes, separators and newlines inside fields, CRLF, a trailing newline, ragged rows', () => {
    expect(parseDelimited('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z']
    ])
    expect(parseDelimited('a,b,c\n1\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '']
    ])
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    expect(parseDelimited('')).toEqual([])
    expect(parseDelimited('﻿h1,h2\n')).toEqual([['h1', 'h2']])
    expect(parseDelimited('a,\n')).toEqual([['a', '']])
  })
})
