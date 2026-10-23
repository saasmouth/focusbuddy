// The drift guard for FILE drops (docs/saved-snippets.md, Files panel plan
// §4.5 item 7). Beside acceptsFor's representative BODIES, accepts.ts keeps
// representative FILE forms (probeFileForms): a picture that is already a row
// in Files, an SVG whose original is the file, a PDF's first page, links to a
// file, video, audio, document and folder, and .md, .csv and .txt files.
//
// Every probe runs over every office host builder and every work widget
// acceptor. Three things are checked:
//   1. the derived verdict (fileAcceptsFor / widgetFileAccepts) is the matrix
//      pinned below, the plan's cells for these forms, so a builder change
//      that moves a cell fails here first;
//   2. everything a destination takes REALLY lands: a body of the host's
//      kind (or the widget's own shape) that carries the picture, the link or
//      the text, never an empty conversion;
//   3. everything it refuses is refused with the plan's sentence, verbatim.

import { describe, expect, it } from 'vitest'
import { convertForms } from '../../src/shared/snippetConvert'
import {
  FILE_PROBES,
  PROBE_FILE_ID,
  acceptsFor,
  convertFileProbe,
  fileAcceptsFor,
  probeFileForms,
  type FileProbe
} from '../../src/shared/snippetConvert/accepts'
import { REASON } from '../../src/shared/snippetConvert/common'
import { PDF_FIRST_PAGE } from '../../src/shared/snippetForms'
import { IMAGE_NEEDS_PICTURE, TABLE_NO_PICTURES, type WidgetTargetKind } from '../../src/shared/snippetWidgets'
import { primaryKindFor, type SnippetBody, type SnippetHostKind } from '../../src/shared/snippets'
import { acceptFor, readDropForms, widgetFileAccepts } from '../../src/renderer/src/lib/widgetSnippetInsert'
import * as F from './snippetConvertFixtures'

const OFFICE: SnippetHostKind[] = ['doc', 'sheet', 'slide', 'design', 'diagram', 'draw']
const WIDGETS: WidgetTargetKind[] = ['sticky', 'note', 'page', 'markdown', 'table', 'image']
const FILE_REF = `fb-file://${PROBE_FILE_ID}`
const PICTURE_LINE = 'It becomes a picture: edit it in the original file.'

const ALL = [...FILE_PROBES]
const without = (...out: FileProbe[]): FileProbe[] => ALL.filter((p) => !out.includes(p))
const LINKS: FileProbe[] = ['linkFile', 'linkVideo', 'linkAudio', 'linkDocument', 'linkFolder']
const PICTURES: FileProbe[] = ['raster', 'svg', 'pdfPage']

/** The plan's matrix for these forms: what each destination takes. */
const OFFICE_TAKES: Record<string, FileProbe[]> = {
  doc: ALL,
  sheet: ['md', 'csv'],
  slide: without(...LINKS),
  design: without(...LINKS),
  diagram: without(...LINKS),
  draw: without(...LINKS)
}

/** And why it refuses the rest, verbatim. */
const OFFICE_REFUSES: Record<string, Partial<Record<FileProbe, string>>> = {
  sheet: {
    raster: REASON.cellsNoPictures,
    svg: REASON.cellsNoPictures,
    pdfPage: REASON.cellsNoPictures,
    linkFile: 'PlexiiCells holds values, not files. Drop it on a desk, or into PlexiiWrite as a link.',
    linkVideo: 'PlexiiCells holds values, not files. Drop it on a desk, or into PlexiiWrite as a link.',
    linkAudio: 'PlexiiCells holds values, not files. Drop it on a desk, or into PlexiiWrite as a link.',
    linkDocument: REASON.cellsDocument,
    linkFolder: 'A folder cannot go into PlexiiCells. Drop it on a desk for a Drive work widget.'
  },
  slide: {
    linkFile: 'PlexiiDeck cannot hold this kind of file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkVideo: 'PlexiiDeck cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkAudio: 'PlexiiDeck cannot hold an audio file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkDocument: REASON.deckDocument,
    linkFolder: 'A folder cannot go into PlexiiDeck. Drop it on a desk for a Drive work widget.'
  },
  design: {
    linkFile: 'PlexiiDesign cannot hold this kind of file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkVideo: 'PlexiiDesign cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkAudio: 'PlexiiDesign cannot hold an audio file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkDocument: REASON.designDocument,
    linkFolder: 'A folder cannot go into PlexiiDesign. Drop it on a desk for a Drive work widget.'
  },
  diagram: {
    linkFile: 'PlexiiDiagrams cannot hold this kind of file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkVideo: 'PlexiiDiagrams cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkAudio: 'PlexiiDiagrams cannot hold an audio file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkDocument: REASON.diagramDocument,
    linkFolder: 'A folder cannot go into PlexiiDiagrams. Drop it on a desk for a Drive work widget.'
  },
  draw: {
    linkFile: 'PlexiiDraw cannot hold this kind of file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkVideo: 'PlexiiDraw cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkAudio: 'PlexiiDraw cannot hold an audio file. Drop it on a desk, or into PlexiiWrite as a link.',
    linkDocument: REASON.drawDocument,
    linkFolder: 'A folder cannot go into PlexiiDraw. Drop it on a desk for a Drive work widget.'
  }
}

const WIDGET_TAKES: Record<WidgetTargetKind, FileProbe[]> = {
  sticky: without(...PICTURES),
  note: without(...PICTURES),
  page: ALL,
  markdown: ALL,
  table: ['md', 'csv'],
  image: PICTURES
}

const WIDGET_REFUSES: Record<WidgetTargetKind, Partial<Record<FileProbe, string>>> = {
  sticky: {
    raster: 'Stickies hold text. Drop on the desk to add it as an image.',
    svg: 'Stickies hold text. Drop on the desk to add it as an image.',
    pdfPage: 'Stickies hold text. Drop on the desk to add it as an image.'
  },
  note: {
    raster: 'Notes hold text. Drop on the desk to add it as an image.',
    svg: 'Notes hold text. Drop on the desk to add it as an image.',
    pdfPage: 'Notes hold text. Drop on the desk to add it as an image.'
  },
  page: {},
  markdown: {},
  table: {
    raster: TABLE_NO_PICTURES,
    svg: TABLE_NO_PICTURES,
    pdfPage: TABLE_NO_PICTURES,
    linkFile: 'A table work widget holds values, and this file has none.',
    linkVideo: 'A table work widget holds values, and this file has none.',
    linkAudio: 'A table work widget holds values, and this file has none.',
    linkDocument: REASON.tableDocument,
    linkFolder: 'A folder cannot go into a table work widget. Drop it on a desk for a Drive work widget.',
    txt: 'Nothing that was dropped reads as rows for this table.'
  },
  image: {
    linkFile: IMAGE_NEEDS_PICTURE,
    linkVideo: IMAGE_NEEDS_PICTURE,
    linkAudio: IMAGE_NEEDS_PICTURE,
    linkDocument: IMAGE_NEEDS_PICTURE,
    linkFolder: 'A folder cannot go into an image work widget. Drop it on a desk for a Drive work widget.',
    md: IMAGE_NEEDS_PICTURE,
    csv: IMAGE_NEEDS_PICTURE,
    txt: IMAGE_NEEDS_PICTURE
  }
}

/** What a landed office body must carry for each probe (its picture, its link, its words). */
function carries(body: SnippetBody, probe: FileProbe): void {
  const json = JSON.stringify(body)
  switch (probe) {
    case 'raster':
    case 'pdfPage':
      // Office documents carry their pictures inline: the data: URL, never the file reference.
      if (body.kind === 'draw') expect(Object.values(body.assets ?? {}).length).toBe(1)
      else expect(json).toContain(F.PNG)
      expect(json).not.toContain(FILE_REF)
      return
    case 'svg':
      expect(json).toMatch(/data:image\/svg\+xml|"assetId"|"type":"path"/)
      return
    case 'linkDocument':
      expect(json).toContain('"type":"docEmbed"')
      expect(json).toContain('"documentId":"doc-plan"')
      return
    case 'linkFile':
    case 'linkVideo':
    case 'linkAudio':
    case 'linkFolder': {
      const v = probeFileForms(probe)[0]
      if (v.kind !== 'link') throw new Error('probe is not a link')
      expect(json).toContain(`"href":"${v.value.href}"`)
      expect(json).toContain(`"text":"${v.value.title}"`)
      return
    }
    case 'md':
      expect(json).toMatch(/Call the bank/)
      return
    case 'csv':
      expect(json).toMatch(/Pens/)
      return
    case 'txt':
      expect(json).toMatch(/Pay the rent/)
  }
}

describe('file forms over every office builder', () => {
  for (const host of OFFICE) {
    const to = primaryKindFor(host)

    it(`${host}: the derived verdict is the plan's matrix`, () => {
      expect(fileAcceptsFor(host, F.DEPS)).toEqual(OFFICE_TAKES[host])
    })

    it(`${host}: everything it takes really lands, carrying what was dropped`, () => {
      for (const probe of fileAcceptsFor(host, F.DEPS)) {
        const r = convertFileProbe(probe, to, F.DEPS)
        if (!r.ok) throw new Error(`${host} ${probe}: ${r.reason}`)
        expect(r.body.kind).toBe(to)
        carries(r.body, probe)
        // PlexiiDraw imports a vector SVG as editable objects (no picture line); the others hold a picture.
        if (probe === 'svg') {
          if (host === 'draw') expect(JSON.stringify(r.body)).toContain('"type":"path"')
          else expect(r.lossy).toContain(PICTURE_LINE)
        }
        if (probe === 'pdfPage') expect(r.lossy).toContain(PDF_FIRST_PAGE)
      }
    })

    it(`${host}: everything it refuses is refused with the plan's sentence`, () => {
      for (const probe of ALL.filter((p) => !OFFICE_TAKES[host].includes(p))) {
        const r = convertFileProbe(probe, to, F.DEPS)
        expect(r.ok, `${host} ${probe}`).toBe(false)
        const want = OFFICE_REFUSES[host]?.[probe]
        if (want) expect(r.ok ? '' : r.reason, `${host} ${probe}`).toBe(want)
        else expect(r.ok ? '' : r.reason, `${host} ${probe}`).toBeTruthy()
      }
    })
  }

  it('the office verdict does not depend on the deps a host was given for links', () => {
    for (const host of OFFICE) {
      const bare = fileAcceptsFor(host).filter((p) => LINKS.includes(p))
      expect(bare, host).toEqual(OFFICE_TAKES[host].filter((p) => LINKS.includes(p)))
    }
  })

  it('the snippet-kind accepts list is unchanged by the file forms', () => {
    // acceptsFor reads bodies only; adding forms must not move a host's library filter.
    expect(acceptsFor('sheet', F.DEPS)).toEqual(['doc', 'widget', 'sheet'])
    expect(acceptsFor('doc', F.DEPS)).toHaveLength(7)
  })
})

describe('file forms over every work widget acceptor, read as a drop', () => {
  for (const kind of WIDGETS) {
    it(`${kind}: the derived verdict is the plan's matrix`, () => {
      expect(widgetFileAccepts(kind)).toEqual(WIDGET_TAKES[kind])
    })

    it(`${kind}: everything it takes really lands, and a picture from Files keeps its row`, () => {
      for (const probe of WIDGET_TAKES[kind]) {
        const read = readDropForms({ forms: probeFileForms(probe), source: null })
        expect(read.ctx.verb).toBe('drop')
        const r = acceptFor(kind, read.forms, read.ctx)
        if (!r.ok) throw new Error(`${kind} ${probe}: ${r.reason}`)
        const json = JSON.stringify(r)
        if (probe === 'raster') {
          expect(json, `${kind} raster`).toContain(FILE_REF)
          expect(json, `${kind} raster`).not.toContain('data:image/png')
        }
        if (probe === 'svg') expect(r.lossy).toContain(PICTURE_LINE)
        if (probe === 'pdfPage') expect(r.lossy).toContain(PDF_FIRST_PAGE)
        if (LINKS.includes(probe)) {
          const v = probeFileForms(probe)[0]
          if (v.kind !== 'link') throw new Error('probe is not a link')
          if (kind === 'sticky' || kind === 'note') expect(r).toMatchObject({ text: `${v.value.title} (${v.value.href})` })
          else if (kind === 'markdown') expect(r).toMatchObject({ markdown: `[${v.value.title}](${v.value.href})` })
          else expect(json).toContain(`"href":"${v.value.href}"`)
        }
        if (probe === 'csv' && kind === 'table') expect(r).toMatchObject({ rows: [['Item', 'Price'], ['Pens', '3']], header: true })
      }
    })

    it(`${kind}: everything it refuses is refused with the plan's sentence, worded for a drop`, () => {
      for (const probe of ALL.filter((p) => !WIDGET_TAKES[kind].includes(p))) {
        const read = readDropForms({ forms: probeFileForms(probe), source: null })
        const r = acceptFor(kind, read.forms, read.ctx)
        expect(r.ok, `${kind} ${probe}`).toBe(false)
        expect(r.ok ? '' : r.reason, `${kind} ${probe}`).toBe(WIDGET_REFUSES[kind][probe])
        expect(r.ok ? '' : r.reason).not.toMatch(/clipboard|Paste|Insert it/)
      }
    })
  }
})

describe('the probes themselves', () => {
  it('cover every file case the plan names, with the shapes the drop reader promises', () => {
    expect(FILE_PROBES).toEqual(['raster', 'svg', 'pdfPage', 'linkFile', 'linkVideo', 'linkAudio', 'linkDocument', 'linkFolder', 'md', 'csv', 'txt'])
    const raster = probeFileForms('raster')[0]
    expect(raster.kind === 'image' && raster.value.fileId).toBe(PROBE_FILE_ID)
    const svg = probeFileForms('svg')[0]
    expect(svg.kind === 'svg' && svg.value.app).toBe('the original file')
    expect(probeFileForms('pdfPage')[0].lossy).toEqual([PDF_FIRST_PAGE])
    expect(probeFileForms('linkVideo')[0]).toMatchObject({ kind: 'link', value: { target: 'file', mime: 'video/mp4' } })
    expect(probeFileForms('linkAudio')[0]).toMatchObject({ kind: 'link', value: { target: 'file', mime: 'audio/mpeg' } })
    expect(probeFileForms('linkDocument')[0]).toMatchObject({ kind: 'link', value: { target: 'document' } })
    expect(probeFileForms('linkFolder')[0]).toMatchObject({ kind: 'link', value: { target: 'folder' } })
  })

  it('conversion of file forms is deterministic and never mutates its input', () => {
    for (const probe of ALL) {
      const forms = probeFileForms(probe)
      const before = JSON.stringify(forms)
      for (const host of OFFICE) {
        const a = convertForms(forms, primaryKindFor(host), F.DEPS)
        const b = convertForms(forms, primaryKindFor(host), F.DEPS)
        expect(JSON.stringify(a), `${host} ${probe}`).toBe(JSON.stringify(b))
      }
      expect(JSON.stringify(forms)).toBe(before)
    }
  })
})
