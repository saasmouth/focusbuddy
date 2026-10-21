// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { adviseDesign, adviceSummary, type Advice } from '../../src/shared/designAdvisor'
import type { DesignBody } from '../../src/shared/design'
import type { SlideElement, SlideTextElement } from '../../src/shared/types'
import type { FlowLine } from '../../src/shared/designFlow'

// Advice that can be wrong is worse than none: a panel that cries wolf gets
// closed and never reopened. So every rule is tested in both directions — it
// fires on the fault, and it stays silent on a document that is fine.

const line = (text: string, over: Partial<FlowLine> = {}): FlowLine => ({
  x: 0, y: 0, w: 400, text, lastOfPara: false,
  size: 16, lh: 24, align: 'left', para: 0, start: 0, end: text.length,
  ...over
})

const text = (over: Partial<SlideTextElement> = {}): SlideTextElement => ({
  id: 't1', type: 'text', x: 50, y: 50, w: 400, h: 200, z: 1,
  paragraphs: [{ runs: [{ text: 'Hello', fontSize: 16, color: '#111111' }] }],
  ...over
}) as SlideTextElement

const doc = (els: SlideElement[], over: Partial<DesignBody> = {}): DesignBody => ({
  schemaVersion: 1, width: 816, height: 1056,
  background: { kind: 'solid', color: '#ffffff' },
  elements: els,
  ...over
}) as DesignBody

const rules = (a: Advice[]): string[] => a.map((x) => x.rule)

describe('a document with nothing wrong', () => {
  // The most important test here. Everything else is noise if this fires.
  const clean = doc([
    text({
      id: 'head',
      paragraphs: [{ runs: [{ text: 'A clear headline', fontSize: 36, color: '#111111' }] }],
      flowLines: [line('A clear headline', { size: 36, lh: 44 })]
    }),
    text({
      id: 'body', y: 160,
      paragraphs: [{ runs: [{ text: 'Body copy', fontSize: 16, color: '#222222' }] }],
      flowLines: Array.from({ length: 8 }, () =>
        line('A line of body copy about sixty characters long, give or take.')
      )
    })
  ], { margins: { top: 40, right: 40, bottom: 40, left: 40 } })

  it('says nothing', () => {
    expect(adviseDesign(clean)).toEqual([])
    expect(adviceSummary([])).toBe('No issues found')
  })
})

describe('text that does not fit', () => {
  it('is reported as a problem, because readers never see it', () => {
    const a = adviseDesign(doc([text({ oversetHere: true } as Partial<SlideTextElement>)]))
    expect(rules(a)).toContain('overset')
    expect(a.find((x) => x.rule === 'overset')?.severity).toBe('problem')
  })
})

describe('contrast', () => {
  it('catches pale text on a white page', () => {
    const a = adviseDesign(doc([
      text({ paragraphs: [{ runs: [{ text: 'faint', fontSize: 14, color: '#dddddd' }] }] })
    ]))
    expect(rules(a)).toContain('contrast')
    expect(a.find((x) => x.rule === 'contrast')?.title).toMatch(/:1/)
  })

  it('allows large type the lower threshold WCAG gives it', () => {
    // #949494 on white is about 3.1:1 — too pale for body, fine at 32px.
    const big = adviseDesign(doc([
      text({ flowLines: [line('Big', { size: 32, color: '#949494' })] })
    ]))
    const small = adviseDesign(doc([
      text({ flowLines: [line('Small', { size: 12, color: '#949494' })] })
    ]))
    expect(rules(big)).not.toContain('contrast')
    expect(rules(small)).toContain('contrast')
  })

  it('says nothing when there is no known background to compare against', () => {
    const a = adviseDesign(doc([text({ flowLines: [line('x', { color: '#eeeeee' })] })], { background: undefined }))
    expect(rules(a)).not.toContain('contrast')
  })
})

describe('line length', () => {
  const long = 'x'.repeat(120)
  it('flags an over-long measure', () => {
    const a = adviseDesign(doc([text({ flowLines: Array.from({ length: 6 }, () => line(long)) })]))
    expect(rules(a)).toContain('measure-long')
  })

  it('flags a very narrow measure', () => {
    const a = adviseDesign(doc([text({ flowLines: Array.from({ length: 6 }, () => line('tiny col')) })]))
    expect(rules(a)).toContain('measure-short')
  })

  it('ignores a short block, where the average means nothing', () => {
    const a = adviseDesign(doc([text({ flowLines: [line(long), line(long)] })]))
    expect(rules(a)).not.toContain('measure-long')
  })

  it('ignores last lines of paragraphs, which are short by nature', () => {
    const a = adviseDesign(doc([
      text({ flowLines: Array.from({ length: 6 }, () => line('end.', { lastOfPara: true })) })
    ]))
    expect(rules(a)).not.toContain('measure-short')
  })
})

describe('leading', () => {
  it('flags body text set tighter than its own size', () => {
    const a = adviseDesign(doc([text({ flowLines: [line('cramped', { size: 16, lh: 17 })] })]))
    expect(rules(a)).toContain('leading')
  })

  it('leaves a large display line alone, where tight leading is a choice', () => {
    const a = adviseDesign(doc([text({ flowLines: [line('DISPLAY', { size: 48, lh: 50 })] })]))
    expect(rules(a)).not.toContain('leading')
  })
})

describe('position', () => {
  it('flags an element outside the margins', () => {
    const a = adviseDesign(doc([text({ x: 5, y: 5 })], { margins: { top: 40, right: 40, bottom: 40, left: 40 } }))
    expect(rules(a)).toContain('margins')
  })

  it('flags an element off the page as a problem, since it will not export', () => {
    const a = adviseDesign(doc([text({ x: 5000, y: 5000 })]))
    const off = a.find((x) => x.rule === 'offcanvas')
    expect(off?.severity).toBe('problem')
  })

  it('does not call a bleed element a stray', () => {
    const a = adviseDesign(doc([text({ x: -10, y: -10, w: 100, h: 100 })], { bleed: 20 }))
    expect(rules(a)).not.toContain('offcanvas')
  })
})

describe('whole-document rules', () => {
  it('counts typefaces and objects past three', () => {
    const els = ['A', 'B', 'C', 'D'].map((f, i) =>
      text({ id: `t${i}`, fontFamily: `Font${f}`, flowLines: [line('x')] })
    )
    expect(rules(adviseDesign(doc(els)))).toContain('fonts')
    expect(rules(adviseDesign(doc(els.slice(0, 2))))).not.toContain('fonts')
  })

  it('counts type sizes past six', () => {
    const els = [10, 12, 14, 18, 24, 32, 48].map((sz, i) =>
      text({ id: `t${i}`, flowLines: [line('x', { size: sz })] })
    )
    expect(rules(adviseDesign(doc(els)))).toContain('sizes')
  })

  it('notices when nothing stands out', () => {
    const els = [16, 17, 16, 18].map((sz, i) => text({ id: `t${i}`, flowLines: [line('x', { size: sz })] }))
    expect(rules(adviseDesign(doc(els)))).toContain('hierarchy')
  })

  it('stays quiet when the headline clearly dominates', () => {
    const els = [
      text({ id: 'h', flowLines: [line('Headline', { size: 48 })] }),
      text({ id: 'b1', flowLines: [line('body', { size: 16 })] }),
      text({ id: 'b2', flowLines: [line('body', { size: 16 })] })
    ]
    expect(rules(adviseDesign(doc(els)))).not.toContain('hierarchy')
  })
})

describe('the panel contract', () => {
  const messy = doc([
    text({ id: 'a', x: 5000, y: 5000 }),
    text({ id: 'b', paragraphs: [{ runs: [{ text: 'f', fontSize: 12, color: '#eeeeee' }] }] })
  ], { margins: { top: 40, right: 40, bottom: 40, left: 40 } })

  it('puts problems before suggestions', () => {
    const a = adviseDesign(messy)
    const firstSuggestion = a.findIndex((x) => x.severity !== 'problem')
    const lastProblem = a.map((x) => x.severity).lastIndexOf('problem')
    if (firstSuggestion >= 0) expect(lastProblem).toBeLessThan(firstSuggestion)
  })

  it('is deterministic — the same document gives the same advice in the same order', () => {
    // A panel whose contents shuffle on every keystroke is unusable, and a
    // rule that fires intermittently cannot be trusted or fixed.
    expect(adviseDesign(messy)).toEqual(adviseDesign(messy))
  })

  it('gives every piece of advice a stable id, so one can be dismissed', () => {
    const a = adviseDesign(messy)
    expect(new Set(a.map((x) => x.id)).size).toBe(a.length)
    expect(adviseDesign(messy).map((x) => x.id)).toEqual(a.map((x) => x.id))
  })

  it('honours mute and limit', () => {
    expect(rules(adviseDesign(messy, { mute: ['offcanvas'] }))).not.toContain('offcanvas')
    expect(adviseDesign(messy, { limit: 1 })).toHaveLength(1)
  })

  it('summarises for a status bar', () => {
    expect(adviceSummary(adviseDesign(messy))).toMatch(/problem/)
  })
})

describe('multi-page documents', () => {
  it('advises on every page and says which', () => {
    const body = doc([], {
      pages: [
        { id: 'p1', elements: [text({ id: 'x', x: 5000, y: 5000 })] },
        { id: 'p2', elements: [text({ id: 'y', x: 6000, y: 6000 })] }
      ]
    })
    const a = adviseDesign(body)
    expect(a.filter((x) => x.rule === 'offcanvas')).toHaveLength(2)
    expect(new Set(a.map((x) => x.page))).toEqual(new Set([0, 1]))
  })
})
