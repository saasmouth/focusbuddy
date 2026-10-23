import { create } from 'zustand'

// Which snippet, if any, is currently open as a session.
//
// Deliberately a module of its own, with no component imports. The opener is
// called from SnippetEmbedNode, and SnippetEmbedNode is registered by
// buildDocExtensions, which SnippetEditSessionView reaches through
// SnippetDocSurface. Keeping the store here means the embed can open a session
// without importing the session — so the document extensions don't pull the
// whole session (and PlexiiCells behind it) into their own graph, and the cycle
// those lazy imports exist to break cannot come back through this door.
//
// Same shape as useDocHistoryPanel: a tiny store plus an imperative opener,
// with one host mounted per renderer root. A snippet embed is a ProseMirror
// node view, so there is no React parent to hand it a callback.

interface SnippetSessionState {
  /** The snippet being edited, or null when no session is open. */
  snippetId: string | null
  open: (snippetId: string) => void
  close: () => void
}

export const useSnippetSession = create<SnippetSessionState>((set) => ({
  snippetId: null,
  open: (snippetId) => set({ snippetId }),
  close: () => set({ snippetId: null })
}))

/**
 * Open a saved snippet as an editing session — the owner's "open and edit the
 * original from where it's placed".
 *
 * Callers do not decide whether the snippet CAN be edited: a kind with no
 * registered editor says so inside the session rather than refusing here, so
 * the user learns which snippet it was and why.
 */
export function openSnippetSession(snippetId: string): void {
  useSnippetSession.getState().open(snippetId)
}
