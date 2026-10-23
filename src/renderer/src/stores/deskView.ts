import { create } from 'zustand'

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

const KEY = 'fb.deskView.v1'
const DEFAULT_KEY = 'fb.deskDefaultView.v1'

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
  get: (taskId: string | null) => DeskViewMode
  set: (taskId: string, mode: DeskViewMode) => void
  toggle: (taskId: string) => void
  getDefault: (taskId: string | null) => DeskViewMode | null
  setDefault: (taskId: string, mode: DeskViewMode) => void
}

export const useDeskViewStore = create<DeskViewStore>((setState, getState) => ({
  modes: loadMap(KEY),
  defaults: loadMap(DEFAULT_KEY),
  get: (taskId) => {
    if (!taskId) return 'canvas'
    const s = getState()
    return s.modes[taskId] ?? s.defaults[taskId] ?? 'canvas'
  },
  set: (taskId, mode) => {
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
  }
}))
