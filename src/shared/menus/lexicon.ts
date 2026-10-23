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
  /** The key off macOS, where the platform binds a different one (Paste as plain text is Ctrl+Shift+V in Chromium). */
  otherKeys?: ShortcutKeys
  /** The §9.3 icon (Material Symbols name): the same row looks the same in every menu. */
  icon?: string
}

/** The keys an action is bound to on this platform, if any. */
export function actionKeys(a: MenuAction, platform: string): ShortcutKeys | undefined {
  const mac = platform === 'darwin' || platform === 'mac'
  return mac ? a.keys : (a.otherKeys ?? a.keys)
}

export const MENU = {
  // Edit / clipboard
  undo: { label: 'Undo', keys: ['mod', 'z'] },
  redo: { label: 'Redo', keys: ['shift', 'mod', 'z'] }, // E-13 (decided): ⇧⌘Z shown, ⌘Y stays bound
  cut: { label: 'Cut', keys: ['mod', 'x'], icon: 'content_cut' },
  copy: { label: 'Copy', keys: ['mod', 'c'], icon: 'content_copy' },
  paste: { label: 'Paste', keys: ['mod', 'v'], icon: 'content_paste' },
  pasteAsPlainText: { label: 'Paste as plain text', keys: ['alt', 'shift', 'mod', 'v'], otherKeys: ['shift', 'mod', 'v'] },
  pasteInPlace: { label: 'Paste in place', keys: ['shift', 'mod', 'v'] },
  duplicate: { label: 'Duplicate', keys: ['mod', 'd'], icon: 'control_point_duplicate' },
  delete: { label: 'Delete', keys: ['backspace'], icon: 'delete' },
  selectAll: { label: 'Select all', keys: ['mod', 'a'], icon: 'select_all' },
  // E-14 (9d): ⌘F is Find, ⇧⌘H is Find and replace, wherever both exist (Draw excepted).
  find: { label: 'Find…', keys: ['mod', 'f'] },
  findAndReplace: { label: 'Find and replace…', keys: ['shift', 'mod', 'h'] },
  saveAsSnippet: { label: 'Save selection as snippet…', icon: 'bookmark_add' },
  // One definition for both apps: Write strips marks and nodes, Cells resets
  // cell format and number format, but it is the same action with the same
  // label and the same key, so neither may drift.
  clearFormatting: { label: 'Clear formatting', keys: ['mod', '\\'], icon: 'format_clear' },
  // Insert
  insertSnippet: { label: 'Insert snippet…', icon: 'bookmarks' },
  workWidgetFromDesk: { label: 'Work widget from a desk…' },
  meeting: { label: 'Meeting' },
  // Arrange
  bringToFront: { label: 'Bring to front', keys: ['shift', 'mod', ']'], icon: 'flip_to_front' },
  sendToBack: { label: 'Send to back', keys: ['shift', 'mod', '['], icon: 'flip_to_back' },
  group: { label: 'Group', keys: ['mod', 'g'], icon: 'link' },
  ungroup: { label: 'Ungroup', keys: ['shift', 'mod', 'g'], icon: 'link_off' },
  // Plexii
  askAssist: { label: 'Ask PlexiiAssist' },
  askAssistAboutThis: { label: 'Ask PlexiiAssist about this', icon: 'auto_awesome' },
  addToFocus: { label: 'Add to Focus…' },
  moreActions: { label: 'More actions' },
  // File
  makeCopy: { label: 'Make a copy' },
  rename: { label: 'Rename' },
  versionHistory: { label: 'Version history' },
  download: { label: 'Download' },
  print: { label: 'Print…', keys: ['mod', 'p'] },
  moveToTrash: { label: 'Move to Trash', icon: 'delete' }, // E-15 (decided)
  // Help
  keyboardShortcuts: { label: 'Keyboard shortcuts', keys: ['mod', '/'] },
  // Links and sharing
  copyLink: { label: 'Copy link' },
  share: { label: 'Share…' },
  // Desk, room and work widget objects (2e's surfaces; AUDIT.md §4.2, SPEC §9.4)
  open: { label: 'Open', icon: 'open_in_new' }, // E-3: bare verb
  archive: { label: 'Archive' },
  addToThisDesk: { label: 'Add to this desk', keys: ['mod', 'enter'] },
  makeThisADesk: { label: 'Make this a desk…' },
  duplicateKeepSynced: { label: 'Duplicate, keep synced' },
  shareWithTeam: { label: 'Share with team or group…' },
  // Tabs (2e WP2; browser wording, E-9)
  pinTab: { label: 'Pin tab' },
  unpinTab: { label: 'Unpin tab' },
  closeTab: { label: 'Close tab' },
  closeOtherTabs: { label: 'Close other tabs' },
  closeAllTabs: { label: 'Close all tabs' }
} as const satisfies Record<string, MenuAction>

export type MenuActionId = keyof typeof MENU

/** "Remove from ‹container›" (SPEC §9.4): taking a placement out, never deleting the object. */
export function removeFromLabel(container: 'desk' | 'room' | 'section' | 'focus' | 'tray' | 'folder' | 'home' | 'dashboard'): string {
  if (container === 'focus') return 'Remove from Focus'
  if (container === 'home') return 'Remove from Home'
  return `Remove from this ${container}`
}

/** "New ‹type›" for each office document type (File's first item). */
export const NEW_DOCUMENT_LABEL: Record<string, string> = {
  doc: 'New document',
  sheet: 'New spreadsheet',
  slides: 'New presentation',
  map: 'New diagram',
  design: 'New design',
  draw: 'New artwork'
}
