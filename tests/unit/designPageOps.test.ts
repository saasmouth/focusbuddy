// @vitest-environment node
// Adding a page to a design that has never had one.
//
// The owner reported "I can't see where to add the second page". Looking for
// the button found something worse behind it: a design starts with `elements`
// and no `pages` array — one page, implied — and every page EDIT worked on
// `pages ?? []`, which is empty. So adding a page built the new array out of
// nothing: one page, empty, and the artwork gone from both the page and the
// top level. These tests are that scenario, and they fail without withPages.
import { describe, it, expect } from 'vitest'
import { pageCountOf, spreadsOf, withPages, type DesignBody } from '../../src/shared/design'
import type { SlideElement } from '../../src/shared/types'

const rect: SlideElement = { id: 'r1', type: 'rect', x: 1, y: 2, w: 30, h: 40, z: 1 } as SlideElement

/** A design as the editor creates one: content, no pages array. */
const fresh = (): DesignBody =>
  ({
    schemaVersion: 1,
    width: 800,
    height: 600,
    elements: [rect],
    background: { type: 'solid', color: '#ffffff' }
  }) as unknown as DesignBody

/** What the editor does on every commit, with the fix in place. */
function syncActivePage(b: DesignBody): DesignBody {
  const base = withPages(b)
  const active = base.activePage ?? 0
  const pages = (base.pages ?? []).map((p, i) => (i === active ? { ...p, elements: b.elements, background: b.background } : p))
  return { ...base, pages }
}

/** What Add page does, through the same writer. */
function addPage(b: DesignBody): DesignBody {
  const saved = syncActivePage(b)
  const np = { id: 'pg-new', background: { type: 'solid' as const, color: '#ffffff' }, elements: [] as SlideElement[] }
  const nextPages = [...(saved.pages ?? []), np]
  return syncActivePage({
    ...saved,
    pages: nextPages,
    activePage: nextPages.length - 1,
    elements: np.elements,
    background: np.background
  })
}

describe('a design with no pages array', () => {
  it('already counts as one page everywhere that counts', () => {
    expect(pageCountOf(fresh())).toBe(1)
    expect(spreadsOf(fresh())).toEqual([[0]])
  })

  it('materialises that page with its content, rather than an empty one', () => {
    const out = withPages(fresh())
    expect(out.pages).toHaveLength(1)
    expect(out.pages?.[0].elements).toEqual([rect])
    expect(out.activePage).toBe(0)
  })

  it('is left alone once it has pages', () => {
    const already = withPages(fresh())
    expect(withPages(already)).toBe(already)
  })
})

describe('adding the second page', () => {
  it('keeps the first page’s artwork — the bug the owner would have hit', () => {
    const after = addPage(fresh())
    expect(after.pages).toHaveLength(2)
    expect(after.pages?.[0].elements).toEqual([rect])
    // And it is still somewhere in the document at all, which is the part that
    // failed before: the rect vanished from the page AND the top level.
    expect(JSON.stringify(after)).toContain('r1')
  })

  it('lands on the new page, which is empty', () => {
    const after = addPage(fresh())
    expect(after.activePage).toBe(1)
    expect(after.elements).toEqual([])
    expect(after.pages?.[1].elements).toEqual([])
  })

  it('keeps working for the third page and beyond', () => {
    const after = addPage(addPage(fresh()))
    expect(after.pages).toHaveLength(3)
    expect(after.pages?.[0].elements).toEqual([rect])
    expect(after.activePage).toBe(2)
  })

  it('does not disturb a design that already had pages', () => {
    const multi = {
      ...fresh(),
      pages: [
        { id: 'p1', elements: [rect] },
        { id: 'p2', elements: [] }
      ],
      activePage: 1,
      elements: []
    } as unknown as DesignBody
    const after = addPage(multi)
    expect(after.pages).toHaveLength(3)
    expect(after.pages?.[0].elements).toEqual([rect])
    expect(after.pages?.[0].id).toBe('p1')
  })
})
