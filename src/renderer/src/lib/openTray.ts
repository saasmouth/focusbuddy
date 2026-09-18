import type { View } from '../stores/view'

// The strip of things you currently have open.
//
// The app navigates, it does not open: every destination replaces the last one
// and the only way back is the history arrows. That is fine for a tool you use
// one thing at a time and wrong for one where a desk, the document you are
// writing from it and the chat you are discussing it in are all the same piece
// of work. The tray is the list of those, so switching between them is a click
// rather than a retrace.
//
// Two decisions shape everything here:
//
// NOT EVERY VIEW IS A THING. Home, Trash and Calendar are places you go, not
// items you have open. A tray listing them is a second navigation bar that
// happens to be at the bottom. Only a view that names a SUBJECT -- this desk,
// this document, this room -- earns an entry.
//
// CLOSING CLOSES NOTHING. The × removes the entry and touches the subject not
// at all. A taskbar whose close button could delete a document would be a trap,
// so the word used in the UI is "close", the tooltip says what it does, and
// nothing in this module can reach a store that deletes.

/**
 * The document a view has open, whichever route it came by, or null.
 *
 * Office renders documents inside its own shell and the standalone route
 * renders them on their own, but it is one document either way -- so anything
 * that asks "is a document open here, and which" has to accept both. The tray
 * uses it for identity and for what a tab can be dragged onto a desk.
 */
export function documentIdOf(view: View): string | null {
  if (view.kind === 'document') return view.documentId
  if (view.kind === 'office' && view.doc) return view.doc
  return null
}

/** A view that names something specific enough to keep a place in the tray. */
export interface TrayEntry {
  /** Stable identity for this subject — dedupes and is the close handle. */
  key: string
  /** Enough to navigate back. Titles are resolved live, never stored. */
  view: View
  /** When it was last looked at, for ordering and for eviction. */
  at: number
  /** Pinned entries survive eviction and sort first. */
  pinned?: boolean
}

// Beyond this the tray stops being scannable and becomes a list to read. The
// oldest UNPINNED entry goes when a new one arrives.
export const MAX_TRAY = 12

/**
 * The tray identity of a view, or null when it is a place rather than a thing.
 *
 * The kinds here are the ones with a subject. Adding a kind is deliberate: it
 * should be something a person would say they had "open".
 */
export function trayKeyFor(view: View): string | null {
  switch (view.kind) {
    case 'task':
      return `task:${view.taskId}`
    case 'project-dashboard':
      return `project:${view.projectId}`
    case 'document':
      return `document:${view.documentId}`
    case 'livedoc':
      return `livedoc:${view.liveDocId}`
    case 'livefolder':
      return `livefolder:${view.liveFolderId}`
    case 'desks':
      return view.roomId ? `room:${view.roomId}` : null
    case 'connected-app':
      return `app:${view.appId}`
    case 'product':
      return `product:${view.productKey}`
    case 'knowledge':
      // The knowledge INDEX is a place; a specific entry is a thing.
      return view.entryId ? `knowledge:${view.entryId}` : null
    case 'office':
      // A document open inside Office is the SAME subject as the standalone
      // document route -- one entry, not two, whichever way you got to it.
      if (view.doc) return `document:${view.doc}`
      // An Office app you have open -- Chat, Mail, the Browser, Sign. The hub
      // itself (no app) is a place, like the desks index.
      return view.app ? `office:${view.app}` : null
    case 'messages':
      // Chat is one context rather than one per conversation: the view carries
      // no conversation id, and inventing one here would be inventing state.
      return 'messages'
    case 'mail':
      return 'mail'
    default:
      return null
  }
}

/** Record a visit: a new entry, or the existing one moved to now. */
export function openIn(list: readonly TrayEntry[], view: View, now = Date.now()): TrayEntry[] {
  const key = trayKeyFor(view)
  if (!key) return [...list]

  const existing = list.find((e) => e.key === key)
  if (existing) {
    // Revisiting keeps the entry's place in the tray and only updates its
    // recency. Reordering the strip under the cursor every time somebody
    // glances at a desk would make it unusable as a set of positions.
    return list.map((e) => (e.key === key ? { ...e, view, at: now } : e))
  }

  const entry: TrayEntry = { key, view, at: now }
  const next = [...list, entry]
  if (next.length <= MAX_TRAY) return next

  // Evict the least recently seen UNPINNED entry — never the one just opened.
  // Without that exclusion the new entry is itself the most recent unpinned
  // one whenever everything else is pinned, so it evicts itself and opening
  // something does nothing at all.
  const evictable = next.filter((e) => e !== entry && !e.pinned)
  // Everything else is pinned: the tray is allowed over the cap rather than
  // dropping something the user asked to keep, or refusing to open.
  if (evictable.length === 0) return next
  const oldest = evictable.reduce((a, b) => (a.at <= b.at ? a : b))
  return next.filter((e) => e !== oldest)
}

/** Remove an entry. The subject is untouched — this is the whole contract. */
export function closeIn(list: readonly TrayEntry[], key: string): TrayEntry[] {
  return list.filter((e) => e.key !== key)
}

/** Close everything except one, for "close the others". */
export function closeOthersIn(list: readonly TrayEntry[], keep: string): TrayEntry[] {
  return list.filter((e) => e.key === keep || e.pinned)
}

export function togglePinIn(list: readonly TrayEntry[], key: string): TrayEntry[] {
  return list.map((e) => (e.key === key ? { ...e, pinned: !e.pinned } : e))
}

/** Pinned first, then the order they were opened in. */
export function orderTray(list: readonly TrayEntry[]): TrayEntry[] {
  const pinned = list.filter((e) => e.pinned)
  const rest = list.filter((e) => !e.pinned)
  return [...pinned, ...rest]
}

/** Which entry, if any, the current view corresponds to. */
export function activeKey(view: View): string | null {
  return trayKeyFor(view)
}

/**
 * Drop entries whose subject no longer exists.
 *
 * `alive` answers for the kinds that can be deleted. An entry the resolver has
 * no opinion about is KEPT: "I do not know" must not read as "it is gone", or a
 * store that has not finished loading would quietly empty the tray.
 */
export function pruneTray(
  list: readonly TrayEntry[],
  alive: (entry: TrayEntry) => boolean | undefined
): TrayEntry[] {
  return list.filter((e) => alive(e) !== false)
}
