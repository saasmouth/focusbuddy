// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { flowStory, type FlowFrame, type FlowParagraph, type FlowParaStyle } from '../../src/shared/designFlow'

// A baseline grid exists so columns line up across a page. These tests check
// that directly — two frames at different vertical offsets, same grid, lines
// landing on the same rulings — rather than checking that a number changed.

// Monospace-ish measurer: every character is half the size wide, so line
// breaking is predictable and a test failure means the GRID is wrong rather
// than the measurer having had an opinion.
const measure = (text: string, font: string): number => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return text.length * ((m ? Number(m[1]) : 16) * 0.5)
}

const style = (over: Partial<FlowParaStyle> = {}): FlowParaStyle => ({
  fontSize: 10,
  lineHeight: 1.4, // 14px natural
  font: '10px Test',
  align: 'left',
  ...over
})

const para = (text: string, st: Partial<FlowParaStyle> = {}): FlowParagraph => ({ text, style: style(st) })
const frame = (id: string, y: number, h = 400): FlowFrame => ({ id, x: 0, y, w: 300, h })

const WORDS = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')

describe('without a grid', () => {
  it('lines advance by their natural line height', () => {
    const r = flowStory({ paragraphs: [para(WORDS)], frames: [frame('f', 0)], measure })
    const ys = r.byFrame.f.map((l) => l.y)
    expect(ys[1] - ys[0]).toBeCloseTo(14, 5)
  })

  it('snapToGrid alone does nothing — a grid has to exist', () => {
    const r = flowStory({ paragraphs: [para(WORDS, { snapToGrid: true })], frames: [frame('f', 0)], measure })
    expect(r.byFrame.f[1].y - r.byFrame.f[0].y).toBeCloseTo(14, 5)
  })
})

describe('with a grid', () => {
  const grid = { spacing: 18 }

  it('quantises the line height up to the grid', () => {
    // 14px natural, 18px grid: lines must sit 18 apart, not 14.
    const r = flowStory({
      paragraphs: [para(WORDS, { snapToGrid: true })],
      frames: [frame('f', 0)],
      grid,
      measure
    })
    const ys = r.byFrame.f.map((l) => l.y)
    expect(ys.length).toBeGreaterThan(3)
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(18, 5)
  })

  it('puts every line on a grid ruling in PAGE coordinates', () => {
    const f = frame('f', 25) // deliberately not a multiple of the spacing
    const r = flowStory({ paragraphs: [para(WORDS, { snapToGrid: true })], frames: [f], grid, measure })
    for (const l of r.byFrame.f) {
      const pageY = f.y + l.y
      expect(Math.min(pageY % 18, 18 - (pageY % 18))).toBeLessThan(1e-6)
    }
  })

  it('aligns two columns that start at different heights', () => {
    // The actual point of the feature. Frames at y=25 and y=37; their text
    // must still share rulings.
    // Frames must be SHORT enough that the story actually reaches the second
    // one — with a tall first frame everything fits in it and the test would
    // pass while proving nothing about alignment.
    const a = frame('a', 25, 90)
    const b = frame('b', 37, 90)
    const r = flowStory({
      paragraphs: [para(WORDS, { snapToGrid: true }), para(WORDS, { snapToGrid: true })],
      frames: [a, b],
      grid,
      measure
    })
    const pageYs = (f: FlowFrame): number[] => r.byFrame[f.id].map((l) => f.y + l.y)
    const ya = pageYs(a)
    const yb = pageYs(b)
    expect(ya.length).toBeGreaterThan(0)
    expect(yb.length).toBeGreaterThan(0)
    for (const y of [...ya, ...yb]) {
      expect(Math.min(y % 18, 18 - (y % 18))).toBeLessThan(1e-6)
    }
  })

  it('honours an offset, so the grid can start below a header', () => {
    const f = frame('f', 0)
    const r = flowStory({
      paragraphs: [para(WORDS, { snapToGrid: true })],
      frames: [f],
      grid: { spacing: 18, offset: 7 },
      measure
    })
    for (const l of r.byFrame.f) {
      const rel = (l.y - 7) % 18
      expect(Math.min(Math.abs(rel), 18 - Math.abs(rel))).toBeLessThan(1e-6)
    }
  })

  it('only moves text DOWN, never up into what sits above it', () => {
    // Needs a paragraph ABOVE it: spaceBefore is deliberately suppressed at
    // the top of a column, so a lone first paragraph starts at 0 and there is
    // nothing to snap away from.
    const r = flowStory({
      paragraphs: [
        para('first', { snapToGrid: true }),
        para('second', { snapToGrid: true, spaceBefore: 5 })
      ],
      frames: [frame('f', 0)],
      grid,
      measure
    })
    const lines = r.byFrame.f
    expect(lines).toHaveLength(2)
    // The second line sits at or below where it would naturally have gone,
    // never pulled up onto the line above.
    expect(lines[1].y).toBeGreaterThanOrEqual(lines[0].y + lines[0].lh - 0.01)
    expect(Math.min(lines[1].y % 18, 18 - (lines[1].y % 18))).toBeLessThan(1e-6)
  })

  it('leaves unlocked paragraphs on their natural rhythm', () => {
    // Per paragraph style, as in InDesign: a heading should not be forced onto
    // a body rhythm it does not divide into.
    const r = flowStory({
      paragraphs: [para(WORDS, { snapToGrid: false })],
      frames: [frame('f', 0)],
      grid,
      measure
    })
    const ys = r.byFrame.f.map((l) => l.y)
    expect(ys[1] - ys[0]).toBeCloseTo(14, 5)
  })

  it('never loses text: everything still flows, just further down', () => {
    // Snapping pushes lines down, so a frame holds fewer of them. The words
    // that no longer fit must overset rather than vanish.
    const tight = frame('f', 0, 60)
    const plain = flowStory({ paragraphs: [para(WORDS)], frames: [tight], measure })
    const snapped = flowStory({
      paragraphs: [para(WORDS, { snapToGrid: true })],
      frames: [tight],
      grid,
      measure
    })
    expect(snapped.byFrame.f.length).toBeLessThanOrEqual(plain.byFrame.f.length)
    expect(snapped.overset).toBe(true)
  })

  it('keeps every line inside its frame', () => {
    // Both ends, and the TOP end matters more than it looks. Snapping is done
    // in page coordinates and converted back to frame-local; get that
    // conversion wrong and y goes negative — text drawn above the frame,
    // which still lands on the page grid and so passes every alignment check
    // while being visibly broken. A mutation doing exactly that survived
    // until this assertion existed.
    for (const h of [100, 240]) {
      const f = frame('f', 25, h)
      const r = flowStory({ paragraphs: [para(WORDS, { snapToGrid: true })], frames: [f], grid, measure })
      expect(r.byFrame.f.length).toBeGreaterThan(0)
      for (const l of r.byFrame.f) {
        expect(l.y).toBeGreaterThanOrEqual(-0.01)
        expect(l.y + l.lh).toBeLessThanOrEqual(f.h + 0.01)
      }
    }
  })

  it('handles a line height larger than the grid by taking two rulings', () => {
    // 24px type on an 18px grid: a line cannot sit inside one ruling, so it
    // takes two. The alternative — overlapping lines — is worse than a gap.
    const r = flowStory({
      paragraphs: [para(WORDS, { fontSize: 20, font: '20px Test', lineHeight: 1.2, snapToGrid: true })],
      frames: [frame('f', 0, 600)],
      grid,
      measure
    })
    const ys = r.byFrame.f.map((l) => l.y)
    expect(ys.length).toBeGreaterThan(2)
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(36, 5)
  })
})
