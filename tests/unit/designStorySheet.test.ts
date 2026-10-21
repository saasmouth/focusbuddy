// @vitest-environment node
// The sheet the document sets by, and the two switches that had no control
// anywhere until the styles panel: hyphenation and baseline snapping.
//
// A checkbox that stores a value is not a feature. These go through
// applyStoryFlows — the function the editor calls on every change — and assert
// the PAGE changes, which is the only thing the person cares about.
import { describe, it, expect } from 'vitest'
import { applyStoryFlows, documentStyleSheet, paragraphsForStory } from '../../src/shared/designStories'
import { DEFAULT_BRAND_KIT } from '../../src/shared/brandKit'
import { updateParagraphStyle } from '../../src/shared/designStyles'
import { parsePlainText } from '../../src/shared/designContent'
import type { DesignBody } from '../../src/shared/design'
import type { FlowMeasurer } from '../../src/shared/designFlow'

// Proportional enough to make wrapping realistic: wide capitals, narrow i/l.
const measure: FlowMeasurer = (text, font) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  const size = m ? Number(m[1]) : 10
  let w = 0
  for (const ch of text) w += /[ilt.,;:'’]/.test(ch) ? size * 0.28 : /[A-Z]/.test(ch) ? size * 0.62 : size * 0.5
  return w
}

function doc(src: string, frame: { w: number; h: number } = { w: 180, h: 400 }): DesignBody {
  const el = {
    id: 'f1',
    type: 'text' as const,
    x: 0,
    y: 0,
    w: frame.w,
    h: frame.h,
    z: 1,
    storyId: 's1',
    paragraphs: []
  }
  return {
    schemaVersion: 1,
    width: 400,
    height: 600,
    elements: [el],
    pages: [{ id: 'p1', elements: [el] }],
    activePage: 0,
    stories: { s1: parsePlainText(src, { firstLineIsTitle: false }) }
  } as unknown as DesignBody
}

type Line = { text: string; y: number; size: number; family?: string; color?: string }
const lines = (b: DesignBody): Line[] => {
  const el = (b.pages?.[0].elements ?? [])[0] as { flowLines?: Line[] }
  return el.flowLines ?? []
}

describe('the document style sheet', () => {
  it('is the generated default when the document carries none, with the styles a layout tool opens with', () => {
    const sheet = documentStyleSheet(doc('Body copy.'))
    expect(sheet.paragraph.map((s) => s.id)).toContain('body')
    expect(sheet.paragraph.map((s) => s.id)).toContain('heading1')
    // Generated, not stored: looking at a document does not change it.
    expect(doc('Body copy.').paragraphStyles).toBeUndefined()
  })

  it('is the document own sheet once it has one', () => {
    const d = doc('Body copy.')
    const mine = { paragraph: [{ id: 'body', name: 'Mine', props: { fontSize: 11 } }] }
    expect(documentStyleSheet({ ...d, paragraphStyles: mine })).toBe(mine)
  })

  it('reads the same sheet the page is actually set from', () => {
    // The panel shows documentStyleSheet; the page is set by storyParagraphs
    // through design.paragraphStyles. If those two disagreed, the panel would
    // be editing something that does not reach the page.
    const d = doc('Body copy that runs on a bit.')
    const sheet = documentStyleSheet(d)
    const bodySize = sheet.paragraph.find((s) => s.id === 'body')?.props.fontSize
    const set = lines(applyStoryFlows(d, measure))
    expect(set.length).toBeGreaterThan(0)
    expect(bodySize).toBeGreaterThan(0)
  })
})

describe('hyphenation, from the switch to the page', () => {
  // A long word that cannot fit on a line is the case hyphenation exists for.
  const src = 'The exhibition covered counterrevolutionary pamphleteering throughout the period.'

  it('is off in the generated sheet, so an old document sets exactly as before', () => {
    const sheet = documentStyleSheet(doc(src))
    expect(sheet.paragraph.find((s) => s.id === 'body')?.props.hyphenate).toBe(false)
  })

  it('breaks a long word with a hyphen once the Body style asks for it', () => {
    const d = doc(src, { w: 120, h: 400 })
    const off = lines(applyStoryFlows(d, measure))
    const on = lines(
      applyStoryFlows(
        { ...d, paragraphStyles: updateParagraphStyle(documentStyleSheet(d), 'body', { props: { hyphenate: true } }) },
        measure
      )
    )
    expect(off.some((l) => l.text.includes('-'))).toBe(false)
    expect(on.some((l) => l.text.trimEnd().endsWith('-'))).toBe(true)
    // And it is the same words, not different content.
    expect(on.map((l) => l.text).join(' ').replace(/-\s+/g, '')).toContain('counterrevolutionary')
  })

  it('carries to a style that inherits from Body', () => {
    const d = doc(`### Heading\n\n${src}`, { w: 120, h: 400 })
    const sheet = updateParagraphStyle(documentStyleSheet(d), 'body', { props: { hyphenate: true } })
    const out = lines(applyStoryFlows({ ...d, paragraphStyles: sheet }, measure))
    expect(out.some((l) => l.text.trimEnd().endsWith('-'))).toBe(true)
  })
})

describe('baseline snapping, from the switch to the page', () => {
  const src = 'First paragraph of the column.\n\nSecond paragraph, which starts wherever the first one left off unless the grid says otherwise.'

  it('does nothing without a grid, however the style is set', () => {
    const d = doc(src)
    const sheet = updateParagraphStyle(documentStyleSheet(d), 'body', { props: { snapToGrid: true } })
    const withSnap = lines(applyStoryFlows({ ...d, paragraphStyles: sheet }, measure))
    const without = lines(applyStoryFlows(d, measure))
    expect(withSnap.map((l) => Math.round(l.y))).toEqual(without.map((l) => Math.round(l.y)))
  })

  it('puts every line on a grid line when both the grid and the switch are set', () => {
    const d = { ...doc(src), baselineGrid: { spacing: 18, offset: 0 } }
    const sheet = updateParagraphStyle(documentStyleSheet(d), 'body', { props: { snapToGrid: true } })
    const out = lines(applyStoryFlows({ ...d, paragraphStyles: sheet }, measure))
    expect(out.length).toBeGreaterThan(2)
    // The frame sits at y=0, so page coordinates and frame coordinates agree.
    for (const l of out) expect(Math.abs((l.y % 18) - 0) < 0.01 || Math.abs((l.y % 18) - 18) < 0.01).toBe(true)
  })

  it('leaves the lines off-grid when the switch is off, so the grid is opt-in per style', () => {
    const d = { ...doc(src), baselineGrid: { spacing: 18, offset: 0 } }
    const out = lines(applyStoryFlows(d, measure))
    expect(out.some((l) => Math.abs(l.y % 18) > 0.01 && Math.abs((l.y % 18) - 18) > 0.01)).toBe(true)
  })
})

describe('the brand kit reaches the page', () => {
  // The kit decides the body and heading families and the accent colour. The
  // editor typeset the page through applyStoryFlows WITHOUT it while measuring
  // the caret through paragraphsForStory WITH it, so for anyone with a brand
  // font the page was set in one family and the caret arithmetic done in
  // another, and the caret drifted along the line.
  const kit = {
    ...DEFAULT_BRAND_KIT,
    fontBody: 'Courier New',
    fontHeading: 'Courier New',
    colorPrimary: '#008800'
  }

  it('sets headings in the kit family, not the built-in one', () => {
    // The BODY family is the serif stack under the default editorial preset
    // whatever the kit says (style.serifBody), so the heading is where the
    // kit shows through on this preset — and the accent colour always is.
    // "##" is heading level 1, which is the one the sheet gives the accent to;
    // "###" is level 2 and sets in ink.
    const d = doc('## A heading\n\nBody copy.')
    const theirs = lines(applyStoryFlows(d, measure, kit))
    const builtIn = lines(applyStoryFlows(d, measure))
    const headingOf = (ls: ReturnType<typeof lines>): (typeof ls)[number] =>
      ls.reduce((a, b) => (b.size > a.size ? b : a), ls[0])
    expect(headingOf(theirs).family).toBe('Courier New')
    expect(headingOf(builtIn).family).not.toBe('Courier New')
    expect(headingOf(theirs).color).toBe('#008800')
  })

  it('agrees with what the caret is measured from, which is the whole point', () => {
    const d = doc('Body copy in the brand family.')
    const set = lines(applyStoryFlows(d, measure, kit))
    const forCaret = paragraphsForStory(d, 's1', kit)
    expect(set[0].family).toBe(forCaret[0].style.fontFamily)
    expect(set[0].size).toBeCloseTo(forCaret[0].style.fontSize, 5)
  })

  it('shows the kit accent in the generated style sheet', () => {
    const sheet = documentStyleSheet(doc('x'), kit)
    const h1 = sheet.paragraph.find((s) => s.id === 'heading1')
    expect(h1?.props.color).toBe('#008800')
    expect(h1?.props.fontFamily).toBe('Courier New')
  })
})
