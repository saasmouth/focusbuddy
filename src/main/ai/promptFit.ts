// Fitting a chat prompt to the window of the model that will read it.
//
// Pure and dependency-free so it unit-tests without the SDK or Electron.
//
// Why this exists (owner, 4.3.40): on a desk, PlexiiAssist on the on-device
// model answered the FIRST message of a fresh conversation, "based on this
// desk, can you provide a research summary report on the future of AI at
// work", with "Conversation hit the model context window. Start a fresh
// session." The conversation was one message long. What did not fit was the
// material sent alongside it: the instructions (~31k characters), the desk
// index, the text of the pages open on the canvas (up to 24k characters) and
// the retrieved workspace passages — about 69k characters against a 16k-token
// window, before a single retrieved passage. Only the retrieved passages were
// ever sized to the device; the desk itself never was, so the engine refused
// the prompt before generating anything.
//
// The fix: every variable part of the prompt (what the user named with @, the
// desk index, the open pages, the retrieved passages) gets a share of what the
// window has left after the fixed parts, each part is cut to its share by its
// own renderer (which already states its own cuts in the prompt), and the
// answer says in plain words what was left out.

import { LOCAL_CHARS_PER_TOKEN, LOCAL_REPLY_RESERVE_TOKENS } from './grounding'

/** Tokens for the chat template and per-turn wrapping (engineCore's fit check over-estimates 32 + 64 per turn). */
const TEMPLATE_TOKENS = 256
const PER_TURN_TOKENS = 64

/**
 * Characters of prompt the on-device model can take in one request with room
 * left for its reply: the window, less the reply reserve and the template.
 */
export function localPromptCharBudget(contextTokens: number, turns = 1, replyReserveTokens = LOCAL_REPLY_RESERVE_TOKENS): number {
  const tokens = contextTokens - replyReserveTokens - TEMPLATE_TOKENS - PER_TURN_TOKENS * Math.max(1, turns)
  return Math.max(0, Math.floor(tokens * LOCAL_CHARS_PER_TOKEN))
}

/**
 * Share `budget` among parts by weighted max-min fairness ("water filling"): a
 * part smaller than its weighted share gets all it needs, and what it does not
 * use is shared among the rest by weight. So one huge part (forty pages of a
 * web page) can never starve a small one (the one note the user named), and
 * nothing is cut when everything fits. Integer characters; never above a
 * part's own size; the total never exceeds the budget.
 */
export function fairShares(parts: ReadonlyArray<{ size: number; weight: number }>, budget: number): number[] {
  const out = parts.map(() => 0)
  let left = Math.max(0, Math.floor(budget))
  let active = parts.map((_, i) => i).filter((i) => parts[i].size > 0 && parts[i].weight > 0)
  while (active.length > 0 && left > 0) {
    const totalWeight = active.reduce((n, i) => n + parts[i].weight, 0)
    const satisfied = active.filter((i) => parts[i].size - out[i] <= (left * parts[i].weight) / totalWeight)
    if (satisfied.length === 0) {
      // Nobody fits in their share: everyone still active takes exactly their share.
      let given = 0
      for (const i of active) {
        const share = Math.floor((left * parts[i].weight) / totalWeight)
        out[i] += share
        given += share
      }
      left -= given
      break
    }
    for (const i of satisfied) {
      left -= parts[i].size - out[i]
      out[i] = parts[i].size
    }
    active = active.filter((i) => !satisfied.includes(i))
  }
  return out
}

/** What was cut to make the prompt fit, counted by the renderers that did the cutting. */
export interface ContextCuts {
  /** The model's window in tokens (for the plain-words notice). */
  contextTokens: number
  desk?: { total: number; shortened: number; omitted: number }
  pages?: { total: number; shortened: number; omitted: number }
  mentions?: { total: number; shortened: number; omitted: number }
  retrieval?: { total: number; shortened: number; omitted: number }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function partPhrase(c: { total: number; shortened: number; omitted: number } | undefined, noun: string, nouns: string, verbOmitted: string): string | null {
  if (!c || (c.shortened === 0 && c.omitted === 0)) return null
  const bits: string[] = []
  if (c.shortened > 0) bits.push(`${c.shortened} of ${plural(c.total, noun, nouns)} ${c.shortened === 1 ? 'was' : 'were'} shortened`)
  if (c.omitted > 0) {
    bits.push(
      c.shortened > 0
        ? `${c.omitted} ${c.omitted === 1 ? 'was' : 'were'} ${verbOmitted}`
        : `${c.omitted} of ${plural(c.total, noun, nouns)} ${c.omitted === 1 ? 'was' : 'were'} ${verbOmitted}`
    )
  }
  return bits.join(' and ')
}

/**
 * The plain-words line an answer carries when material was cut to fit the
 * model's window, or null when nothing was cut. Deterministic, so it is said
 * whether or not the model mentions the cut itself: a small model told "say
 * so if the answer may be incomplete" frequently does not.
 */
export function contextCutsNotice(cuts: ContextCuts): string | null {
  const parts = [
    partPhrase(cuts.desk, 'work widget on this desk', 'work widgets on this desk', 'left out'),
    partPhrase(cuts.pages, 'open page or document', 'open pages and documents', 'not read'),
    partPhrase(cuts.mentions, 'item you referenced', 'items you referenced', 'not read'),
    partPhrase(cuts.retrieval, 'matching workspace item', 'matching workspace items', 'left out')
  ].filter((p): p is string => p !== null)
  if (parts.length === 0) return null
  const k = Math.max(1, Math.round(cuts.contextTokens / 1024))
  return (
    `*Not everything was read: the on-device model reads about ${k}k tokens at once, so ` +
    `${parts.join('; ')}. This answer rests only on what was read. ` +
    'To have a particular work widget, page or document read first, @-mention it in your question.*'
  )
}

/**
 * What to say when the model's context window was exceeded. "Start a fresh
 * session" is only an answer when there IS a session behind the request: on
 * the first message of a conversation, or a one-shot request, there is
 * nothing older to drop, and the advice sends the person round in a circle.
 *
 * `userTurns`: the user messages in the conversation; 0 for a one-shot request
 * that is not a conversation (a welcome, a summary, a build).
 */
export function contextWindowError(userTurns: number): string {
  if (userTurns > 1) {
    return 'This conversation has grown longer than the AI model can read at once. Start a new conversation to carry on.'
  }
  if (userTurns === 1) {
    return (
      'This request, with the desk and workspace material sent alongside it, is more than the AI model can read at once, ' +
      'so nothing was generated. Ask about one part of the desk at a time, or narrow the question.'
    )
  }
  return 'This was more than the AI model can read at once, so nothing was generated. Try again with a smaller request.'
}
