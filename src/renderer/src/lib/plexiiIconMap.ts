// Which owner-supplied Plexii icon each ENTITY wears, and what it wears when
// there is none.
//
// Entities are the things with a name a person would point at: an app, a work
// widget kind, a tool, a connected app. Since the owner's 22 Oct 2026 delivery
// the set also draws PLACES (side-menu destinations, Focus filters, section
// heads, People and PlexiiBrain rows, Bring-in actions, hubs, tour modules),
// Suite PRODUCTS and Home ACTION tiles. Generic glyphs (close, chevrons,
// collapse, edit) are none of these and keep their Material Symbols.
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

export type PlexiiIconKind = 'app' | 'widget' | 'tool' | 'connected' | 'place' | 'product' | 'action'

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

// ── Places ───────────────────────────────────────────────────────────────────
//
// Where the menus and hubs go, and the menu actions that are not an entity
// (New desk, Import…). All line glyphs, tinted per theme like the tools. Ids
// here are this map's own; they are never shown and never stored.

export const PLACE_ICONS = {
  // Side menu: Desk section, header and workspace switcher.
  home: { asset: 'side-menu/home', fallback: 'plexii:home', label: 'Home' },
  focus: { asset: 'side-menu/focus', fallback: 'notifications', label: 'Focus' },
  rooms: { asset: 'side-menu/rooms', fallback: 'meeting_room', label: 'Rooms' },
  desks: { asset: 'side-menu/desks', fallback: 'desk', label: 'Desks' },
  'all-desks': { asset: 'side-menu/all-desks', fallback: 'desk', label: 'All desks' },
  trash: { asset: 'side-menu/trash', fallback: 'delete', label: 'Trash' },
  'new-desk': { asset: 'side-menu/new-desk', fallback: 'add', label: 'New desk' },
  'manage-organisation': { asset: 'side-menu/manage-organisation', fallback: 'settings', label: 'Manage organisation' },
  // Focus filters (lib/attentionQueues ATTENTION_FILTERS).
  'focus-open': { asset: 'focus-filters/open', fallback: 'radio_button_unchecked', label: 'Open' },
  'focus-due-today': { asset: 'focus-filters/due-today', fallback: 'today', label: 'Due today' },
  'focus-overdue': { asset: 'focus-filters/overdue', fallback: 'alarm', label: 'Overdue' },
  'focus-in-progress': { asset: 'focus-filters/in-progress', fallback: 'pending', label: 'In progress' },
  'focus-waiting': { asset: 'focus-filters/waiting', fallback: 'hourglass_empty', label: 'Waiting' },
  'focus-closed-7d': { asset: 'focus-filters/closed-in-the-last-7-days', fallback: 'check_circle', label: 'Closed in the last 7 days' },
  // Side-menu section heads that are groupings, not apps (Desk and PlexiiBrain
  // heads wear their app tiles).
  'section-apps': { asset: 'section-headers/apps', fallback: 'apps', label: 'Apps' },
  'section-widgets': { asset: 'section-headers/work-widgets', fallback: 'widgets', label: 'Work widgets' },
  'section-connected-apps': { asset: 'section-headers/connected-apps', fallback: 'hub', label: 'Connected apps' },
  'section-people': { asset: 'section-headers/people', fallback: 'groups', label: 'People' },
  // People area rows.
  'people-home': { asset: 'people/people-home', fallback: 'groups', label: 'People Home' },
  'people-directory': { asset: 'people/directory', fallback: 'badge', label: 'Directory' },
  // PlexiiBrain area rows.
  'brain-home': { asset: 'plexiibrain/plexiibrain-home', fallback: 'plexii:home', label: 'PlexiiBrain Home' },
  'brain-ask': { asset: 'plexiibrain/ask-plexiibrain', fallback: 'neurology', label: 'Ask PlexiiBrain' },
  'brain-map': { asset: 'plexiibrain/plexiibrain-map', fallback: 'bubble_chart', label: 'PlexiiBrain Map' },
  'brain-decisions': { asset: 'plexiibrain/decisions', fallback: 'gavel', label: 'Decisions' },
  'brain-assemble': { asset: 'plexiibrain/assemble-a-desk', fallback: 'dashboard_customize', label: 'Assemble a desk' },
  'brain-agents': { asset: 'plexiibrain/agents', fallback: 'smart_toy', label: 'Agents' },
  'brain-ops': { asset: 'plexiibrain/ops', fallback: 'monitoring', label: 'Agentic Ops' },
  'brain-connect': { asset: 'plexiibrain/connect', fallback: 'hub', label: 'Connect' },
  'brain-api': { asset: 'plexiibrain/apis', fallback: 'api', label: 'APIs' },
  'brain-insights': { asset: 'plexiibrain/insights', fallback: 'insights', label: 'Insights' },
  // Work widgets section, "Bring in".
  'import-widget-file': { asset: 'bring-in/import-work-widget-file', fallback: 'upload_file', label: 'Import work widget file' },
  'import-file': { asset: 'bring-in/import-file-to-this-desk', fallback: 'description', label: 'Import file to this desk' },
  // Areas and hubs.
  'office-area': { asset: 'areas/office-area', fallback: 'plexii:office', label: 'Office' },
  'people-area': { asset: 'areas/people-area', fallback: 'diversity_3', label: 'People' },
  recent: { asset: 'areas/recent', fallback: 'schedule', label: 'Recent' },
  templates: { asset: 'areas/templates', fallback: 'plexii:templates', label: 'Templates' },
  starred: { asset: 'areas/starred', fallback: 'star', label: 'Starred' },
  // Onboarding tour modules (lib/onboarding/registry, by module id).
  'tour-core': { asset: 'onboarding/welcome-to-plexiidesk', fallback: 'auto_awesome', label: 'Welcome to PlexiiDesk' },
  'tour-rooms-desks': { asset: 'onboarding/rooms-desks-and-plans', fallback: 'meeting_room', label: 'Rooms, Desks and Plans' },
  'tour-office-connect': { asset: 'onboarding/connected-office-files', fallback: 'description', label: 'Connected office files' },
  'tour-body-double': { asset: 'onboarding/body-doubling', fallback: 'diversity_3', label: 'Body doubling' }
} as const satisfies Record<string, EntityIconEntry>

export type PlexiiPlaceId = keyof typeof PLACE_ICONS

const place = (id: PlexiiPlaceId): EntityRef => ({ kind: 'place', id })

/**
 * The Focus filters (lib/attentionQueues). Keyed by the filter id, typed as a
 * full record: a new filter does not compile until its icon is decided.
 */
export const ATTENTION_FILTER_PLACE: Readonly<Record<'open' | 'due-today' | 'overdue' | 'in-progress' | 'waiting' | 'closed-7d', PlexiiPlaceId>> = {
  open: 'focus-open',
  'due-today': 'focus-due-today',
  overdue: 'focus-overdue',
  'in-progress': 'focus-in-progress',
  waiting: 'focus-waiting',
  'closed-7d': 'focus-closed-7d'
}

export function attentionFilterEntity(filter: string): EntityRef | null {
  const id = (ATTENTION_FILTER_PLACE as Record<string, PlexiiPlaceId | undefined>)[filter]
  return id ? place(id) : null
}

/** Side-menu section heads (components/nav/AreaAccordion SectionId). Desk and PlexiiBrain are apps. */
export const NAV_SECTION_ENTITY: Readonly<Record<'desk' | 'apps' | 'widgets' | 'connected' | 'people' | 'brain', EntityRef>> = {
  desk: { kind: 'app', id: 'plexidesk' },
  apps: place('section-apps'),
  widgets: place('section-widgets'),
  connected: place('section-connected-apps'),
  people: place('section-people'),
  brain: { kind: 'app', id: 'plexibrain' }
}

/** The Office document library's pages (PlexiOfficeShell LIBRARY_PAGES). "All" keeps its glyph. */
export const OFFICE_LIBRARY_ENTITY: Readonly<Record<string, EntityRef>> = {
  recent: place('recent'),
  starred: place('starred'),
  shared: { kind: 'tool', id: 'shared' },
  templates: place('templates'),
  trash: place('trash')
}

/** An onboarding tour module (lib/onboarding/registry), by module id. */
export const TOUR_MODULE_ENTITY: Readonly<Record<string, EntityRef>> = {
  core: place('tour-core'),
  'rooms-desks': place('tour-rooms-desks'),
  'office-connect': place('tour-office-connect'),
  'body-double': place('tour-body-double')
}

export function tourModuleEntity(id: string): EntityRef | null {
  return TOUR_MODULE_ENTITY[id] ?? null
}

// ── Suite products and Home actions ──────────────────────────────────────────
//
// Full-colour tiles. Products are the Plexii Suite cards that are neither an
// app nor a tool; actions are the Home dashboard's one-tap tiles.

export const PRODUCT_ICONS = {
  agents: { asset: 'suite/agents', fallback: 'smart_toy', label: 'Agents' },
  dash: { asset: 'suite/dash', fallback: 'dashboard', label: 'Dash' },
  tables: { asset: 'suite/tables', fallback: 'table_view', label: 'Tables' },
  reports: { asset: 'suite/reports', fallback: 'summarize', label: 'Reports' },
  build: { asset: 'suite/build', fallback: 'construction', label: 'Build' },
  // The card is PlexiiWidgets (shared/plexiSuite); a bare "Widgets" is not a
  // name the app uses (user-facing text says "work widget").
  widgets: { asset: 'suite/widgets', fallback: 'widgets', label: 'PlexiiWidgets' },
  api: { asset: 'suite/api', fallback: 'api', label: 'API' },
  marketplace: { asset: 'suite/marketplace', fallback: 'storefront', label: 'Marketplace' },
  ops: { asset: 'suite/ops', fallback: 'monitoring', label: 'Ops' }
} as const satisfies Record<string, EntityIconEntry>

export const ACTION_ICONS = {
  'new-desk': { asset: 'home-actions/new-desk', fallback: 'desk', label: 'New desk' },
  discover: { asset: 'home-actions/discover', fallback: 'plexii:discover', label: 'Discover' },
  transcribe: { asset: 'home-actions/transcribe', fallback: 'plexii:mic', label: 'Transcribe' },
  'focus-timer': { asset: 'home-actions/focus-timer', fallback: 'timer', label: 'Focus timer' }
} as const satisfies Record<string, EntityIconEntry>

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
  'task-link': W('widgets/task-link'),
  'local-app-launcher': W('widgets/app-launcher'),
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
  minimap: W('widgets/minimap'),
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
  // Custom work widget: its own icon, distinct from Custom block.
  custom: W('widgets/custom-work-widget'),
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
    case 'place':
    case 'product':
    case 'action': {
      const table = (kind === 'place' ? PLACE_ICONS : kind === 'product' ? PRODUCT_ICONS : ACTION_ICONS) as Record<string, EntityIconEntry>
      const e = table[id]
      return e ? { asset: assetFor(e.asset), fallback: e.fallback, label: e.label } : { asset: null, fallback: 'apps', label: id }
    }
  }
}

export interface EntityRef {
  kind: PlexiiIconKind
  id: string
}

/**
 * The entity (or place) a `lib/segmentApps` registry row stands for, or null
 * when the set has no icon for it and the row keeps its registry glyph.
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
  'plexidesk:home': place('home'),
  'plexidesk:recent': place('recent'),
  'plexipeople:home': place('people-home'),
  'plexipeople:directory': place('people-directory'),
  'plexipeople:workspaces': { kind: 'tool', id: 'organisation' },
  'plexipeople:map': { kind: 'tool', id: 'people-map' },
  'plexibrain:home': place('brain-home'),
  'plexibrain:ask': place('brain-ask'),
  'plexibrain:search': { kind: 'tool', id: 'search' },
  'plexibrain:map': place('brain-map'),
  'plexibrain:decisions': place('brain-decisions'),
  'plexibrain:assemble': place('brain-assemble'),
  'plexibrain:flows': { kind: 'tool', id: 'flows' },
  'plexibrain:agents': place('brain-agents'),
  'plexibrain:ops': place('brain-ops'),
  'plexibrain:connect': place('brain-connect'),
  'plexibrain:api': place('brain-api'),
  'plexibrain:insights': place('brain-insights')
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
 * key) stands for: its app or tool, or (Agents, Dash, Tables, Reports, Build,
 * Widgets, API, Marketplace, Ops) its own product tile.
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
  plexivault: { kind: 'app', id: 'vault' },
  plexiagents: { kind: 'product', id: 'agents' },
  plexidash: { kind: 'product', id: 'dash' },
  plexitables: { kind: 'product', id: 'tables' },
  plexireports: { kind: 'product', id: 'reports' },
  plexibuild: { kind: 'product', id: 'build' },
  plexiwidgets: { kind: 'product', id: 'widgets' },
  plexiapi: { kind: 'product', id: 'api' },
  pleximarketplace: { kind: 'product', id: 'marketplace' },
  plexiops: { kind: 'product', id: 'ops' }
}

export function suiteProductEntity(key: string): EntityRef | null {
  return SUITE_PRODUCT_ENTITY[key] ?? null
}

/**
 * The entity a dashboard (home) widget def stands for (views/homeWidgetDefs,
 * keyed by HomeWidgetId). Only defs that ARE an app, tool, work widget or
 * Home action are here; summaries (Standup, Pulse, Overdue radar, …) are not
 * entities and keep their glyph.
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
  attention: { kind: 'widget', id: 'attention' },
  // The one-tap action tiles: the owner's Home-Actions set.
  'new-desk': { kind: 'action', id: 'new-desk' },
  discover: { kind: 'action', id: 'discover' },
  transcribe: { kind: 'action', id: 'transcribe' },
  'focus-timer': { kind: 'action', id: 'focus-timer' }
}

export function homeWidgetEntity(id: string): EntityRef | null {
  return HOME_WIDGET_ENTITY[id] ?? null
}

/** The entity behind a top-level view kind (Forms, Collaborations, …), if it has one. */
export function viewKindEntity(viewKind: string): EntityRef | null {
  return VIEW_ENTITY[viewKind] ?? null
}

const VIEW_ENTITY: Record<string, EntityRef> = {
  home: place('home'),
  attention: place('focus'),
  rooms: place('rooms'),
  desks: place('desks'),
  trash: place('trash'),
  office: place('office-area'),
  plexipeople: place('people-area'),
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
