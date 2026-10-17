// Which widget kinds sit in the side menu's main Widgets list and which sit
// under "Other widgets", per user — persisted, and following the user across
// devices.
//
// localStorage is the source of truth on this device, read synchronously so
// the menu never paints in the wrong arrangement and then jumps. The account
// state endpoint (lib/accountStateClient, the same per-account store the
// autonomy prefs use) carries it to the user's other devices: the newer of the
// two copies wins, compared by the timestamp saved with each.

import { useSyncExternalStore } from 'react'
import { getAccountState, setAccountState } from './accountStateClient'
import { parseWidgetMenuPrefs, type WidgetMenuPrefs } from './widgetMenu'

const KEY = 'fb.nav.widgets'
const OTHER_OPEN_KEY = 'fb.nav.widgets.otherOpen'
export const WIDGET_MENU_ACCOUNT_KEY = 'widgetMenu'

interface Stored {
  prefs: WidgetMenuPrefs | null
  updatedAt: number
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { prefs: null, updatedAt: 0 }
    const parsed = JSON.parse(raw) as { prefs?: unknown; updatedAt?: unknown }
    return {
      prefs: parseWidgetMenuPrefs(parsed?.prefs ?? null),
      updatedAt: typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    // Blocked or malformed storage: the defaults, never an empty menu.
    return { prefs: null, updatedAt: 0 }
  }
}

let current: Stored = typeof localStorage === 'undefined' ? { prefs: null, updatedAt: 0 } : read()
const listeners = new Set<() => void>()
function notify(): void {
  for (const l of listeners) l()
}

function writeLocal(next: Stored): void {
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* not persistable here; this session's arrangement still stands */
  }
  notify()
}

export function getWidgetMenuPrefs(): WidgetMenuPrefs | null {
  return current.prefs
}

/** Save an arrangement here and, when signed in, for the user's other devices. */
export function setWidgetMenuPrefs(prefs: WidgetMenuPrefs, token: string | null = null): void {
  const next = { prefs, updatedAt: Date.now() }
  writeLocal(next)
  if (token) void setAccountState(token, WIDGET_MENU_ACCOUNT_KEY, next)
}

/**
 * Adopt the account's copy when it is newer than this device's. Called once a
 * session token is known; a failed fetch changes nothing.
 */
export async function hydrateWidgetMenuPrefs(token: string): Promise<void> {
  const remote = await getAccountState<{ prefs?: unknown; updatedAt?: unknown }>(token, WIDGET_MENU_ACCOUNT_KEY)
  if (!remote) {
    // Nothing saved for the account yet: seed it from this device, so the
    // user's other devices pick this arrangement up.
    if (current.prefs) void setAccountState(token, WIDGET_MENU_ACCOUNT_KEY, current)
    return
  }
  const prefs = parseWidgetMenuPrefs(remote.prefs ?? null)
  const updatedAt = typeof remote.updatedAt === 'number' ? remote.updatedAt : 0
  if (prefs && updatedAt > current.updatedAt) writeLocal({ prefs, updatedAt })
  else if (current.prefs && current.updatedAt > updatedAt) void setAccountState(token, WIDGET_MENU_ACCOUNT_KEY, current)
}

export function subscribeWidgetMenuPrefs(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useWidgetMenuPrefs(): WidgetMenuPrefs | null {
  return useSyncExternalStore(subscribeWidgetMenuPrefs, getWidgetMenuPrefs, getWidgetMenuPrefs)
}

/** Whether "Other widgets" is expanded. Device-local: it is a view state, not an arrangement. */
export function readOtherWidgetsOpen(): boolean {
  try {
    return localStorage.getItem(OTHER_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function writeOtherWidgetsOpen(open: boolean): void {
  try {
    localStorage.setItem(OTHER_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* session-only */
  }
}

/** Test seam: re-read storage (unit tests swap localStorage between cases). */
export function __reloadWidgetMenuPrefsForTests(): void {
  current = read()
  notify()
}
