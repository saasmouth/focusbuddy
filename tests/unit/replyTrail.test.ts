import { describe, it, expect } from 'vitest'
import { normaliseSubject, trailFor } from '../../src/renderer/src/lib/replyTrail'
import type { MailListItem } from '../../src/shared/types'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 8, 10)

const msg = (over: Partial<MailListItem> & { uid: number }): MailListItem =>
  ({
    fromName: 'Sarah',
    fromAddress: 'sarah@example.com',
    subject: 'Ridge St',
    date: T0,
    seen: true,
    flagged: false,
    hasAttachments: false,
    messageId: null,
    inReplyTo: null,
    references: null,
    ...over
  }) as MailListItem

describe('normaliseSubject', () => {
  it('strips reply and forward prefixes, however they are stacked', () => {
    expect(normaliseSubject('Re: Fwd: RE: Ridge St')).toBe('ridge st')
  })
  it('strips a numbered prefix', () => {
    expect(normaliseSubject('Re[2]: Ridge St')).toBe('ridge st')
  })
  it('leaves a clean subject alone', () => {
    expect(normaliseSubject('Ridge St')).toBe('ridge st')
  })
  it('survives an empty subject', () => {
    expect(normaliseSubject('')).toBe('')
  })
})

describe('trailFor', () => {
  const a = msg({ uid: 1, messageId: '<a>', date: T0 })
  const b = msg({ uid: 2, messageId: '<b>', inReplyTo: '<a>', references: '<a>', date: T0 + DAY })
  const c = msg({ uid: 3, messageId: '<c>', inReplyTo: '<b>', references: '<a> <b>', date: T0 + 2 * DAY })
  const other = msg({ uid: 9, messageId: '<z>', subject: 'Unrelated', date: T0 + DAY })
  const all = [a, b, c, other]

  it('returns the ancestors of a message, oldest first', () => {
    expect(trailFor(c, all).map((m) => m.uid)).toEqual([1, 2])
  })

  it('never includes the message itself', () => {
    expect(trailFor(c, all).map((m) => m.uid)).not.toContain(3)
  })

  it('never includes messages that came after it', () => {
    // Drafting a reply to B must not see C: C is an answer to the thing being
    // answered, and feeding it back produces a reply to a settled question.
    expect(trailFor(b, all).map((m) => m.uid)).toEqual([1])
  })

  it('excludes unrelated conversations', () => {
    expect(trailFor(c, all).map((m) => m.uid)).not.toContain(9)
  })

  it('picks up a sibling branch through a shared reference', () => {
    const branch = msg({ uid: 4, messageId: '<d>', inReplyTo: '<a>', references: '<a>', date: T0 + DAY / 2 })
    expect(trailFor(c, [...all, branch]).map((m) => m.uid)).toEqual([1, 4, 2])
  })

  it('falls back to the subject when a message carries no headers at all', () => {
    const bare1 = msg({ uid: 11, subject: 'Settlement date', date: T0 })
    const bare2 = msg({ uid: 12, subject: 'Re: Settlement date', date: T0 + DAY })
    expect(trailFor(bare2, [bare1, bare2]).map((m) => m.uid)).toEqual([11])
  })

  it('does not drag a headerless message into a different subject', () => {
    const bare = msg({ uid: 11, subject: 'Something else', date: T0 })
    expect(trailFor(c, [...all, bare]).map((m) => m.uid)).toEqual([1, 2])
  })

  it('returns nothing for a message that starts a conversation', () => {
    expect(trailFor(a, all)).toEqual([])
  })

  it('caps the trail at the most recent messages', () => {
    const long: MailListItem[] = []
    for (let i = 0; i < 20; i++) {
      long.push(
        msg({
          uid: 100 + i,
          messageId: `<m${i}>`,
          inReplyTo: i === 0 ? null : `<m${i - 1}>`,
          references: Array.from({ length: i }, (_, k) => `<m${k}>`).join(' ') || null,
          date: T0 + i * DAY
        })
      )
    }
    const last = long[long.length - 1]
    const trail = trailFor(last, long, 5)
    expect(trail).toHaveLength(5)
    // The five kept are the five most recent, not the five oldest.
    expect(trail[trail.length - 1].uid).toBe(118)
  })

  it('handles references given as an array', () => {
    const x = msg({ uid: 21, messageId: '<x>', date: T0 })
    const y = msg({ uid: 22, messageId: '<y>', references: ['<x>'] as never, date: T0 + DAY })
    expect(trailFor(y, [x, y]).map((m) => m.uid)).toEqual([21])
  })
})
