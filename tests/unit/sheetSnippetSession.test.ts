// A sheet snippet wrapped as a workbook and unwrapped again.
//
// The round trip is the whole point. The wrapper is deliberately BIGGER than the
// snippet — a 2x2 block in a 2x2 grid leaves nowhere to type — which makes
// trimming on the way out the half that matters: without it a snippet grows by
// the editing room every time it is opened and saved, and then inserts at that
// size everywhere it is used.
import { describe, it, expect } from 'vitest'
import { wrapSheetSnippet, unwrapSheetSnippet } from '../../src/renderer/src/components/documents/sheet/snippetSession'
import type { SheetSnippetBody } from '../../src/shared/snippets'

const block: SheetSnippetBody = {
  kind: 'sheet',
  rows: [
    ['Item', 'Qty'],
    ['Bolt', '=2*3']
  ]
}

describe('wrapping, so there is room to edit', () => {
  it('puts the block at the top-left of a larger grid', () => {
    const doc = wrapSheetSnippet(block)
    const tab = doc.sheets[0]!
    expect(tab.rows[0]!.slice(0, 2)).toEqual(['Item', 'Qty'])
    expect(tab.rows[1]!.slice(0, 2)).toEqual(['Bolt', '=2*3'])
    expect(tab.rows.length).toBeGreaterThan(block.rows.length)
    expect(tab.columns.length).toBeGreaterThan(2)
  })

  it('keeps formulas as written rather than evaluating them', () => {
    const tab = wrapSheetSnippet(block).sheets[0]!
    expect(tab.rows[1]![1]).toBe('=2*3')
  })

  it('carries per-cell formats, which are already block-relative', () => {
    const doc = wrapSheetSnippet({ ...block, formats: { '0,0': { bold: true } } })
    expect(doc.sheets[0]!.formats).toEqual({ '0,0': { bold: true } })
  })
})

describe('unwrapping trims back to the content', () => {
  it('round-trips the block unchanged, which is the property that matters', () => {
    expect(unwrapSheetSnippet(wrapSheetSnippet(block))).toEqual(block)
  })

  it('does not grow by the editing room, however many times it is edited', () => {
    // Twice through: a snippet edited twice must be the same shape as one edited
    // once. Growth here would be invisible until it inserted at the wrong size.
    const once = unwrapSheetSnippet(wrapSheetSnippet(block))
    const twice = unwrapSheetSnippet(wrapSheetSnippet(once))
    expect(twice).toEqual(block)
    expect(twice.rows.length).toBe(2)
    expect(twice.rows[0]!.length).toBe(2)
  })

  it('keeps a genuine edit that extends the block', () => {
    const doc = wrapSheetSnippet(block)
    doc.sheets[0]!.rows[2]![0] = 'Nut'
    doc.sheets[0]!.rows[2]![2] = 'extra col'
    const out = unwrapSheetSnippet(doc)
    expect(out.rows.length).toBe(3)
    // Widened to the furthest real cell, and the gap filled so the block stays
    // rectangular.
    expect(out.rows[2]).toEqual(['Nut', '', 'extra col'])
    expect(out.rows[0]).toEqual(['Item', 'Qty', ''])
  })

  it('drops formats for cells the trimmed block no longer has', () => {
    // Otherwise styling for a deleted cell rides along forever and reappears if
    // the block later grows back over it.
    const doc = wrapSheetSnippet({ ...block, formats: { '0,0': { bold: true } } })
    doc.sheets[0]!.formats = { '0,0': { bold: true }, '9,9': { bold: true } }
    expect(unwrapSheetSnippet(doc).formats).toEqual({ '0,0': { bold: true } })
  })

  it('an emptied grid unwraps to an empty block, not to blank padding', () => {
    const doc = wrapSheetSnippet(block)
    doc.sheets[0]!.rows = doc.sheets[0]!.rows.map((r) => r.map(() => ''))
    // updateSnippet refuses an empty body, so this surfaces as a refusal the
    // user can act on rather than a snippet full of blank cells.
    expect(unwrapSheetSnippet(doc).rows).toEqual([])
  })
})
