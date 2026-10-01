/**
 * Keeping Plexii's reason attached to what it created.
 *
 * A user approves a proposal BECAUSE of the reason on the card, and that
 * sentence used to be discarded the moment they did: nothing carried it into the
 * work item, so the row arriving in Attention could say no more than "Suggested
 * by Plexii". A week later the only honest answer to "why is this on my list?"
 * was a shrug — which is the same complaint as the assistant not explaining
 * itself, arriving a week late.
 *
 * Pure and separate so the composition is tested rather than eyeballed: the
 * ordering, the attribution and the de-duplication are each a real decision the
 * user sees the result of.
 */
export function attributedNotes(
  notes: string | null | undefined,
  reason: string | null | undefined
): string | undefined {
  const own = (notes ?? '').trim()
  const why = (reason ?? '').trim()
  if (!why) return own || undefined
  // Attributed, never blended into the user's own notes: this is Plexii's
  // account of why, not theirs, and a note that reads as the user's own words
  // when it is not is the kind of small dishonesty that costs trust in an
  // assistant.
  const line = `Why Plexii suggested this: ${why}`
  if (!own) return line
  // Already carried (re-applied card, or an edited item being refiled) — adding
  // it twice would grow the note on every pass.
  if (own.includes(line)) return own
  // The user's own words come first. Theirs is the note; this is the footnote.
  return `${own}\n\n${line}`
}
