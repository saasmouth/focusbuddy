import { describe, it, expect } from 'vitest'
import {
  emptyFindings,
  findingsDigest,
  hasFindings,
  mergeFindings,
  normalizeFindings,
  MAX_RECORDS
} from '../../src/shared/browseFindings'

describe('normalizeFindings', () => {
  it('keeps the model-declared field order', () => {
    const f = normalizeFindings({
      fields: ['name', 'specialty', 'rating'],
      records: [{ rating: '4.9', name: 'Pixel Perfect', specialty: 'commercial' }]
    })
    expect(f.fields).toEqual(['name', 'specialty', 'rating'])
    expect(f.records[0].name).toBe('Pixel Perfect')
  })

  it('discovers fields a record uses that were not declared', () => {
    const f = normalizeFindings({
      fields: ['name'],
      records: [{ name: 'A', website: 'https://a.test' }]
    })
    expect(f.fields).toEqual(['name', 'website'])
  })

  it('drops declared fields no record actually fills, so no empty column ships', () => {
    const f = normalizeFindings({
      fields: ['name', 'phone'],
      records: [{ name: 'A' }, { name: 'B' }]
    })
    expect(f.fields).toEqual(['name'])
  })

  it('collapses scraped whitespace inside cells', () => {
    const f = normalizeFindings({ records: [{ name: '  Studio\n\n  Nine   ' }] })
    expect(f.records[0].name).toBe('Studio Nine')
  })

  it('coerces numbers and drops records with nothing usable', () => {
    const f = normalizeFindings({ records: [{ rating: 4.9 }, { junk: '' }, 'nope', null] })
    expect(f.records).toHaveLength(1)
    expect(f.records[0].rating).toBe('4.9')
  })

  it('caps runaway record counts from a hostile page', () => {
    const f = normalizeFindings({ records: Array.from({ length: 500 }, (_, i) => ({ n: `r${i}` })) })
    expect(f.records).toHaveLength(MAX_RECORDS)
  })

  it('degrades to empty rather than throwing on junk', () => {
    expect(normalizeFindings(null)).toEqual(emptyFindings())
    expect(normalizeFindings('a string')).toEqual(emptyFindings())
    expect(normalizeFindings({ records: 'not an array' }).records).toEqual([])
  })
})

describe('mergeFindings', () => {
  // The whole point of recording as you read: a later detail page enriches a
  // record first seen on a listing page, instead of duplicating it.
  it('enriches an existing record rather than duplicating it', () => {
    const a = normalizeFindings({ fields: ['name', 'rating'], records: [{ name: 'Studio Nine', rating: '4.8' }] })
    const b = normalizeFindings({ fields: ['name', 'website'], records: [{ name: 'Studio Nine', website: 'https://s9.test' }] })
    const m = mergeFindings(a, b)
    expect(m.records).toHaveLength(1)
    expect(m.records[0]).toEqual({ name: 'Studio Nine', rating: '4.8', website: 'https://s9.test' })
    expect(m.fields).toEqual(['name', 'rating', 'website'])
  })

  it('keeps genuinely different records apart', () => {
    const a = normalizeFindings({ fields: ['name'], records: [{ name: 'A' }] })
    const b = normalizeFindings({ fields: ['name'], records: [{ name: 'B' }] })
    expect(mergeFindings(a, b).records).toHaveLength(2)
  })

  it('matches identity case-insensitively', () => {
    const a = normalizeFindings({ fields: ['name'], records: [{ name: 'Studio Nine' }] })
    const b = normalizeFindings({ fields: ['name', 'rating'], records: [{ name: 'studio nine', rating: '5' }] })
    expect(mergeFindings(a, b).records).toHaveLength(1)
  })

  it('keeps the newer answer but does not let an empty one erase the old', () => {
    const a = normalizeFindings({ answer: 'first' })
    expect(mergeFindings(a, normalizeFindings({ answer: 'second' })).answer).toBe('second')
    expect(mergeFindings(a, emptyFindings()).answer).toBe('first')
  })
})

describe('findingsDigest', () => {
  it('renders records compactly for replay into the next round', () => {
    const f = normalizeFindings({
      fields: ['name', 'rating'],
      records: [{ name: 'A', rating: '4.9' }, { name: 'B', rating: '4.7' }]
    })
    const d = findingsDigest(f)
    expect(d).toContain('RECORDS SO FAR (2)')
    expect(d).toContain('name=A | rating=4.9')
  })

  it('says so plainly when nothing has been recorded', () => {
    expect(findingsDigest(emptyFindings())).toBe('NOTHING RECORDED YET.')
  })

  it('truncates rather than letting memory grow without bound', () => {
    const f = normalizeFindings({
      fields: ['name'],
      records: Array.from({ length: 200 }, (_, i) => ({ name: `record-number-${i}` }))
    })
    expect(findingsDigest(f, 500).length).toBeLessThan(560)
  })
})

describe('hasFindings', () => {
  it('is false for empty and for null, true once anything is recorded', () => {
    expect(hasFindings(null)).toBe(false)
    expect(hasFindings(emptyFindings())).toBe(false)
    expect(hasFindings(normalizeFindings({ answer: 'yes' }))).toBe(true)
    expect(hasFindings(normalizeFindings({ records: [{ a: 'b' }] }))).toBe(true)
  })
})
