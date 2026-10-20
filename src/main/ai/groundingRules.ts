// The grounding rules the content generators append to their system prompts.
//
// Separate from anthropic.ts so the local provider can import the SAME rule
// text without pulling in the Anthropic SDK. Prompt text that exists twice
// drifts, and a local path quietly running an older rule than the cloud path
// is exactly the bug this file prevents.
//
// GROUNDING_RULE_SMALL, the blunt variant for a small local model, lives in
// inventedSpecifics.ts beside the checker that compensates for the same
// weakness.

/**
 * Why both rules exist: every other prompt in this file already forbids
 * invention, but the content GENERATORS did not, and one of them ("a genuinely
 * useful first draft ... not an outline of placeholders") actively pushed the
 * model to fill specifics in. A stronger model follows that more effectively,
 * so the better the model the more it fabricated: the local-AI eval scored the
 * cloud reference 4/9 on office tasks against the 4B's 6/9, marking Claude down
 * for "states unsupplied facts about the team's wiki" and an invented
 * power-drill statistic. The fix is not "invent nothing" — that yields the
 * empty skeleton the original clause rightly guarded against — but the
 * distinction it was missing: write the prose freely, never assert an
 * unsupplied specific as fact.
 *
 * The placeholder-restraint clause has a history worth keeping, because it was
 * wrong twice before it was right and it would otherwise be re-litigated.
 *
 * Added on reasoning alone: telling a model to write "[launch date]" rather
 * than guess invites a draft peppered with brackets. No measurement, which is
 * the same mistake that caused this whole piece of work.
 *
 * Reverted, because a single-sample run put cloud at 26/34 without it and
 * 21/34 with it, and a change with no measured benefit and an apparent cost
 * does not get the benefit of the doubt.
 *
 * Restored, because 3 samples per task reversed that cleanly: 24/23/23
 * (mean 23.3, sd 0.6) without the clause against 27/27/25 (mean 26.3, sd 1.2)
 * with it. Office 11.7 -> 13.7, build 4.7 -> 5.7, writing level at 7.0.
 * Drafts came out 2-9% shorter with no thinness the judge penalised. The
 * single sample was noise in both directions.
 *
 * The lesson that survives all three steps is about the process, not the
 * wording: one run of one sample is not evidence either way, in either
 * direction, and neither is a confident argument about what a model will do.
 */
export const GROUNDING_RULE =
  ' Ground every specific in what you were given. Write the prose, the structure and ordinary' +
  ' domain knowledge freely, because that is the draft and an empty skeleton is no use. But never' +
  ' present an invented specific as fact: no statistic, study finding, quotation, price, date or' +
  ' market figure you cannot source, and no detail about the reader\'s own world (their people,' +
  ' customers, revenue, tools, deadlines or past decisions) that the request did not supply.' +
  ' Where such a specific is genuinely needed and was not supplied, write a short bracketed' +
  ' placeholder like [launch date] or [owner name] instead of a plausible guess. A placeholder' +
  ' costs the user seconds to fill in; an invented figure they do not notice can reach a customer.' +
  ' Use placeholders sparingly: most good writing needs none, and a draft peppered with brackets' +
  ' is as useless as one full of invention. Reach for one only where a specific is unavoidable and' +
  ' absent, never as a way to avoid writing. Prefer a shorter, fully grounded draft over a fuller' +
  ' one that is partly fiction.'

export const SHEET_DATA_RULE =
  ' This data is a starting point the user will replace, so make the shape and formats realistic' +
  ' (sensible column types, plausible magnitudes, consistent units and date formats) rather than' +
  ' "example 1". Realistic shape is not licence to assert real-world facts: never give figures for' +
  ' a named company, person, product or period as if they had been measured. When the task concerns' +
  ' records the user already has and did not supply, leave clearly fillable placeholders rather' +
  ' than inventing their numbers.'
