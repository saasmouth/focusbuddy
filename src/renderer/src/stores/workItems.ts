import { create } from 'zustand'
import type { FbNode } from '@shared/types'
import { WORK_ITEM_COLUMNS } from '@shared/workItems'
import { crdtEmitNodeCreate, crdtEmitNodeAttrs, crdtEmitNodeTitle } from '../lib/crdtBridge'
import { taskAttrsForItemPatch } from '@shared/attentionProjection'
import { useNodeStore } from './nodes'

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

export const useWorkItemStore = create<WorkItemStore>((set, get) => ({
  items: [],
  loaded: false,
  refresh: async () => {
    try {
      const items = await window.api.workItems.list()
      set({ items, loaded: true })
    } catch {
      /* un-migrated / early boot — keep what we have */
    }
  },
  create: async (draft) => {
    const item = await window.api.workItems.create(draft)
    set({ items: [item, ...get().items] })
    // Live-path producer contract (§3): the create snapshot carries the full
    // renderer-emitted manifest (emitNodeCreate spreads it for work_items).
    crdtEmitNodeCreate(item)
    window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
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
        void useNodeStore.getState().refresh()
      } else {
        const attrs: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(patch)) if (EMITTED_ATTRS.has(k)) attrs[k] = v
        if (typeof patch.title === 'string') attrs.title = patch.title
        if (Object.keys(attrs).length) crdtEmitNodeAttrs(id, attrs)
      }
      window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
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
    }
    return ok
  },
  reclassify: async (id, intentClass) => {
    const item = await window.api.workItems.reclassify(id, intentClass)
    if (item) {
      set({ items: get().items.map((i) => (i.id === id ? item : i)) })
      crdtEmitNodeAttrs(id, { intentClass })
      window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
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
