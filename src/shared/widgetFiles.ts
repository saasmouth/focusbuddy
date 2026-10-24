// Widget files — a widget that exists without a desk, the way a document does.
//
// Stored as a `documents` row with doc_type 'widget' whose body is a
// WidgetFileBody. Placed on a desk it becomes an ordinary widget whose
// syncGroupId is `wf:<file id>`, so the linked-duplicate machinery that already
// mirrors content between copies also mirrors it to and from the file. The full
// contract is docs/widget-files.md; this module is the pure half of it (no IO),
// shared by main, the renderer and the tests.

import type {
  Widget,
  WidgetFileOutlineNode,
  WidgetFile,
  WidgetFileBody,
  WidgetFileTitleSource,
  WidgetKind
} from './types'
import { cleanTitle, isUntitled, titleFromText } from './titles'
import { contentToPlainText, widgetToText, type WidgetTextResolvers } from './widgetText'

// ── Linked instances ────────────────────────────────────────────────────────

/** The syncGroupId prefix that marks a widget as an instance of a widget file. */
export const WIDGET_FILE_GROUP_PREFIX = 'wf:'

export function widgetFileGroupId(fileId: string): string {
  return `${WIDGET_FILE_GROUP_PREFIX}${fileId}`
}

/** The file a sync group belongs to, or null for an ordinary linked-duplicate group. */
export function widgetFileIdFromGroup(syncGroupId: string | null | undefined): string | null {
  if (!syncGroupId || !syncGroupId.startsWith(WIDGET_FILE_GROUP_PREFIX)) return null
  const id = syncGroupId.slice(WIDGET_FILE_GROUP_PREFIX.length)
  return id || null
}

/**
 * The id the full-pane view gives its widget. It is the group id on purpose:
 * the renderer's widget store routes any update for an id with this prefix to
 * the widget-file store, so every widget component works full-pane unchanged.
 */
export const widgetFilePaneId = widgetFileGroupId
export const isWidgetFilePaneId = (id: string | null | undefined): boolean =>
  !!id && id.startsWith(WIDGET_FILE_GROUP_PREFIX)

// ── File types ──────────────────────────────────────────────────────────────

export interface WidgetFileType {
  /** Stable forever once shipped: it is written into every exported file. */
  typeId: string
  /** Extension-like label, also the export file extension. */
  ext: string
  /** The type as Files names it ("Table", "Task list"). */
  label: string
  /** Material Symbols icon; matches the widget catalogue's icon for the kind. */
  icon: string
}

/**
 * Every kind that can be a file. A kind absent from this map is desk-only: it
 * describes or arranges the desk it sits on (a section, a portal, a desk agent
 * wired to its neighbours) or it is already a document (doc, sheet, slides...).
 */
export const WIDGET_FILE_TYPES: Partial<Record<WidgetKind, WidgetFileType>> = {
  table: { typeId: 'plexii.widget.table', ext: '.plexii-table', label: 'Table', icon: 'table_chart' },
  'task-list': { typeId: 'plexii.widget.task-list', ext: '.plexii-tasks', label: 'Task list', icon: 'task_alt' },
  mindmap: { typeId: 'plexii.widget.mindmap', ext: '.plexii-mindmap', label: 'Mind map', icon: 'account_tree' },
  sticky: { typeId: 'plexii.widget.sticky', ext: '.plexii-sticky', label: 'Sticky', icon: 'sticky_note_2' },
  note: { typeId: 'plexii.widget.note', ext: '.plexii-note', label: 'Note', icon: 'description' },
  markdown: { typeId: 'plexii.widget.markdown', ext: '.plexii-markdown', label: 'Markdown note', icon: 'subject' },
  page: { typeId: 'plexii.widget.page', ext: '.plexii-page', label: 'Page', icon: 'description' },
  card: { typeId: 'plexii.widget.card', ext: '.plexii-card', label: 'Card', icon: 'view_agenda' },
  chart: { typeId: 'plexii.widget.chart', ext: '.plexii-chart', label: 'Chart', icon: 'bar_chart' },
  'stat-card': { typeId: 'plexii.widget.stat-card', ext: '.plexii-stat', label: 'Stat card', icon: 'monitoring' },
  metrics: { typeId: 'plexii.widget.metrics', ext: '.plexii-metrics', label: 'Metrics', icon: 'insights' },
  field: { typeId: 'plexii.widget.field', ext: '.plexii-field', label: 'Field', icon: 'edit_note' },
  timer: { typeId: 'plexii.widget.timer', ext: '.plexii-timer', label: 'Timer', icon: 'timer' },
  calculator: { typeId: 'plexii.widget.calculator', ext: '.plexii-calc', label: 'Calculator', icon: 'calculate' },
  color: { typeId: 'plexii.widget.color', ext: '.plexii-color', label: 'Colour swatch', icon: 'palette' },
  'voice-recorder': { typeId: 'plexii.widget.voice-note', ext: '.plexii-voice', label: 'Voice note', icon: 'mic' },
  diagram: { typeId: 'plexii.widget.diagram', ext: '.plexii-diagram', label: 'Diagram', icon: 'schema' },
  scratchpad: { typeId: 'plexii.widget.scratchpad', ext: '.plexii-sketch', label: 'Sketch', icon: 'draw' },
  shape: { typeId: 'plexii.widget.shape', ext: '.plexii-shape', label: 'Shape', icon: 'category' },
  'custom-block': { typeId: 'plexii.widget.custom-block', ext: '.plexii-block', label: 'Form block', icon: 'dashboard_customize' },
  custom: { typeId: 'plexii.widget.custom', ext: '.plexii-custom', label: 'Custom work widget', icon: 'auto_awesome_mosaic' },
  'image-gen': { typeId: 'plexii.widget.image-gen', ext: '.plexii-image', label: 'AI image', icon: 'auto_awesome' },
  gallery: { typeId: 'plexii.widget.gallery', ext: '.plexii-gallery', label: 'Gallery', icon: 'photo_library' },
  'location-map': { typeId: 'plexii.widget.location', ext: '.plexii-place', label: 'Place', icon: 'location_on' },
  streamdeck: { typeId: 'plexii.widget.speeddeck', ext: '.plexii-speeddeck', label: 'SpeedDeck', icon: 'apps' }
}

/**
 * Tools that can be a file when someone PLACES one somewhere off a desk — drops
 * a calendar, inbox or browser into a document (4.3.43, owner: "embed anything
 * in anything"). Kept apart from WIDGET_FILE_TYPES on purpose: that map also
 * decides that every new desk widget of the kind is filed automatically, and a
 * calendar, browser or PDF on a desk must not start appearing in Files as an
 * extra object (a PDF would show twice). Only an explicit create makes one.
 */
export const EMBED_TOOL_FILE_TYPES: Partial<Record<WidgetKind, WidgetFileType>> = {
  contacts: { typeId: 'plexii.widget.contacts', ext: '.plexii-contacts', label: 'Contacts', icon: 'group' },
  inbox: { typeId: 'plexii.widget.inbox', ext: '.plexii-inbox', label: 'Inbox', icon: 'inbox' },
  calendar: { typeId: 'plexii.widget.calendar', ext: '.plexii-calendar', label: 'Calendar', icon: 'calendar_month' },
  attention: { typeId: 'plexii.widget.focus', ext: '.plexii-focus', label: 'Focus', icon: 'notifications' },
  'local-app-launcher': { typeId: 'plexii.widget.app-launcher', ext: '.plexii-app-launcher', label: 'App launcher', icon: 'desktop_mac' },
  file: { typeId: 'plexii.widget.file-link', ext: '.plexii-file-link', label: 'File or link', icon: 'upload_file' },
  drive: { typeId: 'plexii.widget.drive', ext: '.plexii-drive', label: 'Drive folder', icon: 'folder_open' },
  'task-link': { typeId: 'plexii.widget.desk-link', ext: '.plexii-desk-link', label: 'Desk link', icon: 'link' },
  webview: { typeId: 'plexii.widget.browser', ext: '.plexii-browser', label: 'Browser', icon: 'public' },
  pdf: { typeId: 'plexii.widget.pdf', ext: '.plexii-pdf', label: 'PDF', icon: 'picture_as_pdf' },
  gdoc: { typeId: 'plexii.widget.gdoc', ext: '.plexii-gdoc', label: 'Google Doc', icon: 'article' },
  gsheet: { typeId: 'plexii.widget.gsheet', ext: '.plexii-gsheet', label: 'Google Sheet', icon: 'table_chart' },
  gslide: { typeId: 'plexii.widget.gslides', ext: '.plexii-gslides', label: 'Google Slides', icon: 'slideshow' },
  'mail-thread': { typeId: 'plexii.widget.mail-thread', ext: '.plexii-mail-thread', label: 'Email thread', icon: 'mail' },
  'chat-thread': { typeId: 'plexii.widget.chat-thread', ext: '.plexii-chat-thread', label: 'Chat', icon: 'forum' },
  email: { typeId: 'plexii.widget.email', ext: '.plexii-email', label: 'Email', icon: 'mail' },
  image: { typeId: 'plexii.widget.picture', ext: '.plexii-picture', label: 'Image', icon: 'image' },
  video: { typeId: 'plexii.widget.video', ext: '.plexii-video', label: 'Video', icon: 'movie' },
  portal: { typeId: 'plexii.widget.portal', ext: '.plexii-portal', label: 'Portal', icon: 'picture_in_picture' },
  'living-doc': { typeId: 'plexii.widget.living-doc', ext: '.plexii-living-doc', label: 'Living Doc', icon: 'auto_awesome' }
}

const ALL_FILE_TYPES: Partial<Record<WidgetKind, WidgetFileType>> = { ...WIDGET_FILE_TYPES, ...EMBED_TOOL_FILE_TYPES }

/** May a file of this kind exist at all — a standalone kind, or a tool someone placed? */
export function isWidgetFileKind(kind: WidgetKind | string | null | undefined): kind is WidgetKind {
  return !!kind && Object.prototype.hasOwnProperty.call(ALL_FILE_TYPES, kind)
}

/** Can this kind exist as a file (off any desk)? */
export function isStandaloneWidgetKind(kind: WidgetKind | string | null | undefined): kind is WidgetKind {
  return !!kind && Object.prototype.hasOwnProperty.call(WIDGET_FILE_TYPES, kind)
}

export function widgetFileType(kind: WidgetKind | string | null | undefined): WidgetFileType | null {
  return isWidgetFileKind(kind) ? (ALL_FILE_TYPES[kind] ?? null) : null
}

/** "Table", "Task list" … or "Widget" for a kind this build cannot file. */
export function widgetFileTypeLabel(kind: WidgetKind | string | null | undefined): string {
  return widgetFileType(kind)?.label ?? 'Work widget'
}

/** The kind an extension or a type id names, for import. */
export function kindForWidgetFileType(extOrTypeId: string): WidgetKind | null {
  const needle = extOrTypeId.trim().toLowerCase()
  const withDot = needle.startsWith('.') ? needle : `.${needle}`
  for (const [kind, t] of Object.entries(ALL_FILE_TYPES) as Array<[WidgetKind, WidgetFileType]>) {
    if (t.typeId === needle || t.ext === withDot) return kind
  }
  return null
}

/** True for a filename this app wrote with widget-file export. */
export function isWidgetFileName(name: string): boolean {
  const m = /\.plexii-[a-z-]+$/i.exec(name.trim())
  return !!m && kindForWidgetFileType(m[0]) !== null
}

// ── Defaults a new file starts from ─────────────────────────────────────────

/**
 * Content a new FILE of this kind starts with, when it differs from the desk
 * default. Only the task list differs, and only when the file is made with no
 * desk (docs/widget-files.md, "Task lists"):
 *
 *   placed onto a desk as it is made (side-menu drag, "Add to this desk", the
 *   palette, the canvas right-click)  the desk default: a lens over the tasks
 *                                     of whichever desk an instance sits on
 *   made with no desk (a click in the side menu, "New … work widget",
 *   the palette's New)                its own list ("own" scope), the same on
 *                                     every desk it is later placed on
 *
 * A file made from content (an import, the assistant's items, a copy) keeps
 * that content whatever the placement; this is only the empty default.
 */
export type WidgetFilePlacement = 'desk' | 'none'

export function defaultWidgetFileContent(
  kind: WidgetKind,
  deskDefault: string,
  placement: WidgetFilePlacement = 'none'
): string {
  if (kind === 'task-list' && placement === 'none') return JSON.stringify({ scope: 'own', filter: 'open', items: [] })
  return deskDefault
}

// ── Bodies ──────────────────────────────────────────────────────────────────

export function makeWidgetFileBody(
  kind: WidgetKind,
  content: string,
  color: string | null,
  titleSource: WidgetFileTitleSource
): WidgetFileBody {
  return { v: 1, kind, content, color, titleSource }
}

const TITLE_SOURCES: readonly WidgetFileTitleSource[] = ['placeholder', 'derived', 'model', 'user']

/**
 * Read a stored body defensively. A body from a newer build, a hand-edited
 * export or a corrupt row still yields something renderable when it carries a
 * kind; null only when there is no kind to render it as.
 */
export function parseWidgetFileBody(raw: unknown): WidgetFileBody | null {
  let b: unknown = raw
  if (typeof raw === 'string') {
    try {
      b = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!b || typeof b !== 'object') return null
  const r = b as Record<string, unknown>
  if (typeof r.kind !== 'string' || !r.kind) return null
  return {
    v: 1,
    kind: r.kind as WidgetKind,
    content: typeof r.content === 'string' ? r.content : r.content == null ? '' : JSON.stringify(r.content),
    color: typeof r.color === 'string' ? r.color : null,
    titleSource: TITLE_SOURCES.includes(r.titleSource as WidgetFileTitleSource)
      ? (r.titleSource as WidgetFileTitleSource)
      : // A body written without a source predates the field: whatever title it
        // has was not generated by us, so it belongs to the user.
        'user'
  }
}

/** The widget a file renders as, full-pane. Position is meaningless there. */
export function widgetFromFile(file: WidgetFile, size = { width: 800, height: 600 }): Widget {
  const id = widgetFilePaneId(file.id)
  return {
    id,
    taskId: '',
    kind: file.kind,
    title: file.title,
    content: file.content,
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    zIndex: 1,
    color: file.color,
    status: null,
    pinned: false,
    pinnedScreenX: null,
    pinnedScreenY: null,
    pinnedZone: null,
    parentSectionId: null,
    layout: null,
    sourceAppId: null,
    mode: null,
    livingQuery: null,
    livingGeneratedAt: null,
    livingPaused: false,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    archived: false,
    syncGroupId: id
  }
}

// ── Naming ──────────────────────────────────────────────────────────────────

/**
 * The name a file gets when there is nothing to name it from yet: its type and
 * the moment it was made, the same shape the New Desk flow pre-fills (DEC-073).
 * Findable and chronological, never "Untitled". Marked 'placeholder' so the
 * first content worth naming it from replaces it.
 */
export function placeholderWidgetFileTitle(kind: WidgetKind, now: Date = new Date()): string {
  const when = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `${widgetFileTypeLabel(kind)} · ${when}`
}

/**
 * True for a name in the placeholder's shape ("Table · Oct 18, 3:04 PM"), for
 * any file type. Such a name says when something was made, not what it is, so
 * it is never a name to keep or to derive from — including when it was copied
 * onto something else (a table file's backing table took its file's
 * placeholder as its own name, and the naming pass then kept it forever).
 */
export function isPlaceholderWidgetFileTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim()
  if (!t) return false
  const m = /^(.+?) · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/.exec(t)
  if (!m) return false
  const label = m[1].toLowerCase()
  return (
    label === 'work widget' ||
    Object.values(WIDGET_FILE_TYPES).some((ft) => ft!.label.toLowerCase() === label)
  )
}

/** A name the table-file derivation wrote ("Client · 12 rows"); it goes stale as rows change. */
function isRowCountTitle(title: string): boolean {
  return /\s·\s\d+ rows?$/.test(title)
}

/**
 * The title a desk widget carries, when it is a real name worth keeping as the
 * file's: not blank or "Untitled …", not a placeholder, and not just the kind's
 * own label ("Table", "Task list") that a menu stamps on a new widget. Null
 * when there is nothing worth keeping, so the file is named the usual way.
 */
export function meaningfulWidgetTitle(
  kind: WidgetKind | string,
  title: string | null | undefined,
  extraLabels: readonly string[] = []
): string | null {
  const t = (title ?? '').trim()
  if (!t || isUntitled(t) || isPlaceholderWidgetFileTitle(t)) return null
  const lower = t.toLowerCase()
  const labels = [widgetFileTypeLabel(kind), kind, ...extraLabels].map((l) => l.toLowerCase())
  if (labels.includes(lower)) return null
  return t.slice(0, 200)
}

function safeParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function usable(t: string | null | undefined): string | null {
  const c = cleanTitle(t ?? '')
  if (!c || c.length < 2 || isUntitled(c)) return null
  return c
}

/** "Call Sam" / "Call Sam + 3 more". */
function firstPlusMore(first: string, total: number): string {
  const head = cleanTitle(first)
  return total > 1 ? `${head} + ${total - 1} more` : head
}

export interface OwnTaskItem {
  id: string
  title: string
  done: boolean
  dueAt?: number | null
  status?: string | null
}

/** The items of an own-scope task list, or null when it is a lens over nodes. */
export function ownTaskItems(content: string | null | undefined): OwnTaskItem[] | null {
  const p = safeParse<{ scope?: string; items?: unknown }>(content)
  if (!p || p.scope !== 'own') return null
  if (!Array.isArray(p.items)) return []
  return (p.items as Array<Record<string, unknown>>)
    .filter((i) => i && typeof i.title === 'string')
    .map((i) => ({
      id: String(i.id ?? ''),
      title: String(i.title),
      done: i.done === true,
      dueAt: typeof i.dueAt === 'number' ? i.dueAt : null,
      status: typeof i.status === 'string' ? i.status : null
    }))
}

/**
 * A name from what the widget holds, per kind. Free and deterministic — the
 * same rule `shared/titles` applies to documents, with each kind's own idea of
 * where its name lives. Null means "nothing to name it from", which leaves the
 * placeholder for the model pass rather than inventing one.
 */
export function deriveWidgetFileTitle(
  kind: WidgetKind,
  content: string,
  resolvers: WidgetTextResolvers = {}
): string | null {
  const raw = content ?? ''
  switch (kind) {
    case 'sticky':
    case 'note':
    case 'markdown':
      return titleFromText(raw)
    case 'page':
      return titleFromText(contentToPlainText(raw))
    case 'card': {
      const p = safeParse<{ title?: string; body?: string }>(raw)
      return usable(p?.title) ?? titleFromText(p?.body ?? '')
    }
    case 'table': {
      if (!raw || !resolvers.table) return null
      const t = resolvers.table(raw)
      if (!t) return null
      // The table's own name wins only when someone chose it. A placeholder
      // (the file's, copied onto the table when it was provisioned) or an
      // earlier "X · N rows" is not a choice, and keeping either would freeze
      // the file's name at a date or a stale row count.
      const own = usable(t.title)
      if (own && !isPlaceholderWidgetFileTitle(own) && !isRowCountTitle(own)) return own
      const first = t.columns[0]?.label?.trim()
      // An empty table has nothing to be named after yet: "Name · 0 rows"
      // would be a name about the template, not the data.
      const n = t.rows.length
      if (!first || n === 0) return null
      return `${cleanTitle(first)} · ${n} row${n === 1 ? '' : 's'}`
    }
    case 'task-list': {
      const own = ownTaskItems(raw)
      if (own) {
        const open = own.filter((i) => !i.done)
        const list = open.length ? open : own
        const first = list.find((i) => usable(i.title))
        return first ? firstPlusMore(first.title, list.length) : null
      }
      const fake = { id: '', taskId: '', kind, content: raw } as unknown as Widget
      const tasks = resolvers.tasks?.(fake) ?? null
      const first = tasks?.find((t) => usable(t.title))
      return first && tasks ? firstPlusMore(first.title, tasks.length) : null
    }
    case 'mindmap': {
      const p = safeParse<{ root?: { label?: string } }>(raw)
      return usable(p?.root?.label)
    }
    case 'chart': {
      const p = safeParse<{ title?: string; type?: string; tableId?: string | null }>(raw)
      const own = usable(p?.title)
      if (own) return own
      const src = p?.tableId && resolvers.table ? resolvers.table(p.tableId) : null
      const srcName = usable(src?.title)
      if (!srcName) return null
      const type = p?.type ? `${p.type.charAt(0).toUpperCase()}${p.type.slice(1)} chart` : 'Chart'
      return `${type} of ${srcName}`
    }
    case 'stat-card':
    case 'metrics': {
      const p = safeParse<{ title?: string; series?: Array<{ label?: string }>; cells?: Array<{ label?: string }> }>(raw)
      return usable(p?.title) ?? usable((p?.series ?? p?.cells ?? [])[0]?.label)
    }
    case 'field': {
      const p = safeParse<{ def?: { label?: string } }>(raw)
      const label = usable(p?.def?.label)
      return label && label.toLowerCase() !== 'field' ? label : null
    }
    case 'custom-block': {
      const p = safeParse<{ title?: string }>(raw)
      return usable(p?.title)
    }
    case 'custom': {
      const p = safeParse<{ spec?: string }>(raw)
      return titleFromText(p?.spec ?? '')
    }
    case 'voice-recorder': {
      const p = safeParse<{ transcript?: string; processedText?: string }>(raw)
      return titleFromText(p?.processedText || p?.transcript || '')
    }
    case 'image-gen': {
      const p = safeParse<{ prompt?: string }>(raw)
      return titleFromText(p?.prompt ?? '')
    }
    case 'diagram': {
      const p = safeParse<{ nodes?: Array<{ data?: { label?: string } }> }>(raw)
      for (const n of p?.nodes ?? []) {
        const l = usable(n.data?.label)
        if (l) return l
      }
      return null
    }
    case 'location-map': {
      const p = safeParse<{ label?: string; query?: string }>(raw)
      return usable(p?.label?.split(',')[0]) ?? usable(p?.query)
    }
    case 'gallery': {
      const p = safeParse<{ fileIds?: string[] }>(raw)
      const n = p?.fileIds?.length ?? 0
      return n > 0 ? `Gallery · ${n} image${n === 1 ? '' : 's'}` : null
    }
    case 'timer': {
      const p = safeParse<{ targetSec?: number }>(raw)
      const sec = p?.targetSec ?? 0
      if (!sec) return null
      return sec % 60 === 0 ? `Timer · ${sec / 60} min` : `Timer · ${sec}s`
    }
    case 'calculator': {
      // Not through cleanTitle: it strips * and _ as markdown, and an
      // expression's operators are the whole point of it.
      const expr = raw.replace(/\s+/g, ' ').trim().slice(0, 50)
      return expr ? `Calc · ${expr}` : null
    }
    case 'color': {
      const hex = raw.trim()
      return /^#[0-9a-f]{3,8}$/i.test(hex) ? `Colour ${hex.toLowerCase()}` : null
    }
    case 'shape': {
      const p = safeParse<{ label?: string }>(raw)
      return usable(p?.label)
    }
    case 'scratchpad':
      // Strokes carry no words; the model cannot name ink either.
      return null
    default: {
      const t = widgetToText({ kind, content: raw, title: '', id: '', taskId: '' } as unknown as Widget, resolvers).text
      if (!t || /^\(.*\)$/.test(t.trim())) return null
      return titleFromText(t)
    }
  }
}

// ── Export / import ─────────────────────────────────────────────────────────

/** What a `.plexii-*` file holds. Version 1. */
export interface WidgetFileExport {
  type: string
  version: 1
  title: string
  kind: WidgetKind
  content: string
  color: string | null
  /** A table's data travels with it: its content alone is only a table id. */
  table?: {
    title: string
    columns: Array<Record<string, unknown>>
    rows: Array<Record<string, unknown>>
  }
  exportedAt: string
}

export function buildWidgetFileExport(
  file: Pick<WidgetFile, 'kind' | 'title' | 'content' | 'color'>,
  extras: { table?: WidgetFileExport['table']; now?: Date } = {}
): WidgetFileExport {
  const t = widgetFileType(file.kind)
  return {
    type: t?.typeId ?? `plexii.widget.${file.kind}`,
    version: 1,
    title: file.title,
    kind: file.kind,
    content: file.content,
    color: file.color,
    ...(extras.table ? { table: extras.table } : {}),
    exportedAt: (extras.now ?? new Date()).toISOString()
  }
}

/** The filename an export is offered under. */
export function widgetFileExportName(file: Pick<WidgetFile, 'kind' | 'title'>): string {
  const ext = widgetFileType(file.kind)?.ext ?? '.plexii-widget'
  const base = (file.title || widgetFileTypeLabel(file.kind)).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)
  return `${base || 'Widget'}${ext}`
}

/**
 * Parse an exported file. Refuses anything that is not a widget-file envelope
 * for a kind this build can file — an import never guesses.
 */
export function parseWidgetFileExport(text: string): WidgetFileExport | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'This file is not a Plexii work widget file (it is not valid JSON).' }
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'This file is not a Plexii work widget file.' }
  const p = parsed as Record<string, unknown>
  const kind = (typeof p.kind === 'string' ? p.kind : null) ?? (typeof p.type === 'string' ? kindForWidgetFileType(p.type) : null)
  if (!kind || !isStandaloneWidgetKind(kind)) {
    return { error: `This work widget type (${String(p.type ?? p.kind ?? 'unknown')}) is not supported by this version of PlexiiDesk.` }
  }
  return {
    type: typeof p.type === 'string' ? p.type : widgetFileType(kind)!.typeId,
    version: 1,
    title: typeof p.title === 'string' ? p.title : '',
    kind,
    content: typeof p.content === 'string' ? p.content : '',
    color: typeof p.color === 'string' ? p.color : null,
    table:
      p.table && typeof p.table === 'object'
        ? (p.table as WidgetFileExport['table'])
        : undefined,
    exportedAt: typeof p.exportedAt === 'string' ? p.exportedAt : ''
  }
}

// ── Content from plain shapes ───────────────────────────────────────────────
// What the assistant (in-app actions and MCP tools) may write into a widget
// file: text, task items, an outline — turned here into exactly what each
// widget stores, so a model never hand-writes a widget's internal JSON.

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`

/** An own-items task list's content. */
export function taskListContent(items: Array<{ title: string; dueAt?: number | null }>): string {
  return JSON.stringify({
    scope: 'own',
    filter: 'open',
    items: items.map((i) => ({ id: newId(), title: i.title, done: false, dueAt: i.dueAt ?? null }))
  })
}

/** Add items to an own-items task list; null when the list is a desk lens. */
export function appendTaskItems(content: string, items: Array<{ title: string; dueAt?: number | null }>): string | null {
  const existing = ownTaskItems(content)
  if (existing === null) return null
  let filter = 'open'
  try {
    const p = JSON.parse(content) as { filter?: string }
    if (p.filter === 'done' || p.filter === 'all') filter = p.filter
  } catch {
    /* keep the default */
  }
  return JSON.stringify({
    scope: 'own',
    filter,
    items: [
      ...existing.map((i) => ({ id: i.id || newId(), title: i.title, done: i.done, dueAt: i.dueAt ?? null })),
      ...items.map((i) => ({ id: newId(), title: i.title, done: false, dueAt: i.dueAt ?? null }))
    ]
  })
}

/** A mind map's content from an outline: the title is the root idea. */
export function mindmapContent(rootLabel: string, outline: WidgetFileOutlineNode[] = []): string {
  const node = (label: string, kids: WidgetFileOutlineNode[] = []): Record<string, unknown> => ({
    id: newId(),
    label,
    kind: 'idea',
    children: kids.map((k) => node(k.label, k.children ?? [])),
    userReplies: [],
    capped: false
  })
  const root = node(rootLabel, outline)
  return JSON.stringify({
    root,
    selectedId: null,
    viewRootId: root.id,
    agentSuggestions: {},
    agentConversations: {},
    agentStats: {}
  })
}

/** A card's content: title + body. */
export function cardContent(title: string, body: string): string {
  return JSON.stringify({ title, body, accent: '#6366f1' })
}

/** Merge new text into a text kind's content (sticky/note/markdown/card). */
export function mergeText(kind: WidgetKind, content: string, text: string, op: 'replace' | 'append'): string | null {
  if (kind === 'sticky' || kind === 'note' || kind === 'markdown') {
    if (op === 'replace') return text
    return content.trim() ? `${content.replace(/\s+$/, '')}\n${text}` : text
  }
  if (kind === 'card') {
    let card: Record<string, unknown> = {}
    try {
      card = JSON.parse(content || '{}') as Record<string, unknown>
    } catch {
      card = {}
    }
    const body = typeof card.body === 'string' ? card.body : ''
    return JSON.stringify({ ...card, body: op === 'replace' || !body.trim() ? text : `${body}\n${text}` })
  }
  return null
}

