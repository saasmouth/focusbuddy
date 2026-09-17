// PlexiDesign content — the structured document a layout is built FROM.
//
// The old model made you build frames and then pour naked text into them. This
// one inverts it: you bring a document (paste it, import a .docx, pull in a
// PlexiDoc) and it arrives as typed BLOCKS — title, headings, body, lists,
// quotes, images. The layout engine then decides how those blocks become pages,
// columns, frames and threads.
//
// Blocks are the contract between "what the author wrote" and "how it is set".
// Nothing here invents content: every parser only ever re-shapes text that was
// already there, which is why a redesign can never silently rewrite a document.

export type ContentBlock =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string; attribution?: string }
  | { kind: 'image'; src: string; alt?: string; caption?: string }
  | { kind: 'divider' }
  | { kind: 'pagebreak' }

export interface ContentDoc {
  blocks: ContentBlock[]
}

export const EMPTY_CONTENT: ContentDoc = { blocks: [] }

export function blockText(b: ContentBlock): string {
  switch (b.kind) {
    case 'title':
    case 'subtitle':
    case 'heading':
    case 'paragraph':
      return b.text
    case 'quote':
      return b.attribution ? `${b.text} — ${b.attribution}` : b.text
    case 'list':
      return b.items.join(' ')
    case 'image':
      return b.caption ?? b.alt ?? ''
    default:
      return ''
  }
}

export interface ContentStats {
  words: number
  paragraphs: number
  headings: number
  images: number
  lists: number
  quotes: number
  hasTitle: boolean
  /** Longest paragraph in words — a signal for whether the piece is long-form. */
  longestParagraph: number
}

export function contentStats(doc: ContentDoc): ContentStats {
  const s: ContentStats = {
    words: 0,
    paragraphs: 0,
    headings: 0,
    images: 0,
    lists: 0,
    quotes: 0,
    hasTitle: false,
    longestParagraph: 0
  }
  for (const b of doc.blocks) {
    const words = blockText(b).split(/\s+/).filter(Boolean).length
    s.words += words
    if (b.kind === 'title') s.hasTitle = true
    else if (b.kind === 'heading') s.headings++
    else if (b.kind === 'paragraph') {
      s.paragraphs++
      s.longestParagraph = Math.max(s.longestParagraph, words)
    } else if (b.kind === 'image') s.images++
    else if (b.kind === 'list') s.lists++
    else if (b.kind === 'quote') s.quotes++
  }
  return s
}

export function isContentEmpty(doc: ContentDoc): boolean {
  return doc.blocks.every((b) => blockText(b).trim() === '' && b.kind !== 'image')
}

// ── Normalisation ────────────────────────────────────────────────────────────

export function normalizeContent(raw: unknown): ContentDoc {
  if (!raw || typeof raw !== 'object') return { blocks: [] }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.blocks)) return { blocks: [] }
  const blocks: ContentBlock[] = []
  for (const b of r.blocks as unknown[]) {
    const block = normalizeBlock(b)
    if (block) blocks.push(block)
  }
  return { blocks }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function normalizeBlock(raw: unknown): ContentBlock | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  switch (b.kind) {
    case 'title':
    case 'subtitle':
    case 'paragraph':
      return { kind: b.kind, text: str(b.text) } as ContentBlock
    case 'heading': {
      const lvl = b.level === 2 ? 2 : b.level === 3 ? 3 : 1
      return { kind: 'heading', level: lvl, text: str(b.text) }
    }
    case 'list': {
      const items = Array.isArray(b.items) ? (b.items as unknown[]).map(str).filter((t) => t !== '') : []
      return items.length ? { kind: 'list', ordered: b.ordered === true, items } : null
    }
    case 'quote':
      return { kind: 'quote', text: str(b.text), ...(str(b.attribution) ? { attribution: str(b.attribution) } : {}) }
    case 'image':
      return str(b.src) ? { kind: 'image', src: str(b.src), ...(str(b.alt) ? { alt: str(b.alt) } : {}), ...(str(b.caption) ? { caption: str(b.caption) } : {}) } : null
    case 'divider':
      return { kind: 'divider' }
    case 'pagebreak':
      return { kind: 'pagebreak' }
    default:
      return null
  }
}

// ── Plain text / Markdown-ish ────────────────────────────────────────────────

/**
 * Parse pasted or typed plain text. Markdown conventions are honoured because
 * they are what people already type, but plain prose works untouched: a blank
 * line separates paragraphs, and the first line becomes the title when nothing
 * else marks one.
 */
export function parsePlainText(input: string, opts: { firstLineIsTitle?: boolean } = {}): ContentDoc {
  const blocks: ContentBlock[] = []
  const lines = input.replace(/\r\n?/g, '\n').split('\n')

  let paraBuf: string[] = []
  let listBuf: { ordered: boolean; items: string[] } | null = null

  const flushPara = (): void => {
    const text = paraBuf.join(' ').trim()
    paraBuf = []
    if (text) blocks.push({ kind: 'paragraph', text })
  }
  const flushList = (): void => {
    if (listBuf && listBuf.items.length) blocks.push({ kind: 'list', ordered: listBuf.ordered, items: listBuf.items })
    listBuf = null
  }
  const flushAll = (): void => {
    flushPara()
    flushList()
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line === '') {
      flushAll()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const hashes = heading[1].length
      const text = heading[2].trim()
      if (hashes === 1 && !blocks.some((b) => b.kind === 'title')) blocks.push({ kind: 'title', text })
      else blocks.push({ kind: 'heading', level: hashes <= 2 ? 1 : hashes === 3 ? 2 : 3, text })
      continue
    }

    if (/^(---|___|\*\*\*)$/.test(line)) {
      flushAll()
      blocks.push({ kind: 'divider' })
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushAll()
      const text = quote[1].trim()
      // "— Name" on the quote's own line is an attribution, not a new quote.
      const attributed = /^(.*?)\s+[—–-]{1,2}\s*([^—–-]{2,60})$/.exec(text)
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'quote' && !last.attribution && /^[—–-]{1,2}\s*(.+)$/.test(text)) {
        last.attribution = text.replace(/^[—–-]{1,2}\s*/, '')
      } else if (attributed) {
        blocks.push({ kind: 'quote', text: attributed[1].trim(), attribution: attributed[2].trim() })
      } else {
        blocks.push({ kind: 'quote', text })
      }
      continue
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(line)
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushPara()
      const ordered = !!numbered
      const item = (bullet ? bullet[1] : numbered![2]).trim()
      if (!listBuf || listBuf.ordered !== ordered) {
        flushList()
        listBuf = { ordered, items: [] }
      }
      listBuf.items.push(item)
      continue
    }

    flushList()
    paraBuf.push(line)
  }
  flushAll()

  // With no explicit title, promote the first short paragraph — a headline is
  // almost always the first line and almost never a full sentence of prose.
  if (opts.firstLineIsTitle !== false && !blocks.some((b) => b.kind === 'title')) {
    const first = blocks[0]
    if (first && first.kind === 'paragraph') {
      const words = first.text.split(/\s+/).filter(Boolean)
      if (words.length >= 2 && words.length <= 14 && !/[.!?]$/.test(first.text)) {
        blocks[0] = { kind: 'title', text: first.text }
        const second = blocks[1]
        // A second short line right under a headline reads as a standfirst.
        if (second && second.kind === 'paragraph') {
          const w2 = second.text.split(/\s+/).filter(Boolean)
          if (w2.length <= 28 && blocks.length > 2) blocks[1] = { kind: 'subtitle', text: second.text }
        }
      }
    }
  }

  return { blocks }
}

/** Turn a content doc back into the plain text the story editor shows. */
export function toPlainText(doc: ContentDoc): string {
  const out: string[] = []
  for (const b of doc.blocks) {
    switch (b.kind) {
      case 'title':
        out.push(`# ${b.text}`)
        break
      case 'subtitle':
        out.push(`## ${b.text}`)
        break
      case 'heading':
        out.push(`${'#'.repeat(b.level === 1 ? 3 : b.level === 2 ? 4 : 5)} ${b.text}`)
        break
      case 'paragraph':
        out.push(b.text)
        break
      case 'list':
        out.push(b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join('\n'))
        break
      case 'quote':
        out.push(`> ${b.text}${b.attribution ? `\n> — ${b.attribution}` : ''}`)
        break
      case 'image':
        out.push(`[image${b.caption ? `: ${b.caption}` : ''}]`)
        break
      case 'divider':
        out.push('---')
        break
      case 'pagebreak':
        out.push('===')
        break
    }
  }
  return out.join('\n\n')
}

// ── HTML (what a real paste carries) ─────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
}

function stripTags(html: string): string {
  // Newlines survive: a <br> is converted to one before scanning and is a real
  // paragraph break, so collapsing it away would silently merge two lines.
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

/**
 * Parse the text/html flavour of a clipboard paste (Word, Google Docs, a web
 * page). Deliberately a tolerant scanner rather than a DOM parse: it runs in the
 * shared layer with no document available, and a paste is never trustworthy
 * enough to warrant strict parsing.
 */
export function parseHtml(html: string): ContentDoc {
  const blocks: ContentBlock[] = []
  // Drop the parts of a paste that are never content.
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')

  const tagRe = /<(h1|h2|h3|h4|h5|h6|p|li|blockquote|img|hr|ol|ul)\b([^>]*)>([\s\S]*?)<\/\1>|<(img|hr)\b([^>]*)\/?>/gi
  let m: RegExpExecArray | null
  let listBuf: { ordered: boolean; items: string[] } | null = null
  const flushList = (): void => {
    if (listBuf && listBuf.items.length) blocks.push({ kind: 'list', ordered: listBuf.ordered, items: listBuf.items })
    listBuf = null
  }

  while ((m = tagRe.exec(body)) !== null) {
    const tag = (m[1] ?? m[4] ?? '').toLowerCase()
    const attrs = m[2] ?? m[5] ?? ''
    const inner = m[3] ?? ''

    if (tag === 'img') {
      flushList()
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
      const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]
      // Only self-contained images survive a paste; a remote URL would break the
      // moment the document moved, so it is dropped rather than half-imported.
      if (src && src.startsWith('data:')) blocks.push({ kind: 'image', src, ...(alt ? { alt } : {}) })
      continue
    }
    if (tag === 'hr') {
      flushList()
      blocks.push({ kind: 'divider' })
      continue
    }
    if (tag === 'ol' || tag === 'ul') {
      // The scanner consumes the whole wrapper, so its <li>s never come round
      // again — they are read out here instead.
      flushList()
      const items: string[] = []
      const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi
      let li: RegExpExecArray | null
      while ((li = liRe.exec(inner)) !== null) {
        const t = stripTags(li[1]).replace(/\n+/g, ' ').trim()
        if (t) items.push(t)
      }
      if (items.length) blocks.push({ kind: 'list', ordered: tag === 'ol', items })
      continue
    }

    const text = stripTags(inner)
    if (tag === 'li') {
      // A stray <li> outside any wrapper (some pastes do this) still becomes a
      // list item; without a wrapper there is nothing to say it is ordered.
      if (!listBuf) listBuf = { ordered: false, items: [] }
      if (text) listBuf.items.push(text.replace(/\n+/g, ' ').trim())
      continue
    }

    flushList()
    if (!text) continue
    if (tag === 'blockquote') blocks.push({ kind: 'quote', text })
    else if (tag === 'h1') blocks.push(blocks.some((b) => b.kind === 'title') ? { kind: 'heading', level: 1, text } : { kind: 'title', text })
    else if (tag === 'h2') blocks.push({ kind: 'heading', level: 1, text })
    else if (tag === 'h3') blocks.push({ kind: 'heading', level: 2, text })
    else if (tag === 'h4' || tag === 'h5' || tag === 'h6') blocks.push({ kind: 'heading', level: 3, text })
    else {
      // A paragraph that only held a <br>-separated run becomes several.
      for (const part of text.split('\n').map((t) => t.trim()).filter(Boolean)) blocks.push({ kind: 'paragraph', text: part })
    }
  }
  flushList()

  // Nothing recognisable (a plain-text paste mislabelled as HTML) — fall back
  // rather than returning an empty document.
  if (blocks.length === 0) return parsePlainText(stripTags(body))
  return { blocks }
}

// ── Tiptap (a PlexiDocs document) ────────────────────────────────────────────

interface TipNode {
  type?: string
  attrs?: Record<string, unknown>
  content?: TipNode[]
  text?: string
}

function tipText(node: TipNode): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(tipText).join('')
}

/** Convert a PlexiDocs (Tiptap) body into content blocks. */
export function parseTiptap(raw: unknown): ContentDoc {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // A doc body may be the ProseMirror doc itself or { doc, headingStyles }.
  const docNode = (root.doc && typeof root.doc === 'object' ? root.doc : root) as TipNode
  const blocks: ContentBlock[] = []

  for (const node of docNode.content ?? []) {
    const text = tipText(node).trim()
    switch (node.type) {
      case 'heading': {
        const level = Number(node.attrs?.level ?? 1)
        if (!text) break
        if (level === 1 && !blocks.some((b) => b.kind === 'title')) blocks.push({ kind: 'title', text })
        else blocks.push({ kind: 'heading', level: level <= 2 ? 1 : level === 3 ? 2 : 3, text })
        break
      }
      case 'blockquote':
        if (text) blocks.push({ kind: 'quote', text })
        break
      case 'bulletList':
      case 'orderedList': {
        const items = (node.content ?? []).map((li) => tipText(li).trim()).filter(Boolean)
        if (items.length) blocks.push({ kind: 'list', ordered: node.type === 'orderedList', items })
        break
      }
      case 'horizontalRule':
        blocks.push({ kind: 'divider' })
        break
      case 'image': {
        const src = String(node.attrs?.src ?? '')
        if (src.startsWith('data:')) blocks.push({ kind: 'image', src, ...(node.attrs?.alt ? { alt: String(node.attrs.alt) } : {}) })
        break
      }
      default:
        if (text) blocks.push({ kind: 'paragraph', text })
    }
  }
  return { blocks }
}

/**
 * The right parser for whatever arrived. A paste hands over both flavours; HTML
 * is preferred because it carries the structure, with plain text as the fallback.
 */
export function parsePaste(input: { html?: string; text?: string }): ContentDoc {
  if (input.html && input.html.trim()) {
    const parsed = parseHtml(input.html)
    if (parsed.blocks.length > 0) return parsed
  }
  return parsePlainText(input.text ?? '')
}

// ── Sentences, for pull quotes ───────────────────────────────────────────────

/**
 * Split a paragraph into sentences. Used to pick a pull quote, which must be a
 * VERBATIM sentence the author wrote — a layout tool may re-set the words, never
 * write new ones.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'“‘])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * The best pull-quote candidate in a paragraph: a sentence long enough to carry
 * a display setting but short enough to fit one, or null when there is none.
 * Returning null is the honest answer for a paragraph of short clauses.
 */
export function pullQuoteFrom(text: string, opts: { minWords?: number; maxWords?: number } = {}): string | null {
  const min = opts.minWords ?? 8
  const max = opts.maxWords ?? 28
  let best: string | null = null
  // Scores are negative distances from the ideal length, so the floor has to be
  // -Infinity; a -1 floor rejected every sentence more than one word off ideal.
  let bestScore = -Infinity
  for (const s of sentencesOf(text)) {
    const words = s.split(/\s+/).filter(Boolean).length
    if (words < min || words > max) continue
    // Prefer something near the middle of the range — long enough to matter,
    // short enough to set large.
    const score = -Math.abs(words - (min + max) / 2)
    if (score > bestScore) {
      bestScore = score
      best = s
    }
  }
  return best
}
