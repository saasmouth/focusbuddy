// Editing a design snippet with no document: the wrapper in, the snippet out.
//
// The round trip is the whole contract. A session that loses a story, a
// swatch or an element on save would corrupt the snippet MASTER, and every
// live instance of it everywhere follows the master — so a mistake here is
// not one person's document, it is everyone's copy of that snippet.

import { describe, expect, it } from 'vitest'
import { unwrapDesignSnippet, wrapDesignSnippet } from '../../src/renderer/src/components/documents/design/snippetSession'
import type { DesignSnippetBody } from '../../src/shared/snippets'

const text = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'text',
  x: 20,
  y: 30,
  w: 200,
  h: 60,
  z: 1,
  paragraphs: [{ runs: [{ text: 'A line', fontSize: 16 }] }],
  ...extra
})
const shape = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'shape',
  shape: 'rect',
  x: 0,
  y: 0,
  w: 120,
  h: 80,
  z: 0,
  fill: { type: 'solid', color: '#2563eb' },
  ...extra
})

const snippet = (extra: Partial<DesignSnippetBody> = {}): DesignSnippetBody => ({
  kind: 'design',
  elements: [shape('s1'), text('t1')],
  ...extra
})

describe('wrapDesignSnippet: a document to edit, in memory only', () => {
  it('materialises one page holding the snippet’s elements', () => {
    const doc = wrapDesignSnippet(snippet())
    expect(doc.pages).toHaveLength(1)
    expect(doc.pages![0]!.elements.map((e) => e.id)).toEqual(['s1', 't1'])
    // The mirror Design keeps: the active page's elements ARE the top-level ones.
    expect(doc.elements).toBe(doc.pages![0]!.elements)
  })

  it('sizes the page to the art plus a margin, not to a preset', () => {
    const doc = wrapDesignSnippet({ kind: 'design', elements: [shape('s1', { x: 0, y: 0, w: 400, h: 300 })] })
    expect(doc.width).toBeGreaterThanOrEqual(400)
    expect(doc.width).toBeLessThan(600)
    expect(doc.height).toBeGreaterThanOrEqual(300)
  })

  it('gives an empty snippet somewhere to draw rather than a zero-size page', () => {
    const doc = wrapDesignSnippet({ kind: 'design', elements: [] })
    expect(doc.width).toBeGreaterThan(0)
    expect(doc.height).toBeGreaterThan(0)
  })

  it('survives elements with missing or junk geometry', () => {
    const doc = wrapDesignSnippet({
      kind: 'design',
      elements: [{ id: 'bad', type: 'shape', x: Number.NaN, y: undefined, w: 'wide', h: null, z: 0 } as never]
    })
    expect(Number.isFinite(doc.width)).toBe(true)
    expect(Number.isFinite(doc.height)).toBe(true)
  })

  it('puts the snippet’s own swatches on the document, so a fill resolves against what it was saved with', () => {
    const doc = wrapDesignSnippet(
      snippet({
        elements: [shape('s1', { fill: { type: 'solid', color: '#123456', swatchId: 'sw-1' } })],
        swatches: [{ id: 'sw-1', name: 'Deep sea', color: '#123456' }]
      })
    )
    expect(doc.swatches?.map((s) => s.id)).toEqual(['sw-1'])
  })

  it('carries the stories its threaded frames read', () => {
    const doc = wrapDesignSnippet(
      snippet({
        elements: [text('t1', { storyId: 'st-a', storyOrder: 1 })],
        stories: { 'st-a': { blocks: [{ kind: 'paragraph', text: 'The article' }] } }
      })
    )
    expect(doc.stories?.['st-a']).toBeDefined()
  })
})

describe('unwrapDesignSnippet: the snippet back out, and nothing else', () => {
  it('round-trips elements, stories and swatches unchanged when nothing was edited', () => {
    const body = snippet({
      elements: [shape('s1', { fill: { type: 'solid', color: '#123456', swatchId: 'sw-1' } }), text('t1', { storyId: 'st-a' })],
      stories: { 'st-a': { blocks: [{ kind: 'paragraph', text: 'The article' }] } },
      swatches: [{ id: 'sw-1', name: 'Deep sea', color: '#123456' }]
    })
    const out = unwrapDesignSnippet(wrapDesignSnippet(body))
    expect(out.kind).toBe('design')
    expect(out.elements.map((e) => (e as { id: string }).id)).toEqual(['s1', 't1'])
    expect(out.stories).toEqual(body.stories)
    expect(out.swatches).toEqual(body.swatches)
  })

  it('does NOT carry the wrapper’s furniture back into the snippet', () => {
    const doc = wrapDesignSnippet(snippet())
    const edited = { ...doc, margins: { top: 40, right: 40, bottom: 40, left: 40 }, columns: { count: 3, gutter: 18 }, guides: { v: [10], h: [20] } }
    const out = unwrapDesignSnippet(edited) as Record<string, unknown>
    // A snippet that quietly grew a margins box would change how it inserts
    // everywhere it is used.
    expect(out.margins).toBeUndefined()
    expect(out.columns).toBeUndefined()
    expect(out.guides).toBeUndefined()
    expect(out.width).toBeUndefined()
  })

  it('drops a story whose frames were deleted during the session', () => {
    const doc = wrapDesignSnippet(
      snippet({
        elements: [text('t1', { storyId: 'st-a' })],
        // Both stories need real blocks: normalizeDesignBody drops an EMPTY
        // story on the way in, so an empty 'st-a' would have been gone before
        // unwrap ever saw it — which is what the first run of this test
        // actually proved.
        stories: {
          'st-a': { blocks: [{ kind: 'paragraph', text: 'kept' }] },
          'st-gone': { blocks: [{ kind: 'paragraph', text: 'orphan' }] }
        }
      })
    )
    const out = unwrapDesignSnippet(doc)
    expect(Object.keys(out.stories ?? {})).toEqual(['st-a'])
  })

  it('keeps a swatch a fill names, and a locked brand colour even when unused', () => {
    const doc = wrapDesignSnippet(
      snippet({
        elements: [shape('s1', { fill: { type: 'solid', color: '#123456', swatchId: 'sw-1' } })],
        swatches: [
          { id: 'sw-1', name: 'Deep sea', color: '#123456' },
          { id: 'sw-brand', name: 'Brand', color: '#6d5dfc', locked: true },
          { id: 'sw-unused', name: 'Spare', color: '#ff0000' }
        ]
      })
    )
    const out = unwrapDesignSnippet(doc)
    expect(out.swatches?.map((s) => (s as { id: string }).id)).toEqual(['sw-1', 'sw-brand'])
  })

  it('keeps an element added during the session, which is the point of editing', () => {
    const doc = wrapDesignSnippet(snippet())
    const added = { ...doc, pages: [{ ...doc.pages![0]!, elements: [...doc.pages![0]!.elements, shape('s2') as never] }] }
    const out = unwrapDesignSnippet(added)
    expect(out.elements).toHaveLength(3)
  })
})
