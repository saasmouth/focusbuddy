import type { ShortcutKeys } from './shortcuts'

// One label (and, where bound, one key) per shared menu action (SPEC §9.4).
// Every menu bar and right-click menu takes a shared action's label from here,
// so "Duplicate" cannot drift back into "Duplicate selection" in one app.
// Plain data: main imports it for native menus.
//
// Labels pending a 9d ruling (SPEC §9.7) are marked; a ruling is a one-line change.

export interface MenuAction {
  label: string
  keys?: ShortcutKeys
}

export const MENU = {
  // Edit / clipboard
  undo: { label: 'Undo', keys: ['mod', 'z'] },
  redo: { label: 'Redo', keys: ['shift', 'mod', 'z'] }, // E-13 (recommended; ⌘Y stays bound)
  cut: { label: 'Cut', keys: ['mod', 'x'] },
  copy: { label: 'Copy', keys: ['mod', 'c'] },
  paste: { label: 'Paste', keys: ['mod', 'v'] },
  pasteAsPlainText: { label: 'Paste as plain text', keys: ['alt', 'shift', 'mod', 'v'] },
  pasteInPlace: { label: 'Paste in place', keys: ['shift', 'mod', 'v'] },
  duplicate: { label: 'Duplicate', keys: ['mod', 'd'] },
  delete: { label: 'Delete', keys: ['backspace'] },
  selectAll: { label: 'Select all', keys: ['mod', 'a'] },
  find: { label: 'Find', keys: ['mod', 'f'] }, // E-14
  findAndReplace: { label: 'Find and replace…', keys: ['shift', 'mod', 'h'] }, // E-14
  saveAsSnippet: { label: 'Save selection as snippet…' },
  // Insert
  insertSnippet: { label: 'Insert snippet…' },
  workWidgetFromDesk: { label: 'Work widget from a desk…' },
  meeting: { label: 'Meeting' },
  // Arrange
  bringToFront: { label: 'Bring to front', keys: ['shift', 'mod', ']'] },
  sendToBack: { label: 'Send to back', keys: ['shift', 'mod', '['] },
  group: { label: 'Group', keys: ['mod', 'g'] },
  ungroup: { label: 'Ungroup', keys: ['shift', 'mod', 'g'] },
  // Plexii
  askAssist: { label: 'Ask PlexiiAssist' },
  askAssistAboutThis: { label: 'Ask PlexiiAssist about this' },
  addToFocus: { label: 'Add to Focus…' },
  moreActions: { label: 'More actions' },
  // File
  makeCopy: { label: 'Make a copy' },
  rename: { label: 'Rename' },
  versionHistory: { label: 'Version history' },
  download: { label: 'Download' },
  print: { label: 'Print…', keys: ['mod', 'p'] },
  moveToTrash: { label: 'Move to Trash' }, // E-15 (recommended capital T)
  // Help
  keyboardShortcuts: { label: 'Keyboard shortcuts', keys: ['mod', '/'] },
  // Links and sharing
  copyLink: { label: 'Copy link' },
  share: { label: 'Share…' }
} as const satisfies Record<string, MenuAction>

export type MenuActionId = keyof typeof MENU

/** "New ‹type›" for each office document type (File's first item). */
export const NEW_DOCUMENT_LABEL: Record<string, string> = {
  doc: 'New document',
  sheet: 'New spreadsheet',
  slides: 'New presentation',
  map: 'New diagram',
  design: 'New design',
  draw: 'New artwork'
}
