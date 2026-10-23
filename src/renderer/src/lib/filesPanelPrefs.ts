// How the Files panel beside your work was left, per user.
//
// localStorage (`fb.filesPanel.<accountId>`) is the source of truth on this
// device, read synchronously so the panel never paints at the wrong width and
// then jumps. The parts that describe how a PERSON likes to work (pinned or
// not, width, flyout or floating, list or grid) also go to the account state
// endpoint, so they follow the person to another device: the newer copy wins,
// by the timestamp saved with it. Whether the panel is open, and where the
// floating panel sits, stay on this device: one is a moment, the other is a
// screen position.
//
// Every read and write survives storage that throws or holds rubbish: the
// defaults apply, never a broken panel.

export const FILES_PANEL_MIN_W = 240
export const FILES_PANEL_MAX_W = 560
export const FILES_PANEL_DEFAULT_W = 320
/** The panel never takes more than this share of the content area. */
export const FILES_PANEL_MAX_SHARE = 0.45
/** Pinning must leave the content at least this wide, or the panel stays a flyout over it. */
export const FILES_PANEL_MIN_CONTENT = 560
export const FLOAT_MIN_W = 260
export const FLOAT_MIN_H = 280
export const FILES_PANEL_ACCOUNT_KEY = 'filesPanel'

export type FilesPanelMode = 'beside' | 'float'
export type FilesPanelView = 'list' | 'grid'

export interface FloatRect {
  x: number
  y: number
  w: number
  h: number
}

export interface FilesPanelPrefs {
  open: boolean
  mode: FilesPanelMode
  /** Docked: reserves its width and moves the content right. Unpinned it flies out over the content. */
  pinned: boolean
  width: number
  view: FilesPanelView
  float: FloatRect | null
  /** When the synced part last changed (ms). */
  updatedAt: number
}

export const DEFAULT_FILES_PANEL_PREFS: FilesPanelPrefs = {
  open: false,
  mode: 'beside',
  pinned: false,
  width: FILES_PANEL_DEFAULT_W,
  view: 'list',
  float: null,
  updatedAt: 0
}

export function clampPanelWidth(w: unknown, contentWidth?: number): number {
  const n = typeof w === 'number' && Number.isFinite(w) ? Math.round(w) : FILES_PANEL_DEFAULT_W
  let max = FILES_PANEL_MAX_W
  if (typeof contentWidth === 'number' && contentWidth > 0) {
    max = Math.max(FILES_PANEL_MIN_W, Math.min(max, Math.floor(contentWidth * FILES_PANEL_MAX_SHARE)))
  }
  return Math.max(FILES_PANEL_MIN_W, Math.min(max, n))
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parseFloat_(v: unknown): FloatRect | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const x = num(o.x)
  const y = num(o.y)
  const w = num(o.w)
  const h = num(o.h)
  if (x === null || y === null || w === null || h === null) return null
  return { x: Math.round(x), y: Math.round(y), w: Math.max(FLOAT_MIN_W, Math.round(w)), h: Math.max(FLOAT_MIN_H, Math.round(h)) }
}

/** Anything (stored JSON, the account copy, nonsense) → valid prefs. */
export function parseFilesPanelPrefs(raw: unknown): FilesPanelPrefs {
  const d = DEFAULT_FILES_PANEL_PREFS
  if (!raw || typeof raw !== 'object') return { ...d }
  const o = raw as Record<string, unknown>
  return {
    open: typeof o.open === 'boolean' ? o.open : d.open,
    mode: o.mode === 'float' || o.mode === 'beside' ? o.mode : d.mode,
    pinned: typeof o.pinned === 'boolean' ? o.pinned : d.pinned,
    width: clampPanelWidth(o.width),
    view: o.view === 'grid' || o.view === 'list' ? o.view : d.view,
    float: parseFloat_(o.float),
    updatedAt: num(o.updatedAt) ?? 0
  }
}

export function filesPanelStorageKey(accountId: string | null | undefined): string {
  return `fb.filesPanel.${accountId || 'local'}`
}

export function readFilesPanelPrefs(accountId: string | null | undefined): FilesPanelPrefs {
  try {
    const raw = localStorage.getItem(filesPanelStorageKey(accountId))
    return parseFilesPanelPrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_FILES_PANEL_PREFS }
  }
}

export function writeFilesPanelPrefs(accountId: string | null | undefined, prefs: FilesPanelPrefs): void {
  try {
    localStorage.setItem(filesPanelStorageKey(accountId), JSON.stringify(prefs))
  } catch {
    /* not persistable here; this session's panel still stands */
  }
}

/** The part that follows the person to their other devices. */
export interface SyncedFilesPanelPrefs {
  mode: FilesPanelMode
  pinned: boolean
  width: number
  view: FilesPanelView
  updatedAt: number
}

export function syncedPart(p: FilesPanelPrefs): SyncedFilesPanelPrefs {
  return { mode: p.mode, pinned: p.pinned, width: p.width, view: p.view, updatedAt: p.updatedAt }
}

/**
 * Merge the account's copy with this device's: the newer synced part wins;
 * `open` and `float` always stay this device's. Returns null when this
 * device's copy should be kept as is (and pushed, if `push` is true).
 */
export function mergeRemoteFilesPanelPrefs(
  local: FilesPanelPrefs,
  remote: unknown
): { next: FilesPanelPrefs | null; push: boolean } {
  if (!remote || typeof remote !== 'object') return { next: null, push: local.updatedAt > 0 }
  const r = parseFilesPanelPrefs(remote)
  if (r.updatedAt > local.updatedAt) {
    return { next: { ...local, mode: r.mode, pinned: r.pinned, width: r.width, view: r.view, updatedAt: r.updatedAt }, push: false }
  }
  return { next: null, push: local.updatedAt > r.updatedAt }
}
