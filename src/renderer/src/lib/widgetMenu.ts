// The side menu's Widgets section — which kinds it lists, and how they split
// between the main list and the collapsed "Other widgets" accordion.
//
// Pure: no React, no stores, no storage. The section component and the tests
// both drive it. Persistence lives in widgetMenuPrefs.ts.
//
// WHICH KINDS. Every kind the add-widget catalogue offers, minus any kind an
// app under Apps already is (SEGMENT_APPS.office[].widgetKinds, plus the kinds
// a connected app becomes when dragged onto a desk). That set is DERIVED from
// the Apps registry, never hand-listed here: add an app with its widget kinds
// and they leave this section by themselves.

import type { WidgetKind } from '@shared/types'
import { isStandaloneWidgetKind } from '@shared/widgetFiles'
import { SEGMENT_APPS } from './segmentApps'
import { WIDGET_CATALOG, catalogFor, type WidgetCatalogEntry } from './widgetCatalog'

/**
 * What a Connected App tile becomes on a desk (Canvas handleDrop): a browser
 * widget bound to the app, or a launcher tile for a local app. Connected apps
 * are a user-built list rather than a static registry, so their kinds are named
 * here, beside the registry read.
 */
export const CONNECTED_APP_WIDGET_KINDS: readonly WidgetKind[] = ['webview', 'local-app-launcher']

/**
 * Kinds that ARE a place the side menu already lists outside Apps. The
 * Attention widget is the Desk section's Attention area on a desk; listing it
 * again under Widgets put two "Attention" entries in one menu, reading as the
 * same thing. It stays addable from the canvas right-click menu and the command
 * palette ("Add Attention to desk").
 */
export const MENU_AREA_WIDGET_KINDS: readonly WidgetKind[] = ['attention']

/** Every widget kind an app under Apps (or a connected app) already represents. */
export function kindsRepresentedByApps(
  apps: ReadonlyArray<{ key: string; widgetKinds?: readonly WidgetKind[] }> = SEGMENT_APPS.office
): Set<WidgetKind> {
  const out = new Set<WidgetKind>([...CONNECTED_APP_WIDGET_KINDS, ...MENU_AREA_WIDGET_KINDS])
  for (const a of apps) for (const k of a.widgetKinds ?? []) out.add(k)
  return out
}

/** The kind dropping an app tile on a desk creates, or undefined (not draggable). */
export function tileWidgetKind(app: { key: string; widgetKinds?: readonly WidgetKind[] }): WidgetKind | undefined {
  // Only a kind the catalogue knows: Meet's meeting record is minted by the
  // wrap-up and deliberately never hand-placed as an empty shell.
  return (app.widgetKinds ?? []).find((k) => catalogFor(k) !== null)
}

/** The kinds the Widgets section lists, in catalogue order. */
export function widgetMenuEntries(
  catalog: readonly WidgetCatalogEntry[] = WIDGET_CATALOG,
  represented: ReadonlySet<WidgetKind> = kindsRepresentedByApps()
): WidgetCatalogEntry[] {
  return catalog.filter((e) => !e.hideFromPicker && !represented.has(e.kind))
}

/**
 * The eight that open in the main list on a fresh profile: the widgets people
 * reach for most — capture, lists, numbers and thinking. Anything else starts
 * under Other widgets, one click away. A kind that is not in the section (say,
 * an app took it over) is simply skipped.
 */
export const DEFAULT_MAIN_WIDGETS: readonly WidgetKind[] = [
  'sticky',
  'note',
  'task-list',
  'table',
  'page',
  'mindmap',
  'chart',
  'timer'
]

/** Persisted shape: the user's order for each list. Kinds, not entries. */
export interface WidgetMenuPrefs {
  main: string[]
  other: string[]
}

export interface WidgetMenuSplit {
  main: WidgetCatalogEntry[]
  other: WidgetCatalogEntry[]
}

/**
 * Resolve saved prefs against what this build offers.
 *
 * - A kind saved in either list keeps its list and its place.
 * - A kind this build no longer offers is dropped (it cannot be shown).
 * - A kind the prefs have never seen — new in this release — goes to Other
 *   widgets, at the end, unless there are no prefs at all, when the defaults
 *   apply. A new widget never pushes itself into someone's arranged main list.
 */
export function splitWidgetMenu(
  prefs: WidgetMenuPrefs | null,
  entries: readonly WidgetCatalogEntry[] = widgetMenuEntries()
): WidgetMenuSplit {
  const byKind = new Map(entries.map((e) => [e.kind as string, e]))
  if (!prefs) {
    const main = DEFAULT_MAIN_WIDGETS.map((k) => byKind.get(k)).filter((e): e is WidgetCatalogEntry => !!e)
    const inMain = new Set(main.map((e) => e.kind))
    return { main, other: entries.filter((e) => !inMain.has(e.kind)) }
  }
  const seen = new Set<string>()
  const pick = (kinds: readonly string[]): WidgetCatalogEntry[] => {
    const out: WidgetCatalogEntry[] = []
    for (const k of kinds) {
      const e = byKind.get(k)
      if (!e || seen.has(k)) continue
      seen.add(k)
      out.push(e)
    }
    return out
  }
  const main = pick(prefs.main)
  const other = pick(prefs.other)
  for (const e of entries) if (!seen.has(e.kind)) other.push(e)
  return { main, other }
}

/** Prefs that reproduce a split exactly (for writing back after a move). */
export function prefsFromSplit(split: WidgetMenuSplit): WidgetMenuPrefs {
  return { main: split.main.map((e) => e.kind), other: split.other.map((e) => e.kind) }
}

/**
 * Move `kind` into `to`, before `beforeKind` when given (and present in `to`),
 * else at the end. Works for a reorder within one list too. Returns new prefs.
 */
export function moveWidgetKind(
  prefs: WidgetMenuPrefs | null,
  kind: string,
  to: 'main' | 'other',
  beforeKind: string | null = null,
  entries: readonly WidgetCatalogEntry[] = widgetMenuEntries()
): WidgetMenuPrefs {
  const current = prefsFromSplit(splitWidgetMenu(prefs, entries))
  if (!current.main.includes(kind) && !current.other.includes(kind)) return current
  const main = current.main.filter((k) => k !== kind)
  const other = current.other.filter((k) => k !== kind)
  const list = to === 'main' ? main : other
  const at = beforeKind && beforeKind !== kind ? list.indexOf(beforeKind) : -1
  if (at >= 0) list.splice(at, 0, kind)
  else list.push(kind)
  return { main, other }
}

/** Defensive parse of a stored value; null when absent or unusable. */
export function parseWidgetMenuPrefs(raw: unknown): WidgetMenuPrefs | null {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (!Array.isArray(r.main) || !Array.isArray(r.other)) return null
  return {
    main: r.main.filter((k): k is string => typeof k === 'string'),
    other: r.other.filter((k): k is string => typeof k === 'string')
  }
}

/** Clicking a kind: a standalone file, or (desk-only kinds) onto the open desk. */
export function clickActionFor(kind: WidgetKind, deskOpen: boolean): 'create-file' | 'add-to-desk' | 'needs-desk' {
  if (isStandaloneWidgetKind(kind)) return 'create-file'
  return deskOpen ? 'add-to-desk' : 'needs-desk'
}

/**
 * The tooltip of a kind in the Work widgets section: its catalogue hint, plus
 * what a click and a drag make where they differ. They differ for the task
 * list (docs/widget-files.md, "Task lists"): placed onto a desk it shows that
 * desk's tasks; made on its own it keeps a list of its own.
 */
export function widgetMenuHint(entry: Pick<WidgetCatalogEntry, 'kind' | 'hint'>): string {
  if (entry.kind === 'task-list') {
    return (
      "Drag onto a desk, or right-click and Add to this desk: that desk's tasks. " +
      'Click: a task list of its own, saved in Files, with the same items on any desk you place it on.'
    )
  }
  const lead = entry.hint.trim().replace(/[.!?]$/, '')
  if (!isStandaloneWidgetKind(entry.kind)) return `${lead}. Only works on a desk.`
  return `${lead}. Click for a new one in Files, or drag it onto a desk.`
}
