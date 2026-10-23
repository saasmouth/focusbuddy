// PlexiiDesign as a saved-snippet surface (docs/saved-snippets.md, "Adding a
// snippet target" and "Why a design offers Duplicate only"): capture is pure
// and carries what the elements point at (stories, swatches); insertion is a
// paste with fresh element AND story ids, threads inside the selection kept and
// threads out of it cut, swatches resolved by name, the block clamped onto the
// page, the implied page materialised with the mirror intact, the snippet never
// touched, and every refusal explicit. Then the target's contract: Duplicate
// only, registered while mounted, withdrawn on unmount, and where the commands
// live on the shell.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: ({ name }: { name: string }) => <i data-icon={name} /> }))
vi.mock('../../src/renderer/src/components/Tooltip', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import {
  DESIGN_SNIPPET_LINKS,
  designBodyFromSelection,
  designSnippetTargetId,
  insertDesignSnippet,
  newDesignStoryId,
  suggestedDesignSnippetName,
  useDesignSnippetTarget,
  type DesignSnippetPlacement
} from '../../src/renderer/src/components/documents/design/designSnippets'
import { useSnippetsStore } from '../../src/renderer/src/stores/snippets'
import { linkModesFor, snippetBodyIsEmpty, snippetSummary, type DesignSnippetBody, type Snippet } from '../../src/shared/snippets'
import { normalizeDesignBody, storyFrames, type DesignBody } from '../../src/shared/design'
import { applyStoryFlows } from '../../src/shared/designStories'
import { defaultSwatches, type DesignSwatch } from '../../src/shared/designSwatches'
import { ContextBar } from '../../src/renderer/src/components/office/shell'
import { DESIGN_TABS, type DesignCtx } from '../../src/renderer/src/components/documents/design/ribbon'
import { buildDesignCommands, type DesignCommandDeps } from '../../src/renderer/src/components/documents/design/designCommands'
import { expectNotReadOnly } from './_notReadOnly'
import type { SlideElement, SlideTextElement } from '../../src/shared/types'

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A two-page design. Page 1 (active) holds a shape on a swatch, a line, a plain
// text frame and two frames of a three-frame story whose third frame is on
// page 2. Laid out away from the origin so "relative" is a real transformation.

const STORY = { blocks: [{ kind: 'heading', level: 1, text: 'Annual report' }, { kind: 'paragraph', text: 'Revenue grew in every region.' }] }
const OTHER_STORY = { blocks: [{ kind: 'paragraph', text: 'Unrelated copy.' }] }

const SHAPE = { id: 's1', type: 'shape', shape: 'rect', x: 200, y: 100, w: 300, h: 200, z: 1, fill: { type: 'solid', color: '#ff0000', swatchId: 'spot-red', tint: 50 }, groupId: 'g-old' } as unknown as SlideElement
const LINE = { id: 'l1', type: 'line', x: 210, y: 400, w: 200, h: 0, z: 2, x2: 410, y2: 400, stroke: '#111111', strokeWidth: 2, groupId: 'g-old' } as unknown as SlideElement
const PLAIN = { id: 'p1', type: 'text', x: 220, y: 320, w: 280, h: 40, z: 3, paragraphs: [{ runs: [{ text: 'Plain caption', fontSize: 14 }] }] } as unknown as SlideElement
const F1 = { id: 'f1', type: 'text', x: 520, y: 100, w: 200, h: 120, z: 4, paragraphs: [], storyId: 'story-a', storyOrder: 1, flowLines: [{ x: 0, y: 0, w: 10, text: 'cached', size: 12 }], overset: false } as unknown as SlideElement
const F2 = { id: 'f2', type: 'text', x: 520, y: 260, w: 200, h: 120, z: 5, paragraphs: [], storyId: 'story-a', storyOrder: 2, overset: false } as unknown as SlideElement
const F3 = { id: 'f3', type: 'text', x: 40, y: 40, w: 200, h: 120, z: 1, paragraphs: [], storyId: 'story-a', storyOrder: 3, overset: true } as unknown as SlideElement
const ELSE = { id: 'e1', type: 'text', x: 600, y: 600, w: 100, h: 50, z: 6, paragraphs: [], storyId: 'story-b', storyOrder: 1 } as unknown as SlideElement
const UNUSED_SWATCH: DesignSwatch = { id: 'unused', name: 'Unused', color: '#00ff00' }
const SPOT: DesignSwatch = { id: 'spot-red', name: 'Pantone Red', color: '#ff0000', spot: { inkName: 'Pantone 485 C' } }

function source(): DesignBody {
  const page1 = [SHAPE, LINE, PLAIN, F1, F2, ELSE]
  return {
    schemaVersion: 1,
    width: 1000,
    height: 800,
    background: { type: 'solid', color: '#ffffff' },
    elements: page1,
    pages: [
      { id: 'pg-1', elements: page1 },
      { id: 'pg-2', elements: [F3] }
    ],
    activePage: 0,
    stories: { 'story-a': STORY, 'story-b': OTHER_STORY } as DesignBody['stories'],
    swatches: [SPOT, UNUSED_SWATCH]
  }
}

function snippetOf(body: DesignSnippetBody, over: Partial<Snippet> = {}): Snippet {
  return {
    id: 'snip-1',
    kind: 'design',
    name: 'Report block',
    description: '',
    body,
    tags: [],
    scope: 'personal',
    orgId: 'personal',
    authorId: null,
    revision: 1,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

let seq = 0
const at = (over: Partial<DesignSnippetPlacement> = {}): DesignSnippetPlacement => ({
  newId: () => `fresh-${++seq}`,
  newStoryId: () => `story-new-${++seq}`,
  readOnly: false,
  ...over
})

/** A fresh one-page design with nothing on it and no pages array: its page is implied. */
function blank(over: Partial<DesignBody> = {}): DesignBody {
  return { schemaVersion: 1, width: 1000, height: 800, background: { type: 'solid', color: '#fafafa' }, elements: [], ...over }
}

function landed(r: ReturnType<typeof insertDesignSnippet>): { body: DesignBody; ids: string[] } {
  if ('declined' in r) throw new Error(`declined: ${r.declined}`)
  return r
}

const byId = (els: unknown[]): Record<string, SlideElement> => Object.fromEntries((els as SlideElement[]).map((e) => [e.id, e]))

// ── Capture ──────────────────────────────────────────────────────────────────

describe('capture: designBodyFromSelection is pure', () => {
  it('returns null for an empty selection, a missing design, or ids that match nothing', () => {
    expect(designBodyFromSelection(source(), [])).toBeNull()
    expect(designBodyFromSelection(undefined, ['s1'])).toBeNull()
    expect(designBodyFromSelection(source(), ['nope'])).toBeNull()
    // F3 is on page 2, not the page being edited.
    expect(designBodyFromSelection(source(), ['f3'])).toBeNull()
  })

  it('takes the selected elements relative to the selection’s top-left, in z order, line ends moved with them', () => {
    const body = designBodyFromSelection(source(), ['l1', 's1', 'p1'])!
    const els = body.elements as SlideElement[]
    expect(els.map((e) => e.id)).toEqual(['s1', 'l1', 'p1'])
    expect(els.map((e) => e.z)).toEqual([0, 1, 2])
    // The selection's top-left was (200, 100).
    expect(els.map((e) => [e.x, e.y])).toEqual([[0, 0], [10, 300], [20, 220]])
    expect(els[1]).toMatchObject({ x2: 210, y2: 300 })
    expect(els.map((e) => e.groupId ?? null)).toEqual(['g-old', 'g-old', null])
    expect(snippetBodyIsEmpty(body)).toBe(false)
    expect(snippetSummary(snippetOf(body))).toBe('3 element(s)')
  })

  it('a threaded frame carries its whole story, normalised, and drops the flow cache', () => {
    const body = designBodyFromSelection(source(), ['f1'])!
    expect(Object.keys(body.stories ?? {})).toEqual(['story-a'])
    expect(body.stories!['story-a']).toEqual(STORY)
    const f = (body.elements as SlideTextElement[])[0]!
    expect(f.storyId).toBe('story-a')
    expect(f.storyOrder).toBe(1)
    expect(f.flowLines).toBeUndefined()
    expect(f.overset).toBeUndefined()
    // Only the stories the selection reads: story-b is not carried.
    expect(body.stories!['story-b']).toBeUndefined()
  })

  it('keeps a thread between selected frames and cuts the thread to a frame outside, renumbering the chain', () => {
    // f1 and f2 are selected (in reverse order); f3 on page 2 is not.
    const body = designBodyFromSelection(source(), ['f2', 'f1'])!
    const els = byId(body.elements)
    expect((els.f1 as SlideTextElement).storyOrder).toBe(1)
    expect((els.f2 as SlideTextElement).storyOrder).toBe(2)
    expect(Object.values(els).some((e) => e.id === 'f3')).toBe(false)
  })

  it('a frame whose story is gone becomes a plain frame rather than a dangling reference', () => {
    const d = source()
    delete d.stories!['story-b']
    const body = designBodyFromSelection(d, ['e1'])!
    const e = (body.elements as SlideTextElement[])[0]!
    expect(e.storyId).toBeUndefined()
    expect(e.storyOrder).toBeUndefined()
    expect(body.stories).toBeUndefined()
  })

  it('carries exactly the swatches the fills name, and detaches a fill whose swatch the document lacks', () => {
    const body = designBodyFromSelection(source(), ['s1', 'p1'])!
    expect(body.swatches).toEqual([SPOT])
    const d = source()
    d.swatches = []
    const lost = designBodyFromSelection(d, ['s1'])!
    expect(lost.swatches).toBeUndefined()
    expect((lost.elements as SlideElement[])[0]).toMatchObject({ fill: { type: 'solid', color: '#ff0000' } })
    expect(((lost.elements as SlideElement[])[0] as { fill: Record<string, unknown> }).fill.swatchId).toBeUndefined()
    expect(((lost.elements as SlideElement[])[0] as { fill: Record<string, unknown> }).fill.tint).toBeUndefined()
  })

  it('never shares an object with the design, and never changes it', () => {
    const d = source()
    const before = JSON.stringify(d)
    const body = designBodyFromSelection(d, ['s1', 'f1', 'p1'])!
    const s = byId(body.elements).s1 as { fill: unknown }
    expect(s.fill).not.toBe((SHAPE as { fill: unknown }).fill)
    expect(body.stories!['story-a']).not.toBe(d.stories!['story-a'])
    expect(body.swatches![0]).not.toBe(SPOT)
    expect(JSON.stringify(d)).toBe(before)
  })

  it('captures from the master being edited, not the page under it', () => {
    const d = { ...source(), masters: [{ id: 'm1', name: 'A-Master', elements: [{ ...SHAPE, id: 'm-s' } as SlideElement] }], editingMasterId: 'm1' }
    expect(designBodyFromSelection(d, ['s1'])).toBeNull()
    expect((designBodyFromSelection(d, ['m-s'])!.elements as SlideElement[]).map((e) => e.id)).toEqual(['m-s'])
  })

  it('suggests a name from the first words (story or plain), or from what the block holds', () => {
    expect(suggestedDesignSnippetName(designBodyFromSelection(source(), ['f1', 's1'])!)).toBe('Annual report')
    expect(suggestedDesignSnippetName(designBodyFromSelection(source(), ['p1'])!)).toBe('Plain caption')
    expect(suggestedDesignSnippetName(designBodyFromSelection(source(), ['s1'])!)).toBe('Shape')
    expect(suggestedDesignSnippetName(designBodyFromSelection(source(), ['s1', 'l1'])!)).toBe('2 design elements')
  })
})

// ── Insertion ────────────────────────────────────────────────────────────────

describe('insertion: insertDesignSnippet behaves like a paste', () => {
  const captured = (): DesignSnippetBody => designBodyFromSelection(source(), ['s1', 'l1', 'p1', 'f1', 'f2'])!

  it('mints fresh element ids, never mutates the snippet, and returns them as the new selection', () => {
    const snip = snippetOf(captured())
    const frozen = JSON.stringify(snip)
    const r = landed(insertDesignSnippet(blank(), snip, at()))
    expect(r.ids).toHaveLength(5)
    expect(new Set(r.ids).size).toBe(5)
    for (const id of r.ids) expect(['s1', 'l1', 'p1', 'f1', 'f2']).not.toContain(id)
    expect(r.body.elements.map((e) => e.id)).toEqual(r.ids)
    expect(JSON.stringify(snip)).toBe(frozen)
    // Deep copies: editing what landed cannot reach the snippet.
    const plain = r.body.elements.find((e) => e.type === 'text' && !(e as SlideTextElement).storyId) as SlideTextElement
    plain.paragraphs[0]!.runs[0]!.text = 'changed'
    const story = r.body.stories![Object.keys(r.body.stories!)[0]!]!
    ;(story.blocks[0] as { text: string }).text = 'changed'
    expect(JSON.stringify(snip)).toBe(frozen)
  })

  it('writes the story under a FRESH id and points the new frames at it, threaded in the same order', () => {
    const dest = blank({ stories: { 'story-a': OTHER_STORY } as DesignBody['stories'] })
    const r = landed(insertDesignSnippet(dest, snippetOf(captured()), at()))
    const frames = r.body.elements.filter((e): e is SlideTextElement => e.type === 'text' && !!e.storyId)
    expect(frames).toHaveLength(2)
    const sid = frames[0]!.storyId!
    expect(frames[1]!.storyId).toBe(sid)
    // Not the snippet's id, and not one the destination already used: the
    // destination's own 'story-a' is untouched.
    expect(sid).not.toBe('story-a')
    expect(r.body.stories!['story-a']).toEqual(OTHER_STORY)
    expect(r.body.stories![sid]).toEqual(STORY)
    expect(frames.map((f) => f.storyOrder)).toEqual([1, 2])
    expect(frames.every((f) => f.paragraphs.length === 0 && f.flowLines === undefined)).toBe(true)
  })

  it('a newly minted story id that collides is minted again', () => {
    let n = 0
    const ids = ['story-taken', 'story-taken', 'story-free']
    const dest = blank({ stories: { 'story-taken': OTHER_STORY } as DesignBody['stories'] })
    const r = landed(insertDesignSnippet(dest, snippetOf(captured()), at({ newStoryId: () => ids[n++]! })))
    expect(Object.keys(r.body.stories!).sort()).toEqual(['story-free', 'story-taken'])
  })

  it('materialises the implied page with the mirror intact, so the story flows into the new frames', () => {
    const r = landed(insertDesignSnippet(blank(), snippetOf(captured()), at()))
    expect(r.body.pages).toHaveLength(1)
    // The SAME array, as syncActivePage keeps it.
    expect(r.body.pages![0]!.elements).toBe(r.body.elements)
    expect(r.body.activePage).toBe(0)
    expect(r.body.pages![0]!.background).toEqual({ type: 'solid', color: '#fafafa' })
    const sid = (r.body.elements.find((e) => e.type === 'text' && (e as SlideTextElement).storyId) as SlideTextElement).storyId!
    expect(storyFrames(r.body, sid)).toHaveLength(2)
    // And the flow engine really reaches them: the story is set into the copy.
    const flowed = applyStoryFlows(r.body, (t) => t.length * 7)
    const lines = flowed.elements
      .filter((e): e is SlideTextElement => e.type === 'text' && e.storyId === sid)
      .flatMap((f) => (f.flowLines ?? []).map((l) => l.text))
      .join(' ')
    expect(lines).toContain('Annual report')
  })

  it('lands on the active page of a multi-page design and leaves the other pages alone', () => {
    const d = source()
    d.activePage = 1
    d.elements = d.pages![1]!.elements
    const before = JSON.stringify(d.pages![0])
    const r = landed(insertDesignSnippet(d, snippetOf(captured()), at()))
    expect(JSON.stringify(r.body.pages![0])).toBe(before)
    expect(r.body.pages![1]!.elements).toBe(r.body.elements)
    expect(r.body.elements.map((e) => e.id)).toEqual(['f3', ...r.ids])
  })

  it('lands centred on the page, above everything already there, keeping the block’s shape', () => {
    const body = captured()
    const dest = blank({ elements: [{ id: 'old', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, z: 30 } as unknown as SlideElement] })
    const r = landed(insertDesignSnippet(dest, snippetOf(body), at()))
    const els = r.body.elements.filter((e) => r.ids.includes(e.id))
    const minX = Math.min(...els.map((e) => e.x))
    const minY = Math.min(...els.map((e) => e.y))
    // The block is 520 × 300 (200..720, 100..400 on the source page).
    expect([Math.max(...els.map((e) => e.x + e.w)) - minX, Math.max(...els.map((e) => e.y + e.h)) - minY]).toEqual([520, 300])
    expect([minX, minY]).toEqual([(1000 - 520) / 2, (800 - 300) / 2])
    const src = body.elements as SlideElement[]
    els.forEach((e, i) => expect([e.x - minX, e.y - minY, e.w, e.h]).toEqual([src[i]!.x, src[i]!.y, src[i]!.w, src[i]!.h]))
    expect(els.map((e) => e.z)).toEqual([31, 32, 33, 34, 35])
    const line = els.find((e) => e.type === 'line') as SlideElement & { x2: number; y2: number }
    expect([line.x2 - line.x, line.y2 - line.y]).toEqual([200, 0])
  })

  it('is clamped onto a page smaller than the block, never half off it', () => {
    const r = landed(insertDesignSnippet(blank({ width: 300, height: 200 }), snippetOf(captured()), at()))
    const els = r.body.elements
    expect(Math.min(...els.map((e) => e.x))).toBe(0)
    expect(Math.min(...els.map((e) => e.y))).toBe(0)
    for (const e of els) {
      expect(e.x).toBeGreaterThanOrEqual(0)
      expect(e.y).toBeGreaterThanOrEqual(0)
    }
  })

  it('remaps groups, so the copy never joins the original’s group', () => {
    const r = landed(insertDesignSnippet(blank(), snippetOf(captured()), at()))
    const grouped = r.body.elements.filter((e) => e.groupId)
    expect(grouped).toHaveLength(2)
    expect(grouped[0]!.groupId).toBe(grouped[1]!.groupId)
    expect(grouped[0]!.groupId).not.toBe('g-old')
  })

  describe('swatches resolve by name', () => {
    const fillOf = (b: DesignBody): Record<string, unknown> => (b.elements.find((e) => e.type === 'shape') as unknown as { fill: Record<string, unknown> }).fill

    it('a same-named swatch in the destination wins, and the cached colour follows it', () => {
      const dest = blank({ swatches: [{ id: 'red-here', name: 'pantone red', color: '#cc0000' }] })
      const r = landed(insertDesignSnippet(dest, snippetOf(captured()), at()))
      expect(fillOf(r.body)).toMatchObject({ swatchId: 'red-here', tint: 50, color: '#e68080' })
      expect(r.body.swatches).toEqual([{ id: 'red-here', name: 'pantone red', color: '#cc0000' }])
    })

    it('a swatch the destination lacks is added under a fresh id, spot ink and all', () => {
      const dest = blank({ swatches: [{ id: 'pantone-red', name: 'Something else', color: '#000000' }] })
      const r = landed(insertDesignSnippet(dest, snippetOf(captured()), at()))
      const added = r.body.swatches!.find((s) => s.name === 'Pantone Red')!
      expect(added).toMatchObject({ color: '#ff0000', spot: { inkName: 'Pantone 485 C' } })
      expect(added.id).not.toBe('pantone-red')
      expect(fillOf(r.body).swatchId).toBe(added.id)
      expect(r.body.swatches!.find((s) => s.id === 'pantone-red')!.name).toBe('Something else')
    })

    it('a destination with no palette gets the default one, and a brand swatch resolves into it', () => {
      const body: DesignSnippetBody = {
        kind: 'design',
        elements: [{ id: 'b', type: 'shape', shape: 'rect', x: 0, y: 0, w: 50, h: 50, z: 0, fill: { type: 'solid', color: '#123456', swatchId: 'brand-primary' } }],
        swatches: [{ id: 'brand-primary', name: 'Brand primary', color: '#123456', locked: true }]
      }
      const r = landed(insertDesignSnippet(blank(), snippetOf(body), at()))
      const palette = defaultSwatches()
      expect(r.body.swatches).toEqual(palette)
      expect(fillOf(r.body)).toMatchObject({ swatchId: 'brand-primary', color: palette[0]!.color })
    })

    it('a fill naming a swatch the body does not carry is detached, never left dangling; no palette is invented', () => {
      const body: DesignSnippetBody = {
        kind: 'design',
        elements: [{ id: 'b', type: 'shape', shape: 'rect', x: 0, y: 0, w: 50, h: 50, z: 0, fill: { type: 'solid', color: '#abcdef', swatchId: 'ghost', tint: 40 } }]
      }
      const r = landed(insertDesignSnippet(blank(), snippetOf(body), at()))
      expect(fillOf(r.body)).toEqual({ type: 'solid', color: '#abcdef' })
      expect(r.body.swatches).toBeUndefined()
    })
  })

  it('a layer the destination lacks, hides or locks is dropped to the base layer; a usable one is kept', () => {
    const body: DesignSnippetBody = {
      kind: 'design',
      elements: ['gone', 'hidden', 'locked', 'ok'].map((layerId, i) => ({ id: layerId, type: 'shape', shape: 'rect', x: i * 10, y: 0, w: 10, h: 10, z: i, layerId }))
    }
    const dest = blank({
      layers: [
        { id: 'hidden', name: 'Hidden', visible: false, locked: false },
        { id: 'locked', name: 'Locked', visible: true, locked: true },
        { id: 'ok', name: 'Art', visible: true, locked: false }
      ]
    })
    const r = landed(insertDesignSnippet(dest, snippetOf(body), at()))
    expect(r.body.elements.map((e) => e.layerId ?? null)).toEqual([null, null, null, 'ok'])
  })

  it('inserts onto the master being edited, but declines threaded text there, saying why', () => {
    const dest = { ...blank(), masters: [{ id: 'm1', name: 'A-Master', elements: [] }], editingMasterId: 'm1' }
    const shapeOnly = designBodyFromSelection(source(), ['s1'])!
    const r = landed(insertDesignSnippet(dest, snippetOf(shapeOnly), at()))
    expect(r.body.masters![0]!.elements.map((e) => e.id)).toEqual(r.ids)
    expect(r.body.elements).toEqual([])
    const threaded = insertDesignSnippet(dest, snippetOf(captured()), at())
    expect('declined' in threaded && threaded.declined).toMatch(/master page/)
  })

  it('declines when read-only, for another kind, or when nothing in it can be drawn', () => {
    const body = captured()
    const reason = (r: ReturnType<typeof insertDesignSnippet>): string | false => ('declined' in r ? r.declined : false)
    expect(reason(insertDesignSnippet(blank(), snippetOf(body), at({ readOnly: true })))).toMatch(/read-only/)
    expect(reason(insertDesignSnippet(blank(), snippetOf({ kind: 'design', elements: [] }), at()))).toBeTruthy()
    expect(reason(insertDesignSnippet(blank(), snippetOf({ kind: 'design', elements: [{ id: 'ghost', type: 'shape' }] }), at()))).toBeTruthy()
    expect(reason(insertDesignSnippet(blank(), snippetOf({ kind: 'design' } as unknown as DesignSnippetBody), at()))).toBeTruthy()
    expect(reason(insertDesignSnippet(blank(), snippetOf(body, { kind: 'slide', body: { kind: 'slide', elements: body.elements } }), at()))).toBeTruthy()
  })

  it('an untrusted story that is empty or missing leaves a plain frame, not a dangling reference', () => {
    const body: DesignSnippetBody = {
      kind: 'design',
      elements: [
        { id: 'a', type: 'text', x: 0, y: 0, w: 50, h: 50, z: 0, paragraphs: [], storyId: 'nothing' },
        { id: 'b', type: 'text', x: 60, y: 0, w: 50, h: 50, z: 1, paragraphs: [], storyId: 'empty' }
      ],
      stories: { empty: { blocks: [] } }
    }
    const r = landed(insertDesignSnippet(blank(), snippetOf(body), at()))
    expect(r.body.elements.every((e) => (e as SlideTextElement).storyId === undefined)).toBe(true)
    expect(r.body.stories).toBeUndefined()
  })

  it('survives a save and reload: the stored body reopens with the copy, its story and its threading', () => {
    const r = landed(insertDesignSnippet(blank(), snippetOf(captured()), at()))
    const reopened = normalizeDesignBody(JSON.parse(JSON.stringify(r.body)))
    expect(reopened.elements.map((e) => e.id)).toEqual(r.ids)
    const sid = (reopened.elements.find((e) => (e as SlideTextElement).storyId) as SlideTextElement).storyId!
    expect(reopened.stories![sid]).toEqual(STORY)
    expect(storyFrames(reopened, sid).map((f) => f.element.storyOrder)).toEqual([1, 2])
  })

  it('mints distinct story ids by default', () => {
    expect(newDesignStoryId()).not.toBe(newDesignStoryId())
    expect(newDesignStoryId()).toMatch(/^story-/)
  })
})

// ── The registration, in a real React tree ───────────────────────────────────

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useSnippetsStore.setState({ targets: {}, error: null })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Design({ id, title, insert }: { id: string; title: string; insert: (s: Snippet) => boolean }): null {
  useDesignSnippetTarget(id, title, insert)
  return null
}

describe('the design as a snippet target', () => {
  it('claims Duplicate only, and linkModesFor agrees', () => {
    expect(DESIGN_SNIPPET_LINKS).toEqual(['duplicate'])
    act(() => root.render(<Design id=":r1:" title="Spring brochure" insert={() => true} />))
    const target = useSnippetsStore.getState().targets[designSnippetTargetId(':r1:')]!
    expect(target).toBeTruthy()
    expect(linkModesFor(target, 'design')).toEqual(['duplicate'])
    // Any-to-any: every kind with a conversion into page elements, as a copy.
    expect(linkModesFor(target, 'slide')).toEqual(['duplicate'])
    expect(linkModesFor(target, 'draw')).toEqual(['duplicate'])
    expect(target.host).toBe('design')
    expect(target.label).toBe('“Spring brochure”')
  })

  it('registers each mounted design separately and withdraws on unmount', () => {
    act(() =>
      root.render(
        <>
          <Design id=":a:" title="One" insert={() => true} />
          <Design id=":b:" title="" insert={() => true} />
        </>
      )
    )
    expect(Object.keys(useSnippetsStore.getState().targets).sort()).toEqual([designSnippetTargetId(':a:'), designSnippetTargetId(':b:')])
    expect(useSnippetsStore.getState().targets[designSnippetTargetId(':b:')]!.label).toBe('This design')
    act(() => root.render(<Design id=":a:" title="One" insert={() => true} />))
    expect(Object.keys(useSnippetsStore.getState().targets)).toEqual([designSnippetTargetId(':a:')])
    act(() => root.render(<></>))
    expect(useSnippetsStore.getState().targets).toEqual({})
  })

  it('always calls the CURRENT render’s insert, and refuses a live request outright', async () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => false)
    act(() => root.render(<Design id=":c:" title="D" insert={first} />))
    act(() => root.render(<Design id=":c:" title="D" insert={second} />))
    const target = useSnippetsStore.getState().targets[designSnippetTargetId(':c:')]!
    const snip = snippetOf({ kind: 'design', elements: [SHAPE] })
    expect(await target.insert(snip, 'duplicate')).toBe(false)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(await target.insert(snip, 'live')).toBe(false)
    expect(second).toHaveBeenCalledTimes(1)
    expect(await useSnippetsStore.getState().insert(snip, 'live', target.id)).toBe(false)
    expect(useSnippetsStore.getState().error).toMatch(/cannot take a live snippet/)
  })
})

describe('where the commands live on the shell', () => {
  function ctx(selected: SlideElement[], cmds: Partial<DesignCtx['cmd']>): DesignCtx {
    const design = normalizeDesignBody({ width: 794, height: 1123, elements: selected })
    const noop = (): void => undefined
    // The ribbon renders Design's command record (design/designCommands); its
    // snippet commands reach the same functions the old `cmd` hooks did.
    const deps = new Proxy(
      { readOnly: false, selected: selected.length, grouped: false, canPaste: false, textMarks: null, saveSnippet: cmds.saveSnippet ?? noop, insertSnippet: cmds.insertSnippet ?? noop } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : noop) }
    ) as unknown as DesignCommandDeps
    return {
      cmds: expectNotReadOnly('designSnippets', buildDesignCommands(deps)),
      design,
      selected,
      first: selected[0] ?? null,
      fonts: ['Inter'],
      palette: ['#2563eb'],
      cmd: new Proxy(cmds, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (() => undefined) }) as DesignCtx['cmd'],
      startFrom: null,
      guidesVisible: true,
      facing: false,
      bleed: 0,
      layers: [{ id: 'base', name: 'Layer 1' }]
    }
  }
  const btn = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!

  it('Insert › Insert snippet… opens the library', () => {
    const insertSnippet = vi.fn()
    act(() => root.render(<ContextBar<DesignCtx> testid="design-toolbar" tabs={DESIGN_TABS} ctx={ctx([], { insertSnippet })} activeTab="insert" onTabChange={() => {}} menuBar={null} />))
    // The lexicon's label, the same as the menu bar's (SPEC §9.9).
    expect(btn('design-insert-snippet').getAttribute('aria-label')).toContain('Insert snippet…')
    act(() => btn('design-insert-snippet').click())
    expect(insertSnippet).toHaveBeenCalledTimes(1)
  })

  it('Arrange › Save selection as snippet… sits with the selection actions, and is off with nothing selected', () => {
    const saveSnippet = vi.fn()
    act(() => root.render(<ContextBar<DesignCtx> testid="design-toolbar" tabs={DESIGN_TABS} ctx={ctx([], { saveSnippet })} activeTab="arrange" onTabChange={() => {}} menuBar={null} />))
    expect(btn('design-save-snippet').disabled).toBe(true)
    act(() => root.render(<ContextBar<DesignCtx> testid="design-toolbar" tabs={DESIGN_TABS} ctx={ctx([SHAPE], { saveSnippet })} activeTab="arrange" onTabChange={() => {}} menuBar={null} />))
    expect(btn('design-save-snippet').disabled).toBe(false)
    act(() => btn('design-save-snippet').click())
    expect(saveSnippet).toHaveBeenCalledTimes(1)
  })
})
