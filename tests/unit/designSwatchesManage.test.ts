// @vitest-environment node
// Managing the palette: the operations the swatches panel calls. The engine
// (tested in designSwatches.test.ts) already knew how to tint a colour and
// carry an edit through every reference; what was missing was adding,
// deleting and applying — and the dangerous one is deleting, because a
// person's artwork must not change colour when a NAME goes away.
import { describe, it, expect } from 'vitest'
import {
  addSwatch,
  assignSwatchTo,
  deleteSwatch,
  resolveFillColor,
  spotInks,
  swatchId,
  swatchUsage,
  tintedColor
} from '../../src/shared/designSwatches'
import type { DesignBody } from '../../src/shared/design'
import type { SlideElement } from '../../src/shared/types'

const rect = (id: string, fill?: { type: string; color?: string; swatchId?: string; tint?: number }): SlideElement =>
  ({ id, type: 'rect', x: 0, y: 0, w: 10, h: 10, z: 1, ...(fill ? { fill } : {}) }) as unknown as SlideElement

function body(els: SlideElement[], swatches?: DesignBody['swatches']): DesignBody {
  return {
    schemaVersion: 1,
    width: 100,
    height: 100,
    elements: els,
    pages: [{ id: 'p1', elements: els }],
    activePage: 0,
    ...(swatches ? { swatches } : {})
  } as unknown as DesignBody
}

const PALETTE = [
  { id: 'brand-primary', name: 'Brand primary', color: '#2563eb', locked: true },
  { id: 'ink', name: 'Ink', color: '#1c1917' }
]

describe('ids', () => {
  it('read as the name and never collide', () => {
    expect(swatchId('Pantone 286 C', [])).toBe('pantone-286-c')
    expect(swatchId('Ink', ['ink'])).toBe('ink-2')
    expect(swatchId('', [])).toBe('swatch')
  })
})

describe('adding', () => {
  it('gives a document with no palette the default one first', () => {
    // Otherwise someone's first swatch leaves them with a palette of one.
    const { body: next, id } = addSwatch(body([rect('a')]), { name: 'Highlight', color: '#ff0000' })
    expect(id).toBe('highlight')
    const ids = (next.swatches ?? []).map((s) => s.id)
    expect(ids).toContain('black')
    expect(ids).toContain('highlight')
    expect(ids.length).toBeGreaterThan(4)
  })

  it('records a spot ink with the name a printer is told', () => {
    const { body: next, id } = addSwatch(body([], PALETTE), {
      name: 'Pantone 286',
      color: '#0033a0',
      spot: { inkName: 'Pantone 286 C' }
    })
    expect((next.swatches ?? []).find((s) => s.id === id)?.spot).toEqual({ inkName: 'Pantone 286 C' })
  })

  it('does not record an empty ink name as a spot', () => {
    const { body: next, id } = addSwatch(body([], PALETTE), { name: 'Flat', color: '#111111', spot: { inkName: '  ' } })
    expect((next.swatches ?? []).find((s) => s.id === id)?.spot).toBeUndefined()
  })
})

describe('applying to elements', () => {
  it('points the fill at the swatch and caches the resolved colour', () => {
    const next = assignSwatchTo(body([rect('a', { type: 'solid', color: '#ffffff' })], PALETTE), ['a'], 'ink')
    const fill = (next.elements[0] as { fill?: { swatchId?: string; color?: string } }).fill
    expect(fill?.swatchId).toBe('ink')
    expect(fill?.color).toBe('#1c1917')
    expect(swatchUsage(next, 'ink')).toEqual(['a'])
  })

  it('tints toward white, which is what tinting an ink on paper does', () => {
    const next = assignSwatchTo(body([rect('a', { type: 'solid', color: '#ffffff' })], PALETTE), ['a'], 'ink', 20)
    const fill = (next.elements[0] as { fill?: { color?: string; tint?: number } }).fill
    expect(fill?.tint).toBe(20)
    expect(fill?.color).toBe(tintedColor('#1c1917', 20))
    // Pale, not dark: the tint is mixed with white.
    expect(fill?.color).not.toBe('#1c1917')
  })

  it('leaves an element with no fill alone, rather than inventing one', () => {
    // A text frame or a line has no fill; giving it one puts a box behind the
    // words.
    const b = body([rect('text-ish'), rect('b', { type: 'none' })], PALETTE)
    const next = assignSwatchTo(b, ['text-ish', 'b'], 'ink')
    expect(next).toBe(b)
  })

  it('returns the same body when nothing changes, so the canvas does not re-render', () => {
    const b = assignSwatchTo(body([rect('a', { type: 'solid', color: '#fff' })], PALETTE), ['a'], 'ink')
    expect(assignSwatchTo(b, ['a'], 'ink')).toBe(b)
  })

  it('keeps the active page mirroring the top-level elements', () => {
    // pages[active].elements and body.elements are the same array by design;
    // an edit that breaks that makes the canvas and the saved page disagree.
    const next = assignSwatchTo(body([rect('a', { type: 'solid', color: '#fff' })], PALETTE), ['a'], 'ink')
    expect(next.pages?.[0].elements).toEqual(next.elements)
  })
})

describe('deleting', () => {
  const used = (): DesignBody =>
    assignSwatchTo(body([rect('a', { type: 'solid', color: '#ffffff' })], PALETTE), ['a'], 'ink', 40)

  it('never changes the artwork: the fill keeps its colour and loses the link', () => {
    const before = used()
    const colourBefore = (before.elements[0] as { fill?: { color?: string } }).fill?.color
    const after = deleteSwatch(before, 'ink')
    const fill = (after.elements[0] as { fill?: { color?: string; swatchId?: string; tint?: number } }).fill
    expect(fill?.color).toBe(colourBefore)
    expect(fill?.swatchId).toBeUndefined()
    expect(fill?.tint).toBeUndefined()
    expect((after.swatches ?? []).some((s) => s.id === 'ink')).toBe(false)
  })

  it('refuses a locked brand colour', () => {
    const b = used()
    expect(deleteSwatch(b, 'brand-primary')).toBe(b)
  })

  it('is a no-op for a swatch that is not there', () => {
    const b = used()
    expect(deleteSwatch(b, 'ghost')).toBe(b)
  })

  it('leaves a resolvable colour behind for anything still drawing it', () => {
    const after = deleteSwatch(used(), 'ink')
    const fill = (after.elements[0] as { fill?: { color?: string } }).fill
    expect(resolveFillColor(after, fill as never)).toBe(tintedColor('#1c1917', 40))
  })
})

describe('spot inks', () => {
  it('are reported only once something actually uses them', () => {
    // A palette entry nobody has used is not a plate, and telling a printer
    // about it would cost real money.
    const { body: withSpot, id } = addSwatch(body([rect('a', { type: 'solid', color: '#fff' })], PALETTE), {
      name: 'Pantone 286',
      color: '#0033a0',
      spot: { inkName: 'Pantone 286 C' }
    })
    expect(spotInks(withSpot)).toEqual([])
    const applied = assignSwatchTo(withSpot, ['a'], id)
    expect(spotInks(applied).map((s) => s.spot?.inkName)).toEqual(['Pantone 286 C'])
  })

  it('stop being reported when the last use goes away', () => {
    const { body: withSpot, id } = addSwatch(body([rect('a', { type: 'solid', color: '#fff' })], PALETTE), {
      name: 'Spot',
      color: '#0033a0',
      spot: { inkName: 'Pantone 286 C' }
    })
    const applied = assignSwatchTo(withSpot, ['a'], id)
    expect(spotInks(deleteSwatch(applied, id))).toEqual([])
  })
})

describe('a fill always draws what its own swatch and tint resolve to', () => {
  // This is the invariant that was broken: applying a swatch at full strength
  // kept whatever tint the fill already had, so the cached colour (100%) and
  // the tint (20%) disagreed. Nothing looked wrong until something resolved
  // the pair later — deleting the swatch, or re-opening the file — and then
  // the artwork changed colour by itself.
  const palette = [
    { id: 'a', name: 'A', color: '#ff0000' },
    { id: 'b', name: 'B', color: '#0033a0' }
  ]

  it('clears a previous tint when applied at full strength', () => {
    const tinted = assignSwatchTo(body([rect('r', { type: 'solid', color: '#fff' })], palette), ['r'], 'a', 20)
    const full = assignSwatchTo(tinted, ['r'], 'b')
    const fill = (full.elements[0] as { fill?: { color?: string; tint?: number; swatchId?: string } }).fill
    expect(fill?.swatchId).toBe('b')
    expect(fill?.tint).toBeUndefined()
    expect(fill?.color).toBe('#0033a0')
    expect(resolveFillColor(full, fill as never)).toBe(fill?.color)
  })

  it('holds after every reassignment, so deleting the swatch cannot shift the colour', () => {
    let b = body([rect('r', { type: 'solid', color: '#fff' })], palette)
    for (const [id, tint] of [['a', 20], ['b', undefined], ['a', undefined], ['b', 60]] as const) {
      b = assignSwatchTo(b, ['r'], id, tint)
      const fill = (b.elements[0] as { fill?: { color?: string } }).fill
      // What is cached is what the pair resolves to, at every step.
      expect(resolveFillColor(b, fill as never)).toBe(fill?.color)
    }
    const before = (b.elements[0] as { fill?: { color?: string } }).fill?.color
    const after = deleteSwatch(b, 'b')
    expect((after.elements[0] as { fill?: { color?: string } }).fill?.color).toBe(before)
  })
})
