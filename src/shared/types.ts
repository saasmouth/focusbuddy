// Type-only import (erased at build, no runtime cycle) so a document body can be
// a PlexiDesign canvas. DesignBody is owned by ./design alongside its helpers,
// and DrawBody by ./draw.
import type { DesignBody } from './design'
import type { DrawBody } from './draw'
import type { FlowLine } from './designFlow'
import type { ChartCore } from './chart'

export type AxisValue = 1 | 2 | 3 | 4 | 5
// 'work_item' is the Attention layer's routable to-do-like entity (S1+): a
// LEAF node, excluded from listNodes and every desk/room surface, listed only
// by its own workItems queries. NOT a desk — see the vocabulary quarantine
// (src/main/ai/vocabulary.ts). The retired declared-but-unbuilt 'task-item'
// kind is gone from this union (CR-05a); legacy rows of that kind remain
// tolerated at the DB layer (the CHECK keeps the literal) but no code creates
// or types them.
export type NodeKind = 'folder' | 'task' | 'work_item'
export type TaskStatus = 'open' | 'in_progress' | 'done' | 'parked'
export type SectionLayout = 'free' | 'grid' | 'stacks' | 'icons' | 'list'

// Pin-to-screen zones. Pinned widgets dock to one of four corners; multiple
// pins in the same zone stack horizontally without overlap. Legacy widgets
// pinned by pixel-position (pinnedScreenX/Y) still render via the old path
// when pinnedZone is null.
export type PinZone = 'tl' | 'tr' | 'bl' | 'br'

export type WidgetKind =
  // The desk's own tasks. The only part of the "desk as a lens" idea that needs
  // no new storage: a desk is a node and its tasks are its children.
  | 'task-list'
  // Several numbers read together, each with the readings behind it.
  | 'metrics'
  // The handful of people this desk is actually about.
  | 'contacts'
  // The inbox narrowed to what this desk is about, by a rule the user writes
  // and can see. Content is JSON: see InboxContent.
  | 'inbox'
  // A real location, on a real map, for the address this desk is about.
  | 'location-map'
  // What is due on this desk, on a month grid, alongside dates the user adds.
  | 'calendar'
  // A single number that is being watched, with its direction of travel and a
  // sparkline of how it got there. Content is JSON: see StatCardContent.
  | 'stat-card'
  // A grid of pictures, which is how a set of images is usually actually read
  // -- one image widget per photo makes a desk into a filing cabinet.
  | 'gallery'
  // Prompt-to-image on the canvas. Content is the fb_files id of the generated
  // image (never the image bytes — see generateImageToFile), so it renders
  // through the same fb-file:// path as any other image on a desk.
  | 'image-gen'
  | 'sticky'
  | 'note'
  | 'markdown'
  | 'webview'
  | 'pdf'
  | 'gdoc'
  | 'gsheet'
  | 'gslide'
  | 'email'
  // A pinned PlexiChat conversation: stores { conversationId, channelName } in
  // content, renders a compact live view of the thread with an Open button.
  | 'chat-thread'
  | 'calculator'
  | 'color'
  | 'image'
  | 'video'
  | 'timer'
  | 'section'
  | 'task-link'
  | 'local-app-launcher'
  // New: rich data primitives
  | 'file' // unified file widget — type detected from MIME / extension
  | 'drive' // a bound Files folder on the desk — lists it, opens it, saves into it
  | 'field' // single field (text, number, select, checkbox, etc.) on canvas
  | 'page' // Tiptap-based Notion-style document
  | 'table' // Notion/Airtable-style database with typed columns
  // Office documents on the canvas — a doc / spreadsheet / slide deck backed by
  // the fb_documents store (widget.content holds the document id), embedding the
  // full editor so the same file can live on a canvas and in the Documents view.
  | 'doc'
  | 'sheet'
  | 'slides'
  // PlexiDiagrams — a node/edge diagram & workflow document, embeddable on the
  // canvas like the other office docs (backed by an fb_documents row of type
  // 'map' — the stored value predates the PlexiDiagrams name and stays put).
  | 'map'
  // PlexiDesign — a Publisher/InDesign-class page-layout canvas (arbitrary-size
  // pages of freely-placed elements, master pages and threaded text frames),
  // embeddable on the desk like the other office docs (backed by an fb_documents
  // row of type 'design').
  | 'design'
  // PlexiDraw — the vector + painting studio (bezier paths, pathfinder booleans,
  // brush and eraser on raster layers), backed by an fb_documents row of type
  // 'draw'.
  | 'draw'
  // The meeting Record on its desk (C5, S3-DEC-020's last sliver): content
  // holds the meeting id; renders the Record's spans with their provenance
  // tiers and doors into PlexiMeet. Minted by the wrap-up beside the
  // transcript doc — deliberately absent from the add-widget catalogue, so
  // an empty shell can never be hand-placed.
  | 'meeting-record'
  // Stream Deck — Elgato-style 10×3 button grid with folder navigation,
  // macros, app launching, media keys, and volume control. Configuration
  // (buttons, folders, action payloads) lives in widget.content as JSON.
  | 'streamdeck'
  // Canvas minimap — bottom-right overview rectangle with widget silhouettes
  // and a draggable viewport rect. Auto-created on every new task pinned to
  // BR, but it's a regular widget the user can resize, unpin, drag to the
  // canvas, delete, or re-add via the widget picker like anything else.
  | 'minimap'
  // DEC-045 (CR-09 D-B) — the Attention widget ON A DESK. Scope lives in
  // widget.content as JSON {"scope":"desk"|"all"}; defaults to the desk it
  // sits on and falls back to all when that desk holds nothing.
  | 'attention'
  // Voice / video recorder — captures audio (and later webcam video) via
  // MediaRecorder, persists the blob through the files store, and runs
  // it through Whisper (OpenAI) for transcription, then Anthropic for
  // optional cleanup or summary. The widget owns the Record/Stop UI and
  // the post-record three-way mode picker (Full / Cleaned / Summary). A
  // separate post-processing modal surfaces extracted ActionProposals
  // (new tasks, new widgets, etc.) for one-click apply.
  | 'voice-recorder'
  // AI mind mapper — root-of-thought node tree. Each node has a label
  // and an optional kind classifier (idea / task / question / tool /
  // agent). Clicking a node fires Claude with the full root-path
  // context and generates 3-5 child branches. A side panel shows
  // suggested Agent OS agents that could execute on the node's topic,
  // sourced from .claude/agents/*.md and ranked by Claude.
  //
  // PHASE_2: embedded mini-widgets per node (tables, fields, searches)
  // PHASE_2: agent-creation wizard for "no matching agent" flow
  // PHASE_3: autonomous agent execution on the canvas via a runtime
  //   that watches state changes + proposes actions with kill switches
  | 'mindmap'
  // Diagram — a React Flow node/edge canvas for structured diagrams: flowcharts,
  // entity hierarchies, server/software design, mind-map-style trees, and basic
  // Venn (overlapping translucent circle nodes). Nodes can be boxes, circles,
  // text, or an uploaded image/icon; edges are connectors. The whole graph
  // (nodes + edges + viewport) is serialised to widget.content as JSON.
  | 'diagram'
  // Scratchpad — a freeform sketch surface (pressure-sensitive ink via
  // perfect-freehand) for quick drawings, annotations, and visual thinking.
  // Strokes + background are serialised to widget.content as JSON.
  | 'scratchpad'
  // Shape — a vector shape (rect/ellipse/diamond/triangle/hexagon/star/line/
  // arrow) with fill, stroke and an optional centred label. Stretches to fill
  // the widget. Config serialised to widget.content as JSON.
  | 'shape'
  // Card — a titled callout card: accent bar + bold title + multi-line body.
  | 'card'
  // Chart (PlexiDash) — a bar / line / area / pie / KPI view bound to a Table.
  // It reads the real rows of an fb_tables table and aggregates them per its
  // config (chart type, category column, value series + aggregation), which is
  // serialised to widget.content as JSON. Several charts on a desk form a
  // dashboard. Honest by construction: an unbound or empty chart shows a prompt,
  // never sample data.
  | 'chart'
  // Custom block — a WYSIWYG form/record designer: freely-placed typed fields
  // the user lays out themselves; doubles as a data-entry form. Layout + values
  // serialised to widget.content as JSON; can be saved as a reusable template.
  | 'custom-block'
  // A widget the user described in plain language and the AI wrote. The code is
  // a self-contained HTML document that runs in a sandboxed iframe with no
  // same-origin access, so "no limitations" applies to what it can BE, not to
  // what it can REACH. Content is JSON: see CustomWidgetContent.
  | 'custom'
  // Desk agent — a standing AI agent placed on the canvas. Its "senses" are the
  // live wires drawn INTO it (each wired-in widget's content is an input); it
  // holds a standing instruction and a trigger (manual / interval / on a wired
  // input changing), runs with a visible kill switch, and keeps a run log in its
  // own body. Config + history serialised to widget.content as JSON.
  | 'agent'
  // Portal — a live window into ANOTHER task's desk. Shows a shrunk,
  // content-aware miniature of the target desk, refreshed periodically; click to
  // dive in. The target task id is serialised to widget.content as JSON.
  | 'portal'
  // Living doc — a read-only document that writes itself. The user gives it a
  // brief (stored in livingQuery), and the AI keeps it as a running summary of
  // the OTHER widgets on the same desk, regenerated on demand and auto-refreshed
  // when source widgets change (see livingPageScheduler). content is serialized
  // Tiptap JSON, system-owned (never hand-edited). Reuses the living* fields.
  | 'living-doc'
  // Webhook (outbound) — an endpoint tool. Wire a widget INTO it and, on every
  // source change, the source's content is POSTed to the configured URL (main
  // process, so no CORS). content holds { url, method } as JSON. The wire's own
  // run status (freshness / error) reports the last send. This is the outbound
  // half of external webhooks (Lever 3); the inbound trigger is a separate kind.
  | 'webhook'
  // Inbound webhook (trigger) — the receiving half. It self-registers a hook with
  // the signal server and shows a unique URL; when an external system POSTs there,
  // the server relays the payload here and it lands in this widget's content,
  // firing any wire drawn OUT of it. content holds { hookId, url } as JSON. You
  // wire OUT of this (it's a source) — the mirror of the outbound 'webhook'.
  | 'inbound-hook'

export type ContextMenuAction =
  | 'createStickyFromSelection'
  | 'createNoteFromSelection'
  | 'openLinkInNewBrowser'
  | 'saveImageToCanvas'
  | 'saveVideoToCanvas'

export interface ContextMenuPayload {
  action: ContextMenuAction
  webContentsId: number
  x: number
  y: number
  selectionText?: string
  linkURL?: string
  srcURL?: string
}

export interface FbNode {
  id: string
  parentId: string | null
  kind: NodeKind
  title: string
  description: string
  status: TaskStatus
  // ── work_item fields (Attention layer S2, §2.2) — present only on
  // kind='work_item' rows; undefined on desks/rooms. `status` above is a
  // DERIVED projection for work_items (workItemState is authoritative);
  // dueAt is ISO-8601, deliberately distinct from the numeric desk dueDate.
  workItemState?: string | null
  intentClass?: string | null
  intentSub?: string | null
  /** DEC-035: the item LEADING this item's group (a sibling ref, one level). */
  groupId?: string | null
  /** DEC-037: comma-delimited normalized tags. Optional, always. */
  tags?: string | null
  /** DEC-039: JSON entity mentions ({kind,id,title}[]) — people/desks/rooms/plans. */
  mentions?: string | null
  originatorId?: string | null
  recipientId?: string | null
  dueAt?: string | null
  wiUrgency?: string | null
  sourceRef?: string | null
  sourceUrl?: string | null
  // DEC-063 — the meeting a `to_meet` item points at. Optional throughout: an
  // item can be a bare "meet with Sam" long before any of it is known.
  meetStartAt?: string | null
  meetDurationMin?: number | null
  meetUrl?: string | null
  meetLocation?: string | null
  meetAttendees?: string | null
  meetRsvp?: MeetRsvp | null
  sourceType?: string | null
  confidence?: number | null
  approvalState?: string | null
  reasonCode?: string | null
  wiOrigin?: string | null
  schemaEpoch?: number | null
  // Device-local satellite fields (wi_local), joined at read by listWorkItems
  // ONLY — never synced, never in bodies (§2.4). detachedFromId marks the
  // Detached shelf (the desk this item was park-local'd from, F-M6″);
  // snoozeUntil hides an item from queues until it passes.
  detachedFromId?: string | null
  snoozeUntil?: number | null
  priority: AxisValue
  interest: AxisValue
  importance: AxisValue
  sortOrder: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
  // Planning fields (see shared/taskPlanning.ts). Optional everywhere: a task
  // is allowed to be nothing but a title, and most are.
  plannedStartAt?: number | null
  assignee?: string | null
  dependsOn?: string | null
  lagDays?: number | null
  attachmentsJson?: string | null
  estimateMinutes: number | null
  extensionsMinutes: number
  resumeMarkdown: string | null
  resumeUpdatedAt: number | null
  dueDate: number | null
  // Soft-delete / "put away" flag for folders and tasks. Archived nodes
  // are hidden from the main sidebar tree by default but remain
  // recoverable via the dashboard's archived view. Task `status` is
  // about the work itself (open / in_progress / done / parked); archived
  // is about whether the node should be visible in day-to-day surfaces.
  archived: boolean
  // Rooms/Desks/Plans split. Only meaningful on folder nodes: false = a plain
  // Room (organisation only), true = a Plan that appears in the Plans portfolio
  // and Gantt. Task nodes (Desks) leave this false; a Desk is never auto-added
  // to a plan. See migratePlanFlag in main/db/database.ts for the grandfather.
  isPlan: boolean
  // Handle of the person who shared this node with you, set when the node
  // was reconstructed from an accepted share. Null for your own nodes. The
  // sidebar uses it to show a "Shared by <handle>" badge + avatar.
  sharedFromHandle: string | null
  // The desk root id when this node belongs to a desk shared with named
  // individuals (per-desk ACL live share). Non-null = a live-shared room/desk, so
  // the galleries can mark it "Shared" and distinguish it from a personal one.
  sharedRootId: string | null
}

export interface NodeDraft {
  // Optional client-provided id (WS01 sync substrate): materialise with this exact
  // id so a create event from another device is idempotent. Omitted for local creates.
  id?: string
  parentId: string | null
  kind: NodeKind
  title: string
  description?: string
  priority?: AxisValue
  interest?: AxisValue
  importance?: AxisValue
  estimateMinutes?: number | null
  dueDate?: number | null
  // Create this folder as a Plan (is_plan = 1) rather than a plain Room. Only
  // the Plans view sets this; every other create path leaves it a Room.
  isPlan?: boolean
  // Set when reconstructing a node from an accepted share — stamps the
  // sharer's handle so the UI can badge it.
  sharedFromHandle?: string | null
}

export interface NodePatch {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: AxisValue
  interest?: AxisValue
  importance?: AxisValue
  parentId?: string | null
  sortOrder?: number
  estimateMinutes?: number | null
  extensionsMinutes?: number
  resumeMarkdown?: string | null
  resumeUpdatedAt?: number | null
  dueDate?: number | null
  plannedStartAt?: number | null
  assignee?: string | null
  dependsOn?: string | null
  lagDays?: number | null
  attachmentsJson?: string | null
  archived?: boolean
  // Promote a Room to a Plan or demote it back. Lets the user say "this is a
  // plan" / "this is just a room" without recreating the node.
  isPlan?: boolean
}

// ── Time blocks (calendar time-blocking) ────────────────────────────────────
// A booked stretch of time on the calendar, optionally tied to a task. This is
// how the calendar goes from "tasks shown on their due day" to "I've booked
// 2-3pm to focus on this", and a block can launch a focus session for its task.
// DEC-052: 'missed' (the slot passed, work not done — what "replan undone"
// sweeps) and 'skipped' (deliberately let go) join the union. The db CHECK was
// dropped (migrateTimeBlocksStatusCheck); this union is the guard.
// DEC-063 — the answer owed on an invitation. `needed` is the state that makes
// a Meet item worth surfacing at all: somebody is waiting on you.
export type MeetRsvp = 'needed' | 'yes' | 'no' | 'maybe'

export type TimeBlockStatus = 'planned' | 'done' | 'missed' | 'skipped'

// When a time block is a scheduled meeting, it carries the room to join and the
// people invited to it. The room id is stable so the same link works for the
// host and every invitee: the join email, the calendar "Join" button, and the
// haptyx://meet?room= deep link all open this one room.
export interface TimeBlockMeeting {
  roomId: string
  invitees: string[] // email addresses the invite was sent to
  // DEC-063 — a meeting is not always Plexii's own room, and is not always
  // online. `joinUrl` is an EXTERNAL link (Google Meet, Zoom, Teams) that takes
  // precedence over the built-in room when set; `location` is where to
  // physically be. Both optional, and not exclusive: a hybrid meeting has both.
  //
  // roomId stays required and is still minted for every meeting: it costs
  // nothing, and it means a meeting that started as in-person can always be
  // joined remotely without editing anything. The payload is stored as JSON on
  // the block, so adding these needed no migration.
  joinUrl?: string | null
  location?: string | null
  /** Book-time step 7 — what this meeting needs to settle. Same free ride as
   *  joinUrl/location above: the payload is JSON on the block, no migration. */
  agenda?: string | null
}

export type TimeBlockRecurrence = 'daily' | 'weekly' | 'monthly'

export interface TimeBlock {
  id: string
  taskId: string | null // null = a generic focus/time block with no task
  title: string
  startMs: number // absolute start time
  durationMin: number
  status: TimeBlockStatus
  meeting?: TimeBlockMeeting | null // set when this block is a video meeting
  // Repeating blocks: every occurrence is a real row (materialised forward on a
  // rolling horizon by the main process), grouped by seriesId. recurrence is
  // carried on every occurrence so the series keeps extending from its newest
  // row; clearing it (delete "this and future") stops the series.
  recurrence?: TimeBlockRecurrence | null
  seriesId?: string | null
  // DEC-052 scheduling foundation. origin: who placed this block — 'manual'
  // (a person) or 'auto' (the planner); replan may only move 'auto' blocks.
  // locked: never moved by any scheduler — set by hand, or automatically when
  // an external edit is detected (the honour-and-pin convention). pushPolicy:
  // whether this block ever leaves Plexii for an external calendar ('local' is
  // the default and the convention).
  origin: 'manual' | 'auto'
  locked: boolean
  pushPolicy: 'local' | 'push'
  /**
   * The internal calendar this block belongs to, which decides its colour and
   * whether it is pushed out. Null means the default internal calendar.
   */
  calendarId?: string | null
  /**
   * Set once a block has been written to a linked calendar: the provider's own
   * event id, so a later edit updates that event instead of creating a second.
   */
  externalEventId?: string | null
  externalCalendarId?: string | null
  createdAt: number
  updatedAt: number
}

// ── Contacts ────────────────────────────────────────────────────────────────
// A person the workspace deals with. 'member' mirrors somebody in the org (the
// server stays the authority on their access); 'guest' is everybody else, which
// on most real work is half the people involved.
export interface Contact {
  id: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  role: string | null
  /** Postal address, free-text: addresses are not a schema anyone wins at. */
  address: string | null
  notes: string | null
  kind: 'guest' | 'member'
  /** Set when this contact is an org member. */
  accountId: string | null
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface ContactDraft {
  id?: string
  name: string
  email?: string | null
  phone?: string | null
  company?: string | null
  role?: string | null
  address?: string | null
  notes?: string | null
  kind?: 'guest' | 'member'
  accountId?: string | null
  tags?: string[]
  /** Link the new contact to this desk in the same call. */
  nodeId?: string | null
}

export interface ContactPatch {
  name?: string
  email?: string | null
  phone?: string | null
  company?: string | null
  role?: string | null
  address?: string | null
  notes?: string | null
  kind?: 'guest' | 'member'
  accountId?: string | null
  tags?: string[]
}

// ── External calendars (Google / Outlook / any ICS feed) ────────────────────
// A calendar that lives somewhere else and is mirrored here. Events from one
// are READ-ONLY in Plexii: they are a reflection of a fact held elsewhere, and
// pretending otherwise would let a sync quietly overwrite an edit.
/**
 * Where a calendar's entries come from.
 *
 * 'internal' is a calendar Plexii itself owns — time blocks live on one, and it
 * is listed and coloured beside the linked ones so a week reads as one diary.
 * The other three are mirrors of a calendar held somewhere else.
 */
export type ExternalCalendarProvider = 'internal' | 'ics' | 'google' | 'microsoft'

/**
 * Which directions a calendar can move entries.
 *
 *   'read'  pull only. An ICS feed is a published file: there is no way to write
 *           back to it, so offering two-way there would be a lie.
 *   'write' push only — Plexii blocks go out, nothing comes back.
 *   'both'  pull AND push. Only available on an OAuth account with write scope.
 *
 * Stored per calendar so the UI can say what a given calendar will actually do.
 */
export type CalendarSyncMode = 'read' | 'write' | 'both'

/** The colours a calendar can be given, chosen to stay legible on the grid. */
export const CALENDAR_COLORS = [
  '#2563eb',
  '#0891b2',
  '#059669',
  '#65a30d',
  '#ca8a04',
  '#ea580c',
  '#dc2626',
  '#db2777',
  '#7c3aed',
  '#475569'
] as const

export interface ExternalCalendar {
  id: string
  provider: ExternalCalendarProvider
  name: string
  color: string | null
  /** ICS: the feed URL. OAuth: the provider's own calendar id. */
  sourceRef: string
  accountId: string | null
  enabled: boolean
  lastSyncAt: number | null
  /** The reason the last sync failed, shown to the user verbatim. */
  lastSyncError: string | null
  /**
   * Which way entries move. A provider that cannot write is pinned to 'read'
   * regardless of what is stored, so a feed can never claim to be two-way.
   */
  syncMode: CalendarSyncMode
  /**
   * For an internal calendar with a push direction: the linked calendar its
   * blocks are written to. Null means Plexii keeps them to itself.
   */
  pushTargetId: string | null
  /** An internal calendar that new time blocks land on when none is chosen. */
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface ExternalCalendarDraft {
  id?: string
  provider: ExternalCalendarProvider
  name: string
  sourceRef: string
  color?: string | null
  accountId?: string | null
  syncMode?: CalendarSyncMode
  pushTargetId?: string | null
  isDefault?: boolean
}

export interface ExternalEvent {
  id: string
  calendarId: string
  uid: string
  title: string
  description: string | null
  location: string | null
  startMs: number
  endMs: number
  allDay: boolean
  status: string | null
  organizer: string | null
  url: string | null
  updatedAt: number
}

export interface ExternalCalendarSyncResult {
  calendarId: string
  ok: boolean
  events: number
  error?: string
  /** Rules the feed used that we could not expand; surfaced, never hidden. */
  warnings?: string[]
}

export interface TimeBlockDraft {
  // Optional client-provided id (WS01 sync substrate) for idempotent create.
  id?: string
  taskId?: string | null
  title?: string
  startMs: number
  durationMin: number
  meeting?: TimeBlockMeeting | null
  recurrence?: TimeBlockRecurrence | null
  /** Who is placing this block (default 'manual'). */
  origin?: 'manual' | 'auto'
}

export interface TimeBlockPatch {
  taskId?: string | null
  title?: string
  startMs?: number
  durationMin?: number
  status?: TimeBlockStatus
  meeting?: TimeBlockMeeting | null
  locked?: boolean
  pushPolicy?: 'local' | 'push'
  /** Move a block to a different internal calendar (and so a different colour). */
  calendarId?: string | null
  // Set by the push engine once a block exists on a linked calendar, so the next
  // push updates that event rather than creating a second copy of the meeting.
  externalEventId?: string | null
  externalCalendarId?: string | null
}

export interface Widget {
  id: string
  taskId: string
  kind: WidgetKind
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  color: string | null
  // Optional workflow status, used by the Columns view's status board (To sort /
  // In progress / Done / Reference). null = unset (reads as "To sort"). A real
  // synced field so a board means the same thing on every device.
  status: string | null
  pinned: boolean
  pinnedScreenX: number | null
  pinnedScreenY: number | null
  // null = legacy free-position pin (uses pinnedScreenX/Y). Set to one of the
  // four zones for the new auto-stacking pin model.
  pinnedZone: PinZone | null
  parentSectionId: string | null
  layout: SectionLayout | null
  // When a Connected App was dragged onto the canvas, this links the widget to that
  // app so the webview reuses the app's session partition (cookies, auth state) and
  // can auto-fill from the bound vault entry.
  sourceAppId: string | null
  // Render mode for local-app-launcher widgets:
  //  - 'launcher' (default): click-to-launch tile with icon + running indicator
  //  - 'mirror': punch-through live view of the real native app window, positioned
  //    behind a transparent region of the canvas. Click-through goes to the real
  //    app, full interactivity.
  // Null for non-launcher widgets.
  mode: 'launcher' | 'mirror' | null
  // Living-page fields — only meaningful when kind === 'page'. When
  // livingQuery is non-null the page is "living": its `content` (Tiptap
  // JSON) is regenerated periodically from the task's other widgets via an
  // Anthropic call. The user types the query (e.g. "summary of every note
  // about pricing") and the system keeps the page in sync as the task
  // accumulates more material. Setting livingQuery back to null flips the
  // page to manual mode (the user can then edit content directly).
  livingQuery: string | null
  livingGeneratedAt: number | null
  // Paused = don't auto-regen on widget changes. The user can still
  // "regenerate now" manually. Useful when the user wants the current
  // snapshot to stick.
  livingPaused: boolean
  createdAt: number
  updatedAt: number
  archived: boolean
  // When set, this widget is a LINKED duplicate: all widgets sharing the same
  // syncGroupId mirror their content + title + colour to each other (across
  // tasks). Position / size / which task each copy lives in stay independent.
  // null = standalone (not linked).
  syncGroupId: string | null
}

export interface WidgetDraft {
  // Optional client-provided id (WS01 sync substrate): when set, the widget
  // materialises with this exact id, so a create event from another device is
  // idempotent by primary key. Omitted for ordinary local creates.
  id?: string
  taskId: string
  kind: WidgetKind
  title?: string
  content: string
  x?: number
  y?: number
  width?: number
  height?: number
  color?: string | null
  sourceAppId?: string | null
  mode?: 'launcher' | 'mirror' | null
  // Pin a widget to a screen zone at creation time. Used by the minimap
  // auto-create flow (and any future "always-on" widget that should
  // dock to a corner from the moment it spawns). Defaults are unpinned
  // free-positioned via x/y.
  pinned?: boolean
  pinnedZone?: PinZone | null
  // Link this new widget into a sync group (used by Duplicate so the copy stays
  // in sync with its source).
  syncGroupId?: string | null
}

export interface WidgetPatch {
  title?: string
  content?: string
  x?: number
  y?: number
  width?: number
  height?: number
  zIndex?: number
  color?: string | null
  status?: string | null
  pinned?: boolean
  pinnedScreenX?: number | null
  pinnedScreenY?: number | null
  pinnedZone?: PinZone | null
  parentSectionId?: string | null
  layout?: SectionLayout | null
  sourceAppId?: string | null
  mode?: 'launcher' | 'mirror' | null
  livingQuery?: string | null
  livingGeneratedAt?: number | null
  livingPaused?: boolean
  archived?: boolean
  // Set to a group id to LINK this widget into a sync group, or null to UNLINK.
  syncGroupId?: string | null
}

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  role: ChatRole
  content: string
  ts: number
  /**
   * What an assistant turn actually DID, replayed so the model can see its own
   * work on the next turn.
   *
   * Actions travel in a separate JSON field from the reply, and only the reply
   * was ever stored and replayed. So on turn two the model saw every one of its
   * prior turns as prose with no actions attached, and had no evidence that the
   * actions channel was one it had been using. Asked to "show me the actions",
   * it did the reasonable thing and wrote "**Actions:**" as markdown — and from
   * then on its own history taught it that prose was the format, so it never
   * emitted a real action in that conversation again. Every retry added another
   * example and made it worse.
   *
   * Absent on user turns and on assistant turns that proposed nothing.
   */
  actions?: Array<{ kind: string; label?: string }>
}

// Text pulled from a browser / doc / pdf widget on the canvas, so the assistant
// can act on what the user is actually looking at (e.g. create calendar events
// from a booking page, an itinerary doc, or a PDF invoice).
export interface ChatAttachment {
  widgetId: string
  kind: string
  title: string
  source?: string // URL for a browser widget, filename for a file, etc.
  text: string
}

// ── @-mentions (Phase 4) ────────────────────────────────────────────────────
// A typed, id-bearing reference to a real workspace object that the user named
// with "@" (or by clicking it). Deliberately NOT lib/mentions.ts's @handle text
// tokens, which live in PlexiChat, mean "notify this person", and carry no id —
// a text token can make no honest claim about what rode the request.
//
// This is the WIRE shape: what the main process needs to resolve the reference.
// The renderer's MentionRef adds an icon and the conversation it belongs to,
// both of which are presentation/state and stop at the IPC boundary.
export type ChatMentionKind =
  | 'document'
  | 'desk'
  | 'room'
  | 'widget'
  | 'file'
  | 'knowledge'
  | 'person'

export interface ChatMentionRef {
  kind: ChatMentionKind
  id: string
  title: string
  // The desk that owns a widget reference — what lets the resolver read a
  // widget on a desk the user is not currently looking at. (The renderer's own
  // attachment gathering stops at the current desk; this is what mentions add.)
  taskId?: string | null
}

// What a reference ACTUALLY produced, reported back so the renderer can be
// honest about it. A reference that resolved to nothing must never render as
// though the assistant read it.
export interface ChatMentionResolved {
  kind: ChatMentionKind
  id: string
  title: string
  // True only when real text was extracted AND genuinely reached the prompt.
  resolved: boolean
  // How many characters actually rode, after every cap.
  chars: number
  // The prompt budget cut this reference short. Stated, never silent.
  truncated: boolean
  // Why it did not resolve, when it did not. Null when it did.
  reason: string | null
}

export interface ChatRequest {
  taskId: string | null
  messages: ChatMessage[]
  // Live content the user has open on the canvas, gathered by the renderer.
  attachments?: ChatAttachment[]
  // Workspace objects the user explicitly referenced for this conversation
  // (Phase 4). Additive and optional, exactly like pinnedWidgetId before it, so
  // every surface that does not offer mentions is untouched. Their content is
  // force-included ahead of retrieved material, and the prompt claims a
  // reference ONLY when its text genuinely rendered (see chatMentions.ts).
  mentions?: ChatMentionRef[]
  // Layer-1 structural index of the whole workspace (ids + titles, no bodies),
  // gathered by the renderer so the assistant knows what exists and can act on
  // real items. Optional: absent for callers that don't provide it.
  workspace?: WorkspaceSnapshot
  // The calling surface can render a structured follow-up question card. Only
  // then does the system prompt teach the ask-protocol — chat:send is shared
  // by surfaces (focus chat, dashboard cards, field editor) that have no card
  // to render, and a model taught to ask there produces turns that dead-end.
  supportsQuestions?: boolean
  // Whether to inject the self-building memory block ("what I know about you").
  // On only for conversational surfaces (assistant panel / focus chat), off for
  // the field editor / command bar / one-off completions where it's noise + cost.
  includeMemory?: boolean
  // The widget the user clicked-to-pin as this conversation's primary
  // reference (Phase 3a.1). Additive and optional: surfaces with no pin
  // affordance never set it. The prompt claims a pin only when the id resolves
  // to an attachment that genuinely rendered (see chatAttachments).
  pinnedWidgetId?: string
  // The conversation's mode (Plexii P6). Absent means the normal assistant;
  // 'discovery' adds the guided-discovery prompt layer on top of everything
  // else. Optional so every non-conversational caller is untouched.
  mode?: AiChatMode
  // The persisted conversation this request belongs to, when there is one.
  // Retrieval uses it to keep the CURRENT conversation out of the chat-history
  // pool (A2, #17) — its content is already the message history, and citing it
  // back as a discovered source would be theatre. Optional and additive.
  conversationId?: string
  // The conversation's R21 globe toggle: false turns the live web search off
  // for this turn. Optional and additive — absent means on, so every caller
  // that predates the toggle behaves exactly as before.
  webSearch?: boolean
}

// A retrieved workspace document the assistant was grounded on. Slimmed from
// the main process's WorkspaceSource: the renderer needs enough to label, order
// and open a citation — not the full extracted body that went to the model.
export interface ChatSource {
  // 1-based citation number. Matches the [n] markers the model is told to use
  // inline in its reply, so a marker and its chip always refer to the same doc.
  n: number
  docId: string
  title: string
  docType: string
  snippet: string
}

// One action the assistant prepared, surfaced in the retrieval trace the moment
// its JSON object completes in the stream — before the whole response lands.
// Deliberately NOT an ActionProposal: this is read off the raw envelope ahead of
// sanitisation, so `kind` is whatever the model wrote and the entry is a record
// of what happened, not a promise that a card will appear.
export interface ChatToolTrace {
  // 0-based order of arrival within this response.
  index: number
  kind: string
  // The line the trace draws, e.g. "Email draft → Ryan".
  label: string
}

// Fired the moment retrieval returns, carrying what it found and how long it
// actually took. An empty `sources` array is a real result — it means the
// workspace had nothing relevant, which the trace shows honestly rather than
// hiding.
export interface ChatRetrievalTrace {
  sources: ChatSource[]
  elapsedMs: number
  // False when no embedding route was configured, so the search was literal
  // keyword matching — the trace discloses it (defect #15: "churn" does not
  // find "attrition" and nothing said so). Absent on an older main process
  // (version skew): read as unknown, disclose nothing.
  semantic?: boolean
  // What actually ran this turn (A4, AI-10). A discovery ideation turn gates
  // both pools and the trace must not claim a search that never happened;
  // false here suppresses the corresponding trace line. Absent on an older
  // main process: read as "everything ran", the pre-A4 truth.
  searched?: { workspace: boolean; web: boolean }
}

// A structured follow-up the assistant asks instead of guessing — rendered as
// a choice card above the composer. Emitted by the model inside the
// {reply, question, actions} envelope, and only ever taught to surfaces that
// declared supportsQuestions on the request. Single-select; answering sends
// the chosen option (or the user's own words) as a normal user turn.
export interface ChatQuestion {
  prompt: string
  // 2–5 short, mutually exclusive choices.
  options: string[]
  // Whether typing in the composer is a valid answer ("Or, describe it…").
  // False means only the listed options make sense.
  allowFreeText: boolean
}

export interface ChatResponse {
  ok: boolean
  message?: ChatMessage
  error?: string
  needsApiKey?: boolean
  // Action proposals returned alongside the text. The assistant declares what
  // it WOULD do; the renderer shows each as a confirmable card and only
  // executes those the user accepts. Empty/undefined for plain chat replies.
  proposals?: ActionProposal[]
  // The workspace material this answer was grounded on. Retrieval already ran on
  // every message to build the prompt; returning it lets the renderer show what
  // the answer stands on instead of discarding it.
  sources?: ChatSource[]
  // A follow-up question the model asked instead of acting on a guess. Present
  // only when the model actually emitted one — the renderer must never invent
  // or show a question the model did not ask.
  question?: ChatQuestion
  // What each @-mention on the request actually produced (Phase 4). Present
  // only when the request carried mentions. This is the sole source of truth
  // for the trace's "Mentioned" lane and for marking a chip broken — the
  // renderer may not assume a reference resolved just because it was sent.
  mentions?: ChatMentionResolved[]
  // Interactive UI blocks the model emitted in this turn (Plexii P4): choice
  // chips, scales, icon rows, cards. Present only when the model emitted valid
  // ones — the renderer never invents interactivity the turn did not carry.
  blocks?: ChatUiBlock[]
}

// ── Interactive UI blocks (Plexii P4) ────────────────────────────────────────
// The envelope's optional "blocks" array: visual, tappable elements the model
// emits INSIDE an answer so replies read as UI, not walls of text. Tapping an
// option sends the user's selection back as their next chat message — blocks
// carry interaction, never state of their own. Sanitised in main
// (ai/chatUiBlocks.ts) before anything renders.
export type ChatUiBlock =
  | {
      type: 'choices'
      id: string
      // Optional one-line lead-in above the options.
      prompt?: string
      // Multi-select renders toggles + a confirm; single-select sends on tap.
      multi?: boolean
      options: Array<{ id: string; label: string; icon?: string; description?: string }>
    }
  | {
      type: 'scale'
      id: string
      label: string
      min: number
      max: number
      minLabel?: string
      maxLabel?: string
    }
  // Presentational: a row of real icons with labels (apps, tools, steps).
  | { type: 'icon-row'; items: Array<{ icon: string; label: string }> }
  // Presentational: small tinted info cards (icon, title, one-line body).
  | { type: 'cards'; items: Array<{ icon?: string; title: string; body?: string }> }

// ── Agentic loop (multi-round: propose → apply → observe → re-plan) ──────────
// One step of the agent loop returns the same ActionProposal[] the chat uses,
// plus a status the host loop-driver reads to decide whether to continue. The
// model NEVER reports a round number (host-tracked); `blocker` is required and
// nullable so a driver can never optional-chain past a missing reason.
export type AgentStatus = 'working' | 'done' | 'blocked' | 'need_input'

export interface AgentStepResult {
  ok: boolean
  needsApiKey?: boolean
  error?: string
  // Short first-person narration of what this step is doing / found.
  narration: string
  // The actions to apply this round (same union + applier as chat).
  actions: ActionProposal[]
  status: AgentStatus
  // Why the loop stopped or what it needs, when status is blocked/need_input;
  // null when status is working/done. Never optional — always present.
  blocker: string | null
  // The raw assistant JSON of this round, so the driver can thread it back as an
  // assistant turn on the next round (the loop's memory lives in `messages`).
  rawAssistant: string
  // The system prompt used this round. Built once at round 0 and echoed back so
  // the driver can pass it verbatim on later rounds, keeping the cached prefix
  // byte-identical across the whole run.
  systemPrompt: string
}

// The outcome of applying one proposal in a round, rendered into the OBSERVATIONS
// block fed to the next round. createdId is null honestly when the kind registers
// no id (never fabricated).
export interface AgentActionOutcome {
  kind: string
  ok: boolean
  message: string
  createdId: string | null
}

// ── Situational proactivity (workspace radar) ────────────────────────────────
// A cheap, deterministic (no-LLM) detector surfaces actionable situations across
// the user's REAL work in Plexii — tasks, inbound mail, and the calendar — as
// one-tap suggestions they can act on or dismiss.
export type RadarKind = 'overdue' | 'due_soon' | 'stalled' | 'reply_needed' | 'meeting_soon'

// Where a suggestion's "Open" navigates.
export type RadarNav =
  | { view: 'task'; taskId: string }
  | { view: 'mail'; uid: number }
  | { view: 'calendar' }

export interface RadarSuggestion {
  // Stable per (kind + underlying entity), so re-runs dedupe and a dismiss sticks.
  id: string
  kind: RadarKind
  title: string
  detail: string
  nav: RadarNav
  severity: 'info' | 'warn'
}

// ── Self-building memory ─────────────────────────────────────────────────────
export type MemoryKind = 'fact' | 'preference' | 'commitment'

export interface MemoryItem {
  id: string
  kind: MemoryKind
  text: string
  // The entity this concerns (person/org/project), when there is one.
  subject: string
  // For a commitment: the deadline phrase, verbatim from the source (may be '').
  due: string
  // 'user' = stated explicitly; 'extracted' = distilled by the local model.
  source: 'user' | 'extracted'
  // The doc/chat id it was extracted from, when source is 'extracted'.
  sourceRef: string
  confidence: number
  active: boolean
  createdAt: number
  updatedAt: number
}

// ── Action proposals (AI → workspace actions, gated by user confirmation) ───
// The assistant can propose to create widgets, spawn tasks, open URLs, start
// focus sessions, etc. Each proposal has a stable id (for selection state)
// and a typed payload. The renderer's actionExecutor.ts knows how to apply
// each kind.

// Where the navigate-to proposal can send the user. Each value maps to a
// useViewStore go* action in actionExecutor's applyNavigateTo.
export type NavigateTarget =
  | 'home'
  | 'rooms'
  | 'desks'
  | 'shared'
  | 'documents'
  | 'files'
  | 'mail'
  | 'messages'
  | 'inbox'
  | 'calendar'
  | 'meetings'
  | 'forms'
  | 'vault'
  | 'search'
  | 'reports'
  | 'insights'
  | 'org'
  | 'peoplemap'
  | 'knowledge'
  | 'apps'
  | 'sign'
  | 'projects'
  | 'flows'
  | 'marketplace'
  | 'design'
  | 'task'
  | 'document'
  | 'product'

export type ActionProposal =
  | {
      id: string
      kind: 'create-widget'
      widgetKind: WidgetKind
      title?: string
      content?: string
      // DEC-032: the desk this belongs on, when the user named one. A real
      // node id from the desk roster the model is shown; the card resolves it
      // (id, else title) and applies there WITHOUT asking. Omitted = use the
      // desk the user is on, and only ask when there is none.
      deskId?: string
      reason?: string
    }
  | {
      // Create a configured desk agent in one step. The applier serialises a
      // real AgentConfig (see deskAgent.ts) from these fields, so the AI can set
      // up a working agent from a plain instruction rather than emitting an
      // opaque agent-widget content blob. trigger/intervalSec default to a
      // manual, disabled agent so nothing runs until the user turns it on.
      id: string
      kind: 'create-agent'
      title?: string
      instruction: string
      profileId?: string
      trigger?: 'manual' | 'interval' | 'onChange'
      intervalSec?: number
      reason?: string
    }
  | {
      id: string
      kind: 'create-task'
      title: string
      notes?: string
      parentId?: string | null
      reason?: string
    }
  | {
      /**
       * A task ON the desk the user is already looking at.
       *
       * Distinct from create-task, which is a frozen wire verb meaning a DESK
       * -- a whole canvas -- and which saved Flows persist with that meaning.
       * Redefining it would have changed what every stored Flow does, so the
       * "task on this desk" case needed its own verb rather than a new default.
       *
       * This is the one the assistant should reach for almost always: most
       * tasks belong on the desk in front of you, and a desk nobody asked for
       * clutters the sidebar permanently.
       */
      id: string
      kind: 'add-subtask'
      title: string
      notes?: string
      /** Defaults to the current desk. A task id makes it a subtask of that. */
      parentId?: string | null
      dueDate?: number | null
      assignee?: string | null
      reason?: string
    }
  | {
      // Reserved by the Attention layer (S0): a work_item — a routable,
      // to-do-like attention item, NOT a desk. Parsed and creation-gated
      // everywhere from day one so nothing can squat on the kind name; the
      // executor no-ops it until the work-items capability ships (S3+).
      id: string
      kind: 'create-work-item'
      title: string
      notes?: string
      // Which Attention queue this belongs to (to_do/to_review/to_decide/
      // to_respond/to_meet/to_discuss/to_remember/to_know). Omitted → to_do.
      intentClass?: string
      reason?: string
    }
  | {
      id: string
      kind: 'open-url'
      url: string
      title?: string
      reason?: string
    }
  | {
      // Agentic browsing (A6, AI-05): Plexii offers to drive the in-app
      // browser through a multi-step task. The card ACTS (R5): applying
      // opens the panel and starts a supervised run — visible, stoppable,
      // consent-gated — that the AgentRunDock narrates.
      id: string
      kind: 'agent-browse'
      task: string
      url?: string
      reason?: string
    }
  | {
      // System-wide navigation: jump to any area of the app. This is what lets the
      // voice assistant "open my calendar / go to Files / show the org chart" from
      // anywhere, regardless of the current context. Distinct from open-url, which
      // opens an external web page in a canvas webview widget.
      id: string
      kind: 'navigate-to'
      target: NavigateTarget
      targetId?: string // for target 'desks'(roomId) 'task' 'document' 'knowledge' 'product'
      label: string
      reason?: string
    }
  | {
      id: string
      kind: 'create-todo-list'
      title: string
      items: string[]
      // DEC-032: the desk this belongs on, when the user named one. A real
      // node id from the desk roster the model is shown; the card resolves it
      // (id, else title) and applies there WITHOUT asking. Omitted = use the
      // desk the user is on, and only ask when there is none.
      deskId?: string
      reason?: string
    }
  | {
      id: string
      kind: 'create-page'
      title: string
      content: string // serialized Tiptap JSON
      // DEC-032: the desk this belongs on, when the user named one. A real
      // node id from the desk roster the model is shown; the card resolves it
      // (id, else title) and applies there WITHOUT asking. Omitted = use the
      // desk the user is on, and only ask when there is none.
      deskId?: string
      reason?: string
    }
  | {
      id: string
      kind: 'start-focus-session'
      minutes: number
      reason?: string
    }
  | {
      id: string
      kind: 'delete-widget'
      widgetId: string
      label: string // user-facing description ("the empty sticky note")
      reason?: string
    }
  | {
      id: string
      kind: 'update-widget'
      widgetId: string
      label: string
      title?: string
      content?: string
      // Position / size mutations — all optional. Any field omitted is left
      // unchanged. Voice commands like "move this to the top right" or "make
      // it bigger" land here.
      x?: number
      y?: number
      width?: number
      height?: number
      // For content updates: replace (default) wipes the existing body,
      // append/prepend tack the new text onto either end with a leading
      // space/newline. Lets voice commands like "add 'call dentist' to my
      // todo list" append without obliterating the existing items.
      operation?: 'replace' | 'append' | 'prepend'
      reason?: string
    }
  | {
      id: string
      kind: 'link-widgets'
      // Source / target are widget ids. The voice interpreter resolves
      // user-friendly references ("the budget table") into ids before
      // returning this proposal — Apply just calls widgetLinks.create.
      sourceWidgetId: string
      targetWidgetId: string
      sourceLabel: string
      targetLabel: string
      // Optional live-wire semantics. Omitted -> a plain context wire (the old
      // behaviour). A planner that wires a source INTO an agent, or sets up a
      // transform, uses these so the wire actually carries the relationship.
      wireType?: WireType
      verb?: string
      reason?: string
    }
  | {
      id: string
      kind: 'focus-widget'
      widgetId: string
      label: string
      reason?: string
    }
  | {
      id: string
      kind: 'toggle-todo-item'
      // Mark an item in a Markdown / Page widget's task list as done/undone.
      // The renderer finds the line containing `itemMatch` (substring,
      // case-insensitive) and flips its `- [ ]` ↔ `- [x]` marker.
      widgetId: string
      widgetLabel: string
      itemMatch: string
      checked: boolean
      reason?: string
    }
  | {
      id: string
      kind: 'drill-in-widget'
      // Opens the widget in FocusMode (single-widget zoomed modal).
      widgetId: string
      label: string
      reason?: string
    }
  | {
      id: string
      kind: 'arrange-widgets'
      // Auto-layouts widgets into a tidy grid. When widgetIds is
      // omitted, applies to every non-pinned widget on the active task.
      widgetIds?: string[] | null
      label: string
      reason?: string
    }
  | {
      id: string
      // Group existing widgets into a new labelled Section (the Smart Stack
      // suggestion, unified onto the approval-card standard). One card per group.
      kind: 'create-section'
      name: string
      widgetIds: string[]
      reason?: string
    }
  | {
      id: string
      kind: 'create-table'
      title: string
      columns: Array<{
        label: string
        type:
          | 'text-short'
          | 'text-long'
          | 'number'
          | 'checkbox'
          | 'single-select'
          | 'multi-select'
          | 'date'
          | 'attachment'
          | 'button'
        options?: string[] // for select types
      }>
      // DEC-032: the desk this belongs on, when the user named one. A real
      // node id from the desk roster the model is shown; the card resolves it
      // (id, else title) and applies there WITHOUT asking. Omitted = use the
      // desk the user is on, and only ask when there is none.
      deskId?: string
      reason?: string
    }
  | {
      id: string
      kind: 'add-table-row'
      tableId: string
      cells: Record<string, string>
      reason?: string
    }
  | {
      id: string
      kind: 'create-field'
      label: string
      fieldType:
        | 'text-short'
        | 'text-long'
        | 'number'
        | 'checkbox'
        | 'single-select'
        | 'multi-select'
        | 'date'
      options?: string[]
      reason?: string
    }
  | {
      // Update an EXISTING task. taskId is a real node id the model was shown in
      // its context (see taskBlock). Any of the optional fields, when present,
      // is applied; omitted fields are left unchanged. This lets the assistant
      // act on work ("mark the Q3 brief done", "push the due date to Friday")
      // rather than only creating new things.
      id: string
      kind: 'update-task'
      taskId: string
      label: string // user-facing description of the task ("Q3 brief")
      title?: string
      status?: TaskStatus
      dueDate?: number | null // unix ms; null clears the date
      notes?: string // maps to the task description
      reason?: string
    }
  | {
      // Save a fact, decision, or process into PlexiBrain knowledge. Body must
      // carry real content from the conversation, never fabricated facts.
      id: string
      kind: 'create-knowledge-entry'
      title: string
      body: string
      tags?: string[]
      pinned?: boolean
      reason?: string
    }
  | {
      // Create a standalone document in the Documents library: a written doc, a
      // spreadsheet, a slide deck, a diagram/map, or a design canvas. Used when a
      // conversation produces a real deliverable that belongs as its own file
      // rather than a canvas widget.
      id: string
      kind: 'create-document'
      docType: 'doc' | 'sheet' | 'slides' | 'map' | 'design' | 'draw'
      title: string
      reason?: string
    }
  | {
      // Generate a POPULATED office surface with AI (a spreadsheet, a
      // presentation, a diagram / map / mind map, or a written document) and
      // place it on the desk. When `widgetId` names an existing output widget of
      // that type, its backing document is regenerated in place instead. The real
      // body is produced by a second AI call at apply time (documents.generate),
      // so the agent supplies only intent via `prompt` — never a hand-authored
      // body for schemas it would get wrong. This is how the desk agent creates
      // decks, sheets, maps and mind maps, not just plain text.
      id: string
      kind: 'generate-document'
      docType: 'doc' | 'sheet' | 'slides' | 'map'
      title: string
      prompt: string
      widgetId?: string
      reason?: string
    }
  | {
      // Edit an EXISTING document's content. documentId is a real id from the
      // documents context block, or "$<proposalId>" referencing a sibling
      // create-document in the same batch. Defaults to append — the least
      // destructive operation — when the model omits it; replace is available
      // but the doc_snapshots history makes even that recoverable.
      id: string
      kind: 'edit-document'
      documentId: string
      label: string // user-facing description ("the Q3 brief")
      title?: string
      body?: string // markdown-ish text; converted to the doc body format
      operation?: 'replace' | 'append' | 'prepend'
      reason?: string
    }
  | {
      // Write one or more cells in an EXISTING table row. v1 requires a real
      // rowId surfaced in the table context (no symbolic row refs — rows
      // created in the same batch are set via add-table-row's cells instead).
      // tableId may be real or a "$<proposalId>" create-table reference.
      id: string
      kind: 'set-cell'
      tableId: string
      rowId: string
      cells: Record<string, string>
      reason?: string
    }
  | {
      // Schedule a calendar time block. startMs is absolute unix ms — the
      // model resolves relative phrases itself using the current-time fact in
      // its context. Undoable via the shared action history.
      id: string
      kind: 'schedule-event'
      title: string
      startMs: number
      durationMinutes: number
      taskId?: string | null
      recurrence?: 'daily' | 'weekly' | 'monthly' | null
      reason?: string
    }
  | {
      // DRAFT ONLY: opens the mail composer pre-filled. There is deliberately
      // no send field — the human always reviews and sends. Never recorded on
      // the undo timeline (nothing was mutated).
      id: string
      kind: 'compose-mail'
      to?: string[]
      subject: string
      body: string
      reason?: string
    }
  | {
      // DRAFT ONLY: pre-fills the chat composer for a conversation the model
      // was shown. Same contract as compose-mail: a human presses send.
      id: string
      kind: 'post-chat'
      conversationId: string
      conversationLabel?: string
      body: string
      reason?: string
    }

// ── AI model routing ─────────────────────────────────────────────────────────
// The user picks a mode (Auto / Haiku / Sonnet / Opus). In Auto mode, each AI
// purpose has a sensible default. A manual override locks every call to that model.

export type ModelMode = 'auto' | 'haiku' | 'sonnet' | 'opus'

export type AIPurpose =
  | 'chat'
  | 'welcome'
  | 'setup'
  | 'resume'
  | 'trail_summary'
  | 'body_double'
  | 'smart_stack'
  | 'living_page'
  | 'wire_transform'
  | 'desk_agent'
  | 'command_route'
  | 'document'
  | 'doc_rewrite'
  | 'tone_profile'
  | 'email_reply_draft'
  | 'mail_triage'
  | 'file_tag'
  | 'meeting_end'
  | 'agent_step'
  | 'memory_extract'
  | 'browser_agent'
  // Attention S5: the capture console's intent classifier — a tight classify
  // into one of the eight intent classes, small JSON out, fires per capture.
  | 'intent_classify'
  | 'capture_cleanup'
  | 'custom_widget'

// Result of asking AI to draft a reply to an open email in the user's voice.
// `skip` is the expected, non-error outcome for newsletters / no-reply senders /
// nothing-to-reply-to. `needsApiKey` distinguishes a missing key from a real
// failure so the UI can point at Settings instead of showing a scary error.
export interface EmailReplyDraftResult {
  ok: boolean
  reply?: string
  confidence?: number
  note?: string
  skip?: boolean
  skipReason?: string
  needsApiKey?: boolean
  error?: string
}

// Desk time-travel: metadata for one canvas snapshot (the full widget payload
// lives in the DB and is fetched on demand).
// Document version history metadata (payload stays in the main process).
export interface DocSnapshotMeta {
  id: string
  docId: string
  at: number
  label: string
  title: string
}

export interface SnapshotMeta {
  id: string
  taskId: string
  at: number
  label: string
  widgetCount: number
}

// "Live wire" semantics for an inter-widget link. A dead line becomes a pipe:
//   context   — passive. The target's AI is told this source is a related
//               family member (the default; never acts on its own).
//   transform — reactive. When the SOURCE content changes, an AI call runs the
//               wire's `verb` over the source and writes the result into the
//               TARGET.
//   mirror    — reactive. The SOURCE's content is copied into the TARGET on
//               change (sync expressed as a connection, no AI).
export type WireType = 'context' | 'transform' | 'mirror'

// Inter-widget spatial link, now a typed "live wire". Directed (source →
// target) — users can draw a reverse link as a separate row to express
// asymmetric relationships. Rendered as a line on the canvas between the two
// widget centres, with a small badge showing its wire type.
export interface WidgetLink {
  id: string
  sourceWidgetId: string
  targetWidgetId: string
  taskId: string
  createdAt: number
  // Live-wire fields. Existing rows default to a passive 'context' wire.
  type: WireType
  // Free-text instruction for a 'transform' wire, e.g. "extract action items".
  verb: string
  // Kill switch — a disabled reactive wire stays drawn but never fires.
  enabled: boolean
  // Durable run state (reactive wires only). lastRunAt is when the engine last
  // fired this wire (including a checked-but-nothing-to-write no-op), so the
  // badge can show live / stale / just-ran and it survives a reload. lastError
  // is the last failure message, cleared on the next successful run.
  lastRunAt?: number | null
  lastError?: string | null
}

// A durable record of one reactive-wire WRITE into a target — captured whenever a
// transform or mirror wire overwrites a text target's content. It stores the
// before and after so the user can see exactly what an automation did and revert
// it in one click (the trust core). Table-target writes are structurally
// different (row-level) and are not recorded here. Pruned per-wire.
export interface WireRun {
  id: string
  wireId: string
  taskId: string
  sourceWidgetId: string
  targetWidgetId: string
  // Human label for the source (its title or kind) so the activity list reads in
  // plain language without a second lookup.
  sourceLabel: string
  wireType: WireType
  // The transform instruction, if any (empty for a mirror copy).
  verb: string
  at: number
  prevContent: string
  nextContent: string
}

// Result of a living-page regeneration. ok=true → returns freshly-generated
// Tiptap JSON in `content`. The renderer applies it via the widget store so
// the local optimistic copy stays in sync. skip=true → no relevant material
// on the canvas yet; the renderer should keep the prior content and surface
// "no source material" in the UI rather than blanking the page.
export interface LivingPageRegenerateResponse {
  ok: boolean
  content?: string
  generatedAt?: number
  skip?: boolean
  reason?: string
  error?: string
  needsApiKey?: boolean
}

// AI-generated presence narration (the existing "you're not alone, your
// pair-worker is still here" nudges). NOT the user-to-user body double
// feature — that's the BodyDouble* types below. Kept separate so the AI
// helper and the peer matching feature can evolve independently.
export interface BodyDoubleResponse {
  ok: boolean
  skip?: boolean // model decided no presence ping is warranted right now
  line?: string
  error?: string
  needsApiKey?: boolean
}

// ── Peer-to-peer body double feature ────────────────────────────────────────
//
// User-to-user body doubling — Omegle-style random matching for ADHD-style
// "I need someone working alongside me" sessions. Two strangers express an
// interaction preference; a matching service pairs them when their
// preferences are compatible; the session runs with whatever channels the
// shared preference allows.

// How much interaction the user wants during the session. Both partners
// must agree on a mode (compatible matching only — see matcher logic).
export type BodyDoubleMode =
  | 'silent' // names + presence dot only; no chat, no audio
  | 'greetings' // exchange one hello + "what are you working on", then quiet
  | 'light' // text chat available, occasional progress pings welcome
  | 'open' // full conversation; text + audio (when audio ships)

// The handle shown to a partner — pseudonymous "FocusedFalcon" style names
// generated client-side. No real identity, no auth. A user MAY choose a
// persistent handle later via Settings; v1 generates a fresh one per
// session for total deniability.
export interface BodyDoublePartner {
  handle: string
  // Optional one-line context: "drafting Q3 brief", "studying for finals".
  // Only shared when the agreed mode is >= greetings.
  workingOn?: string | null
  // Soft session start so the partner sees how long the OTHER user has
  // been in the room — useful for "this person just arrived" cues.
  joinedAt: number
}

// What the user puts on the matching queue.
export interface BodyDoubleRequest {
  mode: BodyDoubleMode
  workingOn?: string | null
  // Local handle — generated when the request is created. Tells the matcher
  // who to introduce on the other side.
  handle: string
}

// Status of the local user's session. Drives the UI: which panel renders,
// whether the chat is active, whether we keep polling for partners.
export type BodyDoubleStatus =
  | 'idle' // no active intent
  | 'looking' // in the matching queue, no partner yet
  | 'matched' // partner found, exchanging intros
  | 'connected' // session active
  | 'ending' // one side is wrapping up

export interface BodyDoubleChatMessage {
  id: string
  senderHandle: string // either local or partner; UI compares to know which side
  text: string
  ts: number
}

// ── Universal sharing (folders / tasks / widgets) ───────────────────────────
//
// Any user-owned entity in PlexiDesk can be shared via a token. The token
// resolves to a read-only view (no auth required) or a "collaborator" copy
// the recipient owns once they sign up. Same data model for folder, task,
// and widget — the kind field discriminates so consumers pick the right
// rendering.
//
// v1 generates tokens locally and stores them in the local DB. There's no
// global address book; the token URL is the only way to reach the share
// once distributed. When the production server lands, tokens get mirrored
// up so the URL resolves to a hosted viewer; the renderer code path stays
// identical.

// 'document' / 'docfolder' are the office kinds: a single doc/sheet/slides/map,
// or a Drive folder of them, shared as a read-only browser-renderable snapshot
// (and importable when the scope is 'copy'). See DocumentSnapshot / DocFolderSnapshot.
// 'file' is a raw Drive file (PDF, image, video, arbitrary binary): its metadata
// rides the snapshot while its bytes are hosted publicly by the share token, so
// the viewer can preview or download it. See FileSnapshot + the share-blob routes.
export type ShareableKind = 'folder' | 'task' | 'widget' | 'document' | 'docfolder' | 'file'

// Permission level granted by the share. Two levels in v1 — keeping it
// simple. "view" = read-only render. "copy" = recipient can sign up and
// clone the item into their workspace.
export type ShareScope = 'view' | 'copy'

export interface ShareLink {
  // Stable id (uuid) for revoking + tracking.
  id: string
  // Random opaque token used in the URL (e.g. fb.app/share/<token>).
  // Distinct from id so id can be exposed to the owner while the token
  // stays the address ring that controls access.
  token: string
  // What's being shared.
  kind: ShareableKind
  entityId: string
  // Human-readable label for the share list ("Q3 brief", "Marketing
  // folder"). Captured at create-time so revoked / renamed items still
  // make sense in the share manager.
  label: string
  scope: ShareScope
  // Audit fields.
  createdAt: number
  // null = never expires. Otherwise unix ms.
  expiresAt: number | null
  // Cached visit count for the share manager UI. Incremented by the server
  // when the viewer URL is hit. In local-mock mode this stays 0.
  viewCount: number
  // Revoke = soft-delete. The token stops resolving and the share manager
  // shows it as "Revoked" so the owner can audit who they shared with.
  revoked: boolean
  // Who created the share (a handle), so a recipient view can show "invited by
  // X" and the growth loop can attribute a sign-up to its inviter. Null when the
  // sharer was signed out or for shares created before attribution existed.
  createdBy?: string | null
}

// Items shared WITH the current user — the "Shared with me" sidebar
// section. v1 these are populated when the user accepts a share invite;
// production will sync from the server on sign-in.
export interface SharedItem {
  id: string
  token: string
  kind: ShareableKind
  // Cached snapshot of the shared content for offline viewing. For
  // folders this is the folder + its task tree; for tasks it's the task
  // + its widgets; for widgets it's the widget record.
  snapshot: unknown
  // Who shared it — pseudonymous handle until accounts ship.
  fromHandle: string
  acceptedAt: number
  scope: ShareScope
}

export interface SmartStackGroup {
  name: string
  widgetIds: string[]
  reason: string
}

export interface SmartStackResponse {
  ok: boolean
  groups?: SmartStackGroup[]
  error?: string
  needsApiKey?: boolean
}

// Trail event kinds — append new ones; never repurpose existing.
export type ActivityKind =
  | 'task_switched'
  | 'widget_added'
  | 'widget_focused'
  | 'widget_removed'
  | 'browser_nav'
  | 'note_edit'
  | 'chat_sent'
  | 'session_started'
  | 'session_ended'
  | 'ai_setup_run'
  | 'resume_generated'

export interface ActivityEvent {
  id: string
  taskId: string | null
  ts: number
  kind: ActivityKind
  payload: Record<string, unknown>
}

export interface ActivityRecordDraft {
  taskId: string | null
  kind: ActivityKind
  payload?: Record<string, unknown>
}

export interface TrailSummaryResponse {
  ok: boolean
  summary?: string
  eventCount?: number
  error?: string
  needsApiKey?: boolean
}

export type FocusSessionOutcome = 'done' | 'continued' | 'abandoned'

export interface FocusSession {
  id: string
  taskId: string | null
  kind: string // '5min' | 'custom' (string for forward-compat)
  plannedSeconds: number
  startedAt: number
  completedAt: number | null
  actualSeconds: number | null
  outcome: FocusSessionOutcome | null
}

export interface FocusSessionStartDraft {
  taskId: string | null
  kind?: string
  plannedSeconds: number
}

export interface FocusSessionCompletePatch {
  actualSeconds: number
  outcome: FocusSessionOutcome
}

// ── Haptics ──────────────────────────────────────────────────────────────────

export type HapticFeel = 'light' | 'medium' | 'success' | 'warning' | 'rigid'

// ── Energy log ───────────────────────────────────────────────────────────────

export type EnergyLevel = 'low' | 'medium' | 'high'

export interface EnergyLogEntry {
  id: string
  ts: number
  level: EnergyLevel
}

// ── Dashboard layouts (Phase 6) ──────────────────────────────────────────────

export type DashboardCardKind =
  | 'daily-brief'
  | 'quick-start'
  | 'stats'
  | 'garden'
  | 'today-tasks'
  | 'recent-activity'
  | 'energy'
  | 'folders'
  | 'workspace-progress'
  | 'workspace-health'
  | 'focus-session'
  | 'ai-assistant'
  | 'recent-notes'

// ── Unified dashboard model (dashboard unification, docs/DASHBOARD-UNIFICATION.md)
// The single card taxonomy that supersedes both the domain-specific
// DashboardCardKind union above and the declarative ModuleDashboard sections, so
// one engine renders every surface (Home + every module). Five data-shape kinds
// plus a `custom` escape hatch for genuinely interactive cards. A card instance
// carries its config (built live per render from the module's real stores); the
// engine only lays out and chromes cards, it never fetches data.
export type PlexiCardKind = 'metric-row' | 'chart' | 'breakdown' | 'list' | 'activity' | 'custom'

// The visual size a portlet occupies on the dashboard. Small/Medium/Large map to
// grid column-span and a min-height so the choice is a real visual difference.
export type DashboardCardSize = 'small' | 'medium' | 'large'

// How many columns a dashboard flows its portlets into. Responsive rules may
// collapse this to 1 on narrow widths, but the stored preference is 1, 2 or 3.
export type DashboardColumns = 1 | 2 | 3

export interface DashboardLayout {
  dashboardKey: string // 'home' for the master dashboard, or a project node id
  cardIds: DashboardCardKind[]
  // Column count chosen for this dashboard. Defaults to 2 when a legacy layout
  // (bare card-id array) is loaded and no column preference was ever saved.
  columns: DashboardColumns
  // Per-card size overrides. A card absent from this map renders at its default
  // ('medium'). Legacy layouts load with an empty map so every card is medium.
  sizes: Partial<Record<DashboardCardKind, DashboardCardSize>>
  updatedAt: number
}

// Default column count for a dashboard that has never had a preference saved.
export const DEFAULT_DASHBOARD_COLUMNS: DashboardColumns = 2

// The payload the renderer sends when persisting a dashboard. Columns and sizes
// are optional so an old-style card-only save preserves the stored preferences.
export interface DashboardLayoutInput {
  cardIds: DashboardCardKind[]
  columns?: DashboardColumns
  sizes?: Partial<Record<DashboardCardKind, DashboardCardSize>>
}

// ── Vault (Phase 7) ──────────────────────────────────────────────────────────
// Master-password-encrypted credential storage. All ciphertext is base64. The vault
// has TWO states from the user's perspective: locked (master password needed) and
// unlocked (master key kept in renderer memory until lock).

export interface VaultMeta {
  exists: boolean
  iterations: number
  salt: string // base64
  verifierIv: string // base64
  verifierCiphertext: string // base64 — encrypts a known plaintext to verify the master password
  createdAt?: number
  updatedAt?: number
}

export interface VaultEntryStored {
  id: string
  title: string
  url: string | null
  username: string | null
  iv: string // base64
  ciphertext: string // base64 — encrypts a JSON blob: { password, totp, notes }
  sortOrder: number
  createdAt: number
  updatedAt: number
}

// Decrypted in renderer only — never crosses IPC after unlock
export interface VaultSecret {
  password?: string
  totp?: string // base32 secret for RFC 6238 TOTP
  notes?: string
}

export interface VaultEntryDraft {
  title: string
  url?: string | null
  username?: string | null
  iv: string
  ciphertext: string
}

export interface VaultEntryPatch {
  title?: string
  url?: string | null
  username?: string | null
  iv?: string
  ciphertext?: string
}

// 'web' apps render inside an Electron <webview> (existing behaviour). 'local'
// apps are native macOS apps launched via `open -a` — they can't render inside
// the canvas (only HTML can), so they spawn launcher tiles instead.
export type ConnectedAppKind = 'web' | 'local'

export interface ConnectedApp {
  id: string
  title: string
  // For 'web' apps this is the homepage URL. For 'local' apps it's the file://
  // path or just left as the appPath for back-compat (the source of truth for
  // local apps is `appPath`).
  url: string
  icon: string // Material Symbols name (fallback when no real icon is cached)
  color: string | null
  sortOrder: number
  kind: ConnectedAppKind
  // Local-app fields. For web apps both are null. `appPath` is the .app bundle
  // path on disk (e.g. /Applications/Spotify.app); `bundleId` is the macOS
  // bundle identifier (e.g. com.spotify.client) when available.
  appPath: string | null
  bundleId: string | null
  // Base64-encoded PNG of the app's real icon, captured at create-time via
  // Electron's app.getFileIcon. Cached so we don't hit disk on every render.
  iconPngBase64: string | null
  // Pinned to the always-visible Favourites strip in the sidebar.
  pinned: boolean
  // Auto-promoted into Favourites by usage if pinned=false; sorted by recency × count.
  useCount: number
  lastUsedAt: number | null
  // Vault binding for auto-fill. null when the user hasn't linked credentials.
  // Only meaningful for kind='web' — local apps don't have web forms to fill.
  vaultEntryId: string | null
  autofillEnabled: boolean
  createdAt: number
  updatedAt: number
}

export interface ConnectedAppDraft {
  title: string
  url: string
  icon?: string
  color?: string | null
  pinned?: boolean
  vaultEntryId?: string | null
  kind?: ConnectedAppKind
  appPath?: string | null
  bundleId?: string | null
  iconPngBase64?: string | null
}

export interface ConnectedAppPatch {
  title?: string
  url?: string
  icon?: string
  color?: string | null
  pinned?: boolean
  vaultEntryId?: string | null
  autofillEnabled?: boolean
  appPath?: string | null
  bundleId?: string | null
  iconPngBase64?: string | null
}

export interface BrowsingHistoryEntry {
  url: string
  title: string
  host: string
  taskId: string | null
  firstVisitedAt: number
  lastVisitedAt: number
  visitCount: number
}

// ── AI Builder ──────────────────────────────────────────────────────────────
// Richer than WidgetSuggestion: each AI Builder suggestion can carry a full
// table schema (for table widgets), a Tiptap doc (for page widgets), or a
// field definition (for field widgets). The shapes are deliberately optional
// per-kind so the AI can omit irrelevant payloads.

export interface AiBuildSuggestion {
  id: string // unique within the response, used for selection bookkeeping
  kind: WidgetKind
  title: string
  reason: string // one-sentence "why this helps"
  // Common content (used by sticky, note, markdown, webview/pdf/gdoc URLs,
  // color, calculator, timer JSON, etc.)
  content?: string
  // For kind='page': Tiptap document JSON. We pass through as an opaque
  // object — the renderer serializes it before saving into widget.content.
  pageContent?: object
  // For kind='table': schema with columns. The renderer creates the backing
  // fb_tables row before spawning the widget.
  tableSchema?: {
    columns: Array<{
      id: string
      type: string
      label: string
      config: unknown
    }>
  }
  // For kind='field': initial field definition. Same shape as FieldDefinition
  // but kept untyped here so the shared module doesn't import @shared/fields
  // (which would create a circular reference for some toolchains).
  fieldDef?: {
    id: string
    type: string
    label: string
    config: unknown
  }
}

export interface AiBuildResponse {
  ok: boolean
  // One-sentence interpretation of what the user wants. Shown above the
  // suggestion list so the user can verify the AI understood them.
  intent?: string
  suggestions?: AiBuildSuggestion[]
  error?: string
  needsApiKey?: boolean
}

export interface WidgetSuggestion {
  kind: WidgetKind
  title: string
  content: string
  reason: string
}

export interface SetupSuggestResponse {
  ok: boolean
  suggestions?: WidgetSuggestion[]
  error?: string
  needsApiKey?: boolean
}

export interface TemplateWidget {
  kind: WidgetKind
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  color: string | null
}

export interface Template {
  id: string
  name: string
  description: string
  sourceTaskId: string | null
  widgets: TemplateWidget[]
  createdAt: number
}

export interface TemplateDraft {
  name: string
  description?: string
  sourceTaskId: string | null
  widgets: TemplateWidget[]
}

// ── Mail (IMAP) ────────────────────────────────────────────────────────────
// Shapes shared by the main-process IMAP client, the preload bridge and the
// renderer mail store. The password is never part of any renderer-facing type.

export interface MailAccountInput {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  email?: string
}

export interface MailAccountPublic {
  configured: boolean
  host: string
  port: number
  secure: boolean
  user: string
  email?: string
}

export interface MailListItem {
  uid: number
  fromName: string
  fromAddress: string
  subject: string
  date: number
  seen: boolean
  flagged: boolean
  hasAttachments: boolean
  // RFC 5322 threading headers, used to group the mailbox into conversations.
  // messageId is this message's Message-ID; inReplyTo and references point at the
  // ancestors it was a reply to. All may be empty for a message with no headers.
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  /** The sender's own List-Unsubscribe target (RFC 2369), when they published
   *  one: an https link or a mailto. Null means this sender offered no way to
   *  unsubscribe -- a fact worth showing, not a gap to go looking in the body
   *  to fill, since a guessed opt-out link is how an address gets confirmed to
   *  a spammer. Carried on the list item because triage needs it for every
   *  message at once, and refetching headers per message to learn it would cost
   *  a round trip each. */
  unsubscribe: { kind: 'http' | 'mailto'; target: string } | null
  /** RFC 8058 one-click: the sender accepts an unsubscribe POST. */
  oneClickUnsubscribe: boolean
}

// ── Mail folders ─────────────────────────────────────────────────────────────
// Categorising a busy inbox without asking anybody to file anything.
//
// A folder here is a saved CRITERION that fills itself, not a drawer you drag
// messages into. The reason is the problem being solved: an inbox is not
// overwhelming because it lacks folders, it is overwhelming because everything
// arrives looking equally urgent -- and hand-filing is precisely the work that
// stops happening when somebody is drowning. A rule costs one setup and then
// keeps paying.
//
// Nothing here moves mail on the server. These are views over INBOX, which is
// what lets one message sit in two folders at once (an invoice about the Ridge
// St deal is both), lets a folder be undone without consequence, and keeps a
// mistake from being destructive. IMAP folders can do none of those.

/** What belongs in a folder, or what a desk's Inbox widget narrows to. */
export interface InboxRules {
  /** Any of these appearing in the sender's name or address. */
  from?: string[]
  /** Any of these appearing in the subject. */
  subject?: string[]
  unreadOnly?: boolean
  flaggedOnly?: boolean
  withAttachments?: boolean
  /** Only messages from the last N days. */
  sinceDays?: number | null
}

export interface MailFolder {
  id: string
  name: string
  /** A tint token so a folder is findable by colour, not only by reading. */
  colour: string
  rules: InboxRules
  /**
   * The desk or task this folder is about, when it is about one. Null is the
   * ordinary case -- a folder need not belong to anything.
   *
   * ON DELETE SET NULL, deliberately not CASCADE: deleting a desk must not
   * silently destroy somebody's mail categorisation. The folder survives,
   * having merely stopped being about that desk.
   */
  nodeId: string | null
  /**
   * Messages forced INTO this folder regardless of the rules, and forced OUT
   * of it regardless of the rules.
   *
   * These are what make a self-filling folder trustworthy rather than merely
   * clever. Without pinning, a rule that misses a message is a dead end and the
   * user is stuck widening a rule until it over-matches. Without excluding, one
   * stray match poisons the folder for good. Both are uid lists because a uid
   * is stable for the life of the mailbox.
   */
  pinned: number[]
  excluded: number[]
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface MailFolderDraft {
  name: string
  colour?: string
  rules?: InboxRules
  nodeId?: string | null
}

export interface MailFolderPatch {
  name?: string
  colour?: string
  rules?: InboxRules
  nodeId?: string | null
  pinned?: number[]
  excluded?: number[]
  sortOrder?: number
}

export interface MailFullMessage {
  uid: number
  fromName: string
  fromAddress: string
  to: string
  subject: string
  date: number
  text: string
  html: string | null
  attachments: { filename: string; size: number; contentType: string }[]
  // RFC822 Message-ID of this message and the References chain it carried, used
  // to thread a reply correctly (In-Reply-To + References headers on the way
  // out). Null when the server/message did not provide them.
  messageId: string | null
  references: string[]
  // Every recipient address on the original (To + Cc), so a "Reply all" can be
  // pre-populated without re-parsing. Excludes the user's own address at send
  // time, not here.
  toAddresses: string[]
  ccAddresses: string[]
}

// What the renderer hands the main process to send a message. Sent through the
// same account the user reads with; the main process derives SMTP from the
// stored IMAP host and reuses the stored app password.
export interface MailSendInput {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  // Plain-text body the user typed. HTML is generated from it on send so the
  // message has both parts; we do not author raw HTML in the composer.
  text: string
  // Threading headers when this is a reply — the original's Message-ID and the
  // References chain to append it to.
  inReplyTo?: string | null
  references?: string[]
}

export type MailSendResult = { ok: true } | { ok: false; error: string }

// ── Office documents (doc / sheet / slides) ─────────────────────────────────
// Standalone files created and edited as first-class artifacts. One table, one
// list, one AI-create flow; the body shape switches on docType.

// 'map' is PlexiDiagrams (the flowchart / diagram surface) and 'draw' is
// PlexiDraw (the vector + painting studio). The stored value for diagrams stays
// 'map' deliberately: it is written into every existing document row, and
// renaming a product is not a reason to rewrite a user's database.
export type DocType = 'doc' | 'sheet' | 'slides' | 'map' | 'design' | 'draw'

// A single global-search result. `type` decides how the renderer routes a click;
// `taskId` is the canvas to open for widget / table-row hits, `docType` the
// document kind. `snippet` is a short, match-centred excerpt for display.
export interface SearchHit {
  type:
    | 'task'
    | 'folder'
    | 'widget'
    | 'document'
    | 'file'
    | 'table-row'
    | 'knowledge'
    | 'event'
    | 'meeting'
    | 'sign'
    | 'mail'
  id: string
  title: string
  snippet: string
  score: number
  taskId?: string | null
  docType?: DocType
  widgetKind?: string
  /** For 'event' hits: the block's start, so the calendar can land on its month. */
  startMs?: number
}

// ── Spreadsheet body ────────────────────────────────────────────────────────
// v1 was a single grid of string cells: { columns, rows }. v2 wraps one or more
// such grids as named tabs and adds per-cell formatting, column widths, a freeze
// region and charts. v1 bodies on disk stay valid and are lifted to v2 on open
// by normalizeBody (src/renderer/src/lib/sheetBody.ts); nothing is rewritten at
// rest until the user edits. A cell whose value starts with '=' is a formula
// evaluated at render time; what cannot be computed shows #ERR, never a fake
// number.

export interface SheetBodyV1 {
  columns: string[]
  rows: string[][]
}

// How a value should be displayed (the engine still stores the true value).
export type SheetNumberFormat =
  | { kind: 'general' }
  | { kind: 'number'; decimals: number; thousands?: boolean }
  | { kind: 'currency'; decimals: number; symbol: string }
  | { kind: 'percent'; decimals: number }
  | { kind: 'date'; pattern: string }

export interface SheetCellFormat {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string // text colour, hex
  bg?: string // fill colour, hex
  align?: 'left' | 'center' | 'right'
  fontFamily?: string // CSS font-family (e.g. a Google font)
  numFmt?: SheetNumberFormat
}

export interface SheetChartSpec {
  id: string
  type: 'bar' | 'line' | 'pie' | 'area' | 'scatter'
  range: string // e.g. 'A1:C10' on the owning tab
  title?: string
  headerRow?: boolean // first row holds series labels
  headerCol?: boolean // first column holds category labels
  stacked?: boolean // stack bars/areas instead of grouping
}

// Conditional formatting — a rule paints cells in its A1 range whose computed
// value satisfies the condition. Rules apply in order; later matching rules
// override earlier ones for the same property. The cell's true value is never
// changed, only how it is shown (mirrors the honesty rule for number formats).
export type SheetCondOp =
  | 'gt'
  | 'lt'
  | 'ge'
  | 'le'
  | 'eq'
  | 'ne'
  | 'between'
  | 'contains'
  | 'notEmpty'
  | 'empty'

export interface SheetCondRule {
  id: string
  range: string // A1 range on the owning tab, e.g. 'B2:B20'
  // 'compare' (default) paints cells whose value satisfies op/value. The scale /
  // bar / icon kinds instead map every numeric cell in the range onto a gradient,
  // proportional bar, or threshold icon computed from the range's min..max.
  kind?: 'compare' | 'colorScale' | 'dataBar' | 'iconSet'
  op: SheetCondOp
  value?: string // comparison operand (number or text depending on op)
  value2?: string // upper bound for 'between'
  bg?: string // fill colour to apply when matched (compare)
  color?: string // text colour to apply when matched (compare)
  bold?: boolean
  // colorScale: 2-colour (min/max) or 3-colour when midColor is set.
  minColor?: string
  midColor?: string
  maxColor?: string
  // dataBar
  barColor?: string
  // iconSet
  iconSet?: 'arrows' | 'traffic' | 'triangles'
}

// Data validation — constrains what a cell in its range may contain. 'list'
// renders an in-cell dropdown; numeric/text rules flag invalid entries. The
// value is never silently changed; invalid input is marked, not faked.
export type SheetValidationRule =
  | { kind: 'list'; values: string[] }
  | { kind: 'number'; op: 'gt' | 'lt' | 'ge' | 'le' | 'eq' | 'between'; value: number; value2?: number }
  | { kind: 'textNotEmpty' }

export interface SheetValidation {
  id: string
  range: string // A1 range on the owning tab
  rule: SheetValidationRule
  strict?: boolean // when true, invalid entries are rejected on commit
}

// A pivot summary over a source range: group rows by one field, optionally
// across a second field, aggregating a value field. Computed read-only from the
// live data (honest: aggregates the real values, never fabricated ones).
export type SheetPivotAgg = 'sum' | 'count' | 'avg' | 'min' | 'max'
// A slicer: hide the listed values of a field so the pivot recomputes over the
// rest. Empty exclude = everything shown.
export interface SheetPivotFilter {
  field: number // 0-based column index within the range
  exclude: string[] // field values currently hidden
}

export interface SheetPivotSpec {
  id: string
  range: string // A1 source range INCLUDING the header row
  rowField: number // 0-based column index within the range to group rows by
  colField?: number // optional second field to pivot across columns
  valueField: number // column index whose values are aggregated
  agg: SheetPivotAgg
  title?: string
  // Interactive slicers — live value filters applied before aggregation.
  filters?: SheetPivotFilter[]
}

// A merged cell range, 0-based and inclusive of both corners.
export interface SheetMerge {
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface SheetTab {
  id: string
  name: string
  columns: string[]
  rows: string[][]
  // Sparse per-cell formatting keyed "r,c". Absent = general/default.
  formats?: Record<string, SheetCellFormat>
  colWidths?: Record<number, number> // px; absent = default
  rowHeights?: Record<number, number> // px; absent = default (0.75cm)
  // Merged cell ranges (0-based, inclusive). The top-left cell holds the value;
  // the covered cells are not rendered (the anchor spans them). Excel stores
  // merges the same way, so they round-trip through .xlsx.
  merges?: SheetMerge[]
  freeze?: { rows: number; cols: number }
  charts?: SheetChartSpec[]
  pivots?: SheetPivotSpec[]
  condRules?: SheetCondRule[]
  validations?: SheetValidation[]
  // Column filters: per-column-index the set of displayed values to HIDE. A row
  // is hidden when any filtered column's displayed value is in its hide-set. The
  // data is untouched; only which rows render changes.
  filters?: Record<number, string[]>
  filterActive?: boolean // funnels shown on the headers (Data > Create a filter)
  // Outline groups (Data > Group). A collapsed group hides its member rows/cols
  // below/right of the first, which carries the expand/collapse toggle.
  rowGroups?: Array<{ start: number; end: number; collapsed: boolean }>
  colGroups?: Array<{ start: number; end: number; collapsed: boolean }>
  // Power-Query-class data shaping: a snapshot SOURCE table plus ordered transform
  // STEPS. The tab's cells are the applied output; Refresh re-applies the steps.
  // Typed loosely here so shared/types stays free of the renderer query lib.
  query?: {
    source: { columns: string[]; rows: string[][] }
    steps: unknown[]
  }
}

export interface SheetBodyV2 {
  version: 2
  sheets: SheetTab[]
  activeSheet?: number
  // Workbook-level named ranges: a name maps to an A1 reference string such as
  // "A1", "A1:B10" or "Sheet2!A1:C3". Usable in any formula on any sheet.
  names?: Array<{ name: string; ref: string }>
}

export type SheetBody = SheetBodyV1 | SheetBodyV2

// ── Slides body ───────────────────────────────────────────────────────────────
// v1 slides were fixed title + bullets + notes + layout. v2 models each slide as
// a set of positioned ELEMENTS (text boxes, images, shapes, lines) in a fixed
// 1280x720 logical space, plus a deck theme and per-slide transition. v1 decks
// open unchanged and are converted to elements on load by migrateSlidesBody
// (src/shared/slidesMigrate.ts); the old title/bullets fields are kept optional
// so a half-migrated body still renders.

export type SlideLayout =
  | 'title'
  | 'title-content'
  | 'two-content'
  | 'section'
  | 'blank'
  | 'image-caption'
  // legacy value, mapped to 'title-content' on migration
  | 'bullets'

export type SlideTransition = 'none' | 'fade' | 'slide' | 'zoom' | 'morph'

// An element entrance animation, played when its slide appears in present mode.
// `order` staggers multiple animated elements; `durationMs` overrides the default.
export interface SlideAnim {
  type: 'fadeIn' | 'slideUp' | 'slideLeft' | 'zoomIn'
  order?: number
  durationMs?: number
}

export interface SlideFill {
  type: 'solid' | 'none' | 'gradient'
  color?: string
  // Gradient end color and angle (degrees). Used when type === 'gradient';
  // `color` is the start. Absent angle defaults to 135deg.
  color2?: string
  angle?: number
}
export interface SlideBorder {
  color: string
  width: number
  style?: 'solid' | 'dashed'
}

// Inline text run inside a text element.
export interface SlideTextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  fontSize?: number
}
export interface SlideTextParagraph {
  runs: SlideTextRun[]
  align?: 'left' | 'center' | 'right'
  bulletLevel?: number
  listStyle?: 'bullet' | 'number' | 'none'
}

interface SlideElementBase {
  id: string
  // Position + size in 1280x720 logical units.
  x: number
  y: number
  w: number
  h: number
  z: number
  rotation?: number
  // Marks elements that a theme is allowed to restyle (title/body/accent).
  styleRole?: 'title' | 'body' | 'accent'
  // Elements sharing a groupId select and move together as one group. Optional,
  // so legacy decks (no groups) are unaffected and need no migration.
  groupId?: string
  // Framing, shared by every element type: rounded corners (logical px) and a
  // drop-shadow preset. Absent means square corners and no shadow.
  cornerRadius?: number
  shadow?: 'sm' | 'md' | 'lg'
  // Element opacity 0..1. Absent means fully opaque.
  opacity?: number
  // Entrance animation played when the slide appears in present mode.
  anim?: SlideAnim
  // ── PlexiDesign page-layout fields ─────────────────────────────────────────
  // All optional, so a slide deck (which shares this element model) is
  // completely unaffected by their existence.
  //
  // The document layer this element belongs to. Absent means the base layer.
  layerId?: string
  // Text wrap: when set to 'square', threaded story text flows AROUND this
  // element's bounding box instead of running underneath it. `offset` is the
  // gap kept on every side, in logical px.
  wrap?: { mode: 'none' | 'square'; offset?: number }
}
export interface SlideTextElement extends SlideElementBase {
  type: 'text'
  paragraphs: SlideTextParagraph[]
  fontFamily?: string
  fill?: SlideFill
  border?: SlideBorder
  vAlign?: 'top' | 'middle' | 'bottom'
  // ── PlexiDesign threaded text ──────────────────────────────────────────────
  // When set, this frame is one link in a story chain: its visible text is not
  // its own `paragraphs` but a slice of the story, worked out by the flow engine
  // from the whole chain's geometry. The story's text lives once, in
  // DesignBody.stories[storyId].
  storyId?: string
  // The frame's position in its chain. Lower numbers are filled first.
  storyOrder?: number
  // The flow engine's output for this frame, in frame-local coordinates. This is
  // a CACHE the editor rewrites whenever the story, the chain geometry or the
  // wrap obstacles change — it exists so the exporter draws exactly the lines
  // the screen showed rather than re-deriving them with a different measurer.
  // Each line carries its own resolved type, because one story sets headings,
  // body, lists and quotes and every line may differ from its neighbour.
  flowLines?: FlowLine[]
  // True when the LAST frame of a chain still has text left over, so the editor
  // can show the classic red overset marker.
  overset?: boolean
  // Paragraph typography applied to a threaded frame (the whole story shares one
  // style; per-run styling stays on `paragraphs` for unthreaded frames).
  fontSize?: number
  lineHeight?: number
  align?: 'left' | 'center' | 'right' | 'justify'
  color?: string
  paragraphSpacing?: number
  firstLineIndent?: number
}
export interface SlideImageElement extends SlideElementBase {
  type: 'image'
  src: string // data: URI or file path
  // Alternative text for screen readers / accessibility checks. Absent = none.
  alt?: string
  fit?: 'contain' | 'cover' | 'fill'
  // Optional frame around the image (in addition to the shared cornerRadius +
  // shadow on the base).
  border?: SlideBorder
  // When true, dragging a resize handle preserves the frame's aspect ratio.
  lockAspect?: boolean
  // The image's natural width/height, captured on insert, so aspect-lock and
  // "fit to image" can use the true ratio rather than the current frame.
  naturalW?: number
  naturalH?: number
  // Crop as inset fractions (0..1) from each edge of the source image. The
  // remaining window fills the element frame. Absent = the whole image.
  crop?: { l: number; t: number; r: number; b: number }
}
export interface SlideShapeElement extends SlideElementBase {
  type: 'shape'
  shape: 'rect' | 'ellipse' | 'roundRect' | 'triangle'
  fill?: SlideFill
  border?: SlideBorder
}
export interface SlideLineElement extends SlideElementBase {
  type: 'line'
  // x/y is the start; x2/y2 the end. w/h are ignored.
  x2: number
  y2: number
  stroke: string
  strokeWidth: number
  arrowEnd?: boolean
}
// A live embed of a desk widget (by id). The element stores only the reference;
// the renderer resolves the widget's current content at view time, so the deck
// or design never carries a stale copy. Static exports (pptx/pdf/png) render a
// labelled placeholder frame rather than pretending to include live content.
export interface SlideWidgetElement extends SlideElementBase {
  type: 'widget'
  widgetId: string
}
// A chart on a slide, rendered through the shared chart core. It carries a data
// snapshot so the deck is self-contained (present/export never depend on a live
// fetch). When `source` is set, the editor can refresh the snapshot from that
// sheet document's range, so a slide chart can track live sheet data.
export interface SlideChartElement extends SlideElementBase {
  type: 'chart'
  chart: ChartCore
  source?: { sheetDocId: string; range: string; headerRow?: boolean; headerCol?: boolean }
}
// A native table: a grid of cell text. The first row is styled as a header when
// headerRow is set. Column widths are fractions of the element width (they sum to
// ~1); absent means equal columns.
export interface SlideTableElement extends SlideElementBase {
  type: 'table'
  cells: string[][]
  headerRow?: boolean
  fontSize?: number
  accent?: string // header fill / border tint
}
export type SlideElement =
  | SlideTextElement
  | SlideImageElement
  | SlideShapeElement
  | SlideLineElement
  | SlideWidgetElement
  | SlideChartElement
  | SlideTableElement

export interface DeckTheme {
  id: string
  name: string
  background: string
  fontHeading: string
  fontBody: string
  accent: string
  textColor: string
  titleStyle: { fontSize: number; bold?: boolean; color?: string }
  bodyStyle: { fontSize: number; color?: string }
}

// One slide. v1 fields (title/bullets/layout) are optional and retained for
// backward-compatible reads; v2 rendering uses `elements`.
export interface Slide {
  id: string
  notes: string
  title?: string
  bullets?: string[]
  layout?: SlideLayout
  elements?: SlideElement[]
  transition?: SlideTransition
  background?: SlideFill
  schemaVersion?: 2
}

export interface SlidesBody {
  slides: Slide[]
  theme?: DeckTheme | string
  schemaVersion?: 2
  size?: { w: number; h: number }
}

// A 'doc' body is a Tiptap document JSON (the same shape PageWidget stores);
// it is opaque to everything except the editor, so it is typed loosely here.
export type DocBody = { type: 'doc'; content?: unknown[] } | Record<string, unknown>

// ── PlexiMaps (the 'map' document type) ─────────────────────────────────────
// A node-and-edge diagram / workflow map (flowcharts, process maps, org charts,
// mind maps). The body is a clean, tool-agnostic graph: nodes carry their own
// position + shape + colour, edges carry an optional label and line style. The
// editor (MapEditor) renders this on React Flow; the shape stays independent of
// React Flow so it can sync to the cloud and later export cleanly.
export type MapShape =
  | 'process' // rectangle — a step / action
  | 'decision' // diamond — a branch / yes-no
  | 'terminator' // pill — start / end
  | 'data' // parallelogram — input / output
  | 'database' // cylinder — a store
  | 'circle' // connector / state
  | 'note' // free text label
  | 'hexagon' // preparation / predefined step
  | 'trapezoid' // manual operation
  | 'chevron' // process-flow arrow / stage
  | 'triangle' // basic triangle
  | 'pentagon' // basic pentagon
  | 'star' // highlight / callout marker
  | 'cross' // junction / plus
  | 'arrow' // right block arrow
  | 'callout' // speech / annotation bubble
  | 'lane' // swimlane / container band that groups shapes placed on top of it
  | 'widget' // live embed of a desk widget (widgetId on the node)

export interface MapNode {
  id: string
  x: number
  y: number
  label: string
  shape: MapShape
  color: string
  width?: number
  height?: number
  // Only meaningful when shape === 'widget': the desk widget this node embeds.
  // The renderer resolves the widget live; a dangling id renders a missing state.
  widgetId?: string
}

export interface MapEdge {
  id: string
  source: string
  target: string
  label?: string
  sourceHandle?: string | null
  targetHandle?: string | null
  style?: 'solid' | 'dashed'
  animated?: boolean
}

export interface MapBody {
  version: 1
  nodes: MapNode[]
  edges: MapEdge[]
  viewport?: { x: number; y: number; zoom: number }
}

// The full document, body included.
export interface FbDocument {
  id: string
  docType: DocType
  title: string
  body: DocBody | SheetBody | SlidesBody | MapBody | DesignBody | DrawBody
  archived: boolean
  createdAt: number
  updatedAt: number
  // Owning scope: 'personal' (or null, treated as personal) for a private doc, or
  // a real org id for an org-shared doc. Drives whether opening it routes into the
  // CRDT co-editing path (org-shared) instead of the last-write-wins editor.
  orgId: string | null
}

// List row — everything except the (potentially large) body.
export interface DocumentMeta {
  id: string
  docType: DocType
  title: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface DocumentDraft {
  // Optional client-provided id (WS01 sync substrate) for idempotent create.
  id?: string
  docType: DocType
  title: string
  body?: DocBody | SheetBody | SlidesBody | MapBody | DesignBody | DrawBody
}

export interface DocumentPatch {
  title?: string
  body?: DocBody | SheetBody | SlidesBody | MapBody | DesignBody | DrawBody
  archived?: boolean
}

// ── Focus Mode: split view + clusters (ported from Caleb's handoff) ──────────
// Session-local split geometry + persisted per-desk clusters. See splitGeometry.ts
// for the deterministic geometry and focusSplit/focusClusters stores for state.
export type PaneSource =
  | { kind: 'widget'; widgetId: string }
  | { kind: 'chrome'; tab: 'add' | 'chat' }
  | { kind: 'meet'; roomId: string } // reserved for PlexiMeet — placeholder render in v1

export type SplitShape = 'single' | 'halves' | 'left-2stack' | 'quad'
export type PaneCell = 'C0' | 'L' | 'R' | 'R1' | 'R2' | 'Q1' | 'Q2' | 'Q3' | 'Q4'

export interface Pane {
  id: string
  cell: PaneCell
  source: PaneSource
}

export interface SplitRatios {
  x?: number
  yRight?: number
  yQuad?: number
}

export interface SplitState {
  shape: SplitShape
  panes: Pane[]
  ratios: SplitRatios
  activePaneId: string
}

export interface FocusSavedView {
  id: string
  name: string
  deskId: string | null
  shape: SplitShape
  panes: Pane[]
  ratios: SplitRatios
  createdAt: number
  updatedAt: number
}

export interface FocusCluster {
  id: string
  taskId: string
  shape: SplitShape
  panes: Pane[]
  ratios: SplitRatios
  activePaneId: string
  createdAt: number
  updatedAt: number
}

export interface FocusClusterDraft {
  id?: string
  taskId: string
  shape: SplitShape
  panes: Pane[]
  ratios: SplitRatios
  activePaneId: string
}

// ── Persisted AI-chat history (local, free-standing conversations) ──────────
// Ported from Caleb's Focus-Mode branch. Backs the aiChat DB module + the
// Focus-Mode chat surface. ActionProposal / ChatRole already exist on this line.
// Where a conversation was started (Phase 4.5). Before unification the
// assistant re-threaded per screen, so "which screen" WAS the conversation;
// after it, a conversation remembers its origin and keeps it while you walk
// away (plan D4). Null on conversations written before unification — they
// genuinely do not know, and the UI says nothing rather than guessing.
export interface AiChatConversationContext {
  kind: string
  label: string
  title: string
  icon: string
}

// The retrieval trace as persisted. Deliberately NOT the live AssistantTrace:
// the renderer clock stamps that drive the progressive reveal describe one
// session's animation, not a durable fact. What survives is what the assistant
// actually did.
export interface StoredTrace {
  sources: ChatSource[]
  tools: ChatToolTrace[]
  mentions: ChatMentionResolved[]
  retrievalMs: number | null
  error: string | null
  // How the search matched (defect #15): false = keyword-only. Optional so
  // traces stored before this field simply read as unknown.
  semantic?: boolean | null
}

export interface AiChatConversationMeta {
  id: string
  taskId: string | null
  title: string
  createdAt: number
  updatedAt: number
  context?: AiChatConversationContext | null
  // Number of messages — for the history list preview. Populated by the list
  // query; not stored on the row.
  messageCount?: number
  // First user line, for the history list preview.
  preview?: string
  // Desks this conversation produced or adopted (Plexii P5), in link order —
  // element 0 is the PRIMARY: the pinned chip in the header and the default
  // push target. Grows as the chat creates desks; never limits how many.
  linkedDesks: string[]
  // How this conversation talks (Plexii P6). 'chat' is the normal assistant;
  // 'discovery' is the guided mode that drives with questions and blocks
  // toward a desk. Per-conversation and switchable at any time.
  mode: AiChatMode
  // The R21 globe: whether substantive turns in this conversation run the live
  // web search. Per-conversation and sticky, default on. Optional so rows read
  // by an older renderer and legacy fixtures stay valid; absent reads as on.
  webSearch?: boolean
}

// The conversation modes (Plexii P6). Persisted per conversation so reopening
// a discovery thread keeps discovering.
export type AiChatMode = 'chat' | 'discovery'
// A persisted message: the ChatMessage plus its proposals + applied-state, so an
// assistant turn restores with its green "done" cards intact.
export interface AiChatStoredMessage {
  id: string
  role: ChatRole
  content: string
  ts: number
  // Proposals attached to an assistant turn (empty for user/plain turns).
  proposals: ActionProposal[]
  // Approved-card state keyed by proposal id.
  applied: Record<string, AppliedProposal>
  // Phase 4.5 — what the panel always showed and persistence used to drop.
  // Citations this answer stands on.
  sources: ChatSource[]
  // The follow-up the model asked on this turn, if it asked one.
  question: ChatQuestion | null
  // What the assistant actually did to produce this turn.
  trace: StoredTrace | null
  // The references the USER's turn was sent with, so the transcript can redraw
  // its chips exactly where they were typed.
  mentions: ChatMentionRef[]
  // Interactive UI blocks this assistant turn carried (Plexii P4). Empty for
  // user turns and turns written before blocks existed.
  blocks: ChatUiBlock[]
}
export interface AiChatConversation {
  meta: AiChatConversationMeta
  messages: AiChatStoredMessage[]
}

// ── Applied action state (approved cards persist in the thread) ─────────────
// When the user approves an action card it does NOT vanish — it turns green
// (done) and stays as a durable record, optionally with a "Go to" that jumps to
// what it made. This is the applied-state we track per proposal id.
export interface GoToTarget {
  // What the approved action produced/affected, so "Go to" knows where to jump.
  kind: 'widget' | 'task' | 'document'
  id: string
  // A short label for the target (used in the "Go to" affordance tooltip).
  label?: string
}
export interface AppliedProposal {
  // The success message from the executor ("Created task …").
  message: string
  // Where "Go to" navigates, or null when the action has no navigable target
  // (e.g. a draft email, an arrange, a focus-session).
  target: GoToTarget | null
  // When it was applied (ms). For ordering / future persistence.
  appliedAt: number
}

// ── Workspace snapshot (Layer-1 structural index for the assistant) ─────────
// Ported from Caleb's Focus-Mode branch. A bounded ids+titles map of the whole
// workspace so the AI knows what exists and can reference/act on real items by
// id; heavy content is pulled on demand later, keyed on the ids surfaced here.
export interface WorkspaceDeskSummary {
  id: string
  title: string
  // Task ids belonging to this desk (top-level folder), for the tree shape.
  taskIds: string[]
}
export interface WorkspaceTaskSummary {
  id: string
  title: string
  status: TaskStatus
  deskId: string | null
  // Whether this is the task currently open on the desk.
  active: boolean
}
export interface WorkspaceWidgetSummary {
  id: string
  taskId: string
  kind: WidgetKind
  title: string
}
export interface WorkspaceDocumentSummary {
  id: string
  docType: DocType
  title: string
}
export interface WorkspaceSnapshot {
  // The task currently focused on the desk, for "this" references.
  activeTaskId: string | null
  desks: WorkspaceDeskSummary[]
  tasks: WorkspaceTaskSummary[]
  widgets: WorkspaceWidgetSummary[]
  documents: WorkspaceDocumentSummary[]
  // Bookkeeping so a bounded snapshot can honestly say when it was capped.
  truncated?: boolean
}

// ── Chat blocks (the typed-block thread) ────────────────────────────────────
// The agentic chat renders each assistant turn as an ordered list of typed
// blocks rather than one lump of markdown. Today two block kinds are populated
// from real data — 'text' (the reply markdown) and 'action' (one per
// ActionProposal, reusing the existing apply pipeline). The remaining kinds are
// declared now so the union + renderer registry are stable; they render only
// when a real data source populates them.
export type ChatBlock =
  | { kind: 'text'; markdown: string }
  | { kind: 'action'; proposal: ActionProposal }
  | {
      kind: 'record-table'
      title?: string
      columns: string[]
      rows: Array<{ id?: string; cells: string[] }>
    }
  | {
      kind: 'chart'
      title?: string
      chartType: 'bar' | 'line' | 'area' | 'pie' | 'kpi'
      tableId?: string
      series?: Array<{ label: string; value: number }>
    }
  | { kind: 'widget-card'; widgetId?: string; documentId?: string; title: string; widgetKind?: WidgetKind }
  | { kind: 'link'; href: string; label: string; external?: boolean }
  | { kind: 'connector-action'; connector: string; label: string; proposal: ActionProposal }
  // A turn's plain (non-connector) proposals as ONE group (A4, AI-09 — R3):
  // the shared card surface renders them together so Apply all and the
  // per-card checkboxes work over the whole build batch.
  | { kind: 'action-group'; proposals: ActionProposal[] }
  // What the answer was grounded on. Rendered as a row of numbered chips under
  // the reply, matching the [n] markers inside it.
  | { kind: 'mentions'; mentions: ChatMentionResolved[] }
  | { kind: 'sources'; sources: ChatSource[] }
  // A model-emitted interactive block (Plexii P4) riding the derived thread.
  | { kind: 'ui'; block: ChatUiBlock }

// ── Custom (AI-built) widget ────────────────────────────────────────────────
// The user describes what they want; the model writes a complete, self-contained
// HTML document. It runs in an iframe sandboxed WITHOUT allow-same-origin, which
// puts it on a unique opaque origin: it cannot read this app's storage, reach
// window.api / IPC, touch the filesystem, or navigate the top frame. Everything
// it needs from the host arrives over postMessage through the tiny bridge the
// host injects (state, title, height).
export interface CustomWidgetContent {
  // What the user asked for, verbatim. Kept so the widget can be refined later
  // and so retrieval can find it by intent rather than by generated markup.
  spec: string
  // The generated document. Self-contained: inline CSS and JS, no external
  // fetches unless the user has explicitly allowed network for this widget.
  code: string
  // The widget's own persisted data, written by the sandboxed code through
  // plexi.setState(). Opaque to the host — we only bound its size.
  state?: Record<string, unknown>
  // Network access for the generated code. Off by default: a widget that holds
  // what the user typed into it should not be able to post that anywhere
  // without the user turning it on deliberately.
  net?: boolean
  // Previous generations, newest first, so a refine that makes things worse is
  // always revertible. Capped — see CUSTOM_WIDGET_HISTORY_LIMIT.
  history?: Array<{ code: string; spec: string; at: number }>
  // Set when this instance came from the saved library, for provenance.
  savedId?: string
  // What the person answered in the build wizard, kept so EDITING the widget
  // reopens their choices instead of asking them to describe the whole thing
  // again from memory. Absent for widgets built from a free-text prompt.
  wizard?: import('./customWidgetWizard').WidgetWizardAnswers
}

// How many prior generations a custom widget keeps. Enough to undo a bad refine
// without turning widget.content into an archive that syncs on every keystroke.
export const CUSTOM_WIDGET_HISTORY_LIMIT = 5

// Hard ceiling on a generated document. Large enough for a genuinely rich
// mini-app, small enough that a runaway generation cannot bloat the row.
export const CUSTOM_WIDGET_MAX_CODE_BYTES = 200_000

// Hard ceiling on plexi.setState() payloads, enforced host-side.
export const CUSTOM_WIDGET_MAX_STATE_BYTES = 64_000

// A saved custom widget in the user's personal library, reusable on any desk.
export interface SavedCustomWidget {
  id: string
  name: string
  spec: string
  code: string
  icon: string
  net: boolean
  width: number
  height: number
  createdAt: number
  updatedAt: number
  useCount: number
}
