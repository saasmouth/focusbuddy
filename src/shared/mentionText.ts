import type { ChatMentionKind } from './types'

// An @-mention that survives being stored as plain text.
//
// The assistant already had references, but they lived beside the message as
// structured data. That works for one input and nowhere else: a sticky note, a
// table cell and a document body are all just strings, and a reference that
// cannot be written INTO a string cannot exist in any of them.
//
// So a mention is markdown-shaped: `@[Ridge St](plexii://desk/abc123)`. Three
// properties earn that choice -- it round-trips through any text column
// untouched, it degrades to something readable if nothing ever parses it, and
// the title travels with the link so a renderer never has to resolve an id
// just to draw a word.

export interface TextMention {
  kind: ChatMentionKind
  id: string
  title: string
  /** The desk a widget or document belongs to, when the link needs one. */
  taskId?: string | null
}

/**
 * The link body for a mention.
 *
 * `plexii://` rather than a bare path because these strings escape into places
 * that will happily linkify a URL -- a markdown widget, a copied note -- and a
 * scheme nothing else claims keeps them ours.
 */
export function mentionHref(m: TextMention): string {
  const base = `plexii://${m.kind}/${encodeURIComponent(m.id)}`
  return m.taskId ? `${base}?desk=${encodeURIComponent(m.taskId)}` : base
}

export function parseMentionHref(href: string): TextMention | null {
  const m = href.match(/^plexii:\/\/([a-z-]+)\/([^?]+)(?:\?desk=(.*))?$/i)
  if (!m) return null
  return {
    kind: m[1] as ChatMentionKind,
    id: decodeURIComponent(m[2]),
    title: '',
    taskId: m[3] ? decodeURIComponent(m[3]) : null
  }
}

/** Titles may contain brackets; escaping them keeps the token parseable. */
const escapeTitle = (t: string): string => t.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
const unescapeTitle = (t: string): string => t.replace(/\\]/g, ']').replace(/\\\\/g, '\\')

export function serialiseMention(m: TextMention): string {
  return `@[${escapeTitle(m.title || 'Untitled')}](${mentionHref(m)})`
}

// One definition of the token, used by the parser, the stripper and the
// autocomplete alike, so they cannot disagree about what a mention looks like.
export const MENTION_TOKEN = /@\[((?:[^\]\\]|\\.)*)\]\((plexii:\/\/[^)\s]+)\)/g

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; mention: TextMention; raw: string }

/** Split text into plain runs and mentions, in order. */
export function parseMentionText(text: string): MentionSegment[] {
  const out: MentionSegment[] = []
  if (!text) return out
  const re = new RegExp(MENTION_TOKEN.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) })
    const parsed = parseMentionHref(m[2])
    if (parsed) {
      out.push({
        type: 'mention',
        mention: { ...parsed, title: unescapeTitle(m[1]) },
        raw: m[0]
      })
    } else {
      // A token whose href we cannot read is shown as the text it is, rather
      // than as a link that goes nowhere.
      out.push({ type: 'text', text: m[0] })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/** Every mention in a string, in order, deduped by target. */
export function extractMentions(text: string): TextMention[] {
  const seen = new Set<string>()
  const out: TextMention[] = []
  for (const seg of parseMentionText(text)) {
    if (seg.type !== 'mention') continue
    const key = `${seg.mention.kind}:${seg.mention.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(seg.mention)
  }
  return out
}

/**
 * The text as a person reads it, with tokens replaced by their titles.
 *
 * Used wherever the raw string would be shown to something that cannot render
 * links -- a search index, a summariser, an AI prompt.
 */
export function stripMentions(text: string): string {
  return parseMentionText(text)
    .map((s) => (s.type === 'text' ? s.text : s.mention.title))
    .join('')
}

export interface MentionQuery {
  /** Index of the `@`. */
  start: number
  /** Index just past the query, i.e. the caret. */
  end: number
  /** What has been typed after the `@`. */
  query: string
}

/**
 * The `@…` being typed at the caret, if any.
 *
 * Deliberately conservative about what starts one. An `@` mid-word is an email
 * address or a handle somebody is writing out, and popping a picker over it is
 * the behaviour that makes @-mentions infuriating in other tools.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null
  // Walk back to the nearest '@' without crossing whitespace or a newline.
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === '@') break
    if (ch === '\n' || ch === ' ' || ch === '\t') return null
    i--
  }
  if (i < 0 || text[i] !== '@') return null
  const before = i > 0 ? text[i - 1] : ''
  // Must start a word: beginning of text, or after whitespace/punctuation.
  if (before && !/[\s(["'<>,;:]/.test(before)) return null
  const query = text.slice(i + 1, caret)
  // A completed token's tail must never re-open the picker.
  if (query.includes(']') || query.includes(')')) return null
  return { start: i, end: caret, query }
}

export interface MentionInsertion {
  text: string
  /** Where the caret should land afterwards. */
  caret: number
}

/** Replace the active `@…` with a real mention, plus a trailing space. */
export function insertMention(
  text: string,
  q: Pick<MentionQuery, 'start' | 'end'>,
  mention: TextMention
): MentionInsertion {
  const token = `${serialiseMention(mention)} `
  const next = text.slice(0, q.start) + token + text.slice(q.end)
  return { text: next, caret: q.start + token.length }
}
