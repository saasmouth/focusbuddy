// A PlexiiCells copy pasted into our other apps, through its own clipboard
// flavour (application/x-plexii-cells beside the TSV; shared/
// cellsClipboardFormat.ts) rather than the TSV alone.
//
// Read as the main process hands it over (custom types + text), the flavour
// comes first: the paste is the range as a saved snippet of it, so PlexiiDraw
// gets the table PICTURE (formats and the sheet's column widths kept) and
// Deck, Design and Write get a real TABLE of what the cells displayed, a
// formula reading a cell outside the copied range included. The TSV alone
// (any other app, a text field) is unchanged and stays plain text.
//
// Deliberately written against the envelope as JSON, with nothing imported
// from the flavour's own module, so it reads the same against a build that
// has no flavour at all (and fails there).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formsFromClipboardRead, pasteNeedsConversion, readClipboardForms, readFromDataTransfer, resetCellsCopy, markCellsCopy } from '../../src/renderer/src/lib/clipboardForms'
import { convertClipboard, fromAnotherApp } from '../../src/renderer/src/lib/clipboardPaste'
import { convertForms } from '../../src/shared/snippetConvert'
import { useNoticeStore } from '../../src/renderer/src/stores/notice'
import * as F from './snippetConvertFixtures'

const MIME = 'application/x-plexii-cells'

/** What Cells writes for A2:C3 of a sheet where C3 is =B3*$E$1 and E1 holds 3. */
const TSV = 'Item\tQty\tTotal\nPens\t2\t=B3*$E$1'
const BODY = {
  kind: 'sheet',
  rows: [
    ['Item', 'Qty', 'Total'],
    ['Pens', '2', '=B3*$E$1']
  ],
  origin: { r: 1, c: 0 },
  formats: { '0,0': { bold: true }, '1,2': { bg: '#fde68a' } },
  colWidths: { 0: 180 }
}
const VALUES = [
  ['Item', 'Qty', 'Total'],
  ['Pens', '2', '6']
]
const envelope = (version: unknown = 1): string => JSON.stringify({ kind: 'plexiicells/clipboard', version, body: BODY, values: VALUES })
const READ = (): { custom: Record<string, string>; text: string } => ({ custom: { [MIME]: envelope() }, text: TSV })

beforeEach(() => useNoticeStore.getState().clear())
afterEach(() => resetCellsCopy())

/** Fails the test (rather than skipping the rest) when a guard does not hold. */
function must(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`expected ${what}`)
}

function base64Svg(src: string): string {
  const m = /^data:image\/svg\+xml;base64,(.*)$/.exec(src)
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : ''
}

describe('readClipboardForms prefers the Cells flavour', () => {
  it('the flavour is the source body, ahead of the TSV, from any window (no same-renderer memory needed)', () => {
    const r = formsFromClipboardRead(READ(), { deps: F.DEPS })
    expect(r.source).toBe('PlexiiCells')
    expect(r.kind).toBe('sheet')
    expect(r.refused).toBeUndefined()
    expect(r.forms[0]).toMatchObject({ kind: 'native', value: BODY })
    // What the cells DISPLAYED on their sheet, not #REF! for the reference outside the range.
    const rows = r.forms.find((f) => f.kind === 'rows')!
    expect((rows.value as { rows: string[][] }).rows).toEqual(VALUES)
  })

  it('the flavour wins over the same-renderer text match, which only knows the cells’ input', () => {
    markCellsCopy(TSV, { r: 1, c: 0 })
    const r = formsFromClipboardRead(READ(), { deps: F.DEPS })
    expect(r.forms[0].value).toEqual(BODY)
  })

  it('through the main process read (window.api.snippets.readClipboard)', async () => {
    const g = globalThis as unknown as { api?: unknown }
    const before = g.api
    g.api = { snippets: { readClipboard: async () => READ() } }
    try {
      const r = await readClipboardForms(null, { deps: F.DEPS })
      expect(r.source).toBe('PlexiiCells')
      expect(r.forms[0].value).toEqual(BODY)
    } finally {
      g.api = before
    }
  })

  it('a newer PlexiiCells’ envelope is refused with its reason, never guessed at', () => {
    const r = formsFromClipboardRead({ custom: { [MIME]: envelope(2) }, text: TSV }, { deps: F.DEPS })
    expect(r.forms).toEqual([])
    expect(r.kind).toBe('sheet')
    expect(r.refused).toMatch(/newer PlexiiCells/)
    expect(fromAnotherApp(r, 'doc')).toBe(true)
  })

  it('a malformed flavour is not ours: the TSV is read as the plain text it is', () => {
    const r = formsFromClipboardRead({ custom: { [MIME]: '{"kind":"plexiicells/clipboard","version":1,"body":{"kind":"sheet","rows":"x"}}' }, text: TSV }, { deps: F.DEPS })
    expect(r.source).toBeNull()
    expect(r.forms.map((f) => f.kind)).toEqual(['rows', 'docNodes', 'text'])
  })

  it('the TSV alone (what every other app and text field gets) is unchanged plain text', () => {
    const r = formsFromClipboardRead({ text: TSV }, { deps: F.DEPS })
    expect(r.source).toBeNull()
    const text = r.forms.find((f) => f.kind === 'text')!
    expect(text.value).toBe(TSV)
  })

  it('a paste event carries the flavour (browser build), and an editor routes it to the conversion', () => {
    const data = { types: [MIME, 'text/plain'], getData: (t: string) => (t === MIME ? envelope() : t === 'text/plain' ? TSV : '') } as unknown as DataTransfer
    expect(readFromDataTransfer(data).custom?.[MIME]).toBe(envelope())
    expect(pasteNeedsConversion(data)).toBe(true)
  })
})

describe('pasted into each of our apps', () => {
  const read = () => formsFromClipboardRead(READ(), { deps: F.DEPS })

  it('PlexiiDraw: one picture of the table, its formats and the sheet’s column widths kept', () => {
    const out = convertForms(read().forms, 'draw', F.DEPS)
    expect(out.ok).toBe(true)
    must(out.ok && out.body.kind === 'draw', 'a draw body')
    expect(out.body.objects).toHaveLength(1)
    const img = out.body.objects[0] as { type: string; assetId: string; w: number }
    expect(img.type).toBe('image')
    const svg = base64Svg((out.body.assets as Record<string, { dataUrl: string }>)[img.assetId].dataUrl)
    expect(svg).toContain('>Pens<')
    expect(svg).toContain('>6<')
    expect(svg).not.toContain('=B3')
    expect(svg).not.toContain('#REF!')
    // The bg format of C3 and the 180px width set on column A.
    expect(svg).toContain('fill="#fde68a"')
    expect(svg).toMatch(/<rect x="0" y="0" width="180"/)
    expect(out.lossy.join(' ')).toContain('It becomes a picture: edit it in PlexiiCells.')
  })

  it('PlexiiDeck: a native table of what the cells displayed, with a heading row', () => {
    const out = convertForms(read().forms, 'slide', F.DEPS)
    expect(out.ok).toBe(true)
    must(out.ok && out.body.kind === 'slide', 'a slide body')
    const table = (out.body.elements as Array<{ type: string; cells?: string[][]; headerRow?: boolean }>).find((e) => e.type === 'table')!
    expect(table.cells).toEqual(VALUES)
    expect(table.headerRow).toBe(true)
  })

  it('PlexiiDesign: a native table of what the cells displayed', () => {
    const out = convertForms(read().forms, 'design', F.DEPS)
    expect(out.ok).toBe(true)
    must(out.ok && out.body.kind === 'design', 'a design body')
    const table = (out.body.elements as Array<{ type: string; cells?: string[][] }>).find((e) => e.type === 'table')!
    expect(table.cells).toEqual(VALUES)
  })

  it('PlexiiWrite: a table of what the cells displayed, and the paste says it came from PlexiiCells', () => {
    const conv = convertClipboard(read(), 'doc')
    expect(conv && conv.ok).toBe(true)
    must(conv && conv.ok && conv.body.kind === 'doc', 'a doc body')
    const json = JSON.stringify(conv.body.content)
    expect(conv.body.content[0]).toMatchObject({ type: 'table' })
    expect(json).toContain('"text":"6"')
    expect(json).not.toContain('=B3')
    expect(conv.notice).toContain('Formulas become their values.')
  })
})
