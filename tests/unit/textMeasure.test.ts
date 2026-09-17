import { describe, it, expect } from 'vitest'
import { fontShorthand, layoutText, wrapText, type Measurer } from '../../src/renderer/src/components/documents/draw/textMeasure'

// A deterministic stand-in for the browser's font engine: every character is
// exactly 10px wide. Makes every expected break countable by hand.
const tenPx: Measurer = (text) => text.length * 10

describe('textMeasure — font shorthand', () => {
  it('builds a valid CSS font string', () => {
    expect(fontShorthand({ fontSize: 16 })).toBe('16px Inter, system-ui, sans-serif')
    expect(fontShorthand({ fontSize: 16, fontWeight: 700, italic: true, fontFamily: 'Georgia' })).toBe('italic 700 16px Georgia')
  })
})

describe('textMeasure — wrapping', () => {
  it('breaks when the next word would overflow', () => {
    // "aaa bbb" is 70px; a 50px column fits only one 3-letter word.
    expect(wrapText({ text: 'aaa bbb', width: 50, font: '', measure: tenPx })).toEqual(['aaa', 'bbb'])
  })

  it('keeps words together when they fit', () => {
    expect(wrapText({ text: 'aaa bbb', width: 200, font: '', measure: tenPx })).toEqual(['aaa bbb'])
  })

  it('explicit newlines always break, and blank lines survive', () => {
    expect(wrapText({ text: 'a\n\nb', width: 999, font: '', measure: tenPx })).toEqual(['a', '', 'b'])
  })

  it('a word wider than the column is kept whole, never truncated', () => {
    expect(wrapText({ text: 'aaaaaaaaaa', width: 20, font: '', measure: tenPx })).toEqual(['aaaaaaaaaa'])
  })

  it('leading spaces on a wrapped line are absorbed by the break', () => {
    const lines = wrapText({ text: 'aaa bbb ccc', width: 50, font: '', measure: tenPx })
    expect(lines).toEqual(['aaa', 'bbb', 'ccc'])
    expect(lines.every((l) => l === l.trim())).toBe(true)
  })

  it('letter spacing counts toward the line width', () => {
    // 6 chars x 10px = 60px; +5px tracking x 5 gaps = 85px, past a 70px column.
    expect(wrapText({ text: 'aaa bb', width: 70, font: '', measure: tenPx, letterSpacing: 5 })).toEqual(['aaa', 'bb'])
  })

  it('empty text yields one empty line rather than nothing to render', () => {
    expect(wrapText({ text: '', width: 100, font: '', measure: tenPx })).toEqual([''])
  })
})

describe('textMeasure — layout', () => {
  it('height is line count times leading', () => {
    const l = layoutText({ text: 'aaa bbb', width: 50, font: '', measure: tenPx, fontSize: 20, lineHeight: 1.5 })
    expect(l.lines).toHaveLength(2)
    expect(l.height).toBeCloseTo(60, 6)
  })

  it('a single line still has one line of height', () => {
    expect(layoutText({ text: '', width: 50, font: '', measure: tenPx, fontSize: 10 }).height).toBeCloseTo(12, 6)
  })
})
