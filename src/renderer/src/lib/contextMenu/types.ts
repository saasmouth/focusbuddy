// Unified context-menu type model (SPEC §9.3, the right-click contract).
//
// One vocabulary for every right-click on a work widget. A surface computes a
// MenuContext describing what was clicked, providers emit MenuContribution
// rows, and resolveMenu folds them into the CtxMenuItem[] that the kit
// (components/CanvasContextMenu) draws. Every widget header menu, every widget
// body menu, the multi-selection, the section handle, the focus dock, the
// columns view and the desk jump list come out of the one resolver, so the
// groups, labels and ceiling cannot drift between them.
//
// ── The groups (SPEC §9.3), in this order, one separator between non-empty ones
//
//   'object'      Open FIRST, then Add to Focus… (E-1, owner ruling), then
//                 Rename / kind rows / Share…
//   'clipboard'   Copy · Paste · Insert snippet… · Duplicate · Duplicate, keep synced
//   'arrange'     Bring to front (layered objects)
//   'plexii'      Save selection as snippet… · Ask PlexiiAssist · AI assist ▸
//   'more'        More actions ▸: everything past the eight-row ceiling (E-6),
//                 plus rows that always live there (Create & link ▸, Pin ▸, …)
//   'destructive' last, behind its own separator, every row `danger`:
//                 Remove from this desk · Archive · Move to Trash (E-2, owner
//                 ruling), or Archive · Delete for a desk-only kind
//
// ── For a widget BODY that wants rows of its own (the provider API) ──────────
//
// A body never builds its own menu. It contributes MenuContribution rows and the
// resolver places them, counts them against the ceiling and folds the overflow
// into More actions. Two ways in, depending on whether the row needs component
// state:
//
//   1. By kind, for rows that only need the widget (registry.ts):
//        registerWidgetContextActions('table', 'cell', (ctx) => ({
//          context: [{ id: 'table/add-row', group: 'object', priority: 0,
//                      label: 'Add row', icon: 'add', onSelect: … }],
//          suppress: { 'ai-assist': true }
//        }))
//      The optional granularity ('cell', 'node', …) is matched against the
//      `granularity` a body passes when it opens the menu.
//
//   2. Per instance, for rows that close over the body's own state (a dialog
//      to open, a mode to toggle): pass `menuContributions` to WidgetFrame (the
//      header AND every body right-click then carry them), or `contributions`
//      to UnifiedConnectedMenu for one body menu. Same MenuContribution shape.
//
//   Choosing the group: 'object' for what the body is about (Configure…, Add
//   row, Reload); 'clipboard' for its own Cut / Copy / Paste variants; 'arrange'
//   for layering; 'more' for anything rarely needed (it never takes a top-level
//   row); `danger: true` sends a row to the destructive group (Delete row,
//   Reset deck…) whatever `group` says. `priority` orders rows inside a group
//   (lower first). Labels for shared actions come from MENU
//   (src/shared/menus/lexicon.ts); "…" (U+2026) when the row opens a dialog.
//   A row that applies but cannot run right now sets `enabled` false plus
//   `disabledReason` (rendered as the kit's `hint`); a row that cannot apply is
//   left out (`predicate`).
//
//   `headerExtras` (raw CtxMenuItem[], the old headerMenuExtras) still work:
//   they join the object group, count against the ceiling, and fold like any
//   other object row. Prefer contributions for anything new.
//
// ── Right-click precedence inside a widget (one rule, applied in WidgetFrame) ─
// See bodyMenuTarget() in ./bodyTarget.ts: a body's own content menu first,
// then the native text menu for editable fields and selected text, then the
// native web menu inside a <webview>, and otherwise this widget menu.

import type { Widget, WidgetKind } from '@shared/types'
import type { CtxMenuItem } from '../../components/CanvasContextMenu'

/** The §9.3 groups, in the order they render. */
export type MenuGroup = 'object' | 'clipboard' | 'arrange' | 'plexii' | 'more' | 'destructive'

export const MENU_GROUP_ORDER: readonly MenuGroup[] = ['object', 'clipboard', 'arrange', 'plexii', 'more', 'destructive']

// Legacy section ids. Kept so a provider written against the eight-band model
// still compiles: a contribution without `group` is placed by its section
// (Context → object, Destructive → destructive, the rest → more).
export enum MenuSection {
  Context = 0,
  AiAssist = 1,
  Create = 2,
  Convert = 3,
  Organise = 4,
  Share = 5,
  Advanced = 6,
  Destructive = 7
}

// What the user right-clicked. The object identifies the target; the optional
// sub narrows it to a granularity inside a widget (a table cell, a mind-map
// node); selection carries any highlighted text or media so AI assist and
// Create can both inherit it.
export type ObjectKind =
  | { type: 'empty-canvas' }
  | { type: 'widget'; widget: Widget }
  | { type: 'multi'; widgets: Widget[] }

export interface MenuSelection {
  text?: string
  imageUrl?: string
  linkUrl?: string
  sourceWidgetId: string
  sourceKind: WidgetKind
}

/**
 * Which removal rows a placement offers (E-2). 'full': Archive plus the
 * explicit Remove from this desk / Move to Trash (or Delete for a desk-only
 * kind). 'archive-only': a section, whose children must be ejected first.
 * 'none': a host owns removal (a work widget embedded in a document).
 */
export type RemovalMode = 'full' | 'archive-only' | 'none'

// Management actions supplied by whoever hosts the widget (WidgetFrame, the
// section handle, the focus dock), so the unified menu can offer them without
// reimplementing their logic. Each is present only when it applies.
export interface FrameCallbacks {
  onMakeTask?: () => void
  onShare?: () => void
  onDuplicateSynced?: () => void
  onDuplicateIndependent?: () => void
  onEjectFromSection?: () => void
  onUnlinkSynced?: () => void
  /** Start renaming the object in place (the header title, a list row). */
  onRename?: () => void
  // Widget files (docs/widget-files.md): promote a desk widget to a file that
  // lives in Files and can sit on other desks, or open the file this widget is
  // an instance of.
  onSaveAsFile?: () => void
  onOpenFile?: () => void
  // Saved snippets: keep this widget's shape and content as a reusable one.
  // Distinct from onSaveAsFile (one object in several places): a snippet is a
  // template.
  onSaveAsSnippet?: () => void
  // The other direction: put a saved snippet INTO this widget, converted to
  // what it holds. Present only on the work widgets that take inserted content.
  onInsertSnippet?: () => void
  // Paste the clipboard into this widget through the same conversion as an
  // insert. Present only on widgets that take pasted content.
  onPaste?: () => void
  /** Which removal rows apply here; 'full' when absent. */
  removal?: RemovalMode
}

export interface MenuContext {
  object: ObjectKind
  // The granularity inside a widget, e.g. { granularity: 'cell', payload: {...} }.
  sub?: { granularity: string; payload: Record<string, unknown> }
  selection?: MenuSelection
  taskId: string
  // Canvas-space and screen-space coordinates of the click.
  canvasPoint: { x: number; y: number }
  clientPoint: { x: number; y: number }
  frame?: FrameCallbacks
  // Raw kind-specific rows a widget passes through (the old headerMenuExtras).
  // They join the object group and count against the ceiling.
  headerExtras?: CtxMenuItem[]
  /** Per-instance rows from a body or host (see the provider API above). */
  contributions?: MenuContribution[]
  /**
   * Put Rename at the very top (E-11, the desk jump list, where right-click
   * used to BE rename). Everywhere else Open, then Add to Focus…, lead (E-1).
   */
  renameFirst?: boolean
}

// The unit every provider emits. It mirrors CtxMenuItem's fields so the final
// mapping is near-identity, and adds the routing the resolver needs.
export interface MenuContribution {
  id: string // stable, namespaced: "core/duplicate", "<pluginId>/<action>"
  /** Legacy placement; `group` wins when both are set. */
  section?: MenuSection
  /** The §9.3 group this row joins. `danger` overrides it with 'destructive'. */
  group?: MenuGroup
  priority: number // lower sorts first inside its group
  label: string
  icon?: string
  shortcut?: string
  /** Destructive: always the last group, drawn in the danger colour. */
  danger?: boolean
  /** A toggle or a choice among siblings: the kit draws a check, never text. */
  checked?: boolean
  testid?: string
  /** An Open row (Open, Open in browser, Open file, Show in full view): leads the object group (E-1, resolve.ts OBJECT_LEAD). */
  opens?: boolean
  /** Inside a submenu: draw a separator above this row (its own run of rows). */
  separatorBefore?: boolean
  /**
   * How readily the row leaves the top level when the menu is over its
   * ceiling: higher folds into More actions first. Absent: the resolver's
   * default for the row's group (resolve.ts FOLD).
   */
  fold?: number
  predicate?: (ctx: MenuContext) => boolean // false HIDES the row
  enabled?: (ctx: MenuContext) => boolean // passes predicate + false => shown disabled
  disabledReason?: (ctx: MenuContext) => string | undefined
  onSelect?: (ctx: MenuContext) => void | Promise<void>
  children?: MenuContribution[]
}

// The universal rows a provider may switch off for its object. Each key names
// one row (or one family) the resolver would otherwise add.
export type UniversalKey =
  | 'attention'
  | 'rename'
  | 'share'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'arrange'
  | 'snippet'
  | 'ask-assist'
  | 'ai-assist'
  | 'create'
  | 'convert'
  | 'pin'
  | 'recolor'
  | 'flag'
  | 'organise'
  | 'advanced'
  | 'destructive'

export interface WidgetContribution {
  // The provider's rows. Historically "context" (they all landed in the
  // Context band); each may now name its §9.3 group.
  context: MenuContribution[]
  // Set a key to true to omit that universal row for this object.
  suppress?: Partial<Record<UniversalKey, boolean>>
}

export type WidgetContextProvider = (ctx: MenuContext) => WidgetContribution
