import { create } from 'zustand'
import type { View } from './view'
import {
  openIn,
  closeIn,
  closeOthersIn,
  togglePinIn,
  type TrayEntry
} from '../lib/openTray'

// What you have open, kept per device.
//
// This is window state, not workspace data: which things YOU have on this
// machine right now, the same way a browser's tabs are not part of the pages.
// So it lives in localStorage and never syncs — opening a desk on the laptop
// should not rearrange the strip on the desktop.

const KEY = 'plexi.openTray.v1'

interface OpenTrayStore {
  entries: TrayEntry[]
  open: (view: View) => void
  close: (key: string) => void
  closeOthers: (key: string) => void
  togglePin: (key: string) => void
  clear: () => void
}

function load(): TrayEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) return []
    // Anything without a key and a view is not an entry. A half-written record
    // would otherwise render as a nameless tab that navigates nowhere.
    return parsed.entries.filter(
      (e): e is TrayEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as TrayEntry).key === 'string' &&
        !!(e as TrayEntry).view &&
        typeof (e as TrayEntry).at === 'number'
    )
  } catch {
    return []
  }
}

function save(entries: TrayEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ entries }))
  } catch {
    /* quota — the tray is a convenience, never a reason to fail a navigation */
  }
}

export const useOpenTrayStore = create<OpenTrayStore>((set, get) => ({
  entries: typeof window === 'undefined' ? [] : load(),

  open: (view) => {
    const next = openIn(get().entries, view)
    // Reference-equal means the view was a place rather than a thing, or
    // nothing changed. Skip the write and the re-render.
    if (next.length === get().entries.length && next.every((e, i) => e === get().entries[i])) return
    set({ entries: next })
    save(next)
  },

  close: (key) => {
    // Removes the ENTRY. The desk, document or chat behind it is untouched —
    // there is deliberately no path from here to anything that deletes.
    const next = closeIn(get().entries, key)
    set({ entries: next })
    save(next)
  },

  closeOthers: (key) => {
    const next = closeOthersIn(get().entries, key)
    set({ entries: next })
    save(next)
  },

  togglePin: (key) => {
    const next = togglePinIn(get().entries, key)
    set({ entries: next })
    save(next)
  },

  clear: () => {
    set({ entries: [] })
    save([])
  }
}))

// Deliberately NOT a selector: orderTray builds a new array, and a selector
// returning a fresh identity on every read makes zustand re-render forever.
// The component orders inside a useMemo instead.

// Thin handle for debugging + e2e, same convention as __fbView/__fbNodes.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbOpenTray?: typeof useOpenTrayStore }).__fbOpenTray =
    useOpenTrayStore
}
