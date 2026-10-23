// Command palette ranking. Rows arrive scored by their own matchers; this
// filters and orders them, with one rule on top: the full name of a row is
// that row. Typing "new report" and pressing Enter creates a report; it does
// not web-search the words (the omni search row scores a flat 175, above any
// ordinary match). A URL or a question the omni classifier leads with (2000)
// still wins, since no command is named like either.
export const EXACT_LABEL_SCORE = 1500

export function rankPaletteItems<T extends { label: string; score: number }>(items: T[], q: string): T[] {
  const needle = q.trim().toLowerCase()
  if (needle === '') return items.slice().sort((a, b) => b.score - a.score)
  return items
    .map((i) => (i.label.trim().toLowerCase() === needle && i.score < EXACT_LABEL_SCORE ? { ...i, score: EXACT_LABEL_SCORE } : i))
    .filter((i) => i.score > 0)
    .sort((a, b) => b.score - a.score)
}
