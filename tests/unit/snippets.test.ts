import { describe, it, expect } from 'vitest'
import {
  linkModesFor,
  snippetBodyIsEmpty,
  snippetBodyMatchesKind,
  snippetMatches,
  snippetSummary,
  targetAccepts,
  type Snippet,
  type SnippetBody,
  type SnippetTarget
} from '../../src/shared/snippets'

// The snippet substrate's rules, which both the main process and the renderer
// run. They are pure on purpose: the library's own filtering and the SQL-backed
// query must agree on what "matches" means, and a surface must not be offered a
// link mode it cannot honour.

function snippet(over: Partial<Snippet> = {}): Snippet {
  const body: SnippetBody = over.body ?? { kind: 'doc', content: [{ type: 'paragraph' }], text: 'hello' }
  return {
    id: 's1',
    kind: body.kind,
    name: 'Payment terms',
    description: 'Net 30 wording',
    body,
    tags: ['legal'],
    scope: 'personal',
    orgId: 'personal',
    authorId: null,
    revision: 1,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function target(over: Partial<SnippetTarget> = {}): SnippetTarget {
  return {
    id: 'doc:1',
    label: 'This document',
    accepts: ['doc'],
    supports: ['duplicate', 'live'],
    insert: () => true,
    ...over
  }
}

describe('what a target will accept', () => {
  it('offers both link modes for a kind it takes and can resolve', () => {
    expect(linkModesFor(target(), 'doc')).toEqual(['duplicate', 'live'])
  })

  it('offers nothing for a kind it does not take', () => {
    // A sheet snippet in a document is not a degraded insertion, it is no
    // insertion — so the picker must not show it as a destination at all.
    expect(linkModesFor(target(), 'sheet')).toEqual([])
    expect(targetAccepts(target(), snippet({ kind: 'sheet' }))).toBe(false)
  })

  it('offers duplicate alone when the surface cannot resolve a reference', () => {
    // The point of the `supports` list: a surface that cannot resolve at render
    // time must not advertise Live, because a Live that silently became a copy
    // would be a lie about what the user asked for.
    const copyOnly = target({ supports: ['duplicate'] })
    expect(linkModesFor(copyOnly, 'doc')).toEqual(['duplicate'])
    expect(targetAccepts(copyOnly, snippet())).toBe(true)
  })
})

describe('searching the library', () => {
  it('matches on name, description and tags', () => {
    const s = snippet()
    expect(snippetMatches(s, { search: 'payment' })).toBe(true)
    expect(snippetMatches(s, { search: 'net 30' })).toBe(true)
    expect(snippetMatches(s, { search: 'legal' })).toBe(true)
  })

  it('matches on the body text, so "the one with X in it" is findable', () => {
    // Searching inside the content is what makes a library usable without the
    // user having tagged everything up front.
    expect(snippetMatches(snippet(), { search: 'hello' })).toBe(true)
  })

  it('filters by kind and scope', () => {
    const s = snippet()
    expect(snippetMatches(s, { kinds: ['widget'] })).toBe(false)
    expect(snippetMatches(s, { kinds: ['doc'] })).toBe(true)
    expect(snippetMatches(s, { scope: 'org' })).toBe(false)
    expect(snippetMatches(s, { scope: 'personal' })).toBe(true)
  })

  it('an empty search is not a filter', () => {
    expect(snippetMatches(snippet(), { search: '   ' })).toBe(true)
  })
})

describe('emptiness, per kind', () => {
  it('refuses a doc body with no nodes', () => {
    expect(snippetBodyIsEmpty({ kind: 'doc', content: [], text: '' })).toBe(true)
  })

  it('refuses a sheet block of only blank cells', () => {
    // Saving a selection of empty cells would put an entry in the library that
    // cannot be told apart from any other empty one.
    expect(snippetBodyIsEmpty({ kind: 'sheet', rows: [['', '  '], ['', '']] })).toBe(true)
    expect(snippetBodyIsEmpty({ kind: 'sheet', rows: [['', 'x']] })).toBe(false)
  })

  it('accepts a diagram with only edges, and refuses one with neither', () => {
    expect(snippetBodyIsEmpty({ kind: 'diagram', nodes: [], edges: [{}] })).toBe(false)
    expect(snippetBodyIsEmpty({ kind: 'diagram', nodes: [], edges: [] })).toBe(true)
  })
})

describe('the kind and the body must agree', () => {
  it('rejects a body whose discriminator is the wrong kind', () => {
    // This guard is why a slide surface can never be handed an object a
    // document wrote: the store refuses the write, and a corrupt row reads
    // back as an empty body of the declared kind.
    expect(snippetBodyMatchesKind('slide', { kind: 'doc', content: [], text: '' })).toBe(false)
    expect(snippetBodyMatchesKind('doc', { kind: 'doc', content: [], text: '' })).toBe(true)
  })
})

describe('the summary describes what is really there', () => {
  it('uses the body text when there is some', () => {
    expect(snippetSummary(snippet())).toBe('hello')
  })

  it('says a doc block is empty rather than inventing a description', () => {
    expect(snippetSummary(snippet({ body: { kind: 'doc', content: [], text: '' } }))).toBe('Empty')
  })

  it('counts blocks when there is content but no text', () => {
    const body: SnippetBody = { kind: 'doc', content: [{ type: 'image' }], text: '' }
    expect(snippetSummary(snippet({ body }))).toBe('1 block(s), no text')
  })

  it('reports sheet dimensions from the widest row', () => {
    const body: SnippetBody = { kind: 'sheet', rows: [['a'], ['b', 'c', 'd']] }
    expect(snippetSummary(snippet({ kind: 'sheet', body }))).toBe('2 × 3 cells')
  })

  it('truncates a long block rather than running off the row', () => {
    const text = 'x'.repeat(200)
    const out = snippetSummary(snippet({ body: { kind: 'doc', content: [{ type: 'paragraph' }], text } }))
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(120)
  })
})
