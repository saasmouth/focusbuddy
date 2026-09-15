import { describe, it, expect } from 'vitest'
import {
  mentionHref,
  parseMentionHref,
  serialiseMention,
  parseMentionText,
  extractMentions,
  stripMentions,
  findMentionQuery,
  insertMention,
  type TextMention
} from '../../src/shared/mentionText'

const desk: TextMention = { kind: 'desk', id: 'abc123', title: 'Ridge St' }
const widget: TextMention = {
  kind: 'widget',
  id: 'w1',
  title: 'Comparable sales',
  taskId: 'desk9'
}

describe('href round-trip', () => {
  it('builds a plexii url', () => {
    expect(mentionHref(desk)).toBe('plexii://desk/abc123')
  })
  it('carries the desk a widget belongs to', () => {
    expect(mentionHref(widget)).toBe('plexii://widget/w1?desk=desk9')
  })
  it('parses back to the same target', () => {
    const back = parseMentionHref(mentionHref(widget))
    expect(back?.kind).toBe('widget')
    expect(back?.id).toBe('w1')
    expect(back?.taskId).toBe('desk9')
  })
  it('encodes ids that would otherwise break the url', () => {
    const odd: TextMention = { kind: 'file', id: 'a b/c?d', title: 'X' }
    expect(parseMentionHref(mentionHref(odd))?.id).toBe('a b/c?d')
  })
  it('refuses a url that is not ours', () => {
    expect(parseMentionHref('https://example.com/x')).toBeNull()
    expect(parseMentionHref('nonsense')).toBeNull()
  })
})

describe('serialise / parse', () => {
  it('round-trips a mention through text', () => {
    const text = `See ${serialiseMention(desk)} for the numbers.`
    const segs = parseMentionText(text)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ type: 'text', text: 'See ' })
    expect(segs[1].type).toBe('mention')
    expect(segs[1].type === 'mention' && segs[1].mention.id).toBe('abc123')
    expect(segs[1].type === 'mention' && segs[1].mention.title).toBe('Ridge St')
    expect(segs[2]).toEqual({ type: 'text', text: ' for the numbers.' })
  })

  it('survives a title containing brackets', () => {
    const tricky: TextMention = { kind: 'desk', id: 'd', title: 'Ridge [St] (rear)' }
    const segs = parseMentionText(serialiseMention(tricky))
    expect(segs[0].type === 'mention' && segs[0].mention.title).toBe('Ridge [St] (rear)')
  })

  it('handles several mentions in one string', () => {
    const t = `${serialiseMention(desk)} and ${serialiseMention(widget)}`
    expect(extractMentions(t).map((m) => m.id)).toEqual(['abc123', 'w1'])
  })

  it('dedupes repeated references to the same thing', () => {
    const t = `${serialiseMention(desk)} ${serialiseMention(desk)}`
    expect(extractMentions(t)).toHaveLength(1)
  })

  it('shows an unreadable token as the text it is, not a dead link', () => {
    const segs = parseMentionText('@[Thing](https://evil.example/x)')
    expect(segs.every((s) => s.type === 'text')).toBe(true)
  })

  it('leaves ordinary text and bare @ alone', () => {
    expect(parseMentionText('email me at sarah@example.com')).toEqual([
      { type: 'text', text: 'email me at sarah@example.com' }
    ])
    expect(parseMentionText('')).toEqual([])
  })
})

describe('stripMentions', () => {
  it('reads as prose, with titles in place of tokens', () => {
    expect(stripMentions(`Check ${serialiseMention(desk)} today`)).toBe('Check Ridge St today')
  })
  it('leaves plain text untouched', () => {
    expect(stripMentions('nothing here')).toBe('nothing here')
  })
})

describe('findMentionQuery', () => {
  it('finds a mention being typed at the caret', () => {
    const t = 'see @rid'
    expect(findMentionQuery(t, t.length)).toEqual({ start: 4, end: 8, query: 'rid' })
  })
  it('finds a bare @ that has just been typed', () => {
    expect(findMentionQuery('see @', 5)).toEqual({ start: 4, end: 5, query: '' })
  })
  it('finds one at the very start', () => {
    expect(findMentionQuery('@ri', 3)).toEqual({ start: 0, end: 3, query: 'ri' })
  })
  it('does NOT fire inside an email address', () => {
    // The behaviour that makes @-mentions infuriating elsewhere.
    const t = 'sarah@example'
    expect(findMentionQuery(t, t.length)).toBeNull()
  })
  it('does not cross whitespace or a newline', () => {
    expect(findMentionQuery('@ridge st', 9)).toBeNull()
    expect(findMentionQuery('@ridge\nnext', 11)).toBeNull()
  })
  it('opens after punctuation that starts a word', () => {
    expect(findMentionQuery('(@ri', 4)?.query).toBe('ri')
    expect(findMentionQuery('"@ri', 4)?.query).toBe('ri')
  })
  it('does not re-open on the tail of a completed token', () => {
    const t = serialiseMention(desk)
    expect(findMentionQuery(t, t.length)).toBeNull()
  })
  it('returns null for a caret out of range', () => {
    expect(findMentionQuery('abc', 99)).toBeNull()
    expect(findMentionQuery('abc', -1)).toBeNull()
  })
})

describe('insertMention', () => {
  it('replaces the query and leaves the caret after a trailing space', () => {
    const t = 'see @rid'
    const q = findMentionQuery(t, t.length)!
    const r = insertMention(t, q, desk)
    expect(r.text).toBe(`see ${serialiseMention(desk)} `)
    expect(r.caret).toBe(r.text.length)
  })
  it('keeps text that follows the caret', () => {
    const t = 'see @rid later'
    const q = findMentionQuery(t, 8)!
    const r = insertMention(t, q, desk)
    expect(r.text).toBe(`see ${serialiseMention(desk)}  later`)
  })
  it('produces text that parses straight back', () => {
    const t = '@'
    const q = findMentionQuery(t, 1)!
    const r = insertMention(t, q, widget)
    expect(extractMentions(r.text).map((m) => m.id)).toEqual(['w1'])
  })
})
