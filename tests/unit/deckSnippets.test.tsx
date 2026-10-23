// PlexiiDeck as a saved-snippet surface (docs/saved-snippets.md, "Adding a
// snippet target"): capture is pure, insertion behaves exactly like a paste
// (fresh ids, never touching the snippet, declining when read-only), the link
// modes are what the deck claims, and a mounted deck registers itself as a
// destination for exactly as long as it is mounted.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: ({ name }: { name: string }) => <i data-icon={name} /> }))
vi.mock('../../src/renderer/src/components/Tooltip', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import {
  DECK_SNIPPET_LINKS,
  deckSnippetTargetId,
  slideBodyFromSelection,
  slideElementsFromSnippet,
  suggestedSlideSnippetName,
  useDeckSnippetTarget,
  type SlideSnippetPlacement
} from '../../src/renderer/src/components/documents/slides/deckSnippets'
import { useSnippetsStore } from '../../src/renderer/src/stores/snippets'
import { linkModesFor, snippetBodyIsEmpty, snippetSummary, type Snippet, type SlideSnippetBody } from '../../src/shared/snippets'
import { ContextBar } from '../../src/renderer/src/components/office/shell'
import { DECK_TABS, type DeckCtx } from '../../src/renderer/src/components/documents/slides/ribbon'
import { buildDeckCommands, type DeckCommandDeps } from '../../src/renderer/src/components/documents/slides/deckCommands'
import { expectNotReadOnly } from './_notReadOnly'
import { resolveTheme } from '../../src/shared/slideThemes'
import type { Slide, SlideElement } from '../../src/shared/types'

// One of every element type a deck holds, laid out away from the origin so
// "relative to the selection's top-left" is a real transformation.
const TEXT: SlideElement = { id: 't1', type: 'text', x: 300, y: 200, w: 400, h: 100, z: 4, paragraphs: [{ runs: [{ text: 'Quarterly revenue', fontSize: 32, bold: true }] }], fill: { type: 'solid', color: '#ffeecc' } }
const SHAPE: SlideElement = { id: 's1', type: 'shape', shape: 'roundRect', x: 250, y: 150, w: 600, h: 400, z: 1, fill: { type: 'gradient', color: '#ff0000', color2: '#0000ff', angle: 45 }, groupId: 'g-old' }
const LINE: SlideElement = { id: 'l1', type: 'line', x: 260, y: 560, w: 500, h: 0, z: 5, x2: 760, y2: 560, stroke: '#111111', strokeWidth: 3, arrowEnd: true, groupId: 'g-old' }
const IMAGE: SlideElement = { id: 'i1', type: 'image', x: 700, y: 180, w: 120, h: 90, z: 3, src: 'data:image/png;base64,iVBORw0KGgo=', fit: 'cover', lockAspect: true, naturalW: 1200, naturalH: 900, alt: 'Logo' } as SlideElement
const TABLE: SlideElement = { id: 'tb1', type: 'table', x: 320, y: 320, w: 300, h: 120, z: 2, headerRow: true, accent: '#336699', cells: [['Region', 'Revenue'], ['North', '12']] }
const CHART: SlideElement = { id: 'c1', type: 'chart', x: 640, y: 300, w: 200, h: 150, z: 6, chart: { type: 'bar', title: 'Sales', data: { categories: ['Q1', 'Q2'], series: [{ name: 'S', values: [1, 2] }] } }, source: { sheetDocId: 'sheet-42', range: 'A1:B3', headerRow: true } } as SlideElement
const WIDGET: SlideElement = { id: 'w1', type: 'widget', x: 900, y: 500, w: 200, h: 100, z: 7, widgetId: 'widget-9' }
const OUTSIDE: SlideElement = { id: 'x1', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, z: 9 }
const ALL = [TEXT, SHAPE, LINE, IMAGE, TABLE, CHART, WIDGET]

function slideWith(elements: SlideElement[]): Slide {
  return { id: 'sl1', notes: '', elements, schemaVersion: 2 }
}

function snippetOf(body: SlideSnippetBody, over: Partial<Snippet> = {}): Snippet {
  return {
    id: 'snip-1',
    kind: 'slide',
    name: 'Revenue block',
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
const at = (over: Partial<SlideSnippetPlacement> = {}): SlideSnippetPlacement => ({
  canvas: { w: 1280, h: 720 },
  topZ: 20,
  newId: () => `fresh-${++seq}`,
  readOnly: false,
  ...over
})

describe('capture: slideBodyFromSelection is pure', () => {
  it('returns null for an empty selection, a missing slide, or ids that match nothing', () => {
    expect(slideBodyFromSelection(slideWith(ALL), [])).toBeNull()
    expect(slideBodyFromSelection(undefined, ['t1'])).toBeNull()
    expect(slideBodyFromSelection(slideWith(ALL), ['nope'])).toBeNull()
  })

  it('takes only the selected elements, positioned relative to the selection’s top-left, in z order', () => {
    const body = slideBodyFromSelection(slideWith([...ALL, OUTSIDE]), ['t1', 's1', 'l1'])!
    expect(body.kind).toBe('slide')
    const els = body.elements as SlideElement[]
    // z order: shape (1), text (4), line (5), renumbered 0..n-1, order kept.
    expect(els.map((e) => e.id)).toEqual(['s1', 't1', 'l1'])
    expect(els.map((e) => e.z)).toEqual([0, 1, 2])
    // The selection's top-left was (250, 150).
    expect(els.map((e) => [e.x, e.y])).toEqual([[0, 0], [50, 50], [10, 410]])
    // Sizes are untouched, and a line's stored end point moves with it.
    expect(els.map((e) => [e.w, e.h])).toEqual([[600, 400], [400, 100], [500, 0]])
    expect(els[2]).toMatchObject({ x2: 510, y2: 410 })
    expect(Math.min(...els.map((e) => e.x))).toBe(0)
    expect(Math.min(...els.map((e) => e.y))).toBe(0)
  })

  it('keeps every element type whole: text runs, gradients, groups, images, tables, chart sources, widget ids', () => {
    const body = slideBodyFromSelection(slideWith(ALL), ALL.map((e) => e.id))!
    const byId = Object.fromEntries((body.elements as SlideElement[]).map((e) => [e.id, e]))
    for (const src of ALL) {
      const got = byId[src.id]!
      expect(got.type).toBe(src.type)
      // Everything except position and z is carried verbatim.
      const strip = (e: SlideElement): Record<string, unknown> => {
        const { x: _x, y: _y, z: _z, x2: _x2, y2: _y2, ...rest } = e as SlideElement & { x2?: number; y2?: number }
        return rest
      }
      expect(strip(got)).toEqual(strip(src))
    }
    expect(byId.c1).toMatchObject({ source: { sheetDocId: 'sheet-42', range: 'A1:B3' } })
    expect(byId.w1).toMatchObject({ widgetId: 'widget-9' })
    expect(byId.i1).toMatchObject({ src: IMAGE.type === 'image' ? IMAGE.src : '' })
    expect(snippetBodyIsEmpty(body)).toBe(false)
    expect(snippetSummary(snippetOf(body))).toBe('7 element(s)')
  })

  it('never shares an object with the deck, and never changes the deck', () => {
    const slide = slideWith(ALL)
    const before = JSON.stringify(slide)
    const body = slideBodyFromSelection(slide, ['t1', 's1'])!
    const text = (body.elements as SlideElement[]).find((e) => e.id === 't1')!
    expect(text).not.toBe(TEXT)
    expect((text as typeof TEXT & { paragraphs: unknown }).paragraphs).not.toBe((TEXT as { paragraphs: unknown }).paragraphs)
    expect(JSON.stringify(slide)).toBe(before)
  })

  it('suggests a name from the first words, or from what the block holds', () => {
    expect(suggestedSlideSnippetName(slideBodyFromSelection(slideWith(ALL), ['t1', 's1'])!)).toBe('Quarterly revenue')
    expect(suggestedSlideSnippetName(slideBodyFromSelection(slideWith(ALL), ['tb1'])!)).toBe('Table')
    expect(suggestedSlideSnippetName(slideBodyFromSelection(slideWith(ALL), ['s1', 'c1'])!)).toBe('2 slide elements')
  })
})

describe('insertion: slideElementsFromSnippet behaves like a paste', () => {
  const body = slideBodyFromSelection(slideWith(ALL), ALL.map((e) => e.id))!

  it('mints a fresh id for every element and never mutates the snippet', () => {
    const snip = snippetOf(body)
    const frozen = JSON.stringify(snip)
    const els = slideElementsFromSnippet(snip, at())!
    expect(els).toHaveLength(ALL.length)
    const ids = els.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(ALL.map((e) => e.id)).not.toContain(id)
    expect(JSON.stringify(snip)).toBe(frozen)
    // Deep copies: editing an inserted element's paragraphs cannot reach the snippet.
    const t = els.find((e) => e.type === 'text') as Extract<SlideElement, { type: 'text' }>
    t.paragraphs[0]!.runs[0]!.text = 'changed'
    expect(JSON.stringify(snip)).toBe(frozen)
  })

  it('remaps groups so the copy never joins the original’s group, and keeps grouped elements together', () => {
    const els = slideElementsFromSnippet(snippetOf(body), at())!
    const grouped = els.filter((e) => e.groupId)
    expect(grouped).toHaveLength(2)
    expect(grouped[0]!.groupId).toBe(grouped[1]!.groupId)
    expect(grouped[0]!.groupId).not.toBe('g-old')
  })

  it('lands centred on the page, above everything on the slide, keeping the block’s shape and order', () => {
    const els = slideElementsFromSnippet(snippetOf(body), at({ topZ: 20 }))!
    const minX = Math.min(...els.map((e) => e.x))
    const minY = Math.min(...els.map((e) => e.y))
    const maxR = Math.max(...els.map((e) => e.x + e.w))
    const maxB = Math.max(...els.map((e) => e.y + e.h))
    // The block is 850 × 450 (250..1100, 150..600 on the source slide).
    expect([maxR - minX, maxB - minY]).toEqual([850, 450])
    expect([minX, minY]).toEqual([(1280 - 850) / 2, (720 - 450) / 2])
    // Relative geometry is exactly the body's.
    const src = body.elements as SlideElement[]
    els.forEach((e, i) => {
      expect([e.x - minX, e.y - minY, e.w, e.h]).toEqual([src[i]!.x, src[i]!.y, src[i]!.w, src[i]!.h])
    })
    expect(els.map((e) => e.z)).toEqual([21, 22, 23, 24, 25, 26, 27])
    const line = els.find((e) => e.type === 'line') as SlideElement & { x2: number; y2: number }
    expect(line.x2 - line.x).toBe(500)
    expect(line.y2 - line.y).toBe(0)
  })

  it('stays on a smaller page instead of landing off it', () => {
    const els = slideElementsFromSnippet(snippetOf(body), at({ canvas: { w: 800, h: 400 } }))!
    expect(Math.min(...els.map((e) => e.x))).toBe(0)
    expect(Math.min(...els.map((e) => e.y))).toBe(0)
  })

  it('carries linked data the way a paste does: chart source, image src, widget reference', () => {
    const els = slideElementsFromSnippet(snippetOf(body), at())!
    expect(els.find((e) => e.type === 'chart')).toMatchObject({ source: { sheetDocId: 'sheet-42', range: 'A1:B3', headerRow: true } })
    expect(els.find((e) => e.type === 'image')).toMatchObject({ src: (IMAGE as { src: string }).src, alt: 'Logo' })
    expect(els.find((e) => e.type === 'widget')).toMatchObject({ widgetId: 'widget-9' })
  })

  it('declines when read-only, for another kind, or when nothing in it can be drawn', () => {
    expect(slideElementsFromSnippet(snippetOf(body), at({ readOnly: true }))).toBeNull()
    expect(slideElementsFromSnippet(snippetOf({ kind: 'slide', elements: [] }), at())).toBeNull()
    expect(slideElementsFromSnippet(snippetOf({ kind: 'slide', elements: [{ id: 'ghost', type: 'shape' }] }), at())).toBeNull()
    const doc = snippetOf(body, { kind: 'doc', body: { kind: 'doc', content: [], text: '' } })
    expect(slideElementsFromSnippet(doc, at())).toBeNull()
  })

  it('drops undrawable elements from an untrusted body rather than landing invisible ghosts', () => {
    const mixed = snippetOf({ kind: 'slide', elements: [...(body.elements as SlideElement[]).slice(0, 2), { id: 'g', type: 'shape', x: 'a' }] })
    expect(slideElementsFromSnippet(mixed, at())).toHaveLength(2)
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

function Deck({ id, title, insert }: { id: string; title: string; insert: (s: Snippet) => boolean }): null {
  useDeckSnippetTarget(id, title, insert)
  return null
}

describe('the deck as a snippet target', () => {
  it('claims Duplicate only, and linkModesFor agrees', () => {
    expect(DECK_SNIPPET_LINKS).toEqual(['duplicate'])
    act(() => root.render(<Deck id=":r1:" title="Q3 review" insert={() => true} />))
    const target = useSnippetsStore.getState().targets[deckSnippetTargetId(':r1:')]!
    expect(target).toBeTruthy()
    expect(linkModesFor(target, 'slide')).toEqual(['duplicate'])
    // Any-to-any: every kind with a conversion into slide elements, as a copy.
    expect(linkModesFor(target, 'doc')).toEqual(['duplicate'])
    expect(linkModesFor(target, 'design')).toEqual(['duplicate'])
    expect(target.host).toBe('slide')
    expect(target.label).toBe('“Q3 review”')
  })

  it('registers each mounted deck separately and withdraws on unmount', () => {
    act(() =>
      root.render(
        <>
          <Deck id=":a:" title="One" insert={() => true} />
          <Deck id=":b:" title="" insert={() => true} />
        </>
      )
    )
    const ids = Object.keys(useSnippetsStore.getState().targets).sort()
    expect(ids).toEqual([deckSnippetTargetId(':a:'), deckSnippetTargetId(':b:')])
    expect(useSnippetsStore.getState().targets[deckSnippetTargetId(':b:')]!.label).toBe('This deck')
    act(() => root.render(<Deck id=":a:" title="One" insert={() => true} />))
    expect(Object.keys(useSnippetsStore.getState().targets)).toEqual([deckSnippetTargetId(':a:')])
    act(() => root.render(<></>))
    expect(useSnippetsStore.getState().targets).toEqual({})
  })

  it('always calls the CURRENT render’s insert, and refuses a live request outright', async () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => false)
    act(() => root.render(<Deck id=":c:" title="D" insert={first} />))
    act(() => root.render(<Deck id=":c:" title="D" insert={second} />))
    const target = useSnippetsStore.getState().targets[deckSnippetTargetId(':c:')]!
    const snip = snippetOf({ kind: 'slide', elements: [TEXT] })
    expect(await target.insert(snip, 'duplicate')).toBe(false)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(await target.insert(snip, 'live')).toBe(false)
    expect(second).toHaveBeenCalledTimes(1)
    // And the store refuses Live before it even asks the deck.
    expect(await useSnippetsStore.getState().insert(snip, 'live', target.id)).toBe(false)
    expect(useSnippetsStore.getState().error).toMatch(/cannot take a live snippet/)
  })
})

describe('where the commands live on the shell', () => {
  function ctx(selected: SlideElement[], ed: Partial<DeckCtx['ed']>): DeckCtx {
    const noop = (): void => {}
    // The ribbon renders Deck's command record (slides/deckCommands); its
    // snippet commands reach the same functions the old `ed` hooks did.
    const deps = new Proxy(
      { readOnly: false, selected: selected.length, anyGrouped: false, canUndo: false, canRedo: false, canPaste: false, singleSlide: false, textMarks: null, saveSnippet: ed.saveSnippet ?? noop, insertSnippet: ed.insertSnippet ?? noop } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : noop) }
    ) as unknown as DeckCommandDeps
    return {
      cmds: expectNotReadOnly('deckSnippets', buildDeckCommands(deps)),
      slide: slideWith(ALL),
      theme: resolveTheme('plexi-default'),
      selected,
      el: selected.length === 1 ? selected[0]! : null,
      anyGrouped: false,
      readOnly: false,
      tool: 'select',
      setTool: noop,
      isPanelOpen: () => false,
      togglePanel: noop,
      openPanel: noop,
      sidePane: null,
      openSidePane: noop,
      toggleSidePane: noop,
      ed: new Proxy(ed, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? noop }) as DeckCtx['ed']
    }
  }
  const btn = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!

  it('Insert › Insert snippet… opens the library', () => {
    const insertSnippet = vi.fn()
    act(() => root.render(<ContextBar<DeckCtx> testid="slides-toolbar" tabs={DECK_TABS} ctx={ctx([], { insertSnippet })} activeTab="insert" onTabChange={() => {}} menuBar={null} />))
    // The lexicon's label, the same as the menu bar's (SPEC §9.9).
    expect(btn('slides-insert-snippet').getAttribute('aria-label')).toContain('Insert snippet…')
    act(() => btn('slides-insert-snippet').click())
    expect(insertSnippet).toHaveBeenCalledTimes(1)
  })

  it('Arrange › Save selection as snippet… sits with the selection actions, and says why when nothing is selected', () => {
    const saveSnippet = vi.fn()
    act(() => root.render(<ContextBar<DeckCtx> testid="slides-toolbar" tabs={DECK_TABS} ctx={ctx([], { saveSnippet })} activeTab="arrange" onTabChange={() => {}} menuBar={null} />))
    expect(btn('slides-save-snippet').disabled).toBe(true)
    act(() => root.render(<ContextBar<DeckCtx> testid="slides-toolbar" tabs={DECK_TABS} ctx={ctx([SHAPE], { saveSnippet })} activeTab="arrange" onTabChange={() => {}} menuBar={null} />))
    expect(btn('slides-save-snippet').disabled).toBe(false)
    act(() => btn('slides-save-snippet').click())
    expect(saveSnippet).toHaveBeenCalledTimes(1)
  })
})
