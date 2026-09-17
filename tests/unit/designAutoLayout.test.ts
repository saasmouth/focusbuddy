import { describe, it, expect } from 'vitest'
import { LAYOUT_STYLES, autoLayout, findLayoutStyle, planFromContent, storyParagraphs, typeScaleFor } from '../../src/shared/designAutoLayout'
import { parsePlainText, type ContentDoc } from '../../src/shared/designContent'
import { findDesignSize, storyIds, storyFrames, masterForPage } from '../../src/shared/design'
import type { FlowMeasurer } from '../../src/shared/designFlow'
import { DEFAULT_BRAND_KIT } from '../../src/shared/brandKit'
import type { SlideTextElement } from '../../src/shared/types'

// A stand-in font engine: width scales with the font size in the shorthand, so
// bigger type really does take more room and the layout behaves realistically.
const measure: FlowMeasurer = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16)
  return text.length * size * 0.5
}

const A4 = findDesignSize('a4-portrait')!

function article(paragraphs: number, wordsEach = 60): ContentDoc {
  const parts = ['# The Quarterly Review', '', 'A short standfirst under the headline', '']
  for (let i = 0; i < paragraphs; i++) {
    if (i > 0 && i % 4 === 0) parts.push(`### Section ${i / 4}`, '')
    parts.push(`${'word '.repeat(wordsEach).trim()}.`, '')
  }
  return parsePlainText(parts.join('\n'))
}

/** Every word the story actually set, across every frame, in order. */
function setText(body: ReturnType<typeof autoLayout>['body']): string {
  const out: string[] = []
  for (const pg of body.pages ?? []) {
    for (const el of pg.elements) {
      if (el.type !== 'text' || !(el as SlideTextElement).storyId) continue
      for (const l of (el as SlideTextElement).flowLines ?? []) out.push((l.dropCap?.text ?? '') + l.text)
    }
  }
  return out.join(' ')
}

describe('designAutoLayout — styles', () => {
  it('every style is complete and uniquely named', () => {
    const ids = new Set(LAYOUT_STYLES.map((s) => s.id))
    expect(ids.size).toBe(LAYOUT_STYLES.length)
    for (const s of LAYOUT_STYLES) {
      expect(s.name.length).toBeGreaterThan(0)
      expect(s.blurb.length).toBeGreaterThan(10)
      expect(s.columns).toBeGreaterThanOrEqual(1)
      expect(s.marginRatio).toBeGreaterThan(0)
    }
  })

  it('an unknown style id falls back rather than throwing', () => {
    expect(findLayoutStyle('nope').id).toBe(LAYOUT_STYLES[0].id)
  })

  it('the type scale keeps a readable measure in one wide and three narrow columns', () => {
    const wide = typeScaleFor(findLayoutStyle('report'), DEFAULT_BRAND_KIT, 620)
    const narrow = typeScaleFor(findLayoutStyle('magazine'), DEFAULT_BRAND_KIT, 200)
    // Characters per line, at the stand-in's half-em average.
    const cpl = (colW: number, size: number): number => colW / (size * 0.5)
    expect(cpl(620, wide.body)).toBeGreaterThan(40)
    expect(cpl(620, wide.body)).toBeLessThan(85)
    expect(cpl(200, narrow.body)).toBeGreaterThan(30)
    expect(cpl(200, narrow.body)).toBeLessThan(85)
  })
})

describe('designAutoLayout — building a publication', () => {
  it('lays a short article onto one page with no overset', () => {
    const r = autoLayout({ content: article(3), size: A4, measure })
    expect(r.overset).toBe(false)
    expect(r.pages).toBe(1)
    expect(r.body.pages).toHaveLength(1)
  })

  it('grows onto as many pages as the copy needs', () => {
    const short = autoLayout({ content: article(4), size: A4, measure })
    const long = autoLayout({ content: article(60), size: A4, measure })
    expect(long.pages).toBeGreaterThan(short.pages)
    expect(long.overset).toBe(false)
  })

  it('every word of the source survives into the laid-out pages', () => {
    const content = parsePlainText('# Title\n\nalpha bravo charlie delta echo foxtrot golf hotel india juliet.')
    const r = autoLayout({ content, size: A4, measure })
    const set = setText(r.body)
    for (const w of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet']) {
      expect(set).toContain(w)
    }
  })

  it('threads every body frame into ONE story', () => {
    const r = autoLayout({ content: article(30), size: A4, measure })
    const ids = storyIds(r.body)
    expect(ids).toHaveLength(1)
    const chain = storyFrames(r.body, ids[0])
    expect(chain.length).toBeGreaterThan(1)
    // Thread order runs page by page, column by column.
    const orders = chain.map((c) => c.element.storyOrder ?? 0)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('sets up margins, a column grid, a master page and a layer', () => {
    const r = autoLayout({ content: article(10), size: A4, style: findLayoutStyle('editorial'), measure })
    expect(r.body.margins!.top).toBeGreaterThan(0)
    expect(r.body.columns!.count).toBe(2)
    expect(r.body.masters).toHaveLength(1)
    expect(r.body.layers).toHaveLength(1)
  })

  it('the title is display type on page one, not part of the flowing story', () => {
    const r = autoLayout({ content: article(6), size: A4, measure })
    const page1 = r.body.pages![0]
    const titleEl = page1.elements.find(
      (el) => el.type === 'text' && !(el as SlideTextElement).storyId && (el as SlideTextElement).paragraphs[0]?.runs[0]?.text === 'The Quarterly Review'
    )
    expect(titleEl).toBeTruthy()
    expect(setText(r.body)).not.toContain('The Quarterly Review')
  })

  it('page one is detached from the master so the folio does not sit under the title', () => {
    const r = autoLayout({ content: article(30), size: A4, measure })
    expect(r.pages).toBeGreaterThan(1)
    expect(r.body.pages![0].masterId).toBeNull()
    expect(masterForPage(r.body, r.body.pages![1])).toBeTruthy()
  })

  it('later pages carry the running head and the page-number token', () => {
    const r = autoLayout({ content: article(30), size: A4, style: findLayoutStyle('editorial'), measure })
    const master = r.body.masters![0]
    const texts = master.elements.map((el) => (el.type === 'text' ? el.paragraphs[0]?.runs[0]?.text : '')).filter(Boolean)
    expect(texts).toContain('{#}')
    expect(texts).toContain('The Quarterly Review')
  })

  it('body frames sit inside the margins and match the column count', () => {
    const r = autoLayout({ content: article(80), size: A4, style: findLayoutStyle('magazine'), measure })
    expect(r.pages).toBeGreaterThan(1)
    const m = r.body.margins!
    const page2 = r.body.pages![1]
    const frames = page2.elements.filter((el) => el.type === 'text' && (el as SlideTextElement).storyId)
    expect(frames).toHaveLength(3)
    for (const f of frames) {
      expect(f.x).toBeGreaterThanOrEqual(m.left - 1)
      expect(f.x + f.w).toBeLessThanOrEqual(A4.w - m.right + 1)
    }
  })

  it('a heading is set larger than the body it introduces', () => {
    const r = autoLayout({ content: article(12), size: A4, measure })
    const sizes = new Set<number>()
    for (const pg of r.body.pages ?? []) {
      for (const el of pg.elements) {
        if (el.type !== 'text' || !(el as SlideTextElement).storyId) continue
        for (const l of (el as SlideTextElement).flowLines ?? []) sizes.add(l.size)
      }
    }
    // Body plus at least one heading size.
    expect(sizes.size).toBeGreaterThan(1)
  })

  it('an empty document still produces a valid one-page body', () => {
    const r = autoLayout({ content: { blocks: [] }, size: A4, measure })
    expect(r.body.pages).toHaveLength(1)
    expect(r.overset).toBe(false)
  })

  it('the page cap is respected and reported honestly rather than looping', () => {
    const r = autoLayout({ content: article(400), size: A4, measure, maxPages: 3 })
    expect(r.pages).toBeLessThanOrEqual(3)
    expect(r.overset).toBe(true)
  })

  it('records the style so the document can be re-laid-out later', () => {
    const r = autoLayout({ content: article(5), size: A4, style: findLayoutStyle('booklet'), measure })
    expect(r.body.layoutStyleId).toBe('booklet')
    expect(r.body.facing).toBe(true)
  })

  it('every style produces a usable document from the same copy', () => {
    for (const style of LAYOUT_STYLES) {
      const r = autoLayout({ content: article(14), size: A4, style, measure })
      expect(r.overset, `${style.id} overset`).toBe(false)
      expect(r.pages, `${style.id} pages`).toBeGreaterThan(0)
      expect(setText(r.body).length, `${style.id} empty`).toBeGreaterThan(50)
    }
  })
})

describe('designAutoLayout — lists, quotes and images', () => {
  it('list items keep their markers', () => {
    const content = parsePlainText('# T\n\nIntro paragraph here.\n\n- first item\n- second item\n- third item')
    const r = autoLayout({ content, size: A4, measure })
    const bullets: string[] = []
    for (const pg of r.body.pages ?? []) {
      for (const el of pg.elements) {
        if (el.type !== 'text') continue
        for (const l of (el as SlideTextElement).flowLines ?? []) if (l.bullet) bullets.push(l.bullet)
      }
    }
    expect(bullets).toEqual(['•', '•', '•'])
  })

  it('a numbered list numbers itself', () => {
    const content = parsePlainText('# T\n\nIntro.\n\n1. alpha\n2. beta')
    const r = autoLayout({ content, size: A4, measure })
    const bullets: string[] = []
    for (const pg of r.body.pages ?? []) {
      for (const el of pg.elements) {
        if (el.type !== 'text') continue
        for (const l of (el as SlideTextElement).flowLines ?? []) if (l.bullet) bullets.push(l.bullet)
      }
    }
    expect(bullets).toEqual(['1.', '2.'])
  })

  it('an image becomes a placed object that text wraps around', () => {
    const content: ContentDoc = {
      blocks: [
        { kind: 'title', text: 'With a picture' },
        { kind: 'paragraph', text: 'word '.repeat(120).trim() },
        { kind: 'image', src: 'data:image/png;base64,AAA', alt: 'a chart' },
        { kind: 'paragraph', text: 'word '.repeat(120).trim() }
      ]
    }
    const r = autoLayout({ content, size: A4, measure })
    const images = (r.body.pages ?? []).flatMap((p) => p.elements.filter((e) => e.type === 'image'))
    expect(images).toHaveLength(1)
    expect(images[0].wrap?.mode).toBe('square')
  })

  it('a pull quote is a VERBATIM sentence from the copy, never invented', () => {
    const sentence = 'This particular sentence is long enough to be lifted out and set as a display pull quote.'
    const filler = 'Padding words fill the paragraph out to a usable length. '
    const long = `${filler.repeat(8)}${sentence} ${filler.repeat(8)}`
    const content: ContentDoc = { blocks: [{ kind: 'title', text: 'T' }, { kind: 'paragraph', text: long }] }
    const r = autoLayout({ content, size: A4, style: findLayoutStyle('editorial'), measure })
    const quotes = (r.body.pages ?? [])
      .flatMap((p) => p.elements)
      .filter((el) => el.type === 'text' && !(el as SlideTextElement).storyId && (el as SlideTextElement).wrap?.mode === 'square')
      .map((el) => (el as SlideTextElement).paragraphs[0].runs[0].text)
    expect(quotes).toHaveLength(1)
    expect(long).toContain(quotes[0])
  })

  it('a style with pull quotes off produces none', () => {
    const filler = 'Padding words fill the paragraph out to a usable length. '
    const long = `${filler.repeat(8)}This particular sentence is long enough to be lifted out and set as a pull quote. ${filler.repeat(8)}`
    const content: ContentDoc = { blocks: [{ kind: 'title', text: 'T' }, { kind: 'paragraph', text: long }] }
    const r = autoLayout({ content, size: A4, style: findLayoutStyle('report'), measure })
    const quotes = (r.body.pages ?? [])
      .flatMap((p) => p.elements)
      .filter((el) => el.type === 'text' && !(el as SlideTextElement).storyId && (el as SlideTextElement).wrap?.mode === 'square')
    expect(quotes).toHaveLength(0)
  })
})

describe('designAutoLayout — the no-AI planner', () => {
  it('short copy gets a single wide column', () => {
    expect(planFromContent(parsePlainText('Just a few words here.')).styleId).toBe('report')
  })

  it('heading-dense copy gets a report', () => {
    const doc = parsePlainText('# T\n\n### A\n\nbody.\n\n### B\n\nbody.\n\n### C\n\nbody.\n\n### D\n\nbody.')
    expect(planFromContent(doc).styleId).toBe('report')
  })

  it('a long continuous essay gets the editorial two-column', () => {
    const doc = parsePlainText(`# T\n\n${'word '.repeat(600)}\n\n${'word '.repeat(600)}`)
    expect(planFromContent(doc).styleId).toBe('editorial')
  })

  it('a very long piece becomes a booklet', () => {
    const doc = parsePlainText(`# T\n\n${Array.from({ length: 12 }, () => 'word '.repeat(300)).join('\n\n')}`)
    expect(planFromContent(doc).styleId).toBe('booklet')
  })

  it('always explains itself, and only ever names real paragraphs for pull quotes', () => {
    const doc = parsePlainText(`# T\n\n${'word '.repeat(600)}`)
    const plan = planFromContent(doc)
    expect(plan.reason!.length).toBeGreaterThan(10)
    for (const i of plan.pullQuoteBlocks ?? []) expect(doc.blocks[i].kind).toBe('paragraph')
  })
})

describe('designAutoLayout — story paragraphs', () => {
  it('the title and subtitle are excluded from the flowing story', () => {
    const doc = parsePlainText('# Title\n\nA standfirst line\n\nBody copy here.')
    const scale = typeScaleFor(findLayoutStyle('editorial'), DEFAULT_BRAND_KIT, 300)
    const paras = storyParagraphs(doc, findLayoutStyle('editorial'), scale)
    expect(paras.map((p) => p.text)).not.toContain('Title')
    expect(paras.map((p) => p.text)).toContain('Body copy here.')
  })

  it('headings get keep-with-next so they never strand', () => {
    const doc = parsePlainText('### Section\n\nBody.')
    const scale = typeScaleFor(findLayoutStyle('editorial'), DEFAULT_BRAND_KIT, 300)
    const paras = storyParagraphs(doc, findLayoutStyle('editorial'), scale)
    expect(paras[0].style.keepWithNext).toBe(true)
  })

  it('every editable paragraph records the block it came from', () => {
    // Without this mapping a caret on the page cannot be traced back to the text
    // the author edits, so typing on the page is impossible. It was missing once.
    const doc = parsePlainText('# Title\n\nBody one.\n\n### A heading\n\n- alpha\n- beta\n\n> Quoted words here.')
    const scale = typeScaleFor(findLayoutStyle('editorial'), DEFAULT_BRAND_KIT, 300)
    const paras = storyParagraphs(doc, findLayoutStyle('editorial'), scale)
    const sourced = paras.filter((p) => p.source)
    expect(sourced.length).toBeGreaterThanOrEqual(5)
    for (const p of sourced) {
      const block = doc.blocks[p.source!.block]
      expect(block, 'source points at a real block').toBeTruthy()
      if (p.source!.item !== undefined) {
        expect(block.kind).toBe('list')
        expect((block as { items: string[] }).items[p.source!.item]).toBe(p.text)
      } else if ('text' in block) {
        expect(block.text).toBe(p.text)
      }
    }
  })

  it('list items carry their own item index, so a caret lands in the right one', () => {
    const doc = parsePlainText('Intro line here.\n\n- alpha\n- beta\n- gamma')
    const scale = typeScaleFor(findLayoutStyle('report'), DEFAULT_BRAND_KIT, 400)
    const items = storyParagraphs(doc, findLayoutStyle('report'), scale).filter((p) => p.source?.item !== undefined)
    expect(items.map((p) => p.source!.item)).toEqual([0, 1, 2])
    expect(items.map((p) => p.text)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('a quote carries its attribution as its own smaller line', () => {
    const doc = parsePlainText('> Some quoted words here.\n> — A Person')
    const scale = typeScaleFor(findLayoutStyle('editorial'), DEFAULT_BRAND_KIT, 300)
    const paras = storyParagraphs(doc, findLayoutStyle('editorial'), scale)
    expect(paras).toHaveLength(2)
    expect(paras[1].text).toBe('— A Person')
    expect(paras[1].style.fontSize).toBeLessThan(paras[0].style.fontSize)
  })
})
