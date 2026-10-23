// The conversion's `verb` (insert, paste or drop): an input that words a
// refusal or a no-content message and changes nothing else. Insert and paste
// (and no verb at all, which is every caller written before it existed) keep
// today's sentences byte-for-byte; a drop says "dropped" and "Drop".

import { describe, expect, it } from 'vitest'
import { convertForms, convertSnippetBody, type ConvertVerb } from '../../src/shared/snippetConvert'
import { REASON, nothingUsable, widgetReason } from '../../src/shared/snippetConvert/common'
import type { Form } from '../../src/shared/snippetForms'
import { acceptForMarkdown, acceptForPage, acceptForTable, acceptForTextWidget, planDesk } from '../../src/shared/snippetWidgets'
import type { SnippetBody, SnippetKind } from '../../src/shared/snippets'
import { convertClipboard } from '../../src/renderer/src/lib/clipboardPaste'
import * as F from './snippetConvertFixtures'

const OFFICE: SnippetKind[] = ['doc', 'sheet', 'slide', 'design', 'diagram', 'draw', 'widget']
const APP: Record<SnippetKind, string> = {
  doc: 'PlexiiWrite',
  sheet: 'PlexiiCells',
  slide: 'PlexiiDeck',
  design: 'PlexiiDesign',
  diagram: 'PlexiiDiagrams',
  draw: 'PlexiiDraw',
  widget: 'a desk'
}
const TODAY: Array<ConvertVerb | undefined> = [undefined, 'insert', 'paste']
const opts = (verb: ConvertVerb | undefined) => (verb ? { verb } : undefined)
const reasonOf = (r: { ok: boolean; reason?: string }): string => (r.ok ? '' : (r.reason as string))
const rowsOnly: Form[] = [{ kind: 'rows', value: { rows: [['a', 'b']], header: false }, lossy: [] }]
const calendar: SnippetBody = { kind: 'widget', widgetKind: 'calendar', title: '', content: 'x', width: 2, height: 2, color: null }
const emptySticky: SnippetBody = { kind: 'widget', widgetKind: 'sticky', title: '', content: '   ', width: 2, height: 2, color: null }

describe('every office builder words "nothing usable" by verb', () => {
  for (const to of OFFICE) {
    it(`${to}: insert, paste and no verb keep today's line; a drop says "dropped"`, () => {
      for (const verb of TODAY) {
        expect(reasonOf(convertForms([], to, {}, undefined, opts(verb))), `${to} ${verb}`).toBe(`Nothing that was copied is something ${APP[to]} can hold.`)
      }
      expect(reasonOf(convertForms([], to))).toBe(nothingUsable(to))
      expect(reasonOf(convertForms([], to, {}, undefined, { verb: 'drop' }))).toBe(`Nothing that was dropped is something ${APP[to]} can hold.`)
    })
  }
})

describe('refusals of a body, by verb', () => {
  it('a work widget that cannot be placed: "Insert it on a desk" unless dropped', () => {
    for (const to of ['doc', 'sheet', 'slide', 'design', 'diagram', 'draw'] as const) {
      for (const verb of TODAY) {
        expect(reasonOf(convertSnippetBody(calendar, to, {}, opts(verb))), `${to} ${verb}`).toBe(`A calendar work widget cannot be placed in ${APP[to]} yet. Insert it on a desk instead.`)
      }
      expect(reasonOf(convertSnippetBody(calendar, to, {}, { verb: 'drop' }))).toBe(`A calendar work widget cannot be placed in ${APP[to]} yet. Drop it on a desk instead.`)
    }
    expect(widgetReason('calendar', 'doc')).toBe('A calendar work widget cannot be placed in PlexiiWrite yet. Insert it on a desk instead.')
  })

  it('an empty work widget', () => {
    for (const verb of TODAY) expect(reasonOf(convertSnippetBody(emptySticky, 'slide', {}, opts(verb)))).toBe('This work widget is empty, so there is nothing to insert.')
    expect(reasonOf(convertSnippetBody(emptySticky, 'slide', {}, { verb: 'drop' }))).toBe(REASON.widgetEmptyDrop)
    expect(REASON.widgetEmptyDrop).toBe('This work widget is empty, so there is nothing to add.')
  })

  it('an empty body (a Deck selection with nothing drawable, into PlexiiDesign)', () => {
    const empty: SnippetBody = { kind: 'slide', elements: [] }
    for (const verb of TODAY) expect(reasonOf(convertSnippetBody(empty, 'design', {}, opts(verb)))).toBe('There is nothing in this snippet to insert.')
    expect(reasonOf(convertSnippetBody(empty, 'design', {}, { verb: 'drop' }))).toBe('There is nothing in what was dropped to add.')
    expect(reasonOf(convertSnippetBody({ kind: 'design', elements: [] }, 'slide', {}, { verb: 'drop' }))).toBe(REASON.emptyDrop)
  })

  it('PlexiiDraw has no tables, from a body and from rows alone', () => {
    for (const verb of TODAY) {
      expect(reasonOf(convertSnippetBody(F.sheet(), 'draw', {}, opts(verb)))).toBe('PlexiiDraw has no tables; insert it into PlexiiWrite or a page instead.')
      expect(reasonOf(convertForms(rowsOnly, 'draw', {}, undefined, opts(verb)))).toBe(REASON.drawNoTables)
    }
    expect(reasonOf(convertSnippetBody(F.sheet(), 'draw', {}, { verb: 'drop' }))).toBe('PlexiiDraw has no tables; drop it into PlexiiWrite or a page instead.')
    expect(reasonOf(convertForms(rowsOnly, 'draw', {}, undefined, { verb: 'drop' }))).toBe(REASON.drawNoTablesDrop)
  })

  it('the work widget acceptors pass their verb into the shared refusal', () => {
    expect(reasonOf(acceptForPage([], { body: calendar, verb: 'insert' }))).toBe('A calendar work widget cannot be placed in PlexiiWrite yet. Insert it on a desk instead.')
    expect(reasonOf(acceptForPage([], { body: calendar, verb: 'drop' }))).toBe('A calendar work widget cannot be placed in PlexiiWrite yet. Drop it on a desk instead.')
    expect(reasonOf(acceptForTextWidget('sticky', [], { body: emptySticky, verb: 'drop' }))).toBe(REASON.widgetEmptyDrop)
    expect(reasonOf(acceptForTable([], { body: calendar, verb: 'drop' }))).toContain('Drop it on a desk instead.')
    expect(reasonOf(planDesk([], { body: { kind: 'slide', elements: [] }, verb: 'drop' }))).toBe(REASON.emptyDrop)
    const emptyNodes: Form[] = [{ kind: 'docNodes', value: [], lossy: [] }]
    expect(reasonOf(acceptForPage(emptyNodes, { verb: 'paste' }))).toBe('There is nothing in this snippet to insert.')
    expect(reasonOf(acceptForMarkdown(emptyNodes, { verb: 'drop' }))).toBe(REASON.emptyDrop)
    const blank: Form[] = [{ kind: 'text', value: '  ', lossy: [] }]
    expect(reasonOf(acceptForPage(blank, { verb: 'paste' }))).toBe('There is nothing in this to insert.')
    expect(reasonOf(acceptForPage(blank, { verb: 'drop' }))).toBe('There is nothing in this to add.')
  })
})

describe('the verb is wording only', () => {
  it('what lands is identical with any verb, and the same input gives the same output', () => {
    for (const to of OFFICE) {
      for (const body of [F.doc(), F.sheet(), F.slide(), F.STICKY] as SnippetBody[]) {
        const base = JSON.stringify(convertSnippetBody(body, to, F.DEPS))
        for (const verb of ['insert', 'paste', 'drop'] as const) {
          const out = convertSnippetBody(body, to, F.DEPS, { verb })
          if (out.ok) expect(JSON.stringify(out), `${to} ${body.kind} ${verb}`).toBe(base)
          expect(JSON.stringify(convertSnippetBody(body, to, F.DEPS, { verb }))).toBe(JSON.stringify(out))
        }
      }
    }
  })
})

describe('wired from a drop read into the office paste path', () => {
  it('convertClipboard words by the read\'s verb; the clipboard (no verb) keeps today\'s line', () => {
    expect(convertClipboard({ forms: rowsOnly, source: null }, 'draw')).toEqual({ ok: false, reason: REASON.drawNoTables })
    expect(convertClipboard({ forms: rowsOnly, source: null, verb: 'drop' }, 'draw')).toEqual({ ok: false, reason: REASON.drawNoTablesDrop })
    const text: Form[] = [{ kind: 'text', value: 'Hi', lossy: [] }]
    expect(convertClipboard({ forms: text, source: null }, 'doc')).toEqual({ ok: false, reason: 'Nothing that was copied is something PlexiiWrite can hold.' })
    expect(convertClipboard({ forms: text, source: null, verb: 'drop' }, 'doc')).toEqual({ ok: false, reason: 'Nothing that was dropped is something PlexiiWrite can hold.' })
  })
})
