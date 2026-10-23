// The find core shared by Cells' and Deck's Find and replace (SPEC §9.2).
import { describe, expect, it } from 'vitest'
import { findInRecords, replaceHits, replaceInRuns, spliceRanges } from '../../src/renderer/src/lib/recordFind'

const recs = [
  { key: 'a', text: 'Total cost' },
  { key: 'b', text: 'no match here' },
  { key: 'c', text: 'cost, COST and costs' }
]

describe('findInRecords', () => {
  it('finds in record order, then text order, case-insensitively by default', () => {
    expect(findInRecords(recs, 'cost')).toEqual([
      { key: 'a', start: 6, end: 10 },
      { key: 'c', start: 0, end: 4 },
      { key: 'c', start: 6, end: 10 },
      { key: 'c', start: 15, end: 19 }
    ])
  })
  it('honours case, whole word and regex as Write does', () => {
    expect(findInRecords(recs, 'COST', { caseSensitive: true }).map((h) => h.key)).toEqual(['c'])
    expect(findInRecords(recs, 'cost', { wholeWord: true })).toHaveLength(3)
    expect(findInRecords(recs, 'costs?\\b', { regex: true })).toHaveLength(4)
    expect(findInRecords(recs, '')).toEqual([])
  })
})

describe('replaceHits', () => {
  it('replaces one hit, leaving the others', () => {
    const hits = findInRecords(recs, 'cost')
    expect(replaceHits(recs, [hits[2]!], 'price')).toEqual([{ key: 'c', text: 'cost, price and costs' }])
  })
  it('replaces every hit, returning only the records that changed', () => {
    expect(replaceHits(recs, findInRecords(recs, 'cost'), 'price')).toEqual([
      { key: 'a', text: 'Total price' },
      { key: 'c', text: 'price, price and prices' }
    ])
  })
  it('splices ranges given in any order', () => {
    expect(spliceRanges('abcabc', [{ start: 0, end: 1 }, { start: 3, end: 4 }], 'XY')).toBe('XYbcXYbc')
  })
})

describe('replaceInRuns keeps formatting', () => {
  const runs = [{ text: 'Hello ' }, { text: 'bold', bold: true }, { text: ' world' }]
  it('inside one run, in place', () => {
    expect(replaceInRuns(runs, [{ start: 6, end: 10 }], 'brave')).toEqual([{ text: 'Hello ' }, { text: 'brave', bold: true }, { text: ' world' }])
  })
  it('across runs: the replacement takes the style of the run the match starts in', () => {
    expect(replaceInRuns(runs, [{ start: 4, end: 8 }], '--')).toEqual([{ text: 'Hell--' }, { text: 'ld', bold: true }, { text: ' world' }])
  })
  it('a match that starts exactly where a run begins belongs to that run', () => {
    expect(replaceInRuns(runs, [{ start: 6, end: 6 + 4 + 1 }], 'X')).toEqual([{ text: 'Hello ' }, { text: 'X', bold: true }, { text: 'world' }])
  })
  it('drops runs left empty, but never leaves a paragraph with none', () => {
    expect(replaceInRuns(runs, [{ start: 0, end: 16 }], '')).toEqual([{ text: '' }])
    expect(replaceInRuns(runs, [{ start: 0, end: 6 }], '')).toEqual([{ text: 'bold', bold: true }, { text: ' world' }])
  })
  it('several ranges in one paragraph', () => {
    expect(replaceInRuns([{ text: 'a-b' }, { text: '-c', italic: true }], [{ start: 1, end: 2 }, { start: 3, end: 4 }], '+')).toEqual([
      { text: 'a+b' },
      { text: '+c', italic: true }
    ])
  })
})
