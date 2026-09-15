import { describe, it, expect } from 'vitest'
import {
  matches,
  applyRules,
  rulesAreEmpty,
  describeRules,
  seedRulesFromDeskTitle,
  type InboxRules
} from '../../src/renderer/src/lib/inboxFilter'
import type { MailListItem } from '../../src/shared/types'

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)
const DAY = 86_400_000

function msg(over: Partial<MailListItem> = {}): MailListItem {
  return {
    uid: 1,
    fromName: 'Sarah Whitfield',
    fromAddress: 'sarah@ljhooker.com.au',
    subject: 'Ridge St settlement date',
    date: NOW - DAY,
    seen: false,
    flagged: false,
    hasAttachments: false,
    messageId: '<a@x>',
    inReplyTo: null,
    references: null,
    ...over
  } as MailListItem
}

describe('matches', () => {
  it('keeps everything when no rule is set', () => {
    expect(matches(msg(), {}, NOW)).toBe(true)
  })

  it('matches a sender on either name or address', () => {
    expect(matches(msg(), { from: ['sarah'] }, NOW)).toBe(true)
    expect(matches(msg(), { from: ['ljhooker'] }, NOW)).toBe(true)
    expect(matches(msg(), { from: ['david'] }, NOW)).toBe(false)
  })

  it('treats several terms in one field as OR', () => {
    expect(matches(msg(), { from: ['david', 'sarah'] }, NOW)).toBe(true)
  })

  it('treats separate fields as AND', () => {
    // Right sender, wrong subject -> excluded. This is the rule that makes the
    // widget a lens rather than a second inbox.
    expect(matches(msg(), { from: ['sarah'], subject: ['auction'] }, NOW)).toBe(false)
    expect(matches(msg(), { from: ['sarah'], subject: ['ridge'] }, NOW)).toBe(true)
  })

  it('ignores case and surrounding whitespace in terms', () => {
    expect(matches(msg(), { subject: ['  RIDGE  '] }, NOW)).toBe(true)
  })

  it('ignores empty and whitespace-only terms rather than matching nothing', () => {
    expect(matches(msg(), { from: ['', '   '] }, NOW)).toBe(true)
  })

  it('applies the unread, flagged and attachment switches', () => {
    expect(matches(msg({ seen: true }), { unreadOnly: true }, NOW)).toBe(false)
    expect(matches(msg({ seen: false }), { unreadOnly: true }, NOW)).toBe(true)
    expect(matches(msg({ flagged: false }), { flaggedOnly: true }, NOW)).toBe(false)
    expect(matches(msg({ hasAttachments: false }), { withAttachments: true }, NOW)).toBe(false)
    expect(matches(msg({ hasAttachments: true }), { withAttachments: true }, NOW)).toBe(true)
  })

  it('honours the date window', () => {
    expect(matches(msg({ date: NOW - 3 * DAY }), { sinceDays: 7 }, NOW)).toBe(true)
    expect(matches(msg({ date: NOW - 30 * DAY }), { sinceDays: 7 }, NOW)).toBe(false)
  })

  it('excludes an undated message from a date window instead of assuming it fits', () => {
    expect(matches(msg({ date: 0 }), { sinceDays: 7 }, NOW)).toBe(false)
    // ...but keeps it when no window is set.
    expect(matches(msg({ date: 0 }), {}, NOW)).toBe(true)
  })

  it('survives a message with missing name and subject', () => {
    const bare = msg({ fromName: '', subject: '' } as Partial<MailListItem>)
    expect(matches(bare, { subject: ['ridge'] }, NOW)).toBe(false)
    expect(matches(bare, {}, NOW)).toBe(true)
  })
})

describe('applyRules', () => {
  it('returns matches newest first', () => {
    const out = applyRules(
      [
        msg({ uid: 1, date: NOW - 5 * DAY }),
        msg({ uid: 2, date: NOW - 1 * DAY }),
        msg({ uid: 3, date: NOW - 3 * DAY })
      ],
      {},
      NOW
    )
    expect(out.map((m) => m.uid)).toEqual([2, 3, 1])
  })

  it('returns an empty list rather than falling back to everything', () => {
    // The one behaviour that must never soften: no matches means no matches.
    expect(applyRules([msg()], { from: ['nobody'] }, NOW)).toEqual([])
  })
})

describe('rulesAreEmpty', () => {
  it('is true for no rules and for blank terms', () => {
    expect(rulesAreEmpty({})).toBe(true)
    expect(rulesAreEmpty({ from: [''], subject: ['  '], sinceDays: 0 })).toBe(true)
  })
  it('is false once any rule bites', () => {
    expect(rulesAreEmpty({ unreadOnly: true })).toBe(false)
    expect(rulesAreEmpty({ subject: ['ridge'] })).toBe(false)
    expect(rulesAreEmpty({ sinceDays: 30 })).toBe(false)
  })
})

describe('describeRules', () => {
  it('says so when nothing is filtered', () => {
    expect(describeRules({})).toBe('Everything in the inbox')
  })
  it('reads as a sentence', () => {
    const r: InboxRules = { from: ['sarah'], subject: ['ridge'], unreadOnly: true, sinceDays: 30 }
    expect(describeRules(r)).toBe('from sarah · about ridge · unread · in the last 30 days')
  })
})

describe('seedRulesFromDeskTitle', () => {
  it('picks the distinctive words out of a desk title', () => {
    expect(seedRulesFromDeskTitle('Ridge Street Campaign').subject).toEqual(['street', 'ridge'])
  })
  it('drops filler words that would match everything', () => {
    expect(seedRulesFromDeskTitle('The Notes Desk').subject).toEqual([])
  })
  it('drops bare numbers and very short words', () => {
    expect(seedRulesFromDeskTitle('42 St Ives').subject).toEqual(['ives'])
  })
  it('survives an empty or odd title', () => {
    expect(seedRulesFromDeskTitle('').subject).toEqual([])
    expect(seedRulesFromDeskTitle('   ---   ').subject).toEqual([])
  })
  it('opens with a date window so the first view is recent mail', () => {
    expect(seedRulesFromDeskTitle('Ridge Street').sinceDays).toBe(30)
  })
})
