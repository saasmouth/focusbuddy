import { create } from 'zustand'
import type { FbNode } from '@shared/types'
import { WORK_ITEM_COLUMNS } from '@shared/workItems'
import { crdtEmitNodeCreate, crdtEmitNodeAttrs } from '../lib/crdtBridge'

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
 * The Attention layer is a per-device opt-in that ships OFF, so a create can
 * legitimately be refused — but what reached the user was the raw rejection:
 *
 *   Error invoking remote method 'workItems:create': Error: Work items are
 *   not enabled.
 *
 * That names an IPC channel and a flag, and says nothing about the switch in
 * Settings that turns it on, so the only honest reading of it is "the app is
 * broken". Every work-items write can be refused the same three ways, so the
 * translation lives here rather than at each call site.
 *
 * Deliberately matched on the message text, not on a pre-flight capability
 * check. workItemsEnabled() is probed asynchronously at load, so it reads
 * false for a moment at boot and would refuse a create that the main process
 * would have accepted. The main process is the authority on its own gate.
 */
export function friendlyWorkItemError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e)
  if (/not enabled/i.test(raw))
    return new Error(
      'The Attention layer is turned off, so there is nowhere to file this. Turn it on in Settings under Attention, then try again.'
    )
  if (/has not migrated/i.test(raw))
    return new Error(
      'This device has not finished preparing for Attention items yet. Restart Plexii and try again.'
    )
  if (/personal/i.test(raw))
    return new Error(
      'Attention items stay on this device until every member of the shared workspace is ready for them, so this one cannot be filed to a shared space yet.'
    )
  return e instanceof Error ? e : new Error(raw)
}

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
    return item
  },
  updateFields: async (id, patch) => {
    const item = await window.api.workItems.updateFields(id, patch)
    if (item) {
      set({ items: get().items.map((i) => (i.id === id ? item : i)) })
      const attrs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(patch)) if (EMITTED_ATTRS.has(k)) attrs[k] = v
      if (typeof patch.title === 'string') attrs.title = patch.title
      if (Object.keys(attrs).length) crdtEmitNodeAttrs(id, attrs)
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
