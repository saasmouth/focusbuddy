// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { checkInventedSpecifics, GROUNDING_RULE_SMALL } from '../../src/main/ai/inventedSpecifics'

// The positive cases are the real ones. Every string in "the eval's actual
// findings" below is a quote from tools/local-ai-eval's judge output, where the
// CLOUD reference lost points on the office family for stating things the brief
// never contained. They are the reason this module exists, so they are the
// specification.
//
// The negative cases matter more. This is a high-precision check: if it flags
// ordinary prose, it gets switched off and the real catches go with it. So the
// "must not flag" block is deliberately longer than the "must flag" one.

const flaggedSpans = (out: string, supplied: string[] | string = []): string[] =>
  checkInventedSpecifics(out, supplied).flagged.map((f) => f.span)

describe("the eval's actual findings", () => {
  it('flags the invented client count ("two new clients from referrals")', () => {
    const brief = 'Write a short highlights slide for the studio this month.'
    const r = checkInventedSpecifics('We won two new clients from referrals.', brief)
    expect(r.clean).toBe(false)
    expect(r.flagged.some((f) => f.span.toLowerCase().includes('two new clients'))).toBe(true)
  })

  it('flags an offer the brief never made ("Spring Sale")', () => {
    const brief = 'A poster for a garden centre. Friendly, mentions the new season stock.'
    const spans = flaggedSpans('Spring Sale now on, in store this weekend.', brief)
    expect(spans).toContain('Spring Sale')
  })

  it('flags a fabricated statistic', () => {
    const brief = 'Make a deck about why tool libraries are a good idea.'
    const r = checkInventedSpecifics(
      'The average power drill is used for only 12 minutes in its entire lifetime.',
      brief
    )
    expect(r.clean).toBe(false)
    expect(r.flagged.map((f) => f.span)).toContain('12 minutes')
  })

  it("flags unsupplied facts about the user's own tools", () => {
    const brief = 'Draft an onboarding document for new engineers.'
    const r = checkInventedSpecifics(
      'Our wiki holds 400 pages of runbooks, maintained by the Platform Guild.',
      brief
    )
    expect(r.clean).toBe(false)
    expect(r.flagged.map((f) => f.kind)).toContain('name')
  })
})

describe('kinds', () => {
  it('flags money, percentages, dates and years', () => {
    const r = checkInventedSpecifics(
      'Revenue reached $1,200 in Q3 2025, up 40% since March 14, and again in 2026.',
      'Write a trading update.'
    )
    const kinds = new Set(r.flagged.map((f) => f.kind))
    expect(kinds).toContain('money')
    expect(kinds).toContain('percent')
    expect(kinds).toContain('date')
  })

  it('flags a quotation that is not in the source material', () => {
    const r = checkInventedSpecifics(
      'As the report puts it, "adoption more than tripled in the first year".',
      'Summarise the attached report.'
    )
    expect(r.flagged.some((f) => f.kind === 'quote')).toBe(true)
  })

  it('reports an index that points at the span in the original text', () => {
    const out = 'All fine here. Then suddenly $9,999 appears.'
    const r = checkInventedSpecifics(out, 'nothing supplied')
    const f = r.flagged.find((x) => x.kind === 'money')!
    expect(out.slice(f.index, f.index + f.span.length)).toBe(f.span)
  })
})

describe('grounding', () => {
  it('passes a figure the brief supplied', () => {
    const r = checkInventedSpecifics('Revenue reached $1,200 last quarter.', 'Revenue was $1,200 last quarter.')
    expect(r.clean).toBe(true)
  })

  it('ignores thousands separators when matching', () => {
    expect(checkInventedSpecifics('We served 1200 customers.', 'served 1,200 customers').clean).toBe(true)
    expect(checkInventedSpecifics('We served 1,200 customers.', 'served 1200 customers').clean).toBe(true)
  })

  it('treats a spelled-out number as grounded by its numeral', () => {
    // The likeliest false positive of all: the brief says "2", the draft says
    // "two", and a naive check calls a correctly grounded sentence invented.
    expect(checkInventedSpecifics('We signed two clients.', 'We signed 2 clients this month.').clean).toBe(true)
  })

  it('accepts grounding from any one of several supplied sources', () => {
    const r = checkInventedSpecifics('Churn fell to 3% under Maria Santos.', [
      'Q&A notes: churn is now 3%.',
      'Team: Maria Santos leads retention.'
    ])
    expect(r.clean).toBe(true)
  })
})

describe('must not flag', () => {
  it('ordinary prose with no specifics', () => {
    const r = checkInventedSpecifics(
      'This document sets out how the team approaches onboarding. It covers the ' +
        'first week, who to ask for help, and the habits that make review easier. ' +
        'Keep it short and revise it whenever the process changes.',
      'Write an onboarding doc.'
    )
    expect(r.flagged).toEqual([])
    expect(r.clean).toBe(true)
  })

  it('counts of parts of the document itself', () => {
    const r = checkInventedSpecifics(
      'There are three sections below. Step 2 covers review, and slide 4 repeats ' +
        'the summary. Each of the two columns holds one example.',
      'Make a short doc.'
    )
    expect(r.flagged).toEqual([])
  })

  it('the bracketed placeholders GROUNDING_RULE asks for', () => {
    // If this fails, the checker fights the rule it exists to enforce.
    const r = checkInventedSpecifics(
      'The launch is set for [launch date] and owned by [owner name], with a budget of [amount].',
      'Draft a launch brief.'
    )
    expect(r.flagged).toEqual([])
  })

  it('digits that are syntax, not claims', () => {
    const r = checkInventedSpecifics(
      'Put `=SUM(B2:B9)` in the total row.\n\n```\nconst port = 8080\n```\n=AVERAGE(C2:C40)',
      'Explain the formula.'
    )
    expect(r.flagged).toEqual([])
  })

  it('a sentence or heading that merely starts with a capital', () => {
    const r = checkInventedSpecifics(
      '## Purpose And Scope\n\nReview happens weekly. Next steps follow. ' +
        'Because Monday is quiet, use it for planning.',
      'Write a short process note.'
    )
    expect(r.flagged).toEqual([])
  })

  it('a name the brief itself supplied', () => {
    const r = checkInventedSpecifics(
      'Nordic Supply Co will take delivery, and Priya Raman signs it off.',
      'Draft a note about Nordic Supply Co, approved by Priya Raman.'
    )
    expect(r.clean).toBe(true)
  })

  it('an empty or whitespace output', () => {
    expect(checkInventedSpecifics('', 'anything').clean).toBe(true)
    expect(checkInventedSpecifics('   \n ', 'anything').clean).toBe(true)
  })
})

describe('precision on a realistic draft', () => {
  // The contract that decides whether this is usable at all. A full grounded
  // draft must produce NO high-confidence finding; anything louder than a
  // quiet note on good prose trains people to dismiss the check.
  const brief =
    'Write an onboarding document for new engineers joining the platform team. ' +
    'Mention code review and the on-call rota.'

  const draft = `# Engineering Onboarding

## Purpose
This document gets a new engineer productive in their first two weeks. It covers
how we review code, how the on-call rota works, and who to ask when something is
unclear. Read it once on day one, then come back to it.

## Your first week
Start by getting the service running locally. Pair with someone on the team for
the first few changes rather than reading the whole codebase alone. Ask questions
early; the team would much rather answer them than unpick a misunderstanding later.

## Code review
Every change goes through review before it merges. Keep changes small enough that
a reviewer can hold the whole thing in their head. Explain why in the description,
not just what. If a review stalls, say so in the channel rather than waiting.

## On-call
You will join the rota once you have shipped a few changes and shadowed a shift.
Being on call means triaging alerts, deciding whether something needs waking
another person, and writing up anything that will recur. You are never expected
to fix a system you have not been shown.

## Who to ask
Your onboarding buddy is the first stop for anything procedural. For questions
about a specific service, the owning team is listed in [service directory]. For
anything about pay, access or equipment, speak to [manager name].
`

  it('raises nothing high-confidence', () => {
    const r = checkInventedSpecifics(draft, brief, { minConfidence: 'high' })
    expect(r.flagged.map((f) => `${f.kind}:${f.span}`)).toEqual([])
    expect(r.clean).toBe(true)
  })

  it('raises at most one quiet note across the whole draft', () => {
    // As measured: "two weeks" as a ramp-up period, correctly low.
    const r = checkInventedSpecifics(draft, brief)
    expect(r.flagged.length).toBeLessThanOrEqual(1)
    for (const f of r.flagged) expect(f.confidence).toBe('low')
  })

  it('still catches a fabricated figure dropped into that same draft', () => {
    // Guards the test above against passing because detection is simply off.
    const seeded = draft.replace('day one', 'day one, when 94% of hires say they felt lost')
    const r = checkInventedSpecifics(seeded, brief, { minConfidence: 'high' })
    expect(r.flagged.map((f) => f.span)).toContain('94%')
  })
})

describe('confidence', () => {
  it('ranks unambiguous syntax above the looser detectors', () => {
    const r = checkInventedSpecifics('Acme Partners raised $5,000 after two setbacks.', '')
    expect(r.flagged[0].confidence).toBe('high')
    const byKind = new Map(r.flagged.map((f) => [f.kind, f.confidence]))
    expect(byKind.get('money')).toBe('high')
    expect(byKind.get('name')).toBe('medium')
  })

  it('splits numbers on form, because only the digits distinguish them', () => {
    const digitForm = checkInventedSpecifics('Used for 12 minutes.', '')
    expect(digitForm.flagged[0].confidence).toBe('medium')
    const wordForm = checkInventedSpecifics('Took two weeks.', '')
    expect(wordForm.flagged[0].confidence).toBe('low')
  })

  it('minConfidence drops everything below the floor', () => {
    const out = 'Acme Partners raised $5,000 after two setbacks.'
    expect(checkInventedSpecifics(out, '', { minConfidence: 'high' }).flagged.every((f) => f.confidence === 'high')).toBe(true)
    expect(checkInventedSpecifics(out, '', { minConfidence: 'medium' }).flagged.some((f) => f.confidence === 'low')).toBe(false)
    expect(checkInventedSpecifics(out, '').flagged.some((f) => f.confidence === 'low')).toBe(true)
  })
})

describe('HTML output', () => {
  // suggestDocContent and rewriteSelection return HTML fragments
  // (DOC_HTML_CONTRACT), so quoted attribute values are the NORMAL case for
  // them. Measured on a 3-sample local run before this was fixed: 36 of 141
  // flags were CSS out of style="...", all of them high confidence, so all of
  // them would have been repaired — and repairing a style attribute corrupts
  // the markup it is part of.
  const brief = 'Draft a kickoff email for the Pulse launch.'

  it('does not read a style attribute as a fabricated quotation', () => {
    const html =
      '<h3 style="color: #1e3c72; font-size: 18px; margin-top: 0;">Pulse Launch</h3>' +
      '<p>Follow up on the kickoff.</p>' +
      '<hr style="border: 1px solid #e0e0e0; margin: 24px 0;" />'
    const r = checkInventedSpecifics(html, brief)
    expect(r.flagged.map((f) => f.span)).toEqual([])
  })

  it('still catches an invented specific in the prose between tags', () => {
    // Guards the mask against hiding the content it sits around.
    const html =
      '<p style="color: #333">Adoption rose 40% and the file is named ' +
      '&ldquo;Pulse-Launch-2024&rdquo;.</p>'
    const spans = checkInventedSpecifics(html, brief).flagged.map((f) => f.span)
    expect(spans).toContain('40%')
  })

  it('keeps numbers in prose that merely uses angle brackets', () => {
    // The mask requires a letter after "<" so arithmetic survives.
    const r = checkInventedSpecifics('Alert when x < 5 and y > 3 for 12 minutes.', 'Describe the alert.')
    expect(r.flagged.map((f) => f.span)).toContain('12 minutes')
  })
})

describe('spans always come from the original text', () => {
  // Detectors run on a masked copy where tags, code and placeholders are NUL.
  // The quote detector's class excludes only a closing quote and a newline, so
  // it matches straight across a masked region — and before this was fixed the
  // span was sliced from the masked copy, so it came back with NUL bytes in
  // it. A caller that matches or repairs BY SPAN TEXT then skips that finding
  // silently, which is the worst failure mode available: it looks like a clean
  // draft. Found by replaying the real eval spans, not by reading the code.

  const noNul = (r: ReturnType<typeof checkInventedSpecifics>): void => {
    for (const f of r.flagged) expect(f.span).not.toMatch(/\0/)
  }

  it('a quoted phrase interrupted by a tag has no NUL in its span', () => {
    const html = '<p>The runbook says &ldquo;Escalate to <b>Engineering</b> within the hour&rdquo;.</p>'
    const r = checkInventedSpecifics(html, 'Write a support note.')
    noNul(r)
  })

  it('every reported span matches the original text at its own index', () => {
    // The invariant that makes index and span usable together: this is what a
    // caller relies on to highlight or replace, and it is cheap to assert.
    const cases = [
      '<p style="color:#333">Adoption rose 40% in &ldquo;Q3 <em>2025</em>&rdquo;.</p>',
      'Plain prose with $1,200 and 40% and Acme Partners in it.',
      'Code `const x = 40` then a real 40% claim.',
      'A placeholder [owner name] then "a quoted claim of some length here".',
      '<h3>Heading</h3><p>Introducing Lumen Flask for $39 on March 14.</p>'
    ]
    for (const text of cases) {
      const r = checkInventedSpecifics(text, '')
      noNul(r)
      for (const f of r.flagged) {
        expect(text.slice(f.index, f.index + f.span.length)).toBe(f.span)
      }
    }
  })

  it('still catches the claim inside that interrupted quote', () => {
    // Guards the fix against being "no NUL because nothing is reported".
    const html = '<p>It says &ldquo;adoption rose <b>40%</b> in the first year&rdquo;.</p>'
    const spans = checkInventedSpecifics(html, 'Summarise the report.').flagged.map((f) => f.span)
    expect(spans).toContain('40%')
  })
})

describe('options', () => {
  it('allowNewNames lets a naming exercise through but still catches figures', () => {
    const out = 'Introducing Lumen Flask, yours for $39.'
    expect(flaggedSpans(out, 'Name a new water bottle.')).toContain('Lumen Flask')
    const r = checkInventedSpecifics(out, 'Name a new water bottle.', { allowNewNames: true })
    expect(r.flagged.map((f) => f.span)).not.toContain('Lumen Flask')
    expect(r.flagged.map((f) => f.kind)).toContain('money')
  })

  it('limit caps the findings', () => {
    const out = 'Figures: $1, $2, $3, $4, $5, $6 and 7%, 8%, 9%.'
    expect(checkInventedSpecifics(out, '', { limit: 3 }).flagged).toHaveLength(3)
  })

  it('does not report the same specific twice', () => {
    const r = checkInventedSpecifics('It cost $500. Yes, $500. Really, $500.', '')
    expect(r.flagged.filter((f) => f.span === '$500')).toHaveLength(1)
  })

  it('orders the unambiguous kinds before the loosest detector', () => {
    const r = checkInventedSpecifics('Acme Partners raised $5,000 last year.', '')
    expect(r.flagged[0].kind).toBe('money')
    expect(r.flagged.map((f) => f.kind)).toContain('name')
  })
})

describe('GROUNDING_RULE_SMALL', () => {
  it('keeps the prohibition and the placeholder escape hatch', () => {
    expect(GROUNDING_RULE_SMALL).toMatch(/never state a number/i)
    expect(GROUNDING_RULE_SMALL).toMatch(/\[launch date\]/)
    expect(GROUNDING_RULE_SMALL).toMatch(/square brackets/i)
  })

  it('is short enough for a small model to still be following it', () => {
    // The whole point of the variant. If it grows past a few lines it is just
    // GROUNDING_RULE again and the local path is back where it started.
    expect(GROUNDING_RULE_SMALL.length).toBeLessThan(400)
  })
})
