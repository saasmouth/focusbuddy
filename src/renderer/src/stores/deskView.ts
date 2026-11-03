import { create } from 'zustand'
import { DESK_DEFAULT_VIEW_KEY, DESK_VIEW_KEY } from '../lib/deskLocalPrefs'

// Per-desk view mode. A desk can be shown as the infinite spatial Canvas (the
// default) or as Columns (stacked scrollable walls). Two things are remembered per
// desk, both local viewing preferences (localStorage, not the synced DB):
//   - the LAST-USED mode, so switching desks restores how each was last viewed;
//   - an explicit DEFAULT mode the user can pin (spec §3.3 "Allow a default view
//     per desk"), which applies the first time a desk is opened before any toggle.
// Resolution: last-used wins, else the pinned default, else Canvas.

// canvas = the infinite spatial canvas; columns = stacked walls (its Status
// group-by is the Kanban board); list/table/gallery/compact = lightweight data
// views of the same objects (spec §3.4); workcentre = the dashboard, every object a
// resizable tile showing its full content (owner, 4.3.41). Timeline/Calendar are
// intentionally not modeled here — they suit time-bound events, not arbitrary desk objects.
export type DeskViewMode = 'canvas' | 'columns' | 'workcentre' | 'list' | 'table' | 'gallery' | 'compact'

const KEY = DESK_VIEW_KEY
const DEFAULT_KEY = DESK_DEFAULT_VIEW_KEY

function loadMap(key: string): Record<string, DeskViewMode> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, DeskViewMode>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persist(key: string, map: Record<string, DeskViewMode>): void {
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    /* ignore quota / private mode */
  }
}

interface DeskViewStore {
  modes: Record<string, DeskViewMode>
  defaults: Record<string, DeskViewMode>
  /**
   * Desks held to one view for this session: a share link whose sender chose
   * "only this view" (shared/sitePresentation.ts). Never persisted -- it is the
   * link's rule, not the visitor's preference. While a desk is locked, set()
   * and toggle() leave it alone and every view switcher hides itself.
   */
  locked: Record<string, DeskViewMode>
  lock: (taskId: string, mode: DeskViewMode) => void
  get: (taskId: string | null) => DeskViewMode
  set: (taskId: string, mode: DeskViewMode) => void
  toggle: (taskId: string) => void
  getDefault: (taskId: string | null) => DeskViewMode | null
  setDefault: (taskId: string, mode: DeskViewMode) => void
  /**
   * Where a new object should get its Workcentre tile: set by a drop at a grid
   * cell, consumed by the next layout sync (moveTile, not first fit). Session
   * only: it is the instant between a drop and the tile appearing.
   */
  pendingTileAt: Record<string, { x: number; y: number }>
  setPendingTile: (widgetId: string, at: { x: number; y: number }) => void
  clearPendingTiles: (widgetIds: string[]) => void
}

/**
 * The view a desk shows: locked, else last-used, else its pinned default, else
 * Canvas. Every reader resolves through here so a lock cannot be missed.
 */
export function resolveDeskView(
  s: Pick<DeskViewStore, 'modes' | 'defaults' | 'locked'>,
  taskId: string | null | undefined
): DeskViewMode {
  if (!taskId) return 'canvas'
  return s.locked[taskId] ?? s.modes[taskId] ?? s.defaults[taskId] ?? 'canvas'
}

/** Is this desk held to one view (a share link's "only this view")? */
export function useDeskViewLocked(taskId: string | null | undefined): boolean {
  return useDeskViewStore((s) => !!taskId && s.locked[taskId] !== undefined)
}

export const useDeskViewStore = create<DeskViewStore>((setState, getState) => ({
  modes: loadMap(KEY),
  defaults: loadMap(DEFAULT_KEY),
  locked: {},
  lock: (taskId, mode) => setState({ locked: { ...getState().locked, [taskId]: mode } }),
  get: (taskId) => resolveDeskView(getState(), taskId),
  set: (taskId, mode) => {
    if (getState().locked[taskId] !== undefined) return
    const modes = { ...getState().modes, [taskId]: mode }
    setState({ modes })
    persist(KEY, modes)
  },
  toggle: (taskId) => {
    getState().set(taskId, getState().get(taskId) === 'canvas' ? 'columns' : 'canvas')
  },
  getDefault: (taskId) => (taskId ? getState().defaults[taskId] ?? null : null),
  setDefault: (taskId, mode) => {
    const defaults = { ...getState().defaults, [taskId]: mode }
    setState({ defaults })
    persist(DEFAULT_KEY, defaults)
  },
  pendingTileAt: {},
  setPendingTile: (widgetId, at) => setState({ pendingTileAt: { ...getState().pendingTileAt, [widgetId]: at } }),
  clearPendingTiles: (ids) => {
    const next = { ...getState().pendingTileAt }
    for (const id of ids) delete next[id]
    setState({ pendingTileAt: next })
  }
}))
