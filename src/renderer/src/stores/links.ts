import { create } from 'zustand'
import type { WidgetLink, WireType } from '@shared/types'
import { recordAction } from './actionHistory'
import { crdtEmitLinkCreate, crdtEmitLinkDelete, crdtEmitLinkAttrs } from '../lib/crdtBridge'

// Spatial-link store. Mirrors the widgets store's per-task lifecycle:
// loadForTask wipes + fetches; clear empties on task switch. Optimistic
// updates so the SVG overlay redraws immediately without waiting for IPC.

interface LinksStore {
  links: WidgetLink[]
  loadingFor: string | null
  loadForTask: (taskId: string) => Promise<void>
  clear: () => void
  // Create a directed link from source → target. Returns the created link
  // (or the existing one if a same-direction duplicate is rejected). New wires
  // default to a passive 'context' type; pass a type to author the wire's
  // behaviour at creation time (used by the create-and-connect and intent
  // picker flows so the type decision happens at the moment of intent).
  create: (
    sourceId: string,
    targetId: string,
    taskId: string,
    type?: WireType
  ) => Promise<WidgetLink | null>
  // Update a wire's mutable fields (type / verb / enabled, plus durable run
  // state written by the wire engine). Optimistic.
  update: (
    id: string,
    patch: {
      type?: WidgetLink['type']
      verb?: string
      enabled?: boolean
      lastRunAt?: number | null
      lastError?: string | null
    }
  ) => Promise<void>
  remove: (id: string) => Promise<void>
  // Drop every link that references a widget id — called when a widget is
  // deleted. The DB cascade handles the persistence side; this just keeps
  // the local store in sync so the SVG layer doesn't render dangling lines
  // until the next loadForTask.
  pruneByWidget: (widgetId: string) => void
}

export const useLinksStore = create<LinksStore>((set, get) => ({
  links: [],
  loadingFor: null,
  loadForTask: async (taskId) => {
    set({ loadingFor: taskId, links: [] })
    const links = await window.api.widgetLinks.listByTask(taskId)
    // Guard against a second loadForTask kicking off while this one was
    // mid-flight — only commit if our taskId is still the one being loaded.
    if (get().loadingFor === taskId) {
      set({ links, loadingFor: null })
    }
  },
  clear: () => set({ links: [], loadingFor: null }),
  create: async (sourceId, targetId, taskId, type) => {
    if (sourceId === targetId) return null
    const created = await window.api.widgetLinks.create(sourceId, targetId, taskId, type)
    if (!created) return null
    // WS01 sync substrate (flagged): materialise the wire on the other grantees of a
    // shared desk. Emit even if we already have it locally (an echo is deduped by id
    // downstream), so a re-created link still propagates.
    crdtEmitLinkCreate(created)
    // Skip if we already have this link (e.g. server returned the existing
    // row because of UNIQUE conflict). Compare by id, not by endpoints —
    // the server is the source of truth for the canonical row.
    if (get().links.some((l) => l.id === created.id)) return created
    set({ links: [...get().links, created] })
    // Undo a newly-drawn connection (covers AI link-widgets applies too). Redo
    // re-creates it; the id may change, so track the live id for a later undo.
    let linkId = created.id
    recordAction({
      label: 'Connect work widgets',
      undo: async () => {
        await window.api.widgetLinks.delete(linkId)
        set({ links: get().links.filter((l) => l.id !== linkId) })
      },
      redo: async () => {
        const again = await window.api.widgetLinks.create(sourceId, targetId, taskId, type)
        if (again) {
          linkId = again.id
          if (!get().links.some((l) => l.id === again.id)) set({ links: [...get().links, again] })
        }
      }
    })
    return created
  },
  update: async (id, patch) => {
    // Optimistic — apply locally so the wire's badge / style updates at once.
    set({
      links: get().links.map((l) => (l.id === id ? { ...l, ...patch } : l))
    })
    // WS01 sync substrate (flagged): sync the behaviour fields (type/verb/enabled)
    // as LWW registers. Run-state (lastRunAt/lastError) is local engine output and
    // is deliberately NOT synced.
    const taskId = get().links.find((l) => l.id === id)?.taskId
    if (taskId && (patch.type !== undefined || patch.verb !== undefined || patch.enabled !== undefined)) {
      crdtEmitLinkAttrs(id, taskId, { type: patch.type, verb: patch.verb, enabled: patch.enabled })
    }
    const updated = await window.api.widgetLinks.update(id, patch)
    if (updated) {
      set({ links: get().links.map((l) => (l.id === id ? updated : l)) })
    }
  },
  remove: async (id) => {
    // WS01 sync substrate (flagged): tombstone the wire on other grantees. Resolve
    // the task id and emit BEFORE the optimistic prune, so the wire's shared root is
    // still known and the tombstone routes to the same partition its create did.
    const taskId = get().links.find((l) => l.id === id)?.taskId
    if (taskId) crdtEmitLinkDelete(id, taskId)
    // Optimistic — remove locally first so the line disappears immediately.
    set({ links: get().links.filter((l) => l.id !== id) })
    await window.api.widgetLinks.delete(id)
  },
  pruneByWidget: (widgetId) => {
    set({
      links: get().links.filter(
        (l) => l.sourceWidgetId !== widgetId && l.targetWidgetId !== widgetId
      )
    })
  }
}))

// Expose the links store on window so e2e specs can drive wire create/update/remove
// directly (the real store path, which emits the CRDT events). A thin handle to the
// real store, not a mock.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbLinks?: typeof useLinksStore }).__fbLinks = useLinksStore
}
