// Grounding for ANSWERS: PlexiiAssist chat (Ask PlexiiBrain) and the
// workspace-ask paths (PlexiSearch Ask, Ask your workspace in the editors).
//
// The content generators already carry GROUNDING_RULE and have their output
// reviewed (local/groundingCheck.ts). Answers had neither, and on 4.3.41 the
// on-device model answered "Support is open 24/7, as stated in the policy [1]"
// from a refund policy that says nothing about support. So every answer path:
//   1. carries the answer rule in its prompt (GROUNDING_RULE_ANSWER, or the
//      blunt small-model variant when the call runs on the device);
//   2. is checked with checkInventedSpecifics against exactly what it was
//      given (sources, desk and document context, the user's messages — never
//      the app's own instructions, whose examples would ground anything);
//   3. on the device, has high-confidence invented specifics (money,
//      percentages, dates, times and opening hours, quotations) replaced by
//      "[not in your documents]"; from cloud AI, has them highlighted only.
// The result says what was found so the answer can mark it ("check this").
//
// Pure apart from its imports; unit-tested in tests/unit/answerGrounding.test.ts.

import { GROUNDING_RULE_ANSWER } from './groundingRules'
import { GROUNDING_RULE_ANSWER_SMALL } from './inventedSpecifics'
import { reviewProse } from './local/groundingCheck'
import type { AnswerGrounding } from '@shared/types'

export type { AnswerGrounding }

/** The answer rule for the engine that will answer. */
export function answerRule(local: boolean): string {
  return local ? GROUNDING_RULE_ANSWER_SMALL : GROUNDING_RULE_ANSWER
}

/** Whether a prompt carries the answer rule (either variant). */
export function hasAnswerRule(system: string): boolean {
  return system.includes(GROUNDING_RULE_ANSWER.trim()) || system.includes(GROUNDING_RULE_ANSWER_SMALL.trim())
}

/** What a repaired span reads as in an answer: an honest gap, not a fill-in-the-blank. */
export const ANSWER_GAP = '[not in your documents]'

/**
 * Check one answer against what it was given. `local`: the on-device model
 * answered, so high-confidence findings are repaired; otherwise nothing is
 * changed and every finding is highlighted. `grounding` is undefined when the
 * answer is clean.
 */
export function groundAnswer(answer: string, supplied: string, local: boolean): { text: string; grounding?: AnswerGrounding } {
  if (!answer.trim()) return { text: answer }
  let r
  try {
    r = reviewProse(answer, supplied, local, () => ANSWER_GAP)
  } catch {
    return { text: answer } // a check that cannot run never touches the answer
  }
  if (r.repaired.length === 0 && r.flagged.length === 0) return { text: answer }
  const strip = (f: { span: string; kind: string; confidence: 'high' | 'medium' | 'low'; reason: string }): AnswerGrounding['flagged'][number] => ({
    span: f.span,
    kind: f.kind,
    confidence: f.confidence,
    reason: f.reason
  })
  return {
    text: r.text,
    grounding: { path: local ? 'local' : 'cloud', repaired: r.repaired.map(strip), flagged: r.flagged.map(strip) }
  }
}
