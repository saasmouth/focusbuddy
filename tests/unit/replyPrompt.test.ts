import { describe, it, expect } from 'vitest'
import { buildReplyPrompt } from '../../src/main/ai/anthropic'

// "Drafted from the thread" has to be true in the prompt, not just in the UI.

const incoming = {
  subject: 'Ridge St settlement',
  from: 'sarah@example.com',
  body: 'Can we settle on the 14th?'
}
const PROFILE = 'Terse. No sign-off.'

describe('buildReplyPrompt', () => {
  it('carries the message being replied to', () => {
    const p = buildReplyPrompt(incoming, PROFILE)
    expect(p).toContain('Ridge St settlement')
    expect(p).toContain('sarah@example.com')
    expect(p).toContain('Can we settle on the 14th?')
    expect(p).toContain(PROFILE)
  })

  it('includes every earlier message when a trail is given', () => {
    const p = buildReplyPrompt(incoming, PROFILE, [
      { from: 'sarah@example.com', date: Date.UTC(2026, 8, 10), body: 'Are you free this week?' },
      { from: 'me@example.com', date: Date.UTC(2026, 8, 11), body: 'Thursday works.' }
    ])
    expect(p).toContain('Are you free this week?')
    expect(p).toContain('Thursday works.')
  })

  it('keeps the trail in order, oldest first', () => {
    const p = buildReplyPrompt(incoming, PROFILE, [
      { from: 'a@x.com', body: 'FIRSTMESSAGE' },
      { from: 'b@x.com', body: 'SECONDMESSAGE' }
    ])
    expect(p.indexOf('FIRSTMESSAGE')).toBeLessThan(p.indexOf('SECONDMESSAGE'))
  })

  it('puts the trail BEFORE the message being replied to', () => {
    const p = buildReplyPrompt(incoming, PROFILE, [{ from: 'a@x.com', body: 'EARLIERMESSAGE' }])
    expect(p.indexOf('EARLIERMESSAGE')).toBeLessThan(p.indexOf('Incoming email to reply to'))
  })

  it('tells the model the trail is context, not material to restate or embellish', () => {
    const p = buildReplyPrompt(incoming, PROFILE, [{ from: 'a@x.com', body: 'x' }])
    expect(p).toMatch(/do not\s+restate them/i)
    expect(p).toMatch(/do not invent anything they do not say/i)
  })

  it('says nothing about a thread when there is no trail', () => {
    // An empty trail must not imply one existed and was empty.
    const p = buildReplyPrompt(incoming, PROFILE, [])
    expect(p).not.toMatch(/Earlier messages in this thread/)
    expect(buildReplyPrompt(incoming, PROFILE)).not.toMatch(/Earlier messages in this thread/)
  })

  it('keeps the MOST RECENT messages when the trail is over budget', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ from: 'a@x.com', body: `MSG${i}` }))
    const p = buildReplyPrompt(incoming, PROFILE, many)
    // The recent exchange is what a reply turns on, so the oldest are dropped.
    expect(p).not.toContain('MSG0')
    expect(p).not.toContain('MSG3')
    expect(p).toContain('MSG11')
    expect(p).toContain('MSG4')
  })

  it('truncates a very long earlier message rather than blowing the budget', () => {
    const p = buildReplyPrompt(incoming, PROFILE, [{ from: 'a@x.com', body: 'z'.repeat(5000) }])
    expect(p).not.toContain('z'.repeat(1300))
  })

  it('survives a trail entry with no body or date', () => {
    const p = buildReplyPrompt(incoming, PROFILE, [
      { from: 'a@x.com', body: undefined as never }
    ])
    expect(p).toContain('a@x.com')
  })
})
