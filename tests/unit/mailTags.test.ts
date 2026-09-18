import { describe, it, expect } from 'vitest'
import {
  inTag,
  assignToTags,
  untagged,
  tagCounts,
  suggestTags,
  tagFromMessage
} from '../../src/renderer/src/lib/mailTags'
import type { MailTag, MailListItem } from '@shared/types'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

const msg = (p: Partial<MailListItem> & { uid: number }): MailListItem => ({
  fromName: 'Someone',
  fromAddress: 'someone@example.com',
  subject: 'Hello',
  date: NOW - 3600_000,
  seen: true,
  flagged: false,
  hasAttachments: false,
  messageId: `<${p.uid}@x>`,
  inReplyTo: null,
  references: [],
  ...p
})

const tag = (p: Partial<MailTag> & { id: string }): MailTag => ({
  name: 'Tag',
  colour: 'sky',
  rules: {},
  nodeId: null,
  pinned: [],
  excluded: [],
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...p
})

describe('inTag', () => {
  it('files a message its rule matches', () => {
    const f = tag({ id: 'f1', rules: { from: ['acme.com'] } })
    expect(inTag(msg({ uid: 1, fromAddress: 'jo@acme.com' }), f, NOW)).toBe(true)
    expect(inTag(msg({ uid: 2, fromAddress: 'jo@other.com' }), f, NOW)).toBe(false)
  })

  it('lets a pin overrule a rule that missed', () => {
    // Without this a rule that misses is a dead end, and the user is pushed
    // into widening it until it over-matches.
    const f = tag({ id: 'f1', rules: { from: ['acme.com'] }, pinned: [9] })
    expect(inTag(msg({ uid: 9, fromAddress: 'jo@other.com' }), f, NOW)).toBe(true)
  })

  it('lets an exclusion overrule a rule that over-matched', () => {
    // Without this one stray match poisons the tag permanently.
    const f = tag({ id: 'f1', rules: { from: ['acme.com'] }, excluded: [9] })
    expect(inTag(msg({ uid: 9, fromAddress: 'jo@acme.com' }), f, NOW)).toBe(false)
  })

  it('lets an exclusion beat a pin, because it is the later correction', () => {
    const f = tag({ id: 'f1', rules: {}, pinned: [9], excluded: [9] })
    expect(inTag(msg({ uid: 9 }), f, NOW)).toBe(false)
  })

  it('a tag with no rules holds only what was pinned into it', () => {
    // Empty rules matching EVERYTHING would make a half-made tag swallow the
    // whole inbox the moment it was named.
    const f = tag({ id: 'f1', rules: {}, pinned: [2] })
    expect(inTag(msg({ uid: 1 }), f, NOW)).toBe(false)
    expect(inTag(msg({ uid: 2 }), f, NOW)).toBe(true)
  })

  it('honours the rest of the rule vocabulary', () => {
    const unread = tag({ id: 'f', rules: { unreadOnly: true } })
    expect(inTag(msg({ uid: 1, seen: false }), unread, NOW)).toBe(true)
    expect(inTag(msg({ uid: 2, seen: true }), unread, NOW)).toBe(false)

    const recent = tag({ id: 'f', rules: { sinceDays: 7 } })
    expect(inTag(msg({ uid: 3, date: NOW - 2 * 86400_000 }), recent, NOW)).toBe(true)
    expect(inTag(msg({ uid: 4, date: NOW - 30 * 86400_000 }), recent, NOW)).toBe(false)
  })
})

describe('assignToTags', () => {
  const mail = [
    msg({ uid: 1, fromAddress: 'jo@acme.com', subject: 'Invoice 12' }),
    msg({ uid: 2, fromAddress: 'sam@beta.com', subject: 'Invoice 13' }),
    msg({ uid: 3, fromAddress: 'kit@gamma.com', subject: 'Lunch?' })
  ]
  const acme = tag({ id: 'acme', rules: { from: ['acme.com'] } })
  const invoices = tag({ id: 'inv', rules: { subject: ['invoice'] } })

  it('puts one message in every tag it belongs to, not just the first', () => {
    // An invoice from the client belongs in both. Forcing a single home is what
    // makes people stop trusting filing.
    const out = assignToTags(mail, [acme, invoices], NOW)
    expect(out.get('acme')!.map((m) => m.uid)).toEqual([1])
    expect(out.get('inv')!.map((m) => m.uid)).toEqual([1, 2])
  })

  it('gives every tag an entry, including the empty ones', () => {
    const out = assignToTags(mail, [acme, tag({ id: 'empty', rules: { from: ['zzz'] } })], NOW)
    expect(out.has('empty')).toBe(true)
    expect(out.get('empty')).toEqual([])
  })

  it('keeps the order it was given', () => {
    const out = assignToTags(mail, [invoices], NOW)
    expect(out.get('inv')!.map((m) => m.uid)).toEqual([1, 2])
  })

  it('handles no tags at all', () => {
    expect(assignToTags(mail, [], NOW).size).toBe(0)
  })
})

describe('untagged', () => {
  const mail = [
    msg({ uid: 1, fromAddress: 'jo@acme.com' }),
    msg({ uid: 2, fromAddress: 'sam@beta.com' }),
    msg({ uid: 3, fromAddress: 'kit@gamma.com' })
  ]

  it('is everything when there are no tags', () => {
    expect(untagged(mail, [], NOW).map((m) => m.uid)).toEqual([1, 2, 3])
  })

  it('shrinks as tags are made — the point of the whole feature', () => {
    const one = untagged(mail, [tag({ id: 'a', rules: { from: ['acme.com'] } })], NOW)
    expect(one.map((m) => m.uid)).toEqual([2, 3])
    const two = untagged(
      mail,
      [
        tag({ id: 'a', rules: { from: ['acme.com'] } }),
        tag({ id: 'b', rules: { from: ['beta.com'] } })
      ],
      NOW
    )
    expect(two.map((m) => m.uid)).toEqual([3])
  })

  it('counts a message as filed if ANY tag took it', () => {
    const out = untagged(
      mail,
      [tag({ id: 'a', rules: { from: ['zzz'] }, pinned: [3] })],
      NOW
    )
    expect(out.map((m) => m.uid)).toEqual([1, 2])
  })
})

describe('tagCounts', () => {
  it('counts what is in each tag and how much is unread', () => {
    const mail = [
      msg({ uid: 1, fromAddress: 'jo@acme.com', seen: false }),
      msg({ uid: 2, fromAddress: 'amy@acme.com', seen: true }),
      msg({ uid: 3, fromAddress: 'kit@other.com', seen: false })
    ]
    const counts = tagCounts(mail, [tag({ id: 'a', rules: { from: ['acme.com'] } })], NOW)
    expect(counts.get('a')).toEqual({ total: 2, unread: 1 })
  })

  it('reports zero honestly rather than omitting the tag', () => {
    const counts = tagCounts([], [tag({ id: 'a', rules: { from: ['x'] } })], NOW)
    expect(counts.get('a')).toEqual({ total: 0, unread: 0 })
  })
})

describe('suggestTags', () => {
  const many = (n: number, address: string, name = 'Person'): MailListItem[] =>
    Array.from({ length: n }, (_, i) =>
      msg({ uid: 1000 + i, fromAddress: address, fromName: name })
    )

  it('suggests the organisation somebody actually hears from', () => {
    const s = suggestTags([...many(5, 'jo@acme.com'), ...many(1, 'x@rare.com')], [], {
      now: NOW
    })
    expect(s[0].name).toBe('Acme')
    expect(s[0].from).toEqual(['acme.com'])
    expect(s[0].count).toBe(5)
  })

  it('does not suggest a tag for a shared mail host', () => {
    // "gmail.com" would sweep up half the mailbox and mean nothing.
    const s = suggestTags(many(9, 'someone@gmail.com'), [], { now: NOW })
    expect(s.map((x) => x.from?.[0])).not.toContain('gmail.com')
  })

  it('suggests the PERSON when they are on a shared host', () => {
    const s = suggestTags(many(4, 'dana@gmail.com', 'Dana Liu'), [], { now: NOW })
    expect(s[0].name).toBe('Dana Liu')
    expect(s[0].from).toEqual(['dana@gmail.com'])
  })

  it('never suggests a tag for a no-reply address', () => {
    // A sender you cannot correspond with is a tag about nothing.
    for (const a of ['no-reply@x.com', 'noreply@x.com', 'do-not-reply@x.com', 'mailer-daemon@x.com']) {
      expect(suggestTags(many(9, a), [], { now: NOW })).toEqual([])
    }
  })

  it('does not suggest what is already filed', () => {
    const mail = many(6, 'jo@acme.com')
    const existing = [tag({ id: 'a', rules: { from: ['acme.com'] } })]
    expect(suggestTags(mail, existing, { now: NOW })).toEqual([])
  })

  it('will not offer a tag that files almost nothing', () => {
    // The point is to shrink the unsorted pile; a tag holding two things
    // does not, and offering it is noise.
    expect(suggestTags(many(2, 'jo@acme.com'), [], { now: NOW })).toEqual([])
    expect(suggestTags(many(3, 'jo@acme.com'), [], { now: NOW })).toHaveLength(1)
  })

  it('offers the biggest win first', () => {
    const s = suggestTags(
      [...many(4, 'a@small.com'), ...many(9, 'b@big.com'), ...many(6, 'c@mid.com')],
      [],
      { now: NOW }
    )
    expect(s.map((x) => x.count)).toEqual([9, 6, 4])
  })

  it('says how many it would file, and how many are unread', () => {
    const mail = [
      ...many(3, 'jo@acme.com'),
      msg({ uid: 99, fromAddress: 'amy@acme.com', seen: false })
    ]
    expect(suggestTags(mail, [], { now: NOW })[0].reason).toBe(
      '4 messages from acme.com, 1 still unread'
    )
  })

  it('returns nothing for an empty mailbox rather than inventing a starter set', () => {
    expect(suggestTags([], [], { now: NOW })).toEqual([])
  })

  it('caps how many it offers', () => {
    const mail = Array.from({ length: 20 }, (_, d) => many(4, `p@d${d}.com`)).flat()
    expect(suggestTags(mail, [], { now: NOW }).length).toBeLessThanOrEqual(6)
  })

  it('survives messages with no sender address', () => {
    expect(() => suggestTags([msg({ uid: 1, fromAddress: '' })], [], { now: NOW })).not.toThrow()
  })
})

describe('tagFromMessage', () => {
  it('files by organisation for somebody at one', () => {
    expect(tagFromMessage(msg({ uid: 1, fromAddress: 'jo@acme.com' }))).toEqual({
      name: 'Acme',
      from: ['acme.com']
    })
  })

  it('files by person for somebody on a personal address', () => {
    expect(
      tagFromMessage(msg({ uid: 1, fromAddress: 'dana@gmail.com', fromName: 'Dana Liu' }))
    ).toEqual({ name: 'Dana Liu', from: ['dana@gmail.com'] })
  })

  it('uses the sender, not the subject, because subjects drift and senders do not', () => {
    const out = tagFromMessage(msg({ uid: 1, fromAddress: 'jo@acme.com', subject: 'Re: fwd: misc' }))
    expect(out.from).toEqual(['acme.com'])
  })

  it('still produces something usable for a no-reply sender', () => {
    const out = tagFromMessage(
      msg({ uid: 1, fromAddress: 'no-reply@acme.com', fromName: 'Acme Alerts' })
    )
    expect(out.name).toBe('Acme Alerts')
  })

  it('never returns an empty name', () => {
    expect(tagFromMessage(msg({ uid: 1, fromAddress: '', fromName: '' })).name).toBe('New tag')
  })
})
