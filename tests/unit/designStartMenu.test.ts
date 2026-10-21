// @vitest-environment node
// The Design "Start from" menu: what it offers, and the custom size form.
//
// The grid this replaces drew a PUBLICATION heading with nothing under it,
// because it rendered one heading per category whether or not any template
// matched — and there has never been a publication TEMPLATE, only publication
// sizes. Building groups from their real contents is the fix, so the first
// test here is that no group is empty.
import { describe, it, expect } from 'vitest'
import {
  customDesignSize,
  describeSize,
  fromPx,
  startMenuGroups,
  toPx
} from '../../src/shared/designStartMenu'
import { DESIGN_SIZES, DESIGN_TEMPLATES } from '../../src/shared/design'

describe('the menu', () => {
  const groups = startMenuGroups()

  it('has no empty group, which is the bug in the panel it replaces', () => {
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) expect(g.entries.length, `${g.label} is empty`).toBeGreaterThan(0)
  })

  it('still offers publication, from its sizes rather than its templates', () => {
    const pub = groups.find((g) => g.id === 'publication')
    expect(pub, 'publication is offered').toBeTruthy()
    // It has no templates at all — that is why the old heading was bare.
    expect(DESIGN_TEMPLATES.some((t) => t.category === 'publication')).toBe(false)
    expect(pub?.entries.every((e) => e.kind === 'size')).toBe(true)
    expect(pub?.entries.some((e) => e.label === 'A4 portrait')).toBe(true)
  })

  it('offers every template, each carrying the size it produces', () => {
    const templates = groups.flatMap((g) => g.entries.filter((e) => e.kind === 'template'))
    expect(templates).toHaveLength(DESIGN_TEMPLATES.length)
    for (const t of templates) {
      expect(t.w, `${t.label} has a width`).toBeGreaterThan(0)
      expect(t.h, `${t.label} has a height`).toBeGreaterThan(0)
    }
    const quote = templates.find((t) => t.id === 'social-quote')
    expect(quote && describeSize(quote.w, quote.h)).toBe('1080 × 1080')
  })

  it('puts templates before sizes within a group', () => {
    for (const g of groups) {
      const kinds = g.entries.map((e) => e.kind)
      expect(kinds.slice().sort((a, b) => (a === 'template' ? -1 : 1) - (b === 'template' ? -1 : 1))).toEqual(kinds)
    }
  })

  it('offers a size AND a template of the same dimensions, because they differ', () => {
    // "Event flyer" and "Poster (A4)" are both 794×1123. Dropping the size as
    // a duplicate — which I did at first — left no way to ask for a blank A4
    // poster from the group it belongs to.
    const marketing = groups.find((g) => g.id === 'marketing')
    expect(marketing?.entries.some((e) => e.kind === 'template' && e.w === 794 && e.h === 1123)).toBe(true)
    expect(marketing?.entries.some((e) => e.kind === 'size' && e.id === 'poster-a4')).toBe(true)
  })

  it('does not repeat a plain size within a group', () => {
    for (const g of groups) {
      const keys = g.entries.filter((e) => e.kind === 'size').map((s) => `${s.w}x${s.h}:${s.label}`)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('names every size that exists, by its own id', () => {
    const offered = new Set(groups.flatMap((g) => g.entries.filter((e) => e.kind === 'size').map((e) => e.id)))
    for (const s of DESIGN_SIZES) expect(offered.has(s.id), `${s.label} is reachable by name`).toBe(true)
  })
})

describe('units', () => {
  it('converts at 96 to the inch, the same as the rest of the suite', () => {
    expect(toPx(1, 'in')).toBe(96)
    expect(toPx(25.4, 'mm')).toBe(96)
    expect(toPx(300, 'px')).toBe(300)
  })

  it('round-trips closely enough to show back what was typed', () => {
    expect(fromPx(96, 'in')).toBe(1)
    expect(fromPx(96, 'mm')).toBe(25.4)
    expect(fromPx(300.4, 'px')).toBe(300)
  })

  it('refuses nonsense rather than returning zero', () => {
    expect(toPx(0, 'mm')).toBe(0)
    expect(toPx(-5, 'in')).toBe(0)
    expect(toPx(Number.NaN, 'px')).toBe(0)
  })
})

describe('a custom size', () => {
  it('becomes a usable DesignSize', () => {
    const s = customDesignSize({ w: 210, h: 297, unit: 'mm' })
    expect(s).toMatchObject({ w: 794, h: 1123 })
    expect(s?.label).toBe('Custom 794 × 1123')
  })

  it('honours orientation, whichever way round the numbers were typed', () => {
    expect(customDesignSize({ w: 210, h: 297, unit: 'mm', orientation: 'landscape' })).toMatchObject({ w: 1123, h: 794 })
    expect(customDesignSize({ w: 297, h: 210, unit: 'mm', orientation: 'portrait' })).toMatchObject({ w: 794, h: 1123 })
    // Already the asked-for way round: left alone.
    expect(customDesignSize({ w: 1000, h: 500, unit: 'px', orientation: 'landscape' })).toMatchObject({ w: 1000, h: 500 })
  })

  it('refuses a page nothing could be laid out on, or printed', () => {
    expect(customDesignSize({ w: 4, h: 400, unit: 'px' })).toBeNull()
    expect(customDesignSize({ w: 0, h: 0, unit: 'in' })).toBeNull()
    expect(customDesignSize({ w: 1000, h: 99999, unit: 'px' })).toBeNull()
    expect(customDesignSize({ w: Number.NaN, h: 100, unit: 'px' })).toBeNull()
  })
})
