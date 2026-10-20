// Grounding review of model output, around d2's invented-specifics checker
// (src/main/ai/inventedSpecifics.ts — used, never copied).
//
// Which calls: content-writing ones, recognised by the grounding rule itself in
// the system prompt (GROUNDING_RULE from groundingRules.ts, or its small-model
// variant). That marker sits on exactly the generators that write documents,
// sheets, decks, designs, drafts and Build with AI content, so no list of
// purposes has to be kept in step with anthropic.ts.
//
// What happens:
//   local — the prompt carries GROUNDING_RULE_SMALL instead of the full rule
//           (a blunt rule a 4B model actually follows), and high-confidence
//           findings (money, percentages, dates, quotations the request never
//           supplied) are repaired into [placeholders]. Medium and low ones are
//           reported, never rewritten.
//   cloud — nothing is rewritten; findings at the checker's default confidence
//           are reported for the person to check.
// JSON outputs are reviewed string by string, so a repair can never break the
// structure a call site parses.

import { GROUNDING_RULE } from '../groundingRules'
import { checkInventedSpecifics, GROUNDING_RULE_SMALL, type InventedSpecific, type Confidence } from '../inventedSpecifics'

export interface ReviewFinding {
  span: string
  kind: InventedSpecific['kind']
  confidence: Confidence
  reason: string
}

export interface ReviewResult {
  text: string
  /** Replaced by a [placeholder] (local, high confidence only). */
  repaired: ReviewFinding[]
  /** Reported for the person to check, not changed. */
  flagged: ReviewFinding[]
}

/** Whether a system prompt belongs to a content-writing generator. */
export function isContentWriting(system: string): boolean {
  return system.includes(GROUNDING_RULE.trim()) || system.includes(GROUNDING_RULE_SMALL.trim())
}

/** The local path's prompt: the small-model rule in place of the full one. */
export function withSmallRule(system: string): string {
  return system.includes(GROUNDING_RULE) ? system.split(GROUNDING_RULE).join(GROUNDING_RULE_SMALL) : system
}

/** Everything the request gave the model: system context (desk, documents, retrieved chunks) and the user's messages. */
export function suppliedText(system: string, messages: Array<{ role: string; content: string }>): string {
  return [system, ...messages.filter((m) => m.role === 'user').map((m) => m.content)].join('\n')
}

const PLACEHOLDER: Record<InventedSpecific['kind'], string> = {
  money: 'amount',
  percent: 'percentage',
  date: 'date',
  quote: 'quote',
  number: 'number',
  name: 'name',
  org: 'organisation'
}

const toFinding = (f: InventedSpecific): ReviewFinding => ({ span: f.span, kind: f.kind, confidence: f.confidence, reason: f.reason })

/** Review one piece of prose. Exported for tests. */
export function reviewProse(text: string, supplied: string, repair: boolean): ReviewResult {
  // The checker masks non-assertions (code, HTML tags, [placeholders]) with NUL,
  // offsets preserved (ed662ea0). A finding that spans a masked region comes
  // back with NULs in its span text; read the span from the original at the
  // same offsets, so the repair still applies and the person sees real text.
  const all = checkInventedSpecifics(text, supplied).flagged.map((f) =>
    f.span.includes('\u0000') ? { ...f, span: text.slice(f.index, f.index + f.span.length) } : f
  )
  const toRepair = repair ? all.filter((f) => f.confidence === 'high') : []
  let out = text
  // Replace from the end so earlier indices stay valid; skip overlaps.
  let lastStart = Infinity
  for (const f of [...toRepair].sort((a, b) => b.index - a.index)) {
    const end = f.index + f.span.length
    if (end > lastStart || out.slice(f.index, end) !== f.span) continue
    out = out.slice(0, f.index) + `[${PLACEHOLDER[f.kind]}]` + out.slice(end)
    lastStart = f.index
  }
  const repairedSet = new Set(toRepair)
  return {
    text: out,
    repaired: toRepair.map(toFinding),
    flagged: all.filter((f) => !repairedSet.has(f)).map(toFinding)
  }
}

function extractJson(text: string): { start: number; end: number; value: unknown } | null {
  const first = Math.min(...['{', '['].map((c) => text.indexOf(c)).filter((i) => i >= 0))
  if (!Number.isFinite(first)) return null
  const close = text[first] === '{' ? '}' : ']'
  const end = text.lastIndexOf(close)
  if (end <= first) return null
  try {
    return { start: first, end: end + 1, value: JSON.parse(text.slice(first, end + 1)) }
  } catch {
    return null
  }
}

/**
 * Review a model reply: JSON string values one by one when the reply is JSON,
 * otherwise the prose as a whole. `repair` is the local path's switch.
 */
export function reviewOutput(text: string, supplied: string, repair: boolean): ReviewResult {
  const json = extractJson(text)
  if (!json) return reviewProse(text, supplied, repair)
  const repaired: ReviewFinding[] = []
  const flagged: ReviewFinding[] = []
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') {
      // Ids, kinds, colours and URLs are structure, not claims.
      if (key && /^(id|kind|type|color|colour|url|href|src|tableId|rowId|widgetId|docType|layout|shape)$/i.test(key)) return v
      if (v.length < 3) return v
      const r = reviewProse(v, supplied, repair)
      repaired.push(...r.repaired)
      flagged.push(...r.flagged)
      return r.text
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key))
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, k)
      return o
    }
    return v
  }
  const next = walk(json.value, null)
  if (repaired.length === 0) return { text, repaired, flagged }
  return { text: text.slice(0, json.start) + JSON.stringify(next) + text.slice(json.end), repaired, flagged }
}
