import { create } from 'zustand'
import type { MailTag, MailTagDraft, MailTagPatch } from '@shared/types'

// The user's mail tags.
//
// Held apart from the mail store because a tag outlives any particular
// mailbox fetch: tags are the user's own structure and survive a refresh, a
// reconnect, or having no mail account at all. The mail store holds messages;
// this holds how the user wants to look at them.
//
// `selected` is a VIEW selection, not a property of any tag, so it lives
// here rather than being written to the database: which tag you are looking
// at is not a thing to persist across machines.

/** What the mail list is currently showing. */
export type MailScope =
  | { kind: 'inbox' }
  /** Only what no tag claimed -- the pile that actually needs attention. */
  | { kind: 'unsorted' }
  | { kind: 'tag'; id: string }

interface MailTagStore {
  tags: MailTag[]
  loaded: boolean
  error: string | null
  scope: MailScope

  refresh: () => Promise<void>
  create: (draft: MailTagDraft) => Promise<MailTag | null>
  update: (id: string, patch: MailTagPatch) => Promise<void>
  remove: (id: string) => Promise<void>
  pin: (id: string, uid: number) => Promise<void>
  exclude: (id: string, uid: number) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  setScope: (scope: MailScope) => void
}

/** The tag currently being viewed, or null when looking at the whole inbox. */
export const selectActiveTag = (s: MailTagStore): MailTag | null => {
  const scope = s.scope
  if (scope.kind !== 'tag') return null
  return s.tags.find((f) => f.id === scope.id) ?? null
}

export const useMailTagStore = create<MailTagStore>((set, get) => ({
  tags: [],
  loaded: false,
  error: null,
  scope: { kind: 'inbox' },

  refresh: async () => {
    try {
      const tags = await window.api.mailTags.list()
      set({ tags, loaded: true, error: null })
    } catch (err) {
      // An IPC can reject as well as answer badly. Tags the user already has
      // on screen stay there: losing the list would look like losing the
      // tags themselves.
      set({
        loaded: true,
        error: err instanceof Error ? err.message : 'Could not load your tags.'
      })
    }
  },

  create: async (draft) => {
    try {
      const tag = await window.api.mailTags.create(draft)
      set((s) => ({ tags: [...s.tags, tag], error: null }))
      return tag
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not create that tag.' })
      return null
    }
  },

  update: async (id, patch) => {
    // Optimistic, because editing a rule should feel like typing, not like
    // saving. A failure puts the old tag back and says why.
    const before = get().tags
    set({
      tags: before.map((f) => (f.id === id ? { ...f, ...patch, rules: patch.rules ?? f.rules } : f))
    })
    try {
      const updated = await window.api.mailTags.update(id, patch)
      if (updated) set((s) => ({ tags: s.tags.map((f) => (f.id === id ? updated : f)) }))
    } catch (err) {
      set({
        tags: before,
        error: err instanceof Error ? err.message : 'Could not save that change.'
      })
    }
  },

  remove: async (id) => {
    const before = get().tags
    // Deleting a tag deletes a view; no mail moves, so this needs no
    // confirmation and can be optimistic.
    set((s) => ({
      tags: s.tags.filter((f) => f.id !== id),
      // Stop showing a tag that is no longer there.
      scope: s.scope.kind === 'tag' && s.scope.id === id ? { kind: 'inbox' } : s.scope
    }))
    try {
      await window.api.mailTags.remove(id)
    } catch (err) {
      set({
        tags: before,
        error: err instanceof Error ? err.message : 'Could not delete that tag.'
      })
    }
  },

  pin: async (id, uid) => {
    try {
      const updated = await window.api.mailTags.pin(id, uid)
      if (updated) set((s) => ({ tags: s.tags.map((f) => (f.id === id ? updated : f)) }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not file that message.' })
    }
  },

  exclude: async (id, uid) => {
    try {
      const updated = await window.api.mailTags.exclude(id, uid)
      if (updated) set((s) => ({ tags: s.tags.map((f) => (f.id === id ? updated : f)) }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not remove that message.' })
    }
  },

  reorder: async (ids) => {
    const before = get().tags
    const byId = new Map(before.map((f) => [f.id, f]))
    set({ tags: ids.map((id) => byId.get(id)).filter((f): f is MailTag => !!f) })
    try {
      const tags = await window.api.mailTags.reorder(ids)
      set({ tags })
    } catch (err) {
      set({ tags: before, error: err instanceof Error ? err.message : 'Could not reorder.' })
    }
  },

  setScope: (scope) => set({ scope })
}))

// Thin handle for debugging + e2e (same convention as __fbView/__fbMail).
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbMailTags?: typeof useMailTagStore }).__fbMailTags =
    useMailTagStore
}
