import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  deriveQuery,
  researchBlock,
  researchSources,
  type ResearchResult
} from '../../src/main/ai/research'

// Web research for every AI surface (ADR-0011).
//
// deriveQuery is the one place the user's prompt leaves the machine, so what
// it returns IS what the search engine is told. Everything here is locked
// against that: the subject must survive, our product vocabulary must not.

describe('deriveQuery — what the search engine is actually told', () => {
  it.each([
    ['build me a desk tracking indie bookshops in Melbourne', 'indie bookshops in Melbourne'],
    ['create a table of the top ergonomic office chairs', 'top ergonomic office chairs'],
    ['Please help me build a workspace for tracking Series A fintech startups', 'Series A fintech startups'],
    ['make me a tracker for my half marathon training', 'half marathon training'],
    ['research the 2026 EU AI Act compliance deadlines', '2026 EU AI Act compliance deadlines']
  ])('%s → %s', (prompt, expected) => {
    expect(deriveQuery(prompt)).toBe(expected)
  })

  it('leaves a plain question alone', () => {
    const q = 'What are the filing deadlines for a UK private limited company?'
    expect(deriveQuery(q)).toBe(q)
  })

  it('keeps a product word that is part of the subject', () => {
    // "table" is our vocabulary AND a mountain. The connector guard is what
    // tells them apart: no connector after the noun, no strip.
    expect(deriveQuery('Table Mountain hiking trails')).toBe('Table Mountain hiking trails')
    expect(deriveQuery('list price of a Steinway Model D')).toBe('list price of a Steinway Model D')
  })

  it('never strips the subject down to nothing', () => {
    // "build a table" is all preamble. Stripping the trailing product noun
    // too would leave an empty query, which searches for nothing and would
    // read to the caller as "the web had no answer".
    expect(deriveQuery('build a table').length).toBeGreaterThan(0)
  })

  it('appends the terms from the context cards the user added', () => {
    expect(deriveQuery('build me a desk for supplier lead times', ['Suppliers 2026'])).toBe(
      'supplier lead times Suppliers 2026'
    )
  })

  it('caps the query, cutting at a word boundary', () => {
    const long = `compare ${'widget specification detail '.repeat(40)}`
    const q = deriveQuery(long)
    expect(q.length).toBeLessThanOrEqual(240)
    expect(q.endsWith(' ')).toBe(false)
  })
})

describe('researchBlock', () => {
  const result: ResearchResult = {
    queries: ['ergonomic office chairs'],
    findings: [
      {
        n: 1,
        title: 'The best office chairs',
        url: 'https://example.com/chairs',
        domain: 'example.com',
        snippet: 'A short snippet.',
        text: 'The Herman Miller Aeron costs 1,395 USD.'
      },
      {
        n: 2,
        title: 'Chair roundup',
        url: 'https://other.test/x',
        domain: 'other.test',
        snippet: 'Only a snippet for this one.',
        text: ''
      }
    ]
  }

  it('says nothing at all when research was never asked for', () => {
    expect(researchBlock({ queries: [], findings: [], skipped: 'off' })).toBe('')
  })

  it('says the search came back empty, rather than leaving the model to guess', () => {
    const b = researchBlock({ queries: ['x'], findings: [], skipped: 'no-results' })
    expect(b).toContain('found nothing usable')
    expect(b).toMatch(/Do not fill the gap from memory/i)
  })

  it('tells the model the web is off on this device, so it cannot offer to search', () => {
    // The reported failure: "Would you like me to search for this and
    // populate the table?" — asked by an assistant that never could.
    const b = researchBlock({ queries: [], findings: [], skipped: 'local-only' })
    expect(b).toContain('run on this device')
    expect(b).toMatch(/Do not offer to look anything up/i)
  })

  it('cites each source with its real URL', () => {
    const block = researchBlock(result)
    expect(block).toContain('[W1] The best office chairs — example.com (https://example.com/chairs)')
    expect(block).toContain('[W2] Chair roundup — other.test (https://other.test/x)')
  })

  it('prefers the page body, and falls back to the snippet', () => {
    const block = researchBlock(result)
    expect(block).toContain('The Herman Miller Aeron costs 1,395 USD.')
    expect(block).toContain('Only a snippet for this one.')
  })

  it('forbids filling gaps from memory — the whole point of the pass', () => {
    const block = researchBlock(result)
    expect(block).toContain('only web facts you have')
    expect(block).toMatch(/leave the cell or field EMPTY/i)
  })

  it('names what was searched, so the user can see the query that went out', () => {
    expect(researchBlock(result)).toContain('"ergonomic office chairs"')
  })
})

describe('researchSources — the trace', () => {
  it('marks a snippet-only source as not read', () => {
    const rows = researchSources({
      queries: ['q'],
      findings: [
        { n: 1, title: 'a', url: 'https://a.test', domain: 'a.test', snippet: 's', text: 'body' },
        { n: 2, title: 'b', url: 'https://b.test', domain: 'b.test', snippet: 's', text: '' }
      ]
    })
    expect(rows.map((r) => r.read)).toEqual([true, false])
  })
})

// The network-touching paths, with fetch stubbed. These lock the three
// promises the module makes: never throw, never block, never invent.
describe('research — best effort, never a throw', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('returns "too-short" for a follow-up rather than searching for it', async () => {
    const { research } = await import('../../src/main/ai/research')
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch
    const res = await research({ prompt: 'yes do it' })
    expect(res.skipped).toBe('too-short')
    expect(res.findings).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports no-results rather than pretending, when the engine returns nothing', async () => {
    globalThis.fetch = (async () =>
      new Response('<html><body>no results here</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })) as unknown as typeof fetch
    const { research } = await import('../../src/main/ai/research')
    const res = await research({ prompt: 'the lesser spotted nothing at all 2026' })
    expect(res.findings).toEqual([])
    expect(res.skipped).toBe('no-results')
  })

  it('drops a page that failed to load instead of passing the error off as text', async () => {
    const SERP =
      '<a rel="nofollow" class="result__a" href="https://real.test/a">A real page</a>' +
      '<a class="result__snippet">The snippet.</a>'
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('duckduckgo.com')) {
        return new Response(SERP, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('nope', { status: 403, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch
    const { research } = await import('../../src/main/ai/research')
    const res = await research({ prompt: 'a genuinely long enough research question' })
    expect(res.findings).toHaveLength(1)
    // The URL and snippet survive — they are real. The failed body does not.
    expect(res.findings[0].url).toBe('https://real.test/a')
    expect(res.findings[0].snippet).toBe('The snippet.')
    expect(res.findings[0].text).toBe('')
    expect(researchBlock(res)).not.toContain('HTTP 403')
  })

  it('a thrown search is an empty result, not an exception out of the surface', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const { research } = await import('../../src/main/ai/research')
    await expect(research({ prompt: 'a genuinely long enough research question' })).resolves.toMatchObject({
      findings: []
    })
  })
})

describe('researchFor — off by default', () => {
  it('makes no call at all when the surface did not ask', async () => {
    const spy = vi.fn()
    const real = globalThis.fetch
    globalThis.fetch = spy as unknown as typeof fetch
    const { researchFor } = await import('../../src/main/ai/research')
    const { block, result } = await researchFor(false, { prompt: 'something long enough to search' })
    globalThis.fetch = real
    expect(block).toBe('')
    expect(result.skipped).toBe('off')
    expect(spy).not.toHaveBeenCalled()
  })
})
