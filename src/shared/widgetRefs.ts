// Widgets whose content is a REFERENCE to something else in the workspace.
//
// A task-link holds a desk id. A portal holds the id of the desk it watches. A
// drive widget holds a folder id, a file widget a file id, a table widget an
// fb_tables id. In every case the content is one id and nothing else.
//
// Which makes them the same problem the chart had, in miniature: a model cannot
// invent an id, and the failure when it tries is quiet. A task-link pointing at
// a desk that does not exist renders as a dead chip; a table widget bound to a
// missing id shows an empty grid that reads as "no rows" rather than "wrong
// table". Nothing throws. So the expert is handed the real objects to choose
// from, and whatever comes back is checked against them before it is written.
//
// Pure on purpose — no store, no IPC — so the rules are unit testable.

/** One candidate the expert may choose, reduced to what matters. */
export interface RefCandidate {
  id: string
  title: string
  /** The object's own kind, so a folder is not accepted where a file is meant. */
  objectKind: string
}

/** What each referencing widget kind is allowed to point at. */
export const REF_OBJECT_KIND: Readonly<Record<string, string>> = {
  'task-link': 'desk',
  portal: 'desk',
  drive: 'folder',
  file: 'file',
  table: 'table'
}

export type RefProblem = { ok: false; reason: string } | { ok: true }

export function validateWidgetRef(
  widgetKind: string,
  id: unknown,
  candidates: readonly RefCandidate[]
): RefProblem {
  const expected = REF_OBJECT_KIND[widgetKind]
  if (!expected) {
    return { ok: false, reason: `A ${widgetKind} widget does not hold a reference.` }
  }
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, reason: `A ${widgetKind} widget needs something to point at.` }
  }
  const found = candidates.find((c) => c.id === id.trim())
  if (!found) {
    // Named, not shrugged at: this is the model inventing an id, and saying so
    // is the difference between a fixable message and a widget that looks
    // merely empty.
    return { ok: false, reason: `Nothing in this workspace has id ${id.trim()}.` }
  }
  if (found.objectKind !== expected) {
    // The universe is already filtered by kind, so this is belt and braces —
    // but a folder accepted where a file is meant renders an empty widget, and
    // that is exactly the quiet failure worth refusing twice.
    return {
      ok: false,
      reason: `${found.title} is a ${found.objectKind}, and this widget points at a ${expected}.`
    }
  }
  return { ok: true }
}

/** Does this widget kind hold a reference the expert can resolve? */
export function isRefKind(kind: string): boolean {
  return kind in REF_OBJECT_KIND
}
