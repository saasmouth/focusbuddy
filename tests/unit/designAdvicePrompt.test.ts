// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  briefKey,
  buildAdvicePrompt,
  clampBrief,
  designBrief,
  designDigest,
  designText
} from '../../src/shared/designAdvicePrompt'
import type { DesignBody } from '../../src/shared/design'
import type { SlideElement, SlideTextElement } from '../../src/shared/types'
import type { Advice } from '../../src/shared/designAdvisor'

// What the model is TOLD is the testable part, and the part that goes wrong:
// a brief that invites invention produces invented problems, and a panel that
// invents problems gets closed. None of this needs a key or a network.

const text = (id: string, over: Partial<SlideTextElement> = {}): SlideElement =>
  ({ id, type: 'text', x: 0, y: 0, w: 100, h: 50, z: 1,
     paragraphs: [{ runs: [{ text: 'Hello world' }] }], ...over }) as SlideElement

const doc = (els: SlideElement[], over: Partial<DesignBody> = {}): DesignBody =>
  ({ schemaVersion: 1, width: 816, height: 1056, elements: els, ...over }) as DesignBody

const advice = (over: Partial<Advice> = {}): Advice => ({
  id: 'contrast:0:t1', rule: 'contrast', severity: 'problem',
  title: 'Text is too pale to read (2.1:1)',
  detail: 'This needs at least 4.5:1 against its background.', ...over
})

describe('the document digest', () => {
  it('states facts and nothing else', () => {
    const d = designDigest(doc([text('a'), text('b')], { bleed: 18, columns: { count: 3, gutter: 12 } }))
    expect(d).toContain('816x1056')
    expect(d).toContain('2 text')
    expect(d).toContain('18px bleed')
    expect(d).toContain('3-column grid')
    // No adjectives: the digest is input, not opinion.
    expect(d).not.toMatch(/good|bad|crowded|clean|balanced/i)
  })

  it('counts pages', () => {
    const multi = doc([], { pages: [{ id: 'p1', elements: [text('a')] }, { id: 'p2', elements: [] }] })
    expect(designDigest(multi)).toContain('2 pages')
  })
})

describe('the words on the page', () => {
  it('reads them in visual order, top to bottom', () => {
    const d = doc([
      text('low', { y: 200, paragraphs: [{ runs: [{ text: 'SECOND' }] }] }),
      text('high', { y: 10, paragraphs: [{ runs: [{ text: 'FIRST' }] }] })
    ])
    const out = designText(d)
    expect(out.indexOf('FIRST')).toBeLessThan(out.indexOf('SECOND'))
  })

  it('prefers the flowed lines, which are what is actually set', () => {
    const d = doc([
      text('a', {
        paragraphs: [{ runs: [{ text: 'stale source' }] }],
        flowLines: [{ x: 0, y: 0, w: 10, text: 'what is really set', lastOfPara: true, size: 10, lh: 12, align: 'left', para: 0, start: 0, end: 18 }]
      })
    ])
    expect(designText(d)).toContain('what is really set')
  })

  it('respects the character cap', () => {
    const long = 'x'.repeat(5000)
    const d = doc([text('a', { paragraphs: [{ runs: [{ text: long }] }] })])
    expect(designText(d, 200).length).toBeLessThanOrEqual(200)
  })
})

describe('the brief', () => {
  it('hands the findings over as settled fact, not as questions', () => {
    // A model that cannot see the page will hedge — "the contrast may be low"
    // — which turns a measured 2.1:1 into a maybe and teaches the reader to
    // distrust the panel.
    const p = buildAdvicePrompt(designBrief(doc([text('a')]), [advice()]))
    expect(p.system).toMatch(/as fact/i)
    expect(p.system).toMatch(/do not dispute/i)
    expect(p.system).toMatch(/hedge/i)
    expect(p.user).toContain('2.1:1')
  })

  it('asks for what measurement cannot do', () => {
    const p = buildAdvicePrompt(designBrief(doc([text('a')]), []))
    expect(p.system).toMatch(/words/i)
    expect(p.system).toMatch(/headline|idea/i)
  })

  it('tells the model to say nothing when there is nothing to say', () => {
    // Otherwise an empty finding list produces invented work, which is the
    // exact failure the measured advisor exists to avoid.
    const p = buildAdvicePrompt(designBrief(doc([text('a')]), []))
    expect(p.system).toMatch(/inventing work/i)
    expect(p.user).toMatch(/found nothing/i)
  })

  it('leaves the grounding rule to the caller in main', () => {
    // src/shared must not reach into the main process, so the system text
    // here is deliberately incomplete and main appends GROUNDING_RULE.
    const p = buildAdvicePrompt(designBrief(doc([text('a')]), []))
    expect(p.system).not.toMatch(/never present an invented specific/i)
  })

  it('includes the purpose only when given, never a guess', () => {
    const withPurpose = buildAdvicePrompt(designBrief(doc([text('a')]), [], { purpose: 'A conference poster' }))
    expect(withPurpose.user).toContain('A conference poster')
    const without = buildAdvicePrompt(designBrief(doc([text('a')]), []))
    expect(without.user).not.toMatch(/what this is for/i)
  })

  it('says plainly when the page has no text, rather than sending an empty section', () => {
    const p = buildAdvicePrompt(designBrief(doc([]), []))
    expect(p.user).toMatch(/no text yet/i)
  })

  it('lists every finding with its severity', () => {
    const p = buildAdvicePrompt(
      designBrief(doc([text('a')]), [
        advice(),
        advice({ id: 'x', rule: 'measure-long', severity: 'suggestion', title: 'Lines are long', detail: 'Narrow the frame.' })
      ])
    )
    expect(p.user).toContain('[problem]')
    expect(p.user).toContain('[suggestion]')
    expect(p.user).toContain('Lines are long')
  })

  it('is deterministic', () => {
    const body = doc([text('a')])
    const a = buildAdvicePrompt(designBrief(body, [advice()]))
    const b = buildAdvicePrompt(designBrief(body, [advice()]))
    expect(a).toEqual(b)
  })
})

describe('the brief on the wire', () => {
  // designBrief() runs in the renderer and buildAdvicePrompt() in main, so a
  // brief crosses a process boundary. What main reads is what main clamps.
  it('carries facts, not the document', () => {
    const b = designBrief(doc([text('a')]), [advice()], { purpose: 'A poster' })
    expect(Object.keys(b).sort()).toEqual(['digest', 'findings', 'purpose', 'text'])
    expect(b.findings).toEqual([
      { severity: 'problem', title: 'Text is too pale to read (2.1:1)', detail: 'This needs at least 4.5:1 against its background.' }
    ])
    // No element, no id, no image bytes: a design with embedded images is
    // megabytes, and none of those bytes say anything a model could act on.
    expect(JSON.stringify(b)).not.toContain('"id"')
  })

  it('omits the purpose when it is blank rather than sending an empty one', () => {
    expect(designBrief(doc([]), [], { purpose: '   ' }).purpose).toBeUndefined()
  })

  it('clamps what arrived, so the prompt cannot be stuffed', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ severity: 'problem', title: `t${i}`, detail: 'd' }))
    const c = clampBrief({ digest: 'd'.repeat(5000), findings: many, text: 'x'.repeat(50_000), purpose: 'p'.repeat(5000) })
    expect(c.findings).toHaveLength(24)
    expect(c.text.length).toBe(4000)
    expect(c.digest.length).toBe(600)
    expect(c.purpose?.length).toBe(400)
  })

  it('survives a brief that is the wrong shape entirely', () => {
    const c = clampBrief({ findings: 'not an array' } as unknown as ReturnType<typeof designBrief>)
    expect(c).toEqual({ digest: '', findings: [], text: '' })
    // And still builds a prompt that says what is true: nothing measured, no text.
    const p = buildAdvicePrompt(c)
    expect(p.user).toMatch(/found nothing/i)
    expect(p.user).toMatch(/no text yet/i)
  })

  it('leaves a clamped finding a plain object, with nothing extra riding along', () => {
    const c = clampBrief({
      digest: 'd',
      findings: [{ severity: 'problem', title: 't', detail: 'x', extra: 'ignored' } as unknown as { severity: string; title: string; detail: string }],
      text: ''
    })
    expect(Object.keys(c.findings[0]).sort()).toEqual(['detail', 'severity', 'title'])
  })
})

describe('the change key', () => {
  // The panel reviews proactively, so it needs to know when the document has
  // changed in a way the model would answer differently — not merely that
  // React re-rendered.
  const base = (): ReturnType<typeof designBrief> => designBrief(doc([text('a')]), [advice()])

  it('is the same for two equal briefs', () => {
    expect(briefKey(base())).toBe(briefKey(base()))
  })

  it('changes when the words change', () => {
    const other = designBrief(doc([text('a', { paragraphs: [{ runs: [{ text: 'Something else' }] }] })]), [advice()])
    expect(briefKey(other)).not.toBe(briefKey(base()))
  })

  it('changes when a finding appears or clears', () => {
    expect(briefKey(designBrief(doc([text('a')]), []))).not.toBe(briefKey(base()))
  })

  it('changes when the purpose is given', () => {
    expect(briefKey(designBrief(doc([text('a')]), [advice()], { purpose: 'A poster' }))).not.toBe(briefKey(base()))
  })

  it('is short enough to hold in state', () => {
    expect(briefKey(base()).length).toBeLessThan(24)
  })
})
