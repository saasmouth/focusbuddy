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
export type SpecificKind = 'number' | 'name' | 'date' | 'money' | 'percent' | 'org' | 'quote' | 'time'

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
 * One number as written, with what does not change its value removed:
 * thousands separators, leading zeros and a zero fraction. "1,200", "1200",
 * "$1,200.00" and "01200" all key as "1200"; "1.5" stays "1.5", so a decimal
 * is never mistaken for the integer its digits spell.
 */
function numberKey(raw: string): string {
  const [int, frac = ''] = raw.replace(/,/g, '').split('.')
  const i = int.replace(/^0+(?=\d)/, '')
  const f = frac.replace(/0+$/, '')
  return f ? `${i}.${f}` : i
}

/** Every number written in `s`, as numberKey keys it. A comma counts only as a thousands separator. */
function numbersIn(s: string): string[] {
  return [...s.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => numberKey(m[0]))
}

const MONTH = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`

/**
 * A date or a clock time written in the supplied context: ISO dates and
 * timestamps, "15:15", "October 23, 2026", "23 October". Its numbers are the
 * parts of a date or a time, not figures, and are kept apart (see NumberIndex).
 */
const CALENDAR_IN_CONTEXT = new RegExp(
  [
    String.raw`\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?`,
    String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\b`,
    String.raw`\b(?:${MONTH})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTH})\b(?:\s+\d{4})?`
  ].join('|'),
  'gi'
)

/** Month number (1-12) of a month name or its abbreviation; 0 when it is not one. */
function monthOf(word: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(word.slice(0, 3).toLowerCase()) + 1
}

interface DateParts {
  y?: number
  m?: number
  d?: number
  q?: number
}

/** The calendar parts of one date as written; null when it names no date (a clock time alone). */
function dateParts(s: string): DateParts | null {
  let m: RegExpMatchArray | null
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(s))) return { y: +m[1], m: +m[2], d: +m[3] }
  if ((m = new RegExp(String.raw`\b(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b`, 'i').exec(s)))
    return { m: monthOf(m[1]), d: +m[2], ...(m[3] ? { y: +m[3] } : {}) }
  if ((m = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH})\b(?:\s+(\d{4}))?`, 'i').exec(s)))
    return { m: monthOf(m[2]), d: +m[1], ...(m[3] ? { y: +m[3] } : {}) }
  if ((m = /\bQ([1-4])(?:\s+(\d{4}))?\b/.exec(s))) return { q: +m[1], ...(m[2] ? { y: +m[2] } : {}) }
  if ((m = /^\s*((?:19|20)\d{2})\s*$/.exec(s))) return { y: +m[1] }
  return null
}

/**
 * The numbers the supplied context states, each one whole, and the dates it
 * states, as dates.
 *
 * This replaced matching a span's digits as a SUBSTRING of every digit in the
 * context run together, which grounded far more than anyone supplied, and did
 * it by the clock. The chat context opens with the current time
 * ("2026-10-23T15:15Z"), so "$15" counted as supplied whenever the hour or the
 * minute was 15, on the 15th, and at 1:50-1:59, 11:50-11:59 and 21:50-21:59,
 * where the hour's last digit and the minute's first ran together into "15":
 * 113 minutes of every day in which an invented price escaped being marked
 * (the intermittent answerGroundingCloud failure). So:
 *
 *  figures   numbers stated as numbers. A numeric span is grounded only by a
 *            number EQUAL to one of its own, never by digits that happen to
 *            neighbour each other across two numbers;
 *  dates     what a written date or timestamp says, kept as a date. It grounds
 *            a DATE that names the same day, year or quarter ("today is
 *            October 23", "in 2026", "this Q4") and nothing else: the clock's
 *            minute is not a price, a percentage, "15 minutes" or "March 15".
 *            A clock time grounds times only, through isTimeSupplied.
 */
interface NumberIndex {
  figures: Set<string>
  /** "m-d" for each day named, "y" for each year, "Qn" and "Qn y" for each quarter. */
  dates: Set<string>
}

function indexNumbers(context: string): NumberIndex {
  const dates = new Set<string>()
  const rest = context.replace(CALENDAR_IN_CONTEXT, (w) => {
    const p = dateParts(w)
    if (p?.y) dates.add(String(p.y))
    if (p?.m && p.d) {
      dates.add(`${p.m}-${p.d}`)
      const q = Math.ceil(p.m / 3)
      dates.add(`Q${q}`)
      if (p.y) dates.add(`Q${q} ${p.y}`)
    }
    return '\0'.repeat(w.length)
  })
  return { figures: new Set(numbersIn(rest)), dates }
}

/** True when a date the context states names the day, year or quarter this date span names. */
function isDateSupplied(span: string, dates: Set<string>): boolean {
  const p = dateParts(span)
  if (!p) return false
  if (p.y && !dates.has(String(p.y))) return false
  if (p.m && p.d) return dates.has(`${p.m}-${p.d}`)
  if (p.q) return dates.has(p.y ? `Q${p.q} ${p.y}` : `Q${p.q}`)
  return !!p.y
}

/**
 * `needle` occurs in `hay` as a whole run: nothing in `word` runs on at either
 * end, and neither does a decimal or a thousands group ("$15" is not in
 * "$15.50", "5:15" is not in "15:15").
 */
function includesWhole(hay: string, needle: string, word: RegExp = /[a-z0-9]/): boolean {
  if (!needle) return false
  const digit = /\d/
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const end = at + needle.length
    const before = at > 0 ? hay[at - 1] : ''
    const after = hay[end] ?? ''
    const runsIn = (word.test(needle[0]) && word.test(before)) || (digit.test(needle[0]) && /[.,:]/.test(before) && digit.test(hay[at - 2] ?? ''))
    const runsOn =
      (word.test(needle[needle.length - 1]) && word.test(after)) ||
      (digit.test(needle[needle.length - 1]) && /[.,:]/.test(after) && digit.test(hay[end + 1] ?? ''))
    if (!runsIn && !runsOn) return true
  }
  return false
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

/** A time span in canonical form: "9 am" / "9:00am" → "9am", "24 / 7" → "24/7", "Mon - Fri" → "mon-fri". */
function canonTime(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/:00(?=\s?[ap]m)/g, '')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*day\b/g, '$1')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*/g, '$1')
    .replace(/\s*(?:to|through|thru|–|—)\s*/g, '-')
    .replace(/\s+/g, '')
}

/**
 * True when the supplied context grounds a time. By text, never by digits: the
 * digit test below would ground "24/7" on any context holding "247" anywhere
 * in its run of numbers, which a page of figures easily does.
 */
function isTimeSupplied(span: string, contextCanon: string): boolean {
  // Whole times only. canonTime glues words together, so only a DIGIT running
  // on breaks a match: "5:15" is not in the clock's "15:15", nor "9am" in "19am".
  return includesWhole(contextCanon, canonTime(span), /\d/)
}

/** True when the supplied context grounds this span. */
function isSupplied(span: string, kind: SpecificKind, haystack: string, numbers: NumberIndex): boolean {
  // Whole runs only: "$15" is not supplied by "$150", nor "2015" by "20150".
  const n = norm(span)
  if (n && includesWhole(haystack, n)) return true

  // A numeric span is grounded when every number in it is a number the context
  // states: a brief that says "1,200 seats" grounds "1200 seats" and "$1,200".
  // A date may also rest on a date the context states (NumberIndex).
  const d = digits(span)
  if (d && d.length >= 2) {
    const nums = numbersIn(span)
    if (nums.length > 0 && nums.every((x) => numbers.figures.has(x))) return true
  }
  if (kind === 'date' && isDateSupplied(span, numbers.dates)) return true

  // A spelled-out number is grounded by its numeral, and vice versa.
  const words = n.split(' ')
  for (const w of words) {
    const asDigit = NUMBER_WORDS[w]
    if (asDigit && numbers.figures.has(asDigit)) {
      const rest = words.filter((x) => x !== w).join(' ')
      if (!rest || haystack.includes(rest)) return true
    }
  }
  return false
}

interface Candidate {
  /** Text as it appears in the MASKED string — guards only, never reported. */
  masked: string
  index: number
  /**
   * Length of the region in the masked string. Masking is length-preserving,
   * so [index, index + len) is the same region of the ORIGINAL text, and the
   * reported span is always sliced from there.
   *
   * This exists because of a real bug. Detectors run on the masked string, and
   * the quote detector's class excludes only a closing quote and a newline, so
   * it can match straight across a masked region: '"Escalate to <b>Eng</b>"'
   * yielded a span with NUL bytes in it. Any caller matching or repairing BY
   * SPAN TEXT would then silently skip that repair. Reporting the original
   * slice fixes every detector at once rather than patching one class.
   */
  len: number
  kind: SpecificKind
  reason: string
}

/** Collect every candidate specific, before any grounding test. */
function candidates(masked: string, opts: CheckOptions): Candidate[] {
  const out: Candidate[] = []
  const push = (m: RegExpMatchArray, kind: SpecificKind, reason: string, group = 0): void => {
    const raw = m[group] ?? ''
    const span = raw.trim()
    if (!span) return
    if (m.index === undefined) return
    // Offset of the group inside the whole match, then of the trimmed text
    // inside the group, so index/len describe exactly the reported region.
    const inMatch = m[0].indexOf(raw)
    const lead = raw.indexOf(span)
    const at = m.index + (inMatch < 0 ? 0 : inMatch) + (lead < 0 ? 0 : lead)
    out.push({ masked: span, index: at, len: span.length, kind, reason })
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

  // Day-first dates: "3 March", "21st October 2026".
  scan(
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?\b/gi,
    (m) => push(m, 'date', 'a specific date that is not in the source material')
  )

  // Times and opening hours: "9am", "5:30 pm", "17:00", "24/7", "24 hours a
  // day", "around the clock", "Monday to Friday". A chat answer that says
  // "support is open 24/7" from documents that never say so is the case this
  // exists for (4.3.41): each is a claim about the user's world with
  // unambiguous syntax, so it is high confidence like a date.
  scan(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/gi, (m) => push(m, 'time', 'a time that is not in the source material'))
  scan(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b(?!\s?(?:am|pm|a\.m\.|p\.m\.))/gi, (m) => push(m, 'time', 'a time that is not in the source material'))
  scan(/\b24\s?\/\s?7\b|\b24\s?(?:hours?|hrs?)\s+a\s+day\b|\b(?:a)?round[- ]the[- ]clock\b/gi, (m) =>
    push(m, 'time', 'opening hours that are not in the source material')
  )
  scan(
    /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\s*(?:to|through|thru|-|–|—)\s*(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b/gi,
    (m) => {
      // Abbreviations alone ("sat to sun") are too short to trust; whole day names only.
      if (!/day/i.test(m[0])) return
      push(m, 'time', 'days of the week that are not in the source material')
    }
  )

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
      const run = m[1]
      let at = m.index ?? 0
      let len = run.length
      let words = run.split(/\s+/)

      // At a sentence start the first word's capital says nothing about
      // whether it is a name. Suppressing the whole run on that basis lost
      // "Spring Sale"; keeping it whole gave "Introducing Lumen Flask". So
      // drop the lead word only when it is one that opens a sentence rather
      // than naming anything, and judge what is left.
      const atStart = /(?:^|[.!?:;]\s*|\n\s*(?:[-*#>]\s*)?)$/.test(headingsMasked.slice(0, at))
      if (atStart && words.length > 2 && SENTENCE_LEAD.has(words[0].toLowerCase())) {
        // Measure the lead word and its separator off the match itself rather
        // than rebuilding the text, so index and len keep describing a real
        // region of the original string even when the separator is not a
        // single space.
        const skip = /^\S+\s+/.exec(run)?.[0].length ?? 0
        at += skip
        len -= skip
        words = words.slice(1)
      }

      if (words.length < 2) continue
      if (words.every((w) => NOT_A_NAME.has(w.toLowerCase()))) continue
      if (NOT_A_NAME.has(words[0].toLowerCase())) continue
      if (SENTENCE_LEAD.has(words[0].toLowerCase())) continue
      out.push({
        masked: words.join(' '),
        index: at,
        len,
        kind: 'name',
        reason: 'a name that does not appear in the brief or the source material'
      })
    }
  }
  return out
}

/** Confidence order: the unambiguous kinds first, the loosest detector last. */
const KIND_ORDER: SpecificKind[] = ['money', 'percent', 'date', 'time', 'quote', 'number', 'org', 'name']

const CONFIDENCE_ORDER: Confidence[] = ['high', 'medium', 'low']

/**
 * A span's confidence. `number` splits on form rather than kind: "400 pages"
 * is a figure someone could act on, "two weeks" is usually a turn of phrase,
 * and only the digits tell them apart.
 */
function confidenceOf(kind: SpecificKind, span: string): Confidence {
  if (kind === 'money' || kind === 'percent' || kind === 'date' || kind === 'time' || kind === 'quote') return 'high'
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
  const numbers = indexNumbers(context)
  const contextTimes = canonTime(context)

  const masked = maskNonAssertions(text)
  const seen = new Set<string>()
  const flagged: InventedSpecific[] = []

  for (const c of candidates(masked, opts)) {
    // The reported span ALWAYS comes from the original text, never from the
    // masked copy the detectors ran on. Masking is length-preserving, so
    // [index, index + len) is the same region in both — but the masked copy
    // may hold NUL where a tag or a code span was, and a span carrying NUL
    // cannot be matched or repaired by text.
    const span = text.slice(c.index, c.index + c.len)
    if (!span.trim()) continue
    if (c.kind === 'time' ? isTimeSupplied(span, contextTimes) : isSupplied(span, c.kind, haystack, numbers)) continue
    const key = `${c.kind}:${norm(span)}`
    if (seen.has(key)) continue
    seen.add(key)
    flagged.push({
      span,
      kind: c.kind,
      confidence: confidenceOf(c.kind, span),
      reason: c.reason,
      index: c.index
    })
  }

  // One region, one finding. "24 hours a day" also matches the quantity
  // detector as "24 hours", and "Q3 2025" the year detector as "2025"; the
  // highlight and the repair already take the longest span and skip what it
  // covers (checkThis.splitCheck, groundingCheck), so reporting the inner one
  // too only inflates the count of things to check. Never at the cost of
  // confidence: an inner finding the outer one outranks is kept, because the
  // local repair acts on high confidence alone.
  const rank = (f: InventedSpecific): number => CONFIDENCE_ORDER.indexOf(f.confidence)
  const inside = (a: InventedSpecific, b: InventedSpecific): boolean =>
    a !== b &&
    b.span.length > a.span.length &&
    rank(b) <= rank(a) &&
    a.index >= b.index &&
    a.index + a.span.length <= b.index + b.span.length
  const outermost = flagged.filter((f) => !flagged.some((g) => inside(f, g)))
  flagged.length = 0
  flagged.push(...outermost)

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

/**
 * GROUNDING_RULE_ANSWER for a small local model: the same prohibition, blunt,
 * in the order a 4B is most likely to still follow at the end. See
 * groundingRules.ts for why answers need their own rule.
 */
export const GROUNDING_RULE_ANSWER_SMALL =
  ' GROUNDING (answers): only state facts about the user\'s business that appear in the sources' +
  ' given to you. Never guess a number, time, opening hours, date, price or name. If the sources do' +
  ' not say, write "Your documents don\'t say" and what is missing. Put the source number like [1]' +
  ' after every figure, time, date or price.'
