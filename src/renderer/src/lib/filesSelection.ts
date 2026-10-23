// Multi-select in Files, the way Finder does it (pure).
//   click         → just this one
//   ⌘-click       → add or remove this one; it becomes the anchor
//   ⇧-click       → the range from the anchor (the last plain or ⌘ click) to here
//   ⌘⇧-click      → add that range to what is already selected
// The same rule drives the full Files view and the panel beside your work.

export interface SelectionMods {
  meta?: boolean
  shift?: boolean
}

export function nextSelection(
  order: string[],
  selected: string[],
  anchor: string | null,
  clicked: string,
  mods: SelectionMods
): { ids: string[]; focus: string } {
  if (mods.shift && anchor && order.includes(anchor) && order.includes(clicked)) {
    const a = order.indexOf(anchor)
    const b = order.indexOf(clicked)
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
    const ids = mods.meta ? Array.from(new Set([...selected, ...range])) : range
    // The anchor stays where the range started, so the next ⇧-click pivots on it.
    return { ids, focus: anchor }
  }
  if (mods.meta) {
    const ids = selected.includes(clicked) ? selected.filter((x) => x !== clicked) : [...selected, clicked]
    return { ids, focus: clicked }
  }
  return { ids: [clicked], focus: clicked }
}

/** Keyboard: move the focus by `delta`, extending the range with ⇧ (listbox semantics). */
export function stepSelection(
  order: string[],
  selected: string[],
  focus: string | null,
  anchor: string | null,
  delta: number,
  extend: boolean
): { ids: string[]; focus: string | null; anchor: string | null } {
  if (!order.length) return { ids: [], focus: null, anchor: null }
  const cur = focus ? order.indexOf(focus) : -1
  const nextIdx = cur < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, cur + delta))
  const next = order[nextIdx]!
  if (!extend) return { ids: [next], focus: next, anchor: next }
  const a = anchor && order.includes(anchor) ? anchor : (focus ?? next)
  const ai = order.indexOf(a)
  const range = order.slice(Math.min(ai, nextIdx), Math.max(ai, nextIdx) + 1)
  void selected
  return { ids: range, focus: next, anchor: a }
}
