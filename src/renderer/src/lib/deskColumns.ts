import type { Widget, WidgetKind, WidgetLink } from '@shared/types'
import { catalogFor } from './widgetCatalog'
import { widgetDisplayName } from './widgetDisplayName'

// Configuration + geometry for the desk Columns view. A desk's objects can be
// laid out into vertical, independently scrolling columns. Columns are either
// hand-made ("freeform" — you place things where you want), a real board keyed
// off each object's status (drag to change it), or derived from a grouping key
// (Type, Colour, Connections, Section, Recency, Topic). The config is a local
// viewing preference (localStorage per desk); the one exception is status, which
// is a real synced field on the widget so a board means the same thing everywhere.

export type GroupBy =
  | 'freeform'
  | 'status'
  | 'kind'
  | 'color'
  | 'connections'
  | 'section'
  | 'recency'
  | 'topic'

// The status board's columns. `id` is the value stored on widget.status; a widget
// with no status (null) lands in the first column ('todo'). Kept small and ordered
// so the board reads left-to-right as work progresses, with a Reference lane for
// things you keep around rather than act on.
export const STATUS_COLUMNS: DeskColumn[] = [
  { id: 'todo', title: 'To sort' },
  { id: 'doing', title: 'In progress' },
  { id: 'done', title: 'Done' },
  { id: 'reference', title: 'Reference' }
]
export function statusColumnId(status: string | null | undefined): string {
  const s = (status ?? '').toLowerCase()
  return STATUS_COLUMNS.some((c) => c.id === s) ? s : 'todo'
}

// Extra data some grouping modes need beyond the widgets themselves: the wire
// graph for Connections, and an AI-produced topic label per widget for Topic.
export interface BuildColumnsCtx {
  links?: WidgetLink[]
  topicByWidget?: Record<string, string>
}

export interface DeskColumn {
  id: string
  title: string
}

export interface DeskColumnsConfig {
  groupBy: GroupBy
  // Freeform only: the user's columns and which column each widget sits in.
  columns: DeskColumn[]
  assign: Record<string, string> // widgetId -> columnId
  order: Record<string, number> // widgetId -> sort order within its column
  // Manual per-column width override (columnId -> px). When absent for a column,
  // its width is content-driven (widest item + padding). Applies across modes,
  // keyed by the column id each mode produces.
  widths?: Record<string, number>
}

// Bounds for a manually-resized column.
export const COLUMN_MIN_W = 220
export const COLUMN_MAX_W = 960

const KEY_PREFIX = 'fb.deskColumns.v1.'

export function defaultColumnsConfig(): DeskColumnsConfig {
  return {
    groupBy: 'freeform',
    columns: [
      { id: 'col-1', title: 'To sort' },
      { id: 'col-2', title: 'In progress' },
      { id: 'col-3', title: 'Reference' }
    ],
    assign: {},
    order: {},
    widths: {}
  }
}

export function loadColumnsConfig(taskId: string): DeskColumnsConfig {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + taskId)
    if (!raw) return defaultColumnsConfig()
    const parsed = JSON.parse(raw) as Partial<DeskColumnsConfig>
    const base = defaultColumnsConfig()
    return {
      groupBy: parsed.groupBy ?? base.groupBy,
      columns: Array.isArray(parsed.columns) && parsed.columns.length > 0 ? parsed.columns : base.columns,
      assign: parsed.assign ?? {},
      order: parsed.order ?? {},
      widths: parsed.widths ?? {}
    }
  } catch {
    return defaultColumnsConfig()
  }
}

export function saveColumnsConfig(taskId: string, cfg: DeskColumnsConfig): void {
  try {
    localStorage.setItem(KEY_PREFIX + taskId, JSON.stringify(cfg))
  } catch {
    /* ignore */
  }
}

// Move the dragged freeform column so it sits just before the target column
// (spec §3.3 "columns … reordered"). Pure: returns a new array, leaves the input
// untouched, and no-ops on a self-drop or an unknown id.
export function reorderColumns(columns: DeskColumn[], dragId: string, targetId: string): DeskColumn[] {
  if (dragId === targetId) return columns
  const from = columns.findIndex((c) => c.id === dragId)
  if (from < 0 || !columns.some((c) => c.id === targetId)) return columns
  const next = columns.slice()
  const [moved] = next.splice(from, 1)
  const insertAt = next.findIndex((c) => c.id === targetId)
  next.splice(insertAt, 0, moved)
  return next
}

// The width a widget wants to be shown at in a column. Uses the catalog's ideal
// width for the kind (docs/sheets/slides/design/maps are wide; stickies,
// calculators, colours are narrow), falling back to the widget's own width, then
// clamped so a single very wide kind (e.g. webview at 1920) doesn't make a column
// absurdly wide, and nothing gets narrower than a legible minimum.
const ITEM_MIN_W = 240
const ITEM_MAX_W = 760
export function naturalItemWidth(w: Widget): number {
  const ideal = catalogFor(w.kind)?.defaultWidth ?? w.width ?? 320
  return Math.max(ITEM_MIN_W, Math.min(ITEM_MAX_W, Math.round(ideal)))
}

// A sensible card height per item so a column reads as a wall of cards rather
// than a few giant blocks. Honours the widget's own height within bounds.
export function itemCardHeight(w: Widget): number {
  const tall = new Set<WidgetKind>(['doc', 'sheet', 'slides', 'design', 'map', 'mindmap', 'diagram', 'webview', 'pdf', 'scratchpad', 'living-doc'])
  const min = 150
  const max = tall.has(w.kind) ? 520 : 360
  return Math.max(min, Math.min(max, Math.round(w.height || 240)))
}

// Which top-level objects appear in the Columns view: real free widgets, not
// pinned chrome, minimaps, sections or section children.
export function columnsEligible(widgets: Widget[]): Widget[] {
  return widgets.filter(
    (w) => !w.archived && !w.pinned && w.parentSectionId === null && w.kind !== 'minimap' && w.kind !== 'section'
  )
}

// ── Grouping by type ──────────────────────────────────────────────────────────
// Collapse the many widget kinds into a handful of human column names.
const KIND_GROUP: Partial<Record<WidgetKind, string>> = {
  doc: 'Documents', gdoc: 'Documents', page: 'Documents', note: 'Documents', markdown: 'Documents', 'living-doc': 'Documents', scratchpad: 'Documents',
  sheet: 'Spreadsheets', gsheet: 'Spreadsheets',
  slides: 'Slides', gslide: 'Slides',
  design: 'Designs',
  map: 'Diagrams', mindmap: 'Diagrams', diagram: 'Diagrams',
  table: 'Tables', field: 'Tables', 'custom-block': 'Tables',
  sticky: 'Notes', card: 'Notes',
  webview: 'Web & links', pdf: 'Web & links', email: 'Web & links', portal: 'Web & links',
  file: 'Files', drive: 'Files', image: 'Files', video: 'Files', 'voice-recorder': 'Files',
  calculator: 'Tools', color: 'Tools', timer: 'Tools', streamdeck: 'Tools', 'local-app-launcher': 'Tools', shape: 'Tools', chart: 'Tools',
  agent: 'AI', 'chat-thread': 'AI', 'mail-thread': 'Comms', 'task-link': 'Links'
}
export function kindGroupLabel(kind: WidgetKind): string {
  return KIND_GROUP[kind] ?? 'Other'
}

export function colorLabel(color: string | null | undefined): string {
  return color ? color.toLowerCase() : 'No label'
}

export interface BuiltColumn {
  id: string
  title: string
  swatch?: string | null // for colour grouping
  items: Widget[]
  width: number // content-driven column width (widest item + padding)
}

const COLUMN_PADDING = 28 // horizontal breathing room inside a column

// Widgets eligible for the Section mode: unlike the default set, section CHILDREN
// are included (that's the whole point — group them under their section), while the
// section containers, minimaps, pinned chrome and archived items are still excluded.
function sectionEligible(widgets: Widget[]): Widget[] {
  return widgets.filter(
    (w) => !w.archived && !w.pinned && w.kind !== 'minimap' && w.kind !== 'section'
  )
}

// Connected components over the wire graph, restricted to the eligible widgets.
// Returns clusters of size >= 2 (things actually wired together) plus the set of
// widget ids that are unconnected.
function linkClusters(items: Widget[], links: WidgetLink[]): { clusters: string[][]; loose: Set<string> } {
  const present = new Set(items.map((w) => w.id))
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b))
  }
  for (const w of items) parent.set(w.id, w.id)
  for (const l of links) {
    if (present.has(l.sourceWidgetId) && present.has(l.targetWidgetId)) union(l.sourceWidgetId, l.targetWidgetId)
  }
  const groups = new Map<string, string[]>()
  for (const w of items) {
    const root = find(w.id)
    const arr = groups.get(root) ?? []
    arr.push(w.id)
    groups.set(root, arr)
  }
  const clusters: string[][] = []
  const loose = new Set<string>()
  for (const ids of groups.values()) {
    if (ids.length >= 2) clusters.push(ids)
    else loose.add(ids[0])
  }
  return { clusters, loose }
}

// Bucket a creation timestamp into a human recency band.
function recencyBucket(createdAt: number, now: number): { id: string; label: string; order: number } {
  const day = 86_400_000
  const startOfToday = now - (now % day)
  if (createdAt >= startOfToday) return { id: 'today', label: 'Today', order: 0 }
  if (createdAt >= startOfToday - 6 * day) return { id: 'week', label: 'This week', order: 1 }
  if (createdAt >= startOfToday - 29 * day) return { id: 'month', label: 'This month', order: 2 }
  return { id: 'older', label: 'Earlier', order: 3 }
}

// Build the columns to render for the current config + widgets. `ctx` carries the
// extra inputs some modes need (the wire graph for Connections, AI topic labels for
// Topic); modes that don't need it ignore it.
export function buildColumns(widgets: Widget[], cfg: DeskColumnsConfig, ctx: BuildColumnsCtx = {}): BuiltColumn[] {
  const items = columnsEligible(widgets)
  const withWidth = (id: string, title: string, list: Widget[], swatch?: string | null): BuiltColumn => {
    // A manual width override wins; otherwise the column is as wide as its widest
    // item plus padding.
    const override = cfg.widths?.[id]
    const maxW = list.reduce((m, w) => Math.max(m, naturalItemWidth(w)), ITEM_MIN_W)
    const width = override != null ? override : maxW + COLUMN_PADDING
    return { id, title, items: list, width, swatch }
  }

  // Status board: every object sits in the column matching its status field, with
  // the standard ordered lanes always shown (even when empty) so you can drag into
  // them. The column id IS the status value, so a drop can set it directly.
  if (cfg.groupBy === 'status') {
    const byStatus = new Map<string, Widget[]>()
    for (const c of STATUS_COLUMNS) byStatus.set(c.id, [])
    for (const w of items) byStatus.get(statusColumnId(w.status))!.push(w)
    for (const list of byStatus.values()) list.sort((a, b) => a.createdAt - b.createdAt)
    return STATUS_COLUMNS.map((c) => withWidth(c.id, c.title, byStatus.get(c.id) ?? []))
  }

  // Connections: one column per wired cluster, plus a trailing column for the
  // objects that aren't wired to anything. Nothing to group when there are no wires.
  if (cfg.groupBy === 'connections') {
    const { clusters, loose } = linkClusters(items, ctx.links ?? [])
    const byId = new Map(items.map((w) => [w.id, w]))
    const cols: BuiltColumn[] = clusters.map((ids, i) => {
      const list = ids.map((id) => byId.get(id)!).filter(Boolean)
      const lead = list.find((w) => (w.title || '').trim()) ?? list[0]
      const name = lead ? widgetDisplayName(lead) : `Group ${i + 1}`
      return withWidth('cluster:' + i, `Linked · ${name}`, list)
    })
    const looseList = items.filter((w) => loose.has(w.id))
    if (looseList.length || cols.length === 0) cols.push(withWidth('cluster:loose', 'Unconnected', looseList))
    return cols
  }

  // Section: group by the on-canvas section each object belongs to, titled by the
  // section, with free objects in a trailing "Ungrouped" column. Uses its own
  // eligibility so section CHILDREN are included.
  if (cfg.groupBy === 'section') {
    const secItems = sectionEligible(widgets)
    const titles = new Map<string, string>()
    for (const w of widgets) if (w.kind === 'section') titles.set(w.id, w.title || 'Section')
    const bySection = new Map<string, Widget[]>()
    const free: Widget[] = []
    for (const w of secItems) {
      if (w.parentSectionId && titles.has(w.parentSectionId)) {
        const arr = bySection.get(w.parentSectionId) ?? []
        arr.push(w)
        bySection.set(w.parentSectionId, arr)
      } else {
        free.push(w)
      }
    }
    const cols = [...bySection.entries()]
      .sort((a, b) => (titles.get(a[0]) ?? '').localeCompare(titles.get(b[0]) ?? ''))
      .map(([secId, list]) => withWidth('section:' + secId, titles.get(secId) ?? 'Section', list))
    if (free.length || cols.length === 0) cols.push(withWidth('section:none', 'Ungrouped', free))
    return cols
  }

  // Recency: bands by when each object was created.
  if (cfg.groupBy === 'recency') {
    const now = Date.now()
    const bands = new Map<string, { label: string; order: number; list: Widget[] }>()
    for (const w of items) {
      const b = recencyBucket(w.createdAt, now)
      const cur = bands.get(b.id) ?? { label: b.label, order: b.order, list: [] }
      cur.list.push(w)
      bands.set(b.id, cur)
    }
    return [...bands.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([id, b]) => withWidth('recency:' + id, b.label, b.list))
  }

  // Topic: group by an AI-produced label per widget (supplied in ctx). Widgets with
  // no label land in "Uncategorised". When no labels are supplied yet, one column.
  if (cfg.groupBy === 'topic') {
    const map = ctx.topicByWidget ?? {}
    const groups = new Map<string, Widget[]>()
    for (const w of items) {
      const key = (map[w.id] || '').trim() || 'Uncategorised'
      const arr = groups.get(key) ?? []
      arr.push(w)
      groups.set(key, arr)
    }
    return [...groups.entries()]
      .sort((a, b) => (a[0] === 'Uncategorised' ? 1 : b[0] === 'Uncategorised' ? -1 : a[0].localeCompare(b[0])))
      .map(([key, list]) => withWidth('topic:' + key, key, list))
  }

  if (cfg.groupBy === 'kind') {
    const groups = new Map<string, Widget[]>()
    for (const w of items) {
      const g = kindGroupLabel(w.kind)
      const arr = groups.get(g) ?? []
      arr.push(w)
      groups.set(g, arr)
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([g, list]) => withWidth('kind:' + g, g, list))
  }

  if (cfg.groupBy === 'color') {
    const groups = new Map<string, Widget[]>()
    for (const w of items) {
      const key = colorLabel(w.color)
      const arr = groups.get(key) ?? []
      arr.push(w)
      groups.set(key, arr)
    }
    return [...groups.entries()]
      .sort((a, b) => (a[0] === 'No label' ? 1 : b[0] === 'No label' ? -1 : a[0].localeCompare(b[0])))
      .map(([key, list]) => withWidth('color:' + key, key === 'No label' ? 'No label' : 'Label', list, key === 'No label' ? null : key))
  }

  // Freeform: place each widget in its assigned column; unassigned land in the
  // first column so nothing is ever lost.
  const first = cfg.columns[0]?.id
  const byCol = new Map<string, Widget[]>()
  for (const c of cfg.columns) byCol.set(c.id, [])
  for (const w of items) {
    const col = cfg.assign[w.id] && byCol.has(cfg.assign[w.id]) ? cfg.assign[w.id] : first
    if (col) byCol.get(col)!.push(w)
  }
  for (const list of byCol.values()) {
    list.sort((a, b) => (cfg.order[a.id] ?? 0) - (cfg.order[b.id] ?? 0) || a.createdAt - b.createdAt)
  }
  return cfg.columns.map((c) => withWidth(c.id, c.title, byCol.get(c.id) ?? []))
}
