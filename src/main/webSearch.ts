// Web search for the chat's grounding pass (facelift F4 — commissioned by
// Caleb: the assistant's credibility must extend to the web, with the same
// trace-of-links grammar the workspace sources carry).
//
// Same engine the desk agents already drive (html.duckduckgo.com — keyless,
// account-free), but fetched directly in the main process instead of through
// a wired webview, so the CHAT can search without any browser widget on the
// canvas. Best-effort by design: a timeout, a parse miss, or an offline
// machine yields [] and the chat proceeds on workspace grounding alone —
// web search must never block or break an answer.
//
// The parser is exported pure so the result-extraction rules are unit-locked.

import { readTextCapped } from './webPage'

export interface WebResult {
  title: string
  url: string
  domain: string
  snippet: string
}

// DuckDuckGo's html endpoint wraps result links as
//   <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=<enc>&…">Title</a>
// with a sibling  <a class="result__snippet">…</a>. Hrefs are redirect links;
// the real target rides in the uddg param.
export function parseDdgHtml(html: string, limit = 5): WebResult[] {
  const out: WebResult[] = []
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const strip = (s: string): string =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
  const snippets: string[] = []
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) snippets.push(strip(m[1]))
  let i = 0
  for (let m = linkRe.exec(html); m && out.length < limit; m = linkRe.exec(html), i++) {
    const raw = m[1]
    let url = raw
    const uddg = /[?&]uddg=([^&]+)/.exec(raw)
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1])
      } catch {
        /* keep raw */
      }
    }
    if (url.startsWith('//')) url = `https:${url}`
    if (!/^https?:\/\//i.test(url)) continue
    // DuckDuckGo's own ad/redirect rows are not sources.
    let domain = ''
    try {
      domain = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      continue
    }
    if (domain.endsWith('duckduckgo.com')) continue
    const title = strip(m[2])
    if (!title) continue
    out.push({ title, url, domain, snippet: snippets[i] ?? '' })
  }
  return out
}

// Web source quality (A2, AI-15): prefer the canonical site over aggregators.
// Caleb's case: asking about a venue opened its Yelp listing instead of the
// venue's own site. Two deterministic signals, applied as a stable rerank so
// engine order still breaks ties:
// - A domain whose own name matches the query's terms IS the entity
//   ("eleven canterbury" → elevencanterbury.com) and moves up.
// - Directory/review aggregators move down — never out: when the aggregator
//   is all the web has, it still shows.
const AGGREGATOR_DOMAINS = new Set([
  'yelp.com',
  'tripadvisor.com',
  'yellowpages.com',
  'foursquare.com',
  'mapquest.com',
  'bbb.org',
  'thumbtack.com',
  'angi.com',
  'opentable.com',
  'facebook.com',
  'instagram.com',
  'pinterest.com',
  'reddit.com',
  'quora.com'
])

function isAggregator(domain: string): boolean {
  const parts = domain.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    if (AGGREGATOR_DOMAINS.has(parts.slice(i).join('.'))) return true
  }
  return false
}

// True when the query's words are the domain's own name — the strongest
// available "this site IS the thing" signal without fetching pages.
export function domainMatchesQuery(domain: string, query: string): boolean {
  const root = domain.split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '')
  if (root.length < 4) return false
  const terms = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
    (t) => !['the', 'and', 'for', 'near', 'best', 'top', 'www', 'com'].includes(t)
  )
  if (terms.length === 0) return false
  const joined = terms.join('')
  if (root.includes(joined) || joined.includes(root)) return true
  // Two or more distinct query words inside the domain name also count
  // ("canterbury hall venue" → canterburyhall.co.uk).
  let hits = 0
  for (const t of terms) if (t.length >= 4 && root.includes(t)) hits++
  return hits >= 2
}

// Stable rerank, exported pure so the rules are unit-locked.
export function rankWebResults(query: string, results: WebResult[]): WebResult[] {
  return results
    .map((r, i) => ({
      r,
      score: i + (isAggregator(r.domain) ? 2.5 : 0) - (domainMatchesQuery(r.domain, query) ? 3 : 0)
    }))
    .sort((a, b) => a.score - b.score)
    .map((x) => x.r)
}

// Queries this short are follow-ups ("yes", "do it"), not research questions;
// searching the web for them is noise wearing a trenchcoat.
export const WEB_SEARCH_MIN_QUERY = 15

export async function searchWeb(query: string, limit = 5): Promise<WebResult[]> {
  const q = query.trim()
  if (q.length < WEB_SEARCH_MIN_QUERY) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
      headers: {
        // The html endpoint serves plain results to anything that looks like a
        // browser; the default undici UA gets a captcha page instead.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
      }
    })
    if (!res.ok) return []
    // Read under a deadline, like every other body we read (webPage.ts). The
    // abort signal alone is not enough: whether it reaches a body stream is a
    // platform detail, and a search that never returns holds the whole turn.
    const html = await readTextCapped(res, 512 * 1024, Date.now() + 4000)
    // Parse deeper than the ask so a canonical site sitting just below the
    // fold can outrank the aggregators above it (AI-15), then cut to limit.
    return rankWebResults(query, parseDdgHtml(html, limit * 2)).slice(0, limit)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
