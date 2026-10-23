// Showing a find hit IN the text.
//
// 9d caught the gap from a screenshot: Design selected the right frame and left
// the reader to spot the word. These are the rules for the marks that fix it —
// which hits are marked, which one is emphasised, and the one case where the
// emphasis honestly cannot be worked out.
//
// The marks are computed from the query against the RENDERED text rather than
// mapped from the hits' offsets, because a hit's offsets are into a story
// block and the page shows the flow engine's lines — two different cuts of the
// same words. See designFindHighlights.ts for why mapping between them would
// drift.

import { describe, expect, it } from 'vitest'
import type { DesignBody } from '../../src/shared/design'
import type { SlideTextElement } from '../../src/shared/types'
import { marksForElement, splitByMarks } from '../../src/renderer/src/components/documents/design/designFindHighlights'

function storyFrame(id: string, order: number, lines: Array<{ text: string; lastOfPara: boolean }>): SlideTextElement {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    paragraphs: [],
    storyId: 'st1',
    storyOrder: order,
    flowLines: lines.map((l, i) => ({ x: 0, y: i * 14, w: 300, text: l.text, lastOfPara: l.lastOfPara, size: 12, lh: 14, align: 'left' }))
  } as unknown as SlideTextElement
}

/** Two frames of one story: three paragraphs, the third in the second frame. */
function design(): { d: DesignBody; a: SlideTextElement; b: SlideTextElement } {
  const a = storyFrame('frameA', 1, [
    { text: 'Revenue grew in every region', lastOfPara: true },
    { text: 'The region we opened last', lastOfPara: true }
  ])
  const b = storyFrame('frameB', 2, [{ text: 'A third region entirely', lastOfPara: true }])
  const d = {
    schemaVersion: 1,
    width: 600,
    height: 400,
    elements: [a],
    activePage: 0,
    pages: [
      { id: 'p1', elements: [a] },
      { id: 'p2', elements: [b] }
    ],
    stories: {
      st1: {
        blocks: [
          { kind: 'paragraph', text: 'Revenue grew in every region' },
          { kind: 'paragraph', text: 'The region we opened last' },
          { kind: 'paragraph', text: 'A third region entirely' }
        ]
      }
    }
  } as unknown as DesignBody
  return { d, a, b }
}

describe('every hit in the text is marked', () => {
  it('marks the query in each laid-out line of a threaded story', () => {
    const { d, a } = design()
    const marks = marksForElement(d, a, 'region', {}, null)
    expect([...marks.keys()], 'both lines carry a hit').toEqual([0, 1])
    const line0 = marks.get(0)!
    expect('Revenue grew in every region'.slice(line0[0]!.start, line0[0]!.end)).toBe('region')
  })

  it('marks regardless of case, as the panel counts it', () => {
    const { d, a } = design()
    expect(marksForElement(d, a, 'REGION', {}, null).size, 'case-insensitive by default').toBe(2)
    expect(marksForElement(d, a, 'REGION', { caseSensitive: true }, null).size, 'and not when told otherwise').toBe(0)
  })

  it('marks nothing for an empty query, so clearing the field clears the page', () => {
    const { d, a } = design()
    expect(marksForElement(d, a, '', {}, null).size).toBe(0)
  })

  it('marks an unthreaded frame through its runs', () => {
    const { d } = design()
    const loose = {
      id: 'loose',
      type: 'text',
      x: 0,
      y: 0,
      w: 200,
      h: 50,
      paragraphs: [{ runs: [{ text: 'One region and ' }, { text: 'another region', bold: true }] }]
    } as unknown as SlideTextElement
    const marks = marksForElement(d, loose, 'region', {}, null)
    expect(marks.get(0), 'both hits in the paragraph, in paragraph coordinates').toHaveLength(2)
    const text = 'One region and another region'
    expect(marks.get(0)!.map((m) => text.slice(m.start, m.end))).toEqual(['region', 'region'])
  })
})

describe('the current hit is emphasised, and only it', () => {
  it('picks the right occurrence in a threaded story, in a later frame', () => {
    const { d, a, b } = design()
    // The panel is on the hit in block 2 — the paragraph laid out in frame B.
    const current = { key: 's|st1|2', start: 8, end: 14 }
    const inB = marksForElement(d, b, 'region', {}, current)
    expect(inB.get(0)!.map((m) => m.current), 'the hit in frame B is the current one').toEqual([true])
    // And nothing in frame A is emphasised, though both lines are still marked.
    const inA = marksForElement(d, a, 'region', {}, current)
    expect(inA.size, 'still marked').toBe(2)
    expect(inA.get(0)!.concat(inA.get(1)!).some((m) => m.current), 'but none emphasised').toBe(false)
  })

  it('distinguishes two hits in the SAME paragraph', () => {
    const d = {
      ...design().d,
      stories: { st1: { blocks: [{ kind: 'paragraph', text: 'region and region again' }] } },
      pages: [{ id: 'p1', elements: [storyFrame('frameA', 1, [{ text: 'region and region again', lastOfPara: true }])] }]
    } as unknown as DesignBody
    const el = d.pages![0]!.elements[0] as SlideTextElement
    // The SECOND occurrence starts at 11.
    const marks = marksForElement(d, el, 'region', {}, { key: 's|st1|0', start: 11, end: 17 })
    expect(marks.get(0)!.map((m) => m.current)).toEqual([false, true])
  })

  it('emphasises the right run of an unthreaded paragraph', () => {
    const { d } = design()
    const loose = {
      id: 'loose',
      type: 'text',
      x: 0,
      y: 0,
      w: 200,
      h: 50,
      paragraphs: [{ runs: [{ text: 'One region and ' }, { text: 'another region' }] }]
    } as unknown as SlideTextElement
    // 'f|<page>|<elementId>|<para>' — the second hit starts at 23.
    const marks = marksForElement(d, loose, 'region', {}, { key: 'f|0|loose|0', start: 23, end: 29 })
    expect(marks.get(0)!.map((m) => m.current)).toEqual([false, true])
  })
})

describe('splitByMarks is what the renderer draws', () => {
  it('splits a line into plain and marked pieces, in order', () => {
    const parts = splitByMarks('Revenue grew in every region', [{ start: 22, end: 28, current: true }])
    expect(parts.map((p) => p.text)).toEqual(['Revenue grew in every ', 'region'])
    expect(parts.map((p) => !!p.mark)).toEqual([false, true])
    // Rejoining is the original, so nothing is dropped or duplicated on screen.
    expect(parts.map((p) => p.text).join('')).toBe('Revenue grew in every region')
  })

  it('returns the text whole when there is nothing to mark', () => {
    expect(splitByMarks('untouched', undefined)).toEqual([{ text: 'untouched', mark: null }])
  })

  it('handles a mark at the very start and at the very end', () => {
    const a = splitByMarks('region here', [{ start: 0, end: 6, current: false }])
    expect(a.map((p) => p.text)).toEqual(['region', ' here'])
    const b = splitByMarks('here region', [{ start: 5, end: 11, current: false }])
    expect(b.map((p) => p.text)).toEqual(['here ', 'region'])
    expect(b.map((p) => p.text).join('')).toBe('here region')
  })
})
