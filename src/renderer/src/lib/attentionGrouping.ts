import type { FbNode } from '@shared/types'
import { MAX_GROUP_DEPTH } from '@shared/workItems'

// DEC-035 → DEC-048 — grouping, manual order, and (now) real nesting.
//
// The model is still a SIBLING reference (`groupId` → the parent item's id),
// never `parentId` (that means "the desk this lives on"). What changed in
// DEC-048, by operator instruction: chains may nest — a subtask can carry
// sub-subtasks — capped at MAX_GROUP_DEPTH levels total, enforced at the db
// write path and mirrored by every planner here so a drop that would exceed
// the cap is refused before it is attempted.
//
// The one failure mode grouping must never have, unchanged: an item silently
// vanishing because of something that happened to a DIFFERENT item. A child
// whose parent is absent from the queue is promoted, never hidden, and a
// corrupted cycle renders as flat rows rather than disappearing.

export { MAX_GROUP_DEPTH }

export interface GroupedRow {
  item: FbNode
  /** 0 = root; 1 and 2 are nested levels (render depth, clamped to the cap). */
  depth: number
  /** true when this row travels under a parent rather than standing alone. */
  isChild: boolean
  /** Direct children rendered under this row. */
  childCount: number
  /** Total rows in this row's rendered subtree (for the collapsed badge). */
  descendants: number
}

/**
 * DEC-070 — the flat, depth-annotated row list as a TREE.
 *
 * The reset ruling. Four rounds of per-row connector chrome (DEC-062 → 069)
 * tried to draw a hierarchy by making each row paint its own segment of line,
 * and every round produced a new seam, because segments drawn by different
 * rows can never be guaranteed to join. The operator ruled a re-baseline on
 * the inspiration component: the subtree renders as ONE group with ONE dashed
 * connector spanning it — an element that cannot have seams because it has no
 * segments — and the group animates open and closed as a unit, so the line
 * literally grows with the expansion.
 *
 * That needs the renderer to know where a subtree STARTS and ENDS, which a
 * flat list makes every consumer re-derive. This does it once. Order is
 * preserved exactly (depth-first, as flattened), and a malformed depth jump
 * attaches to the nearest real ancestor instead of throwing — a bad row must
 * not take the queue down.
 */
export interface NestedRow<T> {
  row: T
  children: NestedRow<T>[]
}

export function nestRows<T extends { depth: number }>(rows: readonly T[]): NestedRow<T>[] {
  const roots: NestedRow<T>[] = []
  const stack: NestedRow<T>[] = []
  for (const r of rows) {
    const node: NestedRow<T> = { row: r, children: [] }
    while (stack.length > r.depth) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

// DEC-144 — one parent rule for both kinds. A captured item nests by groupId;
// a task on a desk nests by parentId (a task under a task is its step). Only
// parents that are themselves in the list count (childMap checks), so a task's
// desk is never mistaken for its parent item.
const parentOf = (i: FbNode): string | null => {
  if (i.groupId && i.groupId !== i.id) return i.groupId
  if (i.kind === 'task' && i.parentId && i.parentId !== i.id) return i.parentId
  return null
}

/** The desk an item sits on: its nearest ancestor that is not itself an item
 *  in `items` (a work item's parent, or the desk above a chain of tasks). */
export function deskOf(i: FbNode, items: FbNode[], nodes: FbNode[]): string | null {
  const inList = new Set(items.map((x) => x.id))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let cur = i.parentId ?? null
  for (let hops = 0; cur && inList.has(cur) && hops < 16; hops++) {
    cur = byId.get(cur)?.parentId ?? items.find((x) => x.id === cur)?.parentId ?? null
  }
  return cur
}

/** Manual order beats the ranker ONLY where the operator has actually placed
 *  something. sortOrder 0 means "never dragged", and those keep their
 *  ranked position; anything explicitly placed sorts by its number. */
const placed = (i: FbNode): boolean => (i.sortOrder ?? 0) > 0

function childMap(items: FbNode[]): Map<string, FbNode[]> {
  const byId = new Set(items.map((i) => i.id))
  const kids = new Map<string, FbNode[]>()
  for (const i of items) {
    const gid = parentOf(i)
    if (gid && byId.has(gid)) kids.set(gid, [...(kids.get(gid) ?? []), i])
  }
  return kids
}

/** The item plus every descendant reachable through `groupId` (cycle-safe). */
export function subtreeIds(rootId: string, items: FbNode[]): Set<string> {
  const kids = childMap(items)
  const out = new Set<string>()
  const walk = (id: string): void => {
    if (out.has(id)) return
    out.add(id)
    for (const k of kids.get(id) ?? []) walk(k.id)
  }
  walk(rootId)
  return out
}

/** Height of the subtree rooted at `id` — the item alone is 1. Counts only
 *  members visible in `items`; the db guard re-checks over ALL rows. */
export function subtreeHeight(id: string, items: FbNode[]): number {
  const kids = childMap(items)
  const seen = new Set<string>()
  const h = (nodeId: string): number => {
    if (seen.has(nodeId)) return 0
    seen.add(nodeId)
    let deepest = 0
    for (const k of kids.get(nodeId) ?? []) deepest = Math.max(deepest, h(k.id))
    return 1 + deepest
  }
  return h(id)
}

/**
 * Order a queue's items as a rendered tree, every subtree kept together.
 *
 * Roots are ordered among themselves (manual placement first, then the
 * caller's ranking); each row's children follow it immediately, ordered the
 * same way, up to MAX_GROUP_DEPTH levels. A child whose parent is absent from
 * this queue — reclassified out, completed, snoozed — is promoted to a root
 * (its own children riding along), and cycle members are emitted flat.
 */
export function orderWithGroups(
  items: FbNode[],
  rank: (i: FbNode) => number
): GroupedRow[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const kids = new Map<string, FbNode[]>()
  const roots: FbNode[] = []
  for (const i of items) {
    const gid = parentOf(i)
    if (!gid || !byId.has(gid)) roots.push(i)
    else kids.set(gid, [...(kids.get(gid) ?? []), i])
  }

  const cmp = (a: FbNode, b: FbNode): number => {
    const ap = placed(a)
    const bp = placed(b)
    if (ap && bp) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    if (ap !== bp) return ap ? -1 : 1
    return rank(b) - rank(a)
  }

  const out: GroupedRow[] = []
  const emitted = new Set<string>()
  const walk = (i: FbNode, depth: number): number => {
    if (emitted.has(i.id)) return 0
    emitted.add(i.id)
    const row: GroupedRow = {
      item: i,
      depth,
      isChild: depth > 0,
      childCount: 0,
      descendants: 0
    }
    out.push(row)
    const mine = (kids.get(i.id) ?? []).filter((k) => !emitted.has(k.id)).sort(cmp)
    row.childCount = mine.length
    let n = 0
    for (const k of mine) n += 1 + walk(k, Math.min(depth + 1, MAX_GROUP_DEPTH - 1))
    row.descendants = n
    return n
  }
  for (const r of [...roots].sort(cmp)) walk(r, 0)
  // Cycle members are reachable from no root — emit them flat, never hide.
  for (const i of [...items].sort(cmp)) if (!emitted.has(i.id)) walk(i, 0)
  return out
}

/**
 * DEC-050 — a parent's subtask progress, the "3/5" every project tool shows.
 * Counts the WHOLE subtree (a sub-subtask is still work under this item), and
 * takes the closed-predicate as an argument so this module stays free of the
 * state machine.
 */
export function subtaskProgress(
  id: string,
  items: FbNode[],
  isClosed: (i: FbNode) => boolean
): { done: number; total: number } {
  const ids = subtreeIds(id, items)
  ids.delete(id)
  let done = 0
  for (const i of items) if (ids.has(i.id) && isClosed(i)) done++
  return { done, total: ids.size }
}

/**
 * Collapse filter: rows whose ancestor (in the rendered tree) is in
 * `collapsed` are hidden. Pure over the flat depth-annotated list, so the
 * view stays a thin mapper and the rule is testable.
 */
export function visibleRows(rows: GroupedRow[], collapsed: Set<string>): GroupedRow[] {
  if (!collapsed.size) return rows
  const out: GroupedRow[] = []
  const stack: Array<{ depth: number; hidden: boolean }> = []
  for (const r of rows) {
    while (stack.length && stack[stack.length - 1].depth >= r.depth) stack.pop()
    const parent = stack[stack.length - 1]
    const hidden = !!parent && parent.hidden
    stack.push({ depth: r.depth, hidden: hidden || collapsed.has(r.item.id) })
    if (!hidden) out.push(r)
  }
  return out
}

export type DropPosition = 'before' | 'after' | 'into'

export interface GroupWrite {
  id: string
  groupId?: string | null
  sortOrder?: number
  intentClass?: string
}

/** A target's 1-based level in the rendered tree (1 when unknown). */
const levelIn = (ordered: GroupedRow[], id: string): number =>
  (ordered.find((r) => r.item.id === id)?.depth ?? 0) + 1

/**
 * The writes one drag-and-drop produces — computed, not performed, so the rule
 * is testable and the caller stays a thin applier.
 *
 * 'into' nests the dragged item under the target itself (dropping onto a
 * child makes a sub-subtask — DEC-048); 'before'/'after' place it beside the
 * target as a SIBLING, inheriting the target's parent. The dragged item's own
 * subtree rides along, so both forms refuse when parent-level + subtree-height
 * would exceed MAX_GROUP_DEPTH, and when the target sits inside the dragged
 * subtree (a cycle). A cross-queue drop (`intoQueue`) reclassifies the WHOLE
 * subtree in the same gesture — children follow their parent, never strand.
 */
export function planDrop(
  dragged: FbNode,
  targetId: string,
  position: DropPosition,
  ordered: GroupedRow[],
  intoQueue?: string,
  /** ALL items the drag could have come from — lets a cross-queue drag see
   *  (and carry) the dragged item's subtree even though it lives outside the
   *  target queue's rows. Omitted = resolve from the visible rows alone. */
  sourceItems?: FbNode[]
): GroupWrite[] {
  if (dragged.id === targetId) return []
  const rows = ordered.map((r) => r.item)
  const target = rows.find((i) => i.id === targetId)
  if (!target) return []

  const pool =
    sourceItems ?? (rows.some((i) => i.id === dragged.id) ? rows : [...rows, dragged])
  const sub = subtreeIds(dragged.id, pool)
  if (sub.has(targetId)) return [] // dropping into/beside its own descendant

  const h = subtreeHeight(dragged.id, pool)
  let nextGroup: string | null
  if (position === 'into') {
    if (levelIn(ordered, targetId) + h > MAX_GROUP_DEPTH) return []
    nextGroup = target.id
  } else {
    if (levelIn(ordered, targetId) - 1 + h > MAX_GROUP_DEPTH) return []
    nextGroup = parentOf(target)
  }
  if (nextGroup === dragged.id) return []

  // Rebuild the visible order with the dragged row placed, then renumber every
  // row from 1. Renumbering the whole queue (rather than nudging one value) is
  // what keeps the order stable and free of ties as items come and go. A row
  // arriving from ANOTHER queue is simply inserted — it was never in `rows`.
  const without = rows.filter((i) => i.id !== dragged.id)
  const at = without.findIndex((i) => i.id === targetId)
  const insertAt = position === 'before' ? at : at + 1
  const nextRows = [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)]

  const writes: GroupWrite[] = []
  nextRows.forEach((i, idx) => {
    const order = idx + 1
    const isDragged = i.id === dragged.id
    const groupChanged = isDragged && (i.groupId ?? null) !== nextGroup
    const reclass = isDragged && !!intoQueue
    if ((i.sortOrder ?? 0) !== order || groupChanged || reclass) {
      writes.push({
        id: i.id,
        sortOrder: order,
        ...(groupChanged || reclass ? { groupId: nextGroup } : {}),
        ...(reclass ? { intentClass: intoQueue } : {})
      })
    }
  })
  if (intoQueue) {
    // The subtree crosses with its parent.
    for (const id of sub) {
      if (id === dragged.id) continue
      const w = writes.find((x) => x.id === id)
      if (w) w.intentClass = intoQueue
      else writes.push({ id, intentClass: intoQueue })
    }
  }
  return writes
}

/**
 * DEC-048 — one drop for a whole SELECTION. Only the selection's top-level
 * members re-parent (an item selected along with its own parent keeps its
 * internal structure and rides inside it); each top's subtree travels with
 * it. Refused whenever the target is the selection or sits inside any
 * selected subtree, or when the deepest resulting chain would exceed the cap
 * — so the UI can simply not offer the drop.
 */
export function planDropMulti(
  draggedIds: string[],
  targetId: string,
  position: DropPosition,
  ordered: GroupedRow[],
  intoQueue?: string,
  /** ALL items the selection could span (the 'all' tab crosses queues);
   *  omitted = the visible rows alone. */
  sourceItems?: FbNode[]
): GroupWrite[] {
  const rows = ordered.map((r) => r.item)
  const pool = sourceItems ?? rows
  const poolById = new Map(pool.map((i) => [i.id, i]))
  const rowIds = new Set(rows.map((i) => i.id))
  const selected = new Set(draggedIds.filter((id) => poolById.has(id)))
  selected.delete(targetId)
  if (!selected.size || !rowIds.has(targetId)) return []

  // Top-level members: no ancestor of theirs is also selected.
  const tops: FbNode[] = []
  for (const id of selected) {
    let cursor = parentOf(poolById.get(id)!)
    let hasSelectedAncestor = false
    const seen = new Set<string>([id])
    while (cursor && poolById.has(cursor) && !seen.has(cursor)) {
      if (selected.has(cursor)) {
        hasSelectedAncestor = true
        break
      }
      seen.add(cursor)
      cursor = parentOf(poolById.get(cursor)!)
    }
    if (!hasSelectedAncestor) tops.push(poolById.get(id)!)
  }
  if (!tops.length) return []
  for (const t of tops) if (subtreeIds(t.id, pool).has(targetId)) return []

  const target = poolById.get(targetId)!
  const maxH = Math.max(...tops.map((t) => subtreeHeight(t.id, pool)))
  let nextGroup: string | null
  if (position === 'into') {
    if (levelIn(ordered, targetId) + maxH > MAX_GROUP_DEPTH) return []
    nextGroup = target.id
  } else {
    if (levelIn(ordered, targetId) - 1 + maxH > MAX_GROUP_DEPTH) return []
    nextGroup = parentOf(target)
  }

  // The moved block: tops in their current visual order, inserted as a unit;
  // tops arriving from OUTSIDE the target queue's rows append behind them.
  const topIds = new Set(tops.map((t) => t.id))
  const block = [
    ...rows.filter((i) => topIds.has(i.id)),
    ...tops.filter((t) => !rowIds.has(t.id))
  ]
  const without = rows.filter((i) => !topIds.has(i.id))
  const at = without.findIndex((i) => i.id === targetId)
  if (at < 0) return []
  const insertAt = position === 'before' ? at : at + 1
  const nextRows = [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)]

  const writes: GroupWrite[] = []
  nextRows.forEach((i, idx) => {
    const order = idx + 1
    const isMoved = topIds.has(i.id)
    const groupChanged = isMoved && (i.groupId ?? null) !== nextGroup
    const reclass = isMoved && !!intoQueue
    if ((i.sortOrder ?? 0) !== order || groupChanged || reclass) {
      writes.push({
        id: i.id,
        sortOrder: order,
        ...(groupChanged || reclass ? { groupId: nextGroup } : {}),
        ...(reclass ? { intentClass: intoQueue } : {})
      })
    }
  })
  if (intoQueue) {
    for (const t of tops) {
      for (const id of subtreeIds(t.id, pool)) {
        if (id === t.id) continue
        const w = writes.find((x) => x.id === id)
        if (w) w.intentClass = intoQueue
        else writes.push({ id, intentClass: intoQueue })
      }
    }
  }
  return writes
}

/**
 * A SELECTION dropped on a queue header / empty space: every top re-classes
 * into that queue as a root, landing at the end in visual order, each with
 * its subtree riding along.
 */
export function planMoveToQueueMulti(
  draggedIds: string[],
  queue: string,
  ordered: GroupedRow[],
  sourceItems: FbNode[]
): GroupWrite[] {
  const poolById = new Map(sourceItems.map((i) => [i.id, i]))
  const selected = new Set(draggedIds.filter((id) => poolById.has(id)))
  const tops: string[] = []
  for (const id of selected) {
    let cursor = parentOf(poolById.get(id)!)
    let hasSelectedAncestor = false
    const seen = new Set<string>([id])
    while (cursor && poolById.has(cursor) && !seen.has(cursor)) {
      if (selected.has(cursor)) {
        hasSelectedAncestor = true
        break
      }
      seen.add(cursor)
      cursor = parentOf(poolById.get(cursor)!)
    }
    if (!hasSelectedAncestor) tops.push(id)
  }
  const writes: GroupWrite[] = []
  tops.forEach((id, k) => {
    writes.push({ id, groupId: null, sortOrder: ordered.length + 1 + k, intentClass: queue })
    for (const member of subtreeIds(id, sourceItems)) {
      if (member !== id) writes.push({ id: member, intentClass: queue })
    }
  })
  return writes
}

/**
 * Dropping into a queue's empty space (or onto its header): the item is
 * reclassified into that queue and lands at the end, keeping whatever manual
 * order the queue already had. It becomes a root there — but its own subtree
 * follows it across, still nested (DEC-048).
 */
export function planMoveToQueue(
  draggedId: string,
  queue: string,
  ordered: GroupedRow[],
  /** All items the drag came from, so the subtree can travel. Omitted =
   *  the dragged row moves alone (legacy call shape). */
  sourceItems?: FbNode[]
): GroupWrite[] {
  const writes: GroupWrite[] = [
    { id: draggedId, groupId: null, sortOrder: ordered.length + 1, intentClass: queue }
  ]
  if (sourceItems) {
    for (const id of subtreeIds(draggedId, sourceItems)) {
      if (id !== draggedId) writes.push({ id, intentClass: queue })
    }
  }
  return writes
}

/** Detach an item from its parent — the explicit escape from a drag. Its own
 *  children stay with it (it becomes a root carrying its subtree). */
export function planUngroup(id: string): Array<{ id: string; groupId: null }> {
  return [{ id, groupId: null }]
}
