import { describe, it, expect } from 'vitest'
import {
  applyStoryFlows,
  linkFrames,
  paragraphsForStory,
  pruneOrphanStories,
  renumber,
  setStoryContent,
  setStoryText,
  storyText,
  unlinkFrame
} from '../../src/shared/designStories'
import { autoLayout } from '../../src/shared/designAutoLayout'
import { parsePlainText } from '../../src/shared/designContent'
import { blankPublication, findDesignSize, storyFrames, storyIds, type DesignBody } from '../../src/shared/design'
import type { FlowMeasurer } from '../../src/shared/designFlow'
import type { SlideTextElement } from '../../src/shared/types'

const measure: FlowMeasurer = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16)
  return text.length * size * 0.5
}
const A4 = findDesignSize('a4-portrait')!

function frame(id: string, x: number, y: number, w: number, h: number, extra: Partial<SlideTextElement> = {}): SlideTextElement {
  return { id, type: 'text', x, y, w, h, z: 1, paragraphs: [], ...extra }
}

function doc(pages = 2): DesignBody {
  const d = blankPublication(A4, pages)
  d.margins = { top: 0, right: 0, bottom: 0, left: 0 }
  d.columns = { count: 1, gutter: 0 }
  d.layoutStyleId = 'report'
  return d
}

function linesOf(d: DesignBody, pageIndex: number, id: string): string[] {
  const el = d.pages![pageIndex].elements.find((e) => e.id === id) as SlideTextElement | undefined
  return (el?.flowLines ?? []).map((l) => l.text)
}

describe('designStories — paragraphs for a story', () => {
  it('builds styled paragraphs from the story’s blocks', () => {
    const d = doc(1)
    d.stories = { s1: parsePlainText('### A heading\n\nBody copy here.', { firstLineIsTitle: false }) }
    const paras = paragraphsForStory(d, 's1')
    expect(paras.map((p) => p.text)).toEqual(['A heading', 'Body copy here.'])
    expect(paras[0].style.fontSize).toBeGreaterThan(paras[1].style.fontSize)
  })

  it('an unknown story yields no paragraphs rather than throwing', () => {
    expect(paragraphsForStory(doc(1), 'nope')).toEqual([])
  })
})

describe('designStories — flowing', () => {
  it('pours a story through frames on two pages', () => {
    const d = doc()
    d.stories = { s1: parsePlainText('alpha bravo charlie delta echo foxtrot golf hotel.', { firstLineIsTitle: false }) }
    // The type scale comes from the document's column width, so a frame has to
    // be at least one line tall at that size for anything to land in it.
    d.pages![0].elements = [frame('f1', 0, 0, 300, 80, { storyId: 's1', storyOrder: 1 })]
    d.pages![1].elements = [frame('f2', 0, 0, 400, 400, { storyId: 's1', storyOrder: 2 })]
    const out = applyStoryFlows(d, measure)
    expect(linesOf(out, 0, 'f1').length).toBeGreaterThan(0)
    const all = [...linesOf(out, 0, 'f1'), ...linesOf(out, 1, 'f2')].join(' ')
    expect(all).toContain('alpha')
    expect(all).toContain('hotel')
  })

  it('only the LAST frame of a chain is flagged overset', () => {
    const d = doc()
    d.stories = { s1: parsePlainText(`${'word '.repeat(400)}`, { firstLineIsTitle: false }) }
    d.pages![0].elements = [frame('f1', 0, 0, 200, 40, { storyId: 's1', storyOrder: 1 })]
    d.pages![1].elements = [frame('f2', 0, 0, 200, 40, { storyId: 's1', storyOrder: 2 })]
    const out = applyStoryFlows(d, measure)
    expect((out.pages![0].elements[0] as SlideTextElement).overset).toBe(false)
    expect((out.pages![1].elements[0] as SlideTextElement).overset).toBe(true)
  })

  it('an obstacle only affects frames on its OWN page', () => {
    const d = doc()
    d.stories = { s1: parsePlainText('aa bb cc dd ee ff gg hh', { firstLineIsTitle: false }) }
    d.pages![0].elements = [
      frame('f1', 0, 0, 400, 200, { storyId: 's1', storyOrder: 1 }),
      { id: 'img', type: 'shape', shape: 'rect', x: 0, y: 0, w: 200, h: 40, z: 2, wrap: { mode: 'square' } }
    ]
    d.pages![1].elements = [frame('f2', 0, 0, 400, 400, { storyId: 's1', storyOrder: 2 })]
    const out = applyStoryFlows(d, measure)
    const f1 = out.pages![0].elements[0] as SlideTextElement
    // The first line has to start past the object on its own page.
    expect(f1.flowLines![0].x).toBeGreaterThan(0)
  })

  it('a document with no stories is returned untouched, identity included', () => {
    const d = doc()
    expect(applyStoryFlows(d, measure)).toBe(d)
  })

  it('a re-flow that changes nothing returns the SAME body, so it never lands on undo', () => {
    const d = doc(1)
    d.stories = { s1: parsePlainText('hello there', { firstLineIsTitle: false }) }
    d.pages![0].elements = [frame('f1', 0, 0, 400, 400, { storyId: 's1', storyOrder: 1 })]
    const once = applyStoryFlows(d, measure)
    expect(once).not.toBe(d)
    expect(applyStoryFlows(once, measure)).toBe(once)
  })

  it('the active page mirror is kept in step with the re-flowed pages', () => {
    const d = doc(2)
    d.activePage = 1
    d.stories = { s1: parsePlainText('hello', { firstLineIsTitle: false }) }
    d.pages![1].elements = [frame('f1', 0, 0, 400, 400, { storyId: 's1', storyOrder: 1 })]
    const out = applyStoryFlows(d, measure)
    expect(out.elements).toBe(out.pages![1].elements)
  })

  it('a story whose frames were all deleted flows nothing and does not throw', () => {
    const d = doc(1)
    d.stories = { ghost: parsePlainText('text with no home', { firstLineIsTitle: false }) }
    expect(() => applyStoryFlows(d, measure)).not.toThrow()
  })

  it('re-flowing a wizard-built document changes nothing — the layout is already settled', () => {
    const r = autoLayout({ content: parsePlainText(`# T\n\n${'word '.repeat(400)}`), size: A4, measure })
    expect(applyStoryFlows(r.body, measure)).toBe(r.body)
  })
})

describe('designStories — story text round trip', () => {
  it('reads a story back as editable markdown-ish text', () => {
    const d = doc(1)
    d.stories = { s1: parsePlainText('### Heading\n\nBody.', { firstLineIsTitle: false }) }
    expect(storyText(d, 's1')).toContain('Heading')
    expect(storyText(d, 's1')).toContain('Body.')
  })

  it('an unknown story reads as empty rather than throwing', () => {
    expect(storyText(doc(1), 'nope')).toBe('')
  })

  it('writing text back re-parses it into blocks', () => {
    const out = setStoryText(doc(1), 's1', '### New heading\n\nNew body.')
    expect(out.stories!.s1.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph'])
  })

  it('setStoryContent replaces the blocks wholesale', () => {
    const out = setStoryContent(doc(1), 's1', { blocks: [{ kind: 'paragraph', text: 'only this' }] })
    expect(out.stories!.s1.blocks).toHaveLength(1)
  })

  it('editing one story leaves the others alone', () => {
    let d = setStoryText(doc(1), 'a', 'first')
    d = setStoryText(d, 'b', 'second')
    d = setStoryText(d, 'a', 'changed')
    expect(storyText(d, 'b')).toBe('second')
  })
})

describe('designStories — linking', () => {
  function two(): DesignBody {
    const d = doc(1)
    d.pages![0].elements = [
      frame('a', 0, 0, 200, 200, { paragraphs: [{ runs: [{ text: 'hello world' }] }] }),
      frame('b', 250, 0, 200, 200)
    ]
    return d
  }

  it('linking two plain frames mints a story from the first frame’s own text', () => {
    const out = linkFrames(two(), 'a', 'b')
    const ids = Object.keys(out.stories ?? {})
    expect(ids).toHaveLength(1)
    expect(storyText(out, ids[0])).toContain('hello world')
    expect(storyFrames(out, ids[0]).map((f) => f.element.id)).toEqual(['a', 'b'])
  })

  it('the linked frames give up their own paragraphs — the story is the source of truth', () => {
    const out = linkFrames(two(), 'a', 'b')
    expect((out.pages![0].elements[0] as SlideTextElement).paragraphs).toEqual([])
  })

  it('linking a frame that already has text appends it rather than discarding it', () => {
    const d = two()
    ;(d.pages![0].elements[1] as SlideTextElement).paragraphs = [{ runs: [{ text: 'second bit' }] }]
    const out = linkFrames(d, 'a', 'b')
    const id = Object.keys(out.stories!)[0]
    const text = storyText(out, id)
    expect(text).toContain('hello world')
    expect(text).toContain('second bit')
  })

  it('a third frame links onto the end of an existing chain', () => {
    let d = two()
    d.pages![0].elements = [...d.pages![0].elements, frame('c', 500, 0, 200, 200)]
    d = linkFrames(d, 'a', 'b')
    const id = Object.keys(d.stories!)[0]
    d = linkFrames(d, 'b', 'c')
    expect(storyFrames(d, id).map((f) => f.element.id)).toEqual(['a', 'b', 'c'])
  })

  it('linking a frame to itself is refused', () => {
    const d = two()
    expect(linkFrames(d, 'a', 'a')).toBe(d)
  })

  it('a frame already in a DIFFERENT story is never stolen', () => {
    let d = two()
    d.pages![0].elements = [...d.pages![0].elements, frame('c', 0, 300, 200, 200), frame('e', 250, 300, 200, 200)]
    d = linkFrames(d, 'c', 'e')
    const before = d
    expect(linkFrames(d, 'a', 'e')).toBe(before)
  })

  it('an unknown frame id is refused rather than crashing', () => {
    const d = two()
    expect(linkFrames(d, 'a', 'nope')).toBe(d)
  })
})

describe('designStories — unlinking and pruning', () => {
  it('unlinking clears the frame’s thread but keeps the story text', () => {
    let d = doc(1)
    d.pages![0].elements = [
      frame('a', 0, 0, 200, 200, { paragraphs: [{ runs: [{ text: 'keep me' }] }] }),
      frame('b', 250, 0, 200, 200)
    ]
    d = linkFrames(d, 'a', 'b')
    const id = Object.keys(d.stories!)[0]
    const out = unlinkFrame(d, 'b')
    const b = out.pages![0].elements[1] as SlideTextElement
    expect(b.storyId).toBeUndefined()
    expect(b.flowLines).toBeUndefined()
    expect(storyText(out, id)).toContain('keep me')
  })

  it('renumber gives a chain clean consecutive orders', () => {
    const d = doc(1)
    d.stories = { s1: parsePlainText('x', { firstLineIsTitle: false }) }
    d.pages![0].elements = [
      frame('a', 0, 0, 10, 10, { storyId: 's1', storyOrder: 1 }),
      frame('b', 0, 0, 10, 10, { storyId: 's1', storyOrder: 1.5 }),
      frame('c', 0, 0, 10, 10, { storyId: 's1', storyOrder: 1.75 })
    ]
    expect(storyFrames(renumber(d, 's1'), 's1').map((f) => f.element.storyOrder)).toEqual([1, 2, 3])
  })

  it('a story with no frames left is pruned away', () => {
    const d = doc(1)
    d.stories = { orphan: parsePlainText('nobody points at me', { firstLineIsTitle: false }) }
    expect(pruneOrphanStories(d).stories).toEqual({})
  })

  it('a story that still has a frame is kept, identity included', () => {
    const d = doc(1)
    d.stories = { s1: parsePlainText('live', { firstLineIsTitle: false }) }
    d.pages![0].elements = [frame('a', 0, 0, 10, 10, { storyId: 's1', storyOrder: 1 })]
    expect(pruneOrphanStories(d)).toBe(d)
    expect(storyIds(d)).toEqual(['s1'])
  })
})
