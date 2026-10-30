// Fetching a web page as readable text, in the main process.
//
// Lifted out of ai/agentInputs.ts when research was given to every AI surface
// (ADR-0011): a desk agent wired to a browser widget and the research pass
// behind "build me a desk" want exactly the same thing — the page, as text,
// never blocking the caller. One implementation, so a fix to the bot-wall
// headers or the entity decoding reaches both.
//
// Best-effort by contract. A timeout, a non-text response or an offline
// machine returns a parenthesised reason, never a throw and never a partial
// page dressed up as a whole one.

/** How long a single page may take before it is abandoned. */
export const PAGE_FETCH_TIMEOUT_MS = 9000

/** The cap a page is cut to. Enough for an article; short of a token bomb. */
export const PAGE_TEXT_LIMIT = 7000

export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim() ?? ''
  s = s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return (title ? `Page title: ${title}\n\n` : '') + s
}

/**
 * True when the string is a reason rather than a page — the shape every
 * failure takes here. Callers that must not feed an error message to a model
 * as if it were research use this instead of re-deriving the convention.
 */
export function isFetchFailure(text: string): boolean {
  return text.startsWith('(') && text.endsWith(')')
}

export async function fetchPageText(url: string, limit = PAGE_TEXT_LIMIT): Promise<string> {
  let target = url.trim()
  if (!target) return '(no URL)'
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(target, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          // A real UA so sites don't serve a bot wall; identify ourselves too.
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PlexiDeskDeskAgent/1.0'
        }
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return `(could not load ${target}: HTTP ${res.status})`
    const ctype = res.headers.get('content-type') ?? ''
    if (!/text|html|json|xml/i.test(ctype)) return `(${target} is ${ctype || 'a non-text resource'})`
    const body = await res.text()
    const text = /json/i.test(ctype) ? body : htmlToText(body)
    return text.slice(0, limit)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `(could not load ${target}: ${msg})`
  }
}
