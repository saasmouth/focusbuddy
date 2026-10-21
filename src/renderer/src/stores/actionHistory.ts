import { create } from 'zustand'

// One unified undo/redo timeline for structural workspace actions — creating,
// deleting, moving, renaming, resizing, recolouring, linking tasks, folders and
// widgets. It is deliberately SEPARATE from text editing (inputs, the doc/sheet/
// slides/files editors keep their own per-character undo) and from irreversible
// outbound actions (sending mail/chat), which use confirms instead.
//
// Each entry carries its own inverse (undo) and replay (redo) as closures, so
// the stores that mutate via IPC just describe how to reverse themselves. Undo
// runs the inverse and pushes the entry onto the redo stack; a fresh action
// clears redo. A short label drives the "Undid X" / "Deleted — Undo" toast.

export interface HistoryEntry {
  /** Names the step: the undo/redo toasts read "Undid <label>". */
  label: string
  /** What the action toast says right after it happened, when that should
   *  read differently from the step's name ("Removed “Plan” from this desk"
   *  for the step "Remove “Plan” from this desk"). Defaults to `label`. */
  toast?: string
  /** The action toast's icon (default: delete, the common case). */
  toastIcon?: string
  /** A second button on the action toast beside Undo, e.g. "Open desk". */
  toastAction?: { label: string; run: () => void }
  undo: () => Promise<void> | void
  redo: () => Promise<void> | void
}

interface ActionHistoryStore {
  past: HistoryEntry[]
  future: HistoryEntry[]
  busy: boolean
  toast: { kind: 'undo' | 'redo' | 'action'; label: string; entry?: HistoryEntry } | null

  record: (entry: HistoryEntry) => void
  /** Record an action AND surface a toast offering to undo it (for deletes). */
  recordWithToast: (entry: HistoryEntry) => void
  /** Group everything recorded until endBatch into ONE undo entry (e.g. an AI
   *  "Apply all" that touches many widgets reverses with a single Cmd-Z). */
  beginBatch: () => void
  endBatch: (label: string, toast?: string) => void
  undo: () => Promise<void>
  redo: () => Promise<void>
  clear: () => void
  dismissToast: () => void
}

const MAX = 100

// Batch state (module-level): while depth > 0, record()/recordWithToast() buffer
// their entries instead of pushing, and endBatch collapses them into one.
let batchDepth = 0
let batchBuffer: HistoryEntry[] = []
let batchHadToast = false

export const useActionHistory = create<ActionHistoryStore>((set, get) => ({
  past: [],
  future: [],
  busy: false,
  toast: null,

  record: (entry) => {
    if (batchDepth > 0) {
      batchBuffer.push(entry)
      return
    }
    set({ past: [...get().past, entry].slice(-MAX), future: [] })
  },

  recordWithToast: (entry) => {
    if (batchDepth > 0) {
      batchBuffer.push(entry)
      batchHadToast = true
      return
    }
    set({
      past: [...get().past, entry].slice(-MAX),
      future: [],
      toast: { kind: 'action', label: entry.toast ?? entry.label, entry }
    })
  },

  beginBatch: () => {
    batchDepth += 1
  },

  endBatch: (label, toast) => {
    batchDepth = Math.max(0, batchDepth - 1)
    if (batchDepth > 0) return // still inside an outer batch
    const entries = batchBuffer
    const hadToast = batchHadToast
    batchBuffer = []
    batchHadToast = false
    if (entries.length === 0) return
    // One combined entry: undo runs the parts in reverse, redo forward.
    const combined: HistoryEntry = {
      label,
      ...(toast ? { toast } : {}),
      undo: async () => {
        for (let i = entries.length - 1; i >= 0; i--) await entries[i].undo()
      },
      redo: async () => {
        for (const e of entries) await e.redo()
      }
    }
    set({
      past: [...get().past, combined].slice(-MAX),
      future: [],
      toast: hadToast ? { kind: 'action', label: toast ?? label, entry: combined } : get().toast
    })
  },

  undo: async () => {
    if (get().busy) return
    const past = get().past
    const entry = past[past.length - 1]
    if (!entry) return
    set({ busy: true, past: past.slice(0, -1) })
    try {
      await entry.undo()
      set({ future: [...get().future, entry], toast: { kind: 'undo', label: entry.label } })
    } finally {
      set({ busy: false })
    }
  },

  redo: async () => {
    if (get().busy) return
    const future = get().future
    const entry = future[future.length - 1]
    if (!entry) return
    set({ busy: true, future: future.slice(0, -1) })
    try {
      await entry.redo()
      set({ past: [...get().past, entry], toast: { kind: 'redo', label: entry.label } })
    } finally {
      set({ busy: false })
    }
  },

  clear: () => set({ past: [], future: [], toast: null }),
  dismissToast: () => set({ toast: null })
}))

// Convenience for stores: push an inverse action onto the timeline.
export function recordAction(entry: HistoryEntry): void {
  useActionHistory.getState().record(entry)
}
export function recordActionWithToast(entry: HistoryEntry): void {
  useActionHistory.getState().recordWithToast(entry)
}
