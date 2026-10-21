// @vitest-environment node
// Footnote references in text: what the person typed, turned into what the
// footnote engine needs. The failure modes here are silent — a marker the
// measurer cannot see, a number that moves when the text reflows, a typo that
// disappears — so each one has a test.
import { describe, it, expect } from 'vitest'
import { hasFootnotes, storyFootnotes, withFootnoteMarkers } from '../../src/shared/designFootnoteText'
import { parsePlainText, toPlainText } from '../../src/shared/designContent'
import type { FlowParagraph } from '../../src/shared/designFlow'

const para = (text: string): FlowParagraph => ({
  text,
  style: {
    fontSize: 10,
    lineHeight: 1.4,
    font: '10px serif',
    fontFamily: 'serif',
    align: 'left',
    color: '#111'
  }
})

describe('footnote definitions in the story text', () => {
  it('parses the Markdown people already type', () => {
    const doc = parsePlainText('The press moved to Leipzig[^1] that spring.\n\n[^1]: Rosenthal, p.212.', {
      firstLineIsTitle: false
    })
    expect(doc.blocks).toEqual([
      { kind: 'paragraph', text: 'The press moved to Leipzig[^1] that spring.' },
      { kind: 'footnote', id: '1', text: 'Rosenthal, p.212.' }
    ])
  })

  it('never sets a note as body copy, which is what a paragraph would do', () => {
    const doc = parsePlainText('[^a]: A note on its own.', { firstLineIsTitle: false })
    expect(doc.blocks.every((b) => b.kind === 'footnote')).toBe(true)
  })

  it('round-trips through the story editor unchanged', () => {
    const src = 'Body[^1] copy.\n\n[^1]: The note.'
    const back = toPlainText(parsePlainText(src, { firstLineIsTitle: false }))
    expect(back).toBe(src)
    // And again, so a second edit cannot drift.
    expect(toPlainText(parsePlainText(back, { firstLineIsTitle: false }))).toBe(src)
  })

  it('lists the notes once each, in writing order', () => {
    const doc = parsePlainText('x[^b][^a]\n\n[^b]: Bee.\n\n[^a]: Ay.\n\n[^b]: Duplicate.', { firstLineIsTitle: false })
    expect(storyFootnotes(doc)).toEqual([
      { id: 'b', text: 'Bee.' },
      { id: 'a', text: 'Ay.' }
    ])
  })

  it('knows whether a story actually uses its notes', () => {
    const used = parsePlainText('Text[^1].\n\n[^1]: Note.', { firstLineIsTitle: false })
    const unused = parsePlainText('Text.\n\n[^1]: Note.', { firstLineIsTitle: false })
    const none = parsePlainText('Text.', { firstLineIsTitle: false })
    expect(hasFootnotes(used)).toBe(true)
    expect(hasFootnotes(unused)).toBe(false)
    expect(hasFootnotes(none)).toBe(false)
    expect(hasFootnotes(undefined)).toBe(false)
  })

  it('sees a reference inside a list item', () => {
    const doc = parsePlainText('- first[^1]\n- second\n\n[^1]: Note.', { firstLineIsTitle: false })
    expect(hasFootnotes(doc)).toBe(true)
  })
})

describe('markers in the paragraph text', () => {
  const notes = [
    { id: '1', text: 'First note.' },
    { id: '2', text: 'Second note.' }
  ]

  it('replaces the token with a real superscript, so the measurer can see it', () => {
    const [p] = withFootnoteMarkers([para('Leipzig[^1] that spring.')], notes)
    expect(p.text).toBe('Leipzig¹ that spring.')
    // The token itself is gone: a line measured with "[^1]" in it breaks early.
    expect(p.text).not.toContain('[^')
  })

  it('records the offset of the marker, not of the token', () => {
    const [p] = withFootnoteMarkers([para('Leipzig[^1] that spring.')], notes)
    expect(p.footnoteRefs).toEqual([{ id: '1', offset: 'Leipzig'.length }])
    // The offset must point AT the marker in the rewritten text, because that
    // is the text the flow engine reports character ranges against.
    expect(p.text[p.footnoteRefs![0].offset]).toBe('¹')
  })

  it('numbers by reading order across paragraphs, not by id', () => {
    const out = withFootnoteMarkers([para('b first[^2]'), para('a second[^1]')], notes)
    expect(out[0].text).toContain('¹')
    expect(out[1].text).toContain('²')
    expect(out[0].footnoteRefs).toEqual([{ id: '2', offset: 'b first'.length }])
  })

  it('repeats a number when the same note is referenced twice', () => {
    const [p] = withFootnoteMarkers([para('one[^1] and again[^1]')], notes)
    expect(p.text).toBe('one¹ and again¹')
    expect(p.footnoteRefs?.map((r) => r.id)).toEqual(['1', '1'])
  })

  it('handles two markers in one paragraph, with the second offset in the rewritten text', () => {
    const [p] = withFootnoteMarkers([para('a[^1]b[^2]c')], notes)
    expect(p.text).toBe('a¹b²c')
    expect(p.footnoteRefs).toEqual([
      { id: '1', offset: 1 },
      { id: '2', offset: 3 }
    ])
  })

  it('leaves a reference to an undefined note exactly as typed', () => {
    // Dropping it would hide the typo; markering it would print a number with
    // nothing under it.
    const [p] = withFootnoteMarkers([para('see[^9] here')], notes)
    expect(p.text).toBe('see[^9] here')
    expect(p.footnoteRefs).toBeUndefined()
  })

  it('leaves paragraphs alone when the story defines no notes', () => {
    const input = [para('Untouched[^1].')]
    expect(withFootnoteMarkers(input, [])).toBe(input)
  })

  it('does not mutate the paragraphs it was given', () => {
    const input = [para('Leipzig[^1].')]
    const out = withFootnoteMarkers(input, notes)
    expect(input[0].text).toBe('Leipzig[^1].')
    expect(out[0]).not.toBe(input[0])
  })

  it('keeps every other property of the paragraph', () => {
    const p0 = { ...para('x[^1]'), source: { block: 7 }, bullet: '•' }
    const [p] = withFootnoteMarkers([p0], notes)
    expect(p.source).toEqual({ block: 7 })
    expect(p.bullet).toBe('•')
    expect(p.style).toBe(p0.style)
  })

  it('is deterministic, and the regex is not left mid-scan between calls', () => {
    // A module-level /g regex that keeps lastIndex between calls is the classic
    // way this kind of code works once and then silently stops matching.
    const run = (): string => withFootnoteMarkers([para('a[^1] b[^2]')], notes)[0].text
    expect(run()).toBe('a¹ b²')
    expect(run()).toBe('a¹ b²')
    expect(run()).toBe('a¹ b²')
  })
})
