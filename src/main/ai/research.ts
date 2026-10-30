// Web research for every AI surface (ADR-0011).
//
// Before this, browsing lived in two places and reached neither of the things
// people actually ask for. `searchWeb` served the CHAT's grounding pass and
// returned link snippets only. `BROWSER_TOOLS` could read a page, but needed a
// live <webview> on the canvas, so only a desk agent could use it. Ask "build
// me a desk tracking the top 20 ergonomic chairs" and the builder had nothing
// but the model's memory to fill the table with — which is how a table of
// invented products gets built and presented as research.
//
// This module is the shared pre-pass. It searches, reads the pages that come
// back, and hands the calling surface a block of REAL, attributed text to work
// from. It is deliberately NOT Anthropic tool-use: the whole AI layer here
// speaks strict JSON envelopes for the reason recorded at anthropic.ts:1949,
// and a research pass that returns text keeps every surface's existing prompt
// and parser untouched.
//
// Three rules it will not break:
//
//  1. Best-effort, never blocking. Every failure path returns a result with no
//     findings and a stated reason. A surface whose research found nothing
//     behaves exactly as it did before this module existed.
//  2. Nothing is invented. A finding carries the URL and domain it came from,
//     and a page that failed to load is dropped rather than summarised from
//     its title. An empty result says so; it does not degrade into a guess.
//  3. It never sends anything the user has not allowed. The query is built
//     from the prompt plus the context cards the user explicitly added
//     (aiContext.ts) — never from the desk at large.

import { searchWeb, WEB_SEARCH_MIN_QUERY, type WebResult } from '../webSearch'
import { fetchPageText, isFetchFailure } from '../webPage'
import { localOnlyActive } from './local/providerRouter'
import { resolveContext } from './aiContext'
import type { AiResearchOpts, AiResearchSource } from '@shared/types'

export interface ResearchFinding {
  /** 1-based, and the marker the prompt block cites: [W1]. */
  n: number
  title: string
  url: string
  domain: string
  snippet: string
  /** The page as text. Empty when only the result snippet could be had. */
  text: string
}

export type ResearchSkip =
  | 'off' // the caller did not ask for research
  | 'too-short' // a follow-up, not a research question
  | 'local-only' // AI is on-device; searching would send the prompt out
  | 'no-results' // the search ran and found nothing usable

export interface ResearchResult {
  /** What was actually sent to the search engine. Shown in the trace. */
  queries: string[]
  findings: ResearchFinding[]
  /** Present only when findings is empty, saying why. */
  skipped?: ResearchSkip
}

export const EMPTY_RESEARCH: ResearchResult = { queries: [], findings: [] }

// Words that open a request to PlexiiDesk rather than describing the subject.
// "build me a desk for tracking indie bookshops in Melbourne" is a search for
// indie bookshops in Melbourne; sending the instruction along with it buries
// the subject under our own product vocabulary and returns results about desks.
const BUILD_PREAMBLE =
  /^\s*(?:(?:can you|could you|please|hey|ok|okay)\s+)*(?:(?:help me|i want|i need|i'?d like)\s+(?:to\s+)?)?(?:(?:go\s+)?(?:ahead\s+)?and\s+)?(?:build|create|make|set\s*up|add|generate|draft|put together|design|populate|fill(?:\s+in|\s+out)?|research)\s+(?:me\s+)?(?:a|an|the|some|my)?\s*/i

// A product noun the request OPENS on, and the connector that follows it:
// "desk tracking indie bookshops" is a search for indie bookshops.
//
// The connector is REQUIRED, and that guard is the whole reason this is safe.
// Without it "Table Mountain hiking trails" loses its mountain, because
// "table" is also one of our nouns. A connector after the noun ("of", "for",
// "tracking") is what distinguishes our vocabulary from the user's.
const PRODUCT_NOUN =
  '(?:desk|table|widget|widgets|work widget|work widgets|page|board|tracker|spreadsheet|sheet|list|canvas|workspace)s?'
const LEADING_PRODUCT = new RegExp(
  `^${PRODUCT_NOUN}\\s+(?:(?:of|for|to|that|which|tracking|track|listing|covering|comparing|showing|about|with|on)\\s+)+(?:(?:the|a|an|my|all)\\s+)?`,
  'i'
)

// Trailing product nouns the request ends on ("… as a table on my desk").
const TRAILING_PRODUCT =
  /\s*(?:\b(?:as|in|on|into|to)\b\s+)?(?:a|an|the|my|this)?\s*\b(?:desk|table|widget|widgets|work widget|work widgets|page|board|tracker|spreadsheet|sheet|list|canvas|workspace)\b[\s.!]*$/i

/**
 * The query to search for, derived from the user's own words.
 *
 * Exported pure and unit-locked, because this is the one place the user's
 * prompt leaves the machine: what it returns IS what DuckDuckGo is told. It
 * strips our product vocabulary and nothing else — no rewriting, no
 * "improving", no model call. The user said what they wanted; the search
 * should be about that.
 */
export function deriveQuery(prompt: string, extraContext: string[] = []): string {
  let q = prompt.replace(/\s+/g, ' ').trim()
  // Strip the instruction wrapper, repeatedly — "please help me build a …"
  // nests several of these.
  for (let i = 0; i < 3; i++) {
    const next = q.replace(BUILD_PREAMBLE, '')
    if (next === q) break
    q = next.trim()
  }
  // Then the product noun it opens on, same way.
  for (let i = 0; i < 2; i++) {
    const next = q.replace(LEADING_PRODUCT, '')
    if (next === q) break
    q = next.trim()
  }
  // Strip the trailing product noun only when something survives it.
  const trimmed = q.replace(TRAILING_PRODUCT, '').trim()
  if (trimmed.length >= 8) q = trimmed
  const context = extraContext.map((s) => s.trim()).filter(Boolean)
  if (context.length > 0) q = `${q} ${context.join(' ')}`.trim()
  // DuckDuckGo ignores the long tail anyway, and a 900-character paragraph as
  // a query returns nothing at all.
  if (q.length > 240) q = `${q.slice(0, 240).replace(/\s+\S*$/, '')}`
  return q
}

export interface ResearchRequest {
  prompt: string
  /** Terms from the context cards the user added. Never the desk at large. */
  contextTerms?: string[]
  /** How many results to consider. */
  maxResults?: number
  /** How many of those to actually read. Reading is the slow part. */
  maxPages?: number
  /** Characters kept per page. */
  perPage?: number
}

/**
 * Search, then read. Returns findings with real URLs, or an empty result that
 * says why it is empty.
 */
export async function research(req: ResearchRequest): Promise<ResearchResult> {
  const query = deriveQuery(req.prompt, req.contextTerms ?? [])
  if (query.length < WEB_SEARCH_MIN_QUERY) return { queries: [], findings: [], skipped: 'too-short' }
  // AI on this device means the user chose not to send their work out. A
  // search engine is "out". The egress guard would refuse it; this keeps the
  // attempt from being made at all.
  if (localOnlyActive()) return { queries: [], findings: [], skipped: 'local-only' }

  const maxResults = req.maxResults ?? 5
  const maxPages = Math.min(req.maxPages ?? 3, maxResults)
  const results: WebResult[] = await searchWeb(query, maxResults).catch(() => [])
  if (results.length === 0) return { queries: [query], findings: [], skipped: 'no-results' }

  // Read the top pages in parallel. The rest keep their snippets: a snippet
  // with a URL is still a real, checkable source, and dropping it because we
  // did not have time to read it loses the user a lead.
  const pages = await Promise.all(
    results.slice(0, maxPages).map((r) =>
      fetchPageText(r.url, req.perPage ?? 4000).catch(() => '(could not load)')
    )
  )

  const findings = results.map((r, i) => {
    const page = pages[i]
    return {
      n: i + 1,
      title: r.title,
      url: r.url,
      domain: r.domain,
      snippet: r.snippet,
      // A failure message is not page text. Keeping it would hand the model
      // "(could not load …: HTTP 403)" as if it were the article.
      text: page && !isFetchFailure(page) ? page : ''
    }
  })
  return { queries: [query], findings }
}

/**
 * The findings as a prompt block, or '' when there are none.
 *
 * The wording is load-bearing. It tells the model these are the ONLY web facts
 * it has, that it must not add others from memory, and that a cell it cannot
 * source should be left empty — because the failure mode this whole module
 * exists to prevent is a confidently populated table of things that do not
 * exist.
 */
export function researchBlock(res: ResearchResult): string {
  if (res.findings.length === 0) return ''
  const body = res.findings
    .map((f) => {
      const head = `[W${f.n}] ${f.title} — ${f.domain} (${f.url})`
      const content = f.text ? f.text : f.snippet
      return content ? `${head}\n${content}` : head
    })
    .join('\n\n')
  return (
    `WEB RESEARCH — read from the live web just now for this request ` +
    `(searched: "${res.queries.join('", "')}").\n` +
    `Use these to fill in real names, figures and details instead of inventing them. ` +
    `Cite a source as [W1], [W2] in any "reason" or prose you write.\n` +
    `These are the only web facts you have. Do NOT add others from memory. ` +
    `If a value is not in them, leave the cell or field EMPTY rather than guessing — ` +
    `an empty cell is honest and a plausible invented one is not.\n\n` +
    `${body}\n`
  )
}

/**
 * The single call a surface makes: research when asked, and get back the block
 * to paste into its prompt plus the result for the trace. Returns an empty
 * block when research is off, so the call site stays one line.
 */
export async function researchFor(
  enabled: boolean,
  req: ResearchRequest
): Promise<{ block: string; result: ResearchResult }> {
  if (!enabled) return { block: '', result: { queries: [], findings: [], skipped: 'off' } }
  const result = await research(req).catch(() => EMPTY_RESEARCH)
  return { block: researchBlock(result), result }
}

/** The findings as trace rows: what was read, and whether the body was had. */
export function researchSources(res: ResearchResult): AiResearchSource[] {
  return res.findings.map((f) => ({
    n: f.n,
    title: f.title,
    url: f.url,
    domain: f.domain,
    read: f.text.length > 0
  }))
}

/**
 * The one call every AI surface makes.
 *
 * Context FIRST, then research, and in that order for a reason: the context
 * the user added names the real things they mean ("Suppliers", "Q3 launch"),
 * and feeding those names into the search query is what turns a generic
 * search into one about their work. Returns '' when both are off, so a surface
 * that passes nothing behaves exactly as it did before.
 */
export async function researchAndContext(
  opts: AiResearchOpts | undefined,
  prompt: string,
  taskId: string | null
): Promise<{ block: string; sources: AiResearchSource[] }> {
  const ids = opts?.contextIds ?? []
  const ctx = ids.length > 0 ? resolveContext(ids, taskId) : { block: '', used: [], terms: [] }
  const { block: web, result } = await researchFor(opts?.research === true, {
    prompt,
    contextTerms: ctx.terms
  })
  const block = [ctx.block, web].filter(Boolean).join('\n')
  return { block, sources: researchSources(result) }
}
