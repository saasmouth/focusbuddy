import { create } from 'zustand'
import {
  linkModesFor,
  snippetMatches,
  targetAccepts,
  type Snippet,
  type SnippetDraft,
  type SnippetInsertResult,
  type SnippetLink,
  type SnippetPatch,
  type SnippetQuery,
  type SnippetTarget
} from '@shared/snippets'
import { announceConverted } from '../lib/convertedNotice'

// The saved-snippets store: the library the user reads, plus the registry of
// places a snippet can currently go.
//
// The registry is renderer state rather than anything persisted, because a
// target is a mounted surface. A document that is open can take a doc snippet;
// the same document closed cannot. Registering on mount and withdrawing on
// unmount means the picker offers exactly what is really on screen, so the user
// is never offered a destination that would quietly do nothing.
//
// Insertion delegates to the target. The target returns false when it declined
// — a sheet with no selection, a read-only document — and this store reports
// that refusal rather than counting a use that did not happen.

export interface SnippetsState {
  snippets: Snippet[]
  loading: boolean
  /** The last error from a write, for the surface to show. Cleared on success. */
  error: string | null
  /** The last insert's conversion line ("It becomes a picture: edit it in PlexiiDraw."), null when it landed as itself. */
  notice: string | null
  /** Mounted insertion targets, keyed by SnippetTarget.id. */
  targets: Record<string, SnippetTarget>

  refresh: (query?: SnippetQuery) => Promise<void>
  save: (draft: SnippetDraft) => Promise<Snippet | null>
  update: (id: string, patch: SnippetPatch) => Promise<Snippet | null>
  remove: (id: string) => Promise<boolean>
  /** Copy an org snippet into the personal library so it can be changed freely. */
  fork: (id: string) => Promise<Snippet | null>

  registerTarget: (target: SnippetTarget) => void
  unregisterTarget: (id: string) => void
  /** Targets that can take this snippet right now. */
  targetsFor: (snippet: Snippet) => SnippetTarget[]

  /**
   * Insert a snippet into a target. Returns true only when the target actually
   * took it; a use is counted only then.
   */
  insert: (snippet: Snippet, link: SnippetLink, targetId: string) => Promise<boolean>

  /** Client-side filter over the loaded list, using the shared matcher. */
  filter: (query: SnippetQuery) => Snippet[]
}

export const useSnippetsStore = create<SnippetsState>((set, get) => ({
  snippets: [],
  loading: false,
  error: null,
  notice: null,
  targets: {},

  refresh: async (query) => {
    set({ loading: true })
    try {
      const snippets = await window.api.snippets.list(query)
      set({ snippets, loading: false, error: null })
    } catch (e) {
      // An unreadable library is reported as empty-and-errored, never as an
      // empty library that looks fine.
      set({ loading: false, error: (e as Error).message || 'The snippet library could not be read.' })
    }
  },

  save: async (draft) => {
    const res = await window.api.snippets.create(draft)
    if (!res.ok || !res.snippet) {
      set({ error: res.error ?? 'The snippet could not be saved.' })
      return null
    }
    set((s) => ({ snippets: [res.snippet!, ...s.snippets], error: null }))
    return res.snippet
  },

  update: async (id, patch) => {
    const res = await window.api.snippets.update(id, patch)
    if (!res.ok || !res.snippet) {
      set({ error: res.error ?? 'The snippet could not be updated.' })
      return null
    }
    set((s) => ({
      snippets: s.snippets.map((x) => (x.id === res.snippet!.id ? res.snippet! : x)),
      error: null
    }))
    // Every live instance of this snippet, in every open host, re-resolves now.
    // Without this an edit would reach only instances mounted after it, so a
    // second copy in the same document — or the same document in another pane —
    // would sit there showing the old text while claiming to be live.
    notifySnippetChanged(res.snippet.id)
    return res.snippet
  },

  remove: async (id) => {
    const res = await window.api.snippets.delete(id)
    if (!res.ok) {
      set({ error: res.error ?? 'The snippet could not be deleted.' })
      return false
    }
    set((s) => ({ snippets: s.snippets.filter((x) => x.id !== id), error: null }))
    return true
  },

  fork: async (id) => {
    const res = await window.api.snippets.fork(id)
    if (!res.ok || !res.snippet) {
      set({ error: res.error ?? 'The snippet could not be copied.' })
      return null
    }
    set((s) => ({ snippets: [res.snippet!, ...s.snippets], error: null }))
    return res.snippet
  },

  registerTarget: (target) => set((s) => ({ targets: { ...s.targets, [target.id]: target } })),

  unregisterTarget: (id) =>
    set((s) => {
      if (!(id in s.targets)) return s
      const next = { ...s.targets }
      delete next[id]
      return { targets: next }
    }),

  targetsFor: (snippet) => Object.values(get().targets).filter((t) => targetAccepts(t, snippet)),

  insert: async (snippet, link, targetId) => {
    const target = get().targets[targetId]
    if (!target) {
      set({ error: 'That place is no longer open.' })
      return false
    }
    if (!linkModesFor(target, snippet.kind).includes(link)) {
      set({ error: `${target.label} cannot take a ${link} snippet.` })
      return false
    }
    if (!target.accepts.includes(snippet.kind)) {
      set({ error: `${target.label} cannot take a ${snippet.kind} snippet.` })
      return false
    }
    let outcome: SnippetInsertResult = false
    try {
      outcome = await target.insert(snippet, link)
    } catch (e) {
      set({ error: (e as Error).message || 'The snippet could not be inserted.' })
      return false
    }
    const took = outcome === true || (typeof outcome === 'object' && outcome.ok === true)
    if (!took) {
      // The surface declined. A target that knows WHY says so — which cell a
      // formula would have pointed off-sheet, which merge the block would have
      // split — and that reason reaches the user verbatim rather than being
      // flattened into a generic message it cannot act on.
      const reason = typeof outcome === 'object' && !outcome.ok && outcome.reason ? outcome.reason : null
      set({ error: reason ?? `${target.label} did not take the snippet.`, notice: null })
      return false
    }
    // A converted insert says so, in one plain line, after the library closes.
    const notice = typeof outcome === 'object' && outcome.ok ? (outcome.notice ?? null) : null
    set({ error: null, notice })
    announceConverted(notice)
    // Counted only on a real insertion, so usage figures mean something.
    void window.api.snippets.recordUse(snippet.id).catch(() => undefined)
    set((s) => ({
      snippets: s.snippets.map((x) => (x.id === snippet.id ? { ...x, usageCount: x.usageCount + 1 } : x))
    }))
    return true
  },

  filter: (query) => get().snippets.filter((s) => snippetMatches(s, query))
}))

/**
 * Register an insertion target for as long as a surface is mounted.
 *
 * Call from a `useEffect` whose deps include everything the target's `insert`
 * closes over, so the registry never holds a stale closure writing into a
 * document that has since been replaced.
 */
export function registerSnippetTarget(target: SnippetTarget): () => void {
  useSnippetsStore.getState().registerTarget(target)
  return () => useSnippetsStore.getState().unregisterTarget(target.id)
}


// ── Live-instance invalidation ───────────────────────────────────────────────
//
// A live instance resolves its master when it mounts. That is enough for a host
// opened AFTER an edit, and not enough for one already on screen: the owner's
// feature edits the master from inside a placed instance, so the instance beside
// it must change too, immediately, or "changes appear everywhere it's used" is
// a claim the UI does not honour.
//
// Deliberately a tiny id-keyed registry rather than the store's `snippets` list:
// that list holds only what the library last loaded, and an embedded master is
// very often not in it. Listeners re-resolve through the IPC, so the DB stays
// the single source of truth and no copy of the body lives here.

const changeListeners = new Map<string, Set<() => void>>()

/** Re-run `onChange` whenever this snippet's master is edited. Returns an unsubscribe. */
export function onSnippetChanged(id: string, onChange: () => void): () => void {
  let set = changeListeners.get(id)
  if (!set) {
    set = new Set()
    changeListeners.set(id, set)
  }
  set.add(onChange)
  return () => {
    const current = changeListeners.get(id)
    if (!current) return
    current.delete(onChange)
    if (current.size === 0) changeListeners.delete(id)
  }
}

/** Tell every live instance of this snippet to resolve again. */
export function notifySnippetChanged(id: string): void {
  for (const cb of changeListeners.get(id) ?? []) cb()
}

// The authoritative source of these notifications is the MAIN process, which
// announces every successful write wherever it came from — the store, a direct
// window.api call, or workspace sync once it carries snippets. Subscribing once
// here and fanning out locally means an instance needs no IPC listener of its
// own, and no writer has to remember to tell anyone.
//
// Guarded because the renderer store is also loaded by unit tests, where there
// is no preload bridge; the local notify path still works there.
if (typeof window !== 'undefined' && window.api?.snippets?.onChanged) {
  window.api.snippets.onChanged((id) => notifySnippetChanged(id))
}
