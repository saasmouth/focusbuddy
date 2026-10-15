// Unread counts for connected apps, read from the app's own page title.
//
// WHERE THE NUMBER COMES FROM, and why it is honest. Web apps advertise their
// unread count in the document title — "(3) Inbox", "Slack (12)", "Gmail - 5
// unread". That string is the app's own claim about itself, so reading it is
// reporting, not inferring. We never estimate, never cache a number we did not
// see, and never show a count for an app that has not told us one.
//
// WHAT THIS CANNOT DO, stated plainly because the limit matters: a title only
// exists while the app is loaded in a webview. A count therefore appears for
// an app you have open (as a full pane, or as a webview widget on a desk) and
// then persists as "last seen" until it reports again. It is NOT background
// polling — nothing here loads an app you did not open. Doing that would mean
// a hidden renderer process per app, which is a real cost on a real machine,
// and it is the obvious next step rather than something to fake in the
// meantime: a badge that invents a number while the app is closed would be
// worse than no badge.
//
// The per-app preference lives on the app row (`notifications`), not here:
// whether you want a count is a durable choice, while the count itself is
// session state.

import { create } from 'zustand'

const KEY = 'fb.appNotifications.lastSeen'

export interface SeenCount {
  count: number
  /** When the app last told us. Shown as context, never used to guess. */
  at: number
}

interface AppNotificationsStore {
  counts: Record<string, SeenCount>
  /** Report a page title for an app. A title with no count clears it. */
  report: (appId: string, title: string) => void
  /** Clear one app's badge — e.g. you just opened it. */
  clear: (appId: string) => void
  countFor: (appId: string) => number
}

/**
 * Pull an unread count out of a page title.
 *
 * Deliberately conservative. It matches the three shapes real apps use and
 * nothing else, because a loose rule turns a version number or a year into an
 * unread count — "Figma (2024)" must not read as 2024 unread.
 */
export function unreadFromTitle(title: string): number | null {
  if (!title) return null
  const t = title.trim()

  // "(3) Inbox — Gmail" — the dominant convention, and only at the start.
  const leading = t.match(/^\((\d{1,4})\+?\)/)
  if (leading) return clampCount(leading[1])

  // "Slack (12)" — trailing, but ONLY when the whole parenthetical is digits
  // and small enough to be a count rather than a year or a version.
  const trailing = t.match(/\((\d{1,3})\+?\)\s*$/)
  if (trailing) {
    const n = Number(trailing[1])
    // A 4-digit number is a year; 3 digits is plausible unread. Anything that
    // looks like a version ("v2 (1.2)") has already failed the digits-only test.
    if (n > 0 && n < 1000) return n
  }

  // "… - 5 unread", "5 unread messages"
  const worded = t.match(/(\d{1,4})\s+unread/i)
  if (worded) return clampCount(worded[1])

  return null
}

function clampCount(raw: string): number | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(n, 9999)
}

function load(): Record<string, SeenCount> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, SeenCount>
    // Only keep well-formed rows: a malformed store must not render a badge.
    const out: Record<string, SeenCount> = {}
    for (const [id, v] of Object.entries(parsed)) {
      if (v && typeof v.count === 'number' && v.count > 0 && typeof v.at === 'number') {
        out[id] = { count: Math.min(v.count, 9999), at: v.at }
      }
    }
    return out
  } catch {
    return {}
  }
}

function persist(counts: Record<string, SeenCount>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(counts))
  } catch {
    // Not persistable here; the session's counts still stand.
  }
}

export const useAppNotifications = create<AppNotificationsStore>((set, get) => ({
  counts: load(),

  report: (appId, title) => {
    const n = unreadFromTitle(title)
    const counts = { ...get().counts }
    if (n === null) {
      // The app stopped claiming a count — that is a real signal (inbox read),
      // so the badge goes rather than lingering on a stale number.
      if (!(appId in counts)) return
      delete counts[appId]
    } else {
      const prev = counts[appId]
      if (prev && prev.count === n) return
      counts[appId] = { count: n, at: Date.now() }
    }
    set({ counts })
    persist(counts)
  },

  clear: (appId) => {
    const counts = { ...get().counts }
    if (!(appId in counts)) return
    delete counts[appId]
    set({ counts })
    persist(counts)
  },

  countFor: (appId) => get().counts[appId]?.count ?? 0
}))
