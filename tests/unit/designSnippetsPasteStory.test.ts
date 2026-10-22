// @vitest-environment node
//
// f0's paste fix (design-model-fixes 863c7d5c) makes pasteElements DELETE a
// pasted frame's storyId and storyOrder unless it is handed a storyMap, so an
// ordinary paste no longer joins (or, in another document, loses) the
// original's thread. insertDesignSnippet assigns its own fresh story ids and
// must not depend on storyId surviving pasteElements: it reads each frame's
// story from the SOURCE element. This pins that, by running insertion against
// a pasteElements that strips the story fields exactly as the fixed one does.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/shared/elementClipboard', async (orig) => {
  const real = await orig<typeof import('../../src/shared/elementClipboard')>()
  return {
    ...real,
    pasteElements: (...args: Parameters<typeof real.pasteElements>) =>
      real.pasteElements(...args).map((e) => {
        if (e.type !== 'text') return e
        const t = { ...e } as Record<string, unknown>
        delete t.storyId
        delete t.storyOrder
        return t as unknown as typeof e
      })
  }
})

import { designBodyFromSelection, insertDesignSnippet } from '../../src/renderer/src/components/documents/design/designSnippets'
import type { DesignBody } from '../../src/shared/design'
import type { Snippet } from '../../src/shared/snippets'
import type { SlideElement, SlideTextElement } from '../../src/shared/types'

const STORY = { blocks: [{ kind: 'paragraph', text: 'Revenue grew in every region.' }] }
const F1 = { id: 'f1', type: 'text', x: 520, y: 100, w: 200, h: 120, z: 1, paragraphs: [], storyId: 'story-a', storyOrder: 1 } as unknown as SlideElement
const F2 = { id: 'f2', type: 'text', x: 520, y: 260, w: 200, h: 120, z: 2, paragraphs: [], storyId: 'story-a', storyOrder: 2 } as unknown as SlideElement

const source: DesignBody = {
  schemaVersion: 1, width: 1000, height: 800, background: { type: 'solid', color: '#ffffff' },
  elements: [F1, F2], stories: { 'story-a': STORY } as DesignBody['stories']
}

describe('insertion keeps threaded text when paste strips story ids (f0 863c7d5c)', () => {
  it('the copy reads a fresh story, threaded in the same order', () => {
    const body = designBodyFromSelection(source, ['f1', 'f2'])!
    const snip = { id: 's', kind: 'design', name: 'n', description: '', body, tags: [], scope: 'personal', orgId: 'personal', authorId: null, revision: 1, usageCount: 0, createdAt: 0, updatedAt: 0 } as Snippet
    let n = 0
    const dest: DesignBody = { schemaVersion: 1, width: 1000, height: 800, background: { type: 'solid', color: '#fafafa' }, elements: [] }
    const r = insertDesignSnippet(dest, snip, { newId: () => `e-${++n}`, newStoryId: () => `story-new-${++n}`, readOnly: false })
    if ('declined' in r) throw new Error(r.declined)
    const frames = r.body.elements.filter((e): e is SlideTextElement => e.type === 'text')
    expect(frames).toHaveLength(2)
    expect(frames.every((f) => !!f.storyId && f.storyId === frames[0]!.storyId)).toBe(true)
    expect(frames[0]!.storyId).not.toBe('story-a')
    expect(r.body.stories![frames[0]!.storyId!]).toEqual(STORY)
    expect(frames.map((f) => f.storyOrder)).toEqual([1, 2])
  })
})
