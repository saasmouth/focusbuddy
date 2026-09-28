// Did the reply say it DID something, when no card was produced?
//
// actionOutcomeNotice covers the cases where the assistant tried and failed: an
// action the parser could not read, an envelope cut off at the token cap. Its
// last branch returns null for "the model proposed nothing and nothing went
// wrong: an ordinary answer" — and that branch is where the worst version of
// this hides. The model writes "I've added a table to your desk", emits no
// actions at all, and nothing contradicts it. There is no malformed entry to
// count and no truncation to report, so every existing check is satisfied while
// the user reads a completed sentence about work that does not exist and waits
// for a card that is never coming.
//
// This is deliberately HIGH PRECISION and low recall. A false positive attaches
// a frightening correction to a perfectly good answer, which is worse than the
// silence it replaces, so it fires only on a first-person claim in completed
// aspect about a workspace object. "I can build you a tracker", "would you like
// me to add one", "you could put that on a desk" and "I'll add it once you
// confirm" all describe work that has NOT been claimed as done, and none of them
// may trigger it.
//
// Dependency-free so it unit-tests in isolation, same policy as
// discoveryMode.ts, retrievalIntent.ts and creationGate.ts.

/** Verbs that mean a thing was brought into existence or changed. */
const DID = 'created|added|made|set up|built|generated|put|placed|updated|inserted|dropped|filed'

/**
 * A first-person claim in completed aspect: "I've created", "I have added",
 * "I created", "I set up". Present perfect and simple past only — a promise
 * ("I'll add") is a different failure and too easily a legitimate offer.
 */
const FIRST_PERSON_DONE = new RegExp(String.raw`\bI(?:'ve|’ve| have)?\s+(?:just\s+)?(?:${DID})\b`, 'i')

/**
 * The same claim with the subject dropped, which is how assistants usually
 * phrase it: "Created a table for you", "Added three rows.", "Set up a desk".
 * Anchored to the start of a line so it cannot match mid-sentence prose like
 * "once that is created a table appears".
 */
const HEADLESS_DONE = new RegExp(String.raw`(?:^|\n)\s*(?:${DID})\b`, 'i')

/** A thing in the workspace, so generic completions do not qualify. */
const WORKSPACE_OBJECT =
  /\b(?:desk|widget|table|row|column|cell|page|document|doc|sheet|spreadsheet|slide|deck|note|sticky|card|todo|to-do|checklist|task|subtask|agent|diagram|mind ?map|section|knowledge entry|field|timer|chart)s?\b/i

/**
 * Phrasings that describe work NOT yet done. Checked first and they win: the
 * model offering to build something is the ordinary, correct behaviour, and the
 * offer itself is the affordance.
 */
const NOT_YET =
  /\b(?:I can|I could|I would|shall I|should I|do you want|would you like|want me to|if you(?:'d| would) like|let me know|I'?ll|I will|you can|you could|you(?:'d| would) need to|to do (?:this|that),? (?:I|you))\b/i

/**
 * True when the reply reads as a report of completed workspace work.
 *
 * Only meaningful alongside "and no proposal was offered" — on its own a true
 * result is simply an accurate description of a card that IS there.
 */
export function claimsCompletedWork(reply: string): boolean {
  const text = reply.trim()
  if (!text) return false
  if (!WORKSPACE_OBJECT.test(text)) return false

  // Judge per sentence, so an offer elsewhere in a long reply cannot excuse a
  // completed claim, and a completed claim about something else cannot be
  // rescued by a workspace noun three paragraphs away.
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim()
    if (!s) continue
    if (!WORKSPACE_OBJECT.test(s)) continue
    if (NOT_YET.test(s)) continue
    if (FIRST_PERSON_DONE.test(s) || HEADLESS_DONE.test(s)) return true
  }
  return false
}

/**
 * The correction to append when the reply claimed completed work and nothing was
 * offered. It CONTRADICTS rather than annotates, in the first line, for the same
 * reason actionOutcomeNotice does: the prose above has already told the user the
 * job is done, and a correction they have to infer is not a correction.
 */
export function unbackedClaimNotice(): string {
  return (
    '**Nothing above was actually created.** ' +
    'I described that as done, but no change was prepared, so there is no card here to apply. ' +
    'Ask me again — naming the desk or widget you mean — and I will produce it as something you can accept.'
  )
}
