import { describe, it, expect } from 'vitest'
import {
  BASE_LAYER_ID,
  blankPublication,
  columnBoxes,
  defaultMargins,
  designLayers,
  designToHtml,
  designToHtmlAllPages,
  elementLocked,
  elementVisible,
  findDesignSize,
  marginBox,
  masterForPage,
  normalizeDesignBody,
  pageElementsHtml,
  pageNumberOf,
  resolveMasterElements,
  snapTargets,
  spreadsOf,
  storyFrames,
  storyIds,
  wrapObstacles,
  type DesignBody
} from '../../src/shared/design'
import { resizeDesign } from '../../src/shared/design'
import type { SlideElement, SlideTextElement } from '../../src/shared/types'

function text(id: string, str: string, extra: Partial<SlideTextElement> = {}): SlideTextElement {
  return { id, type: 'text', x: 0, y: 0, w: 100, h: 40, z: 1, paragraphs: [{ runs: [{ text: str }] }], ...extra }
}
function shape(id: string, x: number, y: number, w: number, h: number, extra: Partial<SlideElement> = {}): SlideElement {
  return { id, type: 'shape', shape: 'rect', x, y, w, h, z: 1, fill: { type: 'solid', color: '#000' }, ...extra } as SlideElement
}

describe('design — publication documents', () => {
  it('a blank publication has margins, a master, a layer and the right page count', () => {
    const d = blankPublication(findDesignSize('a4-portrait')!, 4)
    expect(d.pages).toHaveLength(4)
    expect(d.width).toBe(794)
    expect(d.masters).toHaveLength(1)
    expect(d.layers).toHaveLength(1)
    expect(d.margins!.top).toBeGreaterThan(0)
  })

  it('default margins scale with the short edge', () => {
    expect(defaultMargins(800, 1000)).toEqual({ top: 60, right: 60, bottom: 60, left: 60 })
  })

  it('publication sizes exist and are all portrait-or-landscape page shapes', () => {
    const pubs = ['a4-portrait', 'letter-portrait', 'a5-booklet', 'tri-fold']
    for (const id of pubs) expect(findDesignSize(id)?.category).toBe('publication')
  })
})

describe('design — masters', () => {
  const base: DesignBody = {
    ...blankPublication(findDesignSize('a4-portrait')!, 3),
    masters: [
      { id: 'mA', name: 'Master A', elements: [text('m1', 'Page {#} of {pages}')] },
      { id: 'mB', name: 'Master B', elements: [text('m2', 'B')] }
    ]
  }

  it('a page with no masterId inherits the first master', () => {
    expect(masterForPage(base, base.pages![0])!.id).toBe('mA')
  })

  it('an explicit masterId wins', () => {
    const pg = { ...base.pages![0], masterId: 'mB' }
    expect(masterForPage(base, pg)!.id).toBe('mB')
  })

  it('an explicit null detaches the page — distinct from "not set"', () => {
    const pg = { ...base.pages![0], masterId: null }
    expect(masterForPage(base, pg)).toBeNull()
  })

  it('a document with no masters returns null rather than throwing', () => {
    expect(masterForPage({ ...base, masters: [] }, base.pages![0])).toBeNull()
  })

  it('page-number tokens resolve per page', () => {
    const els = resolveMasterElements(base.masters![0], { page: 2, pages: 3 })
    expect((els[0] as SlideTextElement).paragraphs[0].runs[0].text).toBe('Page 2 of 3')
  })

  it('an untokenised master element is returned untouched, not copied', () => {
    const master = { id: 'm', name: 'M', elements: [text('t', 'no tokens here')] }
    expect(resolveMasterElements(master, { page: 1, pages: 1 })[0]).toBe(master.elements[0])
  })

  it('page numbering can start at something other than 1', () => {
    expect(pageNumberOf({ ...base, pageNumberStart: 5 }, 2)).toBe(7)
    expect(pageNumberOf(base, 0)).toBe(1)
  })
})

describe('design — layers', () => {
  const d: DesignBody = {
    ...blankPublication(findDesignSize('a4-portrait')!, 1),
    layers: [
      { id: BASE_LAYER_ID, name: 'Base', visible: true, locked: false },
      { id: 'lyr-2', name: 'Hidden', visible: false, locked: false },
      { id: 'lyr-3', name: 'Locked', visible: true, locked: true }
    ]
  }

  it('a document with no layers reports one implicit base layer', () => {
    expect(designLayers({ ...d, layers: [] })).toHaveLength(1)
    expect(designLayers({ ...d, layers: [] })[0].id).toBe(BASE_LAYER_ID)
  })

  it('an element with no layerId belongs to the base layer', () => {
    expect(elementVisible(d, shape('a', 0, 0, 10, 10))).toBe(true)
    expect(elementLocked(d, shape('a', 0, 0, 10, 10))).toBe(false)
  })

  it('visibility and lock follow the element’s layer', () => {
    expect(elementVisible(d, shape('a', 0, 0, 10, 10, { layerId: 'lyr-2' }))).toBe(false)
    expect(elementLocked(d, shape('a', 0, 0, 10, 10, { layerId: 'lyr-3' }))).toBe(true)
  })

  it('an element on a layer that no longer exists stays visible rather than vanishing', () => {
    expect(elementVisible(d, shape('a', 0, 0, 10, 10, { layerId: 'gone' }))).toBe(true)
  })
})

describe('design — margins, columns and snapping', () => {
  const d = blankPublication(findDesignSize('letter-portrait')!, 1)

  it('the margin box is the page inset by the margins', () => {
    const m = d.margins!
    expect(marginBox(d)).toEqual({ x: m.left, y: m.top, w: d.width - m.left - m.right, h: d.height - m.top - m.bottom })
  })

  it('no margins means the whole page', () => {
    expect(marginBox({ ...d, margins: undefined })).toEqual({ x: 0, y: 0, w: d.width, h: d.height })
  })

  it('one column is just the margin box', () => {
    expect(columnBoxes(d)).toEqual([marginBox(d)])
  })

  it('three columns split the margin box with gutters and cover it exactly', () => {
    const three = { ...d, columns: { count: 3, gutter: 20 } }
    const cols = columnBoxes(three)
    expect(cols).toHaveLength(3)
    const box = marginBox(three)
    expect(cols[0].x).toBeCloseTo(box.x, 6)
    expect(cols[2].x + cols[2].w).toBeCloseTo(box.x + box.w, 6)
    expect(cols[1].x - (cols[0].x + cols[0].w)).toBeCloseTo(20, 6)
  })

  it('a gutter wider than the box falls back to one column instead of negative widths', () => {
    const silly = { ...d, columns: { count: 4, gutter: 10000 } }
    expect(columnBoxes(silly)).toEqual([marginBox(silly)])
  })

  it('snap targets include page edges, centre, margins, columns and guides', () => {
    const withGuides = { ...d, columns: { count: 2, gutter: 16 }, guides: { v: [123], h: [456] } }
    const t = snapTargets(withGuides)
    expect(t.xs).toContain(0)
    expect(t.xs).toContain(d.width / 2)
    expect(t.xs).toContain(123)
    expect(t.ys).toContain(456)
    expect(t.ys).toContain(d.margins!.top)
  })
})

describe('design — spreads', () => {
  const d = (pages: number, facing: boolean): DesignBody => ({ ...blankPublication(findDesignSize('a5-booklet')!, pages), facing })

  it('a single-sided document is one page per spread', () => {
    expect(spreadsOf(d(3, false))).toEqual([[0], [1], [2]])
  })

  it('facing pages put the cover alone, then pair up', () => {
    expect(spreadsOf(d(5, true))).toEqual([[0], [1, 2], [3, 4]])
  })

  it('an odd trailing page stands alone', () => {
    expect(spreadsOf(d(4, true))).toEqual([[0], [1, 2], [3]])
  })

  it('a one-page facing document is just the cover', () => {
    expect(spreadsOf(d(1, true))).toEqual([[0]])
  })
})

describe('design — stories and wrap', () => {
  function withStory(): DesignBody {
    const d = blankPublication(findDesignSize('a4-portrait')!, 2)
    d.pages![0].elements = [text('f2', '', { storyId: 's1', storyOrder: 2 }), text('f1', '', { storyId: 's1', storyOrder: 1 })]
    d.pages![1].elements = [text('f3', '', { storyId: 's1', storyOrder: 3 }), text('other', 'plain')]
    return d
  }

  it('story frames come back in thread order across pages', () => {
    expect(storyFrames(withStory(), 's1').map((f) => f.element.id)).toEqual(['f1', 'f2', 'f3'])
  })

  it('frames with no explicit order fall back to page order rather than disappearing', () => {
    const d = withStory()
    d.pages![0].elements = [text('a', '', { storyId: 's1' }), text('b', '', { storyId: 's1' })]
    d.pages![1].elements = [text('c', '', { storyId: 's1' })]
    expect(storyFrames(d, 's1').map((f) => f.element.id)).toEqual(['a', 'b', 'c'])
  })

  it('storyIds lists every distinct story once', () => {
    expect(storyIds(withStory())).toEqual(['s1'])
  })

  it('wrap obstacles are only elements set to wrap', () => {
    const page = {
      id: 'p',
      elements: [
        shape('a', 10, 20, 30, 40, { wrap: { mode: 'square', offset: 6 } }),
        shape('b', 0, 0, 10, 10),
        shape('c', 0, 0, 10, 10, { wrap: { mode: 'none' } })
      ]
    }
    const obs = wrapObstacles(page)
    expect(obs).toHaveLength(1)
    expect(obs[0]).toEqual({ x: 10, y: 20, w: 30, h: 40, offset: 6 })
  })

  it('a frame never wraps around itself', () => {
    const page = { id: 'p', elements: [shape('self', 0, 0, 10, 10, { wrap: { mode: 'square' } })] }
    expect(wrapObstacles(page, ['self'])).toHaveLength(0)
  })
})

describe('design — rendering with masters', () => {
  function doc(): DesignBody {
    const d = blankPublication(findDesignSize('a4-portrait')!, 2)
    d.masters = [{ id: 'mA', name: 'A', elements: [text('folio', 'Page {#}', { z: 0 })] }]
    d.pages![0].elements = [text('body0', 'first page body', { z: 5 })]
    d.pages![1].elements = [text('body1', 'second page body', { z: 5 })]
    return d
  }

  it('a page renders its master furniture and its own elements', () => {
    const html = pageElementsHtml(doc(), 1)
    expect(html).toContain('Page 2')
    expect(html).toContain('second page body')
  })

  it('master furniture is emitted BEFORE the page content, so it sits underneath', () => {
    const html = pageElementsHtml(doc(), 0)
    expect(html.indexOf('Page 1')).toBeLessThan(html.indexOf('first page body'))
  })

  it('a detached page shows no master furniture', () => {
    const d = doc()
    d.pages![0].masterId = null
    expect(pageElementsHtml(d, 0)).not.toContain('Page 1')
  })

  it('elements on a hidden layer are left out of the export', () => {
    const d = doc()
    d.layers = [{ id: 'hidden', name: 'H', visible: false, locked: false }]
    d.pages![0].elements = [text('body0', 'first page body', { layerId: 'hidden' })]
    expect(pageElementsHtml(d, 0)).not.toContain('first page body')
  })

  it('the multi-page export gives every page its own resolved folio', () => {
    const html = designToHtmlAllPages(doc())
    expect(html).toContain('Page 1')
    expect(html).toContain('Page 2')
  })

  it('single-page export renders the ACTIVE page, not always the first', () => {
    const d = doc()
    d.activePage = 1
    expect(designToHtml(d)).toContain('second page body')
    expect(designToHtml(d)).not.toContain('first page body')
  })
})

describe('design — flowed text rendering', () => {
  it('a threaded frame renders its flowed lines at their measured positions', () => {
    const d = blankPublication(findDesignSize('a4-portrait')!, 1)
    d.pages![0].elements = [
      text('f1', '', {
        storyId: 's1',
        flowLines: [
          { x: 0, y: 0, w: 200, text: 'first line', lastOfPara: false, size: 14, lh: 21, align: 'left' },
          { x: 12, y: 21, w: 180, text: 'second line', lastOfPara: true, size: 14, lh: 21, align: 'left' }
        ]
      })
    ]
    const html = pageElementsHtml(d, 0)
    expect(html).toContain('first line')
    expect(html).toContain('second line')
    expect(html).toContain('left:12px')
    expect(html).toContain('top:21px')
  })

  it('justified text justifies every line but the paragraph’s last', () => {
    const d = blankPublication(findDesignSize('a4-portrait')!, 1)
    d.pages![0].elements = [
      text('f1', '', {
        storyId: 's1',
        flowLines: [
          { x: 0, y: 0, w: 200, text: 'aaa', lastOfPara: false, size: 12, lh: 18, align: 'justify' },
          { x: 0, y: 20, w: 200, text: 'bbb', lastOfPara: true, size: 12, lh: 18, align: 'justify' }
        ]
      })
    ]
    const html = pageElementsHtml(d, 0)
    // Each flowed line is its own positioned div; take the style block that
    // immediately precedes each line's text.
    const styleBefore = (needle: string): string => {
      const at = html.indexOf(needle)
      return html.slice(Math.max(0, html.lastIndexOf('<div style="', at)), at)
    }
    expect(styleBefore('aaa')).toContain('text-align-last:justify')
    expect(styleBefore('bbb')).not.toContain('text-align-last:justify')
  })

  it('flowed text is escaped, never injected', () => {
    const d = blankPublication(findDesignSize('a4-portrait')!, 1)
    d.pages![0].elements = [
      text('f1', '', { storyId: 's1', flowLines: [{ x: 0, y: 0, w: 100, text: '<img onerror=x>', lastOfPara: true, size: 12, lh: 18, align: 'left' }] })
    ]
    const html = pageElementsHtml(d, 0)
    expect(html).not.toContain('<img onerror')
    expect(html).toContain('&lt;img onerror=x&gt;')
  })
})

describe('design — normalisation of layout state', () => {
  it('a legacy single-page body still opens, with no layout state invented', () => {
    const d = normalizeDesignBody({ width: 800, height: 600, elements: [] })
    expect(d.pages).toHaveLength(1)
    expect(d.masters).toBeUndefined()
    expect(d.margins).toBeUndefined()
    expect(d.layers).toBeUndefined()
  })

  it('layout state survives a JSON round trip', () => {
    const src = blankPublication(findDesignSize('a4-portrait')!, 3)
    src.guides = { v: [10, 20], h: [30] }
    src.facing = true
    src.stories = { s1: { blocks: [{ kind: 'paragraph', text: 'hello' }] } }
    src.pages![1].masterId = null
    const out = normalizeDesignBody(JSON.parse(JSON.stringify(src)))
    expect(out.pages).toHaveLength(3)
    expect(out.guides).toEqual({ v: [10, 20], h: [30] })
    expect(out.facing).toBe(true)
    expect(out.stories!.s1.blocks).toEqual([{ kind: 'paragraph', text: 'hello' }])
    expect(out.masters).toHaveLength(1)
    expect(out.pages![1].masterId).toBeNull()
  })

  it('malformed guides and columns are dropped rather than crashing the page', () => {
    const out = normalizeDesignBody({ guides: { v: ['x', 5], h: null }, columns: { count: -3, gutter: 'wide' } })
    expect(out.guides).toEqual({ v: [5], h: [] })
    expect(out.columns).toEqual({ count: 1, gutter: 16 })
  })

  it('master-editing mode never survives a reload', () => {
    const out = normalizeDesignBody({ editingMasterId: 'mA', masters: [{ id: 'mA', name: 'A', elements: [] }] })
    expect(out.editingMasterId).toBeNull()
  })

  it('a legacy string story is migrated into blocks rather than discarded', () => {
    const out = normalizeDesignBody({ stories: { old: 'A paragraph.\n\nAnd another.' } })
    expect(out.stories!.old.blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph'])
  })

  it('a story value that is neither a string nor real blocks is dropped', () => {
    const out = normalizeDesignBody({ stories: { good: 'text', bad: 42, empty: { blocks: [] }, junk: { blocks: 'no' } } })
    expect(Object.keys(out.stories ?? {})).toEqual(['good'])
  })
})

describe('design — resizing a multi-page document', () => {
  function brochure(): DesignBody {
    const d = blankPublication(findDesignSize('a4-portrait')!, 3)
    d.masters = [{ id: 'mA', name: 'A', elements: [shape('folio', 100, 1000, 200, 40)] }]
    d.guides = { v: [397], h: [561] }
    d.pages![0].elements = [shape('p0', 0, 0, 100, 100)]
    d.pages![1].elements = [shape('p1', 100, 200, 100, 100)]
    d.pages![2].elements = [shape('p2', 50, 50, 100, 100)]
    return d
  }

  it('scales EVERY page, not just the one on screen', () => {
    const src = brochure()
    // Double the width, keep the height, so the factors are easy to read.
    const out = resizeDesign(src, { id: 'x', category: 'publication', label: 'x', w: src.width * 2, h: src.height })
    const at = (i: number): SlideElement => out.pages![i].elements[0]
    expect(at(0).w).toBe(200)
    expect(at(1).x).toBe(200)
    expect(at(2).x).toBe(100)
  })

  it('scales master furniture too, so a folio stays where it belongs', () => {
    const src = brochure()
    const out = resizeDesign(src, { id: 'x', category: 'publication', label: 'x', w: src.width * 2, h: src.height })
    expect(out.masters![0].elements[0].x).toBe(200)
    expect(out.masters![0].elements[0].w).toBe(400)
  })

  it('scales margins, gutters and guides', () => {
    const src = brochure()
    const before = src.margins!.left
    const out = resizeDesign(src, { id: 'x', category: 'publication', label: 'x', w: src.width * 2, h: src.height })
    expect(out.margins!.left).toBe(before * 2)
    expect(out.margins!.top).toBe(src.margins!.top)
    expect(out.guides!.v[0]).toBe(src.guides!.v[0] * 2)
    expect(out.guides!.h[0]).toBe(src.guides!.h[0])
  })

  it('the top-level element mirror follows the active page', () => {
    const src = brochure()
    src.activePage = 2
    const out = resizeDesign(src, { id: 'x', category: 'publication', label: 'x', w: src.width * 2, h: src.height })
    expect(out.elements).toBe(out.pages![2].elements)
  })

  it('stale flow lines are dropped rather than scaled into a lie', () => {
    const src = brochure()
    src.pages![0].elements = [
      text('f', '', { storyId: 's1', flowLines: [{ x: 0, y: 0, w: 100, text: 'measured for the old size', lastOfPara: true }] })
    ]
    const out = resizeDesign(src, { id: 'x', category: 'publication', label: 'x', w: src.width * 2, h: src.height })
    expect((out.pages![0].elements[0] as SlideTextElement).flowLines).toBeUndefined()
  })

  it('a plain single-page design still resizes exactly as it always did', () => {
    const d = normalizeDesignBody({ width: 100, height: 100, elements: [shape('a', 10, 10, 20, 20)] })
    const out = resizeDesign(d, { id: 'x', category: 'social', label: 'x', w: 200, h: 200 })
    expect(out.elements[0]).toMatchObject({ x: 20, y: 20, w: 40, h: 40 })
  })
})
