// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { hyphenate, hyphenPoints, longestFittingPrefix } from '../../src/shared/hyphenate'

// Hyphenation is graded on two things, and the second matters more: does it
// break words in the right places, and does it REFUSE to break when it is not
// sure. A missed hyphen costs a slightly looser line. A wrong one is printed
// on the page and read by everybody.

const dashed = (w: string): string => hyphenate(w).join('-')

describe('breaks words where a typesetter would', () => {
  it.each([
    ['hyphenation', ['hy', 'phen', 'ation']],
    ['typesetting', ['type', 'set', 'ting']],
    ['computer', ['com', 'put', 'er']],
    ['algorithm', ['al', 'go', 'rithm']],
    ['paragraph', ['para', 'graph']]
  ])('%s', (word, expected) => {
    // The patterns are a curated subset, so the assertion is that every break
    // offered is one of the correct ones — not that all of them are found.
    const got = hyphenate(word)
    const legal = new Set<number>()
    let at = 0
    for (const part of expected.slice(0, -1)) {
      at += part.length
      legal.add(at)
    }
    let pos = 0
    for (const part of got.slice(0, -1)) {
      pos += part.length
      expect(legal, `${word} broke at ${pos} (${dashed(word)})`).toContain(pos)
    }
  })
})

describe('refuses to break when it should', () => {
  it('leaves short words alone', () => {
    for (const w of ['the', 'and', 'table', 'paper']) expect(hyphenate(w)).toEqual([w])
  })

  it('leaves proper nouns alone by default', () => {
    // A broken name reads as a mistake even when the break is correct.
    expect(hyphenate('Washington')).toEqual(['Washington'])
    expect(hyphenate('Washington', { hyphenateCapitalised: true }).length).toBeGreaterThan(1)
  })

  it('leaves anything that is not plain letters alone', () => {
    // URLs, numbers and already-hyphenated compounds are not words the
    // patterns describe.
    for (const w of ['plexiidesk.com', 'ISO-8601', '1,250,000', 'e-commerce', "don't"])
      expect(hyphenate(w)).toEqual([w])
  })

  it('keeps enough letters on each side of the break', () => {
    for (const w of ['hyphenation', 'typesetting', 'algorithm', 'university', 'photograph']) {
      for (const p of hyphenPoints(w)) {
        expect(p, `${w} broke too near the start`).toBeGreaterThanOrEqual(3)
        expect(w.length - p, `${w} broke too near the end`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('honours tighter minimums', () => {
    const strict = hyphenPoints('hyphenation', { minPrefix: 6, minSuffix: 5 })
    for (const p of strict) {
      expect(p).toBeGreaterThanOrEqual(6)
      expect('hyphenation'.length - p).toBeGreaterThanOrEqual(5)
    }
  })

  it('returns no breaks rather than guessing at an unknown word', () => {
    // The safety property the whole design rests on: a word no pattern
    // matches is simply not hyphenated, which is today's behaviour. So
    // adding patterns later can improve the result but never regress it.
    const nonsense = 'zzqxwj' + 'vkxz'
    expect(hyphenate(nonsense)).toEqual([nonsense])
  })
})

describe('exceptions', () => {
  it('override the patterns where the patterns are wrong', () => {
    // present/project are the classic pair: the noun and the verb break
    // differently, so neither is broken at all.
    expect(hyphenate('present')).toEqual(['present'])
    expect(hyphenate('project')).toEqual(['project'])
  })

  it('still apply the length guards', () => {
    for (const p of hyphenPoints('university')) {
      expect(p).toBeGreaterThanOrEqual(3)
      expect('university'.length - p).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('longestFittingPrefix', () => {
  it('takes the most that fits, with the hyphen counted', () => {
    // The hyphen takes width; a prefix that only fits without it does not fit.
    const r = longestFittingPrefix('hyphenation', (c) => c.length <= 7)
    expect(r).not.toBeNull()
    expect(r!.prefix.endsWith('-')).toBe(true)
    expect(r!.prefix.length).toBeLessThanOrEqual(7)
    expect('hyphenation'.slice(0, r!.at)).toBe(r!.prefix.slice(0, -1))
  })

  it('prefers a longer prefix when both fit', () => {
    // typesetting, not hyphenation: the latter has a single break point, so a
    // tighter limit returns null rather than a shorter prefix, and the test
    // would be comparing against nothing.
    const tight = longestFittingPrefix('typesetting', (c) => c.length <= 5)
    const loose = longestFittingPrefix('typesetting', (c) => c.length <= 9)
    expect(tight).not.toBeNull()
    expect(loose).not.toBeNull()
    expect(tight!.prefix).toBe('type-')
    expect(loose!.prefix).toBe('typeset-')
    expect(loose!.at).toBeGreaterThan(tight!.at)
  })

  it('returns null when nothing legal fits, so the caller moves the whole word', () => {
    expect(longestFittingPrefix('hyphenation', () => false)).toBeNull()
    expect(longestFittingPrefix('cat', () => true)).toBeNull()
  })

  it('never returns a prefix the caller said does not fit', () => {
    for (const limit of [3, 4, 5, 6, 7, 8, 9, 10]) {
      const r = longestFittingPrefix('typesetting', (c) => c.length <= limit)
      if (r) expect(r.prefix.length).toBeLessThanOrEqual(limit)
    }
  })
})

describe('the curated pattern set covers common English', () => {
  // Spot values rather than a vague "it does something". If a pattern is ever
  // dropped these say which word stopped breaking, and they document what the
  // subset currently reaches.
  it.each([
    ['hyphenation', 'hyphen-ation'],
    ['typesetting', 'type-set-ting'],
    ['computer', 'com-puter'],
    ['algorithm', 'algo-rithm'],
    ['paragraph', 'para-graph'],
    ['university', 'uni-ver-sity'],
    ['photograph', 'pho-to-graph']
  ])('%s -> %s', (word, expected) => {
    expect(hyphenate(word).join('-')).toBe(expected)
  })
})

describe('determinism', () => {
  it('gives the same answer every time', () => {
    // The trie is built lazily and shared; a stateful bug here would show as
    // text reflowing differently on a second render.
    for (const w of ['hyphenation', 'typesetting', 'computer']) {
      expect(hyphenate(w)).toEqual(hyphenate(w))
    }
  })
})
