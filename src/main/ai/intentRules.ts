// Deterministic intent rules (Attention S5; ARCHITECTURE §6 + R011).
//
// The capture classifier's FIRST pass: hard triggers that resolve without any
// model call — most captures ("remind me to…", "fyi:", "schedule a…") never
// pay model latency at all, which is what makes the R011 budget (classified
// capture ≤ standup baseline + 1s) structurally safe. The model (Haiku,
// purpose 'intent_classify') is only the fallback for genuinely ambiguous
// text, and ITS failure falls back further to to_remember — a capture is
// never lost and never blocked.
//
// Also here: the deadline-phrase machinery behind DEC-016's Q1 rule — the ONE
// clarifying question, composer-side, firing only on an UNANCHORED deadline
// phrase on an actionable class. A resolvable phrase ("by Thursday",
// "tomorrow") becomes due_at silently; an unresolvable one ("before the
// launch", "asap") triggers the question. 0.70 is the named confidence
// constant, recalibrated against attentionPrecision() over time.
//
// Dependency-free and pure: unit tests drive every rule table directly.

export const Q1_CONFIDENCE_THRESHOLD = 0.7

export type IntentClass =
  | 'to_do'
  | 'to_review'
  | 'to_decide'
  | 'to_respond'
  | 'to_meet'
  | 'to_discuss'
  | 'to_remember'
  | 'to_know'

export interface RuleClassification {
  intentClass: IntentClass
  confidence: number
  /** Which hard trigger fired; absent = no rule matched (model territory). */
  trigger?: string
}

// Classes whose items carry commitments a deadline can bind to. to_decide and
// to_respond joined at the taxonomy alignment: "decide by Friday" and "reply
// by Thursday" are exactly the deadline-bearing shapes Q1 exists for (the
// synthesis's To Decide question set names the deadline explicitly).
const ACTIONABLE: ReadonlySet<IntentClass> = new Set([
  'to_do',
  'to_review',
  'to_meet',
  'to_decide',
  'to_respond'
])

export function isActionableClass(c: IntentClass): boolean {
  return ACTIONABLE.has(c)
}

// Ordered — first match wins. Specific verbs before generic ones.
const HARD_TRIGGERS: ReadonlyArray<{ trigger: string; re: RegExp; intentClass: IntentClass }> = [
  { trigger: 'fyi-prefix', re: /^(fyi|note to self|for the record)\b[:,]?\s*/i, intentClass: 'to_know' },
  {
    trigger: 'ack-request',
    re: /\b(acknowledge|confirm (receipt|you (got|received))|just confirming)\b/i,
    intentClass: 'to_respond'
  },
  // Reply-shaped language: someone is waiting on words back. Ahead of
  // review-verb on purpose — "respond to the review request" is a response.
  {
    trigger: 'respond-verb',
    re: /\b(reply to|respond to|get back to|write back|answer (his|her|their|the)\b)/i,
    intentClass: 'to_respond'
  },
  // Decision language: options on the table, a call to make. Ahead of
  // review-verb so "decide whether to approve" routes as the decision it is
  // (T-5: decide's questions are not review's).
  {
    trigger: 'decide-verb',
    re: /\b(decide|decision (on|about)|choose (between|whether)|pick (between|one of)|make (a|the) call on|weigh (the )?options)\b/i,
    intentClass: 'to_decide'
  },
  {
    trigger: 'review-verb',
    re: /\b(review|approve|approval|sign[- ]?off|feedback on|look over|proofread)\b/i,
    intentClass: 'to_review'
  },
  {
    trigger: 'schedule-verb',
    re: /\b(schedule|reschedule|book (a|the|time)|calendar|set up a (call|meeting|sync)|meet (on|at|next)|30[- ]?min(ute)? (sync|call|meeting))\b/i,
    intentClass: 'to_meet'
  },
  {
    trigger: 'discussion-verb',
    re: /\b(discuss|talk (about|through)|bring up (at|in)|agenda|next 1[:.]1|next one[- ]on[- ]one)\b/i,
    intentClass: 'to_discuss'
  },
  {
    trigger: 'action-verb',
    re: /\b(remind me|need to|have to|must|don'?t forget|make sure (i|we|to)|follow up|todo|to-do|task:)\b/i,
    intentClass: 'to_do'
  },
  // Idea-capture language files lightly (the decay tier), even when it wears
  // a verb like "flesh out": an idea is a thought to keep, not yet a to-do.
  // Ordered AFTER the explicit action verbs so "need to flesh out the pricing
  // idea by Friday" still routes as the to-do it states.
  {
    trigger: 'idea-signal',
    re: /\b(idea|brainstorm|concept|what if|shower thought|random thought)\b/i,
    intentClass: 'to_remember'
  },
  // A trailing question needs WORDS BACK, not a task: it files to Respond
  // (the alignment's fix for the old question→action conflation, which T-5
  // flagged — an answer's questions are not a to-do's).
  { trigger: 'question-mark', re: /\?\s*$/, intentClass: 'to_respond' }
]

/** The deterministic first pass. Returns undefined when no rule fires. */
export function classifyByRules(text: string): RuleClassification | undefined {
  const t = text.trim()
  if (!t) return { intentClass: 'to_remember', confidence: 0.9, trigger: 'empty' }
  for (const rule of HARD_TRIGGERS) {
    if (rule.re.test(t)) return { intentClass: rule.intentClass, confidence: 0.95, trigger: rule.trigger }
  }
  // Short fragments with no verbs and no trigger read as idle capture — the
  // decay tier's population. Longer prose without a trigger goes to the model.
  const words = t.split(/\s+/).length
  if (words <= 4 && !/\b(do|make|send|call|write|fix|build|get|buy)\b/i.test(t)) {
    return { intentClass: 'to_remember', confidence: 0.75, trigger: 'short-fragment' }
  }
  return undefined
}

// ── Deadline phrases (Q1 machinery) ─────────────────────────────────────────

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export interface DeadlineScan {
  /** The phrase found, verbatim (for the Q1 question's copy). */
  phrase: string
  /** ISO-8601 when resolvable; null = UNANCHORED → the Q1 trigger. */
  dueAt: string | null
}

function endOfDay(d: Date): string {
  const out = new Date(d)
  out.setHours(17, 0, 0, 0)
  return out.toISOString()
}

/** Find a deadline-like phrase and try to anchor it. Resolvable: today,
 *  tonight, tomorrow, eod/eow, end of day/week, weekday names ("by Thursday" →
 *  the NEXT such weekday), next week. Unresolvable deadline language ("asap",
 *  "by the launch", "before the meeting") returns dueAt:null. */
export function scanDeadline(text: string, now: Date): DeadlineScan | null {
  const t = text.toLowerCase()
  const anchored =
    /\b(?:by|before|due|until)\s+(today|tonight|tomorrow|eod|eow|end of (?:the )?day|end of (?:the )?week|next week|(?:next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/.exec(
      t
    ) ?? /\b(today|tonight|tomorrow)\b/.exec(t)
  if (anchored) {
    const phrase = anchored[0]
    const word = anchored[1] ?? anchored[0]
    const base = new Date(now)
    if (word === 'today' || word === 'tonight' || word === 'eod' || word.startsWith('end of')) {
      if (word === 'eow' || word.includes('week')) {
        const d = new Date(base)
        d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7 * 0)) // this Friday (or today if Friday)
        return { phrase, dueAt: endOfDay(d) }
      }
      return { phrase, dueAt: endOfDay(base) }
    }
    if (word === 'tomorrow') {
      const d = new Date(base)
      d.setDate(d.getDate() + 1)
      return { phrase, dueAt: endOfDay(d) }
    }
    if (word === 'next week') {
      const d = new Date(base)
      d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7)) // next Monday
      return { phrase, dueAt: endOfDay(d) }
    }
    const dayName = word.replace(/^next\s+/, '')
    const idx = WEEKDAYS.indexOf(dayName)
    if (idx >= 0) {
      const d = new Date(base)
      const delta = (idx - d.getDay() + 7) % 7 || 7 // always forward
      d.setDate(d.getDate() + delta + (word.startsWith('next ') && delta <= 0 ? 7 : 0))
      return { phrase, dueAt: endOfDay(d) }
    }
  }
  // Deadline-LIKE but unanchorable — the Q1 trigger.
  const vague = /\b(asap|as soon as possible|soon|by (?:the )?(?!way\b)[a-z]+(?:\s[a-z]+)?\b|before (?:the )?[a-z]+)\b/.exec(
    t
  )
  if (vague && /\b(asap|as soon as possible|by|before|due)\b/.test(vague[0])) {
    return { phrase: vague[0], dueAt: null }
  }
  return null
}

/** DEC-016 Q1: should the composer ask its one question? Only for an
 *  unanchored deadline phrase on an actionable class (the named-recipient
 *  trigger cannot fire while routing is self-only). Hard at-most-one. */
export function needsDeadlineClarification(
  intentClass: IntentClass,
  scan: DeadlineScan | null
): boolean {
  return isActionableClass(intentClass) && scan !== null && scan.dueAt === null
}

// ── Light tidy (DEC-043) ───────────────────────────────────────────────────
// Deterministic capitalization for titles below the model-tidy bar: "call bob
// thursday" should still come out "Call Bob Thursday" without paying a model
// call. Only ever ADDS capitals, never lowercases — idempotent, and safe on
// deliberate casing ("iPhone" is untouched). Four rules:
//   1. the first letter
//   2. standalone "i"
//   3. weekday + month names ("may" excluded — "may need to" is a verb)
//   4. a name-shaped word right after a person-verb ("call bob" → "call Bob"),
//      unless it is a stopword ("call the notary" stays)

const CAL_WORD_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/g
const PERSON_VERB_RE = /\b(call|email|text|ping|ask|tell|meet|message|remind)\s+([a-z][a-z']+)\b/g
const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their',
  'them', 'him', 'me', 'back', 'in', 'on', 'at', 'to', 'with', 'about',
  'up', 'everyone', 'someone', 'anybody', 'people', 'team', 'again', 'now',
  'today', 'tomorrow', 'tonight'
])

export function lightTidyTitle(raw: string): string {
  let t = raw
  t = t.replace(/\bi\b/g, 'I')
  t = t.replace(CAL_WORD_RE, (w) => w[0].toUpperCase() + w.slice(1))
  t = t.replace(PERSON_VERB_RE, (m, verb: string, name: string) =>
    NAME_STOPWORDS.has(name) ? m : `${verb} ${name[0].toUpperCase()}${name.slice(1)}`
  )
  if (t && /[a-z]/.test(t[0])) t = t[0].toUpperCase() + t.slice(1)
  return t
}

/** A short title from a capture: first sentence-ish, trimmed, capped. */
export function titleFromCapture(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s+|\n/)[0] ?? ''
  // Capture scaffolding exists to tell the AI what you meant; it shouldn't
  // survive into the item ("remind me to call Doug" files as "Call Doug").
  const t = lightTidyTitle(
    first
      .replace(/^(fyi|note to self|for the record|todo|to-do)\b[:,]?\s*/i, '')
      .replace(/^(remind me to|i need to|i have to|don'?t forget to)\s+/i, '')
      .trim()
  )
  return (t.length > 120 ? `${t.slice(0, 117)}…` : t) || 'Untitled task'
}

// ── Multi-intent captures (DEC-025) ─────────────────────────────────────────
// "call Bob Thursday and review the deck" is TWO loops wearing one sentence.
// The splitter is deterministic and deliberately conservative: a strong
// separator (newline, semicolon) always cuts; a weak joiner ("and", "then")
// cuts ONLY where the right side independently trips a hard trigger of its
// own — so "call Bob and Alice" (one action, compound object) never splits,
// and a false secondary is structurally rarer than a missed one. Secondaries
// never pay a model call and never ask Q1 (DEC-016: at most one question,
// and it belongs to the primary); an unanchorable date on a secondary simply
// files dateless.

export interface SecondaryIntent {
  /** The segment, verbatim — becomes the secondary's capture text. */
  text: string
  intentClass: IntentClass
  trigger: string
  title: string
  dueAt: string | null
}

const STRONG_SEPARATOR = /\n+|;\s*/
const WEAK_JOINER = /\s+(?:and\s+then|and\s+also|then|and|plus|also)\s+/gi

/** Triggers real enough to justify a cut — fallback buckets don't qualify. */
function qualifies(c: RuleClassification | undefined): c is RuleClassification {
  return !!c?.trigger && c.trigger !== 'empty' && c.trigger !== 'short-fragment'
}

/** Split a capture into intent-bearing segments (first = the primary's home). */
export function splitCompound(text: string): string[] {
  const out: string[] = []
  for (const strong of text.split(STRONG_SEPARATOR)) {
    let rest = strong.trim()
    if (!rest) continue
    // Cut at each weak joiner whose right side carries its own trigger.
    let guard = 0
    while (guard++ < 8) {
      WEAK_JOINER.lastIndex = 0
      let cutAt: { idx: number; len: number } | null = null
      let m: RegExpExecArray | null
      while ((m = WEAK_JOINER.exec(rest)) !== null) {
        const right = rest.slice(m.index + m[0].length).trim()
        if (right.split(/\s+/).length >= 2 && qualifies(classifyByRules(right))) {
          cutAt = { idx: m.index, len: m[0].length }
          break
        }
      }
      if (!cutAt) break
      out.push(rest.slice(0, cutAt.idx).trim())
      rest = rest.slice(cutAt.idx + cutAt.len).trim()
    }
    if (rest) out.push(rest)
  }
  return out.filter(Boolean)
}

export const MAX_SECONDARY_INTENTS = 3

// ── The cleanup gate (DEC-026, Δ6) ──────────────────────────────────────────
// Deterministic messiness test deciding whether a capture even QUALIFIES for
// the opt-in tidy proposal. Clean short captures never pay a model call and
// never see the offer. Pure and unit-tested; the model half lives in
// ai/cleanupRewrite.ts.

const FILLER_RE =
  /\b(um+|uh+|so basically|basically|you know|i think maybe|kind of|sort of|or something|stuff like that|whatever|anyway|like i said)\b/gi

/** Messy enough to offer a tidy: long, rambling, or filler-dense. */
export function needsCleanup(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const words = t.split(/\s+/).length
  if (words >= 30) return true
  const fillers = t.match(FILLER_RE)?.length ?? 0
  if (fillers >= 2) return true
  // A long unpunctuated run-on: 18+ words with no sentence break at all.
  if (words >= 18 && !/[.!?;\n]/.test(t.slice(0, -1))) return true
  return false
}

/** DEC-040 — when the preview should ATTEMPT a tidy at all. The old gate
 *  (needsCleanup alone) only fired on genuinely messy text, so medium
 *  captures showed raw with no tidy and the preview felt inconsistent
 *  ("sometimes I get the tidied up version, other times I don't"). The
 *  preview now attempts a tidy for anything with real content: 8+ words,
 *  more than one sentence, notes attached, or the classic messiness signs.
 *  Tiny fragments still skip — "call Bob Thursday" IS its own tidy, and a
 *  model call there returns the input at latency cost. */
export function qualifiesForTidy(text: string, notes?: string): boolean {
  const t = text.trim()
  if (!t) return false
  if ((notes ?? '').trim()) return true
  if (needsCleanup(t)) return true
  const words = t.split(/\s+/).length
  if (words >= 5) return true
  // Sentence punctuation anywhere before the final character = more than
  // one segment (same trick as needsCleanup's run-on test).
  return /[.!?;\n]/.test(t.slice(0, -1))
}

/** The secondaries a compound capture carries beyond its primary. Rules-only:
 *  a segment with no hard trigger of its own is NOT offered (it stays part of
 *  the primary's context rather than becoming a speculative item). */
export function secondaryCaptures(text: string, now: Date): SecondaryIntent[] {
  const segments = splitCompound(text)
  if (segments.length <= 1) return []
  const out: SecondaryIntent[] = []
  for (const seg of segments.slice(1)) {
    if (out.length >= MAX_SECONDARY_INTENTS) break
    const cls = classifyByRules(seg)
    if (!qualifies(cls)) continue
    out.push({
      text: seg,
      intentClass: cls.intentClass,
      trigger: cls.trigger!,
      title: titleFromCapture(seg),
      dueAt: scanDeadline(seg, now)?.dueAt ?? null
    })
  }
  return out
}
