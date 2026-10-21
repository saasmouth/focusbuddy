// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  defaultStyleSheet,
  resolveParagraphStyle,
  resolveCharacterStyle,
  updateParagraphStyle,
  descendantsOf,
  styleIdForBlock,
  blockStyleKey,
  fontShorthand,
  type DesignStyleSheet,
  type SheetScale,
  type SheetLayout
} from '../../src/shared/designStyles'
import type { FlowParaStyle } from '../../src/shared/designFlow'

const scale: SheetScale = {
  body: 10.5, h1: 24, h2: 18, h3: 14, quote: 12, caption: 9, title: 42, subtitle: 20,
  bodyFamily: 'Charter', headFamily: 'Söhne', ink: '#1c1917', accent: '#2563eb', muted: '#78716c'
}
const layout: SheetLayout = { leading: 1.45, justify: true, dropCap: true, headingRule: true }

const base: FlowParaStyle = {
  fontSize: 10.5, lineHeight: 1.45, font: '10.5px Charter', align: 'left'
}

describe('resolution', () => {
  const sheet = defaultStyleSheet(scale, layout)

  it('gives a style every property the engine needs', () => {
    const body = resolveParagraphStyle(sheet, 'body', base)
    expect(body.fontSize).toBe(10.5)
    expect(body.align).toBe('justify')
    expect(body.color).toBe('#1c1917')
    expect(body.font).toContain('Charter')
  })

  it('inherits from the parent and lets the child win', () => {
    // Heading 1 is based on Body: it takes Body's leading-family decisions but
    // overrides size, family, weight and colour.
    const h1 = resolveParagraphStyle(sheet, 'heading1', base)
    expect(h1.fontSize).toBe(24)
    expect(h1.bold).toBe(true)
    expect(h1.fontFamily).toBe('Söhne')
    expect(h1.color).toBe('#2563eb')
    // widowLines came from Body and survived, which is the point of basedOn.
    expect(h1.widowLines).toBe(2)
  })

  it('rebuilds the font shorthand from whatever size actually won', () => {
    // The measurer and the renderer must agree; inheriting a parent's
    // shorthand would measure a 24px heading with a 10.5px font string.
    const h1 = resolveParagraphStyle(sheet, 'heading1', base)
    expect(h1.font).toBe('700 24px Söhne')
  })

  it('carries inheritance through a chain', () => {
    const custom: DesignStyleSheet = {
      paragraph: [
        { id: 'a', name: 'A', props: { fontSize: 10, color: '#111111', widowLines: 3 } },
        { id: 'b', name: 'B', basedOn: 'a', props: { fontSize: 12 } },
        { id: 'c', name: 'C', basedOn: 'b', props: { italic: true } }
      ]
    }
    const c = resolveParagraphStyle(custom, 'c', base)
    expect(c.fontSize).toBe(12) // from B
    expect(c.color).toBe('#111111') // from A, two levels up
    expect(c.widowLines).toBe(3)
    expect(c.italic).toBe(true)
  })

  it('does not hang on a cycle', () => {
    // Two clicks away for anyone editing styles: "Body based on Caption,
    // Caption based on Body". A layout engine that locks up is a worse answer
    // than a style that resolves slightly oddly.
    const cyclic: DesignStyleSheet = {
      paragraph: [
        { id: 'x', name: 'X', basedOn: 'y', props: { fontSize: 10 } },
        { id: 'y', name: 'Y', basedOn: 'x', props: { fontSize: 20 } }
      ]
    }
    const r = resolveParagraphStyle(cyclic, 'x', base)
    expect(r.fontSize).toBeGreaterThan(0)
  })

  it('falls back to the base when the style is unknown', () => {
    expect(resolveParagraphStyle(sheet, 'nope', base).fontSize).toBe(base.fontSize)
  })
})

describe('editing a style moves everything that uses it', () => {
  it('changes every paragraph of that style at once', () => {
    // The whole reason named styles exist: "make captions a point smaller" is
    // one edit, not one edit per caption.
    const sheet = defaultStyleSheet(scale, layout)
    const before = resolveParagraphStyle(sheet, 'caption', base).fontSize
    const next = updateParagraphStyle(sheet, 'caption', { props: { fontSize: 8 } })
    expect(resolveParagraphStyle(next, 'caption', base).fontSize).toBe(8)
    expect(before).not.toBe(8)
  })

  it('carries a parent edit down to its children', () => {
    const sheet = defaultStyleSheet(scale, layout)
    const next = updateParagraphStyle(sheet, 'body', { props: { color: '#ff0000' } })
    // Quote and Caption are based on Body and set no colour of their own.
    expect(resolveParagraphStyle(next, 'list', base).color).toBe('#ff0000')
    // Heading 1 sets its own colour, so the parent edit must NOT override it.
    expect(resolveParagraphStyle(next, 'heading1', base).color).toBe('#2563eb')
  })

  it('returns a new sheet rather than mutating', () => {
    // The document is React state and undo needs the previous sheet to exist.
    const sheet = defaultStyleSheet(scale, layout)
    const snapshot = JSON.stringify(sheet)
    updateParagraphStyle(sheet, 'body', { props: { fontSize: 99 } })
    expect(JSON.stringify(sheet)).toBe(snapshot)
  })

  it('lists what an edit will affect, so the UI can warn', () => {
    const sheet = defaultStyleSheet(scale, layout)
    const ids = descendantsOf(sheet, 'body').map((s) => s.id).sort()
    expect(ids).toContain('heading1')
    expect(ids).toContain('quote')
    expect(ids).toContain('caption')
    // Subtitle descends from Title, not Body.
    expect(ids).not.toContain('subtitle')
    expect(descendantsOf(sheet, 'title').map((s) => s.id)).toEqual(['subtitle'])
  })
})

describe('blocks choose a style', () => {
  const sheet = defaultStyleSheet(scale, layout)

  it('maps each block kind to its conventional style', () => {
    expect(blockStyleKey({ kind: 'paragraph', text: 'x' })).toBe('paragraph')
    expect(blockStyleKey({ kind: 'heading', level: 2, text: 'x' })).toBe('heading2')
    expect(blockStyleKey({ kind: 'quote', text: 'x' })).toBe('quote')
    expect(styleIdForBlock(sheet, { kind: 'heading', level: 1, text: 'x' })).toBe('heading1')
    expect(styleIdForBlock(sheet, { kind: 'quote', text: 'x' })).toBe('quote')
  })

  it('lets a block name its own style', () => {
    const b = { kind: 'paragraph', text: 'x', styleId: 'caption' } as never
    expect(styleIdForBlock(sheet, b)).toBe('caption')
  })

  it('ignores a style the sheet does not have, rather than setting nothing', () => {
    // Falls back to the mapped style for the block kind, which for a plain
    // paragraph is 'body' — the default sheet names it that, not 'paragraph'.
    const b = { kind: 'paragraph', text: 'x', styleId: 'ghost' } as never
    expect(styleIdForBlock(sheet, b)).toBe('body')
  })

  it('honours an explicit block map', () => {
    const mapped: DesignStyleSheet = {
      paragraph: [...sheet.paragraph],
      blockMap: { quote: 'caption' }
    }
    expect(styleIdForBlock(mapped, { kind: 'quote', text: 'x' })).toBe('caption')
  })
})

describe('character styles', () => {
  const sheet: DesignStyleSheet = {
    paragraph: [],
    character: [
      { id: 'em', name: 'Emphasis', props: { italic: true, color: '#444444' } },
      { id: 'strong-em', name: 'Strong emphasis', basedOn: 'em', props: { bold: true } }
    ]
  }

  it('resolve and inherit like paragraph styles', () => {
    const r = resolveCharacterStyle(sheet, 'strong-em')
    expect(r.italic).toBe(true)
    expect(r.bold).toBe(true)
    expect(r.color).toBe('#444444')
  })

  it('are empty for an unknown id rather than throwing', () => {
    expect(resolveCharacterStyle(sheet, 'nope')).toEqual({})
  })
})

describe('the default sheet', () => {
  const sheet = defaultStyleSheet(scale, layout)

  it('opens with the styles a layout tool should already have', () => {
    const ids = sheet.paragraph.map((s) => s.id)
    for (const want of ['body', 'heading1', 'heading2', 'heading3', 'quote', 'caption', 'list', 'title'])
      expect(ids).toContain(want)
  })

  it('reproduces the hard-coded body style exactly', () => {
    // The compatibility constraint: a document with no sheet of its own must
    // set as it does today, so the generated sheet has to match what
    // storyParagraphs built in code.
    const body = resolveParagraphStyle(sheet, 'body', base)
    expect(body.fontSize).toBe(10.5)
    expect(body.lineHeight).toBe(1.45)
    expect(body.fontFamily).toBe('Charter')
    expect(body.align).toBe('justify')
    expect(body.color).toBe('#1c1917')
    expect(body.spaceAfter).toBe(5.25) // body * 0.5
    expect(body.widowLines).toBe(2)
  })

  it('reproduces the hard-coded heading style exactly, rule included', () => {
    const h1 = resolveParagraphStyle(sheet, 'heading1', base)
    expect(h1.spaceBefore).toBe(15.75) // body * 1.5
    expect(h1.spaceAfter).toBe(3.68) // body * 0.35, rounded
    expect(h1.keepWithNext).toBe(true)
    expect(h1.ruleAbove).toEqual({ width: 1, thickness: 1, color: '#2563eb' })
  })

  it('reproduces the hard-coded quote, list and attribution exactly', () => {
    // These are the ones most likely to drift, because they were buried in a
    // switch rather than in a shared base. Values mirror storyParagraphs.
    const q = resolveParagraphStyle(sheet, 'quote', base)
    expect(q.fontSize).toBe(11.03) // body * 1.05
    expect(q.italic).toBe(true)
    expect(q.align).toBe('left')
    expect(q.leftInset).toBe(12.6) // body * 1.2
    expect(q.rightInset).toBe(6.3) // body * 0.6
    expect(q.spaceBefore).toBe(7.35) // body * 0.7
    expect(q.color).toBe('#78716c')
    // Quote keeps the body family, not the heading family.
    expect(q.fontFamily).toBe('Charter')

    const li = resolveParagraphStyle(sheet, 'list', base)
    expect(li.leftInset).toBe(14.7) // body * 1.4
    expect(li.spaceAfter).toBe(2.31) // body * 0.22
    expect(li.indent).toBe(0)
    expect(li.align).toBe('left')

    const attr = resolveParagraphStyle(sheet, 'quote-attribution', base)
    expect(attr.fontSize).toBe(9)
    expect(attr.lineHeight).toBe(1.3)
    expect(attr.leftInset).toBe(12.6)
    expect(attr.spaceAfter).toBe(7.35)
  })

  it('omits the heading rule when the layout does not ask for one', () => {
    const plain = defaultStyleSheet(scale, { ...layout, headingRule: false })
    expect(resolveParagraphStyle(plain, 'heading1', base).ruleAbove).toBeUndefined()
  })

  it('follows the layout preset for justification', () => {
    const ragged = defaultStyleSheet(scale, { ...layout, justify: false })
    expect(resolveParagraphStyle(ragged, 'body', base).align).toBe('left')
  })
})

describe('fontShorthand', () => {
  it('matches the shape the measurer expects', () => {
    expect(fontShorthand({ fontSize: 12, fontFamily: 'Inter' })).toBe('12px Inter')
    expect(fontShorthand({ fontSize: 12, fontFamily: 'Inter', bold: true })).toBe('700 12px Inter')
    expect(fontShorthand({ fontSize: 12, fontFamily: 'Inter', italic: true, bold: true })).toBe('italic 700 12px Inter')
  })
})
