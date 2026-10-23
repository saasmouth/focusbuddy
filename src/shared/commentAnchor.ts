// Where a comment is, kept WITH THE COMMENT instead of in the document.
//
// A comment anchor used to be a mark in the body (editor/CommentMark.ts), so
// leaving a comment was a document write. That made commenting impossible for
// a viewer of a shared document: signal v123 refuses a viewer's updates, so
// the thread would be created over REST while its anchor was dropped, leaving
// a thread pointing at a span nobody else could see. The owner wants viewers
// to comment, so the anchor moves out of the body.
//
// THREE MECHANISMS, because each covers what the others cannot:
//
//   1. A Yjs RelativePosition pair, for a LIVE document. Co-editing makes an
//      offset stale the moment anyone inserts before it, and a relative
//      position references an item rather than a count, so it survives
//      concurrent edits by construction.
//
//   2. Plain from/to, rebased through each transaction's mapping, for a LOCAL
//      document while its editor is open (ProseMirror's tr.mapping.map).
//
//   3. A QUOTE of the anchored text, for everything mechanisms 1 and 2 cannot
//      see. I had argued a local document has one editor so rebased offsets
//      cannot drift. That premise is false, twice over:
//        - bodies are written by paths with no transaction at all — AI actions
//          rebuild the content wholesale (actionExecutor.ts, where a PREPEND
//          shifts every offset in the document), MCP tools write by id, and a
//          version-history restore swaps the body underneath;
//        - and a local document can be open TWICE at once, because a desk
//          widget (OfficeDocWidget) backs itself with the same fb_documents
//          row and saves it directly, so an insert typed in the widget never
//          reaches the Documents view's mapping.
//      Both were found by review rather than by me, and both have the same
//      failure mode: nothing errors, and the editor draws a highlight at stale
//      offsets, attaching a thread to words nobody commented on. A missing
//      highlight is a nuisance; a confidently wrong one is a lie.
//
// So an anchor is verified against its quote before it is ever drawn.
//
// Pure on purpose: no ProseMirror, no Yjs, no DOM. The editor converts a
// relative position to an index and hands the text in; this decides what is
// true. That is also the seam agreed with ec, who owns the decoration plugin:
// resolved ranges out of here, no ProseMirror in this file and no Yjs in
// theirs.

/** A position in a Yjs document, as relativePositionToJSON writes it. */
export type YjsRelativePositionJson = Record<string, unknown>

/**
 * A copy of the text the comment is on, with a little context either side.
 *
 * Capped: a comment on three pages must not store three pages. The cap is why
 * verification compares a PREFIX rather than the whole span.
 */
export interface AnchorQuote {
  /** The anchored text, up to QUOTE_MAX characters. */
  text: string
  /** True when `text` is only the start of the anchored span. */
  truncated?: boolean
  /** A little text before and after, to tell two identical passages apart. */
  before?: string
  after?: string
}

export const QUOTE_MAX = 160
export const CONTEXT_MAX = 24

export interface YjsCommentAnchor {
  kind: 'yjs'
  start: YjsRelativePositionJson
  end: YjsRelativePositionJson
  quote?: AnchorQuote
}

export interface LocalCommentAnchor {
  kind: 'local'
  /** Absolute positions, rebased while an editor is open. */
  from: number
  to: number
  quote?: AnchorQuote
}

export type CommentAnchor = YjsCommentAnchor | LocalCommentAnchor

export interface ResolvedRange {
  from: number
  to: number
}

/** What became of one anchor when the document was read. */
export type AnchorOutcome =
  /** The range still holds its quote (or has no quote to check). */
  | { status: 'ok'; range: ResolvedRange }
  /**
   * The quote moved and was found again, exactly once. The caller should draw
   * here AND write the corrected anchor back.
   */
  | { status: 'moved'; range: ResolvedRange }
  /**
   * The text is gone, or appears more than once with no way to tell which.
   * Shown as "comment on removed text" — never drawn at a guess.
   */
  | { status: 'orphan'; reason: 'missing' | 'ambiguous' | 'malformed' }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** The quote to store for a new comment, from the document's text. */
export function quoteFor(docText: string, from: number, to: number): AnchorQuote | null {
  if (!isPos(from) || !isPos(to) || to <= from || from >= docText.length) return null
  const full = docText.slice(from, to)
  const text = full.slice(0, QUOTE_MAX)
  if (!text.trim()) return null
  return {
    text,
    ...(full.length > QUOTE_MAX ? { truncated: true } : {}),
    ...(from > 0 ? { before: docText.slice(Math.max(0, from - CONTEXT_MAX), from) } : {}),
    ...(to < docText.length ? { after: docText.slice(to, Math.min(docText.length, to + CONTEXT_MAX)) } : {})
  }
}

/**
 * Read an anchor off a stored comment, or null when there is none to read.
 *
 * Everything here has been through a database and an HTTP boundary, and an
 * older client writes no anchor at all, so absent is ordinary rather than an
 * error. A malformed anchor is treated as absent: a comment with half a range
 * would otherwise highlight an arbitrary span of someone's document.
 *
 * A STRING is parsed, because the two boundaries disagree: SQLite holds the
 * anchor in a TEXT column and hands back JSON, while the signal server's JSON
 * body arrives as an object. Parsing here rather than in each caller is the
 * whole point of a boundary function — and a caller that wrapped it in its own
 * try/catch would be the second place to get it wrong.
 */
export function readCommentAnchor(input: unknown): CommentAnchor | null {
  let raw = input
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!isObj(raw)) return null
  const quote = readQuote(raw.quote)
  if (raw.kind === 'local') {
    if (!isPos(raw.from) || !isPos(raw.to)) return null
    const from = Math.min(raw.from, raw.to)
    const to = Math.max(raw.from, raw.to)
    if (to <= from) return null
    return { kind: 'local', from, to, ...(quote ? { quote } : {}) }
  }
  if (raw.kind === 'yjs') {
    // The relative positions are opaque here: only Yjs reads them, and it is
    // not a dependency of this module. What is checked is that both ends are
    // present, so a half-written anchor never reaches the converter.
    if (!isObj(raw.start) || !isObj(raw.end)) return null
    return { kind: 'yjs', start: raw.start, end: raw.end, ...(quote ? { quote } : {}) }
  }
  return null
}

function readQuote(raw: unknown): AnchorQuote | null {
  if (!isObj(raw) || typeof raw.text !== 'string' || !raw.text) return null
  return {
    text: raw.text.slice(0, QUOTE_MAX),
    ...(raw.truncated === true ? { truncated: true } : {}),
    ...(typeof raw.before === 'string' ? { before: raw.before.slice(-CONTEXT_MAX) } : {}),
    ...(typeof raw.after === 'string' ? { after: raw.after.slice(0, CONTEXT_MAX) } : {})
  }
}

/**
 * Rebase a LOCAL anchor through one edit in the editor that made it.
 *
 * `map` is the transaction's position mapping. assoc -1 at the start and 1 at
 * the end, so text typed at either edge grows the comment rather than escaping
 * it — the behaviour the mark had.
 */
export function rebaseLocalAnchor(
  anchor: LocalCommentAnchor,
  map: (pos: number, assoc?: number) => number
): LocalCommentAnchor | null {
  const from = map(anchor.from, -1)
  const to = map(anchor.to, 1)
  if (!isPos(from) || !isPos(to) || to <= from) return null
  return { ...anchor, from, to }
}

/** Whitespace differences are not text differences, for matching purposes. */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Does the text at this range still hold the quote? */
function holdsQuote(docText: string, range: ResolvedRange, quote: AnchorQuote): boolean {
  const at = norm(docText.slice(range.from, range.to))
  const want = norm(quote.text)
  if (!want) return false
  // A truncated quote is only the START of the span, so a prefix match is the
  // most that can be asked of it.
  return quote.truncated ? at.startsWith(want) : at === want
}

/**
 * Find a quote's text again, and only when there is no doubt about where.
 *
 * EXACT and UNIQUE, with whitespace normalised. Deliberately NOT fuzzy:
 * edit-distance matching would let a comment re-attach to a passage that
 * merely resembles the original, which is the confidently-wrong case this
 * whole mechanism exists to prevent. Two identical passages are separated by
 * the stored context, and if that still leaves it ambiguous the thread is an
 * honest orphan rather than a guess.
 */
export function refindQuote(docText: string, quote: AnchorQuote): ResolvedRange | null {
  const hay = docText
  const needle = quote.text
  if (!needle) return null
  const hits: number[] = []
  for (let i = hay.indexOf(needle); i !== -1 && hits.length <= 8; i = hay.indexOf(needle, i + 1)) hits.push(i)
  if (hits.length === 1) return { from: hits[0]!, to: hits[0]! + needle.length }
  if (hits.length > 1) {
    // Several copies of the same words: the context decides, and only when it
    // picks exactly one.
    const byContext = hits.filter((i) => {
      const beforeOk = !quote.before || norm(hay.slice(Math.max(0, i - CONTEXT_MAX * 2), i)).endsWith(norm(quote.before))
      const afterOk =
        !quote.after || norm(hay.slice(i + needle.length, i + needle.length + CONTEXT_MAX * 2)).startsWith(norm(quote.after))
      return beforeOk && afterOk
    })
    if (byContext.length === 1) return { from: byContext[0]!, to: byContext[0]! + needle.length }
    return null
  }
  // Nothing exact. One more pass with whitespace normalised, because a
  // reflowed paragraph is the same words.
  const nHay = norm(hay)
  const nNeedle = norm(needle)
  if (!nNeedle) return null
  const first = nHay.indexOf(nNeedle)
  if (first === -1 || nHay.indexOf(nNeedle, first + 1) !== -1) return null
  // Both ends map back through the original text. The END cannot be
  // `from + needle.length`: the match may span MORE characters than the
  // needle, because the whitespace it was normalised over is longer in the
  // document ("quite\n  believed" is three characters where the quote has
  // one). Using the needle's length returned a range two characters short —
  // a highlight that was almost right, which is the exact failure this whole
  // mechanism exists to prevent, and it slipped through until the test
  // asserted the matched TEXT instead of just the status.
  const from = originalIndexOf(hay, first)
  if (from === -1) return null
  const endNorm = first + nNeedle.length
  const end = originalIndexOf(hay, endNorm)
  const to = end === -1 ? hay.length : end
  if (to <= from) return null
  return { from, to }
}

/** The position in `raw` whose normalised index is `target`. */
function originalIndexOf(raw: string, target: number): number {
  let n = 0
  let inRun = false
  let leading = true
  for (let i = 0; i < raw.length; i++) {
    const ws = /\s/.test(raw[i]!)
    if (ws) {
      if (leading) continue
      if (!inRun) {
        if (n === target) return i
        n++
        inRun = true
      }
      continue
    }
    inRun = false
    leading = false
    if (n === target) return i
    n++
  }
  return -1
}

/**
 * What to do with one anchor, given the document as it is now.
 *
 * `resolve` turns a stored anchor into a candidate range: for a local anchor
 * that is its from/to; for a Yjs anchor the editor converts its relative
 * positions first (and passes null when they no longer resolve). The quote
 * then decides whether that range is believed.
 */
export function resolveAnchor(
  anchor: CommentAnchor | null,
  docText: string,
  candidate: ResolvedRange | null
): AnchorOutcome {
  if (!anchor) return { status: 'orphan', reason: 'malformed' }
  const clamped = candidate ? clampRange(candidate, docText.length) : null
  // No quote: an anchor written before quotes existed, or by an older client.
  // The candidate is all there is, so it is believed — there is nothing to
  // check it against, and refusing to draw would lose a comment that is
  // probably fine.
  if (!anchor.quote) return clamped ? { status: 'ok', range: clamped } : { status: 'orphan', reason: 'missing' }
  if (clamped && holdsQuote(docText, clamped, anchor.quote)) return { status: 'ok', range: clamped }
  const found = refindQuote(docText, anchor.quote)
  if (found) return { status: 'moved', range: found }
  // Distinguish "gone" from "there but ambiguous", because the second is worth
  // saying differently to a person who can see two identical paragraphs.
  const appears = docText.includes(anchor.quote.text) || norm(docText).includes(norm(anchor.quote.text))
  return { status: 'orphan', reason: appears ? 'ambiguous' : 'missing' }
}

/** Clamp a range to the document, so a stale position cannot throw in the editor. */
export function clampRange(range: ResolvedRange, docSize: number): ResolvedRange | null {
  const max = Math.max(0, docSize)
  const from = Math.min(Math.max(0, range.from), max)
  const to = Math.min(Math.max(0, range.to), max)
  if (to <= from) return null
  return { from, to }
}

// ── The seam with the decoration plugin ─────────────────────────────────────

/** One thread, as a host hands it to the plugin: a range in the CURRENT doc. */
export interface ResolvedThread {
  id: string
  from: number
  to: number
  state: 'open' | 'resolved'
  /** True when the range was re-found rather than believed: the caller should save it back. */
  corrected?: boolean
}

export interface OrphanThread {
  id: string
  reason: 'missing' | 'ambiguous' | 'malformed'
}

export interface ThreadInput {
  id: string
  anchor: unknown
  state?: 'open' | 'resolved'
  /**
   * The candidate range, for a thread whose anchor only the editor can read:
   * a Yjs anchor converted to absolute positions, or null when its relative
   * positions no longer resolve. Omitted for a local anchor, whose own
   * from/to is the candidate.
   */
  candidate?: ResolvedRange | null
}

/**
 * Resolve every thread against the document as it is now.
 *
 * This is the whole of what the decoration plugin needs (ec owns that file):
 * ranges in the current document, and the threads that have no place in it.
 * Called afresh whenever the host has ranges to push — including after a
 * REMOUNT, which is now a real state: a local document's body can be replaced
 * underneath an open editor (a second window, a desk widget, a snapshot
 * restore, sync), and catching up rebuilds the editor, so a plugin's
 * decoration set is gone and there is no transaction history to rebase
 * through. A pure function called again is exactly the right shape for that.
 */
export function resolveThreads(
  threads: ThreadInput[],
  docText: string
): { ranges: ResolvedThread[]; orphans: OrphanThread[] } {
  const ranges: ResolvedThread[] = []
  const orphans: OrphanThread[] = []
  for (const t of threads) {
    const anchor = readCommentAnchor(t.anchor)
    const candidate =
      t.candidate !== undefined ? t.candidate : anchor && anchor.kind === 'local' ? { from: anchor.from, to: anchor.to } : null
    const out = resolveAnchor(anchor, docText, candidate)
    if (out.status === 'orphan') orphans.push({ id: t.id, reason: out.reason })
    else
      ranges.push({
        id: t.id,
        from: out.range.from,
        to: out.range.to,
        state: t.state ?? 'open',
        ...(out.status === 'moved' ? { corrected: true } : {})
      })
  }
  return { ranges, orphans }
}
