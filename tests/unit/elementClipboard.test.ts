// @vitest-environment node
// The elements clipboard. The owner's report was "ctrl c and v don't work",
// and the parts that go wrong once they do are all here: ids, groups, z order,
// and a paste that lands off the page where it cannot be clicked.
import { describe, it, expect } from 'vitest'
import {
  ELEMENT_CLIP_KIND,
  buildElementClipboard,
  elementsPlainText,
  parseElementClipboard,
  pasteElements,
  serializeElementClipboard
} from '../../src/shared/elementClipboard'
import type { SlideElement } from '../../src/shared/types'

const rect = (over: Partial<SlideElement> = {}): SlideElement =>
  ({ id: 'r1', type: 'rect', x: 10, y: 20, w: 100, h: 50, z: 1, fill: { type: 'solid', color: '#ff0000' }, ...over }) as SlideElement

const text = (over: Partial<SlideElement> = {}): SlideElement =>
  ({
    id: 't1',
    type: 'text',
    x: 0,
    y: 0,
    w: 200,
    h: 40,
    z: 2,
    paragraphs: [{ runs: [{ text: 'Hello world' }] }],
    ...over
  }) as SlideElement

const canvas = { w: 800, h: 600 }
let seq = 0
const newId = (): string => `new-${++seq}`

describe('building and reading a payload', () => {
  it('round-trips through a string, which is what the clipboard carries', () => {
    const clip = buildElementClipboard([rect(), text()], canvas)
    const back = parseElementClipboard(serializeElementClipboard(clip))
    expect(back?.kind).toBe(ELEMENT_CLIP_KIND)
    expect(back?.elements.map((e) => e.id)).toEqual(['r1', 't1'])
    expect(back?.source).toEqual({ w: 800, h: 600 })
  })

  it('orders by z, so a paste lays them down the way they were stacked', () => {
    const clip = buildElementClipboard([rect({ id: 'top', z: 9 }), rect({ id: 'bottom', z: 1 })], canvas)
    expect(clip.elements.map((e) => e.id)).toEqual(['bottom', 'top'])
  })

  it('copies the elements, so later edits to the page do not change the clip', () => {
    const live = rect()
    const clip = buildElementClipboard([live], canvas)
    ;(live as { x: number }).x = 999
    ;(live.fill as { color: string }).color = '#000000'
    expect(clip.elements[0].x).toBe(10)
    expect((clip.elements[0].fill as { color: string }).color).toBe('#ff0000')
  })

  it('takes the words for the text/plain flavour, in reading order', () => {
    const t = elementsPlainText([
      text({ id: 'b', y: 100, paragraphs: [{ runs: [{ text: 'SECOND' }] }] }),
      text({ id: 'a', y: 10, paragraphs: [{ runs: [{ text: 'FIRST' }] }] }),
      rect()
    ])
    expect(t).toBe('FIRST\n\nSECOND')
  })

  it('prefers the flowed lines, which are what is actually set', () => {
    const t = elementsPlainText([
      text({
        paragraphs: [{ runs: [{ text: 'stale' }] }],
        flowLines: [{ x: 0, y: 0, w: 10, text: 'what is set', lastOfPara: true, size: 10, lh: 12, align: 'left', para: 0, start: 0, end: 11 }]
      } as Partial<SlideElement>)
    ])
    expect(t).toBe('what is set')
  })
})

describe('what comes back off the clipboard is untrusted', () => {
  it('refuses anything that is not ours', () => {
    expect(parseElementClipboard(null)).toBeNull()
    expect(parseElementClipboard('')).toBeNull()
    expect(parseElementClipboard('just some copied text')).toBeNull()
    expect(parseElementClipboard('{"kind":"something/else","elements":[]}')).toBeNull()
    expect(parseElementClipboard(JSON.stringify({ kind: ELEMENT_CLIP_KIND, elements: 'nope' }))).toBeNull()
  })

  it('refuses a payload whose elements could not be drawn', () => {
    const bad = JSON.stringify({
      kind: ELEMENT_CLIP_KIND,
      version: 1,
      source: { w: 1, h: 1 },
      elements: [{ id: 'x', type: 'rect', x: 'left', y: 0, w: 10, h: 10 }]
    })
    // An element with no finite geometry would land as an invisible,
    // unselectable ghost, so it is dropped — and with nothing left, the whole
    // paste is refused rather than silently doing nothing.
    expect(parseElementClipboard(bad)).toBeNull()
  })

  it('keeps the good elements when only some are broken', () => {
    const mixed = JSON.stringify({
      kind: ELEMENT_CLIP_KIND,
      version: 1,
      source: { w: 100, h: 100 },
      elements: [rect(), { id: '', type: 'rect', x: 0, y: 0, w: 1, h: 1 }, { nonsense: true }]
    })
    expect(parseElementClipboard(mixed)?.elements).toHaveLength(1)
  })

  it('tolerates fields it does not know, rather than losing the artwork', () => {
    const future = JSON.stringify({
      kind: ELEMENT_CLIP_KIND,
      version: 99,
      source: { w: 100, h: 100 },
      elements: [{ ...rect(), someFutureField: { nested: 1 } }]
    })
    const back = parseElementClipboard(future)
    expect(back?.version).toBe(99)
    expect((back?.elements[0] as unknown as { someFutureField: unknown }).someFutureField).toEqual({ nested: 1 })
  })

  it('survives a payload claiming a nonsense canvas', () => {
    const odd = JSON.stringify({ kind: ELEMENT_CLIP_KIND, version: 1, source: { w: -5, h: 'tall' }, elements: [rect()] })
    expect(parseElementClipboard(odd)?.source).toEqual({ w: 0, h: 0 })
  })
})

describe('pasting', () => {
  const clipOf = (els: SlideElement[]): ReturnType<typeof buildElementClipboard> => buildElementClipboard(els, canvas)

  it('mints fresh ids', () => {
    const out = pasteElements(clipOf([rect(), text()]), { canvas, topZ: 5, newId })
    expect(out.map((e) => e.id)).not.toContain('r1')
    expect(new Set(out.map((e) => e.id)).size).toBe(2)
  })

  it('shares nothing with the copied elements, however deep', () => {
    // Two elements sharing a fill object means editing one edits the other.
    const clip = clipOf([rect()])
    const out = pasteElements(clip, { canvas, topZ: 0, newId })
    expect(out[0].fill).not.toBe(clip.elements[0].fill)
    ;(out[0].fill as { color: string }).color = '#00ff00'
    expect((clip.elements[0].fill as { color: string }).color).toBe('#ff0000')
  })

  it('lands on top, keeping the stacking order of the copy', () => {
    const out = pasteElements(clipOf([rect({ id: 'a', z: 1 }), rect({ id: 'b', z: 7 })]), { canvas, topZ: 12, newId })
    expect(out.map((e) => e.z)).toEqual([13, 14])
  })

  it('nudges by 20 so the copy is not hidden exactly behind the original', () => {
    const out = pasteElements(clipOf([rect({ x: 10, y: 20 })]), { canvas, topZ: 0, newId })
    expect(out[0].x).toBe(30)
    expect(out[0].y).toBe(40)
  })

  it('pastes in place when asked', () => {
    const out = pasteElements(clipOf([rect({ x: 10, y: 20 })]), { canvas, topZ: 0, newId, offset: 0 })
    expect([out[0].x, out[0].y]).toEqual([10, 20])
  })

  it('nudges the whole paste together, so a group keeps its shape', () => {
    const out = pasteElements(clipOf([rect({ id: 'a', x: 0, y: 0 }), rect({ id: 'b', x: 300, y: 100 })]), {
      canvas,
      topZ: 0,
      newId
    })
    expect(out[1].x - out[0].x).toBe(300)
    expect(out[1].y - out[0].y).toBe(100)
  })

  it('keeps the paste on the page when the nudge would push it off', () => {
    // A shape against the right edge: nudging it 20 further would hide it.
    const out = pasteElements(clipOf([rect({ x: 700, y: 560, w: 100, h: 40 })]), { canvas, topZ: 0, newId })
    expect(out[0].x + out[0].w).toBeLessThanOrEqual(canvas.w)
    expect(out[0].y + out[0].h).toBeLessThanOrEqual(canvas.h)
  })

  it('keeps the top-left corner on the page for something bigger than the page', () => {
    // Pasted from a poster onto a postcard: it cannot fit, so it is placed
    // where it can be grabbed rather than centred off two edges.
    const out = pasteElements(clipOf([rect({ x: 0, y: 0, w: 2000, h: 1500 })]), { canvas, topZ: 0, newId })
    expect([out[0].x, out[0].y]).toEqual([0, 0])
  })

  it('remaps a group, so a pasted copy is not tied to the original', () => {
    const clip = clipOf([rect({ id: 'a', groupId: 'grp-1' }), rect({ id: 'b', groupId: 'grp-1' })])
    const out = pasteElements(clip, { canvas, topZ: 0, newId })
    const gid = (out[0] as { groupId?: string }).groupId
    expect(gid).toBeTruthy()
    expect(gid).not.toBe('grp-1')
    // Both members land in the SAME new group.
    expect((out[1] as { groupId?: string }).groupId).toBe(gid)
  })

  it('keeps two different groups different', () => {
    const clip = clipOf([
      rect({ id: 'a', groupId: 'g1' }),
      rect({ id: 'b', groupId: 'g1' }),
      rect({ id: 'c', groupId: 'g2' })
    ])
    const out = pasteElements(clip, { canvas, topZ: 0, newId })
    const g = (e: SlideElement): string | undefined => (e as { groupId?: string }).groupId
    expect(g(out[0])).toBe(g(out[1]))
    expect(g(out[2])).not.toBe(g(out[0]))
  })

  it('leaves an ungrouped element ungrouped', () => {
    const out = pasteElements(clipOf([rect()]), { canvas, topZ: 0, newId })
    expect((out[0] as { groupId?: string }).groupId).toBeUndefined()
  })

  it('can be pasted twice without the two pastes colliding', () => {
    const clip = clipOf([rect()])
    const first = pasteElements(clip, { canvas, topZ: 0, newId })
    const second = pasteElements(clip, { canvas, topZ: first[0].z, newId })
    expect(second[0].id).not.toBe(first[0].id)
    expect(second[0].z).toBeGreaterThan(first[0].z)
  })
})
