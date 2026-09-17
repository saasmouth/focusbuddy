// The assistant must never promise work it did not do.
//
// Reported by the user: asked to edit three documents on a desk, the assistant
// replied "applying it now", showed an empty action list, and said nothing
// about why. Asked again three times, it did the same thing each time. The
// cause was a truncated envelope — the model was cut off at the token cap part
// way through the first edit-document body, every action was dropped by the
// parser, and the only notice in the code was gated on at least one action
// having SURVIVED. It fired when it was least needed and stayed silent when it
// was most needed.
import { describe, it, expect } from 'vitest'
import { actionOutcomeNotice, parseChatJson } from '../../src/main/ai/anthropic'

describe('actionOutcomeNotice', () => {
  it('says nothing when everything the model asked for is on offer', () => {
    expect(actionOutcomeNotice({ applied: 3, dropped: 0, truncated: false })).toBeNull()
    expect(actionOutcomeNotice({ applied: 0, dropped: 0, truncated: false })).toBeNull()
  })

  it('speaks up for a cutoff that left no action behind to count', () => {
    // The reported bug exactly: salvage drops the torn object, so the count is
    // zero and `truncated` is the only evidence anything was attempted.
    const out = actionOutcomeNotice({ applied: 0, dropped: 0, truncated: true })!
    expect(out.startsWith('**Nothing above was actually applied.**')).toBe(true)
    expect(out).toContain('ran out of room')
    expect(out).not.toContain('the 0 changes')
  })

  it('contradicts the reply outright when nothing survived', () => {
    // Not an annotation. The reply above it already promised the work, so a
    // correction the reader has to infer is not a correction.
    const out = actionOutcomeNotice({ applied: 0, dropped: 3, truncated: true })!
    expect(out.startsWith('**Nothing above was actually applied.**')).toBe(true)
  })

  it('tells the user what to do differently when it ran out of room', () => {
    const out = actionOutcomeNotice({ applied: 0, dropped: 3, truncated: true })!
    expect(out).toContain('ran out of room')
    expect(out).toContain('one at a time')
  })

  it('names the likelier cause when it was not a cutoff', () => {
    // A rejected action is almost always an id the model invented, and the fix
    // is different from the fix for a cutoff.
    const out = actionOutcomeNotice({ applied: 0, dropped: 2, truncated: false })!
    expect(out).toContain('does not exist')
    expect(out).not.toContain('ran out of room')
  })

  it('reads correctly for a single dropped change', () => {
    const cut = actionOutcomeNotice({ applied: 0, dropped: 1, truncated: true })!
    expect(cut).toContain('the change')
    expect(cut).not.toContain('1 changes')
    const rejected = actionOutcomeNotice({ applied: 0, dropped: 1, truncated: false })!
    expect(rejected).toContain('one change')
    expect(rejected).toContain('it was')
  })

  it('reports a partial build so it is never mistaken for the whole thing', () => {
    const out = actionOutcomeNotice({ applied: 2, dropped: 0, truncated: true })!
    expect(out).toContain('first 2 items')
  })

  it('accounts for the lost ones when some did survive', () => {
    const out = actionOutcomeNotice({ applied: 1, dropped: 2, truncated: true })!
    expect(out).toContain('2 more changes')
    expect(out).not.toContain('Nothing above')
  })

  it('never claims nothing was applied when something was', () => {
    for (const truncated of [true, false]) {
      for (let applied = 1; applied <= 3; applied++) {
        const out = actionOutcomeNotice({ applied, dropped: 2, truncated })
        expect(out ?? '').not.toContain('Nothing above was actually applied')
      }
    }
  })
})

describe('parseChatJson counts what it dropped', () => {
  const body = (n: number): string => 'A'.repeat(n)

  it('reproduces the reported failure: reply survives, no actions, and it says so', () => {
    // Cut off inside the FIRST edit-document body — exactly what a request to
    // rewrite three documents in one envelope produces.
    const raw =
      '{"reply":"Adding a Current State to Future State section to each of the three audit docs.",' +
      '"actions":[{"kind":"edit-document","documentId":"doc-1","label":"Breadwinner",' +
      '"operation":"append","body":"' + body(4000)
    const out = parseChatJson(raw)!
    expect(out.reply).toContain('Current State')
    expect(out.proposals).toHaveLength(0)
    expect(out.truncated).toBe(true)
    expect(out.dropped).toBe(0)
    expect(
      actionOutcomeNotice({ applied: 0, dropped: out.dropped, truncated: out.truncated })
    ).toContain('Nothing above was actually applied')
  })

  it('salvages the ones that finished and counts only the torn one', () => {
    const raw =
      '{"reply":"Updating the three docs.",' +
      '"actions":[{"kind":"edit-document","documentId":"doc-1","label":"one","operation":"append","body":"First."},' +
      '{"kind":"edit-document","documentId":"doc-2","label":"two","operation":"append","body":"' + body(3000)
    const out = parseChatJson(raw)!
    expect(out.proposals).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })

  it('counts an action naming no document — the other way this goes silent', () => {
    const raw = JSON.stringify({
      reply: 'Updating the brief.',
      actions: [{ kind: 'edit-document', label: 'the brief', body: 'New section.' }]
    })
    const out = parseChatJson(raw)!
    expect(out.proposals).toHaveLength(0)
    expect(out.dropped).toBe(1)
    expect(out.truncated).toBe(false)
  })

  it('counts an action kind it has never heard of', () => {
    // Forward-compat means unknown kinds are skipped, but skipped is not the
    // same as unremarked: the user still asked for something and got nothing.
    const raw = JSON.stringify({
      reply: 'Doing it.',
      actions: [{ kind: 'reticulate-splines', target: 'x' }]
    })
    const out = parseChatJson(raw)!
    expect(out.proposals).toHaveLength(0)
    expect(out.dropped).toBe(1)
  })

  it('counts entries that are not objects at all', () => {
    const raw = JSON.stringify({ reply: 'Doing it.', actions: ['edit the doc', null, 7] })
    expect(parseChatJson(raw)!.dropped).toBe(3)
  })

  it('reports zero dropped for a clean response', () => {
    const raw = JSON.stringify({
      reply: 'Here you go.',
      actions: [
        { kind: 'edit-document', documentId: 'doc-1', label: 'one', body: 'Text.' },
        { kind: 'edit-document', documentId: 'doc-2', label: 'two', body: 'Text.' }
      ]
    })
    const out = parseChatJson(raw)!
    expect(out.proposals).toHaveLength(2)
    expect(out.dropped).toBe(0)
    expect(actionOutcomeNotice({ applied: 2, dropped: 0, truncated: false })).toBeNull()
  })

  it('reports zero dropped when the model proposed nothing at all', () => {
    // A plain conversational answer must never gain a failure notice.
    const raw = JSON.stringify({ reply: 'The three audits cover SEO and authority.', actions: [] })
    const out = parseChatJson(raw)!
    expect(out.dropped).toBe(0)
    expect(actionOutcomeNotice({ applied: 0, dropped: 0, truncated: false })).toBeNull()
  })
})
