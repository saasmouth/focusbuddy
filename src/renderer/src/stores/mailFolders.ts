import { create } from 'zustand'
import type { MailFolder, MailFolderDraft, MailFolderPatch } from '@shared/types'

// The user's mail folders.
//
// Held apart from the mail store because a folder outlives any particular
// mailbox fetch: folders are the user's own structure and survive a refresh, a
// reconnect, or having no mail account at all. The mail store holds messages;
// this holds how the user wants to look at them.
//
// `selected` is a VIEW selection, not a property of any folder, so it lives
// here rather than being written to the database: which folder you are looking
// at is not a thing to persist across machines.

/** What the mail list is currently showing. */
export type MailScope =
  | { kind: 'inbox' }
  /** Only what no folder claimed -- the pile that actually needs attention. */
  | { kind: 'unsorted' }
  | { kind: 'folder'; id: string }

interface MailFolderStore {
  folders: MailFolder[]
  loaded: boolean
  error: string | null
  scope: MailScope

  refresh: () => Promise<void>
  create: (draft: MailFolderDraft) => Promise<MailFolder | null>
  update: (id: string, patch: MailFolderPatch) => Promise<void>
  remove: (id: string) => Promise<void>
  pin: (id: string, uid: number) => Promise<void>
  exclude: (id: string, uid: number) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  setScope: (scope: MailScope) => void
}

/** The folder currently being viewed, or null when looking at the whole inbox. */
export const selectActiveFolder = (s: MailFolderStore): MailFolder | null => {
  const scope = s.scope
  if (scope.kind !== 'folder') return null
  return s.folders.find((f) => f.id === scope.id) ?? null
}

export const useMailFolderStore = create<MailFolderStore>((set, get) => ({
  folders: [],
  loaded: false,
  error: null,
  scope: { kind: 'inbox' },

  refresh: async () => {
    try {
      const folders = await window.api.mailFolders.list()
      set({ folders, loaded: true, error: null })
    } catch (err) {
      // An IPC can reject as well as answer badly. Folders the user already has
      // on screen stay there: losing the list would look like losing the
      // folders themselves.
      set({
        loaded: true,
        error: err instanceof Error ? err.message : 'Could not load your folders.'
      })
    }
  },

  create: async (draft) => {
    try {
      const folder = await window.api.mailFolders.create(draft)
      set((s) => ({ folders: [...s.folders, folder], error: null }))
      return folder
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not create that folder.' })
      return null
    }
  },

  update: async (id, patch) => {
    // Optimistic, because editing a rule should feel like typing, not like
    // saving. A failure puts the old folder back and says why.
    const before = get().folders
    set({
      folders: before.map((f) => (f.id === id ? { ...f, ...patch, rules: patch.rules ?? f.rules } : f))
    })
    try {
      const updated = await window.api.mailFolders.update(id, patch)
      if (updated) set((s) => ({ folders: s.folders.map((f) => (f.id === id ? updated : f)) }))
    } catch (err) {
      set({
        folders: before,
        error: err instanceof Error ? err.message : 'Could not save that change.'
      })
    }
  },

  remove: async (id) => {
    const before = get().folders
    // Deleting a folder deletes a view; no mail moves, so this needs no
    // confirmation and can be optimistic.
    set((s) => ({
      folders: s.folders.filter((f) => f.id !== id),
      // Stop showing a folder that is no longer there.
      scope: s.scope.kind === 'folder' && s.scope.id === id ? { kind: 'inbox' } : s.scope
    }))
    try {
      await window.api.mailFolders.remove(id)
    } catch (err) {
      set({
        folders: before,
        error: err instanceof Error ? err.message : 'Could not delete that folder.'
      })
    }
  },

  pin: async (id, uid) => {
    try {
      const updated = await window.api.mailFolders.pin(id, uid)
      if (updated) set((s) => ({ folders: s.folders.map((f) => (f.id === id ? updated : f)) }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not file that message.' })
    }
  },

  exclude: async (id, uid) => {
    try {
      const updated = await window.api.mailFolders.exclude(id, uid)
      if (updated) set((s) => ({ folders: s.folders.map((f) => (f.id === id ? updated : f)) }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not remove that message.' })
    }
  },

  reorder: async (ids) => {
    const before = get().folders
    const byId = new Map(before.map((f) => [f.id, f]))
    set({ folders: ids.map((id) => byId.get(id)).filter((f): f is MailFolder => !!f) })
    try {
      const folders = await window.api.mailFolders.reorder(ids)
      set({ folders })
    } catch (err) {
      set({ folders: before, error: err instanceof Error ? err.message : 'Could not reorder.' })
    }
  },

  setScope: (scope) => set({ scope })
}))

// Thin handle for debugging + e2e (same convention as __fbView/__fbMail).
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbMailFolders?: typeof useMailFolderStore }).__fbMailFolders =
    useMailFolderStore
}
