import { describe, it, expect } from 'vitest'
import {
  classifyByRules,
  scanDeadline,
  needsDeadlineClarification,
  titleFromCapture,
  isActionableClass,
  Q1_CONFIDENCE_THRESHOLD,
  splitCompound,
  secondaryCaptures,
  MAX_SECONDARY_INTENTS,
  needsCleanup,
  qualifiesForTidy,
  lightTidyTitle
} from '../../src/main/ai/intentRules'

// Attention S5 — the deterministic classifier rules (R011's fast path: these
// captures never pay model latency) and DEC-016's Q1 machinery. Includes the
// synthesis's deterministic scenarios (analysis/20 Δ12) at the rules level.

const NOW = new Date('2026-08-25T10:00:00') // a Tuesday

// DEC-144: Attention was renamed Focus and its items are "tasks"; these pins follow the new words.
describe('hard triggers — every class, deterministically', () => {
  const cases: Array<[string, string]> = [
    ['Remind me to call Bob about the lease', 'to_do'],
    ['need to send the invoice today', 'to_do'],
    ["don't forget the standup notes", 'to_do'],
    ['todo: fix the login flow', 'to_do'],
    ['Can you review the pricing doc before Thursday?', 'to_review'],
    ['Need your sign-off on the proposal', 'to_review'],
    ['Decide whether we sponsor the meetup', 'to_decide'],
    ['need to decide on the venue by friday', 'to_decide'], // decision outranks the bare to-do verb
    ['make a call on the pricing tiers', 'to_decide'],
    ['Reply to Sarah about the renewal', 'to_respond'],
    ['get back to the landlord tomorrow', 'to_respond'],
    ['Just confirming you got the contract', 'to_respond'], // acknowledgment merged in
    ['Schedule a 30-min sync Thursday afternoon', 'to_meet'],
    ['book time with the design team next week', 'to_meet'],
    ['fyi: the vendor moved the deadline', 'to_know'],
    ['Note to self: the API key rotates monthly', 'to_know'],
    ['Bring up at next 1:1 — the hiring plan', 'to_discuss'],
    ["Let's discuss the rebrand direction", 'to_discuss'],
    ['What is the wifi password?', 'to_respond'] // question → words owed back (alignment's T-5 fix)
  ]
  it.each(cases)('"%s" → %s', (text, expected) => {
    const r = classifyByRules(text)
    expect(r?.intentClass).toBe(expected)
    expect(r?.confidence).toBeGreaterThanOrEqual(Q1_CONFIDENCE_THRESHOLD)
  })

  it('idea language files lightly — unless an explicit action verb outranks it', () => {
    // The live-QA case: an idea capture must not become a task.
    expect(classifyByRules('Flesh out LakeDash idea — DoorDash but on lakes')?.intentClass).toBe(
      'to_remember'
    )
    expect(classifyByRules('what if we bundled the onboarding into one desk')?.intentClass).toBe(
      'to_remember'
    )
    // An explicit commitment keeps its to-do routing even when it says "idea".
    expect(classifyByRules('need to flesh out the pricing idea by friday')?.intentClass).toBe(
      'to_do'
    )
  })

  it('short idle fragments become loose thoughts; long ambiguous prose goes to the model', () => {
    expect(classifyByRules('mountain cabin idea')?.intentClass).toBe('to_remember')
    expect(classifyByRules('')?.intentClass).toBe('to_remember')
    expect(
      classifyByRules(
        'The vendor conversation yesterday went in an interesting direction around pricing tiers and support'
      )
    ).toBeUndefined() // model territory
  })
})

describe('deadline scanning — resolvable anchors vs the Q1 trigger', () => {
  it('resolves weekday, tomorrow, today, next week silently', () => {
    const thu = scanDeadline('review the doc by thursday', NOW)
    expect(thu?.dueAt).toBeTruthy()
    expect(new Date(thu!.dueAt!).getDay()).toBe(4) // Thursday
    expect(new Date(thu!.dueAt!).getTime()).toBeGreaterThan(NOW.getTime())
    const tmrw = scanDeadline('send it tomorrow', NOW)
    expect(new Date(tmrw!.dueAt!).getDate()).toBe(26)
    expect(scanDeadline('finish today', NOW)?.dueAt).toBeTruthy()
    const nextWeek = scanDeadline('due next week', NOW)
    expect(new Date(nextWeek!.dueAt!).getDay()).toBe(1) // Monday
  })

  it('flags UNANCHORED deadline language for the one Q1 question', () => {
    for (const text of ['do this asap', 'need it before the launch', 'send by the deadline']) {
      const scan = scanDeadline(text, NOW)
      expect(scan, text).not.toBeNull()
      expect(scan!.dueAt, text).toBeNull()
    }
  })

  it('plain text with no deadline language scans null', () => {
    expect(scanDeadline('review the pricing doc', NOW)).toBeNull()
  })

  it('Q1 fires ONLY for unanchored deadlines on actionable classes (DEC-016)', () => {
    const unanchored = { phrase: 'asap', dueAt: null }
    const anchored = { phrase: 'by thursday', dueAt: '2026-08-27T17:00:00.000Z' }
    expect(needsDeadlineClarification('to_do', unanchored)).toBe(true)
    expect(needsDeadlineClarification('to_review', unanchored)).toBe(true)
    expect(needsDeadlineClarification('to_decide', unanchored)).toBe(true) // "decide by…" binds
    expect(needsDeadlineClarification('to_respond', unanchored)).toBe(true) // "reply by…" binds
    expect(needsDeadlineClarification('to_do', anchored)).toBe(false) // silent anchor
    expect(needsDeadlineClarification('to_know', unanchored)).toBe(false) // not actionable
    expect(needsDeadlineClarification('to_remember', unanchored)).toBe(false)
    expect(needsDeadlineClarification('to_do', null)).toBe(false)
  })
})

describe('Δ12 scenarios at the rules level', () => {
  it('mixed-intent review with resolvable deadline files silently as review + due', () => {
    const text = "Here's the new pricing doc. Can you review it before Thursday?"
    const r = classifyByRules(text)
    const scan = scanDeadline(text, NOW)
    expect(r?.intentClass).toBe('to_review')
    expect(scan?.dueAt).toBeTruthy()
    expect(needsDeadlineClarification(r!.intentClass, scan)).toBe(false)
  })

  it('a scheduling hold classifies without touching the calendar machinery', () => {
    expect(classifyByRules("Let's schedule a 30-min sync Thursday afternoon")?.intentClass).toBe(
      'to_meet'
    )
  })

  it('actionable-class helper matches the DEC-016 set (alignment: decide/respond joined)', () => {
    expect(isActionableClass('to_do')).toBe(true)
    expect(isActionableClass('to_review')).toBe(true)
    expect(isActionableClass('to_meet')).toBe(true)
    expect(isActionableClass('to_decide')).toBe(true)
    expect(isActionableClass('to_respond')).toBe(true)
    expect(isActionableClass('to_know')).toBe(false)
    expect(isActionableClass('to_discuss')).toBe(false)
    expect(isActionableClass('to_remember')).toBe(false)
  })
})

describe('title extraction', () => {
  it('takes the first sentence, strips capture prefixes, caps length', () => {
    expect(titleFromCapture('fyi: the vendor moved the deadline. Also more detail here.')).toBe(
      'The vendor moved the deadline.'
    )
    // Capture rebuild (2026-08-30): scaffolding lead-ins are stripped —
    // "remind me to" told the AI what you meant; the item keeps the verb.
    expect(titleFromCapture('Remind me to call Bob')).toBe('Call Bob')
    expect(titleFromCapture('x'.repeat(200)).length).toBeLessThanOrEqual(120)
    expect(titleFromCapture('   ')).toBe('Untitled task')
  })
})

describe('DEC-025 — multi-intent captures (deterministic splitter)', () => {
  it('a weak "and" cuts ONLY when the right side trips its own trigger', () => {
    expect(splitCompound('call Bob Thursday and review the deck before standup')).toEqual([
      'call Bob Thursday',
      'review the deck before standup'
    ])
    // Compound OBJECT, single intent — never split.
    expect(splitCompound('remind me to call Bob and Alice by Thursday')).toEqual([
      'remind me to call Bob and Alice by Thursday'
    ])
    // No trigger on the right — no cut.
    expect(splitCompound('remind me to call Bob and enjoy the weather')).toEqual([
      'remind me to call Bob and enjoy the weather'
    ])
  })

  it('strong separators always cut; three-way compounds chain', () => {
    expect(splitCompound('remind me to email the invoice; schedule a sync with Caleb tomorrow')).toEqual([
      'remind me to email the invoice',
      'schedule a sync with Caleb tomorrow'
    ])
    expect(
      splitCompound('remind me to call Bob and review the deck and schedule a sync tomorrow')
    ).toEqual(['remind me to call Bob', 'review the deck', 'schedule a sync tomorrow'])
  })

  it('secondaries: rules-only, own class + anchored date, non-triggering tails skipped', () => {
    const s = secondaryCaptures(
      'remind me to call Bob today and review the deck before standup',
      NOW
    )
    expect(s).toHaveLength(1)
    expect(s[0].intentClass).toBe('to_review')
    // Light tidy (DEC-043) capitalizes secondaries the same as primaries.
    expect(s[0].title).toBe('Review the deck before standup')
    expect(s[0].dueAt).toBeNull() // "before standup" is vague — files dateless, no Q1
    const anchored = secondaryCaptures('need to send the invoice; schedule a sync tomorrow', NOW)
    expect(anchored[0].intentClass).toBe('to_meet')
    expect(anchored[0].dueAt).not.toBeNull()
    // A strong-split tail with no trigger of its own is NOT offered.
    expect(secondaryCaptures('remind me to call Bob\nthe weather was lovely out there', NOW)).toEqual([])
    // Simple captures carry none.
    expect(secondaryCaptures('remind me to call Bob', NOW)).toEqual([])
  })

  it('caps at MAX_SECONDARY_INTENTS', () => {
    const s = secondaryCaptures(
      'remind me to call Bob; review the deck; schedule a sync; discuss the roadmap; approve the budget',
      NOW
    )
    expect(s.length).toBe(MAX_SECONDARY_INTENTS)
  })
})

describe('DEC-026 — the cleanup gate (deterministic, pure)', () => {
  it('clean short captures never qualify', () => {
    expect(needsCleanup('Remind me to call Bob today')).toBe(false)
    expect(needsCleanup('fyi: the vendor moved the deadline to Friday.')).toBe(false)
    expect(needsCleanup('')).toBe(false)
  })

  it('long, filler-dense, or unpunctuated run-ons qualify', () => {
    // 30+ words.
    expect(
      needsCleanup(
        'so I was talking to the vendor about the contract terms and they said the pricing model changes next quarter which means we need to redo the projections for the board deck next month'
      )
    ).toBe(true)
    // Filler-dense.
    expect(needsCleanup('so basically we need the thing, you know, for the launch')).toBe(true)
    // 18+ words, zero sentence punctuation.
    expect(
      needsCleanup(
        'need to grab the numbers from finance then fold them into the deck before the call with the team'
      )
    ).toBe(true)
  })
})

describe('DEC-040 — when the preview attempts a tidy at all', () => {
  it('anything with real content qualifies — the old gate left medium captures raw', () => {
    // 8+ words: the operator's ordinary captures.
    expect(qualifiesForTidy('draft the cetra pitch deck for friday with pricing tiers')).toBe(true)
    // Multi-sentence, even when short.
    expect(qualifiesForTidy('Call Bob. He has the numbers.')).toBe(true)
    // Notes attached always qualify — there is something to clean.
    expect(qualifiesForTidy('call Bob', 'he wants the revised pricing tiers before the board call')).toBe(true)
    // The classic messiness signs still qualify on their own.
    expect(qualifiesForTidy('so basically we need the thing, you know, for the launch')).toBe(true)
  })

  it('tiny fragments still skip — "call Bob Thursday" IS its own tidy', () => {
    expect(qualifiesForTidy('call Bob Thursday')).toBe(false)
    expect(qualifiesForTidy('')).toBe(false)
    expect(qualifiesForTidy('   ')).toBe(false)
  })
})

describe('DEC-043 — light tidy: capitalization without a model call', () => {
  it('the operator’s own example: "call bob thursday" → "Call Bob Thursday"', () => {
    expect(lightTidyTitle('call bob thursday')).toBe('Call Bob Thursday')
    expect(titleFromCapture('call bob thursday')).toBe('Call Bob Thursday')
  })

  it('only ADDS capitals — deliberate casing and stopwords survive', () => {
    expect(lightTidyTitle('call the notary')).toBe('Call the notary')
    expect(lightTidyTitle('ship the iPhone build')).toBe('Ship the iPhone build')
    expect(lightTidyTitle('remind me to breathe')).toBe('Remind me to breathe')
    // Idempotent: tidying a tidy changes nothing.
    expect(lightTidyTitle(lightTidyTitle('call bob thursday'))).toBe('Call Bob Thursday')
  })

  it('standalone i, weekdays and months — but "may" stays a verb', () => {
    expect(lightTidyTitle('i owe caleb a reply on friday')).toBe('I owe caleb a reply on Friday')
    expect(lightTidyTitle('may need to review the january numbers')).toBe(
      'May need to review the January numbers'
    )
    // 'may' mid-sentence is untouched (only the first-letter rule hit above).
    expect(lightTidyTitle('we may need this')).toBe('We may need this')
  })

  it('the tidy bar sits at FIVE words now', () => {
    expect(qualifiesForTidy('draft the cetra pitch deck')).toBe(true) // 5 words
    expect(qualifiesForTidy('call bob on thursday')).toBe(false) // 4 — light tidy covers it
  })
})
