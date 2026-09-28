import { describe, it, expect } from 'vitest'
import { claimsCompletedWork, unbackedClaimNotice } from '../../src/main/ai/claimCheck'
import { buildChatResponse } from '../../src/main/ai/anthropic'

// The failure this exists for: Plexii writes "I've added a table to your desk",
// emits no actions at all, and nothing contradicts it. There is no malformed
// entry to count and no truncation to report, so every other check passes while
// the user reads a finished sentence about work that was never done and waits for
// a card that is never coming.
//
// The negative cases below matter more than the positive ones. A false positive
// staples "**Nothing above was actually created**" onto a perfectly good answer,
// which is worse than the silence it replaces — so offering, suggesting and
// explaining must never trigger it.

describe('a completed claim about workspace work is caught', () => {
  const claims = [
    "I've added a table to your desk.",
    'I have created a page for the launch plan.',
    'I created a desk for the Q3 launch.',
    "I've set up a checklist with the five steps.",
    'Added three rows to the Leads table.',
    'Created a sticky note with those numbers.',
    "I've updated the budget spreadsheet.",
    "I've put a timer on the desk.",
    'Set up a tracker desk with a table and a page.',
    "I've just added the subtask under this desk."
  ]
  for (const c of claims) {
    it(`catches: ${c}`, () => expect(claimsCompletedWork(c)).toBe(true))
  }
})

describe('offering, suggesting and explaining are never caught', () => {
  const fine = [
    // Offers — the ordinary, correct behaviour, and the offer is the affordance.
    'I can create a table for that if you like.',
    'Would you like me to add a page for this?',
    'Shall I set up a desk for the launch?',
    'Want me to put a checklist on the desk?',
    "I'll add the table once you confirm the columns.",
    'I could build you a tracker with a table and a timer.',
    // Instructions to the user, not claims about the assistant.
    'You can add a widget from the toolbar on the right.',
    "You'd need to create a desk first, then add the table.",
    // Descriptions with no completed claim.
    'Your desk has three widgets on it: a table, a page and a timer.',
    'The table already has nine rows.',
    'A desk is where widgets live.',
    // Completed claims about things that are NOT workspace objects.
    "I've read through the transcript.",
    "I've summarised the page you had open.",
    "I've searched your files for it.",
    ''
  ]
  for (const f of fine) {
    it(`leaves alone: ${f || '(empty reply)'}`, () => expect(claimsCompletedWork(f)).toBe(false))
  }
})

describe('judging happens per sentence', () => {
  it('an offer elsewhere does not excuse a completed claim', () => {
    // Both in one reply. The claim is still a claim.
    const reply = "I've added a table to your desk. I can also set up a page if you want one."
    expect(claimsCompletedWork(reply)).toBe(true)
  })

  it('a workspace noun far from the claim does not manufacture one', () => {
    // "created" here is about the summary, not the desk mentioned later.
    const reply = "I've created a summary of what you asked.\n\nA desk would be the place for it."
    expect(claimsCompletedWork(reply)).toBe(false)
  })

  it('mid-sentence prose is not a headless claim', () => {
    // "created a table" appears, but only inside a conditional explanation.
    expect(claimsCompletedWork('Once the desk is created a table can be added to it.')).toBe(false)
  })
})

describe('the notice contradicts rather than annotates', () => {
  it('leads with the correction, because the prose above already promised it', () => {
    const n = unbackedClaimNotice()
    expect(n.startsWith('**Nothing above was actually created.**')).toBe(true)
  })

  it('says what to do next instead of only reporting failure', () => {
    expect(unbackedClaimNotice()).toMatch(/ask me again/i)
  })
})

// ── Integration: the net has to fire through the real response builder ───────

const build = (envelope: Record<string, unknown>) =>
  buildChatResponse(JSON.stringify(envelope), [])

describe('the whole response path contradicts an unbacked claim', () => {
  it('adds the correction when the reply claims work and no action was emitted', () => {
    const r = build({ reply: "I've added a table to your desk with the three columns.", actions: [] })
    expect(r?.ok).toBe(true)
    expect(r?.proposals).toBeUndefined()
    expect(r?.message?.content).toContain('Nothing above was actually created')
  })

  it('stays quiet when the claim is backed by a real card', () => {
    const r = build({
      reply: "I've added a table to your desk.",
      actions: [{ kind: 'create-table', title: 'Leads', columns: [{ label: 'Name', type: 'text' }] }]
    })
    expect(r?.proposals?.length).toBe(1)
    expect(r?.message?.content).not.toContain('Nothing above was actually created')
  })

  it('stays quiet on an ordinary answer that claims nothing', () => {
    const r = build({ reply: 'Your desk has three widgets on it.', actions: [] })
    expect(r?.message?.content).not.toContain('Nothing above was actually created')
  })

  it('stays quiet when the model asked a question instead of acting', () => {
    // The question IS the affordance; an offer is not a claim.
    const r = build({
      reply: 'I can set up a desk for this.',
      actions: [],
      question: { prompt: 'Shall I create it?', options: ['Yes', 'Not yet'] }
    })
    expect(r?.message?.content).not.toContain('Nothing above was actually created')
  })

  it('defers to the existing notice when something measurably went wrong', () => {
    // A dropped action already explains itself; two notices would be noise.
    const r = build({
      reply: "I've added a table to your desk.",
      actions: [{ kind: 'not-a-real-kind', title: 'x' }]
    })
    const c = r?.message?.content ?? ''
    expect(c).toContain('Nothing above was actually applied')
    expect(c).not.toContain('Nothing above was actually created')
  })
})

describe('an unapplicable action is reported instead of vanishing', () => {
  it('counts an open-url that is not a web address', () => {
    // It used to be filtered between the parser and the cards without touching
    // `dropped`, so this reply reported nothing wrong and offered nothing.
    const r = build({
      reply: 'Opening that for you.',
      actions: [{ kind: 'open-url', url: 'the Projects page', title: 'Projects' }]
    })
    expect(r?.proposals).toBeUndefined()
    expect(r?.message?.content).toContain('Nothing above was actually applied')
  })
})
