import type { WidgetKind } from '@shared/types'

export type WidgetCategory = 'Notes' | 'Web' | 'Files' | 'Tools' | 'Comms' | 'Layout'

export interface WidgetCatalogEntry {
  kind: WidgetKind
  category: WidgetCategory
  label: string
  icon: string // Material Symbols icon name
  hint: string
  defaultWidth: number
  defaultHeight: number
  defaultContent: string
  urlPlaceholder?: string
  isWebBased: boolean
  // When true, hidden from the picker but still routed correctly when an
  // existing widget of this kind is rendered. Used to fold redundant kinds
  // (image / video / pdf / gdoc / gsheet / gslide / email) into the
  // universal File widget, which now handles upload + URL paste + auto-
  // detection by MIME or hostname — without breaking existing canvases.
  hideFromPicker?: boolean
}

export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
  {
    // One number, its direction, and the readings behind it. The sparkline is
    // the point: an arrow without a line is an assertion nobody can check.
    kind: 'stat-card',
    category: 'Tools',
    label: 'Stat card',
    icon: 'monitoring',
    hint: 'A number worth watching, and how it got there',
    defaultWidth: 340,
    defaultHeight: 240,
    // Seeded with a readable example rather than an empty card: a stat card with
    // nothing in it cannot show what it is for, and this is the widget whose
    // point is hardest to guess from its name.
    defaultContent: JSON.stringify({
      title: 'Median price',
      series: [
        { label: 'Sales', caption: 'Median sale price · 12 months', display: '$5.2M',
          points: [4.6, 4.7, 4.65, 4.8, 4.9, 4.88, 5.0, 5.05, 5.1, 5.0, 5.15, 5.2] },
        { label: 'Rentals', caption: 'Median weekly rent · 12 months', display: '$1,240',
          points: [1080, 1100, 1120, 1115, 1160, 1180, 1175, 1200, 1210, 1225, 1230, 1240] }
      ],
      activeIndex: 0
    }),
    isWebBased: false
  },
  {
    // A set of pictures read as a set. One image widget per photo turns a desk
    // into a filing cabinet.
    kind: 'gallery',
    category: 'Files',
    label: 'Gallery',
    icon: 'photo_library',
    hint: 'A grid of pictures, kept in this workspace',
    defaultWidth: 460,
    defaultHeight: 340,
    defaultContent: JSON.stringify({ fileIds: [] }),
    isWebBased: false
  },
  {
    // DEC-045: the same command-center face the home screen has, placeable on
    // any desk. Defaults to THIS desk's items; one tap widens to all.
    kind: 'attention',
    category: 'Tools',
    label: 'Attention',
    icon: 'notifications',
    hint: 'This desk’s attention items — or all of them',
    defaultWidth: 380,
    defaultHeight: 340,
    defaultContent: '{"scope":"desk"}',
    isWebBased: false
  },
  {
    // Prompt-to-image on the desk. The generation already existed for the design
    // editor; this makes it a first-class canvas tool.
    kind: 'image-gen',
    category: 'Tools',
    label: 'Image',
    icon: 'auto_awesome',
    hint: 'Describe an image and generate it here',
    defaultWidth: 420,
    defaultHeight: 460,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'sticky',
    category: 'Notes',
    label: 'Sticky',
    icon: 'sticky_note_2',
    hint: 'Small colored note pinned to the desk',
    defaultWidth: 240,
    defaultHeight: 200,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'note',
    category: 'Notes',
    label: 'Note',
    icon: 'description',
    hint: 'Larger paper for longer writing',
    defaultWidth: 400,
    defaultHeight: 320,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'markdown',
    category: 'Notes',
    label: 'Markdown',
    icon: 'subject',
    hint: 'One portable note in markdown — slash menu, export, copy out. Use Page for rich multi-block docs.',
    defaultWidth: 460,
    defaultHeight: 360,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'local-app-launcher',
    category: 'Layout',
    label: 'App launcher',
    icon: 'desktop_mac',
    hint: 'One-click tile that launches a native Mac app — drag a Local app from the sidebar to create one',
    defaultWidth: 200,
    defaultHeight: 120,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'file',
    category: 'Files',
    label: 'File or link',
    icon: 'upload_file',
    hint: 'Upload any file (PDF, image, video, audio, doc) or paste a cloud link (Google Doc, Drive, Notion). Auto-detects type and renders the right preview.',
    defaultWidth: 320,
    defaultHeight: 240,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'drive',
    category: 'Files',
    label: 'Drive (folder)',
    icon: 'folder_open',
    hint: 'A folder from your Files, pinned to this desk. Lists its contents, opens it in Files, and any file you drop or add saves straight into that folder.',
    defaultWidth: 300,
    defaultHeight: 260,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'field',
    category: 'Tools',
    label: 'Field',
    icon: 'edit_note',
    hint: 'A single typed field — text, number, select, checkbox, attachment, button. Pick the type after creating.',
    defaultWidth: 240,
    defaultHeight: 100,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'page',
    category: 'Notes',
    label: 'Page',
    icon: 'description',
    hint: 'A rich multi-block document (headings, lists, todos, slash-command AI). Use Markdown for a single portable note.',
    defaultWidth: 480,
    defaultHeight: 400,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'table',
    category: 'Tools',
    label: 'Table',
    icon: 'table_chart',
    hint: 'Airtable-style database — rows + columns of typed fields',
    // Open wide enough that several typed columns + the add-row control are all
    // usable without a resize (N3: size scales with the real estate a kind needs).
    defaultWidth: 680,
    defaultHeight: 440,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'chart',
    category: 'Tools',
    label: 'Chart',
    icon: 'bar_chart',
    hint: 'PlexiDash — bar, line, area, pie or KPI charts from a table. Several on a desk make a dashboard.',
    defaultWidth: 520,
    defaultHeight: 380,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'doc',
    category: 'Files',
    label: 'Document',
    icon: 'article',
    hint: 'A Word-class document. Create new, open a .docx, or place an existing one.',
    // Word-class: needs the toolbar + a full page width (~816px page) usable on
    // open. Sized so the page and ribbon are readable without a resize.
    defaultWidth: 860,
    defaultHeight: 760,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'sheet',
    category: 'Files',
    label: 'Spreadsheet',
    icon: 'grid_on',
    hint: 'An Excel-class spreadsheet with formulas. Create new, import .xlsx/.csv, or place an existing one.',
    // Excel-class: formula bar + toolbar + enough columns/rows to be usable at a
    // glance without a resize.
    defaultWidth: 880,
    defaultHeight: 580,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'slides',
    category: 'Files',
    label: 'Slides',
    icon: 'slideshow',
    hint: 'A PowerPoint-class deck. Create new, import .pptx, or place an existing one.',
    // PowerPoint-class: a 16:9 slide + the thumbnail rail + toolbar all usable on
    // open.
    defaultWidth: 900,
    defaultHeight: 600,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'map',
    category: 'Files',
    // Labelled "Flowchart" rather than "Map": go-live persona testing found "Map"
    // reads as a location/road map, not a diagramming tool, so it wasted a core
    // slot on a confusing word. Same PlexiMaps editor underneath.
    label: 'Flowchart',
    icon: 'account_tree',
    hint: 'Flowcharts, process maps, org charts and mind maps (PlexiMaps) — diagram by hand or generate with AI.',
    defaultWidth: 720,
    defaultHeight: 520,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'design',
    category: 'Files',
    label: 'Design',
    icon: 'palette',
    hint: 'A PlexiDesign canvas — posters, social posts, one-pagers and more. Size presets, brand templates, AI copy and images.',
    defaultWidth: 720,
    defaultHeight: 540,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'streamdeck',
    category: 'Tools',
    label: 'SpeedDeck',
    icon: 'apps',
    hint: 'Elgato-style 10×3 macro pad — launch apps, run macros, control media, organise with folders. Toggle between this-task and Universal scopes.',
    defaultWidth: 760,
    defaultHeight: 260,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'task-link',
    category: 'Layout',
    label: 'Task link',
    icon: 'link',
    hint: 'Reference another task on this canvas — drag a task from the sidebar onto the canvas to create one',
    defaultWidth: 280,
    defaultHeight: 110,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'webview',
    category: 'Web',
    label: 'Browser',
    icon: 'public',
    hint: 'Any URL — a focused browser tab for this task',
    // Open at Desktop size (1920 × 1080) — a full 1080p viewport, and one of the
    // presets in the browser's own size menu. Sites lay out for this width, so
    // pages render the way they were designed rather than in a narrowed column;
    // the canvas zoom is what makes a widget this size comfortable to work at.
    defaultWidth: 1920,
    defaultHeight: 1080,
    defaultContent: '',
    urlPlaceholder: 'https://…',
    isWebBased: true
  },
  // ── Folded into File ───────────────────────────────────────────────────
  // pdf / gdoc / gsheet / gslide / email / image / video were separate
  // picker entries — each redundant with the File widget, which now
  // handles both upload (auto-detects PDF/image/video/audio by MIME) and
  // URL paste (auto-detects cloud docs by hostname). The kinds remain
  // valid so existing widgets keep rendering, but they're hidden from
  // the picker. Users wanting a "live Google Doc iframe" can still drop
  // a Browser widget and paste the URL.
  {
    kind: 'pdf',
    category: 'Files',
    label: 'PDF',
    icon: 'picture_as_pdf',
    hint: 'PDF document via URL',
    defaultWidth: 560,
    defaultHeight: 640,
    defaultContent: '',
    urlPlaceholder: 'https://…/file.pdf',
    isWebBased: true,
    hideFromPicker: true
  },
  {
    kind: 'gdoc',
    category: 'Files',
    label: 'Doc',
    icon: 'article',
    hint: 'Google Docs',
    defaultWidth: 600,
    defaultHeight: 500,
    defaultContent: '',
    urlPlaceholder: 'https://docs.google.com/document/…',
    isWebBased: true,
    hideFromPicker: true
  },
  {
    kind: 'gsheet',
    category: 'Files',
    label: 'Sheet',
    icon: 'table_chart',
    hint: 'Google Sheets',
    defaultWidth: 640,
    defaultHeight: 480,
    defaultContent: '',
    urlPlaceholder: 'https://docs.google.com/spreadsheets/…',
    isWebBased: true,
    hideFromPicker: true
  },
  {
    kind: 'gslide',
    category: 'Files',
    label: 'Slides',
    icon: 'slideshow',
    hint: 'Google Slides',
    defaultWidth: 640,
    defaultHeight: 420,
    defaultContent: '',
    urlPlaceholder: 'https://docs.google.com/presentation/…',
    isWebBased: true,
    hideFromPicker: true
  },
  {
    kind: 'chat-thread',
    category: 'Comms',
    label: 'Chat',
    icon: 'forum',
    hint: 'A live chat panel bound to a channel — read and reply without leaving the desk',
    defaultWidth: 340,
    defaultHeight: 460,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'email',
    category: 'Comms',
    label: 'Email',
    icon: 'mail',
    hint: 'Gmail / Outlook inbox view',
    defaultWidth: 600,
    defaultHeight: 500,
    defaultContent: 'https://mail.google.com/',
    urlPlaceholder: 'https://mail.google.com/ or any inbox URL',
    isWebBased: true,
    hideFromPicker: true
  },
  {
    kind: 'image',
    category: 'Files',
    label: 'Image',
    icon: 'image',
    hint: 'Image from URL',
    defaultWidth: 360,
    defaultHeight: 280,
    defaultContent: '',
    urlPlaceholder: 'https://…/image.png',
    isWebBased: false,
    hideFromPicker: true
  },
  {
    kind: 'video',
    category: 'Files',
    label: 'Video',
    icon: 'movie',
    hint: 'Video from URL (mp4 / webm)',
    defaultWidth: 480,
    defaultHeight: 320,
    defaultContent: '',
    urlPlaceholder: 'https://…/video.mp4',
    isWebBased: false,
    hideFromPicker: true
  },
  {
    kind: 'calculator',
    category: 'Tools',
    label: 'Calc',
    icon: 'calculate',
    hint: 'Small inline calculator',
    defaultWidth: 208,
    defaultHeight: 300,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'color',
    category: 'Tools',
    label: 'Color',
    icon: 'palette',
    hint: 'Color picker + screen eyedropper',
    defaultWidth: 220,
    defaultHeight: 200,
    defaultContent: '#fbbf24',
    isWebBased: false
  },
  {
    kind: 'timer',
    category: 'Tools',
    label: 'Timer',
    icon: 'timer',
    hint: 'Countdown timer with audio cues — beeps as time runs out',
    defaultWidth: 224,
    defaultHeight: 224,
    defaultContent: JSON.stringify({ targetSec: 600, elapsedSec: 0, state: 'idle', startedAt: null }),
    isWebBased: false
  },
  {
    kind: 'section',
    category: 'Layout',
    label: 'Section',
    icon: 'crop_free',
    hint: 'A labeled frame to group widgets visually — renders behind everything',
    defaultWidth: 480,
    defaultHeight: 360,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'minimap',
    category: 'Layout',
    label: 'Minimap',
    icon: 'map',
    hint: 'Bird\'s-eye view of the canvas — drag the viewport rect to pan, click anywhere to jump there',
    defaultWidth: 220,
    defaultHeight: 160,
    defaultContent: '',
    isWebBased: false,
    hideFromPicker: true
  },
  {
    kind: 'voice-recorder',
    category: 'Tools',
    label: 'Voice note',
    icon: 'mic',
    hint: 'Record a voice note — AI transcribes (full / cleaned / summary), suggests tasks and widgets, then sends results anywhere on the canvas',
    defaultWidth: 320,
    defaultHeight: 240,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'mindmap',
    category: 'Tools',
    label: 'Mind map',
    icon: 'account_tree',
    hint: 'Explore an idea — AI suggests branches, tasks, and the Agent OS agents that can execute on each node',
    defaultWidth: 720,
    defaultHeight: 480,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'diagram',
    category: 'Tools',
    label: 'Diagram',
    icon: 'schema',
    hint: 'Flowcharts, hierarchies, server/software design, Venn — boxes, circles, text & image nodes joined with connectors',
    defaultWidth: 760,
    defaultHeight: 520,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'scratchpad',
    category: 'Tools',
    label: 'Scratchpad',
    icon: 'draw',
    hint: 'Freeform sketch surface — draw, annotate and think visually with pressure-sensitive ink',
    defaultWidth: 560,
    defaultHeight: 420,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'shape',
    category: 'Layout',
    label: 'Shape',
    icon: 'category',
    hint: 'A vector shape — rectangle, ellipse, diamond, triangle, hexagon, star, line or arrow — with fill, stroke and an optional label',
    defaultWidth: 200,
    defaultHeight: 160,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'card',
    category: 'Notes',
    label: 'Card',
    icon: 'view_agenda',
    hint: 'A titled callout card with an accent bar, bold title and body',
    defaultWidth: 280,
    defaultHeight: 200,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'custom-block',
    category: 'Tools',
    label: 'Custom block',
    icon: 'dashboard_customize',
    hint: 'Design your own form/record — drop typed fields and place them where you want; save as a reusable template',
    defaultWidth: 440,
    defaultHeight: 380,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'agent',
    category: 'Tools',
    label: 'Desk agent',
    icon: 'smart_toy',
    hint: 'A standing AI agent. Wire widgets INTO it as inputs, give it an instruction and a trigger, and it works on its own',
    defaultWidth: 320,
    defaultHeight: 300,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'webhook',
    category: 'Tools',
    label: 'Send to a URL',
    icon: 'webhook',
    hint: 'An outbound webhook. Wire a tool into it and its content is POSTed to your URL whenever it changes — send desk data out to Slack, Zapier or any HTTP endpoint',
    defaultWidth: 320,
    defaultHeight: 180,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'inbound-hook',
    category: 'Tools',
    label: 'Receive from a URL',
    icon: 'call_received',
    hint: 'An inbound webhook. Gives you a unique URL — when an external system (Stripe, a form, curl) POSTs to it, the payload lands here and fires any wire drawn OUT of this tool',
    defaultWidth: 340,
    defaultHeight: 200,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'portal',
    category: 'Layout',
    label: 'Portal',
    icon: 'picture_in_picture',
    hint: 'A live window into another task’s desk — watch it at a glance and click to dive in',
    defaultWidth: 300,
    defaultHeight: 240,
    defaultContent: '',
    isWebBased: false
  },
  {
    kind: 'living-doc',
    category: 'Notes',
    label: 'Living Doc',
    icon: 'auto_awesome',
    hint: 'A doc that writes itself — give it a brief and it keeps a living summary of this desk',
    defaultWidth: 500,
    defaultHeight: 400,
    defaultContent: '',
    isWebBased: false
  }
]

export function catalogFor(kind: WidgetKind): WidgetCatalogEntry | null {
  return WIDGET_CATALOG.find((e) => e.kind === kind) ?? null
}

// Go-live simplification: a brand-new user should meet a small, obvious CORE set,
// not the full catalog. Everything below is still fully creatable — it just lives
// under the picker's "Advanced" expander (one tap away) instead of the first-run
// grid. This is a demotion, NOT a removal: no functionality is lost, and the
// command palette still lists every kind. (Truly duplicate kinds — pdf/gdoc/etc,
// and diagram/mindmap once Map covers them — use hideFromPicker instead.)
export const ADVANCED_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  // Notes — Sticky + Page are the core two; these are variants/styles or AI docs.
  'note',
  'markdown',
  'card',
  'living-doc',
  // Files — Document/Spreadsheet/Slides/File/Map/Drive/Design are core. Drive (a
  // shared folder pinned to the desk) and Design (a PlexiDesign canvas) are core
  // per the product spec §2.4 core-14 set; both are ungated at the spawn layer.
  // Tools/data — Table + Chart + Field are core; Field is the spec's configurable
  // utility slot (one typed value, type chosen after drop). custom-block below is a
  // heavier design-your-own authoring flow and stays advanced.
  'custom-block',
  'calculator',
  'color',
  'scratchpad',
  'streamdeck',
  // Automation — powerful but intimidating first-run.
  'agent',
  'webhook',
  'inbound-hook',
  // Layout/canvas depth — Section is core; these are advanced placements.
  'shape',
  'task-link',
  'portal',
  'local-app-launcher',
  // Diagramming — Map is the one CORE diagram tool. Diagram + Mind map are demoted
  // here rather than folded away: the Map owner confirmed Map does NOT cover two of
  // their capabilities (Diagram's image/icon-upload node type; Mind map's per-node
  // Agent-OS agents with proposal apply/undo), so hiding them would lose real
  // functionality. Kept fully creatable under Advanced; existing ones render as
  // normal (rendering is keyed on widget.kind, independent of this list).
  'diagram',
  'mindmap'
])

export function isAdvancedKind(kind: WidgetKind): boolean {
  return ADVANCED_KINDS.has(kind)
}

// Single-key quick-add shortcuts (no modifier) for the most common widgets,
// fired on the canvas when a desk is active and the user is not typing. The
// command palette shows these next to each "Add" command. Kept to memorable,
// non-conflicting letters that avoid the canvas's existing keys ([ ] 0 H A);
// widgets that need a dialog or a drag flow (office docs, file upload,
// task-link, app launcher, minimap) intentionally have no quick-add key.
export const WIDGET_SHORTCUTS: Partial<Record<WidgetKind, string>> = {
  sticky: 'S',
  note: 'N',
  page: 'P',
  markdown: 'M',
  table: 'T',
  webview: 'B',
  calculator: 'C',
  timer: 'I',
  color: 'O',
  section: 'R',
  shape: 'G',
  card: 'D',
  field: 'F'
}

// Reverse map: pressed key (uppercased) -> the widget kind to spawn. Built from
// WIDGET_SHORTCUTS so the two never drift.
export const SHORTCUT_TO_KIND: Record<string, WidgetKind> = Object.fromEntries(
  Object.entries(WIDGET_SHORTCUTS).map(([kind, key]) => [key, kind as WidgetKind])
) as Record<string, WidgetKind>

export const CATEGORIES: WidgetCategory[] = ['Notes', 'Web', 'Files', 'Tools', 'Comms', 'Layout']

/**
 * Entries grouped for the picker — excludes anything marked
 * `hideFromPicker`. Use `WIDGET_CATALOG` directly for the full list
 * (e.g. when looking up an existing widget's metadata).
 */
export function entriesByCategory(): Record<WidgetCategory, WidgetCatalogEntry[]> {
  const out: Record<WidgetCategory, WidgetCatalogEntry[]> = {
    Notes: [],
    Web: [],
    Files: [],
    Tools: [],
    Comms: [],
    Layout: []
  }
  for (const entry of WIDGET_CATALOG) {
    if (entry.hideFromPicker) continue
    out[entry.category].push(entry)
  }
  return out
}

export const DRAG_MIME = 'application/x-fb-widget-kind'

// How a widget sits inside a split-view pane (ported from Caleb's Focus Mode).
// Short/atmospheric widgets are framed as a contained card ('center'); anything
// with its own scroll/fill surface fills the pane ('fill').
const CENTER_IN_PANE: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  'sticky',
  'note',
  'field',
  'timer',
  'color',
  'calculator',
  'task-link'
])

export function fitsPaneFor(kind: WidgetKind): 'center' | 'fill' {
  return CENTER_IN_PANE.has(kind) ? 'center' : 'fill'
}
