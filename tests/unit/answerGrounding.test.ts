// The answer grounding rule, the checker's times and opening hours, and the
// "check this" marking (4.3.41: "Support is open 24/7" stated from nothing).
import { describe, it, expect } from 'vitest'
import { GROUNDING_RULE, GROUNDING_RULE_ANSWER } from '../../src/main/ai/groundingRules'
import { GROUNDING_RULE_ANSWER_SMALL, GROUNDING_RULE_SMALL, checkInventedSpecifics } from '../../src/main/ai/inventedSpecifics'
import { answerRule, groundAnswer, hasAnswerRule, ANSWER_GAP } from '../../src/main/ai/answerGrounding'
import { checkSpansFor, checkSummary, splitCheck, ANSWER_GAP as UI_GAP } from '../../src/renderer/src/lib/checkThis'

describe('the answer rule', () => {
  it('says what to do instead of guessing, and pins its key instructions', () => {
    expect(GROUNDING_RULE_ANSWER).toMatch(/must come from the\s+material supplied/)
    expect(GROUNDING_RULE_ANSWER).toContain('Your documents don\'t say')
    expect(GROUNDING_RULE_ANSWER).toMatch(/offer to answer such a gap from general knowledge, but only as an offer/)
    expect(GROUNDING_RULE_ANSWER).toMatch(/label it clearly as general knowledge/)
    expect(GROUNDING_RULE_ANSWER).toMatch(/after every figure, time, date or price/)
    expect(GROUNDING_RULE_ANSWER_SMALL).toMatch(/Never guess a number, time, opening hours, date, price or name/)
    expect(GROUNDING_RULE_ANSWER_SMALL).toContain('Your documents don\'t say')
  })
  it('is its own variant, not the document rule (no placeholders in an answer)', () => {
    expect(GROUNDING_RULE_ANSWER).not.toContain(GROUNDING_RULE.trim())
    expect(GROUNDING_RULE_ANSWER_SMALL).not.toContain(GROUNDING_RULE_SMALL.trim())
    expect(answerRule(true)).toBe(GROUNDING_RULE_ANSWER_SMALL)
    expect(answerRule(false)).toBe(GROUNDING_RULE_ANSWER)
    expect(hasAnswerRule(`x ${GROUNDING_RULE_ANSWER} y`)).toBe(true)
    expect(hasAnswerRule('x')).toBe(false)
  })
  it('the UI marks the same gap text main writes', () => {
    expect(UI_GAP).toBe(ANSWER_GAP)
  })
})

describe('the checker: times and opening hours', () => {
  const SRC = 'The support desk is staffed Monday to Friday, 9am to 5pm Sydney time. Ticket 2470 was closed on 14 June.'
  const spans = (out: string, src = SRC): string[] => checkInventedSpecifics(out, src).flagged.map((f) => f.span)
  it('catches what the sources never say', () => {
    expect(spans('Support is open 24/7.')).toEqual(['24/7'])
    expect(spans('Support answers 24 hours a day, around the clock.').sort()).toEqual(['24 hours a day', 'around the clock'])
    expect(spans('It opens at 8:30 am and closes at 18:00.').sort()).toEqual(['18:00', '8:30 am'])
    expect(spans('It is staffed Saturday to Sunday.')).toEqual(['Saturday to Sunday'])
    expect(spans('Refunds stopped on 3 March.')).toEqual(['3 March'])
    expect(checkInventedSpecifics('Open 24/7', SRC).flagged[0]).toMatchObject({ kind: 'time', confidence: 'high' })
  })
  it('accepts what they do say, however it is written', () => {
    expect(spans('Support is staffed Mon - Fri, 9 am to 5 pm.')).toEqual([])
    expect(spans('Support is staffed Monday to Friday, 9:00am–5:00pm.')).toEqual([])
    expect(spans('It was closed on 14 June.')).toEqual([])
  })
  it('never grounds a time on stray digits ("2470" does not make "24/7")', () => {
    expect(spans('Open 24/7.')).toEqual(['24/7'])
  })
})

describe('groundAnswer', () => {
  const SRC = 'After 30 days we offer store credit only.'
  it('on the device: repairs high-confidence specifics into an honest gap', () => {
    const g = groundAnswer('Store credit after 30 days. Support is open 24/7.', SRC, true)
    expect(g.text).toBe(`Store credit after 30 days. Support is open ${ANSWER_GAP}.`)
    expect(g.grounding?.repaired.map((f) => f.span)).toEqual(['24/7'])
  })
  it('from cloud AI: changes nothing, flags it', () => {
    const g = groundAnswer('Support is open 24/7.', SRC, false)
    expect(g.text).toBe('Support is open 24/7.')
    expect(g.grounding).toMatchObject({ path: 'cloud', repaired: [], flagged: [{ span: '24/7' }] })
  })
  it('a grounded answer has no grounding at all', () => {
    expect(groundAnswer('After 30 days we offer store credit only [1].', SRC, true)).toEqual({ text: 'After 30 days we offer store credit only [1].' })
  })
})

describe('"check this" marks', () => {
  const g = { path: 'local' as const, repaired: [{ span: '24/7', kind: 'time', confidence: 'high' as const, reason: 'opening hours that are not in the source material' }], flagged: [{ span: '$15', kind: 'money', confidence: 'high' as const, reason: 'a monetary figure that is not in the brief' }] }
  it('marks flagged spans and the gaps, nothing else', () => {
    const parts = splitCheck(`Support is open ${ANSWER_GAP} and costs $15 [1].`, checkSpansFor(g))
    expect(parts.filter((p) => p.check).map((p) => p.text)).toEqual([ANSWER_GAP, '$15'])
    expect(parts.map((p) => p.text).join('')).toBe(`Support is open ${ANSWER_GAP} and costs $15 [1].`)
    expect(parts.find((p) => p.text === ANSWER_GAP)?.check).toMatch(/“24\/7”, which your documents do not say/)
  })
  it('says in one line what was marked', () => {
    expect(checkSummary(g)).toBe('One detail your documents do not support was taken out; one detail is not in your documents: check it before relying on this.')
    expect(checkSummary(undefined)).toBeNull()
  })
})
