// The two snippet kinds PlexiiDiagrams and PlexiiDeck edit in
// SnippetEditSessionView ("Open original"): wrap a snippet body into the
// editor's document shape, unwrap it back. Built from bodies made by the real
// capture functions, so the round trip is checked against the contract capture
// sets (positions relative to the fragment's top-left).

import { describe, expect, it } from 'vitest'
import type { MapNode, MapEdge, Slide, SlideElement } from '../../src/shared/types'
import { diagramBodyFromSelection } from '../../src/renderer/src/components/documents/diagram/diagramSnippets'
import { unwrapDiagramSnippet, wrapDiagramSnippet } from '../../src/renderer/src/components/documents/diagram/snippetSession'
import { slideBodyFromSelection, DECK_PAGE } from '../../src/renderer/src/components/documents/slides/deckSnippets'
import { unwrapSlideSnippet, wrapSlideSnippet } from '../../src/renderer/src/components/documents/slides/snippetSession'

const node = (id: string, x: number, y: number, label = id): MapNode => ({ id, x, y, label, shape: 'rect', color: '#336699', width: 120, height: 60 }) as MapNode

describe('diagram snippet ⇄ one-page MapBody', () => {
  const graph = {
    nodes: [node('a', 300, 200, 'Start'), node('b', 520, 200, 'End'), node('c', 900, 900, 'Elsewhere')],
    edges: [{ id: 'e1', source: 'a', target: 'b', waypoints: [{ x: 460, y: 180 }] } as MapEdge]
  }
  const captured = diagramBodyFromSelection(graph as never, { nodes: new Set(['a', 'b']), edges: new Set() })!

  it('capture gives a top-left fragment (the contract the session keeps)', () => {
    const xs = (captured.nodes as MapNode[]).map((n) => n.x)
    expect(Math.min(...xs)).toBe(0)
    expect(captured.edges).toHaveLength(1)
  })

  it('wrap puts the graph on page one and invents no pages', () => {
    const doc = wrapDiagramSnippet(captured)
    expect(doc.nodes.map((n) => n.id).sort()).toEqual((captured.nodes as MapNode[]).map((n) => n.id).sort())
    expect(doc.pages ?? []).toHaveLength(0)
  })

  it('round trip: ids, labels, positions and the edge (with its waypoint) come back', () => {
    const back = unwrapDiagramSnippet(wrapDiagramSnippet(captured))
    const pick = (ns: unknown[]): unknown[] => (ns as MapNode[]).map((n) => [n.id, n.label, n.x, n.y]).sort()
    expect(pick(back.nodes)).toEqual(pick(captured.nodes))
    const e = (back.edges as MapEdge[])[0]!
    const e0 = (captured.edges as MapEdge[])[0]!
    expect([e.id, e.source, e.target, e.waypoints]).toEqual([e0.id, e0.source, e0.target, e0.waypoints])
  })

  it('is stable: unwrap ∘ wrap is idempotent, so an unchanged Save writes the same body', () => {
    const once = unwrapDiagramSnippet(wrapDiagramSnippet(captured))
    expect(unwrapDiagramSnippet(wrapDiagramSnippet(once))).toEqual(once)
  })

  it('an edit that moves the fragment is re-normalised to its top-left, waypoints too', () => {
    const doc = wrapDiagramSnippet(captured)
    const moved = { ...doc, nodes: doc.nodes.map((n) => ({ ...n, x: n.x + 400, y: n.y + 250 })), edges: doc.edges.map((e) => ({ ...e, waypoints: e.waypoints?.map((p) => ({ x: p.x + 400, y: p.y + 250 })) })) }
    const back = unwrapDiagramSnippet(moved)
    expect(back).toEqual(unwrapDiagramSnippet(doc))
  })

  it('an emptied diagram unwraps to an empty snippet', () => {
    expect(unwrapDiagramSnippet({ ...wrapDiagramSnippet(captured), nodes: [], edges: [] })).toEqual({ kind: 'diagram', nodes: [], edges: [] })
  })
})

describe('slide snippet ⇄ in-memory one-slide deck', () => {
  const slide: Slide = {
    id: 's1',
    notes: '',
    elements: [
      { id: 't1', type: 'text', x: 400, y: 300, w: 300, h: 60, z: 2, text: 'Title' } as unknown as SlideElement,
      { id: 'r1', type: 'shape', x: 380, y: 280, w: 340, h: 120, z: 1 } as unknown as SlideElement,
      { id: 'l1', type: 'line', x: 380, y: 420, w: 340, h: 0, x2: 720, y2: 420, z: 3 } as unknown as SlideElement,
      { id: 'other', type: 'text', x: 10, y: 10, w: 50, h: 20, z: 0, text: 'not picked' } as unknown as SlideElement
    ]
  }
  const captured = slideBodyFromSelection(slide, ['t1', 'r1', 'l1'])!

  it('wrap makes ONE slide holding exactly the fragment, centred on the page', () => {
    const deck = wrapSlideSnippet(captured)
    expect(deck.slides).toHaveLength(1)
    expect(deck.size).toEqual(DECK_PAGE)
    const els = deck.slides[0]!.elements!
    expect(els).toHaveLength(3)
    const minX = Math.min(...els.map((e) => e.x))
    const maxR = Math.max(...els.map((e) => e.x + (e.w ?? 0)))
    expect(Math.round((minX + maxR) / 2)).toBe(DECK_PAGE.w / 2)
  })

  it('round trip returns the captured body exactly (ids, z order, the line end)', () => {
    expect(unwrapSlideSnippet(wrapSlideSnippet(captured))).toEqual(captured)
  })

  it('an edit that moves the fragment is re-normalised to its top-left; a line end moves with it', () => {
    const deck = wrapSlideSnippet(captured)
    const s0 = deck.slides[0]!
    const moved = { ...deck, slides: [{ ...s0, elements: s0.elements!.map((e) => ({ ...e, x: e.x + 37, y: e.y + 11, ...(e.type === 'line' ? { x2: (e as unknown as { x2: number }).x2 + 37, y2: (e as unknown as { y2: number }).y2 + 11 } : {}) })) }] }
    expect(unwrapSlideSnippet(moved as never)).toEqual(captured)
  })

  it('z order is kept and renumbered from 0, as capture does', () => {
    const back = unwrapSlideSnippet(wrapSlideSnippet(captured)).elements as SlideElement[]
    expect(back.map((e) => e.z)).toEqual([0, 1, 2])
  })

  it('an emptied slide unwraps to an empty snippet', () => {
    const deck = wrapSlideSnippet(captured)
    expect(unwrapSlideSnippet({ ...deck, slides: [{ ...deck.slides[0]!, elements: [] }] })).toEqual({ kind: 'slide', elements: [] })
  })
})
