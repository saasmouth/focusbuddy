// The empty-canvas menu (SPEC §9.3, the second standard shape):
//
//   Paste · Insert snippet… | Add object ▸ (create here) | Select all | view rows
//
// Plain data built from the handlers Canvas passes, so the guard test builds
// exactly what the app shows. Every hint here is a key Canvas really binds:
// ⌘V (desk/deskSnippets useDeskPaste), ⌘A (select every selectable widget),
// ⌘H (centre on home) and ⌘0 (reset view), all in Canvas's keydown handlers.

import type { CtxMenuItem } from '../../components/CanvasContextMenu'
import { MENU } from '@shared/menus/lexicon'
import { shortcutLabel } from '@shared/menus/shortcuts'
import {
  CATEGORIES,
  entriesByCategory,
  isAdvancedKind,
  type WidgetCatalogEntry,
  type WidgetCategory
} from '../widgetCatalog'

const CATEGORY_ICON: Record<WidgetCategory, string> = {
  Notes: 'sticky_note_2',
  Web: 'public',
  Files: 'folder',
  Tools: 'build',
  Comms: 'mail',
  Layout: 'crop_free'
}

/**
 * Add object ▸: the core kinds grouped by category, then one Advanced group for
 * the powerful-but-intimidating kinds (agents, webhooks, diagram, mind map),
 * matching the widget palette. `onAdd` places the kind at the click; Canvas
 * gates it on capabilities the same way the palette does.
 */
export function addObjectItem(onAdd: (entry: WidgetCatalogEntry) => void): CtxMenuItem {
  const grouped = entriesByCategory()
  const toItem = (entry: WidgetCatalogEntry): CtxMenuItem => ({
    label: entry.label,
    icon: entry.icon,
    entity: { kind: 'widget', id: entry.kind },
    onClick: () => onAdd(entry)
  })
  const coreGroups: CtxMenuItem[] = CATEGORIES.map((cat) => ({
    label: cat,
    icon: CATEGORY_ICON[cat],
    children: grouped[cat].filter((e) => !isAdvancedKind(e.kind)).map(toItem)
  })).filter((group) => (group.children?.length ?? 0) > 0)
  // Advanced kinds across every category, kept individually selectable.
  const advanced = CATEGORIES.flatMap((cat) => grouped[cat].filter((e) => isAdvancedKind(e.kind)))
  return {
    label: 'Add object',
    icon: 'add',
    testid: 'canvas-ctx-add-object',
    children: [...coreGroups, ...(advanced.length ? [{ label: 'Advanced', icon: 'tune', children: advanced.map(toItem) }] : [])]
  }
}

export interface EmptyCanvasHandlers {
  /** The Add object ▸ tree (categories ▸ kinds), built by Canvas from the catalog. */
  addObject: CtxMenuItem
  onPaste: () => void
  onInsertSnippet: () => void
  /** Select every selectable work widget; null when the desk has none (shown disabled, with why). */
  onSelectAll: (() => void) | null
  onFitAll: () => void
  onResetView: () => void
  onGroupByType: () => void
  onStackByType: () => void
  /** This device keeps its own layout (PLX-APP-010 Phase 2): a toggle, drawn checked. */
  customLayout: boolean
  onToggleCustomLayout: () => void
}

export function buildEmptyCanvasMenu(h: EmptyCanvasHandlers, platform: string): CtxMenuItem[] {
  const key = (k: Parameters<typeof shortcutLabel>[0]): string => shortcutLabel(k, platform)
  return [
    // Paste what is on the clipboard here, as the work widget that holds it.
    { label: MENU.paste.label, icon: 'content_paste', shortcut: key(MENU.paste.keys), onClick: h.onPaste, testid: 'canvas-ctx-paste' },
    // Place a saved snippet here (was "Add object ▸ From a saved snippet…": one route now).
    { label: MENU.insertSnippet.label, icon: 'bookmarks', onClick: h.onInsertSnippet, testid: 'canvas-ctx-insert-snippet' },
    { separator: true },
    h.addObject,
    { separator: true },
    h.onSelectAll
      ? { label: MENU.selectAll.label, icon: 'select_all', shortcut: key(MENU.selectAll.keys), onClick: h.onSelectAll, testid: 'canvas-ctx-select-all' }
      : { label: MENU.selectAll.label, icon: 'select_all', disabled: true, hint: 'Nothing on this desk to select', testid: 'canvas-ctx-select-all' },
    { separator: true },
    { label: 'Home — fit all to view', icon: 'home', shortcut: key(['mod', 'h']), onClick: h.onFitAll, testid: 'canvas-ctx-home' },
    { label: 'Reset view', icon: 'center_focus_strong', shortcut: key(['mod', '0']), onClick: h.onResetView, testid: 'canvas-ctx-reset-view' },
    {
      label: 'Auto-arrange',
      icon: 'view_module',
      children: [
        { label: 'Group by type', icon: 'workspaces', onClick: h.onGroupByType },
        { label: 'Stack by type', icon: 'layers', onClick: h.onStackByType }
      ]
    },
    {
      // A toggle reads as one label with a check (F-13), not two labels.
      label: "Customise this device's layout",
      checked: h.customLayout,
      onClick: h.onToggleCustomLayout,
      testid: 'canvas-ctx-custom-layout'
    }
  ]
}
