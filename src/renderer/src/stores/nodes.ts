import { create } from 'zustand'
import type { FbNode, NodeDraft, NodePatch } from '@shared/types'
import { recordAction, recordActionWithToast } from './actionHistory'
import { recordTrail } from '../lib/trail'
import { nudgeSync } from '../lib/syncNudge'
import {
  crdtEmitNodeTitle,
  crdtEmitNodeParent,
  crdtEmitNodeCreate,
  crdtEmitNodeDelete,
  crdtEmitNodeAttrs
} from '../lib/crdtBridge'
import { taskComplete } from '../lib/audioBeep'
import { hapticSuccess } from '../lib/haptics'
import { canCreateMore, limitFor } from '../lib/gating'
import { useCapabilityStore } from './capabilities'
import { promptUpgrade } from './upgradePrompt'
import { useMessagingStore } from './messaging'
import { useContextHealthStore } from './contextHealth'

// The multiple_desks capability caps how many DESKS a tier may have. Thrown by
// create() when a free user would exceed it — callers that don't catch it
// simply have the creation prevented (the throw happens before the IPC
// create call, so nothing is persisted).
export const DESK_LIMIT_ERROR = 'DESK_LIMIT_REACHED'

// A DESK is a top-level TASK. A top-level FOLDER is a ROOM, and rooms are not
// capped (owner, 2026-10-24).
//
// This read `kind === 'folder'` and was right when it was written: a "desk"
// used to be the top-level folder the sidebar called a project. The Rooms/Desks
// rename moved the words under it — see archiveObjectChannel below, which
// sends `kind === 'folder' ? 'room' : 'desk'` — while Sidebar.requestCreateDesk
// creates kind: 'task'. So the cap stopped firing on the only path people use
// to make a desk, and started refusing a fourth ROOM with a message about
// desks. Exported because a paid boundary should fail loudly in a test rather
// than quietly in production.
export function isTopLevelDesk(draft: Pick<NodeDraft, 'parentId' | 'kind'>): boolean {
  return draft.parentId === null && draft.kind === 'task'
}

export function countTopLevelDesks(nodes: ReadonlyArray<Pick<FbNode, 'parentId' | 'kind'>>): number {
  return nodes.filter((n) => n.parentId === null && n.kind === 'task').length
}

interface NodeStore {
  nodes: FbNode[]
  activeTaskId: string | null
  expanded: Record<string, boolean>
  loading: boolean
  // Whether a load has ever succeeded, and the last load error if any. These let
  // the UI tell three states apart that used to look identical: still loading, a
  // genuinely empty workspace, and a load that FAILED. Conflating the last two is
  // how a transient failure could read as "all my workspaces disappeared".
  loaded: boolean
  error: string | null
  refresh: () => Promise<void>
  create: (draft: NodeDraft) => Promise<FbNode>
  update: (id: string, patch: NodePatch) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Bulk trash (DEC-022): several roots, one emit + one undo toast. */
  removeMany: (rootIds: string[]) => Promise<void>
  // Atomic reparent + reorder. beforeId=null appends to end of new parent.
  move: (id: string, newParentId: string | null, beforeId: string | null) => Promise<void>
  // Share a personal room/desk (and everything under it) with an org, optionally
  // scoped to a single team/group. Re-scopes the subtree + its widgets/tables so
  // the org sync loop pushes it to the org (or just that group's members).
  moveToOrg: (id: string, orgId: string, teamId?: string | null) => Promise<string[]>
  setActive: (id: string | null) => void
  toggleExpand: (id: string) => void
  expand: (id: string, on: boolean) => void
}

export const useNodeStore = create<NodeStore>((set, get) => ({
  nodes: [],
  activeTaskId: null,
  expanded: {},
  loading: false,
  loaded: false,
  error: null,
  refresh: async () => {
    set({ loading: true })
    // Loading the workspace tree must never fail silently into an empty state that
    // looks like lost data. A transient DB lock (e.g. another installed build
    // briefly holding the database at boot) can make the first call reject, so we
    // retry with a short backoff. On real failure we KEEP whatever nodes we already
    // had and record an honest error the sidebar surfaces, rather than blanking the
    // tree.
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const nodes = await window.api.nodes.list()
        set({ nodes, loading: false, loaded: true, error: null })
        return
      } catch (e) {
        if (attempt === MAX_ATTEMPTS) {
          set({
            loading: false,
            error: e instanceof Error ? e.message : String(e)
          })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 300))
      }
    }
  },
  create: async (draft) => {
    // THE desk limit — this is the only place it is enforced. The comment here
    // used to say the sidebar additionally gated its own trigger "for nicer
    // UX"; it does not (no multiple_desks check anywhere in Sidebar.tsx), so
    // every create path reaches this and nothing pre-empts it.
    //
    // Only CREATION is gated. Someone who is already over the limit keeps
    // every desk they have and can still open them; they simply cannot make
    // another (owner's ruling, 2026-10-24).
    if (isTopLevelDesk(draft)) {
      const caps = useCapabilityStore.getState().capabilities
      const deskCount = countTopLevelDesks(get().nodes)
      if (!canCreateMore(caps, 'multiple_desks', deskCount)) {
        const limit = limitFor(caps, 'multiple_desks')
        promptUpgrade(
          `You've reached your ${limit}-desk limit on the Free plan. Upgrade for unlimited desks.`,
          'pro'
        )
        throw new Error(DESK_LIMIT_ERROR)
      }
    }
    const node = await window.api.nodes.create(draft)
    set({ nodes: [...get().nodes, node] })
    nudgeSync()
    // WS01 sync substrate (flagged): emit the create so the node materialises on
    // other devices with the same id. No-op until the engine registers.
    crdtEmitNodeCreate(node)
    if (draft.parentId) set({ expanded: { ...get().expanded, [draft.parentId]: true } })
    // Undo a creation by trashing it; redo restores exactly what was trashed
    // (it may have gained children by the time you undo).
    let trashed: string[] = [node.id]
    recordAction({
      label: `Create ${node.kind}`,
      undo: async () => {
        trashed = await window.api.nodes.delete(node.id)
        await get().refresh()
      },
      redo: async () => {
        await window.api.nodes.restore(trashed)
        await get().refresh()
      }
    })
    return node
  },
  update: async (id, patch) => {
    const prev = get().nodes.find((n) => n.id === id) ?? null
    const updated = await window.api.nodes.update(id, patch)
    // DEC-052 Track D (#7) — a desk marked done is a QUIET WIN: it feeds the
    // ledger for analytics ("counted from the work, not the checkboxes") and
    // never prompts (closing a desk already ran its own offers).
    if (patch.status === 'done') {
      const closing = get().nodes.find((n) => n.id === id)
      if (closing?.kind === 'task' && closing.status !== 'done') {
        void window.api.signals
          .record({ kind: 'desk_closed', targetKind: 'desk', targetRef: id })
          .catch(() => {})
      }
    }
    if (!updated) return
    set({ nodes: get().nodes.map((n) => (n.id === id ? updated : n)) })
    nudgeSync()
    // WS01 sync substrate (flagged, off by default): mirror a title or parent change
    // into the one CRDT change log. No-ops until the engine registers (flag on).
    if (patch.title !== undefined) crdtEmitNodeTitle(id, updated.title)
    if ('parentId' in patch) crdtEmitNodeParent(id, patch.parentId ?? null)
    // The node's scalar attributes (status/priority/dueDate/etc.) as generic 'attr'
    // LWW registers. The engine filters to the fields it carries; ordering + resume
    // text stay on the poll. No-op until the engine registers.
    crdtEmitNodeAttrs(id, patch as unknown as Record<string, unknown>)
    // Record an undo only for user-meaningful field edits (not programmatic
    // patches like resume autosave or timers), restoring the prior values.
    const UNDOABLE = ['title', 'description', 'status', 'priority', 'interest', 'importance', 'dueDate'] as const
    const touched = UNDOABLE.filter((k) => k in patch)
    if (prev && touched.length) {
      const prevPatch: NodePatch = {}
      const redoPatch: NodePatch = {}
      for (const k of touched) {
        ;(prevPatch as Record<string, unknown>)[k] = (prev as unknown as Record<string, unknown>)[k]
        ;(redoPatch as Record<string, unknown>)[k] = (patch as unknown as Record<string, unknown>)[k]
      }
      const label = touched.includes('title')
        ? `Rename ${prev.kind}`
        : touched.includes('status')
          ? 'Change status'
          : 'Edit'
      recordAction({
        label,
        undo: async () => {
          await window.api.nodes.update(id, prevPatch)
          await get().refresh()
        },
        redo: async () => {
          await window.api.nodes.update(id, redoPatch)
          await get().refresh()
        }
      })
    }
    // Triumphant chime on task completion — fire only on the open→done transition
    if (
      prev &&
      prev.kind === 'task' &&
      prev.status !== 'done' &&
      updated.status === 'done'
    ) {
      taskComplete()
      hapticSuccess()
    }
  },
  remove: async (id) => {
    const target = get().nodes.find((n) => n.id === id)
    const ids = await window.api.nodes.delete(id)
    // WS01 sync substrate (flagged): tombstone every removed id (a folder delete
    // cascades to its descendants) so the removal converges on other devices. Emit
    // BEFORE pruning the store so the engine can still resolve each node's shared
    // root (shared-desk deletes must route to the desk partition, not the account).
    crdtEmitNodeDelete(ids)
    set({
      nodes: get().nodes.filter((n) => !ids.includes(n.id)),
      activeTaskId: ids.includes(get().activeTaskId ?? '') ? null : get().activeTaskId
    })
    nudgeSync()
    // Best-effort: archive the deleted room/desk's chat channel (keeps history,
    // hides it from lists). No-op if the object never had a channel.
    if (target) {
      void useMessagingStore
        .getState()
        .archiveObjectChannel(target.kind === 'folder' ? 'room' : 'desk', id)
    }
    if (ids.length) {
      recordActionWithToast({
        label: `Delete ${target?.kind ?? 'item'}${target?.title ? ` “${target.title}”` : ''}`,
        undo: async () => {
          await window.api.nodes.restore(ids)
          await get().refresh()
        },
        redo: async () => {
          await window.api.nodes.delete(id)
          await get().refresh()
        }
      })
    }
  },
  removeMany: async (rootIds) => {
    // DEC-022 bulk trash: the same contract as remove(), once — one tombstone
    // emit, one undo toast covering every subtree. Shared roots are the
    // caller's job to exclude (D1); the db layer refuses them anyway.
    const targets = get().nodes.filter((n) => rootIds.includes(n.id))
    const allIds: string[] = []
    for (const root of rootIds) {
      const ids = await window.api.nodes.delete(root)
      allIds.push(...ids)
    }
    if (!allIds.length) return
    crdtEmitNodeDelete(allIds)
    set({
      nodes: get().nodes.filter((n) => !allIds.includes(n.id)),
      activeTaskId: allIds.includes(get().activeTaskId ?? '') ? null : get().activeTaskId
    })
    nudgeSync()
    for (const t of targets) {
      void useMessagingStore
        .getState()
        .archiveObjectChannel(t.kind === 'folder' ? 'room' : 'desk', t.id)
    }
    recordActionWithToast({
      label: `Delete ${targets.length} item${targets.length === 1 ? '' : 's'}`,
      undo: async () => {
        await window.api.nodes.restore(allIds)
        await get().refresh()
      },
      redo: async () => {
        for (const root of rootIds) await window.api.nodes.delete(root)
        await get().refresh()
      }
    })
  },
  moveToOrg: async (id, orgId, teamId) => {
    const ids = await window.api.nodes.moveToOrg(id, orgId, teamId)
    if (!ids.length) return ids
    // The subtree left the active (personal) org; refresh drops it from this view.
    // It now belongs to the target org and appears when that org is active, and the
    // nudge pushes it to every member right away.
    await get().refresh()
    nudgeSync()
    return ids
  },
  move: async (id, newParentId, beforeId) => {
    // Capture the node's current slot so undo can put it back exactly.
    const before = get().nodes.find((n) => n.id === id)
    const prevParentId = before?.parentId ?? null
    const siblings = get()
      .nodes.filter((n) => n.parentId === prevParentId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    const idx = siblings.findIndex((n) => n.id === id)
    const prevBeforeId = idx >= 0 ? siblings[idx + 1]?.id ?? null : null
    const updated = await window.api.nodes.move(id, newParentId, beforeId)
    if (!updated) return // rejected (cycle or missing) — leave state untouched
    // Refresh from server so sort_order on every sibling is correct in one fetch
    const fresh = await window.api.nodes.list()
    set({ nodes: fresh })
    nudgeSync()
    // WS01 sync substrate (flagged): a reparent is a node 'parent' register change,
    // and the moved node's new rank is a 'sortOrder' attr register (LWW per item).
    // No-op until the engine registers (flag on).
    crdtEmitNodeParent(id, newParentId)
    const moved = fresh.find((n) => n.id === id)
    if (moved) crdtEmitNodeAttrs(id, { sortOrder: moved.sortOrder })
    // Auto-expand the destination parent so the moved node is visible after drop
    if (newParentId) set({ expanded: { ...get().expanded, [newParentId]: true } })
    if (prevParentId !== newParentId || prevBeforeId !== beforeId) {
      recordAction({
        label: 'Move',
        undo: async () => {
          await window.api.nodes.move(id, prevParentId, prevBeforeId)
          set({ nodes: await window.api.nodes.list() })
        },
        redo: async () => {
          await window.api.nodes.move(id, newParentId, beforeId)
          set({ nodes: await window.api.nodes.list() })
        }
      })
    }
  },
  setActive: (id) => {
    const prev = get().activeTaskId
    if (prev !== id) {
      const fromNode = prev ? get().nodes.find((n) => n.id === prev) : null
      const toNode = id ? get().nodes.find((n) => n.id === id) : null
      recordTrail('task_switched', id, {
        fromTaskId: prev,
        toTaskId: id,
        fromTitle: fromNode?.title ?? null,
        toTitle: toNode?.title ?? null
      })
    }
    set({ activeTaskId: id })
    // Opening a desk is the honest "I am now looking at this" signal: capture what
    // changed since last visit, mark it reviewed, and refresh related-desk health
    // so the header surfaces relations (plexi-4.0). Fire-and-forget; never blocks
    // navigation and degrades to a no-op if the endpoints are absent.
    if (id) void useContextHealthStore.getState().openDesk(id)
  },
  toggleExpand: (id) =>
    set({ expanded: { ...get().expanded, [id]: !get().expanded[id] } }),
  expand: (id, on) => set({ expanded: { ...get().expanded, [id]: on } })
}))

// Thin handle for debugging + e2e (same convention as __fbView/__fbWidgets): the
// real store, not a mock. Changes nothing about user behaviour.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbNodes?: typeof useNodeStore }).__fbNodes = useNodeStore
}
