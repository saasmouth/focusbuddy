// Who a comment's "@" can offer, on a local document.
//
// This is the rule that broke when names became required (4.3.41) and that
// nothing caught, because it broke by going QUIET: the pool came out empty, so
// the autocomplete simply never opened. Nothing threw, nothing was mis-drawn,
// and the e2e that covered it was already red for the sign-in gate, so the
// second failure hid behind the first.
//
// The pool is HANDLES. A display name is not one, however much it looks like a
// person — a mention is matched by MENTION_RE and compared to a handle, so an
// inserted "@Dana Reed" resolves to nobody and notifies nobody.

import { describe, expect, it } from 'vitest'
import { commentMentionHandles, filterMentionCandidates, isHandleShaped } from '@renderer/lib/mentions'

describe('the pool a comment composer offers', () => {
  it('offers the signed-in account’s handle — the regression', () => {
    // A named account, which from 4.3.41 is every account. Before the fix the
    // pool was built from the DISPLAY name and came out empty here.
    expect(commentMentionHandles('dana', ['Dana Reed'])).toEqual(['dana'])
  })

  it('never offers a display name, even though it is what the comment is signed with', () => {
    // The author column holds "Dana Reed" — that is what renders above the
    // comment body. It must not reach the pool: "@Dana Reed" is not a mention,
    // it is two words, and the second one is not even part of the token.
    const pool = commentMentionHandles(null, ['Dana Reed', 'Sam Okafor'])
    expect(pool, 'a full name is not a handle').toEqual([])
    // And stated the other way, so the test says what it means: the name is
    // rejected for its SHAPE, not merely absent by accident.
    expect(isHandleShaped('Dana Reed')).toBe(false)
    expect(isHandleShaped('dana')).toBe(true)
  })

  it('still offers a legacy author string, because back then it WAS the handle', () => {
    // A document commented on before names: the author column holds handles.
    // Dropping them would lose real participants from an old thread.
    expect(commentMentionHandles('dana', ['sam', 'Dana Reed', 'ana.lee'])).toEqual(['dana', 'sam', 'ana.lee'])
  })

  it('puts mine first and dedupes case-insensitively', () => {
    // Mine is the one handle on a local document that is certainly real.
    expect(commentMentionHandles('dana', ['sam', 'DANA', 'Sam', 'sam'])).toEqual(['dana', 'sam'])
  })

  it('is honestly empty when there is no handle to offer', () => {
    // Signed out, or an account with no handle at all: offer nothing rather
    // than inventing a candidate. MentionInput opens only on a non-empty
    // pool, so an empty one means no menu — not an empty menu.
    expect(commentMentionHandles(null, [])).toEqual([])
    expect(commentMentionHandles(undefined, ['Dana Reed'])).toEqual([])
    expect(commentMentionHandles('  ', [])).toEqual([])
  })

  it('feeds filterMentionCandidates, which is what the menu actually renders', () => {
    // The two halves joined up: the pool, then the typed prefix. Asserting the
    // pool alone would leave the menu itself unproven.
    const pool = commentMentionHandles('dana', ['sam', 'Dana Reed'])
    expect(filterMentionCandidates(pool, ''), 'right after "@"').toEqual(['dana', 'sam'])
    expect(filterMentionCandidates(pool, 'd'), 'after "@d"').toEqual(['dana'])
    expect(filterMentionCandidates(pool, 'z'), 'a prefix nobody matches').toEqual([])
  })
})
