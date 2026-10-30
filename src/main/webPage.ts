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

/**
 * Read a response body under a hard deadline and a byte cap.
 *
 * `res.text()` has neither, and that is what hung the sidebar assistant for
 * 373 seconds: the fetch timer only ever guarded the HEADERS, so a server
 * that answered at once and then dripped its body held the promise open with
 * no error and no output. The abort signal is not relied on to rescue it —
 * whether an abort propagates into a body stream is a platform detail, and
 * this function must finish on every platform and every malformed response.
 *
 * The cap is in BYTES and the caller's limit is in characters, so it is
 * deliberately generous: markup is many times the size of the text inside it,
 * and cutting the bytes too close truncates the article rather than the ads.
 */
export async function readTextCapped(res: Response, maxBytes: number, deadlineAt: number): Promise<string> {
  const body = res.body
  // No stream to read (a mocked or non-standard Response): fall back, still
  // under the deadline.
  if (!body) return await withDeadline(res.text(), deadlineAt)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await withDeadline(reader.read(), deadlineAt)
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
      // Enough. Everything past this would be cut by the caller's limit.
      if (total >= maxBytes) break
    }
  } finally {
    // Let the socket go whether we finished, capped out or timed out.
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
  const joined = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    joined.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(joined)
}

/** Reject once the deadline passes, whatever the promise is doing. */
function withDeadline<T>(p: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) return Promise.reject(new Error('timed out'))
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), remaining)
    })
    // Clearing matters: an uncleared timer keeps the event loop alive, which
    // in the main process means the app does not quit.
  ]).finally(() => clearTimeout(timer)) as Promise<T>
}

export async function fetchPageText(
  url: string,
  limit = PAGE_TEXT_LIMIT,
  timeoutMs = PAGE_FETCH_TIMEOUT_MS
): Promise<string> {
  let target = url.trim()
  if (!target) return '(no URL)'
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`
  // ONE deadline for the whole operation — connect, headers AND body. The
  // previous version armed a timer, cleared it the moment headers arrived,
  // and then read the body with nothing guarding it at all.
  const deadlineAt = Date.now() + timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await withDeadline(
      fetch(target, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          // A real UA so sites don't serve a bot wall; identify ourselves too.
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PlexiDeskDeskAgent/1.0'
        }
      }),
      deadlineAt
    )
    if (!res.ok) return `(could not load ${target}: HTTP ${res.status})`
    const ctype = res.headers.get('content-type') ?? ''
    if (!/text|html|json|xml/i.test(ctype)) return `(${target} is ${ctype || 'a non-text resource'})`
    const body = await readTextCapped(res, Math.max(limit * 8, 65536), deadlineAt)
    const text = /json/i.test(ctype) ? body : htmlToText(body)
    return text.slice(0, limit)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `(could not load ${target}: ${msg})`
  } finally {
    clearTimeout(timer)
    // Nothing is still reading by here, and an un-aborted request would keep
    // the connection (and the event loop) alive after we have given up.
    controller.abort()
  }
}
