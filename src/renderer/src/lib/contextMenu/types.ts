// Unified context-menu type model.
//
// One vocabulary for every right-click in PlexiDesk. A surface computes a
// MenuContext describing what was clicked, providers emit MenuContribution
// rows against the eight canonical sections, and resolveMenu folds those into
// the CtxMenuItem[] that the existing CanvasContextMenu renderer draws. The
// renderer is never rewritten; this is purely the resolution layer that sits
// in front of it (see docs/context-menu-system-spec.md sections 1 and 2).

import type { Widget, WidgetKind } from '@shared/types'

// The eight canonical sections, in fixed order. The numeric value doubles as
// the sort key so identical ordering is a property of the data, not something
// each surface has to reproduce. Destructive is always last.
export enum MenuSection {
  Context = 0, // 1. Context-specific actions for the exact object clicked
  AiAssist = 1, // 2. AI Assist
  Create = 2, // 3. Create + connect a new widget
  Convert = 3, // 4. Convert / reinterpret as another kind
  Organise = 4, // 5. Section membership, layering, grouping
  Share = 5, // 6. Share, copy out, export
  Advanced = 6, // 7. Power-user / rarely needed
  Destructive = 7 // 8. Archive, delete, remove, unlink (ALWAYS LAST)
}

// What the user right-clicked. The object identifies the target; the optional
// sub narrows it to a granularity inside a widget (a table cell, a mind-map
// node); selection carries any highlighted text or media so AI Assist and
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

// Widget-frame management actions, supplied by WidgetFrame so the unified menu
// can offer them without reimplementing (and risking) their logic. Each is
// present only when it applies to the widget that was clicked.
export interface FrameCallbacks {
  onMakeTask: () => void
  onShare: () => void
  onDuplicateSynced: () => void
  onDuplicateIndependent: () => void
  onDuplicateToFolder?: () => void
  onEjectFromSection?: () => void
  onUnlinkSynced?: () => void
  // Widget files (docs/widget-files.md): promote a desk widget to a file that
  // lives in Files and can sit on other desks, or open the file this widget is
  // an instance of.
  onSaveAsFile?: () => void
  onOpenFile?: () => void
  // Saved snippets: keep this widget's shape and content as a reusable one, so
  // a widget you set up often can be placed on any desk again. Distinct from
  // onSaveAsFile, which makes ONE widget appear in several places with its
  // edits flowing both ways. A snippet is a template; a file is one object.
  onSaveAsSnippet?: () => void
  // The other direction: put a saved snippet INTO this widget, converted to
  // what it holds (a sheet block into a page lands as a table). Present only
  // on the work widgets that take inserted content.
  onInsertSnippet?: () => void
  // Paste the clipboard into this widget through the same conversion as an
  // insert. Present only on widgets that take pasted content.
  onPaste?: () => void
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
  // Widget-frame management actions, when this menu is for a single widget that
  // sits in a frame. Lets the unified menu carry make-task, share, duplicate,
  // eject, and unlink without porting their logic out of WidgetFrame.
  frame?: FrameCallbacks
  // Raw kind-specific rows a widget passes through (the old headerMenuExtras),
  // prepended to the Context band.
  headerExtras?: import('../../components/CanvasContextMenu').CtxMenuItem[]
}

// The unit every provider emits. It mirrors the field vocabulary of
// CtxMenuItem so the final mapping is near-identity, and adds the routing
// metadata the resolver needs: which section it joins, its group and priority
// within that section, a predicate that hides it when false, and an enabled
// gate that shows it disabled-with-reason when the predicate passes but enabled
// is false.
export interface MenuContribution {
  id: string // stable, namespaced: "core/duplicate", "<pluginId>/<action>"
  section: MenuSection
  group?: string
  priority: number // lower sorts first; most-common = lowest number
  label: string
  icon?: string
  shortcut?: string
  danger?: boolean // forces the Destructive band; cannot live elsewhere
  predicate?: (ctx: MenuContext) => boolean // false HIDES the row
  enabled?: (ctx: MenuContext) => boolean // passes predicate + false => shown disabled
  disabledReason?: (ctx: MenuContext) => string | undefined
  onSelect?: (ctx: MenuContext) => void | Promise<void>
  children?: MenuContribution[]
}

// A widget provider contributes Context-band rows for a (kind, granularity)
// pair, and may suppress universal sections it does not want for that object.
export type UniversalKey =
  | 'ai-assist'
  | 'create'
  | 'convert'
  | 'organise'
  | 'share'
  | 'advanced'
  | 'destructive'

export interface WidgetContribution {
  // Context-band rows. These are the only rows allowed into section 1.
  context: MenuContribution[]
  // Set a key to false to omit that universal section for this object.
  suppress?: Partial<Record<UniversalKey, boolean>>
}

export type WidgetContextProvider = (ctx: MenuContext) => WidgetContribution
