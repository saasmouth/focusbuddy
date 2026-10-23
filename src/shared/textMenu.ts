// The Plexii rows of the app window's native text menu (main/webContextMenu.ts
// attachAppTextMenu): "Ask PlexiiAssist about this" and "Save selection as
// snippet…". Main draws the menu; the renderer does the work, because only the
// surface that owns the focused text knows what its selection really is (an
// office editor has rich content, not just the plain text Electron reports).
//
// Flow:
//   1. Right-click on text the page did not claim (no preventDefault).
//   2. Main asks the page which rows apply: window[TEXT_MENU_QUERY]() returns
//      TextMenuCaps for the focused element (renderer lib/textMenuHandlers.ts).
//   3. The person picks a row: main sends TEXT_MENU_CHANNEL with a
//      TextMenuCommand; the renderer hands it to the surface that registered
//      for the focused element, else to the generic flow.

/** main → renderer, one event per chosen row. */
export const TEXT_MENU_CHANNEL = 'textMenu:action'

/** The page-global main calls (executeJavaScript) to learn which rows apply. */
export const TEXT_MENU_QUERY = '__plexiiTextMenuQuery'

export type TextMenuAction = 'askAssist' | 'saveSnippet'

export interface TextMenuCommand {
  action: TextMenuAction
  /** The selection as Electron saw it (plain text). A surface with a richer selection reads its own. */
  selectionText: string
  /** The field was editable. */
  isEditable: boolean
  /** The frame the click was in (WebFrameMain.routingId), when it was a subframe. */
  frameId?: number
}

/** Which Plexii rows the focused element offers. Absent rows are never drawn (SPEC §9.5). */
export interface TextMenuCaps {
  askAssist: boolean
  saveSnippet: boolean
}

/**
 * The page's full answer to main's query: the rows, plus whether text was
 * already selected when the right-click began. On macOS a right-click on text
 * selects the word under it, so on read-only text (a button's label, a
 * heading) Electron reports a selection the person never made; main offers the
 * read-only text menu only for a selection that was there first.
 */
export interface TextMenuQueryResult extends TextMenuCaps {
  selectedBefore: boolean
}

/** What main assumes when the page does not answer: the generic ask route exists; no generic snippet route does. */
export const DEFAULT_TEXT_MENU_CAPS: TextMenuCaps = { askAssist: true, saveSnippet: false }
