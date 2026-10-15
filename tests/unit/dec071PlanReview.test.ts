// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const cal = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/views/CalendarView.tsx'),
  'utf8'
)

// DEC-071 — a proposed plan has to be inspectable BEFORE it is accepted.
// The ghosts on the grid are not real blocks (nothing is booked until accept),
// so there was nothing to click, and the summary line truncated — it could say
// THAT three blocks were proposed but never which, when, or why.

describe('dec_071 — the prompt grows with what you type', () => {
  it('dec_071_is_a_textarea_not_a_single_line_input', () => {
    // A real intent prompt is a sentence, not a keyword. In a single-line
    // input the start of it scrolls out of sight while it is being written.
    expect(cal).toContain('<textarea')
    expect(cal).toContain('ref={intentRef}')
    expect(cal).not.toMatch(/<input\s+value=\{intent\}/)
  })

  it('dec_071_grows_and_shrinks_and_then_scrolls', () => {
    // Measure-then-set: height is collapsed to auto first, so deleting text
    // shrinks the field instead of leaving it stuck at its high-water mark.
    expect(cal).toContain("el.style.height = 'auto'")
    expect(cal).toContain('Math.min(el.scrollHeight, 152)')
    // Capped, because an unbounded field would push the calendar off screen.
    expect(cal).toContain('max-h-[152px]')
  })

  it('dec_071_enter_plans_and_shift_enter_is_a_newline', () => {
    // Multi-line input is worthless if Enter cannot make a new line.
    expect(cal).toContain("e.key === 'Enter' && !e.shiftKey")
  })
})

describe('dec_071 — the plan opens for review', () => {
  it('dec_071_a_landed_proposal_opens_the_review', () => {
    expect(cal).toContain('setReviewOpen(true)')
    expect(cal).toContain('aria-label="Review the proposed plan"')
  })

  it('dec_071_the_review_shows_which_when_and_why', () => {
    // All three already existed on PlannedProposal and none were rendered.
    expect(cal).toContain('{pr.title}')
    expect(cal).toContain('{pr.reason}')
    expect(cal).toContain('pr.startMs + pr.durationMin * 60_000')
    // ...and the prompt it is answering, in full.
    // DEC-094 restyled the echo: the grey "You asked for" block became one
    // quiet quoted line. The requirement — the prompt is SHOWN, in full,
    // beside the plan it produced — is unchanged.
    expect(cal).toContain('{planIntent}')
    expect(cal).toContain('“{planIntent}”')
  })

  it('dec_071_the_summary_bar_stops_pretending_to_explain', () => {
    // It used to append a truncated note — an explanation that could not
    // finish a sentence. The bar carries the count and a way back in.
    expect(cal).not.toContain('${planNote ? ` — ${planNote}` : \'\'}')
    expect(cal).toContain('setReviewOpen(true)')
  })

  it('dec_071_review_is_centre_peek_and_bounded_like_the_item_editor', () => {
    // DEC-065's lesson: content that cannot be REACHED is worse than content
    // that scrolls.
    expect(cal).toContain('flex items-center justify-center p-6')
    expect(cal).toContain('max-h-full overflow-y-auto')
  })

  it('dec_071_opening_the_review_books_nothing', () => {
    // The whole stance (DEC-052 §5, anti-Motion): propose, never apply.
    // DEC-094 rewrapped the subtitle (it now also carries the day span), so
    // the sentence sits on one line in the source. Same promise, same words.
    expect(cal).toContain('nothing is booked until you accept')
    expect(cal).toContain('async function acceptPlan(only?: PlannedProposal[])')
  })

  it('dec_071_a_single_block_can_be_dropped_without_losing_the_plan', () => {
    expect(cal).toContain('function dropProposal(')
    // Emptying the set closes the review — a dialog about nothing is a bug.
    expect(cal).toContain('if (next.length > 0) return next')
  })
})

// DEC-071 — the note's cap. It was a display limit living at the data layer,
// sized for a one-line bar, and it cut mid-word: the operator's own plan came
// back "…Cetra pitch deck—all high-cr".
describe('dec_071 — the planner note is bounded without being mangled', () => {
  // DEC-142 — these five cases each awaited `import('…/planSelect')` INSIDE the
  // test, so the module's one-time load was charged to a 5s test timeout. In a
  // full-suite run that import can exceed it: adding any one more test file to
  // the pool turned `dec_071_a_normal_note_passes_through_whole` red while it
  // still passed when the file ran alone. The import is hoisted here with room
  // to breathe; the cases themselves are unchanged.
  let mod: typeof import('../../src/main/ai/planSelect')
  beforeAll(async () => {
    mod = await import('../../src/main/ai/planSelect')
  }, 30_000)

  it('dec_071_a_normal_note_passes_through_whole', async () => {
    const { trimNote } = mod
    const note = 'Strategic product work: LakeDash roadmap, user flows, UX prototype.'
    expect(trimNote(note)).toBe(note)
  })

  it('dec_071_the_old_120_char_cap_no_longer_truncates_a_real_sentence', async () => {
    const { trimNote, PLAN_NOTE_MAX } = mod
    const note =
      'Strategic product/design work: LakeDash roadmap, user flows, UX prototype, Plexi marketing, Cetra pitch deck — all high-creativity items pulled from your rooms.'
    expect(note.length).toBeGreaterThan(120)
    expect(PLAN_NOTE_MAX).toBeGreaterThan(120)
    expect(trimNote(note)).toBe(note) // survives intact now
  })

  it('dec_071_an_overlong_note_is_cut_on_a_word_and_marked', async () => {
    const { trimNote, PLAN_NOTE_MAX } = mod
    const out = trimNote('alpha bravo '.repeat(80)) as string
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(PLAN_NOTE_MAX + 1)
    // Cut on a boundary — no half-words before the ellipsis.
    expect(out.replace('…', '').trimEnd()).toMatch(/(alpha|bravo)$/)
  })

  it('dec_071_a_single_giant_token_still_gets_bounded', async () => {
    const { trimNote, PLAN_NOTE_MAX } = mod
    const out = trimNote('x'.repeat(900)) as string
    expect(out.length).toBeLessThanOrEqual(PLAN_NOTE_MAX + 1)
  })

  it('dec_071_an_empty_note_is_null_not_an_empty_bubble', async () => {
    const { trimNote } = mod
    expect(trimNote('   ')).toBeNull()
  })
})
