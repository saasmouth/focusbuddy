// @vitest-environment node
// Footnotes end to end through the document, which is where the feature was
// missing: the engine settled notes against the flow and had tests, and
// nothing in the app ever called it. These tests go through applyStoryFlows —
// the same function the editor calls on every change — so they fail if the
// wiring comes loose.
import { describe, it, expect } from 'vitest'
import { applyStoryFlows, footnoteStyle, footnoteLinesFor } from '../../src/shared/designStories'
import { parsePlainText } from '../../src/shared/designContent'
import type { DesignBody } from '../../src/shared/design'
import type { FlowMeasurer, FlowParagraph } from '../../src/shared/designFlow'

const measure: FlowMeasurer = (text, font) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return text.length * ((m ? Number(m[1]) : 10) * 0.5)
}

/** A one-page document with one threaded frame carrying `src` as its story. */
function doc(src: string, frame: { w: number; h: number } = { w: 300, h: 400 }): DesignBody {
  const story = parsePlainText(src, { firstLineIsTitle: false })
  const el = {
    id: 'f1',
    type: 'text' as const,
    x: 20,
    y: 20,
    w: frame.w,
    h: frame.h,
    z: 1,
    storyId: 's1',
    paragraphs: []
  }
  return {
    schemaVersion: 1,
    width: 600,
    height: 800,
    elements: [el],
    pages: [{ id: 'p1', elements: [el] }],
    activePage: 0,
    stories: { s1: story }
  } as unknown as DesignBody
}

const linesOf = (b: DesignBody, id = 'f1'): NonNullable<
  Extract<DesignBody['elements'][number], { type: 'text' }>['flowLines']
> => {
  const el = (b.pages?.[0].elements ?? []).find((e) => e.id === id)
  return ((el as { flowLines?: [] }).flowLines ?? []) as never
}

describe('footnotes through applyStoryFlows', () => {
  it('sets the note at the foot of the frame, below the body text', () => {
    const out = applyStoryFlows(doc('Leipzig[^1] in spring.\n\n[^1]: Rosenthal, p.212.'), measure)
    const lines = linesOf(out)
    const notes = lines.filter((l) => l.footnote)
    const body = lines.filter((l) => !l.footnote)
    expect(body.length).toBeGreaterThan(0)
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0].text).toContain('Rosenthal')
    // Below every line of body text, and inside the frame.
    expect(Math.min(...notes.map((n) => n.y))).toBeGreaterThan(Math.max(...body.map((b) => b.y)))
    expect(Math.max(...notes.map((n) => n.y + n.lh))).toBeLessThanOrEqual(400.01)
  })

  it('puts the marker in the body text and the number on the note', () => {
    const out = applyStoryFlows(doc('Leipzig[^1] in spring.\n\n[^1]: The note.'), measure)
    const lines = linesOf(out)
    expect(lines.find((l) => !l.footnote)?.text).toContain('¹')
    expect(lines.find((l) => l.footnote)?.text?.startsWith('¹')).toBe(true)
    // The token itself never reaches the page.
    expect(lines.every((l) => !l.text.includes('[^'))).toBe(true)
  })

  it('draws a separator rule above the first note only', () => {
    const out = applyStoryFlows(doc('a[^1] b[^2]\n\n[^1]: One.\n\n[^2]: Two.'), measure)
    const notes = linesOf(out).filter((l) => l.footnote)
    expect(notes.filter((l) => l.rule).length).toBe(1)
    expect(notes[0].rule).toBeTruthy()
  })

  it('sets notes smaller than the body, in the body family', () => {
    const out = applyStoryFlows(doc('Body text[^1] here.\n\n[^1]: The note.'), measure)
    const lines = linesOf(out)
    const body = lines.find((l) => !l.footnote)!
    const note = lines.find((l) => l.footnote)!
    expect(note.size).toBeLessThan(body.size)
    expect(note.family).toBe(body.family)
  })

  it('leaves a story without references exactly as it was', () => {
    // Same document, with and without the reference: the body must set
    // identically, because reserving space for a note nobody called would
    // silently repaginate the page.
    const plain = applyStoryFlows(doc('Body text here.\n\n[^1]: An unused note.'), measure)
    const lines = linesOf(plain)
    expect(lines.every((l) => !l.footnote)).toBe(true)
    const bare = applyStoryFlows(doc('Body text here.'), measure)
    expect(linesOf(plain).map((l) => l.text)).toEqual(linesOf(bare).map((l) => l.text))
  })

  it('never sets the note text as body copy', () => {
    const out = applyStoryFlows(doc('Short[^1].\n\n[^1]: Definition text.'), measure)
    const body = linesOf(out).filter((l) => !l.footnote)
    expect(body.some((l) => l.text.includes('Definition text'))).toBe(false)
  })

  it('takes the space from the body: less text fits with a note than without', () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
    // The reference goes EARLY in the text on purpose. A marker at the end of
    // a long story oversets with the text it sits in, and a note whose marker
    // is not on the page is correctly not placed — which would make this test
    // pass for the wrong reason.
    const withNote = applyStoryFlows(doc(`first[^1] ${long}\n\n[^1]: A note long enough to take a line or two of the column it sits in.`, { w: 200, h: 160 }), measure)
    const without = applyStoryFlows(doc(`first ${long}`, { w: 200, h: 160 }), measure)
    const bodyLines = (b: DesignBody): number => linesOf(b).filter((l) => !l.footnote).length
    expect(bodyLines(withNote)).toBeLessThan(bodyLines(without))
  })

  it('reports overset honestly when the notes leave no room', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const out = applyStoryFlows(doc(`${long}[^1]\n\n[^1]: Note.`, { w: 150, h: 80 }), measure)
    const el = (out.pages?.[0].elements ?? [])[0] as { overset?: boolean }
    expect(el.overset).toBe(true)
  })
})

describe('the note style', () => {
  const style = (fontSize: number, font = `${fontSize}px Georgia`): FlowParagraph['style'] => ({
    fontSize,
    lineHeight: 1.5,
    font,
    fontFamily: 'Georgia',
    align: 'justify',
    color: '#222',
    indent: 12,
    spaceAfter: 8
  })

  it('takes the body size, not the opening heading', () => {
    const paras: FlowParagraph[] = [
      { text: 'A HEADING', style: style(28, '28px Georgia') },
      { text: 'body one', style: style(10) },
      { text: 'body two', style: style(10) }
    ]
    const s = footnoteStyle(paras)
    expect(s.fontSize).toBeCloseTo(7.8, 1)
    // The font shorthand carries the size the measurer uses, so it has to be
    // rebuilt rather than inherited.
    expect(s.font).toContain('7.8px')
    expect(s.fontFamily).toBe('Georgia')
  })

  it('drops the body rhythm: no first-line indent, no space around, left aligned', () => {
    const s = footnoteStyle([{ text: 'body', style: style(10) }])
    expect(s.indent).toBe(0)
    expect(s.spaceAfter).toBe(0)
    expect(s.spaceBefore).toBe(0)
    expect(s.align).toBe('left')
  })

  it('never goes below 6px, however small the body is', () => {
    expect(footnoteStyle([{ text: 'x', style: style(5, '5px Georgia') }]).fontSize).toBe(6)
  })
})

describe('placing the note lines', () => {
  const style = { fontSize: 8, lineHeight: 1.3, font: '8px Test', align: 'left' as const, color: '#333' }

  it('returns nothing when the placement is empty', () => {
    expect(footnoteLinesFor({ frameId: 'f', notes: [], height: 0 }, { w: 200, h: 300 }, style, measure, 10)).toEqual([])
  })

  it('stacks two notes in order, the second below the first', () => {
    const lines = footnoteLinesFor(
      {
        frameId: 'f',
        notes: [
          { id: 'a', marker: '¹', text: 'First.' },
          { id: 'b', marker: '²', text: 'Second.' }
        ],
        height: 60
      },
      { w: 200, h: 300 },
      style,
      measure,
      10
    )
    const first = lines.find((l) => l.text.includes('First'))!
    const second = lines.find((l) => l.text.includes('Second'))!
    expect(second.y).toBeGreaterThan(first.y)
    expect(lines.every((l) => l.footnote)).toBe(true)
  })
})
