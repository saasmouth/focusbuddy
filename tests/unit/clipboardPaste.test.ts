// ⌘V from one of our apps into another (renderer/src/lib/clipboardPaste.ts):
// the same conversion a snippet insert runs, the one-line notice when it was
// converted, a refusal's reason verbatim, and nothing done when the clipboard
// holds nothing (so the app's own paste can run). Plus the synchronous test an
// editor makes on a paste event before the browser's own paste would run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertClipboard, fromAnotherApp, pasteConverted, pastedSnippet } from '../../src/renderer/src/lib/clipboardPaste'
import { formsFromClipboardRead, markCellsCopy, pasteNeedsConversion, resetCellsCopy, DIAGRAM_CLIP_MIME, type ClipboardForms } from '../../src/renderer/src/lib/clipboardForms'
import { useNoticeStore } from '../../src/renderer/src/stores/notice'
import { ELEMENT_CLIP_MIME } from '../../src/shared/elementClipboard'
import { formsOf } from '../../src/shared/snippetForms'
import { REASON } from '../../src/shared/snippetConvert/common'
import * as F from './snippetConvertFixtures'

const fromApp = (body: Parameters<typeof formsOf>[0]): ClipboardForms => ({ forms: formsOf(body, F.DEPS), source: 'x', kind: body.kind })

beforeEach(() => useNoticeStore.getState().clear())
afterEach(() => resetCellsCopy())

describe('pasteConverted', () => {
  it('a Cells range into Diagrams: a table shape through the app’s insert, and the conversion said', async () => {
    const insert = vi.fn(() => true)
    expect(await pasteConverted('diagram', insert, { read: fromApp(F.sheet()) })).toBe('pasted')
    const body = (insert.mock.calls[0] as unknown as [{ kind: string; nodes: Array<{ shape: string }> }])[0]
    expect(body.kind).toBe('diagram')
    expect(body.nodes[0].shape).toBe('table-header')
    expect(useNoticeStore.getState().notice?.text).toBe('Formulas become their values. Cell formatting is not kept.')
  })

  it('a refused pair shows the reason verbatim and inserts nothing', async () => {
    const insert = vi.fn(() => true)
    expect(await pasteConverted('sheet', insert, { read: fromApp(F.draw()) })).toBe('refused')
    expect(insert).not.toHaveBeenCalled()
    expect(useNoticeStore.getState().notice?.text).toBe(REASON.cellsNoPictures)
  })

  it('a newer PlexiiDraw’s copy is refused with its own reason', async () => {
    expect(await pasteConverted('doc', () => true, { read: { forms: [], source: 'PlexiiDraw', kind: 'draw', refused: 'Update PlexiiDraw.' } })).toBe('refused')
    expect(useNoticeStore.getState().notice?.text).toBe('Update PlexiiDraw.')
  })

  it('an empty clipboard does nothing, so the app’s own paste can run', async () => {
    const insert = vi.fn(() => true)
    expect(await pasteConverted('doc', insert, { read: { forms: [], source: null, kind: null } })).toBe('nothing')
    expect(insert).not.toHaveBeenCalled()
    expect(useNoticeStore.getState().notice).toBeNull()
  })

  it('the app declining with a reason shows it; a faithful paste of plain content says nothing', async () => {
    expect(await pasteConverted('sheet', () => ({ ok: false, reason: 'You can’t change part of a merged cell.' }), { read: fromApp(F.doc()) })).toBe('refused')
    expect(useNoticeStore.getState().notice?.text).toBe('You can’t change part of a merged cell.')
    useNoticeStore.getState().clear()
    const text = formsFromClipboardRead({ text: 'One\nTwo' })
    expect(await pasteConverted('diagram', () => true, { read: text })).toBe('pasted')
    expect(useNoticeStore.getState().notice?.text).toBe('Each paragraph becomes a note.')
  })

  it('convertClipboard names the source app in a faithful conversion', () => {
    const r = convertClipboard(fromApp({ kind: 'slide', elements: F.slide().elements }), 'design')
    expect(r && r.ok && r.notice).toBe('Converted from PlexiiDeck for PlexiiDesign.')
  })

  it('pastedSnippet only dresses the body; it is never a saved snippet', () => {
    const s = pastedSnippet(F.sheet())
    expect(s.kind).toBe('sheet')
    expect(s.id).toBe('clipboard')
  })
})

describe('deciding on a paste event', () => {
  const dt = (data: Record<string, string>, extraTypes: string[] = []): DataTransfer =>
    ({ types: [...Object.keys(data), ...extraTypes], getData: (t: string) => data[t] ?? '' }) as unknown as DataTransfer

  it('our private types, a Diagrams clip in the text, or a Cells range: converted', () => {
    expect(pasteNeedsConversion(dt({ [ELEMENT_CLIP_MIME]: '{}', 'text/plain': 'words' }))).toBe(true)
    expect(pasteNeedsConversion(dt({ [DIAGRAM_CLIP_MIME]: '{}' }))).toBe(true)
    expect(pasteNeedsConversion(dt({ 'text/plain': '{"marker":"plexii-diagram/v1"}' }))).toBe(true)
    markCellsCopy('a\tb', { r: 0, c: 0 })
    expect(pasteNeedsConversion(dt({ 'text/plain': 'a\tb' }))).toBe(true)
  })

  it('a clipboard of only pictures (a PlexiiDraw copy, a screenshot): converted', () => {
    expect(pasteNeedsConversion(dt({}, ['Files']))).toBe(true)
  })

  it('HTML or text from anywhere else keeps the app’s own paste', () => {
    expect(pasteNeedsConversion(dt({ 'text/html': '<b>x</b>', 'text/plain': 'x' }))).toBe(false)
    expect(pasteNeedsConversion(dt({ 'text/plain': 'a\tb' }))).toBe(false)
    expect(pasteNeedsConversion(dt({}))).toBe(false)
    expect(pasteNeedsConversion(null)).toBe(false)
  })

  it('fromAnotherApp: our other apps, and a refusal; never the app’s own copy or foreign content', () => {
    expect(fromAnotherApp(fromApp(F.sheet()), 'doc')).toBe(true)
    expect(fromAnotherApp(fromApp(F.sheet()), 'sheet')).toBe(false)
    expect(fromAnotherApp({ forms: [], source: null, kind: null }, 'doc')).toBe(false)
    expect(fromAnotherApp({ forms: [], source: 'PlexiiDraw', kind: 'draw', refused: 'x' }, 'draw')).toBe(true)
  })
})
