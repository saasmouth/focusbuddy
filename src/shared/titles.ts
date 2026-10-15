// Naming things that arrived without a name.
//
// THE PROBLEM. Desks, rooms, documents and widgets could all be created with
// an empty title, and the UI papered over it with "Untitled desk" at render
// time. That reads as a name until you have forty of them, at which point the
// sidebar, search, the command palette and every picker are a list of
// identical rows and the only way to find anything is to open it.
//
// THE ORDER OF PREFERENCE, cheapest first. Nearly everything can be named
// without asking a model:
//
//   1. A name the user already gave it somewhere else — a heading inside the
//      document, the page title of a bookmarked URL, the filename.
//   2. The first meaningful line of its own content.
//   3. Only then, a model — and the cheapest one, on content alone.
//
// Steps 1 and 2 are free, deterministic and testable, which is why they live
// here as pure functions with no imports. The backfill in
// `main/titleBackfill.ts` exhausts them before it spends a single token, and
// in practice they name the large majority of items.
//
// WHAT THIS NEVER DOES. It never invents a subject. A title is derived from
// text the item already contains, or it is left for the model, or it is left
// alone. An empty note stays untitled rather than being christened something
// plausible — a confident wrong name is worse than a visibly missing one,
// because the user stops looking inside.

/** The display fallbacks the app renders for an empty title. */
const UNTITLED_WORDS = [
  'untitled',
  'new',
  'no title',
  'unnamed'
]

/**
 * Is this title absent in practice?
 *
 * Covers the genuinely empty, and the placeholder strings the UI has been
 * rendering in their place — "Untitled", "Untitled desk", "New calendar",
 * "New document 3". Those are not names the user chose; they are the absence
 * of a name wearing a label, and the backfill should treat them the same.
 *
 * Deliberately conservative about what counts as a placeholder: the word must
 * START the title, so a real document called "New hire onboarding" or
 * "Untitled Goose Game notes" is left alone.
 */
export function isUntitled(title: string | null | undefined): boolean {
  if (title === null || title === undefined) return true
  const t = title.trim()
  if (t === '') return true
  const lower = t.toLowerCase()
  for (const word of UNTITLED_WORDS) {
    if (lower === word) return true
    // "untitled desk", "new calendar", "untitled document 2" — the placeholder
    // plus a noun and/or a number, and nothing else.
    const re = new RegExp(`^${word}\\s+[a-z]+(\\s+\\d+)?$|^${word}\\s+\\d+$`)
    if (re.test(lower)) return true
  }
  return false
}

/** The longest a derived title may be before it is cut at a word boundary. */
const MAX_TITLE = 60

/**
 * Tidy a candidate into something that belongs in a sidebar.
 *
 * Strips the markdown and list punctuation that comes with lifting a line out
 * of a document, collapses whitespace, and cuts at a word boundary rather than
 * mid-word. Returns '' when nothing usable survives.
 */
export function cleanTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  let t = String(raw)
    // Markdown heading hashes, blockquotes, list bullets and checkboxes.
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s+/, '')
    .replace(/^\s{0,3}[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^\s{0,3}\d+[.)]\s+/, '')
    // Inline emphasis, code ticks and link syntax — keep the link's text.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    // Any remaining control characters or newlines become spaces.
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  // A trailing colon or full stop reads oddly as a name.
  t = t.replace(/[:.,;\s]+$/, '')
  if (t.length <= MAX_TITLE) return t
  const cut = t.slice(0, MAX_TITLE)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > MAX_TITLE * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[:.,;\s]+$/, '')
}

/**
 * The first line of prose worth using as a name.
 *
 * Prefers a heading, because a heading is a name the user already wrote. Falls
 * back to the first substantial line, and then to the first sentence of it.
 *
 * Returns null rather than a guess when the text has nothing to offer — one
 * word of filler, a URL on its own, a row of punctuation. Null is the signal
 * to try the next source, not a failure.
 */
export function titleFromText(text: string | null | undefined): string | null {
  if (!text) return null
  const lines = String(text).split(/\r?\n/)

  // A markdown heading anywhere in the first few lines beats the opening line,
  // which is often a date, a byline or a stray fragment.
  for (const line of lines.slice(0, 8)) {
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) {
      const h = cleanTitle(line)
      if (isUsable(h)) return h
    }
  }

  for (const line of lines) {
    const candidate = cleanTitle(line)
    if (!isUsable(candidate)) continue
    // A long opening paragraph: take its first sentence rather than 60
    // characters cut mid-thought.
    const sentence = candidate.match(/^(.{10,}?[.!?])(\s|$)/)
    if (sentence) {
      const s = cleanTitle(sentence[1])
      if (isUsable(s)) return s
    }
    return candidate
  }
  return null
}

/**
 * Is a candidate a name, or just the first thing in the file?
 *
 * The bar: at least two words or one substantial word, some letters, and not
 * a bare URL. This is what stops "http://…", "---" and "ok" becoming titles.
 */
function isUsable(candidate: string): boolean {
  if (!candidate) return false
  if (candidate.length < 3) return false
  if (!/[a-z]/i.test(candidate)) return false
  if (/^https?:\/\/\S+$/i.test(candidate)) return false
  const words = candidate.split(/\s+/).filter(Boolean)
  if (words.length === 1 && candidate.length < 6) return false
  return true
}

/**
 * A name from a URL, for the things that are really a link — a bookmarked
 * page, a connected app, a browser widget.
 *
 * Prefers the last meaningful path segment ("quarterly-review" →
 * "Quarterly review") and falls back to the hostname, because
 * "notion.so" is a worse name than the page it points at but a much better one
 * than nothing.
 */
export function titleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(String(url))
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null

  const segments = parsed.pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (last) {
    // Drop a file extension and a trailing id/hash, then humanise separators.
    const base = last
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[-_]?[0-9a-f]{8,}$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    const humanised = cleanTitle(base)
    if (isUsable(humanised)) return sentenceCase(humanised)
  }

  const host = parsed.hostname.replace(/^www\./, '')
  if (!host) return null
  // "mail.google.com" → "Mail google" is worse than "mail.google.com"; keep the
  // host verbatim, which at least reads as an address the user recognises.
  return host
}

/** Capitalise the first letter only — slugs arrive all lower case. */
function sentenceCase(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Pull readable text out of a document body, whatever shape that body is in.
 *
 * Documents store very different things per type — prose JSON, a grid of
 * cells, a slide deck, a node graph — and all this needs is enough text to
 * name the thing. So rather than a parser per type, it walks the structure and
 * collects strings in order, which degrades gracefully when a body shape
 * changes and cannot throw on an unexpected one.
 *
 * `limit` caps how much is collected: a title never needs more than the
 * opening, and walking a 10MB sheet to build a 60-character name is waste.
 */
export function textFromBody(body: unknown, limit = 2000): string {
  const out: string[] = []
  let budget = limit

  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > 12) return
    if (typeof node === 'string') {
      const s = node.trim()
      // Skip the machinery: ids, hex colours, type tags, single punctuation.
      if (!s || s.length > 500) return
      if (/^[0-9a-f-]{16,}$/i.test(s)) return
      if (/^#[0-9a-f]{3,8}$/i.test(s)) return
      out.push(s)
      budget -= s.length
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (node && typeof node === 'object') {
      // `text` and `title` first where present — in every editor shape we use,
      // those hold the words a person typed.
      const rec = node as Record<string, unknown>
      for (const key of ['title', 'text', 'content', 'value', 'label']) {
        if (key in rec) walk(rec[key], depth + 1)
      }
      for (const [key, value] of Object.entries(rec)) {
        if (['title', 'text', 'content', 'value', 'label'].includes(key)) continue
        if (key === 'id' || key === 'type' || key === 'kind') continue
        walk(value, depth + 1)
      }
    }
  }

  try {
    walk(typeof body === 'string' ? safeParse(body) : body, 0)
  } catch {
    return ''
  }
  return out.join('\n')
}

function safeParse(s: string): unknown {
  const t = s.trim()
  if (!t) return ''
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t)
    } catch {
      return s
    }
  }
  return s
}

/**
 * The whole free path, in one call: try every deterministic source in order.
 *
 * Returns null when none of them produced a name, which is the ONLY case worth
 * spending a model call on.
 */
export function deriveTitle(input: {
  /** The item's own body/content, in whatever shape it is stored. */
  body?: unknown
  /** A URL, for link-shaped items. */
  url?: string | null
  /** A filename, for file-backed items. */
  filename?: string | null
  /** Free text already extracted by the caller. */
  text?: string | null
}): string | null {
  const fromText = titleFromText(input.text)
  if (fromText) return fromText

  if (input.body !== undefined && input.body !== null) {
    const fromBody = titleFromText(textFromBody(input.body))
    if (fromBody) return fromBody
  }

  if (input.filename) {
    const base = cleanTitle(
      String(input.filename).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_]+/g, ' ')
    )
    if (base && base.length >= 3) return sentenceCase(base)
  }

  const fromUrl = titleFromUrl(input.url)
  if (fromUrl) return fromUrl

  return null
}
