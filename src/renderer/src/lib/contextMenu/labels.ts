// Labels the work widget menus use that MENU (src/shared/menus/lexicon.ts, d8's)
// does not carry yet. One place, so moving each into MENU is a one-line change
// here and nowhere else. Shared actions (Copy, Paste, Duplicate, Archive, Move
// to Trash, Share…, Add to Focus…, Ask PlexiiAssist, …) are NOT here: they are
// imported from MENU at the call site.

// TODO(§9 lexicon): move to MENU.copyAllText. AUDIT §4.2: plain "Copy" is the
// selection; a scoped label only when the whole object's text is copied.
export const COPY_ALL_TEXT_LABEL = 'Copy all text'
// TODO(§9 lexicon): move to MENU.createAndLink.
export const CREATE_AND_LINK_LABEL = 'Create & link'
// TODO(§9 lexicon): move to MENU.removeOrDeleteMany. A multi-selection can mix
// desk-only kinds and files, so it keeps the one question (lib/widgetRemoval).
export const removeOrDeleteManyLabel = (n: number): string => `Remove or delete ${n} work widgets…`
// TODO(§9 lexicon): move to MENU.addManyToFocus.
export const addManyToFocusLabel = (n: number): string => `Add ${n} to Focus…`
// TODO(§9 lexicon): move to MENU.showInFullView / MENU.showOnCanvas.
export const SHOW_IN_FULL_VIEW_LABEL = 'Show in full view'
export const SHOW_ON_CANVAS_LABEL = 'Show on the canvas'
// TODO(§9 lexicon): move to MENU.duplicateEmpty (a section: its frame, not its children).
export const DUPLICATE_EMPTY_LABEL = 'Duplicate, empty'
