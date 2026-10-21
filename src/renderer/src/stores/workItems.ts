import { create } from 'zustand'
import type { FbNode } from '@shared/types'
import { WORK_ITEM_COLUMNS, normalizeAssigneeIds } from '@shared/workItems'
import { crdtEmitNodeCreate, crdtEmitNodeAttrs, crdtEmitNodeTitle } from '../lib/crdtBridge'
import { nudgeSync } from '../lib/syncNudge'
import { taskAttrsForItemPatch } from '@shared/attentionProjection'

// The work_item store (Attention S3, §4). Work items NEVER pass through
// useNodeStore — listNodes excludes the kind, and every desk/room surface is
// blind to them by construction. This store is the renderer-side producer for
// the live path (§3): create → crdtEmitNodeCreate (the emit carries the full
// manifest snapshot); field/state changes → crdtEmitNodeAttrs registers.
// snooze/markRead are wi_local device-local state — IPC only, no emit.
//
// The poll's receive side refreshes this store from the sync loop the same
// way useNodeStore is refreshed; the live path's receive side lands through
// the arrival router (crdtSync → workItems:applySyncEvent) and also refreshes
// here.

interface WorkItemStore {
  items: FbNode[]
  loaded: boolean
  refresh: () => Promise<void>
  create: (draft: {
    title: string
    notes?: string
    parentId?: string | null
    intentClass?: string
    state?: string
    dueAt?: string | null
    wiUrgency?: string | null
    tags?: string | null
    mentions?: string | null
    confidence?: number | null
    approvalState?: string
    sourceRef?: string | null
    sourceType?: string | null
    sourceUrl?: string | null
    wiOrigin?: 'human' | 'ai' | 'system'
  }) => Promise<FbNode>
  updateFields: (id: string, patch: Record<string, unknown>) => Promise<FbNode | null>
  setState: (id: string, state: string) => Promise<boolean>
  reclassify: (id: string, intentClass: string) => Promise<FbNode | null>
  snooze: (id: string, until: number | null) => Promise<void>
  markRead: (id: string) => Promise<void>
}

const EMITTED_ATTRS = new Set(WORK_ITEM_COLUMNS.filter((c) => c.rendererEmitted).map((c) => c.attr))

/**
 * Turn a main-process refusal into something a person can act on.
 *
 * What reached the user was the raw rejection, e.g.
 *
 *   Error invoking remote method 'workItems:create': Error: …
 *
 * which names an IPC channel and reads as "the app is broken". Every
 * work-items write can be refused the same way, so the translation lives
 * here rather than at each call site. (DEC-144 retired "turned off": Focus is
 * always on, and no message names a Settings switch that does not exist.
 * DEC-145 retired "personal only": team workspaces hold tasks.) Matched on the
 * message text; the main
 * process is the authority on its own gate.
 */
export function friendlyWorkItemError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e)
  if (/has not (migrated|finished updating)/i.test(raw))
    return new Error('This device has not finished updating for Focus yet. Restart Plexii and try again.')
  return e instanceof Error ? e : new Error(raw)
}

/**
 * DEC-144 — "X assigned you a task". When the Focus list holds an open task
 * that lists you as an assignee and was raised by someone else, post one
 * notification for it. The dedupe key is per task and person, and the
 * substrate keeps it across restarts, so each assignment announces itself
 * exactly once — however many times the list refreshes. Lazy imports: this
 * store also loads where there is no window (its unit tests).
 */
async function announceAssignments(items: FbNode[]): Promise<void> {
  try {
    const [{ useAccountStore }, { parseAssigneeIds, TERMINAL_WORK_ITEM_STATES }, { usePeopleStore, personName }] =
      await Promise.all([import('./account'), import('@shared/workItems'), import('../lib/peopleDirectory')])
    const self = useAccountStore.getState().account?.id
    if (!self) return
    const terminal = new Set<string>(TERMINAL_WORK_ITEM_STATES)
    for (const i of items) {
      if (!i.originatorId || i.originatorId === self) continue
      if (i.workItemState && terminal.has(i.workItemState)) continue
      if (!parseAssigneeIds(i.assigneeIds).includes(self)) continue
      const from = usePeopleStore.getState().people.find((p) => p.accountId === i.originatorId)
      await window.api.notifications
        .post({
          ref: i.id,
          queue: i.intentClass ?? 'to_do',
          title: `${from ? personName(from) : 'A teammate'} assigned you a task`,
          body: i.title || 'Untitled task',
          dedupeKey: `assigned:${i.id}:${self}`,
          category: 'attention',
          trigger: 'assigned',
          origin: 'human'
        } as never)
        .catch(() => {})
    }
  } catch {
    /* a notification is a courtesy; the task is in Focus either way */
  }
}

export const useWorkItemStore = create<WorkItemStore>((set, get) => ({
  items: [],
  loaded: false,
  refresh: async () => {
    try {
      const items = await window.api.workItems.list()
      set({ items, loaded: true })
      void announceAssignments(items)
    } catch {
      /* un-migrated / early boot — keep what we have */
    }
  },
  create: async (draft) => {
    let item: FbNode
    try {
      item = await window.api.workItems.create(draft)
    } catch (e) {
      throw friendlyWorkItemError(e)
    }
    set({ items: [item, ...get().items] })
    // Live-path producer contract (§3): the create snapshot carries the full
    // renderer-emitted manifest (emitNodeCreate spreads it for work_items).
    crdtEmitNodeCreate(item)
    window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
    // DEC-144: push now, not at the next 20s poll.
    nudgeSync()
    return item
  },
  updateFields: async (id, patch) => {
    const item = await window.api.workItems.updateFields(id, patch)
    if (item) {
      set({ items: get().items.map((i) => (i.id === id ? item : i)) })
      if (item.kind === 'task') {
        // DEC-144: a desk task edited in Focus syncs in the task's vocabulary
        // (description, dueDate) — the same registers the desk's own editor
        // emits — and the desk surfaces re-read it, so both views agree.
        const { title, ...taskAttrs } = taskAttrsForItemPatch(patch) ?? {}
        if (title !== undefined) crdtEmitNodeTitle(id, title)
        if (Object.keys(taskAttrs).length) crdtEmitNodeAttrs(id, taskAttrs as Record<string, unknown>)
        // Lazy: the node store reads window at load, and this module is also
        // imported where there is no window (friendlyWorkItemError's tests).
        void import('./nodes').then((m) => m.useNodeStore.getState().refresh())
      } else {
        const attrs: Record<string, unknown> = {}
        // Each attr goes out in the form its column stores. assigneeIds comes
        // from the editor as an array; sent as one, a receiver bound it into
        // SQL as separate parameters (4.3.40: the assignee stored bare, so the
        // task never reached their Focus).
        for (const [k, v] of Object.entries(patch))
          if (EMITTED_ATTRS.has(k)) attrs[k] = k === 'assigneeIds' ? (normalizeAssigneeIds(v) ?? null) : v
        if (typeof patch.title === 'string') attrs.title = patch.title
        if (Object.keys(attrs).length) crdtEmitNodeAttrs(id, attrs)
      }
      window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
      // DEC-144: push now, not at the next 20s poll — a team guest has no
      // live channel, so the poll path is how their change reaches the team.
      nudgeSync()
    }
    return item
  },
  setState: async (id, state) => {
    const ok = await window.api.workItems.setState(id, state)
    if (ok) {
      const fresh = await window.api.workItems.get(id)
      if (fresh) set({ items: get().items.map((i) => (i.id === id ? fresh : i)) })
      // Only workItemState rides the wire — the receiver recomputes its own
      // status projection (§2.3 F012); status itself is never emitted.
      crdtEmitNodeAttrs(id, { workItemState: state })
      window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
      // DEC-144: push now, not at the next 20s poll — a team guest has no
      // live channel, so the poll path is how their change reaches the team.
      nudgeSync()
    }
    return ok
  },
  reclassify: async (id, intentClass) => {
    const item = await window.api.workItems.reclassify(id, intentClass)
    if (item) {
      set({ items: get().items.map((i) => (i.id === id ? item : i)) })
      crdtEmitNodeAttrs(id, { intentClass })
      window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
      // DEC-144: push now, not at the next 20s poll — a team guest has no
      // live channel, so the poll path is how their change reaches the team.
      nudgeSync()
    }
    return item
  },
  snooze: async (id, until) => {
    await window.api.workItems.snooze(id, until) // device-local — no emit
  },
  markRead: async (id) => {
    await window.api.workItems.markRead(id) // device-local — no emit
  }
}))

// Thin handle for debugging + e2e (same convention as __fbNodes): the real
// store, not a mock. Changes nothing about user behaviour.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbWorkItems?: typeof useWorkItemStore }).__fbWorkItems = useWorkItemStore
}
