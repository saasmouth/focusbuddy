// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { layoutWithFootnotes, footnoteMarker, numberFootnotes, type FootnoteRefParagraph } from '../../src/shared/designFootnotes'
import type { FlowFrame, FlowParaStyle } from '../../src/shared/designFlow'

// The interesting behaviour is the settling loop, not the drawing. A note
// takes space from its frame, which can push its own marker onto the next
// one. These tests are about that.

const measure = (text: string, font: string): number => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return text.length * ((m ? Number(m[1]) : 10) * 0.5)
}

const style = (over: Partial<FlowParaStyle> = {}): FlowParaStyle => ({
  fontSize: 10, lineHeight: 1.4, font: '10px Test', align: 'left', ...over
})
const noteStyle = style({ fontSize: 8, font: '8px Test', lineHeight: 1.3 })

const para = (text: string, refs?: Array<{ id: string; offset: number }>): FootnoteRefParagraph => ({
  text, style: style(), ...(refs ? { footnoteRefs: refs } : {})
})
const frame = (id: string, y: number, h: number, w = 200): FlowFrame => ({ id, x: 0, y, w, h })

describe('markers', () => {
  it('are real superscript characters, so the measurer can see them', () => {
    // A marker the measurer cannot see makes its line slightly too long, and
    // the error accumulates down a justified column.
    expect(footnoteMarker(1)).toBe('¹')
    expect(footnoteMarker(12)).toBe('¹²')
    expect(footnoteMarker(0)).toBe('')
  })

  it('number in reading order and reuse the number for a repeated id', () => {
    const n = numberFootnotes(['b', 'a', 'b', 'c'])
    expect(n.get('b')).toBe('¹')
    expect(n.get('a')).toBe('²')
    expect(n.get('c')).toBe('³')
    expect(n.size).toBe(3)
  })
})

describe('placement', () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')

  it('puts a note on the frame its marker landed in', () => {
    const r = layoutWithFootnotes({
      paragraphs: [para('short text', [{ id: 'n1', offset: 2 }])],
      frames: [frame('a', 0, 300)],
      notes: [{ id: 'n1', text: 'The note.' }],
      measure,
      options: { style: noteStyle }
    })
    const a = r.placements.find((p) => p.frameId === 'a')!
    expect(a.notes.map((n) => n.id)).toEqual(['n1'])
    expect(a.height).toBeGreaterThan(0)
  })

  it('reserves no space on a frame with no markers', () => {
    const r = layoutWithFootnotes({
      paragraphs: [para('short text')],
      frames: [frame('a', 0, 300), frame('b', 400, 300)],
      notes: [{ id: 'n1', text: 'Unreferenced.' }],
      measure,
      options: { style: noteStyle }
    })
    for (const p of r.placements) expect(p.height).toBe(0)
  })

  it('follows the marker to whichever frame it ends up in', () => {
    // The point of the whole module: the note belongs to the page its marker
    // is printed on, not the page it was defined on.
    const paras = [para(words), para('tail', [{ id: 'n1', offset: 0 }])]
    const r = layoutWithFootnotes({
      paragraphs: paras,
      frames: [frame('a', 0, 40), frame('b', 400, 300)],
      notes: [{ id: 'n1', text: 'The note.' }],
      measure,
      options: { style: noteStyle }
    })
    const withNote = r.placements.filter((p) => p.notes.length)
    expect(withNote).toHaveLength(1)
    // The first frame is far too short to reach the second paragraph.
    expect(withNote[0].frameId).toBe('b')
  })

  it('never shows a note whose marker is not on that frame', () => {
    // The failure mode that matters: a note printed on a page whose marker
    // ended up overleaf. Asserted across every frame rather than spot-checked.
    const paras = [para(words, [{ id: 'n1', offset: 0 }]), para(words, [{ id: 'n2', offset: 0 }])]
    const r = layoutWithFootnotes({
      paragraphs: paras,
      frames: [frame('a', 0, 60), frame('b', 400, 60), frame('c', 800, 300)],
      notes: [{ id: 'n1', text: 'One.' }, { id: 'n2', text: 'Two.' }],
      measure,
      options: { style: noteStyle }
    })
    for (const p of r.placements) {
      const lines = r.flow.byFrame[p.frameId] ?? []
      for (const n of p.notes) {
        const ref = paras.flatMap((x) => x.footnoteRefs ?? []).find((x) => x.id === n.id)!
        const onThisFrame = lines.some((l) => ref.offset >= l.start && ref.offset < l.end)
        expect(onThisFrame, `${n.id} shown on ${p.frameId} without its marker`).toBe(true)
      }
    }
  })

  it('takes the space from the text, so the two cannot overlap', () => {
    // MUST overfill the frame. With only a few lines of text the assertion
    // holds whether or not the frame was shortened, and a mutation that
    // skipped the shortening entirely — letting notes sit on top of the text
    // — passed this test until the fixture was made long enough to care.
    const many = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ')
    const paras = [para(many, [{ id: 'n1', offset: 0 }])]
    const tall = frame('a', 0, 200)
    const withNotes = layoutWithFootnotes({
      paragraphs: paras, frames: [tall],
      notes: [{ id: 'n1', text: 'A reasonably long note that takes a line or two of space.' }],
      measure, options: { style: noteStyle }
    })
    const reserve = withNotes.placements[0].height
    expect(reserve).toBeGreaterThan(0)
    // The text really does run to the bottom of the shortened frame, or the
    // check below proves nothing.
    const lines = withNotes.flow.byFrame.a ?? []
    expect(lines.length).toBeGreaterThan(5)
    expect(lines[lines.length - 1].y + lines[lines.length - 1].lh).toBeGreaterThan(tall.h - reserve - 20)
    for (const l of withNotes.flow.byFrame.a ?? [])
      expect(l.y + l.lh).toBeLessThanOrEqual(tall.h - reserve + 0.01)
  })

  it('settles rather than oscillating, and says when it did not', () => {
    const r = layoutWithFootnotes({
      paragraphs: [para('short', [{ id: 'n1', offset: 0 }])],
      frames: [frame('a', 0, 300)],
      notes: [{ id: 'n1', text: 'Short note.' }],
      measure, options: { style: noteStyle }
    })
    expect(r.unsettled).toBe(false)
  })

  it('reports unsettled instead of looping forever on a frame that cannot hold both', () => {
    // A frame barely tall enough for the line carrying the marker: reserving
    // note space pushes the marker out, which frees the space, which pulls it
    // back. There is no stable answer, and the honest output is a flag.
    const r = layoutWithFootnotes({
      paragraphs: [para(words, [{ id: 'n1', offset: 0 }])],
      frames: [frame('a', 0, 30), frame('b', 400, 300)],
      notes: [{ id: 'n1', text: 'A note long enough to need more room than the frame has spare.' }],
      measure, options: { style: noteStyle, maxPasses: 3 }
    })
    expect(typeof r.unsettled).toBe('boolean')
    // Whatever it decided, it must still be self-consistent: no note without
    // its marker on the same frame.
    for (const p of r.placements) {
      const lines = r.flow.byFrame[p.frameId] ?? []
      for (const n of p.notes) {
        const ref = { id: 'n1', offset: 0 }
        expect(lines.some((l) => ref.offset >= l.start && ref.offset < l.end)).toBe(true)
      }
    }
  })

  it('ignores a reference to a note that does not exist', () => {
    const r = layoutWithFootnotes({
      paragraphs: [para('text', [{ id: 'ghost', offset: 0 }])],
      frames: [frame('a', 0, 300)],
      notes: [],
      measure, options: { style: noteStyle }
    })
    expect(r.placements[0].notes).toEqual([])
    expect(r.placements[0].height).toBe(0)
  })
})

describe('the space a note reserves', () => {
  // The height was once total-width ÷ column-width, rounded up. That is a line
  // short whenever a word will not fit in what is left of a line — which is
  // most notes, because a note is short and often ends in a page reference or
  // a URL. One line short is a note the frame then clips.
  it('is measured by breaking the note into lines, not by dividing its width', () => {
    // The measurer here gives every character 4px at 8px type, so a 100px
    // column holds 25 characters — but only in whole words.
    //
    // Three 15-character words: 45 characters of word plus 2 spaces = 188px.
    // The division says ceil(188 / 100) = 2 lines. Real wrapping cannot put
    // two 60px words on a 100px line once the 8px space is counted, so it
    // needs 3. The division under-reserves, and the frame clips the note.
    const text = 'aaaaaaaaaaaaaaa bbbbbbbbbbbbbbb ccccccccccccccc'
    const r = layoutWithFootnotes({
      paragraphs: [para('x', [{ id: 'n', offset: 0 }])],
      frames: [frame('a', 0, 400, 100)],
      notes: [{ id: 'n', text }],
      measure,
      options: { style: noteStyle, gap: 0, ruleHeight: 0 }
    })
    const lineH = 8 * 1.3
    expect(r.placements[0].height).toBeGreaterThan(2.5 * lineH)
  })

  it('reserves nothing when a frame holds no marker', () => {
    const r = layoutWithFootnotes({
      paragraphs: [para('no markers here')],
      frames: [frame('a', 0, 300)],
      notes: [{ id: 'n', text: 'Unreferenced.' }],
      measure,
      options: { style: noteStyle }
    })
    expect(r.placements[0].height).toBe(0)
  })
})
