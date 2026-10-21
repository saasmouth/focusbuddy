import { statusForWorkItemState, DEFAULT_INTENT_CLASS, canonicalIntentClass } from './workItems'
import type { FbNode, TaskStatus } from './types'

// One record, two lenses.
//
// A task on a desk and an item in Attention were two separate things: different
// node kinds, different state machines, different closing verbs, and no way to
// see the same piece of work in both places. This module is the join, and it
// deliberately joins by PROJECTION rather than by copying: the node is the
// record, and Attention reads the fields that node already has.
//
// The alternative -- writing a work_item alongside every task -- was rejected
// because two rows for one piece of work is precisely the bug being fixed. They
// drift the moment anything updates one and not the other, and then neither is
// trustworthy.
//
// So: a work_item keeps its own state machine (it has states a task has no use
// for -- 'needs_approval', 'delegated'). A task keeps `status`, which is the
// truth for a task. Each is read through a single shape, and each is written
// back in its own vocabulary.

/**
 * Is this node a task filed on a desk, as opposed to a desk itself?
 *
 * A desk and a task are the same node kind here -- a desk is a task you opened
 * as a canvas -- so the boundary is the parent: a task whose parent is also a
 * task is work ON a desk. A top-level one IS the desk, and a desk is not an
 * item to be done.
 */
export function isDeskTask(node: FbNode, byId: (id: string) => FbNode | undefined): boolean {
  if (node.kind !== 'task') return false
  if (node.archived) return false
  if (!node.parentId) return false
  const parent = byId(node.parentId)
  return parent?.kind === 'task'
}

/** The work-item state a task's status corresponds to. */
export function stateForTaskStatus(status: TaskStatus): string {
  switch (status) {
    case 'in_progress':
      return 'in_progress'
    case 'done':
      return 'completed'
    case 'parked':
      // Parked is a deliberate "not now", which is what dismissed means in the
      // attention vocabulary -- not the same as done, and not still open.
      return 'dismissed'
    default:
      return 'open'
  }
}

/** The task status a work-item state corresponds to. Re-exported for symmetry. */
export function taskStatusForState(state: string): TaskStatus {
  return statusForWorkItemState(state)
}

/**
 * Read any node as an attention item.
 *
 * Returns the node unchanged when it already carries the fields (a work_item),
 * and fills them in from what a task has when it does not. Nothing is written:
 * this is how the record is READ, and the record itself stays one row.
 */
export function asAttentionItem(node: FbNode): FbNode {
  if (node.kind !== 'task') return node
  return {
    ...node,
    // A task with no declared intent is something to do, which is both the
    // truthful default and the queue a desk task belongs in.
    intentClass: node.intentClass ?? DEFAULT_INTENT_CLASS,
    workItemState: node.workItemState ?? stateForTaskStatus(node.status),
    // Attention sorts and groups on the ISO dueAt; tasks carry a numeric
    // dueDate. Same fact, two column types, so it is converted on read rather
    // than stored twice.
    dueAt: node.dueAt ?? (node.dueDate ? new Date(node.dueDate).toISOString() : null)
  }
}

/**
 * Which of a set of nodes belong in Attention.
 *
 * Every work_item, plus every task filed on a desk. Both come back projected,
 * so the caller has one shape to render.
 */
export function attentionItemsFrom(nodes: readonly FbNode[]): FbNode[] {
  const index = new Map(nodes.map((n) => [n.id, n]))
  const byId = (id: string): FbNode | undefined => index.get(id)
  const out: FbNode[] = []
  for (const n of nodes) {
    if (n.kind === 'work_item') out.push(n)
    else if (isDeskTask(n, byId)) out.push(asAttentionItem(n))
  }
  return out
}

/** The item fields a desk task can hold, keyed by the TASK's attribute names. */
export interface TaskAttrsFromItem {
  title?: string
  description?: string
  dueDate?: number | null
  intentClass?: string
}

/**
 * Translate an item-shaped edit (what Focus's editor and the MCP tools send)
 * into a desk task's own attributes (DEC-144).
 *
 * Same fact, the task's vocabulary: `notes` is the task's description and the
 * ISO `dueAt` is its numeric `dueDate`. Returns null when the patch carries a
 * field a task does not have (urgency, tags, mentions, the meeting fields,
 * work_item_state...) or a value that cannot be stored, so the caller refuses
 * the whole edit rather than applying half of it and reporting success.
 */
export function taskAttrsForItemPatch(patch: Record<string, unknown>): TaskAttrsFromItem | null {
  const out: TaskAttrsFromItem = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    switch (key) {
      case 'title':
        if (typeof value !== 'string' || !value.trim()) return null
        out.title = value.trim()
        break
      case 'notes':
        if (value !== null && typeof value !== 'string') return null
        out.description = value ?? ''
        break
      case 'dueAt': {
        if (value === null) {
          out.dueDate = null
          break
        }
        const ms = typeof value === 'string' ? Date.parse(value) : NaN
        if (!Number.isFinite(ms)) return null
        out.dueDate = ms
        break
      }
      case 'intentClass': {
        const canonical = canonicalIntentClass(value)
        if (!canonical) return null
        out.intentClass = canonical
        break
      }
      default:
        return null
    }
  }
  return out
}

/** The item-editor fields a desk task supports. Focus hides the rest for one. */
export const TASK_EDITABLE_ITEM_FIELDS = ['title', 'notes', 'dueAt', 'intentClass'] as const
