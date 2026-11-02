// Pure text extraction + keyword ranking for "ask your workspace". No database
// or native dependencies, so it is unit-testable on its own. workspaceSearch.ts
// wraps these with the document store.

import { docBodyToText, widgetFileBodyToText, type WidgetTextResolvers } from '@shared/widgetText'

// The DB-backed resolvers a widget file needs to be read (a table file's rows,
// a task list's tasks). Injected by main/index.ts at boot rather than imported,
// because this module stays free of database dependencies for its unit tests;
// without them a widget file still reads, just without the resolved rows.
let docTextResolvers: (() => WidgetTextResolvers) | null = null
export function setDocTextResolvers(factory: () => WidgetTextResolvers): void {
  docTextResolvers = factory
}

export interface WorkspaceSource {
  docId: string
  title: string
  docType: string
  snippet: string
  // Truncated extracted text, fed to the model as the grounding for this source.
  text: string
  score: number
  // Optional AI-enriched metadata (local model), present for documents that have
  // been enriched. Used to build a richer grounding header (so the model sees a
  // source's category, dates, key entities and a summary before its body) without
  // changing behaviour for un-enriched sources, where these are simply absent.
  summary?: string
  category?: string
  dates?: string[]
  entities?: string[]
  // Desk affinity, set by the pools that can know it (every pool that routes
  // through mergeScopedPools) and left undefined by the ones that cannot —
  // curated knowledge and meetings have no desk of their own. The interleave
  // in workspaceSearch reads it to decide which sources get the slots first;
  // undefined is scope-NEUTRAL, not off-scope, so workspace-level truth is
  // never pushed behind desk furniture.
  inScope?: boolean
}

// Best-effort plain text from a document body, by type. Shared with the
// auto-filing tag suggester so both read documents the same way.
export function collectTiptapText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[] }
  if (typeof n.text === 'string') return n.text
  const kids = Array.isArray(n.content) ? n.content : []
  const block = n.type === 'paragraph' || n.type === 'heading'
  const inner = kids.map(collectTiptapText).join(block ? '' : ' ')
  return block ? inner + '\n' : inner
}

// The ceiling extractDocText applies to every document body. Exported — purely
// additive, no behaviour change — so callers that must be honest about
// truncation can tell "this document is exactly this long" from "this is merely
// where the cut fell". @-mention resolution needs that distinction: quoting
// the cap as a document's full length when it is only the cap would state a
// number that is not true.
// 48000 (M1): the old 12000 meant a passage past ~page 4 of a long document
// could never be retrieved, mentioned, or embedded, however good the match.
// Chunk scoring is linear in this cap, so it is a ceiling, not an invitation.
export const DOC_TEXT_CAP = 48000

// Sheets flatten one row per line. 40 rows silently answered "total this
// column" questions from the first 40 rows of a 500-row sheet; rows are cheap
// (~tens of chars each) so the row cap can be generous — DOC_TEXT_CAP still
// bounds the total.
export const SHEET_ROW_CAP = 500

export function extractDocText(docType: string, body: unknown): string {
  try {
    const b = (body ?? {}) as Record<string, unknown>
    if (docType === 'doc') {
      const root = (b.doc as unknown) ?? body
      return collectTiptapText(root).trim().slice(0, DOC_TEXT_CAP)
    }
    if (docType === 'sheet') {
      // Two shapes exist in the field: V2 nests tabs under `sheets`, V1 puts
      // `columns`/`rows` at the top level. Only V2 was handled here, so every
      // legacy sheet extracted to nothing and never reached retrieval. The
      // shared extractor already knew about V1; this branch did not.
      const v2 = b.sheets as Array<{ columns?: string[]; rows?: string[][] }> | undefined
      const sheets =
        Array.isArray(v2) && v2.length
          ? v2
          : [{ columns: b.columns as string[] | undefined, rows: b.rows as string[][] | undefined }]
      return sheets
        .map((t) => {
          const header = (t.columns ?? []).join(' | ')
          const rows = (t.rows ?? []).slice(0, SHEET_ROW_CAP).map((r) => (r ?? []).join(' | ')).join('\n')
          return `${header}\n${rows}`
        })
        .join('\n')
        .trim()
        .slice(0, DOC_TEXT_CAP)
    }
    if (docType === 'slides') {
      const slides =
        (b.slides as Array<{
          notes?: string
          elements?: Array<{ type?: string; paragraphs?: Array<{ runs?: Array<{ text?: string }> }> }>
        }>) ?? []
      return slides
        .map((s) => {
          const text = (s.elements ?? [])
            .filter((e) => e.type === 'text')
            .map((e) => (e.paragraphs ?? []).map((p) => (p.runs ?? []).map((r) => r.text ?? '').join('')).join(' '))
            .join(' ')
          return s.notes ? `${text}\n${s.notes}` : text
        })
        .join('\n')
        .trim()
        .slice(0, DOC_TEXT_CAP)
    }
    if (docType === 'widget') {
      // A widget file reads exactly as its desk instances do — one serialiser
      // (shared/widgetText) with the DB-backed resolvers, so a table file is
      // its rows as a markdown table, a task list its checklist, and so on.
      const r = docTextResolvers ? docTextResolvers() : {}
      return widgetFileBodyToText(body, '', r).slice(0, DOC_TEXT_CAP)
    }
    if (docType === 'map' || docType === 'design') {
      // The shared extractor already knows these shapes (nodes/edges labels
      // for maps, element text for designs); before this branch they returned
      // '' here, which is why a design widget could never resolve (#10).
      return docBodyToText(docType, body).slice(0, DOC_TEXT_CAP)
    }
  } catch {
    /* best-effort */
  }
  return ''
}

// A short excerpt around the first matching term, for showing under a citation.
function makeSnippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (at === -1 || i < at)) at = i
  }
  if (at === -1) return text.slice(0, 160).trim()
  const start = Math.max(0, at - 60)
  return (start > 0 ? '…' : '') + text.slice(start, start + 200).trim() + (text.length > start + 200 ? '…' : '')
}

// Common words carry no signal and, in a long "related documents" query (where
// the query is a whole document), would otherwise dominate the score.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'but', 'not', 'you', 'your', 'our', 'its',
  'has', 'have', 'had', 'will', 'can', 'all', 'any', 'out', 'who', 'what', 'when', 'how', 'why', 'were', 'they',
  'their', 'them', 'then', 'than', 'into', 'over', 'per', 'via', 'etc', 'also', 'such', 'each', 'about', 'would',
  'there', 'which', 'been', 'more', 'some', 'one', 'two', 'get', 'got', 'use', 'using', 'new',
  // Auxiliaries carry no signal but used to count toward the relevance gate's
  // coverage bar — "what DID we decide" demanded a hit for "did" and culled
  // the source that answered.
  'did', 'does', 'doing', 'done',
  // What you ask the assistant TO DO, as opposed to what you are asking
  // about (2026-10-30). "add the top 20 honeymoon destinations" is a question
  // about honeymoon destinations; "add" and "top" are addressed to Plexii and
  // appear in half the workspace. Counting them toward coverage is what let
  // an unrelated document clear the bar on filler alone.
  //
  // Only words that are near-worthless AS A SEARCH TERM belong here. A word
  // that is sometimes the subject ("design", "table", "chart") does not,
  // however often it is also an instruction.
  'add', 'top', 'make', 'create', 'list', 'show', 'find', 'give', 'put', 'set',
  'need', 'want', 'please', 'help', 'tell', 'write', 'build', 'update', 'fill',
  'generate', 'populate', 'best', 'good', 'great', 'thing', 'things', 'stuff',
  'something', 'anything', 'everything', 'just', 'like', 'now', 'here'
])

// Minimal inflection handling (#28): 'renewals' must find 'renewal',
// 'decided' must find 'decide'. Substring matching already covers the
// forward direction (term ⊂ its longer inflection in the text); these
// stripped variants cover the reverse, without a stemmer dependency.
export function termVariants(term: string): string[] {
  const v = [term]
  if (term.length > 4) {
    if (term.endsWith('ies')) v.push(term.slice(0, -3) + 'y')
    else if (term.endsWith('es')) v.push(term.slice(0, -2))
    if (term.endsWith('s') && !term.endsWith('ss')) v.push(term.slice(0, -1))
    if (term.endsWith('ed')) v.push(term.slice(0, -2), term.slice(0, -1))
    if (term.endsWith('ing')) v.push(term.slice(0, -3), term.slice(0, -3) + 'e')
  }
  return [...new Set(v.filter((x) => x.length > 2))]
}

// One term-vs-text rule shared by the gate and the scorer, so "matches"
// means the same thing everywhere.
//
// A term matches a WORD, not a substring (fixed 2026-10-30: "its reading
// random unrelated documents"). Bare `hay.includes(v)` made "top" match
// "laptop" and "desktop", "add" match "address", "act" match "contract" —
// and the gate counted each as a hit, so three coincidences in an unrelated
// document were enough to admit it. On the on-device model, whose window is
// ~16k tokens, every one of those evicted a document that did answer.
//
// The start is anchored to a word boundary and a short inflection is allowed
// at the end, so "destinations" still finds "destination" and vice versa
// (termVariants handles the query side; this handles the text side) while
// "laptop" no longer contains "top".
const matcherCache = new Map<string, RegExp>()
function matcherFor(term: string): RegExp {
  const cached = matcherCache.get(term)
  if (cached) return cached
  // Each variant is expanded into the forms it can take in the TEXT, rather
  // than matched with a generic suffix tail. A tail would have to allow a
  // bare "d" for decide → decided, and that same "d" makes "ban" match
  // "band". Listing the forms keeps the boundary tight at both ends.
  const forms = new Set<string>()
  for (const v of termVariants(term)) {
    forms.add(v)
    forms.add(`${v}s`)
    forms.add(`${v}es`)
    forms.add(`${v}ed`)
    forms.add(`${v}ing`)
    if (v.endsWith('e')) {
      forms.add(`${v}d`) // decide → decided
      forms.add(`${v.slice(0, -1)}ing`) // decide → deciding
    }
    if (v.endsWith('y')) forms.add(`${v.slice(0, -1)}ies`) // category → categories
  }
  const alts = [...forms]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  // Edges are any non-letter, non-digit, Unicode-aware. \b counted "_" as part
  // of a word and "é" as an edge, so "q3_budget_2026" never matched "budget"
  // (queryTerms splits on "_"), and "caf" matched inside "café".
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, 'iu')
  matcherCache.set(term, re)
  return re
}

export function termMatches(hay: string, term: string): boolean {
  return matcherFor(term).test(hay)
}

// Split text into ~size-char chunks on paragraph/line boundaries so ranking can
// find a passage buried deep in a long document instead of only its head.
export function chunkText(text: string, size = 800): string[] {
  const clean = (text || '').replace(/\r/g, '').trim()
  if (clean.length <= size) return clean ? [clean] : []
  const chunks: string[] = []
  let cur = ''
  for (const piece of clean.split(/\n{2,}|\n/)) {
    if (cur && (cur.length + piece.length + 1) > size) {
      chunks.push(cur.trim())
      cur = piece
    } else {
      cur = cur ? `${cur}\n${piece}` : piece
    }
    // A single very long line (e.g. a wide sheet row) is hard-split.
    while (cur.length > size * 1.5) {
      chunks.push(cur.slice(0, size).trim())
      cur = cur.slice(size)
    }
  }
  if (cur.trim()) chunks.push(cur.trim())
  return chunks
}

function scoreHay(hay: string, terms: string[]): number {
  let s = 0
  for (const t of terms) {
    // Best variant wins (#28): count occurrences of whichever inflection
    // actually appears, capped as before.
    let best = 0
    for (const v of termVariants(t)) best = Math.max(best, hay.split(v).length - 1)
    s += Math.min(best, 6)
  }
  return s
}

// The query reduced to its signal-bearing terms, shared by every ranking path
// so "what matches" means one thing everywhere.
export function queryTerms(query: string): string[] {
  // Letters in any script, not just a to z: "café" stays "café" rather than
  // becoming "caf", which only matched before because \b mistook "é" for an edge.
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2 && !STOPWORDS.has(t)))]
}

// The passage(s) of one text that best answer a query: the top-scoring chunks
// joined, falling back to the head when nothing matches (title-only or purely
// semantic matches have no chunk to point at). This is the single
// passage-selection rule — rankSources applies it to keyword-ranked pools, and
// the semantic document path applies it so a document chosen by meaning is
// still QUOTED at its best-matching passage instead of its opening: a 20-page
// contract matching on page 9 must deliver page 9, not the cover page.
export function selectPassages(query: string, text: string, maxChars = 6000): string {
  const terms = queryTerms(query)
  const chunks = chunkText(text)
  const top = chunks
    .map((t) => ({ text: t, score: terms.length ? scoreHay(t.toLowerCase(), terms) : 0 }))
    .sort((a, b) => b.score - a.score)
    .filter((c) => c.score > 0)
    .slice(0, 2)
  const passages = top.length ? top.map((c) => c.text) : [chunks[0] ?? text.slice(0, 800)]
  return passages.join('\n…\n').slice(0, maxChars)
}

// The citation snippet, anchored honestly (defect #27): the old rule anchored
// on the FIRST query term — stopwords included — so the chip you click to
// verify a claim centred on "what". This one anchors on the EARLIEST
// occurrence in the text of any CONTENT term (inflection-aware via
// termVariants), falls back to any raw token, and only then to the head.
export function snippetFor(text: string, query: string, span = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const hay = clean.toLowerCase()
  let anchor = -1
  for (const t of queryTerms(query)) {
    for (const v of termVariants(t)) {
      const at = hay.indexOf(v)
      if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at
    }
  }
  if (anchor < 0) {
    for (const raw of query.toLowerCase().split(/\s+/).filter(Boolean)) {
      const at = hay.indexOf(raw)
      if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at
    }
  }
  if (anchor < 0) return clean.slice(0, span).trim()
  const start = Math.max(0, anchor - 60)
  return (
    (start > 0 ? '… ' : '') +
    clean.slice(start, start + span).trim() +
    (clean.length > start + span ? ' …' : '')
  )
}

// Score each document, title matches weighted higher AND the body scored per
// chunk so a mid-document match counts. The returned source text is the top
// matching chunk(s), not the document head, so the model is grounded on the
// passage that actually answers the query. Returns [] for an empty/short query.
export function rankSources(
  query: string,
  docs: Array<{ docId: string; title: string; docType: string; text: string }>,
  limit = 6
): WorkspaceSource[] {
  const terms = queryTerms(query)
  if (!terms.length) return []
  const scored: WorkspaceSource[] = []
  for (const d of docs) {
    const titleLower = (d.title || '').toLowerCase()
    let titleScore = 0
    for (const t of terms) if (titleLower.includes(t)) titleScore += 4

    const chunks = chunkText(d.text)
    const ranked = chunks
      .map((text) => ({ text, score: scoreHay(text.toLowerCase(), terms) }))
      .sort((a, b) => b.score - a.score)
    const top = ranked.filter((c) => c.score > 0).slice(0, 2)
    const bodyScore = top.reduce((a, c) => a + c.score, 0)
    const score = titleScore + bodyScore

    if (score > 0) {
      // Ground on the best-matching passages; fall back to the head if the match
      // was title-only.
      const passages = top.length ? top.map((c) => c.text) : [chunks[0] ?? d.text.slice(0, 800)]
      scored.push({
        docId: d.docId,
        title: d.title || 'Untitled',
        docType: d.docType,
        snippet: makeSnippet(top[0]?.text ?? d.text, terms),
        text: passages.join('\n…\n').slice(0, 6000),
        score
      })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// Desk scope demotes, never excludes (#12). The old scope filter made an
// answer sitting on an unrelated desk invisible forever with no gap reported,
// while the same question from Home found it instantly. Off-scope content now
// stays in the pool at a fraction of its score: an on-desk match still wins
// every tie, but a strong off-desk match survives to be cited.
export const OFF_SCOPE_DEMOTION = 0.45

// Merge an in-scope pool with a demoted off-scope pool. Both must come from
// the SAME scorer so the scores are comparable — demotion is a ratio, and a
// ratio of incomparable numbers would be noise, not a preference.
export function mergeScopedPools(
  inScope: WorkspaceSource[],
  offScope: WorkspaceSource[],
  limit: number,
  demotion = OFF_SCOPE_DEMOTION
): WorkspaceSource[] {
  // Tag as well as demote. Demotion alone only reorders WITHIN a pool, and the
  // round-robin interleave downstream then hands every pool the same number of
  // slots whatever the question was about — so a desk with fifteen relevant
  // widgets still surrendered slots to documents from elsewhere. The flag lets
  // the interleave fill from the desk first.
  const kept = inScope.map((s) => ({ ...s, inScope: true }))
  const demoted = offScope.map((s) => ({ ...s, score: s.score * demotion, inScope: false }))
  return [...kept, ...demoted].sort((a, b) => b.score - a.score).slice(0, limit)
}

// ── Who gets the slots ──────────────────────────────────────────────────────
//
// Round-robin across the pools alone handed every pool the same number of
// rounds whatever the question was about: 28 slots across seven pools is four
// each, so a desk with fifteen relevant widgets surrendered eleven of them to
// documents, files and meetings from elsewhere. Demoting off-scope sources did
// not help, because demotion only reorders WITHIN a pool — it never moves a
// slot between pools.
//
// So when a desk scope is active, in-scope sources fill the slots FIRST,
// round-robin among themselves (which keeps every kind of desk content
// represented), and the rest of the workspace fills what is left. Both
// symptoms of the old behaviour come from this one thing: too little from
// here, too much from nowhere.
//
// Scope-NEUTRAL sources — curated PlexiBrain knowledge and meetings, which
// have no desk of their own — ride in the FIRST pass (inScope === undefined).
// Knowledge is company truth meant to ground every answer, and putting it
// behind desk furniture would be a worse answer, not a more focused one. Pool
// order is preserved within every round, so knowledge still leads.
//
// With no desk scope nothing is marked off-scope, so this is one pass over
// everything and the result is byte-for-byte what plain round-robin gave.
export function interleaveByAffinity(
  pools: WorkspaceSource[][],
  limit: number
): WorkspaceSource[] {
  const fromHere = (s: WorkspaceSource): boolean => s.inScope !== false
  const merged: WorkspaceSource[] = []
  const seen = new Set<string>()
  const drain = (admit: (s: WorkspaceSource) => boolean): void => {
    const lanes = pools.map((p) => p.filter(admit))
    for (let i = 0; merged.length < limit && lanes.some((p) => p[i]); i++) {
      for (const lane of lanes) {
        const s = lane[i]
        if (s && !seen.has(s.docId) && merged.length < limit) {
          seen.add(s.docId)
          merged.push(s)
        }
      }
    }
  }
  drain(fromHere)
  drain((s) => !fromHere(s))
  return merged
}

// The relevance gate (A2 prep, from Caleb's live-drive feedback). Keyword
// pools admit anything with a single term hit, so "Research the best ways to
// be an SDR in 2026" dragged every doc containing "research" into the trace
// as if it had been analysed. A source must match enough of the question to
// plausibly be ABOUT it: distinct-term coverage scaled to the query's size
// (5+ signal terms need 3 hits, 3-4 need 2, shorter queries 1), and at least
// 30% of the pool's top score, so one strong match pushes the weak tail out.
// Per-pool, because scores are not comparable across pools. Keyword-only by
// design: when semantic ranking goes live (A2), its matches bypass term
// coverage — "churn" finding "attrition" with zero shared terms is the whole
// point — and get the relative cut derived from the measured cosine overlap
// instead.
/**
 * The least a source may score, on its own, to be worth a slot.
 *
 * The relative floor below cannot do this alone: scoring every candidate
 * against the best of the others makes the least-bad one look like the best
 * one, so a pool where nothing matches comes back looking analysed. An
 * absolute floor is what makes "nothing relevant" a possible answer.
 */
const MIN_ABSOLUTE_SCORE = 0.08

/**
 * How many of the question's terms a source must actually contain.
 *
 * Was 3-of-anything-above-5, which on a nine-word question meant a third of
 * it — and with substring matching those three were usually filler. Half the
 * terms, at least two, at most four: enough that a source is about the
 * question, not so much that a long question can only be answered by a
 * document that repeats it.
 */
export function coverageNeeded(termCount: number): number {
  if (termCount <= 1) return 1
  return Math.min(4, Math.max(2, Math.ceil(termCount / 2)))
}

/**
 * @param onDesk ids of things that live on the desk the question was asked
 * from. They are held to a lower bar, because belonging to the desk IS a
 * relation — "based on this desk, summarise…" means the desk's own notes
 * even when they do not repeat the words of the question. Everything else
 * must earn its slot on the question's own terms.
 */
export function relevanceGate(
  query: string,
  sources: WorkspaceSource[],
  onDesk?: ReadonlySet<string>
): WorkspaceSource[] {
  if (sources.length === 0) return sources
  const terms = queryTerms(query)
  if (terms.length === 0) return sources
  const needed = coverageNeeded(terms.length)
  const top = Math.max(...sources.map((s) => s.score))
  return sources.filter((s) => {
    const hay = `${s.title}\n${s.text}`.toLowerCase()
    let hits = 0
    for (const t of terms) if (termMatches(hay, t)) hits++
    if (onDesk?.has(s.docId)) {
      // On the desk you are asking from. One real term is enough to show it
      // is not merely sitting there — but a desk object that touches the
      // question nowhere at all is still not an answer to it.
      return hits >= 1
    }
    if (hits < needed) return false
    // Both floors. The relative one keeps a strong result from dragging in
    // its weak neighbours; the absolute one keeps a uniformly weak pool from
    // promoting its own best member.
    return s.score >= top * 0.3 && s.score >= MIN_ABSOLUTE_SCORE
  })
}
