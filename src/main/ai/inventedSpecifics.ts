// Did the model state a specific it was never given?
//
// GROUNDING_RULE tells the content generators to write the prose freely but
// never to assert an unsupplied specific as fact. A large model follows that
// well. A 4B does not: it is exactly the kind of long, conditional instruction
// a small model drops halfway through a draft, and the local path cannot fall
// back on the model simply being careful.
//
// So this checks the output instead of trusting the instruction. It is the
// same shape as claimCheck.ts — pure, dependency-free, HIGH PRECISION and low
// recall — and for the same reason: a false positive puts "[check this]" on a
// perfectly good sentence, and a tool that cries wolf gets turned off, taking
// the true positives with it. Every rule below that could fire on ordinary
// prose has a guard, and when the two are in tension the guard wins.
//
// What it does NOT do: judge whether a claim is TRUE. "The average power drill
// is used for twelve minutes in its lifetime" may well be accurate. The point
// is that the brief did not say it, so the user never asked the model to
// vouch for it and cannot tell that it did.

/** What kind of specific was asserted. */
export type SpecificKind = 'number' | 'name' | 'date' | 'money' | 'percent' | 'org' | 'quote'

/**
 * How safe this finding is to act on without a person looking.
 *
 * Needed because the detectors are not equally sure of themselves, and a
 * consumer that treats them alike produces either noise or misses. Measured on
 * a realistic 300-word grounded draft, the only finding was "two weeks" as a
 * ramp-up period: a genuine unsupplied specific, but a mild one. Flagging that
 * as loudly as a fabricated statistic teaches people to dismiss the check, and
 * a dismissed check catches nothing.
 *
 *  high   unambiguous syntax — money, percentages, dates, quotations. Safe to
 *         highlight, and the right set to repair into placeholders.
 *  medium a figure with a real-world unit, or a Title Case name. Both caught
 *         real eval failures ("12 minutes", "Spring Sale"), both can misfire.
 *  low    a quantity written out in words. Correct often enough to report,
 *         wrong often enough that it should not interrupt anyone.
 */
export type Confidence = 'high' | 'medium' | 'low'

export interface InventedSpecific {
  /** The exact text as it appears in the output, for highlighting. */
  span: string
  kind: SpecificKind
  confidence: Confidence
  /** Why it was flagged, phrased for a person reading a review UI. */
  reason: string
  /** Character offset of `span` in the ORIGINAL output, for span highlighting. */
  index: number
}

export interface CheckResult {
  flagged: InventedSpecific[]
  clean: boolean
}

export interface CheckOptions {
  /**
   * Skip the Title Case name detector. Worth setting for marketing copy, where
   * an invented product or campaign name is the POINT of the exercise, and for
   * creative briefs that ask for naming. Default false.
   */
  allowNewNames?: boolean
  /** Cap on returned findings, highest confidence first. Default 25. */
  limit?: number
  /**
   * Drop findings below this confidence. A consumer that repairs spans
   * automatically should pass 'high'; one that highlights for review can take
   * the default and show the rest quietly.
   */
  minConfidence?: Confidence
}

/**
 * Number words, so a brief saying "2 clients" grounds a draft saying "two
 * clients". Without this the checker flags a correctly grounded sentence for
 * spelling a numeral out, which is the single most likely false positive.
 */
const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100',
  thousand: '1000', million: '1000000'
}

/**
 * Nouns that count parts of the ARTEFACT rather than things in the world.
 * "three sections", "step 4", "slide 2" describe the document being written,
 * so a number attached to one of these asserts nothing about the user and must
 * never be flagged. This list is the main reason the number detector is safe
 * to run on a structured draft at all.
 */
const STRUCTURAL_NOUNS = new Set([
  'step', 'steps', 'phase', 'phases', 'stage', 'stages', 'section', 'sections',
  'slide', 'slides', 'page', 'pages', 'part', 'parts', 'chapter', 'chapters',
  'column', 'columns', 'row', 'rows', 'cell', 'cells', 'item', 'items',
  'point', 'points', 'bullet', 'bullets', 'paragraph', 'paragraphs',
  'heading', 'headings', 'option', 'options', 'example', 'examples',
  'question', 'questions', 'tab', 'tabs', 'field', 'fields', 'level', 'levels',
  'category', 'categories', 'column_header', 'placeholder', 'placeholders',
  'list', 'lists', 'table', 'tables', 'chart', 'charts', 'appendix', 'note', 'notes'
])

/**
 * Title Case words that are not names: calendar words, and the connectives and
 * sentence-openers that let a two-word capitalised run form by accident.
 */
const NOT_A_NAME = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'of', 'to', 'in', 'on', 'at',
  'by', 'with', 'from', 'this', 'that', 'these', 'those', 'it', 'we', 'you',
  'they', 'he', 'she', 'our', 'your', 'their', 'his', 'her', 'its',
  'if', 'when', 'while', 'after', 'before', 'because', 'however', 'then',
  'next', 'first', 'second', 'third', 'finally', 'overview', 'summary',
  'introduction', 'conclusion', 'background', 'purpose', 'scope', 'goals',
  'objectives', 'risks', 'timeline', 'budget', 'owner', 'status', 'notes',
  'appendix', 'agenda', 'actions', 'yes', 'no'
])

/**
 * Words that commonly open a sentence or a headline and are capitalised for
 * that reason alone. Without this, "Introducing Lumen Flask" is reported whole
 * and the highlight covers a verb; with it, the span is the name itself.
 */
const SENTENCE_LEAD = new Set([
  'introducing', 'announcing', 'presenting', 'launching', 'welcome', 'meet',
  'discover', 'try', 'get', 'join', 'visit', 'book', 'order', 'save', 'learn',
  'read', 'see', 'explore', 'celebrate', 'enjoy', 'shop', 'start', 'build',
  'make', 'take', 'find', 'choose', 'bring', 'keep', 'review', 'consider',
  'remember', 'note', 'imagine', 'say', 'ask', 'use', 'add'
])

/** Units that make a bare number a claim about the world rather than a count. */
const UNIT = String.raw`minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|quarters?|` +
  String.raw`seconds?|secs?|ms|times|x|users?|customers?|clients?|people|persons?|employees?|` +
  String.raw`staff|members?|subscribers?|seats?|licen[cs]es?|accounts?|teams?|stores?|offices?|` +
  String.raw`orders?|requests?|tickets?|leads?|deals?|units?|products?|sales?|visits?|views?|` +
  String.raw`downloads?|installs?|signups?|sign-ups?|kg|lbs?|km|miles?|m|ft|gb|mb|tb|kb`

/** Normalise for presence testing: case, separators and padding all ignored. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[^a-z0-9'%$£€./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Digits only, so "1,200" and "1200" and "$1200" compare equal. */
function digits(s: string): string {
  return s.replace(/[^\d]/g, '')
}

/**
 * Remove the regions where a specific is not a factual assertion:
 *
 *  - fenced and inline code, and spreadsheet formulas, where digits are syntax;
 *  - HTML tags, because an attribute value is syntax wearing quotation marks.
 *    This one was measured, not guessed: on a 3-sample local run, 36 of 141
 *    flags (26%) were CSS out of style="..." — 'color: #1e3c72; font-size:
 *    18px' read as a fabricated quotation. Every one was high confidence, so
 *    every one would have been REPAIRED, and repairing a style attribute
 *    corrupts the markup. suggestDocContent and rewriteSelection both emit
 *    HTML fragments (see DOC_HTML_CONTRACT), so this is the normal case for
 *    them, not an edge case;
 *  - bracketed placeholders, because GROUNDING_RULE instructs the model to
 *    write "[launch date]" and flagging its own prescribed output would make
 *    the checker fight the rule it exists to enforce.
 *
 * Regions are blanked rather than deleted so every reported index still points
 * into the original string, and they are blanked with NUL rather than spaces.
 * Spaces looked harmless and were not: a masked tag became a run of spaces,
 * \s+ in the name detector bridged it, and '<h3 ...>Pulse Launch</h3><p>Follow
 * up' was reported as the name "Pulse Launch        Follow". NUL preserves the
 * offsets exactly as spaces did, but no detector can match across it, so
 * masking can only ever remove a finding and never invent one.
 */
function maskNonAssertions(text: string): string {
  const blank = (m: string): string => '\0'.repeat(m.length)
  return text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    // A letter must follow "<" so that prose like "if x < 5 and y > 3" keeps
    // its numbers; only something shaped like a tag is masked.
    .replace(/<\/?[a-zA-Z][^>]*>/g, blank)
    .replace(/^\s*=[^\n]*/gm, blank)
    .replace(/\[[^\]\n]{0,80}\]/g, blank)
}

/** True when the supplied context grounds this span. */
function isSupplied(span: string, haystack: string, haystackDigits: string): boolean {
  const n = norm(span)
  if (n && haystack.includes(n)) return true

  // A numeric span is grounded by its digits appearing anywhere in context: a
  // brief that says "1,200 seats" grounds "1200 seats" and "$1,200".
  const d = digits(span)
  if (d && d.length >= 2 && haystackDigits.includes(d)) return true

  // A spelled-out number is grounded by its numeral, and vice versa.
  const words = n.split(' ')
  for (const w of words) {
    const asDigit = NUMBER_WORDS[w]
    if (asDigit && haystackDigits.includes(asDigit)) {
      const rest = words.filter((x) => x !== w).join(' ')
      if (!rest || haystack.includes(rest)) return true
    }
  }
  return false
}

interface Candidate {
  span: string
  index: number
  kind: SpecificKind
  reason: string
}

/** Collect every candidate specific, before any grounding test. */
function candidates(masked: string, opts: CheckOptions): Candidate[] {
  const out: Candidate[] = []
  const push = (m: RegExpMatchArray, kind: SpecificKind, reason: string, group = 0): void => {
    const span = (m[group] ?? '').trim()
    if (!span) return
    const at = m.index === undefined ? -1 : m.index + (m[0].indexOf(span) < 0 ? 0 : m[0].indexOf(span))
    out.push({ span, index: at, kind, reason })
  }
  const scan = (re: RegExp, fn: (m: RegExpMatchArray) => void): void => {
    for (const m of masked.matchAll(re)) fn(m)
  }

  // Money. Unambiguous and never structural, so no guard is needed.
  scan(/[$£€]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|billion|million|thousand))?/gi, (m) =>
    push(m, 'money', 'a monetary figure that is not in the brief')
  )

  // Percentages.
  scan(/\b\d+(?:\.\d+)?\s?(?:%|per ?cent\b)/gi, (m) =>
    push(m, 'percent', 'a percentage that is not in the brief')
  )

  // Dates and years. A bare year counts: "in 2026" dates a plan nobody dated.
  scan(
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?\b/gi,
    (m) => push(m, 'date', 'a specific date that is not in the brief')
  )
  scan(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => push(m, 'date', 'a specific date that is not in the brief'))
  scan(/\bQ[1-4](?:\s+(?:19|20)\d{2})?\b/g, (m) => push(m, 'date', 'a specific quarter that is not in the brief'))
  scan(/\b(?:19|20)\d{2}\b/g, (m) => push(m, 'date', 'a specific year that is not in the brief'))

  // A number with a real-world unit. The unit is what makes it a claim.
  scan(new RegExp(String.raw`\b\d[\d,]*(?:\.\d+)?\s*(?:${UNIT})\b`, 'gi'), (m) =>
    push(m, 'number', 'a quantity that is not in the brief')
  )

  // A quantity written out, then up to two modifiers, then a plural noun:
  // "two new clients", "three enterprise customers". Skipped when the noun
  // counts part of the document instead of something in the world.
  scan(
    new RegExp(
      String.raw`\b(${Object.keys(NUMBER_WORDS).join('|')}|dozens?|hundreds?|thousands?)\s+(?:[a-z][a-z-]*[^s\W]\s+){0,2}([a-z][a-z-]*s)\b`,
      'gi'
    ),
    (m) => {
      // A structural word ANYWHERE in the span disqualifies it. Matching only
      // the noun slot was not enough: in "the two columns holds one example"
      // the slot fell on "holds" and "columns" slipped through.
      const words = m[0].toLowerCase().split(/\s+/)
      if (words.some((w) => STRUCTURAL_NOUNS.has(w))) return
      push(m, 'number', 'a count of something that is not in the brief')
    }
  )

  // Anything presented as a quotation. Short runs are skipped because quotes
  // are also used for emphasis and for naming a field.
  scan(/[“"]([^”"\n]{12,240})[”"]/g, (m) =>
    push(m, 'quote', 'a quotation that does not appear in the source material', 1)
  )

  // Title Case runs of two or more words, mid-sentence only. This is the
  // loosest detector by far, hence the heaviest guards: it must not fire at a
  // sentence start, on a heading, or on calendar and connective words.
  if (!opts.allowNewNames) {
    const headingsMasked = masked.replace(/^\s*#{1,6}[^\n]*/gm, (h) => ' '.repeat(h.length))
    for (const m of headingsMasked.matchAll(/([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){1,3})/g)) {
      let span = m[1]
      let at = m.index ?? 0
      let words = span.split(/\s+/)

      // At a sentence start the first word's capital says nothing about
      // whether it is a name. Suppressing the whole run on that basis lost
      // "Spring Sale"; keeping it whole gave "Introducing Lumen Flask". So
      // drop the lead word only when it is one that opens a sentence rather
      // than naming anything, and judge what is left.
      const atStart = /(?:^|[.!?:;]\s*|\n\s*(?:[-*#>]\s*)?)$/.test(headingsMasked.slice(0, at))
      if (atStart && words.length > 2 && SENTENCE_LEAD.has(words[0].toLowerCase())) {
        at += words[0].length + 1
        words = words.slice(1)
        span = words.join(' ')
      }

      if (words.length < 2) continue
      if (words.every((w) => NOT_A_NAME.has(w.toLowerCase()))) continue
      if (NOT_A_NAME.has(words[0].toLowerCase())) continue
      if (SENTENCE_LEAD.has(words[0].toLowerCase())) continue
      out.push({
        span,
        index: at,
        kind: 'name',
        reason: 'a name that does not appear in the brief or the source material'
      })
    }
  }
  return out
}

/** Confidence order: the unambiguous kinds first, the loosest detector last. */
const KIND_ORDER: SpecificKind[] = ['money', 'percent', 'date', 'quote', 'number', 'org', 'name']

const CONFIDENCE_ORDER: Confidence[] = ['high', 'medium', 'low']

/**
 * A span's confidence. `number` splits on form rather than kind: "400 pages"
 * is a figure someone could act on, "two weeks" is usually a turn of phrase,
 * and only the digits tell them apart.
 */
function confidenceOf(kind: SpecificKind, span: string): Confidence {
  if (kind === 'money' || kind === 'percent' || kind === 'date' || kind === 'quote') return 'high'
  if (kind === 'name' || kind === 'org') return 'medium'
  return /\d/.test(span) ? 'medium' : 'low'
}

/**
 * Flag specifics in `output` that appear nowhere in `supplied`.
 *
 * `supplied` is everything the model was legitimately working from: the user's
 * prompt, retrieved documents, table rows, a transcript. Pass it all — a
 * specific grounded in ANY of it is grounded.
 */
export function checkInventedSpecifics(
  output: string,
  supplied: string[] | string,
  opts: CheckOptions = {}
): CheckResult {
  const text = output ?? ''
  if (!text.trim()) return { flagged: [], clean: true }

  const context = (Array.isArray(supplied) ? supplied : [supplied]).filter(Boolean).join('\n')
  const haystack = norm(context)
  const haystackDigits = digits(context)

  const masked = maskNonAssertions(text)
  const seen = new Set<string>()
  const flagged: InventedSpecific[] = []

  for (const c of candidates(masked, opts)) {
    if (isSupplied(c.span, haystack, haystackDigits)) continue
    const key = `${c.kind}:${norm(c.span)}`
    if (seen.has(key)) continue
    seen.add(key)
    flagged.push({
      span: c.span,
      kind: c.kind,
      confidence: confidenceOf(c.kind, c.span),
      reason: c.reason,
      index: c.index
    })
  }

  flagged.sort((a, b) => {
    const conf = CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence)
    if (conf !== 0) return conf
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    return k !== 0 ? k : a.index - b.index
  })

  const floor = CONFIDENCE_ORDER.indexOf(opts.minConfidence ?? 'low')
  const kept = flagged.filter((f) => CONFIDENCE_ORDER.indexOf(f.confidence) <= floor)
  const limit = opts.limit ?? 25
  return { flagged: kept.slice(0, limit), clean: kept.length === 0 }
}

/**
 * The short, blunt grounding rule for a small local model.
 *
 * GROUNDING_RULE explains itself, which is right for a model that can hold a
 * conditional instruction across a long draft. A 4B cannot reliably, so this
 * variant gives up the explanation and keeps the prohibition, in the order a
 * small model is most likely to still be following at the end: what to do,
 * then what never to do.
 */
export const GROUNDING_RULE_SMALL =
  ' Use only facts from the request. Write the prose and the structure yourself,' +
  ' but never state a number, name, date, price, percentage or quotation that the' +
  ' request did not give you. If you need one, write it in square brackets like' +
  ' [launch date]. Never guess a specific.'
