// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  defaultSwatches, findSwatch, tintedColor, resolveFillColor, swatchUsage,
  applySwatchEdit, assignSwatch, detachSwatch, spotInks,
  type DesignSwatch
} from '../../src/shared/designSwatches'
import type { DesignBody } from '../../src/shared/design'
import type { SlideElement, SlideFill } from '../../src/shared/types'

// Built from the shipped types, not from the implementation. The advisor's
// contrast rule never fired for months because its fixtures copied the code's
// wrong field name, so these say `type: 'solid'` because SlideFill does.

const fill = (over: Record<string, unknown> = {}): SlideFill =>
  ({ type: 'solid', color: '#2563eb', ...over }) as SlideFill

const el = (id: string, f?: SlideFill): SlideElement =>
  ({ id, type: 'shape', x: 0, y: 0, w: 10, h: 10, z: 1, ...(f ? { fill: f } : {}) }) as SlideElement

const doc = (els: SlideElement[], swatches?: DesignSwatch[]): DesignBody =>
  ({ schemaVersion: 1, width: 100, height: 100, elements: els, ...(swatches ? { swatches } : {}) }) as DesignBody

const SW: DesignSwatch[] = [
  { id: 'brand', name: 'Brand', color: '#2563eb' },
  { id: 'spot1', name: 'Pantone-ish', color: '#aa0055', spot: { inkName: 'Pantone 226 C' } },
  { id: 'locked', name: 'Locked', color: '#123456', locked: true }
]

describe('tints', () => {
  it('mixes toward white, because that is what ink on paper does', () => {
    // A 20% tint of a dark blue is a PALE blue. Mixing toward transparent
    // would look similar on white paper and wrong on anything else.
    expect(tintedColor('#000000', 100)).toBe('#000000')
    expect(tintedColor('#000000', 0)).toBe('#ffffff')
    expect(tintedColor('#000000', 50)).toBe('#808080')
  })

  it('treats a missing tint as full strength', () => {
    expect(tintedColor('#2563eb')).toBe('#2563eb')
  })

  it('leaves a value it cannot parse alone', () => {
    expect(tintedColor('rebeccapurple', 50)).toBe('rebeccapurple')
  })

  it('clamps out-of-range tints instead of producing nonsense', () => {
    expect(tintedColor('#000000', -40)).toBe('#ffffff')
    expect(tintedColor('#000000', 400)).toBe('#000000')
  })
})

describe('resolving a fill', () => {
  const body = doc([], SW)

  it('prefers the swatch over a stale cached colour', () => {
    // The cached colour exists so old readers work. It must never win over
    // the swatch it claims to have come from.
    expect(resolveFillColor(body, fill({ color: '#ff0000', swatchId: 'brand' }))).toBe('#2563eb')
  })

  it('applies the tint', () => {
    expect(resolveFillColor(body, fill({ swatchId: 'brand', tint: 50 }))).toBe(tintedColor('#2563eb', 50))
  })

  it('falls back to the cached colour when the swatch is gone', () => {
    // A deleted swatch should leave the artwork looking the same, not turn
    // it black.
    expect(resolveFillColor(body, fill({ color: '#abcdef', swatchId: 'ghost' }))).toBe('#abcdef')
  })

  it('leaves a plain fill completely alone', () => {
    expect(resolveFillColor(body, fill({ color: '#112233' }))).toBe('#112233')
    expect(resolveFillColor(body, undefined)).toBeUndefined()
  })
})

describe('editing a swatch moves everything that uses it', () => {
  const body = doc(
    [
      el('a', fill({ swatchId: 'brand' })),
      el('b', fill({ swatchId: 'brand', tint: 50, color: tintedColor('#2563eb', 50) })),
      el('c', fill({ color: '#2563eb' })) // same colour, NOT linked
    ],
    SW
  )

  it('rewrites every linked fill, including tinted ones', () => {
    const next = applySwatchEdit(body, 'brand', { color: '#ff6600' })
    const colourOf = (b: DesignBody, id: string): string | undefined =>
      ((b.elements ?? []).find((e) => e.id === id) as { fill?: SlideFill })?.fill?.color
    expect(colourOf(next, 'a')).toBe('#ff6600')
    expect(colourOf(next, 'b')).toBe(tintedColor('#ff6600', 50))
  })

  it('leaves an unlinked element of the same colour alone', () => {
    // A swatch is a link, not a find-and-replace. Something that merely
    // happens to be the same blue must not move.
    const next = applySwatchEdit(body, 'brand', { color: '#ff6600' })
    const c = ((next.elements ?? []).find((e) => e.id === 'c') as { fill?: SlideFill })?.fill?.color
    expect(c).toBe('#2563eb')
  })

  it('refuses to edit a locked swatch', () => {
    // Brand colours come from the brand kit; a document quietly redefining
    // "Brand primary" is how a brand stops being one.
    expect(applySwatchEdit(body, 'locked', { color: '#000000' })).toBe(body)
  })

  it('returns the same body when nothing actually changes', () => {
    expect(applySwatchEdit(body, 'brand', { color: '#2563eb' })).toBe(body)
    expect(applySwatchEdit(body, 'nope', { color: '#000000' })).toBe(body)
  })

  it('does not mutate the original', () => {
    const snapshot = JSON.stringify(body)
    applySwatchEdit(body, 'brand', { color: '#ff6600' })
    expect(JSON.stringify(body)).toBe(snapshot)
  })

  it('reaches elements on every page of a multi-page document', () => {
    const multi = {
      schemaVersion: 1, width: 100, height: 100, elements: [], swatches: SW,
      pages: [
        { id: 'p1', elements: [el('x', fill({ swatchId: 'brand' }))] },
        { id: 'p2', elements: [el('y', fill({ swatchId: 'brand' }))] }
      ]
    } as unknown as DesignBody
    const next = applySwatchEdit(multi, 'brand', { color: '#00aa00' })
    for (const p of next.pages ?? [])
      for (const e of p.elements ?? [])
        expect((e as { fill?: SlideFill }).fill?.color).toBe('#00aa00')
  })
})

describe('attaching and detaching', () => {
  it('assign caches the resolved colour alongside the link', () => {
    const f = assignSwatch(fill({ color: '#000000' }), SW[0], 50)
    expect(f.swatchId).toBe('brand')
    expect(f.tint).toBe(50)
    expect(f.color).toBe(tintedColor('#2563eb', 50))
  })

  it('detach keeps the colour, so the artwork does not change', () => {
    const body = doc([], SW)
    const linked = assignSwatch(fill(), SW[0], 40)
    const plain = detachSwatch(body, linked)
    expect(plain.color).toBe(tintedColor('#2563eb', 40))
    expect((plain as { swatchId?: string }).swatchId).toBeUndefined()
    expect((plain as { tint?: number }).tint).toBeUndefined()
  })
})

describe('usage and spot inks', () => {
  it('lists what a swatch is used by, so a delete can warn', () => {
    const body = doc([el('a', fill({ swatchId: 'brand' })), el('b', fill())], SW)
    expect(swatchUsage(body, 'brand')).toEqual(['a'])
    expect(swatchUsage(body, 'spot1')).toEqual([])
  })

  it('reports only spot inks that are actually used', () => {
    // A printer is quoted per plate. An unused spot swatch sitting in the
    // palette must not add one.
    const unused = doc([el('a', fill({ swatchId: 'brand' }))], SW)
    expect(spotInks(unused)).toEqual([])
    const used = doc([el('a', fill({ swatchId: 'spot1' }))], SW)
    expect(spotInks(used).map((s) => s.spot?.inkName)).toEqual(['Pantone 226 C'])
  })
})

describe('the default palette', () => {
  it('starts from the brand kit and locks the brand colours', () => {
    const sw = defaultSwatches({ colorPrimary: '#ff0000', colorSecondary: '#00ff00', fontHeading: 'x', fontBody: 'y' })
    const brand = sw.find((s) => s.id === 'brand-primary')!
    expect(brand.color).toBe('#ff0000')
    expect(brand.locked).toBe(true)
    expect(sw.find((s) => s.id === 'brand-secondary')?.color).toBe('#00ff00')
  })

  it('omits brand roles the kit does not define, rather than inventing them', () => {
    const sw = defaultSwatches({ colorPrimary: '#ff0000', fontHeading: 'x', fontBody: 'y' })
    expect(sw.find((s) => s.id === 'brand-secondary')).toBeUndefined()
  })

  it('includes the basics a designer reaches for', () => {
    const ids = defaultSwatches().map((s) => s.id)
    for (const want of ['black', 'white', 'paper', 'ink']) expect(ids).toContain(want)
  })
})

describe('documents without swatches', () => {
  it('behave exactly as before', () => {
    const plain = doc([el('a', fill({ color: '#123456' }))])
    expect(plain.swatches).toBeUndefined()
    expect(resolveFillColor(plain, fill({ color: '#123456' }))).toBe('#123456')
    expect(swatchUsage(plain, 'anything')).toEqual([])
    expect(spotInks(plain)).toEqual([])
    expect(findSwatch(plain, 'anything')).toBeNull()
  })
})
