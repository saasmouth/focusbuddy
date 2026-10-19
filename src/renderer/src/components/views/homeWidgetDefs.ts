// The home widget registry — pure data, no JSX, no store imports. Lives apart
// from homeWidgets.tsx so grid geometry (homeGridLayout.ts) and unit tests can
// read the catalog without dragging component code in.

export type HomeWidgetId =
  | 'standup'
  | 'navigator'
  | 'continue'
  | 'agenda'
  | 'pulse'
  | 'quick'
  | 'activity'
  | 'pinned-desk'
  // A real, editable object lifted off a desk onto a dashboard, and a real
  // office document rendered in its own editor. Both are live: what you type
  // here is written to the same row the desk reads.
  | 'desk-widget'
  | 'office-document'
  // Dragged onto a dashboard from the side menu. 'work-widget' holds a widget
  // FILE (no desk; see docs/widget-files.md), 'connected-app' holds a live
  // app. Both are multi: a dashboard may hold as many as you drop.
  | 'work-widget'
  | 'connected-app'
  // The Plexii apps, each as its own card so the picker lists them by name
  // rather than offering one "app" entry that then asks which. Five render
  // the app's own view, which takes no props; the browser is a pinned page.
  | 'app-mail'
  | 'app-chat'
  | 'app-calendar'
  | 'app-files'
  | 'app-vault'
  | 'app-browser'
  // People's former home screen, kept whole as a widget so turning that page
  // into a personalisable grid loses none of what was on it.
  | 'people-home'
  | 'room-portal'
  | 'quick-links'
  | 'shortcuts'
  | 'app-launcher'
  | 'create'
  | 'overdue'
  | 'focus-timer'
  | 'one-thing'
  | 'where-was-i'
  | 'stalled'
  | 'new-meeting'
  | 'pinned-conversation'
  | 'transcribe'
  | 'new-desk'
  | 'discover'
  // The Attention widget family (S6/DEC-019c). 'attention' is the ONE offered
  // widget (section slider inside); the seven att-* ids are retired but keep
  // rendering for any layout that placed them.
  | 'attention'
  | 'att-tasks'
  | 'att-reviews'
  | 'att-calendar'
  | 'att-ack'
  | 'att-completed'
  | 'att-stale'
  | 'att-system'

// One tile in a Shortcuts box. Every kind carries an optional label snapshot
// taken when the target was added: live store titles win while the subject
// exists (renames stay fresh), the snapshot keeps a dead target legible
// ("Payroll desk" instead of an anonymous missing tile). `detail` is an
// optional where-it-lives snapshot (a document's Drive folder, for example)
// captured when the target is added, so tiles can say WHAT a thing is, not
// just its name.
interface ShortcutTargetBase {
  label?: string
  detail?: string
}
export type ShortcutTarget =
  | (ShortcutTargetBase & { kind: 'url'; url: string })
  | (ShortcutTargetBase & { kind: 'section'; id: string })
  | (ShortcutTargetBase & { kind: 'desk'; nodeId: string })
  | (ShortcutTargetBase & { kind: 'room'; roomId: string })
  | (ShortcutTargetBase & { kind: 'document'; documentId: string })
  | (ShortcutTargetBase & { kind: 'connected-app'; appId: string })
  // A tile that DOES something instead of going somewhere: starts a meeting
  // or a transcription right from the box.
  | (ShortcutTargetBase & { kind: 'action'; action: 'new-meeting' | 'transcribe' })
  // Message a person: opens their DM (starting it for real if none exists).
  | (ShortcutTargetBase & { kind: 'person'; accountId: string; handle?: string })
  // A specific widget on a desk: lands on the desk with the camera centred on
  // that widget (the desk alone if the widget has since been removed).
  | (ShortcutTargetBase & { kind: 'desk-widget'; nodeId: string; widgetId: string })

export interface HomeWidgetConfig {
  deskId?: string
  // desk-widget: the object lifted onto the dashboard, and the desk it lives on
  // (kept so the card can offer "open on its desk" and survive a store miss).
  widgetId?: string
  // office-document: the fb_documents row this card edits.
  documentId?: string
  documentTitle?: string
  roomId?: string
  routes?: string[]
  // work-widget: the widget FILE this card renders. Not {deskId,widgetId} —
  // the file has no desk, and the same file may also be placed on desks as
  // linked instances.
  widgetFileId?: string
  // connected-app: the app this card runs live.
  appId?: string
  // app-browser: the page it is pinned to. Kept on the CARD rather than in a
  // widgets row, because a dashboard browser has no desk row to write to.
  url?: string
  // Shortcuts: the box name and its tiles.
  title?: string
  targets?: ShortcutTarget[]
  // Pinned conversation: either a conversation, or a person (name and handle
  // snapshotted at pin time — presence only lists people currently online, so
  // the tile must stay legible when they are not).
  conversationId?: string
  personId?: string
  personHandle?: string
  personName?: string
}

export interface HomeWidgetInstance {
  key: string
  widget: HomeWidgetId
  config?: HomeWidgetConfig
}

// Apple-style widget sizes. The grid packs in half-cell subunits (see
// homeGridLayout.ts): icon is one subunit — a true app-icon square, four of
// them in a small widget's footprint, exactly Apple's ratio — then sm 1x1
// cell, md 2x1, lg 2x2, stack 1x2 tall. Every def declares only the sizes
// its content genuinely supports, plus the size it arrives at.
export type WidgetSize = 'icon' | 'sm' | 'md' | 'lg' | 'stack'

// Which dashboard a widget is offered on. Home, Office, People and Brain each
// render the same engine with their own saved layout, so the catalogue is
// scoped rather than duplicated. A def with no `surfaces` is offered everywhere.
export type DashboardSurface = 'home' | 'office' | 'people' | 'brain'
export const DASHBOARD_SURFACES: DashboardSurface[] = ['home', 'office', 'people', 'brain']

export interface HomeWidgetDef {
  id: HomeWidgetId
  name: string
  blurb: string
  icon: string
  tint: string
  category: 'Navigation' | 'Live' | 'Actions' | 'Smart' | 'Communication'
  // Multi-instance widgets (a pinned desk per desk, a portal per room). All
  // others are singletons: the gallery shows them as Added once placed.
  multi?: boolean
  // Which picker must run before this widget can be placed.
  config?: 'desk' | 'room' | 'conversation' | 'desk-widget' | 'document'
  // Dashboards this widget appears on. Absent = every dashboard.
  surfaces?: DashboardSurface[]
  // Retired widgets stay in the id union and this registry so stored layouts
  // keep loading (and migrating) sanely, but the gallery never offers them.
  retired?: boolean
  defaultCol: 'main' | 'rail'
  sizes: WidgetSize[]
  defaultSize: WidgetSize
}

export const HOME_WIDGET_DEFS: HomeWidgetDef[] = [
  // Live
  { id: 'standup', name: 'Standup', blurb: 'Your look-back and look-forward narrative for the day', icon: 'auto_awesome', tint: 'bg-accent/10 text-accent', category: 'Live', defaultCol: 'main', sizes: ['lg'], defaultSize: 'lg' },
  { id: 'agenda', name: "Today's agenda", blurb: 'The time blocks on your calendar today', icon: 'calendar_today', tint: 'bg-sky-500/10 text-sky-500', category: 'Live', defaultCol: 'rail', sizes: ['sm', 'md', 'stack'], defaultSize: 'sm' },
  { id: 'pulse', name: 'Pulse', blurb: 'Open, due, and overdue counts at a glance', icon: 'monitoring', tint: 'bg-violet-500/10 text-violet-500', category: 'Live', defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'continue', name: 'Continue', blurb: 'The documents you touched most recently', icon: 'history', tint: 'bg-accent/10 text-accent', category: 'Live', defaultCol: 'main', sizes: ['md', 'lg'], defaultSize: 'lg' },
  { id: 'activity', name: 'Recent activity', blurb: 'The workspace activity trail from the last week', icon: 'bolt', tint: 'bg-accent/10 text-accent', category: 'Live', defaultCol: 'rail', sizes: ['sm', 'md', 'stack'], defaultSize: 'sm' },
  { id: 'overdue', name: 'Overdue radar', blurb: 'Only the tasks past their due date. Empty is the goal', icon: 'priority_high', tint: 'bg-rose-500/10 text-rose-500', category: 'Live', defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  // Navigation
  { id: 'navigator', name: 'Rooms and desks', blurb: 'Browse rooms on the left, their desks open to the right', icon: 'meeting_room', tint: 'bg-sky-500/10 text-sky-500', category: 'Navigation', defaultCol: 'main', sizes: ['lg'], defaultSize: 'lg' },
  { id: 'pinned-desk', name: 'Pinned desk', blurb: 'One desk you care about, one click away', icon: 'push_pin', tint: 'bg-violet-500/10 text-violet-500', category: 'Navigation', multi: true, config: 'desk', defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'people-home', name: 'Team status', blurb: 'Who is around, standups and team activity', icon: 'groups', tint: 'bg-indigo-500/10 text-indigo-500', category: 'Live', surfaces: ['people'], defaultCol: 'main', sizes: ['lg'], defaultSize: 'lg' },
  { id: 'desk-widget', name: 'Desk object', blurb: 'One object from a desk, live and editable right here', icon: 'widgets', tint: 'bg-emerald-500/10 text-emerald-500', category: 'Navigation', multi: true, config: 'desk-widget', defaultCol: 'main', sizes: ['sm', 'md', 'lg'], defaultSize: 'md' },
  { id: 'office-document', name: 'Office document', blurb: 'A doc, sheet or deck in its own editor, live and editable', icon: 'description', tint: 'bg-sky-500/10 text-sky-500', category: 'Navigation', multi: true, config: 'document', defaultCol: 'main', sizes: ['md', 'lg'], defaultSize: 'lg' },
  { id: 'room-portal', name: 'Room portal', blurb: 'A single room and the desks inside it', icon: 'door_open', tint: 'bg-teal-500/10 text-teal-500', category: 'Navigation', multi: true, config: 'room', defaultCol: 'main', sizes: ['md', 'lg'], defaultSize: 'lg' },
  // Absorbed by Shortcuts (2026-08-21): stored quick-links instances migrate
  // to a Shortcuts box with section targets at load.
  { id: 'quick-links', name: 'Quick links', blurb: 'Your own row of shortcuts to the places you use most', icon: 'link', tint: 'bg-indigo-500/10 text-indigo-500', category: 'Navigation', retired: true, defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'shortcuts', name: 'Shortcuts', blurb: 'Your own tiles to anywhere: desks, documents, websites, apps', icon: 'link', tint: 'bg-indigo-500/10 text-indigo-500', category: 'Navigation', multi: true, defaultCol: 'rail', sizes: ['sm', 'md', 'lg', 'stack'], defaultSize: 'sm' },
  { id: 'work-widget', name: 'Work widget', blurb: 'A sticky, table, chart or any other work widget, live on this dashboard', icon: 'widgets', tint: 'bg-violet-500/10 text-violet-500', category: 'Live', defaultCol: 'main', multi: true, sizes: ['sm', 'md', 'lg', 'stack'], defaultSize: 'md' },
  { id: 'connected-app', name: 'Connected app', blurb: 'One of your connected apps, running here', icon: 'public', tint: 'bg-sky-500/10 text-sky-500', category: 'Live', defaultCol: 'main', multi: true, sizes: ['md', 'lg'], defaultSize: 'lg' },
  { id: 'app-mail', name: 'Mail', blurb: 'Your inbox, here', icon: 'mail', tint: 'bg-rose-500/10 text-rose-500', category: 'Communication', defaultCol: 'main', multi: false, sizes: ['md', 'lg'], defaultSize: 'lg' },
  { id: 'app-chat', name: 'Chat', blurb: 'Your conversations, here', icon: 'forum', tint: 'bg-sky-500/10 text-sky-500', category: 'Communication', defaultCol: 'main', multi: false, sizes: ['md', 'lg'], defaultSize: 'md' },
  { id: 'app-calendar', name: 'Calendar', blurb: 'Your calendar, here', icon: 'calendar_month', tint: 'bg-violet-500/10 text-violet-500', category: 'Live', defaultCol: 'main', multi: false, sizes: ['md', 'lg'], defaultSize: 'lg' },
  { id: 'app-files', name: 'Files', blurb: 'Your file library, here', icon: 'folder', tint: 'bg-sky-500/10 text-sky-500', category: 'Navigation', defaultCol: 'main', multi: false, sizes: ['md', 'lg'], defaultSize: 'lg' },
  { id: 'app-vault', name: 'Vault', blurb: 'Your vault, here', icon: 'plexii:vault', tint: 'bg-rose-500/10 text-rose-500', category: 'Navigation', defaultCol: 'main', multi: false, sizes: ['md', 'lg'], defaultSize: 'md' },
  { id: 'app-browser', name: 'Browser', blurb: 'A page you want in front of you', icon: 'public', tint: 'bg-indigo-500/10 text-indigo-500', category: 'Live', defaultCol: 'main', multi: true, sizes: ['md', 'lg'], defaultSize: 'lg' },
  { id: 'app-launcher', name: 'App launcher', blurb: 'Your favourite connected apps with their real logos', icon: 'apps', tint: 'bg-emerald-500/10 text-emerald-500', category: 'Navigation', defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  // Actions
  { id: 'quick', name: 'Quick actions', blurb: 'Create, plan, collaborate, automate', icon: 'bolt', tint: 'bg-emerald-500/10 text-emerald-500', category: 'Actions', defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'create', name: 'Create new', blurb: 'Start a document, spreadsheet, deck, or desk in one tap', icon: 'add_circle', tint: 'bg-accent/10 text-accent', category: 'Actions', defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'focus-timer', name: 'Focus timer', blurb: 'Start and stop the five minute promise from home', icon: 'timer', tint: 'bg-violet-500/10 text-violet-500', category: 'Actions', defaultCol: 'rail', sizes: ['icon', 'sm'], defaultSize: 'sm' },
  { id: 'new-desk', name: 'New desk', blurb: 'A fresh desk, one tap, straight in', icon: 'desk', tint: 'bg-teal-500/10 text-teal-500', category: 'Actions', defaultCol: 'rail', sizes: ['icon'], defaultSize: 'icon' },
  { id: 'discover', name: 'Discover', blurb: 'Start from any idea and let Plexii guide it into a desk', icon: 'plexii:discover', tint: 'bg-indigo-500/10 text-indigo-500', category: 'Actions', defaultCol: 'rail', sizes: ['icon'], defaultSize: 'icon' },
  // Communication
  { id: 'new-meeting', name: 'New meeting', blurb: 'Start or schedule a PlexiiMeet and invite anyone', icon: 'plexii:meet', tint: 'bg-rose-500/10 text-rose-500', category: 'Communication', defaultCol: 'rail', sizes: ['icon', 'md'], defaultSize: 'icon' },
  { id: 'pinned-conversation', name: 'Pinned conversation', blurb: 'One person or chat, unread count and one click away', icon: 'plexii:chat', tint: 'bg-sky-500/10 text-sky-500', category: 'Communication', multi: true, config: 'conversation', defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'transcribe', name: 'Transcribe', blurb: 'Record and transcribe, then keep it where it belongs', icon: 'plexii:mic', tint: 'bg-violet-500/10 text-violet-500', category: 'Communication', defaultCol: 'rail', sizes: ['icon', 'md'], defaultSize: 'icon' },
  // Smart
  { id: 'one-thing', name: 'One thing now', blurb: 'The single most pressing task. No list, just the one', icon: 'target', tint: 'bg-amber-500/10 text-amber-600', category: 'Smart', defaultCol: 'main', sizes: ['md', 'lg'], defaultSize: 'md' },
  { id: 'where-was-i', name: 'Where was I', blurb: 'Your last working context, with one button: Resume', icon: 'undo', tint: 'bg-sky-500/10 text-sky-500', category: 'Smart', defaultCol: 'main', sizes: ['md', 'lg'], defaultSize: 'md' },
  { id: 'stalled', name: 'Stalled desk', blurb: 'The in-progress desk that has waited longest for you', icon: 'hourglass_bottom', tint: 'bg-orange-500/10 text-orange-500', category: 'Smart', defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  // The ONE Attention widget (DEC-019c): every queue behind a section slider.
  { id: 'attention', name: 'Attention', blurb: 'Everything that needs you — tasks, reviews, dates, stale desks — one widget, sliding sections', icon: 'notifications', tint: 'bg-accent/10 text-accent', category: 'Smart', defaultCol: 'main', sizes: ['sm', 'md', 'lg'], defaultSize: 'md' },
  // Retired (DEC-019c): consolidated into 'attention'. Stored layouts keep
  // rendering; the gallery never offers these again.
  { id: 'att-tasks', name: 'Attention · Tasks', blurb: 'Your open to-dos, soonest due first', icon: 'check_circle', tint: 'bg-accent/10 text-accent', category: 'Smart', retired: true, defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'att-reviews', name: 'Attention · Reviews', blurb: 'Everything waiting on your judgment or sign-off', icon: 'rate_review', tint: 'bg-violet-500/10 text-violet-500', category: 'Smart', retired: true, defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'att-calendar', name: 'Attention · Coming up', blurb: 'Dated work and scheduling items, soonest first', icon: 'event', tint: 'bg-sky-500/10 text-sky-500', category: 'Smart', retired: true, defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'att-ack', name: 'Attention · Acknowledgments', blurb: 'Items needing only your receipt — one tap closes the loop', icon: 'mark_email_read', tint: 'bg-teal-500/10 text-teal-500', category: 'Smart', retired: true, defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'att-completed', name: 'Attention · Completed', blurb: 'Loops you closed this week', icon: 'task_alt', tint: 'bg-emerald-500/10 text-emerald-500', category: 'Smart', retired: true, defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'att-stale', name: 'Stale desks', blurb: 'Open desks gone quiet — object permanence, restored', icon: 'bedtime', tint: 'bg-orange-500/10 text-orange-500', category: 'Smart', retired: true, defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' },
  { id: 'att-system', name: 'Attention · System', blurb: 'Agent escalations and system signals, out of your headline count', icon: 'settings_suggest', tint: 'bg-slate-500/10 text-slate-500', category: 'Smart', retired: true, defaultCol: 'rail', sizes: ['sm', 'md'], defaultSize: 'sm' }
]

export function widgetDef(id: HomeWidgetId): HomeWidgetDef {
  return HOME_WIDGET_DEFS.find((d) => d.id === id) ?? HOME_WIDGET_DEFS[0]
}

// The route catalog Quick Links composes from. Each id is stable and stored in
// the widget's config; icons and tones mirror the sidebar so the shortcuts
// read as the same destinations.
export interface QuickLinkRoute {
  id: string
  label: string
  icon: string
  tone: string
}
export const QUICK_LINK_ROUTES: QuickLinkRoute[] = [
  { id: 'rooms', label: 'Rooms', icon: 'meeting_room', tone: 'text-sky-500' },
  { id: 'desks', label: 'Desks', icon: 'desk', tone: 'text-teal-500' },
  { id: 'shared', label: 'Shared', icon: 'folder_shared', tone: 'text-fuchsia-500' },
  { id: 'plans', label: 'Plans', icon: 'account_tree', tone: 'text-violet-500' },
  { id: 'tasks', label: 'Tasks', icon: 'checklist', tone: 'text-emerald-500' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar_month', tone: 'text-amber-500' },
  { id: 'documents', label: 'Documents', icon: 'description', tone: 'text-sky-500' },
  { id: 'files', label: 'Files', icon: 'folder', tone: 'text-orange-500' },
  { id: 'vault', label: 'Vault', icon: 'plexii:vault', tone: 'text-rose-500' }
]
