// Which owner-supplied Plexii icon each ENTITY wears, and what it wears when
// there is none.
//
// Entities are the things with a name a person would point at: an app, a work
// widget kind, a tool, a connected app. Generic glyphs (close, chevrons, edit,
// section furniture) are not entities and keep their Material Symbols.
//
// Every entry is DECLARED. An entity either names an asset key from the
// generated index (lib/plexiiIconAssets.generated.ts, built by
// scripts/build-plexii-icons.mjs) or is `null`, which means "keep the current
// Material/Plexii glyph" on purpose. tests/unit/plexiiIconMap.test.ts walks
// every app, widget kind, tool and connected app and fails on anything that
// is neither, so nothing can silently render a blank.
//
// Code ids are never renamed here. The asset set uses display names
// ("Attention", "Email"); the app's ids stay what they are ('attention',
// 'mail-thread'). DEC-144 renamed Attention to Focus in display text only, so
// the Attention asset is the Focus work widget.

import type { WidgetKind } from '@shared/types'
import { PLEXII_ICON_ASSETS, type PlexiiIconAsset } from './plexiiIconAssets.generated'
import { catalogFor } from './widgetCatalog'
import { findStandardApp } from './standardApps'
import type { SegmentKind } from './segmentApps'

export type PlexiiIconKind = 'app' | 'widget' | 'tool' | 'connected'

export interface EntityIconEntry {
  /** Key into PLEXII_ICON_ASSETS, or null: the current glyph is kept on purpose. */
  asset: string | null
  /** The glyph drawn when there is no asset (or it fails to load). */
  fallback: string
  /** Display name, for alt text and the coverage report. */
  label: string
  /** Why an entry borrows another category's asset or has none. */
  note?: string
}

// ── Apps ─────────────────────────────────────────────────────────────────────
//
// Keyed by the app's own id: the Office key from lib/segmentApps where there is
// one, and the area id for the two areas that are themselves apps.

export const APP_ICONS = {
  plexidesk: { asset: 'apps/plexiidesk', fallback: 'desktop_windows', label: 'PlexiiDesk' },
  plexibrain: { asset: 'apps/plexiibrain', fallback: 'neurology', label: 'PlexiiBrain' },
  assist: { asset: 'apps/plexiiassist', fallback: 'auto_awesome', label: 'PlexiiAssist' },
  docs: { asset: 'apps/plexiiwrite', fallback: 'description', label: 'PlexiiWrite' },
  sheets: { asset: 'apps/plexiicells', fallback: 'table_chart', label: 'PlexiiCells' },
  slides: { asset: 'apps/plexiideck', fallback: 'slideshow', label: 'PlexiiDeck' },
  diagrams: { asset: 'apps/plexiidiagrams', fallback: 'account_tree', label: 'PlexiiDiagrams' },
  design: { asset: 'apps/plexiidesign', fallback: 'plexii:design', label: 'PlexiiDesign' },
  draw: { asset: 'apps/plexiidraw', fallback: 'brush', label: 'PlexiiDraw' },
  meet: { asset: 'apps/plexiicall', fallback: 'video_call', label: 'PlexiiCall' },
  chat: { asset: 'apps/plexiichat', fallback: 'forum', label: 'PlexiiChat' },
  vault: { asset: 'apps/plexiivault', fallback: 'lock', label: 'PlexiiVault' },
  sign: { asset: 'apps/plexiisign', fallback: 'plexii:sign', label: 'PlexiiSign' },
  files: { asset: 'apps/files', fallback: 'folder', label: 'Files' },
  browser: { asset: 'apps/browser', fallback: 'public', label: 'Browser' },
  mail: { asset: 'apps/mail', fallback: 'mail', label: 'Mail' },
  inbox: { asset: 'apps/inbox', fallback: 'inbox', label: 'Inbox' },
  calendar: { asset: 'apps/calendar', fallback: 'calendar_month', label: 'Calendar' }
} as const satisfies Record<string, EntityIconEntry>

export type PlexiiAppId = keyof typeof APP_ICONS

// ── Tools ────────────────────────────────────────────────────────────────────

export const TOOL_ICONS = {
  forms: { asset: 'tools/forms', fallback: 'dynamic_form', label: 'Forms' },
  projects: { asset: 'tools/projects', fallback: 'account_tree', label: 'Projects' },
  collaborations: { asset: 'tools/collaborations', fallback: 'groups', label: 'Collaborations' },
  shared: { asset: 'tools/shared-with-me', fallback: 'folder_shared', label: 'Shared with me' },
  search: { asset: 'tools/search', fallback: 'search', label: 'Search' },
  'all-tasks': { asset: 'tools/all-tasks', fallback: 'checklist', label: 'All Tasks' },
  organisation: { asset: 'tools/organisation', fallback: 'apartment', label: 'Organisation' },
  flows: { asset: 'tools/flows', fallback: 'bolt', label: 'Flows' },
  'people-map': { asset: 'tools/people-map', fallback: 'account_tree', label: 'People Map' }
} as const satisfies Record<string, EntityIconEntry>

export type PlexiiToolId = keyof typeof TOOL_ICONS

// ── Work widget kinds ────────────────────────────────────────────────────────
//
// `Record<WidgetKind, …>`: adding a kind to the union without deciding its icon
// is a compile error. `null` keeps the catalogue's Material glyph.

const W = (asset: string | null, note?: string): { asset: string | null; note?: string } => ({ asset, note })

export const WIDGET_ICON_ASSETS: Record<WidgetKind, { asset: string | null; note?: string }> = {
  'task-list': W('widgets/tasks'),
  metrics: W('widgets/metrics'),
  contacts: W('widgets/contacts'),
  inbox: W('widgets/inbox'),
  'location-map': W('widgets/map'),
  calendar: W('widgets/calendar'),
  'stat-card': W('widgets/stat-card'),
  gallery: W('widgets/gallery'),
  'image-gen': W('widgets/image-generation'),
  sticky: W('widgets/sticky'),
  note: W('widgets/note'),
  markdown: W('widgets/markdown'),
  webview: W('widgets/browser'),
  pdf: W('widgets/pdf'),
  gdoc: W('widgets/google-doc'),
  gsheet: W('widgets/google-sheet'),
  gslide: W('widgets/google-slides'),
  email: W('widgets/email'),
  'chat-thread': W('widgets/chat-thread'),
  'mail-thread': W('widgets/email'),
  calculator: W('widgets/calculator'),
  color: W('widgets/colour'),
  image: W('widgets/image'),
  video: W('widgets/video'),
  timer: W('widgets/timer'),
  section: W('widgets/section'),
  'task-link': W(null, 'no Task link icon in the set'),
  'local-app-launcher': W(null, 'no App launcher icon in the set'),
  file: W('widgets/file'),
  drive: W('widgets/drive-folder'),
  field: W('widgets/field'),
  page: W('widgets/page'),
  table: W('widgets/table'),
  doc: W('widgets/document'),
  sheet: W('widgets/spreadsheet'),
  slides: W('widgets/slides'),
  map: W('widgets/flowchart'),
  design: W('widgets/design'),
  draw: W('apps/plexiidraw', 'no Artwork work widget icon in the set; a draw work widget IS a PlexiiDraw document'),
  'meeting-record': W('apps/plexiicall', 'a meeting record is PlexiiCall\'s work widget (segmentApps meet.widgetKinds)'),
  streamdeck: W('widgets/stream-deck'),
  minimap: W(null, 'no Minimap icon in the set'),
  // DEC-144: Attention is "Focus" in display text only; the asset keeps its name.
  attention: W('widgets/attention'),
  'voice-recorder': W('widgets/voice-note'),
  mindmap: W('widgets/mind-map'),
  diagram: W('apps/plexiidiagrams', 'legacy kind, never offered; represented under Apps by PlexiiDiagrams'),
  scratchpad: W('widgets/scratchpad'),
  shape: W('widgets/shape'),
  card: W('widgets/card'),
  chart: W('widgets/chart'),
  'custom-block': W('widgets/custom-block'),
  custom: W(null, 'no Custom work widget icon in the set (Custom block is a different kind)'),
  agent: W('widgets/agent'),
  portal: W('widgets/portal'),
  'living-doc': W('widgets/living-doc'),
  webhook: W('widgets/outgoing-webhook'),
  'inbound-hook': W('widgets/incoming-webhook')
}

// ── Connected apps ───────────────────────────────────────────────────────────
//
// Keyed by the standard-app id (lib/standardApps). Logos are third-party marks:
// used exactly as supplied.

export const CONNECTED_ICON_ASSETS: Record<string, string> = {
  gmail: 'connected/gmail',
  gcal: 'connected/google-calendar',
  gdrive: 'connected/google-drive',
  notion: 'connected/notion',
  trello: 'connected/trello',
  todoist: 'connected/todoist',
  slack: 'connected/slack',
  discord: 'connected/discord',
  whatsapp: 'connected/whatsapp',
  github: 'connected/github',
  linear: 'connected/linear',
  jira: 'connected/jira',
  claude: 'connected/claude',
  chatgpt: 'connected/chatgpt',
  gemini: 'connected/gemini',
  spotify: 'connected/spotify',
  ytmusic: 'connected/youtube-music',
  youtube: 'connected/youtube',
  figma: 'connected/figma',
  miro: 'connected/miro'
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface ResolvedEntityIcon {
  asset: PlexiiIconAsset | null
  fallback: string
  label: string
}

function assetFor(key: string | null | undefined): PlexiiIconAsset | null {
  return key ? (PLEXII_ICON_ASSETS[key] ?? null) : null
}

/** What `<PlexiiIcon kind id>` draws. Unknown ids resolve to a fallback, never to nothing. */
export function resolveEntityIcon(kind: PlexiiIconKind, id: string): ResolvedEntityIcon {
  switch (kind) {
    case 'app': {
      const e = (APP_ICONS as Record<string, EntityIconEntry>)[id]
      return e ? { asset: assetFor(e.asset), fallback: e.fallback, label: e.label } : { asset: null, fallback: 'apps', label: id }
    }
    case 'tool': {
      const e = (TOOL_ICONS as Record<string, EntityIconEntry>)[id]
      return e ? { asset: assetFor(e.asset), fallback: e.fallback, label: e.label } : { asset: null, fallback: 'build', label: id }
    }
    case 'widget': {
      const cat = catalogFor(id as WidgetKind)
      const e = WIDGET_ICON_ASSETS[id as WidgetKind]
      return { asset: assetFor(e?.asset), fallback: cat?.icon ?? 'widgets', label: cat?.label ?? id }
    }
    case 'connected': {
      const std = findStandardApp(id)
      return { asset: assetFor(CONNECTED_ICON_ASSETS[id]), fallback: std?.icon ?? 'apps', label: std?.title ?? id }
    }
  }
}

export interface EntityRef {
  kind: PlexiiIconKind
  id: string
}

/**
 * The entity a `lib/segmentApps` registry row stands for, or null when the row
 * is a place rather than an entity with its own icon (hubs, Recent, Insights…),
 * which keeps its registry glyph.
 */
export function segmentAppEntity(segment: SegmentKind | string, key: string): EntityRef | null {
  if (segment === 'office') return key in APP_ICONS ? { kind: 'app', id: key } : null
  const ref = SEGMENT_ENTITY[`${segment}:${key}`]
  return ref ?? null
}

const SEGMENT_ENTITY: Record<string, EntityRef> = {
  'plexidesk:desk': { kind: 'app', id: 'plexidesk' },
  'plexidesk:plans': { kind: 'tool', id: 'projects' },
  'plexidesk:tasks': { kind: 'tool', id: 'all-tasks' },
  'plexipeople:workspaces': { kind: 'tool', id: 'organisation' },
  'plexipeople:map': { kind: 'tool', id: 'people-map' },
  'plexibrain:search': { kind: 'tool', id: 'search' },
  'plexibrain:flows': { kind: 'tool', id: 'flows' }
}

/**
 * The app a document type belongs to: a PlexiiWrite doc wears PlexiiWrite's
 * icon wherever a document is listed (Recent, Office home, pickers, editor
 * headers). A widget file wears its work widget kind's icon. Unknown or
 * missing types return null, so the call site keeps its own glyph.
 */
export const DOC_TYPE_APP: Readonly<Record<string, PlexiiAppId>> = {
  doc: 'docs',
  sheet: 'sheets',
  slides: 'slides',
  map: 'diagrams',
  design: 'design',
  draw: 'draw'
}

export function docTypeEntity(docType: string | null | undefined, widgetKind?: string | null): EntityRef | null {
  if (!docType) return null
  if (docType === 'widget') return widgetKind ? { kind: 'widget', id: widgetKind } : null
  const app = DOC_TYPE_APP[docType]
  return app ? { kind: 'app', id: app } : null
}

/**
 * The entity a Plexii Suite product card (shared/plexiSuite, keyed by product
 * key) stands for. Products with no icon in the set (Agents, Dash, Tables,
 * Reports, Build, Widgets, API, Marketplace, Ops) are absent on purpose and
 * keep their Material glyph.
 */
export const SUITE_PRODUCT_ENTITY: Readonly<Record<string, EntityRef>> = {
  plexidesk: { kind: 'app', id: 'plexidesk' },
  plexidocs: { kind: 'app', id: 'docs' },
  plexisheets: { kind: 'app', id: 'sheets' },
  plexislides: { kind: 'app', id: 'slides' },
  plexidiagrams: { kind: 'app', id: 'diagrams' },
  plexidesign: { kind: 'app', id: 'design' },
  plexidraw: { kind: 'app', id: 'draw' },
  plexiforms: { kind: 'tool', id: 'forms' },
  plexisign: { kind: 'app', id: 'sign' },
  plexitasks: { kind: 'tool', id: 'all-tasks' },
  plexiprojects: { kind: 'tool', id: 'projects' },
  plexicalendar: { kind: 'app', id: 'calendar' },
  pleximeet: { kind: 'app', id: 'meet' },
  plexichat: { kind: 'app', id: 'chat' },
  plexifiles: { kind: 'app', id: 'files' },
  plexibrain: { kind: 'app', id: 'plexibrain' },
  plexiflow: { kind: 'tool', id: 'flows' },
  plexisearch: { kind: 'tool', id: 'search' },
  pleximail: { kind: 'app', id: 'mail' },
  plexivault: { kind: 'app', id: 'vault' }
}

export function suiteProductEntity(key: string): EntityRef | null {
  return SUITE_PRODUCT_ENTITY[key] ?? null
}

/**
 * The entity a dashboard (home) widget def stands for (views/homeWidgetDefs,
 * keyed by HomeWidgetId). Only defs that ARE an app, tool or work widget are
 * here; summaries (Standup, Pulse, Overdue radar, …) are not entities and keep
 * their glyph.
 */
export const HOME_WIDGET_ENTITY: Readonly<Record<string, EntityRef>> = {
  'app-mail': { kind: 'app', id: 'mail' },
  'app-chat': { kind: 'app', id: 'chat' },
  'app-calendar': { kind: 'app', id: 'calendar' },
  'app-files': { kind: 'app', id: 'files' },
  'app-vault': { kind: 'app', id: 'vault' },
  'app-browser': { kind: 'app', id: 'browser' },
  'new-meeting': { kind: 'app', id: 'meet' },
  'pinned-conversation': { kind: 'app', id: 'chat' },
  // DEC-144: the home "Focus" widget is the Focus (Attention) work widget.
  attention: { kind: 'widget', id: 'attention' }
}

export function homeWidgetEntity(id: string): EntityRef | null {
  return HOME_WIDGET_ENTITY[id] ?? null
}

/** The entity behind a top-level view kind (Forms, Collaborations, …), if it has one. */
export function viewKindEntity(viewKind: string): EntityRef | null {
  return VIEW_ENTITY[viewKind] ?? null
}

const VIEW_ENTITY: Record<string, EntityRef> = {
  forms: { kind: 'tool', id: 'forms' },
  collaborations: { kind: 'tool', id: 'collaborations' },
  'people-map': { kind: 'tool', id: 'people-map' },
  shared: { kind: 'tool', id: 'shared' },
  plexidesk: { kind: 'app', id: 'plexidesk' },
  plexibrain: { kind: 'app', id: 'plexibrain' }
}

/**
 * The entity a search hit belongs to: a document wears its app, a widget hit
 * its kind, and the app-owned hit types (PlexiiBrain knowledge, Calendar
 * events, PlexiiCall meetings, PlexiiSign envelopes, Mail) their app. Tasks,
 * folders, files and table rows are not entities and keep their glyph.
 */
export function searchHitEntity(hit: { type: string; docType?: string | null; widgetKind?: string | null }): EntityRef | null {
  switch (hit.type) {
    case 'document':
      return docTypeEntity(hit.docType, hit.widgetKind)
    case 'widget':
      return hit.widgetKind && WIDGET_ICON_ASSETS[hit.widgetKind as WidgetKind]?.asset ? { kind: 'widget', id: hit.widgetKind } : null
    case 'knowledge':
      return { kind: 'app', id: 'plexibrain' }
    case 'event':
      return { kind: 'app', id: 'calendar' }
    case 'meeting':
      return { kind: 'app', id: 'meet' }
    case 'sign':
      return { kind: 'app', id: 'sign' }
    case 'mail':
      return { kind: 'app', id: 'mail' }
    default:
      return null
  }
}
