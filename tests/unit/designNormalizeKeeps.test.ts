// normalizeDesignBody runs on EVERY read of a design — parseBody in
// src/main/db/documents.ts calls it — so anything it does not carry through is
// not "defaulted", it is DELETED, and the next save writes the loss to disk.
//
// swatches, paragraphStyles and baselineGrid were added with their features
// (2026-10-21) and never added to the normaliser, so reopening a design lost
// the palette the user named, the style sheet they edited and the grid they
// set, and every fill's swatchId was left dangling while its cached colour
// stayed — the artwork looked right until something recoloured.
//
// Found by 2e while reading the model for the Design snippet target.

import { describe, expect, it } from 'vitest'
import { DESIGN_BODY_FIELDS, normalizeDesignBody } from '../../src/shared/design'
import { normalizeContent } from '../../src/shared/designContent'

const body = (extra: Record<string, unknown>): Record<string, unknown> => ({
  width: 794,
  height: 1123,
  elements: [],
  ...extra
})

describe('normalizeDesignBody keeps the document-level settings', () => {
  it('keeps a named palette, including a spot ink and a locked brand colour', () => {
    const out = normalizeDesignBody(
      body({
        swatches: [
          { id: 'sw-1', name: 'Deep sea', color: '#123456' },
          { id: 'sw-2', name: 'Pantone 286', color: '#0033a0', spot: { inkName: 'Pantone 286 C' } },
          { id: 'sw-3', name: 'Brand', color: '#6d5dfc', locked: true }
        ]
      })
    )
    expect(out.swatches).toHaveLength(3)
    expect(out.swatches?.[1]?.spot?.inkName).toBe('Pantone 286 C')
    expect(out.swatches?.[2]?.locked).toBe(true)
  })

  it('keeps an edited paragraph style sheet, with its character styles and block map', () => {
    const out = normalizeDesignBody(
      body({
        paragraphStyles: {
          paragraph: [
            { id: 'body', name: 'Body', props: { fontSize: 11 } },
            { id: 'heading1', name: 'Heading 1', props: { fontSize: 28, bold: true } }
          ],
          character: [{ id: 'emph', name: 'Emphasis', props: { italic: true } }],
          blockMap: { quote: 'body' }
        }
      })
    )
    expect(out.paragraphStyles?.paragraph.map((s) => s.id)).toEqual(['body', 'heading1'])
    expect(out.paragraphStyles?.character?.[0]?.id).toBe('emph')
    expect(out.paragraphStyles?.blockMap?.quote).toBe('body')
  })

  it('keeps a baseline grid, with its offset', () => {
    const out = normalizeDesignBody(body({ baselineGrid: { spacing: 14.5, offset: 6 } }))
    expect(out.baselineGrid).toEqual({ spacing: 14.5, offset: 6 })
  })

  it('survives a round trip, which is what reopening a document is', () => {
    const first = normalizeDesignBody(
      body({
        swatches: [{ id: 'sw-1', name: 'Deep sea', color: '#123456' }],
        paragraphStyles: { paragraph: [{ id: 'body', name: 'Body', props: { fontSize: 11 } }] },
        baselineGrid: { spacing: 12 }
      })
    )
    // Save, reopen, save, reopen: a drop would show on the second pass even if
    // the first happened to hold the live object.
    const second = normalizeDesignBody(JSON.parse(JSON.stringify(first)))
    const third = normalizeDesignBody(JSON.parse(JSON.stringify(second)))
    expect(third.swatches).toEqual(first.swatches)
    expect(third.paragraphStyles).toEqual(first.paragraphStyles)
    expect(third.baselineGrid).toEqual(first.baselineGrid)
  })

  it('rejects junk rather than carrying it: the body is untrusted input', () => {
    const out = normalizeDesignBody(
      body({
        swatches: [{ name: 'no id' }, { id: 'ok', color: '#fff' }, 'nonsense', null],
        paragraphStyles: { paragraph: 'not an array' },
        baselineGrid: { spacing: 0 }
      })
    )
    expect(out.swatches?.map((s) => s.id)).toEqual(['ok'])
    expect(out.paragraphStyles).toBeUndefined()
    // A zero or negative spacing would divide by zero in the flow engine.
    expect(out.baselineGrid).toBeUndefined()
  })

  it('leaves a design with none of them alone, rather than inventing any', () => {
    const out = normalizeDesignBody(body({}))
    expect(out.swatches).toBeUndefined()
    expect(out.paragraphStyles).toBeUndefined()
    expect(out.baselineGrid).toBeUndefined()
  })
})

describe('normalizeContent keeps an explicit block style override', () => {
  it('keeps styleId on the block kinds that can carry one', () => {
    const doc = normalizeContent({
      blocks: [
        { kind: 'paragraph', text: 'A paragraph', styleId: 'lede' },
        { kind: 'heading', level: 2, text: 'A heading', styleId: 'kicker' },
        { kind: 'list', items: ['one'], styleId: 'bullets' },
        { kind: 'quote', text: 'A line', styleId: 'pullquote' }
      ]
    })
    expect(doc.blocks.map((b) => (b as { styleId?: string }).styleId)).toEqual(['lede', 'kicker', 'bullets', 'pullquote'])
  })

  it('does not invent one, and rejects a non-string', () => {
    const doc = normalizeContent({
      blocks: [{ kind: 'paragraph', text: 'Plain' }, { kind: 'paragraph', text: 'Junk', styleId: 7 }]
    })
    expect(doc.blocks.every((b) => (b as { styleId?: string }).styleId === undefined)).toBe(true)
  })
})

// 9d's gate: a fully populated body through the normaliser, field by field.
// DESIGN_BODY_FIELDS classifies every field DesignBody declares — adding one
// without classifying it is a compile error — and this proves the ones marked
// `kept` really do survive, so the classification cannot become a comment that
// lies. `derived` fields are computed (clamped, mirrored from the active page,
// or deliberately not persisted), and each is asserted on its own below.
describe('every field of a fully populated design survives normalisation', () => {
  const full = {
    schemaVersion: 1,
    width: 794,
    height: 1123,
    background: { type: 'solid', color: '#fffdf8' },
    elements: [],
    category: 'print' as const,
    brandApplied: true,
    bleed: 3,
    pages: [
      { id: 'pg-1', background: { type: 'solid', color: '#fffdf8' }, elements: [], masterId: 'master-1' },
      { id: 'pg-2', background: { type: 'solid', color: '#ffffff' }, elements: [], masterId: null }
    ],
    activePage: 1,
    masters: [
      { id: 'master-1', name: 'Master A', background: { type: 'solid', color: '#ffffff' }, elements: [], side: 'left' as const }
    ],
    guides: { v: [100, 200], h: [50] },
    margins: { top: 40, right: 50, bottom: 60, left: 70 },
    columns: { count: 3, gutter: 18 },
    // DesignLayer is { id, name, visible, locked } — all four always written,
    // so a layer stored without its flags comes back with them. The fixture
    // uses the real shape; an invented `hidden` here made this test fail and
    // the normaliser look wrong.
    layers: [
      { id: 'base', name: 'Layer 1', visible: true, locked: false },
      { id: 'notes', name: 'Notes', visible: false, locked: true }
    ],
    facing: true,
    stories: { 'st-a': { blocks: [{ kind: 'paragraph', text: 'The story' }] } },
    layoutStyleId: 'magazine',
    sourceContent: { blocks: [{ kind: 'title', text: 'A Quarter Worth Reading About' }] },
    pageNumberStart: 7,
    editingMasterId: 'master-1',
    paragraphStyles: { paragraph: [{ id: 'body', name: 'Body', props: { fontSize: 11 } }], blockMap: { quote: 'body' } },
    baselineGrid: { spacing: 14, offset: 2 },
    swatches: [{ id: 'sw-1', name: 'Deep sea', color: '#123456', spot: { inkName: 'Pantone 286 C' } }]
  }

  const kept = (Object.keys(DESIGN_BODY_FIELDS) as Array<keyof typeof DESIGN_BODY_FIELDS>).filter(
    (k) => DESIGN_BODY_FIELDS[k] === 'kept'
  )

  it('classifies every declared field (a new one without a classification will not compile)', () => {
    // Nothing clever to assert: the type is the test. This states the intent
    // so the next person sees why the map exists.
    expect(kept.length).toBeGreaterThan(0)
    expect(Object.keys(DESIGN_BODY_FIELDS).sort()).toEqual(Object.keys(full).sort())
  })

  for (const field of kept) {
    it(`keeps ${field}`, () => {
      const out = normalizeDesignBody(full) as Record<string, unknown>
      expect(out[field], `${field} did not survive normalizeDesignBody`).toEqual(
        (full as Record<string, unknown>)[field]
      )
    })
  }

  it('derives the rest as documented, rather than losing it', () => {
    const out = normalizeDesignBody(full)
    expect(out.schemaVersion).toBe(1)
    expect(out.width).toBe(794)
    expect(out.height).toBe(1123)
    // elements and background mirror the ACTIVE page (page 2 here), which is
    // what the editor renders.
    expect(out.activePage).toBe(1)
    expect(out.elements).toEqual(full.pages[1]!.elements)
    expect(out.background).toEqual(full.pages[1]!.background)
    // A document that reopened straight into master-editing would be a trap.
    expect(out.editingMasterId).toBeNull()
  })

  it('round-trips twice without drift, which is what two saves and two opens are', () => {
    const once = normalizeDesignBody(full)
    const twice = normalizeDesignBody(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
  })
})
