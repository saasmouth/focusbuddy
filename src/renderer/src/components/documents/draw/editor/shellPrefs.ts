// How the person left PlexiiDraw's office-shell chrome: the top bar's tab and
// whether its second row is collapsed (owner D5: double-click the active tab),
// which overlay panels are pinned, and the last tool used in each rail flyout.
// Per device and per profile (localStorage, which Electron keeps per
// profile), like Illustrator's workspace. Never part of a drawing.

import { createStore } from 'zustand/vanilla'

export interface ShellPrefs {
  /** The top bar's active tab ('home', 'object', 'align' or a contextual one). */
  tab: string
  /** Row 2 of the top bar hidden. */
  collapsed: boolean
  /** Overlay panels kept open while you work (they reopen with the editor). */
  pinned: string[]
  /** Flyout id -> the tool shown on its rail button (the last one picked). */
  lastUsed: Record<string, string>
  /**
   * View › Hide Artboards (⇧⌘H): the artboards' edges and fill are not drawn,
   * so the art shows on the pasteboard. A view preference of the person, not
   * of the drawing: it never edits or saves a drawing (a v1 drawing stays v1,
   * co-editors keep their own view, a read-only drawing can be looked at
   * either way), and export is unaffected.
   */
  hideArtboards: boolean
}

// Direct Selection fronts its flyout (Group Selection sits behind it), as in Illustrator's toolbar.
export const SHELL_PREF_DEFAULTS: ShellPrefs = { tab: 'home', collapsed: false, pinned: [], lastUsed: { direct: 'direct' }, hideArtboards: false }

const KEY = 'plexii.draw.shell'

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 64

function load(): ShellPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return SHELL_PREF_DEFAULTS
    const v = JSON.parse(raw) as Partial<Record<keyof ShellPrefs, unknown>>
    const lastUsed: Record<string, string> = { ...SHELL_PREF_DEFAULTS.lastUsed }
    if (v.lastUsed && typeof v.lastUsed === 'object' && !Array.isArray(v.lastUsed))
      for (const [k, id] of Object.entries(v.lastUsed as Record<string, unknown>)) if (isStr(k) && isStr(id)) lastUsed[k] = id
    return {
      // Every office app opens on Home (SPEC §3.9): the tab is not restored.
      tab: SHELL_PREF_DEFAULTS.tab,
      collapsed: v.collapsed === true,
      pinned: Array.isArray(v.pinned) ? [...new Set(v.pinned.filter(isStr))] : [],
      lastUsed,
      hideArtboards: v.hideArtboards === true
    }
  } catch {
    return SHELL_PREF_DEFAULTS
  }
}

export const shellPrefs = createStore<ShellPrefs>(() => load())

shellPrefs.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s))
  } catch {
    // Storage unavailable (a private window, a test): the choice lasts for the session.
  }
})

export function setShellPrefs(patch: Partial<ShellPrefs>): void {
  shellPrefs.setState(patch)
}

/** Remember the tool picked in a flyout, so its rail button shows that tool. */
export function rememberFlyoutTool(flyout: string, toolId: string): void {
  shellPrefs.setState((s) => (s.lastUsed[flyout] === toolId ? s : { lastUsed: { ...s.lastUsed, [flyout]: toolId } }))
}

/** Back to the defaults (tests). */
export function resetShellPrefs(): void {
  shellPrefs.setState(SHELL_PREF_DEFAULTS, true)
}
