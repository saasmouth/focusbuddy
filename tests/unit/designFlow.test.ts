import { describe, it, expect } from 'vitest'
import {
  defaultParaStyle,
  flowStory,
  freeIntervals,
  hasPageToken,
  resolvePageTokens,
  type FlowMeasurer,
  type FlowParaStyle,
  type FlowParagraph
} from '../../src/shared/designFlow'

// Every character is exactly 10px wide, so each expected break is countable.
const tenPx: FlowMeasurer = (t) => t.length * 10

/** A 10px body style with no spacing, so line positions are trivially readable. */
function body(over: Partial<FlowParaStyle> = {}): FlowParaStyle {
  return { fontSize: 10, lineHeight: 1, font: 'body', align: 'left', spaceAfter: 0, widowLines: 1, ...over }
}
function para(text: string, over: Partial<FlowParaStyle> = {}): FlowParagraph {
  return { text, style: body(over) }
}
function frame(id: string, x: number, y: number, w: number, h: number): { id: string; x: number; y: number; w: number; h: number } {
  return { id, x, y, w, h }
}
function textOf(r: ReturnType<typeof flowStory>, id: string): string[] {
  return (r.byFrame[id] ?? []).map((l) => l.text)
}

describe('designFlow — free intervals', () => {
  it('no obstacles leaves the whole column free', () => {
    expect(freeIntervals(0, 100, 0, 10, [])).toEqual([[0, 100]])
  })

  it('an obstacle in the middle splits the column in two', () => {
    expect(freeIntervals(0, 100, 0, 10, [{ x: 40, y: 0, w: 20, h: 10 }])).toEqual([
      [0, 40],
      [60, 100]
    ])
  })

  it('an obstacle at a different height is ignored', () => {
    expect(freeIntervals(0, 100, 0, 10, [{ x: 40, y: 500, w: 20, h: 10 }])).toEqual([[0, 100]])
  })

  it('an obstacle covering the column leaves nothing', () => {
    expect(freeIntervals(0, 100, 0, 10, [{ x: -10, y: 0, w: 200, h: 10 }])).toEqual([])
  })

  it('the wrap offset widens the exclusion on every side', () => {
    expect(freeIntervals(0, 100, 0, 10, [{ x: 40, y: 0, w: 20, h: 10 }], 5)).toEqual([
      [0, 35],
      [65, 100]
    ])
  })
})

describe('designFlow — pouring a story', () => {
  it('fills one frame and reports no overset when it all fits', () => {
    const r = flowStory({ paragraphs: [para('aaa bbb')], frames: [frame('f1', 0, 0, 200, 100)], measure: tenPx })
    expect(textOf(r, 'f1')).toEqual(['aaa bbb'])
    expect(r.overset).toBe(false)
    expect(r.oversetFrom).toBeNull()
  })

  it('breaks lines at the column width', () => {
    const r = flowStory({ paragraphs: [para('aaa bbb ccc')], frames: [frame('f1', 0, 0, 60, 100)], measure: tenPx })
    expect(textOf(r, 'f1')).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('carries what will not fit into the next frame in the chain', () => {
    const r = flowStory({
      paragraphs: [para('aaa bbb ccc ddd')],
      frames: [frame('f1', 0, 0, 30, 10), frame('f2', 200, 0, 30, 100)],
      measure: tenPx
    })
    expect(textOf(r, 'f1')).toEqual(['aaa'])
    expect(textOf(r, 'f2')).toEqual(['bbb', 'ccc', 'ddd'])
    expect(r.overset).toBe(false)
  })

  it('reports overset, and where it starts, rather than dropping text', () => {
    const r = flowStory({
      paragraphs: [para('aaa'), para('bbb'), para('ccc')],
      frames: [frame('f1', 0, 0, 30, 10)],
      measure: tenPx
    })
    expect(textOf(r, 'f1')).toEqual(['aaa'])
    expect(r.overset).toBe(true)
    expect(r.oversetFrom).toBe(1)
    expect(r.oversetHeight).toBeGreaterThan(0)
  })

  it('each paragraph starts on its own line', () => {
    const r = flowStory({ paragraphs: [para('aaa'), para('bbb')], frames: [frame('f1', 0, 0, 500, 100)], measure: tenPx })
    expect(textOf(r, 'f1')).toEqual(['aaa', 'bbb'])
  })

  it('a word wider than the column is placed whole, never truncated', () => {
    const r = flowStory({ paragraphs: [para('aaaaaaaaaa bb')], frames: [frame('f1', 0, 0, 30, 100)], measure: tenPx })
    expect(textOf(r, 'f1')).toEqual(['aaaaaaaaaa', 'bb'])
  })

  it('with no frames at all, everything is overset from the first paragraph', () => {
    const r = flowStory({ paragraphs: [para('aaa')], frames: [], measure: tenPx })
    expect(r.overset).toBe(true)
    expect(r.oversetFrom).toBe(0)
  })

  it('line positions are relative to their own frame, not the page', () => {
    const r = flowStory({ paragraphs: [para('aaa')], frames: [frame('f1', 300, 400, 100, 100)], measure: tenPx })
    expect(r.byFrame.f1[0]).toMatchObject({ x: 0, y: 0 })
  })
})

describe('designFlow — per-paragraph styling', () => {
  it('each line carries its own resolved type', () => {
    const heading: FlowParagraph = {
      text: 'Big',
      style: body({ fontSize: 30, lineHeight: 1.2, bold: true, color: '#ff0000', font: 'head' })
    }
    const r = flowStory({ paragraphs: [heading, para('small')], frames: [frame('f1', 0, 0, 400, 200)], measure: tenPx })
    const lines = r.byFrame.f1
    expect(lines[0]).toMatchObject({ size: 30, bold: true, color: '#ff0000' })
    expect(lines[1]).toMatchObject({ size: 10 })
  })

  it('a bigger heading pushes the following line further down', () => {
    const r = flowStory({
      paragraphs: [{ text: 'H', style: body({ fontSize: 40, lineHeight: 1 }) }, para('after')],
      frames: [frame('f1', 0, 0, 400, 300)],
      measure: tenPx
    })
    expect(r.byFrame.f1[1].y).toBeCloseTo(40, 6)
  })

  it('space before and after open up the right gaps', () => {
    const r = flowStory({
      paragraphs: [para('one', { spaceAfter: 6 }), para('two', { spaceBefore: 4 })],
      frames: [frame('f1', 0, 0, 400, 300)],
      measure: tenPx
    })
    // 10 (line) + 6 (after) + 4 (before) = 20
    expect(r.byFrame.f1[1].y).toBeCloseTo(20, 6)
  })

  it('space before is suppressed at the top of a frame — a column never opens with a gap', () => {
    const r = flowStory({
      paragraphs: [para('aaa'), para('bbb', { spaceBefore: 50 })],
      frames: [frame('f1', 0, 0, 30, 10), frame('f2', 0, 0, 30, 100)],
      measure: tenPx
    })
    expect(r.byFrame.f2[0].y).toBe(0)
  })

  it('a left inset indents the whole paragraph and a bullet rides on its first line', () => {
    const r = flowStory({
      paragraphs: [para('item one two', { leftInset: 20, bullet: '•' })],
      frames: [frame('f1', 0, 0, 100, 100)],
      measure: tenPx
    })
    expect(r.byFrame.f1[0].x).toBe(20)
    expect(r.byFrame.f1[0].bullet).toBe('•')
    expect(r.byFrame.f1[1]?.bullet).toBeUndefined()
  })

  it('a first-line indent applies only to the first line', () => {
    const r = flowStory({
      paragraphs: [para('aaa bbb ccc', { indent: 15 })],
      frames: [frame('f1', 0, 0, 40, 100)],
      measure: tenPx
    })
    expect(r.byFrame.f1[0].x).toBe(15)
    expect(r.byFrame.f1[1].x).toBe(0)
  })

  it('a rule above appears once, on the paragraph’s first line', () => {
    const r = flowStory({
      paragraphs: [para('aaa bbb', { ruleAbove: { width: 1, thickness: 2, color: '#000' } })],
      frames: [frame('f1', 0, 0, 30, 100)],
      measure: tenPx
    })
    expect(r.byFrame.f1[0].rule).toEqual({ width: 1, thickness: 2, color: '#000' })
    expect(r.byFrame.f1[1].rule).toBeUndefined()
  })

  it('an empty paragraph emits an empty line, so a caret can land on it', () => {
    // A blank paragraph that produced no line at all would be both invisible and
    // unclickable, which makes it impossible to type into on the page.
    const r = flowStory({ paragraphs: [para('aaa'), para(''), para('bbb')], frames: [frame('f1', 0, 0, 400, 300)], measure: tenPx })
    expect(textOf(r, 'f1')).toEqual(['aaa', '', 'bbb'])
    expect(r.byFrame.f1[1].y).toBeCloseTo(10, 6)
    expect(r.byFrame.f1[2].y).toBeCloseTo(20, 6)
  })
})

describe('designFlow — drop caps', () => {
  it('the initial is lifted out and the first lines indent past it', () => {
    const r = flowStory({
      paragraphs: [para('Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma', { dropCapLines: 3 })],
      frames: [frame('f1', 0, 0, 200, 200)],
      measure: tenPx
    })
    const lines = r.byFrame.f1
    expect(lines[0].dropCap?.text).toBe('A')
    // The first line starts past the cap, and the text no longer repeats it.
    expect(lines[0].x).toBeGreaterThan(0)
    expect(lines[0].text.startsWith('lpha')).toBe(true)
    // The cap indents exactly its own number of lines; the measure then returns
    // to the full column width.
    expect(lines.length).toBeGreaterThan(3)
    expect(lines.slice(0, 3).every((l) => l.x > 0)).toBe(true)
    expect(lines[3].x).toBe(0)
  })

  it('no drop cap means no indent and no lost letter', () => {
    const r = flowStory({ paragraphs: [para('Alpha beta')], frames: [frame('f1', 0, 0, 200, 200)], measure: tenPx })
    expect(r.byFrame.f1[0].x).toBe(0)
    expect(r.byFrame.f1[0].text).toBe('Alpha beta')
  })
})

describe('designFlow — keeping type honest at a column foot', () => {
  it('a heading never strands itself as the last line of a frame', () => {
    // The frame holds exactly two 10px lines. Without keep-with-next the heading
    // would sit alone at the foot; with it, it moves to the next frame.
    const r = flowStory({
      paragraphs: [para('aaa'), para('HEAD', { keepWithNext: true }), para('body text here')],
      frames: [frame('f1', 0, 0, 200, 20), frame('f2', 0, 0, 200, 200)],
      measure: tenPx
    })
    expect(textOf(r, 'f1')).toEqual(['aaa'])
    expect(textOf(r, 'f2')[0]).toBe('HEAD')
  })

  it('a heading in the LAST frame is still set rather than lost', () => {
    const r = flowStory({
      paragraphs: [para('aaa'), para('HEAD', { keepWithNext: true })],
      frames: [frame('f1', 0, 0, 200, 20)],
      measure: tenPx
    })
    expect(textOf(r, 'f1')).toEqual(['aaa', 'HEAD'])
  })

  it('a paragraph does not leave a single orphan line behind', () => {
    // Room for two lines; the paragraph needs three, so a widow rule of 2 moves
    // the whole thing rather than leaving one line stranded.
    const r = flowStory({
      paragraphs: [para('aaa'), para('bbb ccc ddd', { widowLines: 2 })],
      frames: [frame('f1', 0, 0, 30, 20), frame('f2', 0, 0, 30, 100)],
      measure: tenPx
    })
    expect(textOf(r, 'f1')).toEqual(['aaa'])
    expect(textOf(r, 'f2')).toEqual(['bbb', 'ccc', 'ddd'])
  })
})

describe('designFlow — wrapping around objects', () => {
  it('text flows down both sides of a central obstacle, then full width below', () => {
    const r = flowStory({
      paragraphs: [para('aa bb cc dd')],
      frames: [{ ...frame('f1', 0, 0, 100, 30), obstacles: [{ x: 40, y: 0, w: 20, h: 10 }] }],
      measure: tenPx
    })
    const lines = r.byFrame.f1
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ x: 0, y: 0, text: 'aa' })
    expect(lines[1]).toMatchObject({ x: 60, y: 0, text: 'bb' })
    expect(lines[2]).toMatchObject({ x: 0, y: 10, text: 'cc dd' })
    expect(r.overset).toBe(false)
  })

  it('a per-frame obstacle does not affect other frames — pages share coordinates', () => {
    const r = flowStory({
      paragraphs: [para('aa bb cc dd ee ff')],
      frames: [
        { ...frame('f1', 0, 0, 100, 10), obstacles: [{ x: 40, y: 0, w: 20, h: 10 }] },
        { ...frame('f2', 0, 0, 100, 40), obstacles: [] }
      ],
      measure: tenPx
    })
    expect(r.byFrame.f1.map((l) => l.x)).toEqual([0, 60])
    expect(r.byFrame.f2.every((l) => l.x === 0)).toBe(true)
  })

  it('a fully blocked line is skipped and the text continues below', () => {
    const r = flowStory({
      paragraphs: [para('aa')],
      frames: [{ ...frame('f1', 0, 0, 100, 30), obstacles: [{ x: -50, y: 0, w: 300, h: 10 }] }],
      measure: tenPx
    })
    expect(r.byFrame.f1).toHaveLength(1)
    expect(r.byFrame.f1[0].y).toBeCloseTo(10, 6)
  })
})

describe('designFlow — defaults and page tokens', () => {
  it('the default paragraph style is usable as-is', () => {
    const st = defaultParaStyle(12)
    expect(st.fontSize).toBe(12)
    expect(st.align).toBe('left')
    expect(st.font).toContain('12px')
  })

  it('replaces the page and total tokens', () => {
    expect(resolvePageTokens('Page {#} of {pages}', { page: 3, pages: 12 })).toBe('Page 3 of 12')
    expect(resolvePageTokens('{#}-{#}', { page: 7, pages: 7 })).toBe('7-7')
  })

  it('leaves ordinary text alone', () => {
    expect(resolvePageTokens('nothing here', { page: 1, pages: 1 })).toBe('nothing here')
    expect(hasPageToken('nothing here')).toBe(false)
    expect(hasPageToken('Page {#}')).toBe(true)
  })
})
