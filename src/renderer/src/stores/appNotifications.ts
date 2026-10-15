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
  /**
   * What the number counts.
   *
   * This exists because the two signals do not measure the same thing and we
   * were presenting them as if they did. A page title is usually the number of
   * CONVERSATIONS with something unread — one chat holding five messages shows
   * as 1 — whereas the per-row accessible labels give the MESSAGES. Reporting
   * "1" for five waiting messages is not a rounding error, it is the wrong
   * question answered confidently, so the unit now travels with the number and
   * the tooltip says which it is.
   */
  unit?: CountUnit
}

/** What a reported number counts. 'unknown' is never guessed into one of the others. */
export type CountUnit = 'messages' | 'conversations' | 'unknown'

/**
 * Whether a count is being collected RIGHT NOW, and why not when it isn't.
 *
 * The distinction the operator asked to see: a number that is arriving live
 * from a signed-in session, versus the last number we happened to see. Those
 * are different claims and a single badge cannot make both, so the state is
 * explicit and the badge shows it — a sun and a green count when live, a moon
 * and a grey count when it is only the last thing we saw.
 */
export type AppLiveness =
  /** A background session is loaded and signed in; counts are current. */
  | 'live'
  /** Loaded, but the app showed us a sign-in wall. Counts cannot be read. */
  | 'signed-out'
  /** Not being polled — notifications off, or waiting its turn. */
  | 'asleep'

export interface AppStatus {
  liveness: AppLiveness
  /** When the background check last completed. */
  checkedAt: number
  /** The final URL after redirects, which is how sign-out is detected. */
  url?: string
}

interface AppNotificationsStore {
  counts: Record<string, SeenCount>
  /** Liveness per app. Session state: never persisted, never guessed. */
  status: Record<string, AppStatus>
  /** Report a page title for an app. A title with no count clears it. */
  report: (appId: string, title: string) => void
  /**
   * Report a count read from the page itself, which outranks the title.
   *
   * Separate from `report` because the precedence matters: a page that tells us
   * both its message total and its conversation total should badge the total
   * the user actually has to deal with.
   */
  reportCount: (appId: string, count: number | null, unit: CountUnit) => void
  unitFor: (appId: string) => CountUnit
  /**
   * Give up the "this is a message count" claim without discarding the number.
   *
   * Called when a live check found no per-thread labels after a previous one
   * did. Without it the message count outranks the title FOREVER: if an app
   * changes its markup the badge freezes on a number nobody can refresh, and a
   * frozen count is a count that is no longer true. This lets the title win
   * again on the next report, which is the honest fallback.
   */
  releaseMessageClaim: (appId: string) => void
  /** Clear one app's badge — e.g. you just opened it. */
  clear: (appId: string) => void
  countFor: (appId: string) => number
  setLiveness: (appId: string, liveness: AppLiveness, url?: string) => void
  livenessFor: (appId: string) => AppLiveness
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

/**
 * What a page title's number counts.
 *
 * Only "N unread" phrasing states its own unit, and even then it says messages.
 * A bare "(3)" does NOT: in practice it is usually conversations with something
 * waiting, but "usually" is not a claim worth making about someone's inbox, so
 * it is reported as unknown and the tooltip stays vague rather than wrong.
 */
export function titleUnitOf(title: string): CountUnit {
  if (/\d+\s+unread\s+messages?/i.test(title)) return 'messages'
  if (/\d+\s+unread\s+(chats?|conversations?)/i.test(title)) return 'conversations'
  return 'unknown'
}

/**
 * Total unread MESSAGES, summed from the page's own accessible labels.
 *
 * WHY THIS BEATS THE TITLE. A messaging app's title counts conversations — one
 * chat holding five messages titles itself "(1)" — so the badge was answering
 * "how many threads" while the user was asking "how much is waiting". The
 * per-row unread pills carry the real number, and they carry it in their
 * ACCESSIBLE NAME: `aria-label="5 unread messages"`. That is a standard, not a
 * per-app selector, which is what makes this usable on an app nobody
 * anticipated — the directory is not finite and never will be.
 *
 * DOUBLE COUNTING is the one real hazard: a row's pill and the row's own
 * wrapper can both be labelled, and a container may restate its children's
 * total. So a labelled element is skipped when it CONTAINS another labelled
 * element — only the innermost claim is counted.
 *
 * Returns null when the page makes no such claim, which is most of the web.
 * Null means "fall back to the title", never "zero".
 */
export function sumAriaUnread(
  labels: ReadonlyArray<{ label: string; containsAnother: boolean }>
): number | null {
  let total = 0
  let found = false
  for (const l of labels) {
    if (l.containsAnother) continue
    const m = l.label.match(/(\d{1,4})\s+unread/i)
    if (!m) continue
    const n = Number(m[1])
    if (!Number.isFinite(n) || n <= 0) continue
    total += n
    found = true
  }
  if (!found) return null
  return Math.min(total, 9999)
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
        // The unit is restored too. Dropping it would turn a known message
        // count back into an unlabelled number across a restart, which is the
        // bug this whole field exists to stop.
        const unit: CountUnit =
          v.unit === 'messages' || v.unit === 'conversations' ? v.unit : 'unknown'
        out[id] = { count: Math.min(v.count, 9999), at: v.at, unit }
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

/**
 * Does this URL look like a sign-in wall?
 *
 * Generic on purpose. The directory of connected apps is NOT finite — people
 * add whatever they use — so there can be no per-app rule about where its
 * login page lives or what its logged-out title says. This matches the shapes
 * the whole web uses, and the host pairs it with a password-field check, which
 * is the other universal signal.
 */
export function looksSignedOut(url: string, hasPasswordField: boolean): boolean {
  if (hasPasswordField) return true
  if (!url) return false
  const u = url.toLowerCase()
  return /(\/|\.|^)(login|signin|sign-in|sign_in|auth|sso|oauth|session\/new|account\/login|u\/login)(\/|\?|#|$)/.test(
    u
  )
}

export const useAppNotifications = create<AppNotificationsStore>((set, get) => ({
  counts: load(),
  status: {},

  report: (appId, title) => {
    const n = unreadFromTitle(title)
    // A title arriving after a message-level read must not overwrite it with a
    // conversation count. The DOM read is the better answer and it stands until
    // the app says the count is gone.
    const prev = get().counts[appId]
    if (n !== null && prev?.unit === 'messages') return
    get().reportCount(appId, n, titleUnitOf(title))
  },

  reportCount: (appId, count, unit) => {
    const counts = { ...get().counts }
    if (count === null) {
      // The app stopped claiming a count — that is a real signal (inbox read),
      // so the badge goes rather than lingering on a stale number.
      if (!(appId in counts)) return
      delete counts[appId]
    } else {
      const prev = counts[appId]
      if (prev && prev.count === count && prev.unit === unit) return
      counts[appId] = { count, at: Date.now(), unit }
    }
    set({ counts })
    persist(counts)
  },

  unitFor: (appId) => get().counts[appId]?.unit ?? 'unknown',

  releaseMessageClaim: (appId) => {
    const prev = get().counts[appId]
    if (!prev || prev.unit !== 'messages') return
    // Keep the number — it was true when we read it — but stop treating it as
    // the better answer, so the title can take over again on the next report.
    const counts = { ...get().counts, [appId]: { ...prev, unit: 'unknown' as CountUnit } }
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

  countFor: (appId) => get().counts[appId]?.count ?? 0,

  setLiveness: (appId, liveness, url) => {
    const prev = get().status[appId]
    if (prev && prev.liveness === liveness && prev.url === url) return
    set({ status: { ...get().status, [appId]: { liveness, checkedAt: Date.now(), url } } })
  },

  livenessFor: (appId) => get().status[appId]?.liveness ?? 'asleep'
}))
