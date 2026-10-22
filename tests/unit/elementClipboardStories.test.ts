// Copying a THREADED text frame. A threaded frame holds no words of its own:
// its text lives in the document's story map and the frame only points at it
// with `storyId` (plus `storyOrder`, its place in the chain).
//
// Paste used to keep both verbatim, which is wrong in two different ways —
// both reported by 2e while reading the model for the Design snippet target:
//
//   SAME DOCUMENT: the pasted frame JOINS the original's chain, so the article
//   silently reflows through it and the copy shows the next page of the story
//   rather than a copy of what was on screen.
//
//   ANOTHER DOCUMENT: the story id points at nothing and the frame renders
//   empty — a copy of a page of text that pastes as a blank box.
//
// So the story travels with the copy and lands under a fresh id, and a caller
// that cannot take stories (PlexiiDeck, which has none) gets frames cut loose
// rather than pointing somewhere.

import { describe, expect, it } from 'vitest'
import {
  buildElementClipboard,
  pasteElements,
  pasteStoryMap,
  parseElementClipboard,
  serializeElementClipboard,
  storyIdsOf
} from '../../src/shared/elementClipboard'
import type { SlideElement } from '../../src/shared/types'

const frame = (id: string, storyId?: string, storyOrder?: number, y = 0): SlideElement =>
  ({
    id,
    type: 'text',
    x: 10,
    y,
    w: 200,
    h: 100,
    z: 1,
    ...(storyId ? { storyId } : {}),
    ...(storyOrder !== undefined ? { storyOrder } : {})
  }) as unknown as SlideElement

const CANVAS = { w: 800, h: 1000 }
const STORIES = { 'st-a': { blocks: [{ kind: 'paragraph', text: 'The quarterly numbers landed.' }] } }

let n = 0
const opts = (storyMap?: Record<string, string>) => ({
  canvas: CANVAS,
  topZ: 0,
  newId: () => `el-${++n}`,
  ...(storyMap ? { storyMap } : {})
})
const newStoryId = (): string => `st-new-${++n}`

describe('a threaded frame on the clipboard', () => {
  it('takes its story with it, and only the stories it references', () => {
    const clip = buildElementClipboard([frame('f1', 'st-a', 0)], CANVAS, {
      ...STORIES,
      'st-unused': { blocks: [{ kind: 'paragraph', text: 'Another article entirely.' }] }
    })
    expect(Object.keys(clip.stories ?? {})).toEqual(['st-a'])
  })

  it('embeds nothing when the elements are not threaded', () => {
    const clip = buildElementClipboard([frame('f1')], CANVAS, STORIES)
    expect(clip.stories).toBeUndefined()
  })

  it('pastes under a FRESH story id, so it never joins the original chain', () => {
    const clip = buildElementClipboard([frame('f1', 'st-a', 3)], CANVAS, STORIES)
    const { map, stories } = pasteStoryMap(clip, newStoryId)
    const [el] = pasteElements(clip, opts(map))
    const pasted = el as unknown as { storyId?: string; storyOrder?: number }
    expect(pasted.storyId).toBeDefined()
    expect(pasted.storyId).not.toBe('st-a')
    expect(stories[pasted.storyId!]).toEqual(STORIES['st-a'])
    // Numbered from the start of the paste, not from the source's chain.
    expect(pasted.storyOrder).toBe(0)
  })

  it('keeps frames that were threaded together threaded together, in order', () => {
    const clip = buildElementClipboard(
      [frame('f2', 'st-a', 5, 300), frame('f1', 'st-a', 4, 0)],
      CANVAS,
      STORIES
    )
    const { map, stories } = pasteStoryMap(clip, newStoryId)
    const out = pasteElements(clip, opts(map)) as unknown as Array<{ storyId?: string; storyOrder?: number; y: number }>
    expect(Object.keys(stories)).toHaveLength(1)
    expect(new Set(out.map((e) => e.storyId)).size).toBe(1)
    // f1 was earlier in the chain, so it stays first wherever it sits. Compared
    // by relative y, not by the source's coordinates: a paste nudges and clamps
    // onto the page, so the pasted copies are not at the originals' y.
    const byY = [...out].sort((a, b) => a.y - b.y)
    expect(byY.map((e) => e.storyOrder)).toEqual([0, 1])
  })

  it('cuts a threaded frame loose when the caller cannot take stories', () => {
    const clip = buildElementClipboard([frame('f1', 'st-a', 0)], CANVAS, STORIES)
    const [el] = pasteElements(clip, opts())
    const pasted = el as unknown as { storyId?: string; storyOrder?: number }
    expect(pasted.storyId).toBeUndefined()
    expect(pasted.storyOrder).toBeUndefined()
  })

  it('cuts it loose when the payload carried no story for it, rather than pointing at nothing', () => {
    // A copy made before this change, or hand-edited on the clipboard.
    const clip = buildElementClipboard([frame('f1', 'st-a', 0)], CANVAS)
    const { map } = pasteStoryMap(clip, newStoryId)
    expect(map).toEqual({})
    const [el] = pasteElements(clip, opts(map))
    expect((el as unknown as { storyId?: string }).storyId).toBeUndefined()
  })

  it('survives the round trip through the system clipboard', () => {
    const clip = buildElementClipboard([frame('f1', 'st-a', 0)], CANVAS, STORIES)
    const back = parseElementClipboard(serializeElementClipboard(clip))
    expect(back?.stories?.['st-a']).toEqual(STORIES['st-a'])
  })

  it('ignores a stories field that is not a map: the clipboard is untrusted', () => {
    const back = parseElementClipboard(
      JSON.stringify({ ...buildElementClipboard([frame('f1', 'st-a', 0)], CANVAS), stories: ['nope'] })
    )
    expect(back?.stories).toBeUndefined()
  })

  it('lists the story ids it references, once each, in first-seen order', () => {
    expect(storyIdsOf([frame('a', 'st-b'), frame('b', 'st-a'), frame('c', 'st-b'), frame('d')])).toEqual(['st-b', 'st-a'])
  })
})
