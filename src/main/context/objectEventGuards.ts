// DEC-059 — an Object Event asserts that state changed. These decide whether it
// actually did.
//
// Every emitter in ipc/index.ts fired on the REQUEST rather than the OUTCOME,
// and the database layer had already been built to absorb replays: createNode
// and createWidget both return the existing row untouched when the id is
// already present ("so a replayed/echoed create never duplicates"). So a CRDT
// replay would call nodes:create for a desk that has existed since June, the db
// would correctly do nothing, and the handler would emit `Created desk "X"`
// anyway.
//
// Measured on the operator's machine before this fix: 20 DeskCreated events for
// a single desk whose row was created two months earlier, 15,481 WidgetUpdated
// across 38 widgets (six for one sticky inside 2ms, all with byte-identical
// state), and 774+ events per replay episode. crdtSync applies remote events by
// calling the same user-facing IPC a human uses — nodes.create, nodes.delete,
// widgets.create/update/delete — so every replayed event minted a fresh
// "user did this" Event for a change that had already happened, or had not
// happened at all.
//
// That matters more here than in an ordinary log, because Events CANNOT be
// pruned: PLX-EVT-030 makes the store append-only and PLX-EVT-031 requires it
// to stay replayable. Anything emitted here is permanent. The only place to be
// correct is before the append.
//
// These are pure so the rule can be tested directly rather than inferred from
// handler behaviour.

// Columns that move on every write whether or not anything meaningful changed.
// `updatedAt` is the important one: a no-op re-apply still bumps it, so leaving
// it in the comparison would make every replayed write look like an edit and
// defeat the entire guard.
const BOOKKEEPING = new Set([
  'updatedAt',
  'updated_at',
  'syncRev',
  'sync_rev',
  'needsSync',
  'needs_sync'
])

/**
 * A create is real only if nothing was there. `before` is the row as it existed
 * BEFORE the create call — null/undefined when the id was genuinely new.
 */
export function isRealCreate(before: unknown | null | undefined): boolean {
  return before === null || before === undefined
}

/**
 * A delete is real only if there was something to delete. Deleting an id that
 * is already gone is not a state transition and must not mint an Event.
 */
export function isRealDelete<T>(before: T | null | undefined): before is T {
  return before !== null && before !== undefined
}

/**
 * Did any user-meaningful field actually change? Bookkeeping columns are
 * ignored; nested values compare structurally so a rebuilt-but-identical
 * object (layout, tags) does not read as an edit.
 *
 * A row appearing or vanishing counts as a change — callers that care about
 * those cases use isRealCreate / isRealDelete instead.
 */
export function stateChanged(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): boolean {
  if (!before || !after) return before !== after
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (BOOKKEEPING.has(key)) continue
    const a = before[key]
    const b = after[key]
    if (Object.is(a, b)) continue
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      if (JSON.stringify(a) === JSON.stringify(b)) continue
    }
    return true
  }
  return false
}
