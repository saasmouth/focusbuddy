// Shared office-shell measurements (spec §2.6). One set of numbers for all six
// apps, so a desk widget behaves the same whichever editor it hosts.

export const RAIL_WIDTH = 40
export const ROW2_HEIGHT = 36
/** Below this editor width a ShellPanel opens as a sheet over the canvas. */
export const PANEL_SHEET_BELOW = 520
/** Below this editor width the leftAside navigator (Deck thumbnails) collapses to a toggle. */
export const ASIDE_COLLAPSE_BELOW = 640
/** Default and minimum overlay-panel width. */
export const PANEL_WIDTH = 280
/** Default width of the right content pane (comments, outline, AI). */
export const SIDE_PANE_WIDTH = 320
/** The side pane's DOM id: what its toggles point aria-controls at. */
export const SIDE_PANE_DOM_ID = 'shell-sidepane'
/** Width the folded "≡" menu button takes in Row 1. */
export const FOLDED_MENU_WIDTH = 34
/** Width the "More ▾" tab takes in Row 1. */
export const MORE_TAB_WIDTH = 64

/**
 * Row 1 folding, pure (spec §2.6). Given the natural widths, decide whether the
 * menus fold into "≡" and which tabs fold into "More". The active tab and any
 * pinned (visible contextual) tab never fold; trailing tabs fold first.
 */
export function planRow1(input: {
  available: number
  menuWidth: number
  tabs: { id: string; width: number; keep: boolean }[]
  chrome: number // collapse chevron, dividers, padding
}): { foldMenus: boolean; folded: string[] } {
  const tabsWidth = input.tabs.reduce((n, t) => n + t.width, 0)
  if (input.menuWidth + tabsWidth + input.chrome <= input.available) return { foldMenus: false, folded: [] }
  let used = FOLDED_MENU_WIDTH + tabsWidth + input.chrome
  const folded: string[] = []
  if (used <= input.available) return { foldMenus: true, folded }
  used += MORE_TAB_WIDTH
  for (let i = input.tabs.length - 1; i >= 0 && used > input.available; i--) {
    const t = input.tabs[i]!
    if (t.keep) continue
    folded.unshift(t.id)
    used -= t.width
  }
  return { foldMenus: true, folded }
}
