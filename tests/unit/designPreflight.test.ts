// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { preflight, preflightSummary, effectivePpi } from '../../src/shared/designPreflight'
import type { DesignBody } from '../../src/shared/design'
import type { SlideElement, SlideImageElement, SlideTextElement } from '../../src/shared/types'
import type { FlowLine } from '../../src/shared/designFlow'
import type { DesignSwatch } from '../../src/shared/designSwatches'

// Built from the shipped types. Preflight's only value is that you can act on
// it without re-checking, so a rule that fires wrongly is worse than no rule —
// every one is tested in both directions.

const img = (over: Partial<SlideImageElement> = {}): SlideElement =>
  ({ id: 'i1', type: 'image', x: 100, y: 100, w: 192, h: 192, z: 1, src: 'data:x', naturalW: 576, naturalH: 576, ...over }) as SlideElement

const line = (over: Partial<FlowLine> = {}): FlowLine =>
  ({ x: 0, y: 0, w: 100, text: 'x', lastOfPara: false, size: 16, lh: 20, align: 'left', para: 0, start: 0, end: 1, ...over })

const text = (over: Partial<SlideTextElement> = {}): SlideElement =>
  ({ id: 't1', type: 'text', x: 100, y: 100, w: 200, h: 100, z: 1, paragraphs: [], ...over }) as SlideElement

const doc = (els: SlideElement[], over: Partial<DesignBody> = {}): DesignBody =>
  ({ schemaVersion: 1, width: 816, height: 1056, elements: els, ...over }) as DesignBody

const rules = (b: DesignBody, o = {}): string[] => preflight(b, o).map((i) => i.rule)

describe('a document that is ready to print', () => {
  it('reports nothing', () => {
    // 576px natural in a 192px frame = 288 PPI... just under the 300 bar, so
    // use a frame that clears it.
    const clean = doc([img({ w: 144, h: 144 })])
    expect(preflight(clean)).toEqual([])
    expect(preflightSummary([])).toBe('Ready to print')
  })
})

describe('image resolution', () => {
  it('computes effective PPI from the natural size and the frame', () => {
    // 576 natural px across a 192px (2 inch) frame = 288 PPI.
    expect(effectivePpi(img({ w: 192, h: 192 }) as SlideImageElement)).toBeCloseTo(288, 0)
  })

  it('counts cropping against the resolution', () => {
    // Cropping throws pixels away, so the same frame gets fewer of them. This
    // is the commonest way a good photograph becomes an unprintable one.
    const cropped = img({ w: 192, h: 192, crop: { l: 0.25, t: 0.25, r: 0.25, b: 0.25 } }) as SlideImageElement
    expect(effectivePpi(cropped)).toBeCloseTo(144, 0)
  })

  it('counts a crop on ONE axis, not just a symmetric one', () => {
    // A symmetric crop is the easy case: both axes shrink, so Math.min gives
    // the right answer even if one of them is computed wrongly. A mutation
    // that ignored the horizontal crop entirely survived the symmetric test
    // for exactly that reason. Cropping only the sides is the case that
    // distinguishes them.
    const wide = img({ w: 192, h: 192, crop: { l: 0.5, t: 0, r: 0, b: 0 } }) as SlideImageElement
    expect(effectivePpi(wide)).toBeCloseTo(144, 0)
    const tall = img({ w: 192, h: 192, crop: { l: 0, t: 0.5, r: 0, b: 0 } }) as SlideImageElement
    expect(effectivePpi(tall)).toBeCloseTo(144, 0)
  })

  it('errors below the floor and warns below the usual bar', () => {
    expect(rules(doc([img({ w: 576, h: 576 })]))).toContain('image-low') // 96 PPI
    expect(rules(doc([img({ w: 288, h: 288 })]))).toContain('image-soft') // 192 PPI
    expect(rules(doc([img({ w: 144, h: 144 })]))).not.toContain('image-soft') // 384 PPI
  })

  it('says UNKNOWN rather than inventing a number', () => {
    // The honest answer when the natural size was never recorded. A fabricated
    // PPI is the one output here that could cost a print run.
    const r = preflight(doc([img({ naturalW: undefined, naturalH: undefined })]))
    expect(r.map((i) => i.rule)).toContain('image-unknown')
    expect(r.find((i) => i.rule === 'image-unknown')?.severity).toBe('info')
    expect(effectivePpi(img({ naturalW: undefined }) as SlideImageElement)).toBeNull()
  })

  it('reports an empty image frame as an error, not a resolution problem', () => {
    const r = rules(doc([img({ src: '' })]))
    expect(r).toContain('image-missing')
    expect(r).not.toContain('image-low')
  })
})

describe('hairlines', () => {
  it('warns about a rule too thin for a press', () => {
    // 0.25px is 0.1875pt, under the 0.25pt floor.
    expect(rules(doc([img({ border: { color: '#000', width: 0.25 } })]))).toContain('hairline')
  })

  it('leaves an ordinary rule alone', () => {
    expect(rules(doc([img({ w: 144, h: 144, border: { color: '#000', width: 1 } })]))).not.toContain('hairline')
  })
})

describe('type', () => {
  it('warns about text too small to print', () => {
    // 6px is 4.5pt.
    expect(rules(doc([text({ flowLines: [line({ size: 6 })] })]))).toContain('tiny-text')
  })

  it('leaves readable text alone', () => {
    expect(rules(doc([text({ flowLines: [line({ size: 12 })] })]))).not.toContain('tiny-text')
  })

  it('treats text that does not fit as an error — it will not print at all', () => {
    const r = preflight(doc([text({ oversetHere: true } as Partial<SlideTextElement>)]))
    expect(r.find((i) => i.rule === 'overset')?.severity).toBe('error')
  })
})

describe('trim safety', () => {
  it('warns when live content sits near the cut', () => {
    expect(rules(doc([img({ x: 2, y: 2, w: 100, h: 100 })]))).toContain('trim-safety')
  })

  it('does not scold a deliberate bleed', () => {
    // Something run fully off the edge of a bleeding document is intentional,
    // and warning about it is how a preflight panel gets ignored.
    const bled = doc([img({ x: -10, y: -10, w: 200, h: 200 })], { bleed: 18 })
    expect(rules(bled)).not.toContain('trim-safety')
  })

  it('leaves content well inside the page alone', () => {
    expect(rules(doc([img({ x: 200, y: 300, w: 144, h: 144 })]))).not.toContain('trim-safety')
  })
})

describe('bleed and inks', () => {
  it('notes a bleed set on a page with no background', () => {
    const r = preflight(doc([], { bleed: 18 }))
    expect(r.map((i) => i.rule)).toContain('bleed-empty')
  })

  it('says nothing when the page has a background to bleed', () => {
    const r = preflight(doc([], { bleed: 18, background: { type: 'solid', color: '#fff' } }))
    expect(r.map((i) => i.rule)).not.toContain('bleed-empty')
  })

  it('counts the spot inks a document actually uses, and names them', () => {
    const swatches: DesignSwatch[] = [
      { id: 's1', name: 'Pink', color: '#aa0055', spot: { inkName: 'Pantone 226 C' } },
      { id: 's2', name: 'Unused', color: '#00aa55', spot: { inkName: 'Pantone 354 C' } }
    ]
    const used = doc(
      [{ id: 'a', type: 'shape', shape: 'rect', x: 200, y: 300, w: 100, h: 100, z: 1, fill: { type: 'solid', color: '#aa0055', swatchId: 's1' } } as unknown as SlideElement],
      { swatches }
    )
    const item = preflight(used).find((i) => i.rule === 'spot-inks')
    expect(item?.title).toContain('Pantone 226 C')
    // The unused plate must not be charged for.
    expect(item?.title).not.toContain('354')
    expect(item?.title).toContain('1 spot ink')
  })
})

describe('the report', () => {
  const messy = doc([img({ w: 576, h: 576, x: 2, y: 2 }), text({ oversetHere: true, x: 300, y: 400 } as Partial<SlideTextElement>)])

  it('puts errors before warnings before notes', () => {
    const sev = preflight(messy).map((i) => i.severity)
    expect(sev).toEqual([...sev].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)))
  })

  it('is deterministic', () => {
    expect(preflight(messy)).toEqual(preflight(messy))
  })

  it('summarises for an export dialog', () => {
    expect(preflightSummary(preflight(messy))).toMatch(/error/)
  })

  it('checks every page of a multi-page document and says which', () => {
    const multi = doc([], {
      pages: [
        { id: 'p1', elements: [img({ id: 'a', w: 576, h: 576 })] },
        { id: 'p2', elements: [img({ id: 'b', w: 576, h: 576 })] }
      ]
    })
    const low = preflight(multi).filter((i) => i.rule === 'image-low')
    expect(low).toHaveLength(2)
    expect(new Set(low.map((i) => i.page))).toEqual(new Set([0, 1]))
  })
})
