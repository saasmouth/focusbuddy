import { describe, it, expect } from 'vitest'
import { mergeTextMentions } from '../../src/main/ai/anthropic'
import { serialiseMention } from '../../src/shared/mentionText'

// The join that makes @ carry context everywhere: a reference typed into
// ordinary text must reach the model the same way one picked from the
// assistant's own picker does.

const desk = serialiseMention({ kind: 'desk', id: 'd1', title: 'Ridge St' })
const doc = serialiseMention({ kind: 'document', id: 'doc1', title: 'Brief' })
const msg = (content: string, role = 'user') => ({ role, content })

describe('mergeTextMentions', () => {
  it('lifts a mention out of the message text', () => {
    const out = mergeTextMentions(undefined, [msg(`look at ${desk}`)])
    expect(out).toEqual([{ kind: 'desk', id: 'd1', title: 'Ridge St', taskId: null }])
  })

  it('keeps explicit references and adds the text ones', () => {
    const explicit = [{ kind: 'widget' as const, id: 'w1', title: 'Notes', taskId: 't1' }]
    const out = mergeTextMentions(explicit, [msg(`and ${desk}`)])
    expect(out?.map((m) => m.id).sort()).toEqual(['d1', 'w1'])
  })

  it('does not duplicate a reference that is in both', () => {
    const explicit = [{ kind: 'desk' as const, id: 'd1', title: 'Ridge St', taskId: 'd1' }]
    const out = mergeTextMentions(explicit, [msg(`again ${desk}`)])
    expect(out).toHaveLength(1)
    // The explicit one wins: the picker carried a taskId the text form may not.
    expect(out?.[0].taskId).toBe('d1')
  })

  it('reads ONLY the last user message', () => {
    // Re-including earlier turns would grow forced context without bound — the
    // same document handed over five times because it was mentioned five turns
    // ago.
    const out = mergeTextMentions(undefined, [
      msg(`old ${doc}`),
      msg('assistant reply', 'assistant'),
      msg(`new ${desk}`)
    ])
    expect(out?.map((m) => m.id)).toEqual(['d1'])
  })

  it('ignores mentions in an assistant turn', () => {
    const out = mergeTextMentions(undefined, [msg(`cited ${doc}`, 'assistant')])
    expect(out).toBeUndefined()
  })

  it('leaves the explicit list untouched when the text has none', () => {
    const explicit = [{ kind: 'desk' as const, id: 'x', title: 'X', taskId: null }]
    expect(mergeTextMentions(explicit, [msg('no mentions here')])).toBe(explicit)
  })

  it('survives empty and missing input', () => {
    expect(mergeTextMentions(undefined, undefined)).toBeUndefined()
    expect(mergeTextMentions(undefined, [])).toBeUndefined()
    expect(mergeTextMentions(undefined, [msg('')])).toBeUndefined()
  })

  it('carries several distinct references from one message', () => {
    const out = mergeTextMentions(undefined, [msg(`${desk} and ${doc}`)])
    expect(out?.map((m) => m.kind).sort()).toEqual(['desk', 'document'])
  })
})
