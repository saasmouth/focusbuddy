import * as Y from 'yjs'

// Keyed reconcile: the co-editing engine for documents whose lists are lists of
// THINGS WITH IDS (PlexiiDraw's layers and objects), not lists addressed by
// position.
//
// yjsJson.reconcileMap aligns arrays by index. That is right for a grid of
// cells and wrong for a z-ordered list of shapes: bringing one shape to the
// front, or deleting one from the middle, shifts every later shape down a slot,
// and the index-aligned reconcile then rewrites each slot's fields in place --
// so slot 3 receives object 4's fields one by one. A collaborator who was
// meanwhile recolouring the object in slot 3 has their edit merged onto
// whatever object now lives there: two objects blend into one.
//
// Here an array whose items all carry a unique string `id` is reconciled BY ID:
//
//   - an object that still exists is updated in place, field by field, in its
//     own Y.Map -- so a concurrent edit to it by someone else merges with ours;
//   - an object that is gone is deleted, an object that is new is inserted;
//   - a change of ORDER moves only the items that have to move (everything on
//     the longest run already in the right relative order stays put).
//
// Yjs has no "move", so a moved item is re-inserted with our copy of its
// fields: a collaborator's concurrent edit to THAT SAME object, at the same
// moment we reordered it, is lost (the object keeps our version). That is the
// one remaining trade-off, and it is the narrow one -- the edit is dropped,
// never smeared across a different object as index alignment did.
//
// The stored Yjs SHAPE is unchanged (arrays stay Y.Arrays of Y.Maps), so a
// client still running the index-aligned engine in the same session reads and
// writes the same document.

function toY(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>()
    arr.push(value.map(toY))
    return arr
  }
  if (value && typeof value === 'object') {
    const map = new Y.Map<unknown>()
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) map.set(k, toY(v))
    return map
  }
  return value
}

function idOfJson(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const id = (v as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : null
}

function idOfY(v: unknown): string | null {
  if (!(v instanceof Y.Map)) return null
  const id = v.get('id')
  return typeof id === 'string' && id ? id : null
}

/** Ids of every item, or null when any item has none or two share one. */
function uniqueIds<T>(items: T[], idOf: (v: T) => string | null): string[] | null {
  const out: string[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const id = idOf(it)
    if (id === null || seen.has(id)) return null
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Indexes (into `seq`) of one longest strictly increasing subsequence. Used to
 * find the largest set of surviving items already in the target order, which
 * therefore do not have to move.
 */
function longestIncreasing(seq: number[]): Set<number> {
  const tails: number[] = []
  const prev = new Array<number>(seq.length).fill(-1)
  for (let i = 0; i < seq.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const keep = new Set<number>()
  let k = tails.length ? tails[tails.length - 1] : -1
  while (k >= 0) {
    keep.add(k)
    k = prev[k]
  }
  return keep
}

function reconcileKeyed(arr: Y.Array<unknown>, list: unknown[], newIds: string[]): void {
  const wanted = new Map(newIds.map((id, i) => [id, i]))
  // 1. Drop what no longer exists (from the end, so indexes stay valid).
  for (let i = arr.length - 1; i >= 0; i--) {
    const id = idOfY(arr.get(i))
    if (id === null || !wanted.has(id)) arr.delete(i, 1)
  }
  // 2. Of the survivors, keep the longest run already in target order; the
  //    rest are taken out here and re-inserted at their new place in step 3.
  const order = arr.toArray().map((v) => wanted.get(idOfY(v) as string) as number)
  const keep = longestIncreasing(order)
  for (let i = order.length - 1; i >= 0; i--) if (!keep.has(i)) arr.delete(i, 1)
  // 3. Walk the target list. Survivors are now in target order, so each slot
  //    either already holds the right object (update it in place) or needs
  //    the object inserted there (new, or one that moved).
  for (let i = 0; i < list.length; i++) {
    const cur = i < arr.length ? arr.get(i) : undefined
    if (cur instanceof Y.Map && idOfY(cur) === newIds[i]) reconcileMapKeyed(cur, list[i] as Record<string, unknown>)
    else arr.insert(i, [toY(list[i])])
  }
}

function reconcileIndexed(arr: Y.Array<unknown>, list: unknown[]): void {
  // Positional lists (path nodes, gradient stops, dash patterns): match by
  // index, recurse into matching containers, replace changed primitives.
  for (let i = 0; i < list.length; i++) {
    const v = list[i]
    if (i >= arr.length) {
      arr.push([toY(v)])
      continue
    }
    const cur = arr.get(i)
    if (Array.isArray(v) && cur instanceof Y.Array) reconcileArrayKeyed(cur, v)
    else if (v && typeof v === 'object' && !Array.isArray(v) && cur instanceof Y.Map) reconcileMapKeyed(cur, v as Record<string, unknown>)
    else if (cur !== v) {
      arr.delete(i, 1)
      arr.insert(i, [toY(v)])
    }
  }
  if (arr.length > list.length) arr.delete(list.length, arr.length - list.length)
}

/** Reconcile one array: by id when every item (old and new) has a unique one, by position otherwise. */
export function reconcileArrayKeyed(arr: Y.Array<unknown>, list: unknown[]): void {
  const newIds = list.length ? uniqueIds(list, idOfJson) : []
  const oldIds = arr.length ? uniqueIds(arr.toArray(), idOfY) : []
  if (newIds && oldIds && (newIds.length > 0 || oldIds.length > 0)) reconcileKeyed(arr, list, newIds)
  else reconcileIndexed(arr, list)
}

function reconcileInto(parent: Y.Map<unknown>, key: string, v: unknown): void {
  const cur = parent.get(key)
  if (Array.isArray(v)) {
    if (cur instanceof Y.Array) reconcileArrayKeyed(cur, v)
    else parent.set(key, toY(v))
  } else if (v && typeof v === 'object') {
    if (cur instanceof Y.Map) reconcileMapKeyed(cur, v as Record<string, unknown>)
    else parent.set(key, toY(v))
  } else if (cur !== v) {
    parent.set(key, v)
  }
}

/**
 * Reconcile a Y.Map to match `obj`, applying the minimal set of changes, with
 * id-keyed arrays. Wrap calls in one Y.transact at the call site so peers see
 * one update and the undo manager sees one step.
 */
export function reconcileMapKeyed(map: Y.Map<unknown>, obj: Record<string, unknown>): void {
  for (const k of [...map.keys()]) if (!(k in obj)) map.delete(k)
  for (const [k, v] of Object.entries(obj)) reconcileInto(map, k, v)
}

// ── Own-change undo ──────────────────────────────────────────────────────────

/**
 * What a co-edited editor needs from an undo stack that only ever holds ITS
 * OWN changes.
 *
 * The studio's ordinary undo restores a whole snapshot of the body. In a live
 * session that snapshot is then reconciled over the shared document, so an
 * undo silently reverted whatever a collaborator had changed since the
 * snapshot was taken. This stack is a Y.UndoManager that tracks only the local
 * origin: undo reverses this person's operations and nothing else, and a
 * collaborator's concurrent edit survives it.
 */
export interface LiveUndo {
  /** Close the current step: the next local change starts a new one. */
  checkpoint(): void
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
  /** Called whenever the stacks change, so Undo/Redo can enable and disable. */
  subscribe(cb: () => void): () => void
  /** Forget every step (e.g. after seeding the shared document). */
  clear(): void
  destroy(): void
}

/**
 * An own-change undo stack over `root`, tracking only transactions made with
 * `localOrigin`. Steps are delimited by `checkpoint()` -- one per gesture or
 * command -- not by time, so a slow drag is one step and two quick commands are
 * two.
 */
export function createLiveUndo(root: Y.Map<unknown>, localOrigin: unknown): LiveUndo {
  // A capture window longer than any session: grouping is driven entirely by
  // checkpoint() (stopCapturing), never by the clock.
  const um = new Y.UndoManager(root, { trackedOrigins: new Set([localOrigin]), captureTimeout: 2 ** 31 - 1 })
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const cb of listeners) cb()
  }
  um.on('stack-item-added', notify)
  um.on('stack-item-popped', notify)
  um.on('stack-cleared', notify)
  return {
    checkpoint: () => um.stopCapturing(),
    undo: () => {
      um.stopCapturing()
      um.undo()
    },
    redo: () => {
      um.stopCapturing()
      um.redo()
    },
    canUndo: () => um.undoStack.length > 0,
    canRedo: () => um.redoStack.length > 0,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    clear: () => um.clear(),
    destroy: () => {
      listeners.clear()
      um.destroy()
    }
  }
}
