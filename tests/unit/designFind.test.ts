// Find and replace in PlexiiDesign — the part that is Design's alone.
//
// Design was the last office app without find (SPEC §9.6) because its text is
// in two places and neither is where you would look first. A THREADED STORY is
// held once in DesignBody.stories and merely SHOWN by its frames, so searching
// the frames finds nothing and replacing in them writes to a cache the next
// re-flow discards. An UNTHREADED frame does carry its own paragraphs and runs.
//
// These tests are the proofs 9d asked for, and each one fails without the
// change — several of them in ways that would otherwise look like success:
// a replacement that lands in a frame and is then quietly re-flowed away, or
// an undo stack with twenty entries where a person expects one.

import { describe, expect, it } from 'vitest'
import type { DesignBody } from '../../src/shared/design'
import type { SlideTextElement } from '../../src/shared/types'
import { findInRecords } from '../../src/renderer/src/lib/recordFind'
import {
  applyDesignReplacements,
  designFindRecords,
  frameForRecord
} from '../../src/renderer/src/components/documents/design/designFind'

/** A text frame showing a slice of a story. */
function storyFrame(id: string, order: number, lines: Array<{ text: string; lastOfPara: boolean }>): SlideTextElement {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    // A story frame still HAS a paragraphs array — a leftover from before it
    // was linked, or a stale slice. Giving the fixture empty ones made the
    // "frames contribute nothing" test vacuous: it passed even with the
    // storyId guard removed, because there was nothing to contribute either
    // way. These are what a real stale slice looks like.
    paragraphs: lines.map((l) => ({ runs: [{ text: l.text }] })),
    storyId: 'st1',
    storyOrder: order,
    flowLines: lines.map((l, i) => ({ x: 0, y: i * 14, w: 300, text: l.text, lastOfPara: l.lastOfPara, size: 12, lh: 14, align: 'left' }))
  } as unknown as SlideTextElement
}

/** A frame that carries its own text, with two runs so formatting is at stake. */
function ownTextFrame(id: string): SlideTextElement {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    w: 300,
    h: 100,
    paragraphs: [
      { runs: [{ text: 'A caption about ' }, { text: 'widgets', bold: true }] },
      { runs: [{ text: 'and more widgets' }] }
    ]
  } as unknown as SlideTextElement
}

/**
 * Two pages. The story runs across BOTH frames: four paragraphs, the first two
 * laid out in frame A and the rest in frame B — which is the shape that makes
 * "the right frame" a real question rather than a formality.
 */
function design(): DesignBody {
  const a = storyFrame('frameA', 1, [
    { text: 'The opening paragraph', lastOfPara: true },
    { text: 'The second paragraph', lastOfPara: true }
  ])
  const b = storyFrame('frameB', 2, [
    { text: 'The third paragraph about widgets', lastOfPara: true },
    { text: 'The fourth paragraph', lastOfPara: true }
  ])
  const own = ownTextFrame('loose')
  return {
    schemaVersion: 1,
    width: 600,
    height: 400,
    elements: [a, own],
    activePage: 0,
    pages: [
      { id: 'p1', elements: [a, own], background: undefined },
      { id: 'p2', elements: [b], background: undefined }
    ],
    stories: {
      st1: {
        blocks: [
          { kind: 'paragraph', text: 'The opening paragraph' },
          { kind: 'paragraph', text: 'The second paragraph' },
          { kind: 'paragraph', text: 'The third paragraph about widgets' },
          { kind: 'paragraph', text: 'The fourth paragraph' }
        ]
      }
    }
  } as unknown as DesignBody
}

const textOf = (d: DesignBody, key: string): string | undefined =>
  designFindRecords(d).find((r) => r.key === key)?.text

describe('what a design offers to be searched', () => {
  it('reads a threaded story from the STORY, and not from the frames showing it', () => {
    const recs = designFindRecords(design())
    const storyRecs = recs.filter((r) => r.key.startsWith('s|'))
    expect(storyRecs.map((r) => r.text)).toEqual([
      'The opening paragraph',
      'The second paragraph',
      'The third paragraph about widgets',
      'The fourth paragraph'
    ])
    // The frames that SHOW the story contribute nothing of their own. If they
    // did, every hit would appear twice and a replacement offered in a frame
    // would be discarded by the next re-flow.
    expect(recs.filter((r) => r.key.startsWith('f|') && /frameA|frameB/.test(r.key))).toEqual([])
  })

  it('reads an unthreaded frame from its own paragraphs, runs joined', () => {
    const recs = designFindRecords(design())
    expect(recs.filter((r) => r.key.startsWith('f|')).map((r) => r.text)).toEqual([
      'A caption about widgets',
      'and more widgets'
    ])
  })
})

describe('text threaded across two frames', () => {
  it('is FOUND wherever it sits in the chain', () => {
    const hits = findInRecords(designFindRecords(design()), 'widgets')
    // One in the story's third paragraph (frame B), two in the loose frame.
    expect(hits.map((h) => h.key)).toEqual(['s|st1|2', 'f|0|loose|0', 'f|0|loose|1'])
  })

  it('is REPLACED in the story, so every frame showing it changes at once', () => {
    const d = design()
    const hits = findInRecords(designFindRecords(d), 'widgets').filter((h) => h.key.startsWith('s|'))
    const next = applyDesignReplacements(d, hits, 'gadgets')
    expect(textOf(next, 's|st1|2')).toBe('The third paragraph about gadgets')
    // Written to the story, which is the only place it can be written.
    expect(next.stories!.st1!.blocks[2]).toMatchObject({ text: 'The third paragraph about gadgets' })
  })

  it('a match in the SECOND frame selects that frame, not the first', () => {
    const d = design()
    const [hit] = findInRecords(designFindRecords(d), 'third')
    expect(frameForRecord(d, hit!.key)).toEqual({ pageIndex: 1, elementId: 'frameB' })
    // And one in the first frame still selects the first.
    const [opening] = findInRecords(designFindRecords(d), 'opening')
    expect(frameForRecord(d, opening!.key)).toEqual({ pageIndex: 0, elementId: 'frameA' })
  })
})

describe('find is case-insensitive by default, as everywhere else', () => {
  it('matches regardless of case, and the hit is in the right frame', () => {
    const d = design()
    const hits = findInRecords(designFindRecords(d), 'THE THIRD')
    expect(hits).toHaveLength(1)
    expect(frameForRecord(d, hits[0]!.key)).toEqual({ pageIndex: 1, elementId: 'frameB' })
    // Case-sensitive is opt-in, and then it does not match.
    expect(findInRecords(designFindRecords(d), 'THE THIRD', { caseSensitive: true })).toEqual([])
  })
})

describe('replace-all is ONE change to the document', () => {
  it('returns a single new body with every hit applied', () => {
    const d = design()
    const hits = findInRecords(designFindRecords(d), 'paragraph')
    expect(hits.length, 'four story paragraphs match').toBe(4)
    const next = applyDesignReplacements(d, hits, 'section')
    expect(next.stories!.st1!.blocks.map((b) => (b as { text: string }).text)).toEqual([
      'The opening section',
      'The second section',
      'The third section about widgets',
      'The fourth section'
    ])
    // One body out, so the caller commits once and undo takes all four back
    // together — not one step per frame, which is what a person means by
    // "undo the replace".
    expect(next).not.toBe(d)
    expect(d.stories!.st1!.blocks[0], 'the original is untouched').toMatchObject({ text: 'The opening paragraph' })
  })

  it('keeps run formatting in an unthreaded frame', () => {
    const d = design()
    const hits = findInRecords(designFindRecords(d), 'widgets').filter((h) => h.key.startsWith('f|'))
    const next = applyDesignReplacements(d, hits, 'gadgets')
    const loose = next.pages![0]!.elements.find((e) => e.id === 'loose') as SlideTextElement
    expect(loose.paragraphs[0]!.runs.map((r) => r.text).join('')).toBe('A caption about gadgets')
    // The replacement takes the style of the run the match started in.
    expect(loose.paragraphs[0]!.runs.find((r) => r.text.includes('gadgets'))?.bold).toBe(true)
  })

  it('writes the active page BOTH ways, or the commit would discard it', () => {
    // A design stores the active page's elements at the top level AND in
    // pages[active], and syncActivePage mirrors the top level over the page on
    // every commit. A replacement written only into the page array is undone
    // at the moment of saving — silently, which is the trap designSwatches.ts
    // already records having been caught by.
    const d = design()
    const hits = findInRecords(designFindRecords(d), 'caption')
    const next = applyDesignReplacements(d, hits, 'note')
    const top = next.elements.find((e) => e.id === 'loose') as SlideTextElement
    const page = next.pages![0]!.elements.find((e) => e.id === 'loose') as SlideTextElement
    expect(top.paragraphs[0]!.runs.map((r) => r.text).join('')).toContain('A note about')
    expect(page.paragraphs[0]!.runs.map((r) => r.text).join('')).toContain('A note about')
  })

  it('a replacement on a NON-active page is kept', () => {
    const d = design()
    const hits = findInRecords(designFindRecords(d), 'fourth')
    const next = applyDesignReplacements(d, hits, 'final')
    expect(textOf(next, 's|st1|3')).toBe('The final paragraph')
  })
})

describe('the stated approximation at a frame boundary', () => {
  it('attributes a paragraph that SPILLS to the frame it starts in', () => {
    // Frame A lays out the first paragraph's opening line but not its end
    // (no lastOfPara), so the paragraph continues into frame B. A match in it
    // selects frame A — where the reader picks that paragraph up — rather
    // than wherever the matched characters landed. Deliberate: see the comment
    // on frameForRecord for why exact attribution is not available.
    const a = storyFrame('frameA', 1, [{ text: 'A very long paragraph that', lastOfPara: false }])
    const b = storyFrame('frameB', 2, [{ text: 'spills into the next frame', lastOfPara: true }])
    const d = {
      ...design(),
      elements: [a],
      pages: [
        { id: 'p1', elements: [a] },
        { id: 'p2', elements: [b] }
      ],
      stories: { st1: { blocks: [{ kind: 'paragraph', text: 'A very long paragraph that spills into the next frame' }] } }
    } as unknown as DesignBody
    const [hit] = findInRecords(designFindRecords(d), 'spills')
    expect(frameForRecord(d, hit!.key)).toEqual({ pageIndex: 0, elementId: 'frameA' })
  })

  it('and the test above is not passing by falling back to the first frame', () => {
    // frameA is also what frameForRecord returns when it cannot map a hit at
    // all, so the assertion above would hold even if the mapping were dead.
    // A SECOND paragraph, which starts in frame B, tells the two apart.
    const a = storyFrame('frameA', 1, [{ text: 'A very long paragraph that', lastOfPara: false }])
    const b = storyFrame('frameB', 2, [
      { text: 'spills into the next frame', lastOfPara: true },
      { text: 'A second paragraph entirely in B', lastOfPara: true }
    ])
    const d = {
      ...design(),
      elements: [a],
      pages: [
        { id: 'p1', elements: [a] },
        { id: 'p2', elements: [b] }
      ],
      stories: {
        st1: {
          blocks: [
            { kind: 'paragraph', text: 'A very long paragraph that spills into the next frame' },
            { kind: 'paragraph', text: 'A second paragraph entirely in B' }
          ]
        }
      }
    } as unknown as DesignBody
    const [second] = findInRecords(designFindRecords(d), 'entirely in B')
    expect(frameForRecord(d, second!.key), 'the mapping really runs').toEqual({ pageIndex: 1, elementId: 'frameB' })
  })
})
