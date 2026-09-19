// Noticing that a run is going nowhere.
//
// Reported as "doing the same thing over and over and costing money to not
// achieve anything." The loop had no idea. It counted FAILED actions —
// priorFailed — and gave up after four. But the actions that trap a run do not
// fail: clicking a button that does nothing, scrolling a page that will not
// scroll, opening the URL you are already on all return ok:true, which RESET
// the counter. So the one situation that most needs a circuit breaker was the
// one situation guaranteed not to trip it, and the run paid for a model round
// every time until the twenty-four-round budget ran out.
//
// Failing is not the problem. Going nowhere is. This watches the page instead
// of the return value: if the world does not change and the plan does not
// change, the run is stuck no matter how many actions "succeed".

/** What the page looked like at the end of a round. */
export interface RoundState {
  url: string
  /** Where the read window sat — so scrolling counts as progress. */
  textStart: number
  /** Enough page text to notice a re-render that keeps the URL. */
  textSample: string
  elementCount: number
}

/**
 * A round reduced to one comparable string.
 *
 * The text SAMPLE matters as much as the URL: single-page apps navigate
 * without changing the URL, and a run that only watched the address bar would
 * call real progress a stall.
 */
export function roundSignature(s: RoundState): string {
  const text = s.textSample.replace(/\s+/g, ' ').trim().slice(0, 400)
  return [s.url, s.textStart, s.elementCount, text].join('|')
}

export type StallVerdict = 'none' | 'warn' | 'stop'

// Two identical rounds is a coincidence worth mentioning; three is a loop. A
// tighter rule than this fires on legitimate work — a page that takes a beat to
// load looks identical for a round through no fault of the plan.
const WARN_AT = 2
const STOP_AT = 3

/**
 * Is this run getting anywhere?
 *
 * Both halves have to be stuck. A page that will not change while the model
 * tries genuinely different things is exploration, and it deserves the budget
 * it was given; the same action into an unchanging page is a loop.
 *
 * `signatures` and `actions` are most-recent-last and index-aligned.
 */
export function detectStall(signatures: readonly string[], actions: readonly string[]): StallVerdict {
  const n = Math.min(signatures.length, actions.length)
  if (n < WARN_AT) return 'none'
  const sameFor = (k: number): boolean => {
    if (n < k) return false
    const sig = signatures[n - 1]
    const act = actions[n - 1]
    for (let i = n - k; i < n; i++) {
      if (signatures[i] !== sig || actions[i] !== act) return false
    }
    return true
  }
  if (sameFor(STOP_AT)) return 'stop'
  if (sameFor(WARN_AT)) return 'warn'
  return 'none'
}

/**
 * What to tell the model when it is repeating itself.
 *
 * Naming the specific thing it keeps doing matters. "Try something different"
 * is advice a model will agree with and then ignore; "you have clicked element
 * 14 twice and the page has not changed" is an observation it has to act on.
 */
export function stallNotice(action: string): string {
  return (
    `NOTE: you have now done exactly this twice — ${action} — and the page did not change either time. ` +
    'Repeating it a third time will end the run. ' +
    'Something is blocking that approach: the control may be inert, hidden behind an overlay, or not the one you want. ' +
    'Do something DIFFERENT — scroll to see more of the page, open a more specific URL, or record what you already have and finish. ' +
    'If the task cannot be completed on this page, say so with status "blocked" rather than trying again.'
  )
}

/** The summary a stalled run ends on — honest about what it cost and why. */
export function stallSummary(action: string, rounds: number): string {
  return (
    `Stopped after ${rounds} ${rounds === 1 ? 'round' : 'rounds'}: the run kept doing the same thing (${action}) ` +
    'and the page never changed. Stopping beats spending the rest of the budget on a loop.'
  )
}

/**
 * A mid-run instruction, framed for the model.
 *
 * The framing is the whole feature. A bare line of user text dropped into a
 * transcript reads as a NEW task, and the model abandons what it was doing and
 * starts over — losing the pages it had already mined. It is an amendment
 * unless the user plainly says otherwise, so it says so, and leaves judging
 * "otherwise" to the one party that can read the sentence.
 */
export function steerNotice(steers: readonly string[], task: string): string {
  if (steers.length === 0) return ''
  const lines = steers.map((s) => `  "${s.replace(/\s+/g, ' ').trim()}"`)
  return [
    steers.length === 1
      ? 'THE USER JUST SAID THIS, WHILE YOU WORK:'
      : 'THE USER SAID THESE, WHILE YOU WORK (oldest first):',
    ...lines,
    '',
    'Treat it as an UPDATE to the task you are already on, not a replacement for it.',
    `The task remains: ${task}`,
    'Keep every finding you have recorded and carry on from where you are — unless they have plainly asked you to change course or go somewhere else, in which case follow them.',
    'It takes priority over your current plan where the two disagree.'
  ].join('\n')
}
