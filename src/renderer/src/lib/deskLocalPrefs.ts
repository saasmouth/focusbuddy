// Where a desk's local viewing preferences live, in one place.
//
// The view a desk opens in (stores/deskView) and its Columns setup
// (lib/deskColumns) are kept in localStorage, per desk, on purpose: they are how
// THIS person likes to look at the desk, not part of the desk. A share link is
// the one case where somebody else's preference should become the starting
// point -- the sender chose how their desk is presented -- and the share page
// sets them while unpacking the desk, before the renderer has loaded. So the
// keys are here, in a module with no imports, where the share page can reach
// them without pulling the renderer in ahead of window.api.

export const DESK_VIEW_KEY = 'fb.deskView.v1'
export const DESK_DEFAULT_VIEW_KEY = 'fb.deskDefaultView.v1'
export const DESK_COLUMNS_KEY_PREFIX = 'fb.deskColumns.v1.'

function readMap(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Make `mode` the view `deskId` was last shown in, as if this person had picked it. */
export function rememberDeskView(deskId: string, mode: string): void {
  if (!deskId) return
  try {
    localStorage.setItem(DESK_VIEW_KEY, JSON.stringify({ ...readMap(DESK_VIEW_KEY), [deskId]: mode }))
  } catch {
    /* private mode: the desk opens in its default view */
  }
}

/** Store a Columns setup for `deskId`. loadColumnsConfig reads it defensively. */
export function rememberColumnsConfig(deskId: string, cfg: Record<string, unknown>): void {
  if (!deskId) return
  try {
    localStorage.setItem(DESK_COLUMNS_KEY_PREFIX + deskId, JSON.stringify(cfg))
  } catch {
    /* private mode: Columns opens with its default setup */
  }
}
