// @vitest-environment node
// Grounding review around d2's invented-specifics checker: the local path
// repairs only high-confidence findings, the cloud path only reports, and a
// JSON reply keeps its structure.
import { describe, it, expect } from 'vitest'
import { GROUNDING_RULE } from '../../src/main/ai/groundingRules'
import { GROUNDING_RULE_SMALL } from '../../src/main/ai/inventedSpecifics'
import { isContentWriting, withSmallRule, reviewOutput, reviewProse } from '../../src/main/ai/local/groundingCheck'

describe('grounding review', () => {
  it('recognises content-writing prompts by the rule, and swaps in the small rule', () => {
    const sys = 'Write a document.' + GROUNDING_RULE
    expect(isContentWriting(sys)).toBe(true)
    expect(isContentWriting('Classify this.')).toBe(false)
    const small = withSmallRule(sys)
    expect(small).toContain(GROUNDING_RULE_SMALL)
    expect(small).not.toContain(GROUNDING_RULE)
    expect(isContentWriting(small)).toBe(true)
  })

  it('repairs high-confidence invented specifics and leaves supplied ones alone', () => {
    const supplied = 'Write a launch note. Budget is $60,000.'
    const out = 'Our budget is $60,000 and revenue grew 18% to $412,000 last quarter.'
    const r = reviewProse(out, supplied, true)
    expect(r.text).toContain('$60,000')
    expect(r.text).not.toContain('18%')
    expect(r.text).not.toContain('$412,000')
    expect(r.text).toMatch(/\[percentage\]/)
    expect(r.repaired.every((f) => f.confidence === 'high')).toBe(true)
  })

  it('never rewrites when repair is off (the cloud path): it only reports', () => {
    const out = 'Revenue grew 18% to $412,000.'
    const r = reviewOutput(out, 'Write a note.', false)
    expect(r.text).toBe(out)
    expect(r.repaired).toEqual([])
    expect(r.flagged.length).toBeGreaterThan(0)
  })

  it('reviews JSON string by string and keeps the structure parseable', () => {
    const out = '{"title":"Q3","slides":[{"id":"s1","title":"Numbers","bullets":["Retention rose to 85%","Revenue: $4,200 per client"]}]}'
    const r = reviewOutput(out, 'A deck about our quarter.', true)
    const parsed = JSON.parse(r.text)
    expect(parsed.slides[0].id).toBe('s1')
    expect(parsed.slides[0].bullets.join(' ')).not.toMatch(/85%|\$4,200/)
    expect(r.repaired.length).toBeGreaterThanOrEqual(2)
  })
})
