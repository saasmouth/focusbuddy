import { describe, it, expect } from 'vitest'
import { relevanceGate, termMatches, queryTerms } from '../../src/main/workspaceRank'
import type { WorkspaceSource } from '../../src/main/workspaceRank'

// Retrieval was reading unrelated documents (reported 2026-10-30:
// "its reading random unrelated documents, not documents that have any
// relation by content, name, desk, type or association").
//
// It matters most exactly where it was noticed: on the on-device model, whose
// window is ~16k tokens. Every unrelated document admitted is a related one
// left out, so noise does not merely add clutter — it evicts the answer.

const QUERY = 'add the top 20 honeymoon destinations flying out from adelaide'

function src(title: string, text: string, score = 1): WorkspaceSource {
  return { docId: title, title, docType: 'doc', snippet: '', text, score }
}

describe('a term must match a WORD, not a substring', () => {
  it.each([
    ['top', 'I bought a new laptop yesterday'],
    ['top', 'the desktop is cluttered'],
    ['add', 'send it to this address'],
    ['act', 'the contract is signed'],
    ['ill', 'the bill is due'],
    ['art', 'we start on Monday']
  ])('"%s" does not match %o', (term, hay) => {
    expect(termMatches(hay.toLowerCase(), term)).toBe(false)
  })

  it.each([
    ['destinations', 'our destination is set'],
    ['destination', 'two destinations remain'],
    ['flying', 'we are flying out on Tuesday'],
    ['adelaide', 'Adelaide, South Australia'],
    ['renewals', 'the renewal is overdue']
  ])('"%s" still matches %o', (term, hay) => {
    expect(termMatches(hay.toLowerCase(), term)).toBe(true)
  })
})

describe('the relevance gate drops the unrelated', () => {
  it('keeps the document that is actually about the question', () => {
    const kept = relevanceGate(QUERY, [
      src('Honeymoon ideas', 'Flights from Adelaide to Bali and Fiji. Destinations we liked.')
    ])
    expect(kept).toHaveLength(1)
  })

  it('drops a document that only collides on filler words', () => {
    // The reported failure, in one row: "top" inside "laptop", "add" inside
    // "address", "out" a stopword. Three coincidences used to be enough.
    const kept = relevanceGate(QUERY, [
      src('Office equipment', 'Order a new laptop. Add the delivery address. Sort out the invoice.')
    ])
    expect(kept).toHaveLength(0)
  })

  it('drops a weak match sitting beside a strong one', () => {
    const kept = relevanceGate(QUERY, [
      src('Honeymoon shortlist', 'Adelaide departures. Honeymoon destinations: Bali, Fiji, Vanuatu.', 1),
      src('Weekly standup', 'Add the laptop order to the agenda. Top priority. Flying visit from the CEO.', 0.9)
    ])
    expect(kept.map((k) => k.title)).toEqual(['Honeymoon shortlist'])
  })

  it('an all-weak pool comes back empty rather than normalised into looking relevant', () => {
    // These two DO cover the question — the words are all there — but the
    // ranker scored them near zero, which is it saying the match is
    // incidental. Scoring each against the best of the others makes the
    // least-bad one look like the best one, so a relative floor alone
    // promotes the top of a pool that should have been thrown away whole.
    // This is the case the absolute floor exists for, and the coverage bar
    // cannot catch it.
    const kept = relevanceGate(QUERY, [
      src('Invoices', 'honeymoon destinations flying adelaide', 0.04),
      src('Recipes', 'honeymoon destinations flying adelaide', 0.03)
    ])
    expect(kept).toHaveLength(0)
  })

  it('but a strong match at the same relative position is kept', () => {
    // Guards the floor from being set so high it eats real results.
    const kept = relevanceGate(QUERY, [
      src('Honeymoon plan', 'honeymoon destinations flying adelaide', 0.9)
    ])
    expect(kept).toHaveLength(1)
  })

  it('needs real coverage of the question, not three filler hits out of nine', () => {
    expect(queryTerms(QUERY)).not.toContain('top')
    expect(queryTerms(QUERY)).not.toContain('add')
    expect(queryTerms(QUERY)).toContain('honeymoon')
    expect(queryTerms(QUERY)).toContain('adelaide')
  })
})

describe('belonging to the desk is itself a relation', () => {
  // The owner's words: unrelated "by content, name, desk, type or
  // association". Desk membership is on that list, and a pure keyword bar
  // cannot see it — "based on this desk, summarise the research" means the
  // desk's own notes whether or not they repeat the words of the question.
  const DESK_Q = 'based on this desk, can you provide a research summary on the future of AI at work'

  const note = src('Research note 3', 'Generative AI moved from pilots to daily use in knowledge work.')
  const stranger = src('Recipe 12', 'Slow-cooked lentil soup: onions, carrots, cumin and stock.')

  it('keeps a desk note that touches the question, even on thin coverage', () => {
    const kept = relevanceGate(DESK_Q, [note], new Set([note.docId]))
    expect(kept).toHaveLength(1)
  })

  it('drops the same note when it is NOT on the desk being asked from', () => {
    // Same text, same question — only the relation differs. This is the
    // whole point of passing the set.
    expect(relevanceGate(DESK_Q, [note])).toHaveLength(0)
  })

  it('a desk object that touches the question nowhere is still not an answer', () => {
    // Being on the desk lowers the bar; it does not remove it. Otherwise
    // "what did we decide about pricing" drags in every sticky on the desk.
    expect(relevanceGate(DESK_Q, [stranger], new Set([stranger.docId]))).toHaveLength(0)
  })
})
