// The picture of a sheet's table (shared/snippetForms/sheetPicture.ts) and
// where it sits among a sheet's forms: what holds a table, a document or rows
// still takes those; what holds only pictures takes this.

import { describe, expect, it } from 'vitest'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import {
  SHEET_PICTURE_MAX_COLS,
  SHEET_PICTURE_MAX_ROWS,
  fitText,
  sheetPicture,
  textWidth,
  xmlEscape,
  type SheetPictureInput
} from '../../src/shared/snippetForms/sheetPicture'
import { formsOf, type Form } from '../../src/shared/snippetForms'
import { convertForms, convertSnippetBody } from '../../src/shared/snippetConvert'
import { probeFileForms, acceptsFor, fileAcceptsFor } from '../../src/shared/snippetConvert/accepts'
import { textFileForms } from '../../src/shared/fileForms'
import { acceptForImage } from '../../src/shared/snippetWidgets'
import { L } from '../../src/shared/snippetForms/lossy'
import type { SheetSnippetBody } from '../../src/shared/snippets'
import type { DrawImageNode } from '../../src/shared/draw/model'
import * as F from './snippetConvertFixtures'

const pic = (input: Partial<SheetPictureInput> & { rows: string[][] }) => sheetPicture({ app: 'PlexiiCells', ...input })

/**
 * Parse, failing on any XML error. xmldom 0.8 forgives a bare `&` and
 * characters XML forbids, which Chromium's image decoder does not, so those
 * are checked first, by hand.
 */
function parse(svg: string): { getElementsByTagName: (n: string) => ArrayLike<{ textContent: string | null }> } {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(svg)) throw new Error('bare &')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(svg)) throw new Error('a character XML forbids')
  const errors: string[] = []
  const doc = new XmlDomParser({ errorHandler: { warning: (m: string) => errors.push(String(m)), error: (m: string) => errors.push(String(m)), fatalError: (m: string) => errors.push(String(m)) } } as never).parseFromString(svg, 'image/svg+xml')
  if (errors.length) throw new Error(errors.join('\n'))
  return doc as never
}

/** The cells' text in document order, as an XML reader sees it. */
function texts(svg: string): string[] {
  return Array.from(parse(svg).getElementsByTagName('text')).map((t) => t.textContent ?? '')
}

const wellFormed = (svg: string): boolean => {
  parse(svg)
  return true
}

const svgOf = (body: SheetSnippetBody): string => {
  const f = formsOf(body, F.DEPS).find((x) => x.kind === 'svg')
  if (f?.kind !== 'svg') throw new Error('no picture')
  return f.value.svg
}

describe('sheetPicture: the drawing', () => {
  it('is well-formed standalone SVG of what the cells show', () => {
    const p = pic({ rows: [['Item', 'Price'], ['Pens', '3']] })!
    expect(wellFormed(p.value.svg)).toBe(true)
    expect(p.value.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(p.value).toMatchObject({ vector: false, app: 'PlexiiCells' })
    expect(p.value.svg).toContain(`width="${p.value.width}" height="${p.value.height}"`)
    expect(texts(p.value.svg)).toEqual(['Item', 'Price', 'Pens', '3'])
    expect(p.lossy).toEqual([])
  })

  it('escapes & < > " \' and leaves out characters XML forbids', () => {
    const nasty = 'A & B <script>"x"</script> \'q\'\u0000\u0007\u001b￾\uD800!'
    const p = pic({ rows: [[nasty, 'tail']], colWidths: { 0: 600 } })!
    expect(wellFormed(p.value.svg)).toBe(true)
    expect(p.value.svg).not.toContain('<script>')
    expect(p.value.svg).toContain('A &amp; B &lt;script&gt;&quot;x&quot;&lt;/script&gt; &apos;q&apos;!')
    expect(texts(p.value.svg)[0]).toBe('A & B <script>"x"</script> \'q\'!')
    expect(xmlEscape('\u0009\u000a\u000d')).toBe('\u0009\u000a\u000d')
    expect(xmlEscape('😀')).toBe('😀')
  })

  it('uses the sheet’s own column widths where set, and sizes the rest to the text', () => {
    const p = pic({ rows: [['Item', 'A rather longer heading'], ['Pens', '3']], colWidths: { 0: 180 } })!
    expect(p.value.svg).toContain('<rect x="0" y="0" width="180" height="24"')
    // The second column is sized to its words: wider than the minimum, narrower than the cap.
    const second = /<rect x="180" y="0" width="(\d+)"/.exec(p.value.svg)
    expect(Number(second?.[1])).toBeGreaterThan(Math.ceil(textWidth('A rather longer heading', true)))
    expect(Number(second?.[1])).toBeLessThanOrEqual(240)
    expect(p.value.width).toBe(180 + Number(second?.[1]) + 1)
  })

  it('cuts a long cell short with an ellipsis, and says so', () => {
    const long = 'word '.repeat(200).trim()
    const p = pic({ rows: [['Note'], [long]] })!
    const shown = texts(p.value.svg)[1]
    expect(shown.endsWith('…')).toBe(true)
    expect(shown.length).toBeLessThan(long.length)
    expect(textWidth(shown)).toBeLessThanOrEqual(240 - 16)
    expect(p.lossy).toContain(L.cellsCut)
    // A cell of several lines shows its first, cut.
    expect(fitText('first\nsecond', 500)).toEqual({ text: 'first…', cut: true })
    expect(fitText('fits', 500)).toEqual({ text: 'fits', cut: false })
    expect(fitText('anything', 4)).toEqual({ text: '', cut: true })
  })

  it(`draws at most ${SHEET_PICTURE_MAX_ROWS} rows and ${SHEET_PICTURE_MAX_COLS} columns, and says how many of how many`, () => {
    const rows = Array.from({ length: 250 }, (_, r) => Array.from({ length: 40 }, (_, c) => `${r}:${c}`))
    const p = pic({ rows })!
    expect(p.lossy).toEqual([`Showing the first ${SHEET_PICTURE_MAX_ROWS} rows of 250.`, `Showing the first ${SHEET_PICTURE_MAX_COLS} columns of 40.`])
    expect(p.value.height).toBe(SHEET_PICTURE_MAX_ROWS * 24 + 1)
    const t = texts(p.value.svg)
    expect(t).toHaveLength(SHEET_PICTURE_MAX_ROWS * SHEET_PICTURE_MAX_COLS)
    expect(t.at(-1)).toBe(`${SHEET_PICTURE_MAX_ROWS - 1}:${SHEET_PICTURE_MAX_COLS - 1}`)
    // Exactly the bound: nothing to say.
    const exact = pic({ rows: rows.slice(0, SHEET_PICTURE_MAX_ROWS).map((r) => r.slice(0, SHEET_PICTURE_MAX_COLS)) })!
    expect(exact.lossy).toEqual([])
  })

  it('has no picture for a sheet with no text (an honest absence, never a blank card)', () => {
    expect(pic({ rows: [] })).toBeNull()
    expect(pic({ rows: [['', '  '], ['', '']], formats: { '0,0': { bold: true } } })).toBeNull()
  })

  it('leaves off the empty margin, keeps the blanks inside', () => {
    const p = pic({ rows: [['', '', ''], ['', 'a', ''], ['', '', ''], ['', 'b', 'c'], ['', '', '']] })!
    expect(p.value.height).toBe(3 * 24 + 1)
    expect(texts(p.value.svg)).toEqual(['a', 'b', 'c'])
  })

  it('draws a merged range as one cell, with no rule inside it', () => {
    const p = pic({ rows: [['Title', '', ''], ['a', 'b', 'c']], merges: [{ r1: 0, c1: 0, r2: 0, c2: 2 }] })!
    const w = p.value.width - 1
    expect(p.value.svg).toContain(`<rect x="0" y="0" width="${w}" height="24"`)
    // No vertical rule through the merged top row; one per column boundary in the second.
    const vertical = [...p.value.svg.matchAll(/M(\d+) (\d+)V(\d+)/g)]
    expect(vertical.every((m) => m[2] !== '0')).toBe(true)
    expect(vertical).toHaveLength(2)
    // A merge that clashes with another, or is not whole numbers, is ignored rather than trusted.
    const bad = pic({ rows: [['a', 'b'], ['c', 'd']], merges: [{ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 1, c1: 1, r2: 1, c2: 1.5 } as never, { r1: 0, c1: 1, r2: 1, c2: 1 }] })!
    expect(texts(bad.value.svg)).toEqual(['a'])
  })

  it('keeps number formats, bold, alignment and colours; says fonts are not kept', () => {
    const p = pic({
      rows: [['Rate', 'Name'], ['0.25', 'Ada']],
      formats: { '1,0': { numFmt: { kind: 'percent', decimals: 0 } }, '1,1': { italic: true, color: '#ff0000', bg: '#00ff00', align: 'center', fontFamily: 'Lobster' }, '0,1': { color: 'red"/><script>' } }
    })!
    expect(texts(p.value.svg)).toEqual(['Rate', 'Name', '25%', 'Ada'])
    expect(p.value.svg).toContain('fill="#00ff00"')
    expect(p.value.svg).toMatch(/text-anchor="middle" font-style="italic" fill="#ff0000"[^>]*>Ada</)
    expect(p.value.svg).not.toContain('script')
    expect(p.lossy).toEqual([L.cellFonts])
  })

  it('is deterministic and never mutates its input', () => {
    const input: SheetPictureInput = {
      rows: [['Item', 'Qty'], ['Pens', '2'], ['A long, long, long, long, long, long, long, long, long, long cell', '#REF!']],
      formats: { '0,0': { bold: true } },
      merges: [{ r1: 1, c1: 0, r2: 1, c2: 1 }],
      colWidths: { 1: 90 },
      app: 'PlexiiCells'
    }
    const before = structuredClone(input)
    const a = sheetPicture(input)
    const b = sheetPicture(input)
    expect(a).toEqual(b)
    expect(a!.value.svg).toBe(b!.value.svg)
    expect(input).toEqual(before)
  })
})

describe('a sheet’s forms, best first', () => {
  it('offers the picture after the forms that keep values, before the text', () => {
    const kinds = formsOf(F.sheet(), F.DEPS).map((f) => f.kind)
    expect(kinds).toEqual(['native', 'rows', 'docNodes', 'markdown', 'svg', 'text'])
  })

  it('pictures the COMPUTED values, never the formulas, and keeps the formula lines', () => {
    const svg = svgOf(F.sheet())
    expect(texts(svg)).toContain('26')
    expect(svg).not.toMatch(/=C3|SUM\(/)
    const f = formsOf(F.sheet(), F.DEPS).find((x) => x.kind === 'svg')!
    expect(f.lossy).toContain(L.formulasValues)
    expect(f.lossy).not.toContain(L.cellFormatting)
  })

  it('has no picture for an empty sheet, so PlexiiDraw refuses honestly', () => {
    const empty: SheetSnippetBody = { kind: 'sheet', rows: [['', ''], ['', '']] }
    expect(formsOf(empty, F.DEPS).some((f) => f.kind === 'svg')).toBe(false)
    const out = convertSnippetBody(empty, 'draw', F.DEPS)
    expect(out).toEqual({ ok: false, reason: 'There is nothing in this snippet to insert.' })
  })

  it('a CSV file has the same picture form in the same place', () => {
    const forms = textFileForms({ entryId: 'c', kind: 'file', name: 'scores.csv', mimeType: 'text/csv', ext: 'csv' }, 'name,score\nAda,9\n')
    expect(forms.map((f) => f.kind)).toEqual(['rows', 'docNodes', 'markdown', 'svg', 'text'])
    const svg = forms.find((f) => f.kind === 'svg')!
    expect(svg).toMatchObject({ value: { app: 'the original file', vector: false } })
  })
})

describe('every destination, with a sheet', () => {
  const sheet = F.sheet()
  it('PlexiiDraw: a picture of the table', () => {
    const out = convertSnippetBody(sheet, 'draw', F.DEPS)
    expect(out.ok).toBe(true)
    if (!out.ok || out.body.kind !== 'draw') return
    expect(out.body.objects).toEqual([expect.objectContaining({ type: 'image', alt: 'Picture from PlexiiCells' })])
    expect(out.lossy[0]).toBe('It becomes a picture: edit it in PlexiiCells.')
    const node = out.body.objects[0] as DrawImageNode
    expect((out.body.assets as Record<string, { dataUrl: string }>)[node.assetId].dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    // Twice, byte-identical (a live converted instance is converted on every render).
    expect(JSON.stringify(convertSnippetBody(sheet, 'draw', F.DEPS))).toBe(JSON.stringify(out))
  })

  it('PlexiiDeck, PlexiiDesign and PlexiiDiagrams still take their own table; Write a table; Cells the rows', () => {
    const slide = convertSnippetBody(sheet, 'slide', F.DEPS)
    expect(slide.ok && slide.body.kind === 'slide' && (slide.body.elements[0] as { type: string }).type).toBe('table')
    const design = convertSnippetBody(sheet, 'design', F.DEPS)
    expect(design.ok && design.body.kind === 'design' && (design.body.elements[0] as { type: string }).type).toBe('table')
    const diagram = convertSnippetBody(sheet, 'diagram', F.DEPS)
    expect(diagram.ok && diagram.body.kind === 'diagram' && diagram.body.nodes[0].shape).toMatch(/^table/)
    const doc = convertSnippetBody(sheet, 'doc', F.DEPS)
    expect(doc.ok && doc.body.kind === 'doc' && (doc.body.content[0] as { type: string }).type).toBe('table')
    const cells = convertSnippetBody(sheet, 'sheet', F.DEPS)
    expect(cells.ok && cells.body).toEqual(sheet)
    const widget = convertSnippetBody(sheet, 'widget', F.DEPS)
    expect(widget.ok && widget.body.kind === 'widget' && widget.body.widgetKind).toBe('markdown')
  })

  it('an image work widget: the same picture', () => {
    const a = acceptForImage(formsOf(sheet, F.DEPS), { body: sheet, verb: 'insert' })
    expect(a.ok && 'svg' in a.picture && a.picture.svg.app).toBe('PlexiiCells')
  })

  it('the derived accepts now offer a sheet to PlexiiDraw, and a CSV file to it', () => {
    expect(acceptsFor('draw', F.DEPS)).toContain('sheet')
    expect(fileAcceptsFor('draw', F.DEPS)).toContain('csv')
  })

  it('a grid with no picture of its own (rows only) lands in PlexiiDraw as one, not a refusal', () => {
    const rowsOnly: Form[] = [{ kind: 'rows', value: { rows: [['a', 'b'], ['1', '2']], header: true }, lossy: [] }]
    for (const verb of ['paste', 'drop'] as const) {
      const out = convertForms(rowsOnly, 'draw', {}, undefined, { verb })
      expect(out.ok && out.lossy[0]).toBe('It becomes a picture: edit it in the app it came from.')
    }
    expect(convertForms([{ kind: 'rows', value: { rows: [['', '']], header: false }, lossy: [] }], 'draw').ok).toBe(false)
  })

  it('a CSV dropped from Files lands in PlexiiDraw as a picture of its table, not a line of commas', () => {
    const out = convertForms(probeFileForms('csv'), 'draw', F.DEPS, undefined, { verb: 'drop' })
    expect(out.ok && out.body.kind === 'draw' && (out.body.objects[0] as { type: string }).type).toBe('image')
    expect(out.ok && out.lossy).toEqual(['It becomes a picture: edit it in the original file.'])
  })
})

describe('the strict XML reader these tests use', () => {
  it('really rejects malformed markup (so "well-formed" above means something)', () => {
    expect(() => parse('<svg xmlns="http://www.w3.org/2000/svg"><text>a & b</text></svg>')).toThrow()
    expect(() => parse('<svg xmlns="http://www.w3.org/2000/svg"><text>a\u0007</text></svg>')).toThrow()
    expect(() => parse('<svg xmlns="http://www.w3.org/2000/svg"><text>a</svg>')).toThrow()
    expect(parse('<svg xmlns="http://www.w3.org/2000/svg"><text>a &amp; b</text></svg>')).toBeTruthy()
  })
})
