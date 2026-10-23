import { create } from 'zustand'
import {
  DEFAULT_FILES_PANEL_PREFS,
  FILES_PANEL_ACCOUNT_KEY,
  clampPanelWidth,
  mergeRemoteFilesPanelPrefs,
  readFilesPanelPrefs,
  syncedPart,
  writeFilesPanelPrefs,
  type FilesPanelMode,
  type FilesPanelPrefs,
  type FilesPanelView,
  type FloatRect
} from '../lib/filesPanelPrefs'
import { getAccountState, setAccountState } from '../lib/accountStateClient'

// Files beside your work: whether it is open, flying out of the side menu or
// pinned beside it, or floating; its width; list or grid. Persisted per user by
// lib/filesPanelPrefs. The panel's FOLDER and selection are not here: they are
// the 'panel' browser in stores/fileManager, shared by the flyout and the float.

/** Where the flyout docks: the right edge of whichever side menu is showing. */
export interface FilesPanelAnchor {
  /** Viewport x of the slot beside the side menu. */
  left: number
  top: number
  bottom: number
  /** Viewport x of the content area's right edge (for the narrow rule). */
  contentRight: number
  /** On the full-bleed desk the menu floats over the canvas; the flyout does too. */
  overCanvas: boolean
}

interface FilesPanelStore extends FilesPanelPrefs {
  accountId: string | null
  token: string | null
  anchor: FilesPanelAnchor | null
  /** A Files drag is in progress (the sheet goes pointer-transparent; pinning is held). */
  dragging: boolean

  openBeside: () => void
  openFloating: () => void
  close: () => void
  /** The header toggle and ⌥⌘F: open in the last mode, or close. */
  toggle: () => void
  /** The side menu's Files: fly out beside it, or close it when it is already beside. */
  toggleBeside: () => void
  setPinned: (pinned: boolean) => void
  setWidth: (w: number) => void
  setView: (v: FilesPanelView) => void
  setFloatRect: (r: FloatRect) => void
  setAnchor: (a: FilesPanelAnchor | null) => void
  setDragging: (d: boolean) => void
  /** Switch to this account's saved panel (sign-in, account switch). */
  switchAccount: (accountId: string | null, token: string | null) => void
  /** Adopt the account's copy if it is newer than this device's. */
  hydrateRemote: () => Promise<void>
}

function prefsOf(s: FilesPanelStore): FilesPanelPrefs {
  return { open: s.open, mode: s.mode, pinned: s.pinned, width: s.width, view: s.view, float: s.float, updatedAt: s.updatedAt }
}

export const useFilesPanelStore = create<FilesPanelStore>((set, get) => {
  /** Save locally; when `synced` changed, stamp and push to the account too. */
  const commit = (patch: Partial<FilesPanelPrefs>, synced: boolean): void => {
    if (synced) patch = { ...patch, updatedAt: Date.now() }
    set(patch)
    const s = get()
    writeFilesPanelPrefs(s.accountId, prefsOf(s))
    if (synced && s.token) void setAccountState(s.token, FILES_PANEL_ACCOUNT_KEY, syncedPart(prefsOf(s))).catch(() => false)
  }
  const initial = typeof localStorage === 'undefined' ? { ...DEFAULT_FILES_PANEL_PREFS } : readFilesPanelPrefs(null)
  return {
    ...initial,
    accountId: null,
    token: null,
    anchor: null,
    dragging: false,

    openBeside: () => commit({ open: true, mode: 'beside' }, get().mode !== 'beside'),
    openFloating: () => commit({ open: true, mode: 'float' }, get().mode !== 'float'),
    close: () => commit({ open: false }, false),
    toggle: () => commit({ open: !get().open }, false),
    toggleBeside: () => {
      const s = get()
      if (s.open && s.mode === 'beside') commit({ open: false }, false)
      else commit({ open: true, mode: 'beside' }, s.mode !== 'beside')
    },
    setPinned: (pinned) => {
      // Never reflow the content under a drag in progress.
      if (get().dragging || pinned === get().pinned) return
      commit({ pinned, mode: 'beside' }, true)
    },
    setWidth: (w) => {
      const width = clampPanelWidth(w)
      if (width !== get().width) commit({ width }, true)
    },
    setView: (view) => {
      if (view !== get().view) commit({ view }, true)
    },
    setFloatRect: (r) => commit({ float: r }, false),
    setAnchor: (a) => {
      const cur = get().anchor
      if (
        cur === a ||
        (cur && a && cur.left === a.left && cur.top === a.top && cur.bottom === a.bottom && cur.contentRight === a.contentRight && cur.overCanvas === a.overCanvas)
      )
        return
      set({ anchor: a })
    },
    setDragging: (dragging) => {
      if (dragging !== get().dragging) set({ dragging })
    },
    switchAccount: (accountId, token) => {
      if (accountId !== get().accountId) set({ accountId, ...readFilesPanelPrefs(accountId) })
      if (token !== get().token) {
        set({ token })
        if (token) void get().hydrateRemote()
      }
    },
    hydrateRemote: async () => {
      const { token } = get()
      if (!token) return
      const remote = await getAccountState<unknown>(token, FILES_PANEL_ACCOUNT_KEY).catch(() => null)
      if (get().token !== token) return
      const { next, push } = mergeRemoteFilesPanelPrefs(prefsOf(get()), remote)
      if (next) {
        set(next)
        writeFilesPanelPrefs(get().accountId, next)
      } else if (push) {
        void setAccountState(token, FILES_PANEL_ACCOUNT_KEY, syncedPart(prefsOf(get()))).catch(() => false)
      }
    }
  }
})

export type { FilesPanelMode, FilesPanelView }

/**
 * Files itself fills the screen (the full Files view, or Files inside
 * PlexiiOffice): the panel beside would be a second copy of it, and would
 * cover the full view's own folders. It steps aside, and comes back as it was.
 */
export function isFilesFullScreen(view: { kind: string; app?: string }): boolean {
  return view.kind === 'files' || (view.kind === 'office' && view.app === 'files')
}
