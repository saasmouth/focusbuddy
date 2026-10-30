// Finding related things by their METADATA (asked for 2026-10-30: "use a table
// of meta data to find appropriate related things, not time based … only use
// logical things that are likely to surface related info").
//
// fb_document_metadata already holds what an enrichment pass distilled from
// each document: the entities it names, its keywords, its category, a summary.
// Until now that was read only to DECORATE a result something else had already
// found. So a question about "Acme" missed a document whose body says "the
// client" throughout and whose entities list says Acme — the one place in the
// workspace that knew they were the same thing.
//
// THREE RULES.
//
// 1. Recall, never a filter. This can only ADD a candidate. Nothing that used
//    to be findable stops being findable because its metadata is thin or its
//    row was never written — most of a workspace has no metadata at all until
//    the enrichment pass reaches it, and that must cost nothing.
//
// 2. Logical signals only. What a document is ABOUT, what it NAMES, what it
//    IS. Not when it was touched: a document is not related to a question
//    because someone edited it this morning, and ranking on recency is how a
//    search starts returning whatever is newest instead of whatever answers.
//
// 3. Cheap enough to run every turn. A metadata row is a few hundred bytes
//    against a vector's ~20KB, so scanning the whole table costs about as
//    much as parsing one embedding. That is what buys the recall: it widens
//    the net without spending the user's patience.

import { queryTerms, termMatches } from './workspaceRank'

/** The fields a relation may be drawn from, strongest first. */
export const METADATA_SIGNALS = ['entities', 'keywords', 'title', 'category', 'summary'] as const

export interface MetadataCandidate {
  docId: string
  title: string
  summary: string
  category: string
  entities: string[]
  keywords: string[]
}

// What each signal is worth when it matches.
//
// An entity leads because naming a thing is the strongest claim of aboutness
// a document can make — "Acme" in the entity list means the document is about
// Acme, while "Acme" in a summary may be an aside. Keywords are the distilled
// topic. A title is what a person chose to call it. Category and summary are
// weaker and tie-break rather than carry.
const WEIGHTS: Record<(typeof METADATA_SIGNALS)[number], number> = {
  entities: 4,
  keywords: 3,
  title: 3,
  category: 2,
  summary: 1
}

/**
 * How strongly this document's metadata says it relates to the question.
 * Zero means "no relation found here" — which is the normal case and costs
 * the caller nothing.
 *
 * Exported pure and unit-locked: what counts as a relation is a product
 * decision, not an implementation detail.
 */
export function scoreMetadata(query: string, m: MetadataCandidate): number {
  const terms = queryTerms(query)
  if (terms.length === 0) return 0
  const fields: Array<[(typeof METADATA_SIGNALS)[number], string]> = [
    ['entities', m.entities.join(' ')],
    ['keywords', m.keywords.join(' ')],
    ['title', m.title],
    ['category', m.category],
    ['summary', m.summary]
  ]
  let score = 0
  for (const [signal, text] of fields) {
    if (!text) continue
    const hay = text.toLowerCase()
    // Each signal counts once per term it matches — a document naming three
    // of the question's entities is more about it than one naming a single
    // entity three times.
    for (const t of terms) if (termMatches(hay, t)) score += WEIGHTS[signal]
  }
  return score
}

/**
 * The documents whose metadata relates to the question, best first.
 *
 * `limit` bounds what is handed on, not what is considered: every row is
 * scored, because the whole point is that a document the keyword index missed
 * can still surface here.
 */
export function rankByMetadata(
  query: string,
  candidates: readonly MetadataCandidate[],
  limit = 6
): Array<{ docId: string; score: number }> {
  const scored: Array<{ docId: string; score: number }> = []
  for (const m of candidates) {
    const score = scoreMetadata(query, m)
    if (score > 0) scored.push({ docId: m.docId, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId)).slice(0, limit)
}
