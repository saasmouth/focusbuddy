// Right-click menus that belong to a work widget's BODY (SPEC §9.3), built as
// plain CtxMenuItem[] so the guard (tests/unit/contextMenuContract.wp1b.test.ts)
// checks exactly what the widgets render. Two kinds live here:
//
// - Content menus a body genuinely owns, drawn with the kit directly: the
//   table's column header, a speed-deck tile and the speed-deck background, a
//   mind-map node. They replace four bespoke menus that had no keyboard, no
//   portal (so they were scaled inside the zoomed canvas) and their own labels.
// - The rows a body contributes to its widget's unified menu (the browser and
//   custom work widgets' extras). Those ride into the resolver as headerExtras,
//   group 1 (object actions), with any overflow already folded under
//   `More actions` so a body can never break the eight-item ceiling (E-6).
//
// And one rule every text-bearing body shares: a right-click on text is the
// text menu's (`isTextContextTarget`).

import type { CtxMenuItem } from '../CanvasContextMenu'
import { MENU } from '@shared/menus/lexicon'
import { shortcutLabel, type ShortcutKeys } from '@shared/menus/shortcuts'
import { FIELD_TYPE_ICONS, FIELD_TYPE_LABELS, type FieldType } from '@shared/fields'

/** The platform hint formatter's input: `window.api.platform` in the app. */
export function menuPlatform(): string {
  if (typeof window === 'undefined') return 'darwin'
  return (window as { api?: { platform?: string } }).api?.platform ?? 'darwin'
}

const hint = (keys: ShortcutKeys | undefined, platform: string): string | undefined =>
  keys ? shortcutLabel(keys, platform) : undefined

/** Join §9.3 groups with exactly one separator between the non-empty ones. */
export function joinGroups(...groups: CtxMenuItem[][]): CtxMenuItem[] {
  const out: CtxMenuItem[] = []
  for (const g of groups) {
    if (!g.length) continue
    if (out.length) out.push({ separator: true })
    out.push(...g)
  }
  return out
}

// ── Text precedence (§9.3 third shape, E-5) ─────────────────────────────────

// Inputs that hold typed text. Checkboxes, buttons, ranges and pickers are
// controls, not text, so a right-click on them is still the body's.
const TEXT_INPUT =
  'input:not([type]),input[type="text"],input[type="search"],input[type="url"],input[type="tel"],' +
  'input[type="email"],input[type="password"],input[type="number"],textarea,' +
  '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]'

/**
 * True when a right-click belongs to the text menu, not the body's: it landed
 * in editable text, or on a text selection that covers what was clicked. The
 * body must then NOT preventDefault, so the right-click reaches the native
 * §9.3 text menu (main/webContextMenu, editableField.ts: Cut · Copy · Paste ·
 * Paste as plain text | Select all | Ask PlexiiAssist about this · Save
 * selection as snippet…). This replaces the old Shift-right-click bypass: text
 * gets the text menu by default, and everything else gets the widget's.
 */
export function isTextContextTarget(
  target: EventTarget | null,
  selection: Selection | null = typeof window === 'undefined' ? null : window.getSelection()
): boolean {
  const node = target as Node | null
  const el: Element | null =
    node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null)
  if (!el) return false
  if (el.closest(TEXT_INPUT)) return true
  if ((el as HTMLElement).isContentEditable) return true
  if (selection && !selection.isCollapsed && selection.toString().trim() !== '') {
    for (let i = 0; i < selection.rangeCount; i++) {
      if (selection.getRangeAt(i).intersectsNode(el)) return true
    }
  }
  return false
}

// ── Table column header ─────────────────────────────────────────────────────

export interface TableHeaderMenuInput {
  columnLabel: string
  index: number
  columnCount: number
  /** Group rows by this column is offered (the column can be grouped on). */
  groupable: boolean
  /** The table is grouped by this column right now. */
  groupedByThis: boolean
}

export interface TableHeaderMenuActions {
  insert: (side: 'left' | 'right', type: FieldType) => void
  move: (dir: -1 | 1) => void
  edit: () => void
  toggleGroup: () => void
  remove: () => void
}

// The column types, as the trailing "+" adder offers them, as a submenu.
function typePicker(onPick: (t: FieldType) => void, testPrefix: string): CtxMenuItem[] {
  return (Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => ({
    label: FIELD_TYPE_LABELS[t],
    icon: FIELD_TYPE_ICONS[t],
    testid: `${testPrefix}-${t}`,
    onClick: () => onPick(t)
  }))
}

/**
 * The table's column-header menu. Insert column left / right and Delete column
 * say exactly what PlexiiCells' column header says (SPEC §9.6), so a table
 * work widget and a spreadsheet read the same. A new column's type is picked in
 * a submenu, as it is at creation everywhere else in the table (a column's type
 * is set when it is made). The rest are the table's own column actions: move
 * (the keyboard route to what the grip does by drag), edit (the popover the
 * title opens) and grouping (the filter bar's Group, for this column). No
 * clipboard group: a column has no cut / copy / paste, so it is absent (§9.5).
 */
export function tableHeaderMenuItems(m: TableHeaderMenuInput, a: TableHeaderMenuActions): CtxMenuItem[] {
  const first = m.index === 0
  const last = m.index >= m.columnCount - 1
  const object: CtxMenuItem[] = [
    { label: 'Insert column left', icon: 'keyboard_tab_rtl', testid: 'table-col-insert-left', children: typePicker((t) => a.insert('left', t), 'table-col-insert-left') },
    { label: 'Insert column right', icon: 'keyboard_tab', testid: 'table-col-insert-right', children: typePicker((t) => a.insert('right', t), 'table-col-insert-right') },
    {
      label: 'Move column left',
      icon: 'arrow_back',
      testid: 'table-col-move-left',
      disabled: first,
      hint: first ? 'Already the first column' : undefined,
      onClick: () => a.move(-1)
    },
    {
      label: 'Move column right',
      icon: 'arrow_forward',
      testid: 'table-col-move-right',
      disabled: last,
      hint: last ? 'Already the last column' : undefined,
      onClick: () => a.move(1)
    },
    { label: 'Edit column…', icon: 'edit', testid: 'table-col-edit', onClick: a.edit }
  ]
  if (m.groupable) {
    object.push({ label: 'Group rows by this column', icon: 'view_agenda', testid: 'table-col-group', checked: m.groupedByThis, onClick: a.toggleGroup })
  }
  const only = m.columnCount <= 1
  const destructive: CtxMenuItem[] = [
    {
      label: 'Delete column',
      icon: 'delete',
      danger: true,
      testid: 'table-col-delete',
      disabled: only,
      hint: only ? 'A table needs at least one column' : undefined,
      onClick: a.remove
    }
  ]
  return joinGroups(object, destructive)
}

// ── Speed deck ──────────────────────────────────────────────────────────────

/**
 * The keys a focused speed-deck tile answers to. The menu shows a hint only for
 * these (SPEC §9.4), and StreamDeckWidget's tile keydown handler binds exactly
 * these, so the two cannot drift apart.
 */
export const SPEED_DECK_KEYS = {
  cut: MENU.cut.keys,
  copy: MENU.copy.keys,
  paste: MENU.paste.keys,
  duplicate: MENU.duplicate.keys
} as const

export type SpeedDeckKeyAction = keyof typeof SPEED_DECK_KEYS

/** Which tile action a keydown means, if any (⌘/Ctrl + X, C, V, D; no other modifier). */
export function speedDeckKeyAction(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: string
): SpeedDeckKeyAction | null {
  const mac = platform === 'darwin' || platform === 'mac'
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey || e.shiftKey) return null
  const k = e.key.toLowerCase()
  for (const [action, keys] of Object.entries(SPEED_DECK_KEYS) as [SpeedDeckKeyAction, ShortcutKeys][]) {
    if (keys.length === 2 && keys[1] === k) return action
  }
  return null
}

export interface SpeedDeckTileMenuInput {
  hasButton: boolean
  hasClipboard: boolean
}

export interface SpeedDeckTileMenuActions {
  configure: () => void
  makeFolder: () => void
  cut: () => void
  copy: () => void
  paste: () => void
  duplicate: () => void
  remove: () => void
}

/**
 * A speed-deck tile. Object: Configure… on a button, Add button… and New
 * folder here on an empty slot. Clipboard in the OS order (Cut, Copy, Paste,
 * Duplicate; it listed Copy first), with the hints the tile's keys really
 * answer to. Removing a button deletes it (it exists nowhere else), so it is
 * `Delete`, last and in the danger colour. No ⌫ hint: the key is not bound on a
 * tile, where Backspace would also be the canvas's delete-the-widget key.
 */
export function speedDeckTileMenuItems(
  m: SpeedDeckTileMenuInput,
  a: SpeedDeckTileMenuActions,
  platform: string
): CtxMenuItem[] {
  const object: CtxMenuItem[] = m.hasButton
    ? [{ label: 'Configure…', icon: 'tune', testid: 'speeddeck-menu-configure', onClick: a.configure }]
    : [
        { label: 'Add button…', icon: 'add', testid: 'speeddeck-menu-add', onClick: a.configure },
        { label: 'New folder here', icon: 'create_new_folder', testid: 'speeddeck-menu-folder', onClick: a.makeFolder }
      ]
  const paste: CtxMenuItem = {
    label: MENU.paste.label,
    icon: 'content_paste',
    shortcut: hint(SPEED_DECK_KEYS.paste, platform),
    testid: 'speeddeck-menu-paste',
    disabled: !m.hasClipboard,
    hint: m.hasClipboard ? undefined : 'Cut or copy a button first',
    onClick: a.paste
  }
  const clipboard: CtxMenuItem[] = m.hasButton
    ? [
        { label: MENU.cut.label, icon: 'content_cut', shortcut: hint(SPEED_DECK_KEYS.cut, platform), testid: 'speeddeck-menu-cut', onClick: a.cut },
        { label: MENU.copy.label, icon: 'content_copy', shortcut: hint(SPEED_DECK_KEYS.copy, platform), testid: 'speeddeck-menu-copy', onClick: a.copy },
        paste,
        { label: MENU.duplicate.label, icon: 'control_point_duplicate', shortcut: hint(SPEED_DECK_KEYS.duplicate, platform), testid: 'speeddeck-menu-duplicate', onClick: a.duplicate }
      ]
    : [paste]
  const destructive: CtxMenuItem[] = m.hasButton
    ? [{ label: MENU.delete.label, icon: 'delete', danger: true, testid: 'speeddeck-menu-delete', onClick: a.remove }]
    : []
  return joinGroups(object, clipboard, destructive)
}

export interface SpeedDeckDeckMenuInput {
  editing: boolean
}

export interface SpeedDeckDeckMenuActions {
  toggleEditing: () => void
  copyJson: () => void
  exportFile: () => void
  importFile: () => void
  accessibility: () => void
  reset: () => void
}

/**
 * The speed-deck background (and its ⋯ button). The deck's own actions, then
 * Reset deck… last in the danger colour. The scope ("Task deck" / "Universal
 * deck") was a heading row the kit does not draw; the Reset confirmation names
 * it, which is where it matters.
 */
export function speedDeckDeckMenuItems(m: SpeedDeckDeckMenuInput, a: SpeedDeckDeckMenuActions): CtxMenuItem[] {
  return joinGroups(
    [
      { label: 'Edit buttons', icon: 'tune', checked: m.editing, testid: 'speeddeck-deck-edit', onClick: a.toggleEditing },
      { label: 'Copy deck JSON', icon: 'data_object', testid: 'speeddeck-deck-copy-json', onClick: a.copyJson },
      { label: 'Export deck to file…', icon: 'download', testid: 'speeddeck-deck-export', onClick: a.exportFile },
      { label: 'Import deck from file…', icon: 'upload', testid: 'speeddeck-deck-import', onClick: a.importFile },
      { label: 'Accessibility permission…', icon: 'key', testid: 'speeddeck-deck-accessibility', onClick: a.accessibility }
    ],
    [{ label: 'Reset deck…', icon: 'restart_alt', danger: true, testid: 'speeddeck-deck-reset', onClick: a.reset }]
  )
}

// ── Mind-map node ───────────────────────────────────────────────────────────

export interface MindMapNodeMenuInput {
  isRoot: boolean
  /** An AI-proposed node waiting for accept / reject. */
  pending: boolean
  /** The view is already drilled into this node. */
  isViewRoot: boolean
  /** Expand with AI is running (one at a time). */
  busy: boolean
}

export interface MindMapNodeMenuActions {
  addChild: () => void
  addSibling: () => void
  drillIn: () => void
  expand: () => void
  accept: () => void
  reject: () => void
  remove: () => void
}

/**
 * A mind-map node. The tree's own actions for the node that was clicked (they
 * were reachable only from the side panel and keys), and Delete for any node
 * but the root. A pending (AI-proposed) node offers only Accept / Reject.
 */
export function mindMapNodeMenuItems(m: MindMapNodeMenuInput, a: MindMapNodeMenuActions): CtxMenuItem[] {
  if (m.pending) {
    return [
      { label: 'Accept', icon: 'check', testid: 'mindmap-menu-accept', onClick: a.accept },
      { label: 'Reject', icon: 'close', testid: 'mindmap-menu-reject', onClick: a.reject }
    ]
  }
  const object: CtxMenuItem[] = [{ label: 'Add child', icon: 'subdirectory_arrow_right', testid: 'mindmap-menu-add-child', onClick: a.addChild }]
  if (!m.isRoot) object.push({ label: 'Add sibling', icon: 'add', testid: 'mindmap-menu-add-sibling', onClick: a.addSibling })
  if (!m.isViewRoot) object.push({ label: 'Zoom into this branch', icon: 'zoom_in', testid: 'mindmap-menu-drill', onClick: a.drillIn })
  object.push({
    label: 'Expand with AI',
    icon: 'auto_awesome',
    testid: 'mindmap-menu-expand',
    disabled: m.busy,
    hint: m.busy ? 'Already working on this map' : undefined,
    onClick: a.expand
  })
  const destructive: CtxMenuItem[] = m.isRoot
    ? []
    : [{ label: MENU.delete.label, icon: 'delete', danger: true, testid: 'mindmap-menu-delete', onClick: a.remove }]
  return joinGroups(object, destructive)
}

// ── Rows a body contributes to its widget's menu (headerExtras) ─────────────

export interface WebViewExtrasInput {
  /** A URL is loaded. */
  hasUrl: boolean
  /** Already bound to a Connected App (Pin to Apps would be a no-op). */
  boundToApp: boolean
}

export interface WebViewExtrasActions {
  pinToApps: () => void
  reload: () => void
  openFullScreen: () => void
  changeUrl: () => void
}

/**
 * The browser-family work widget's object rows. No hint on Reload: ⌘R is not
 * bound to the widget (it reloads the app window).
 */
export function webViewMenuExtras(m: WebViewExtrasInput, a: WebViewExtrasActions): CtxMenuItem[] {
  const items: CtxMenuItem[] = []
  if (m.hasUrl) items.push({ label: 'Open full screen', icon: 'fullscreen', onClick: a.openFullScreen })
  items.push({ label: 'Reload', icon: 'refresh', onClick: a.reload })
  items.push({ label: 'Change URL…', icon: 'edit', onClick: a.changeUrl })
  if (m.hasUrl && !m.boundToApp) items.push({ label: 'Pin to Apps', icon: 'push_pin', onClick: a.pinToApps })
  return items
}

export interface CustomExtrasInput {
  /** The work widget has been built (it has code). */
  built: boolean
  hasHistory: boolean
  showSource: boolean
  net: boolean
  acts: boolean
}

export interface CustomExtrasActions {
  changeWhatItDoes: () => void
  refine: () => void
  save: () => void
  revert: () => void
  toggleSource: () => void
  toggleNet: () => void
  toggleActs: () => void
  startOver: () => void
  library: () => void
}

/**
 * The custom work widget's rows: the two ways to change it inline, everything
 * else under `More actions` (it was up to nine rows spliced into the menu
 * uncapped, AUDIT F-9). The on/off settings are check marks, not ": on" text
 * in the label; Start over discards the widget, so it is last and destructive.
 */
export function customWidgetMenuExtras(m: CustomExtrasInput, a: CustomExtrasActions): CtxMenuItem[] {
  if (!m.built) return [{ label: 'My work widgets…', icon: 'grid_view', onClick: a.library }]
  const more = joinGroups(
    [
      { label: 'Internet access', icon: 'public', checked: m.net, onClick: a.toggleNet },
      { label: 'Can make changes', icon: 'bolt', checked: m.acts, onClick: a.toggleActs },
      { label: 'Show source', icon: 'code', checked: m.showSource, onClick: a.toggleSource }
    ],
    [
      ...(m.hasHistory ? [{ label: 'Revert to previous version', icon: 'undo', onClick: a.revert }] : []),
      { label: 'Save to my work widgets…', icon: 'bookmark_add', onClick: a.save },
      { label: 'My work widgets…', icon: 'grid_view', onClick: a.library }
    ],
    [{ label: 'Start over…', icon: 'restart_alt', danger: true, onClick: a.startOver }]
  )
  return [
    { label: 'Change what it does…', icon: 'tune', onClick: a.changeWhatItDoes },
    { label: 'Change this work widget…', icon: 'auto_fix_high', onClick: a.refine },
    { label: MENU.moreActions.label, icon: 'more_horiz', children: more }
  ]
}
