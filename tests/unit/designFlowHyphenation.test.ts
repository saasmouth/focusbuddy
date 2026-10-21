// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { flowStory, type FlowFrame, type FlowParagraph, type FlowParaStyle } from '../../src/shared/designFlow'

// Wiring tests, not algorithm tests — hyphenate.test.ts covers where words
// break. What matters here is that breaking a word across a line never loses
// text, never DUPLICATES it, and stays off when it was not asked for.

const measure = (text: string, font: string): number => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return text.length * ((m ? Number(m[1]) : 10) * 0.5)
}

const style = (over: Partial<FlowParaStyle> = {}): FlowParaStyle => ({
  fontSize: 10,
  lineHeight: 1.4,
  font: '10px Test',
  align: 'left',
  ...over
})
const para = (text: string, st: Partial<FlowParaStyle> = {}): FlowParagraph => ({ text, style: style(st) })
const frame = (id: string, y: number, h: number, w = 60): FlowFrame => ({ id, x: 0, y, w, h })

/** Every character the flow actually emitted, hyphens stripped. */
const emitted = (lines: Array<{ text: string }>): string =>
  lines.map((l) => l.text).join(' ').replace(/-\s+/g, '').replace(/\s+/g, ' ').trim()

describe('off by default', () => {
  it('does not break words unless the style asks', () => {
    const r = flowStory({ paragraphs: [para('hyphenation typesetting')], frames: [frame('f', 0, 200)], measure })
    for (const l of r.byFrame.f) expect(l.text).not.toMatch(/-$/)
  })
})

describe('when the style asks', () => {
  it('breaks a word that will not fit, and marks it with a hyphen', () => {
    const r = flowStory({
      paragraphs: [para('aaa hyphenation', { hyphenate: true })],
      frames: [frame('f', 0, 200, 55)],
      measure
    })
    const joined = r.byFrame.f.map((l) => l.text).join('|')
    expect(joined).toMatch(/-\|/)
  })

  it('loses no characters when it breaks', () => {
    // The property that matters most: a hyphen is a rendering detail, the
    // text has to survive it intact.
    const text = 'aaa hyphenation typesetting university photograph'
    const r = flowStory({
      paragraphs: [para(text, { hyphenate: true })],
      frames: [frame('f', 0, 400, 55)],
      measure
    })
    expect(emitted(r.byFrame.f)).toBe(text)
  })

  it('does not duplicate the tail', () => {
    // The failure this design most had to avoid. setParagraph hands back a
    // WORD index, not an offset inside a word, so a half-placed word left at
    // a frame edge would be re-emitted whole in the next frame.
    const text = 'aaa hyphenation typesetting university'
    const r = flowStory({
      paragraphs: [para(text, { hyphenate: true })],
      frames: [frame('a', 0, 40, 55), frame('b', 100, 400, 55)],
      measure
    })
    const all = emitted([...r.byFrame.a, ...r.byFrame.b])
    expect(all).toBe(text)
    // No word appears more often than it does in the source.
    for (const w of ['hyphenation', 'typesetting', 'university']) {
      expect(all.split(w).length - 1).toBe(1)
    }
  })

  it('refuses to break when the remainder could not land in this frame', () => {
    // One line of room left: breaking here would strand the tail, so the whole
    // word moves on instead.
    const r = flowStory({
      paragraphs: [para('aaa hyphenation', { hyphenate: true })],
      frames: [frame('a', 0, 15, 55), frame('b', 100, 400, 55)],
      measure
    })
    for (const l of r.byFrame.a) expect(l.text).not.toMatch(/-$/)
  })

  it('keeps character ranges honest across a break', () => {
    // start/end are what turn a click into a caret. A broken word must report
    // the half it actually drew, not the whole word.
    const text = 'aaa hyphenation'
    const r = flowStory({
      paragraphs: [para(text, { hyphenate: true })],
      frames: [frame('f', 0, 200, 55)],
      measure
    })
    for (const l of r.byFrame.f) {
      expect(l.start).toBeGreaterThanOrEqual(0)
      expect(l.end).toBeLessThanOrEqual(text.length)
      expect(l.end).toBeGreaterThanOrEqual(l.start)
    }
    const hy = r.byFrame.f.find((l) => l.text.endsWith('-'))
    if (hy) {
      // The range must stop where the hyphen does — mid-word — not at the end
      // of the whole word.
      expect(hy.end).toBeLessThan(text.length)
      // The range covers the WHOLE line, which here is "aaa hyphen" — the
      // earlier words plus the half-word actually drawn. The hyphen itself is
      // rendering, not source, so it is not in the range.
      expect(text.slice(hy.start, hy.end)).toBe(hy.text.replace(/-$/, ''))
    }
  })

  it('still places a word no break can help, rather than dropping it', () => {
    // A word with no legal break point, wider than the column: the existing
    // rule stands — an overflowing word is visible and fixable, a missing one
    // is not.
    const r = flowStory({
      paragraphs: [para('zzqxwjvkxz', { hyphenate: true })],
      frames: [frame('f', 0, 200, 20)],
      measure
    })
    expect(emitted(r.byFrame.f)).toBe('zzqxwjvkxz')
  })

  it('never emits a hyphen on the last line of a paragraph', () => {
    const r = flowStory({
      paragraphs: [para('aaa hyphenation typesetting', { hyphenate: true })],
      frames: [frame('f', 0, 400, 55)],
      measure
    })
    const last = r.byFrame.f[r.byFrame.f.length - 1]
    expect(last.text).not.toMatch(/-$/)
  })
})
