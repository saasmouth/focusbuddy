// The PlexiSuite catalog: the single source of truth for every product in the
// suite, what group it belongs to, whether it is live yet, and the copy that
// makes the case for it against Microsoft 365 and Google Workspace. The home
// launcher, the per-product home pages, and the coming-soon upvote system all
// read from this one list, so the roadmap stays honest and consistent in one
// place.
//
// status is deliberate and honest. 'ready' means you can use it today. 'soon'
// means the foundation exists and it is actively being finished. 'planned' means
// it is on the roadmap but not started. Coming-soon and planned products render
// in lighter grey with a badge and can be upvoted to move them up the queue.

export type PlexiStatus = 'ready' | 'soon' | 'planned'

export interface PlexiGroup {
  key: string
  name: string
  tagline: string
  // Tailwind-friendly accent (hex) used for the group's header + card glow.
  accent: string
}

export interface PlexiProduct {
  key: string // stable id, also the upvote feature key
  name: string
  group: string // PlexiGroup.key
  tagline: string
  status: PlexiStatus
  icon: string // Material Symbols name
  accent: string // hex
  // What it is, in a sentence or two, for the product home page.
  about: string
  // Why it beats the incumbents. Each item is one concrete advantage.
  edges: string[]
  // The incumbent feature it replaces, for the "instead of" line.
  insteadOf?: string
  // For coming-soon/planned: the headline capabilities being built.
  planned?: string[]
  // Optional in-app destination for ready products. The home interprets a small
  // set of known keys; anything else just opens the product page.
  launch?: string
}

export const PLEXI_GROUPS: PlexiGroup[] = [
  { key: 'office', name: 'PlexiOffice', tagline: 'Create anything.', accent: '#f59e0b' },
  { key: 'work', name: 'PlexiWork', tagline: 'Run the work.', accent: '#ef4444' },
  { key: 'ai', name: 'PlexiAI', tagline: 'Add intelligence.', accent: '#8b5cf6' },
  { key: 'data', name: 'PlexiData', tagline: 'See it. Understand it. Act on it.', accent: '#0ea5e9' },
  { key: 'build', name: 'PlexiBuild', tagline: 'Build your own tools.', accent: '#10b981' },
  { key: 'connect', name: 'PlexiConnect', tagline: 'Connect everything.', accent: '#6366f1' },
  { key: 'ops', name: 'PlexiOps', tagline: 'Run the whole business.', accent: '#14b8a6' }
]

// The flagship surface, shown as the hero rather than a card.
export const PLEXI_DESK: PlexiProduct = {
  key: 'plexidesk',
  name: 'PlexiDesk',
  group: 'office',
  tagline: 'Your visual workspace.',
  status: 'ready',
  icon: 'space_dashboard',
  accent: '#6366f1',
  about:
    'A spatial desktop where every document, table, chart, file and tool lives together on one infinite canvas, wired up the way you actually think, instead of buried in folders and tabs.',
  edges: [
    'Your whole work surface at once, not one file in one window. Neither Office nor Workspace has a canvas.',
    'Live wires connect tools so a change in one updates the next, like a spreadsheet for your entire workspace.',
    'AI agents stand right on the desk beside the work they act on.'
  ],
  insteadOf: 'a folder of disconnected files',
  launch: 'canvas'
}

export const PLEXI_PRODUCTS: PlexiProduct[] = [
  // ── PlexiOffice ──────────────────────────────────────────────────────────
  {
    key: 'plexidocs',
    name: 'PlexiDocs',
    group: 'office',
    tagline: 'AI-native documents.',
    status: 'ready',
    icon: 'article',
    accent: '#3b82f6',
    about: 'A Word-class editor where the AI is part of the page, not a bolted-on sidebar, and the document lives in the same workspace as your data.',
    edges: [
      'Ask the AI to write, restructure or summarise inline, grounded in your own documents.',
      'Opens and saves real .docx, so nobody is locked out.',
      'Lives on the canvas next to the work it describes.'
    ],
    insteadOf: 'Microsoft Word / Google Docs',
    launch: 'documents'
  },
  {
    key: 'plexisheets',
    name: 'PlexiSheets',
    group: 'office',
    tagline: 'Smarter spreadsheets with live data and AI.',
    status: 'ready',
    icon: 'table_chart',
    accent: '#22c55e',
    about: 'A spreadsheet that understands its own columns, pulls in live data, and lets you ask the AI to build and explain formulas.',
    edges: [
      'Typed columns and real data types, not just a grid of strings.',
      'Native .xlsx in and out.',
      'Charts and dashboards one click away via PlexiDash.'
    ],
    insteadOf: 'Microsoft Excel / Google Sheets',
    launch: 'documents'
  },
  {
    key: 'plexislides',
    name: 'PlexiSlides',
    group: 'office',
    tagline: 'AI-assisted decks and sales materials.',
    status: 'ready',
    icon: 'slideshow',
    accent: '#f97316',
    about: 'Build a deck by describing it. The AI drafts slides, applies a coherent theme, and keeps everything editable.',
    edges: [
      'Generate a full deck from a prompt, then refine slide by slide.',
      'Exports to .pptx and PDF.',
      'Co-edit live with cursors and comments.'
    ],
    insteadOf: 'Microsoft PowerPoint / Google Slides',
    launch: 'documents'
  },
  {
    key: 'plexidiagrams',
    name: 'PlexiDiagrams',
    group: 'office',
    tagline: 'Flowcharts, org charts, processes and systems.',
    status: 'ready',
    icon: 'account_tree',
    accent: '#8b5cf6',
    about:
      'Structured diagramming: flowcharts, process maps, org charts, swimlanes and system diagrams, built from a real stencil library and joined with connectors that stay attached when you move things.',
    edges: [
      'A proper stencil set with connectors that route and re-route themselves.',
      'Diagrams connect to live data and tools, not just static boxes.',
      'Opens and saves Visio .vsdx, so nobody is locked out.'
    ],
    insteadOf: 'Visio / Lucidchart',
    launch: 'documents'
  },
  {
    key: 'plexidesign',
    name: 'PlexiDesign',
    group: 'office',
    tagline: 'Page layout, from a flyer to a forty-page brochure.',
    status: 'ready',
    icon: 'article_shortcut',
    accent: '#d946ef',
    about:
      'A free-form page designer: place anything anywhere, thread a story through linked text frames, lay pages out on master pages with real margins, columns and guides, and send the result to print with bleed and crop marks.',
    edges: [
      'Master pages, threaded text frames and automatic page numbers — the layout tools a word processor has never had.',
      'Text wraps around objects, and rulers, guides and column grids keep a multi-page document consistent.',
      'Print-ready PDF with bleed and crop marks, not just "save as PDF".'
    ],
    insteadOf: 'Microsoft Publisher / Adobe InDesign',
    launch: 'design'
  },
  {
    key: 'plexidraw',
    name: 'PlexiDraw',
    group: 'office',
    tagline: 'Vector and painting in one studio.',
    status: 'ready',
    icon: 'brush',
    accent: '#ec4899',
    about:
      'Draw bezier paths with a real pen tool, combine them with pathfinder booleans, and paint on pixel layers with brushes, blend modes and a paint bucket — vector and raster in one document, one layer stack, one export.',
    edges: [
      'Pen tool, editable anchors and Unite/Minus/Intersect/Exclude, like a proper vector editor.',
      'Painted layers sit in the same stack as vector layers, with blend modes and per-layer opacity on both.',
      'Exports true SVG as well as PNG and PDF — no two subscriptions to do one job.'
    ],
    insteadOf: 'Adobe Illustrator / Photoshop',
    launch: 'draw'
  },
  {
    key: 'plexiforms',
    name: 'PlexiForms',
    group: 'office',
    tagline: 'Capture requests, leads, briefs and data.',
    status: 'ready',
    icon: 'dynamic_form',
    accent: '#a855f7',
    about: 'Design a form from typed fields, fill it, and every response lands as a row in a real table you can chart in PlexiDash, filter and automate. (Shareable public links are on the way.)',
    edges: [
      'Submissions flow straight into your tables and dashboards.',
      'Built on the same field types as the rest of the suite.',
      'No export-import dance between a forms tool and your data.'
    ],
    insteadOf: 'Google Forms / Microsoft Forms',
    launch: 'forms'
  },
  {
    key: 'plexisign',
    name: 'PlexiSign',
    group: 'office',
    tagline: 'Sign, approve and track documents.',
    status: 'ready',
    icon: 'draw_abstract',
    accent: '#14b8a6',
    about: 'Create an agreement, collect typed or drawn signatures from an ordered set of signers, and keep an append-only audit trail with a tamper-evident completion certificate, without leaving your workspace. (Outside-party signing links are on the way.)',
    edges: [
      'Signatures backed by the same identity and audit layer as everything else.',
      'An append-only trail and a sha256 completion certificate.',
      'No per-envelope DocuSign bill.'
    ],
    insteadOf: 'DocuSign / Adobe Sign',
    launch: 'sign'
  },

  // ── PlexiWork ────────────────────────────────────────────────────────────
  {
    key: 'plexitasks',
    name: 'PlexiTasks',
    group: 'work',
    tagline: 'Tasks that live beside the work.',
    status: 'ready',
    icon: 'checklist',
    accent: '#ef4444',
    about: 'Tasks are first-class here. Each one carries its own desk of documents, tools and context, so opening a task opens the work.',
    edges: [
      'Every task has a workspace, not just a due date.',
      'Tasks connect to the documents and tools that complete them.',
      'No separate project tool to keep in sync.'
    ],
    insteadOf: 'Microsoft Planner / Google Tasks',
    launch: 'tasks'
  },
  {
    key: 'plexiprojects',
    name: 'Plans',
    group: 'work',
    tagline: 'Plans, milestones and Gantt.',
    status: 'ready',
    icon: 'account_tree',
    accent: '#f43f5e',
    about: 'Roll tasks up into plans with dependencies, milestones and a Gantt timeline. A critical-path engine finds the chain that drives the finish date, flags tasks that have slipped, and reschedules the plan from what actually happened.',
    edges: [
      'Plans built from the same tasks you already work in.',
      'Critical-path and drift detection, not a static chart.',
      'Reschedule the whole plan from real progress in one click.'
    ],
    insteadOf: 'Microsoft Project / Asana',
    launch: 'projects'
  },
  {
    key: 'plexicalendar',
    name: 'PlexiCalendar',
    group: 'work',
    tagline: 'Time, meetings, tasks and work in one place.',
    status: 'ready',
    icon: 'calendar_month',
    accent: '#f59e0b',
    about: 'A calendar that blocks time for real work, not just meetings, and sits beside the tasks and documents it schedules.',
    edges: [
      'Time-block tasks directly from your task list.',
      'Work and meetings share one timeline.',
      'Google Calendar sync on the way.'
    ],
    insteadOf: 'Outlook Calendar / Google Calendar',
    launch: 'calendar'
  },
  {
    key: 'pleximeet',
    name: 'PlexiMeet',
    group: 'work',
    tagline: 'Meetings that turn into actions.',
    status: 'ready',
    icon: 'groups',
    accent: '#fb7185',
    about: 'Record a meeting and walk away with a clean transcript, an AI summary, and action items you turn into real tasks with one click. Or capture notes by hand. Live transcription uses your configured key.',
    edges: [
      'Transcription and summary built in.',
      'Action items become real tasks, not notes you retype.',
      'Searchable meeting history beside the work.'
    ],
    insteadOf: 'Teams / Google Meet + a notetaker',
    launch: 'meetings'
  },
  {
    key: 'plexichat',
    name: 'PlexiChat',
    group: 'work',
    tagline: 'Conversations tied to the actual work.',
    status: 'ready',
    icon: 'forum',
    accent: '#e11d48',
    about: 'Messages and comments that attach to the document, task or desk they are about, so conversation never drifts away from the work.',
    edges: [
      'Comment threads live on the document, not in a separate channel.',
      'Share a folder, task or desk straight into a conversation.',
      'One identity across chat, docs and the workspace.'
    ],
    insteadOf: 'Slack / Microsoft Teams chat',
    launch: 'messages'
  },
  {
    key: 'plexifiles',
    name: 'PlexiFiles',
    group: 'work',
    tagline: 'Find every file, note, doc and asset fast.',
    status: 'ready',
    icon: 'folder_open',
    accent: '#f97316',
    about: 'One finder for everything: imported files, internal documents, and the assets on your desks, with live folders you can share.',
    edges: [
      'Internal docs and external files in one place.',
      'Live, shareable folders with real-time sync.',
      'No guessing whether it is in Drive, SharePoint or someone’s laptop.'
    ],
    insteadOf: 'OneDrive / Google Drive',
    launch: 'files'
  },

  // ── PlexiAI ──────────────────────────────────────────────────────────────
  {
    key: 'plexibrain',
    name: 'PlexiBrain',
    group: 'ai',
    tagline: 'The shared memory for people and agents.',
    status: 'ready',
    icon: 'neurology',
    accent: '#8b5cf6',
    about: 'A company knowledge base that both people and the AI read from, so answers come grounded in your own documented truth, not a generic guess.',
    edges: [
      'One memory shared by your team and your AI.',
      'Grounds the assistant in your real knowledge, alongside your documents.',
      'Curate entries with tags and pin what matters most.'
    ],
    insteadOf: 'a wiki nobody updates',
    launch: 'knowledge'
  },
  {
    key: 'plexiagents',
    name: 'PlexiAgents',
    group: 'ai',
    tagline: 'Assign work to AI teammates.',
    status: 'ready',
    icon: 'smart_toy',
    accent: '#a78bfa',
    about: 'Standing AI agents you place on a desk, wire to inputs, give an instruction, and let run, with a visible kill switch and a run log.',
    edges: [
      'Agents live on the canvas beside the work they do.',
      'Their senses are the live wires you draw into them.',
      'You see every run and can stop it instantly.'
    ],
    insteadOf: 'Copilot you cannot direct',
    launch: 'canvas'
  },
  {
    key: 'plexiflow',
    name: 'PlexiFlow',
    group: 'ai',
    tagline: 'Connect tools and trigger work.',
    status: 'ready',
    icon: 'account_tree',
    accent: '#7c3aed',
    about: 'An automation builder: when you run it or on a schedule, do a sequence of actions across your workspace. Create a task, add a table row, send an email, write a knowledge entry, or run an AI step whose output later steps reuse.',
    edges: [
      'Actions that reach into your real workspace objects.',
      'AI steps as first-class actions, not an afterthought.',
      'No separate Zapier subscription.'
    ],
    insteadOf: 'Zapier / Power Automate',
    launch: 'flows'
  },
  {
    key: 'plexisearch',
    name: 'PlexiSearch',
    group: 'ai',
    tagline: 'Find anything across everything.',
    status: 'ready',
    icon: 'search',
    accent: '#9333ea',
    about: 'One search across your tasks, documents, tables, files and knowledge, ranked by meaning, with a plain-language answer drawn from the same sources sitting above the links.',
    edges: ['One box for the whole workspace.', 'Answers, not just a list of links.', 'Ranks by meaning, not just exact words.'],
    insteadOf: 'searching each app one by one',
    launch: 'search'
  },

  // ── PlexiData ────────────────────────────────────────────────────────────
  {
    key: 'plexidash',
    name: 'PlexiDash',
    group: 'data',
    tagline: 'Live business views from your data.',
    status: 'ready',
    icon: 'monitoring',
    accent: '#0ea5e9',
    about: 'Charts and dashboards built straight on your tables. Bar, line, area, pie and KPI views that update as the data does, no exports.',
    edges: [
      'Every chart reads a real table, so it is never stale.',
      'A dashboard is just charts on a desk, arranged how you like.',
      'No BI tool to license or model data into.'
    ],
    insteadOf: 'Power BI / Looker Studio',
    launch: 'canvas'
  },
  {
    key: 'plexitables',
    name: 'PlexiTables',
    group: 'data',
    tagline: 'Typed tables with views and filters.',
    status: 'ready',
    icon: 'grid_on',
    accent: '#0284c7',
    about: 'Airtable-style databases with typed columns, multiple views, filters, grouping, drag-reorder and keyboard navigation.',
    edges: [
      'Real field types, relations and select options.',
      'Table, kanban, calendar and gallery views of one dataset.',
      'Feeds charts, forms and automations directly.'
    ],
    insteadOf: 'Airtable / Excel-as-a-database',
    launch: 'canvas'
  },
  {
    key: 'plexireports',
    name: 'PlexiReports',
    group: 'data',
    tagline: 'Scheduled, shareable reports.',
    status: 'ready',
    icon: 'summarize',
    accent: '#0369a1',
    about: 'Turn your tables into a report that is generated on a schedule, narrated by AI, and emailed to the people who need it. With no AI key it falls back to an honest data summary rather than a fabricated narrative.',
    edges: ['Reports built from your real table data.', 'AI writes the narrative around the numbers, never invents them.', 'Generated and emailed on a schedule.'],
    insteadOf: 'hand-built monthly slide decks',
    launch: 'reports'
  },

  // ── PlexiBuild ───────────────────────────────────────────────────────────
  {
    key: 'plexibuild',
    name: 'PlexiBuild',
    group: 'build',
    tagline: 'Build internal tools without code.',
    status: 'ready',
    icon: 'construction',
    accent: '#10b981',
    about: 'Compose your own apps from typed components, headings, text, input fields, buttons, more, in a Build mode, then run them in Preview. No code. (Phase 1; multi-screen navigation, table data binding and logic are on the way.)',
    edges: [
      'Build on the same primitives the suite is made of.',
      'Design in Build mode, run instantly in Preview.',
      'No separate low-code platform to learn.'
    ],
    insteadOf: 'Power Apps / Retool',
    launch: 'apps'
  },
  {
    key: 'plexiwidgets',
    name: 'PlexiWidgets',
    group: 'build',
    tagline: 'A library of reusable widgets.',
    status: 'ready',
    icon: 'widgets',
    accent: '#059669',
    about: 'A growing catalogue of canvas widgets, from tables and charts to recorders, agents and stream decks, that you drop in and connect.',
    edges: ['Dozens of widgets, one consistent canvas.', 'Everything connects via live wires.', 'Save your own as templates.'],
    insteadOf: 'rigid, single-purpose apps',
    launch: 'canvas'
  },
  {
    key: 'plexiapi',
    name: 'PlexiAPI',
    group: 'build',
    tagline: 'Programmatic access to your workspace.',
    status: 'ready',
    icon: 'api',
    accent: '#047857',
    about: 'A local REST API over your workspace, for your own scripts and tools. The server binds only to 127.0.0.1 and is off until you enable it; access needs a scoped token whose raw value is shown once and stored only as a hash.',
    edges: ['Read and write your real workspace objects.', 'Scoped read or read/write tokens.', 'Local only, off by default, no data leaves your machine.'],
    insteadOf: 'screen-scraping or no access at all',
    launch: 'api'
  },

  // ── PlexiConnect ─────────────────────────────────────────────────────────
  {
    key: 'pleximail',
    name: 'PlexiMail',
    group: 'connect',
    tagline: 'Email inside your workspace.',
    status: 'ready',
    icon: 'mail',
    accent: '#6366f1',
    about: 'A fast IMAP and SMTP client that turns emails into tasks, drafts AI replies in your voice, and keeps mail beside the work.',
    edges: [
      'Turn any email into a task on the right desk.',
      'AI drafts replies that sound like you.',
      'No tab-switching between mail and work.'
    ],
    insteadOf: 'Outlook / Gmail',
    launch: 'mail'
  },
  {
    key: 'plexivault',
    name: 'PlexiVault',
    group: 'connect',
    tagline: 'Secrets and credentials, secured.',
    status: 'ready',
    icon: 'lock',
    accent: '#4f46e5',
    about: 'An encrypted vault for passwords, keys and sensitive notes, with export, backup and restore you control.',
    edges: ['Encrypted at rest with a password you own.', 'Backup, export and restore.', 'No third-party password manager bill.'],
    insteadOf: '1Password / LastPass',
    launch: 'vault'
  },
  {
    key: 'pleximarketplace',
    name: 'PlexiMarketplace',
    group: 'connect',
    tagline: 'Start from a template.',
    status: 'ready',
    icon: 'storefront',
    accent: '#4338ca',
    about: 'A gallery of built-in starter templates, tables, reports, automations and knowledge, that you add to your workspace with one click. Community publishing, where teams share their own templates, is on the way.',
    edges: ['Start from a proven template, not a blank desk.', 'Applies real, editable objects, not a demo.', 'One click to add a whole setup.'],
    insteadOf: 'building everything from scratch',
    launch: 'marketplace'
  },

  // ── PlexiOps (the future business suite) ─────────────────────────────────
  {
    key: 'plexiops',
    name: 'PlexiOps',
    group: 'ops',
    tagline: 'Run the whole business, not just the work.',
    status: 'planned',
    icon: 'corporate_fare',
    accent: '#14b8a6',
    about: 'The business-management layer of Plexii: marketing, CRM, accounting, payroll, inventory and MRP, all sharing the same data, identity and AI as the rest of your workspace. Over time, an entire business runs on Plexii.',
    edges: [
      'One system for the work and the business that surrounds it.',
      'CRM, finance and operations sharing the same source of truth.',
      'AI and automation across the entire company, not siloed apps.'
    ],
    insteadOf: 'a dozen disconnected business apps',
    planned: ['Marketing and CRM', 'Accounting and invoicing', 'Payroll', 'Inventory and MRP', 'Business dashboards across it all']
  }
]

export function allProducts(): PlexiProduct[] {
  return [PLEXI_DESK, ...PLEXI_PRODUCTS]
}

export function productByKey(key: string): PlexiProduct | undefined {
  return allProducts().find((p) => p.key === key)
}

export function productsInGroup(groupKey: string): PlexiProduct[] {
  return PLEXI_PRODUCTS.filter((p) => p.group === groupKey)
}

export const STATUS_LABEL: Record<PlexiStatus, string> = {
  ready: 'Ready',
  soon: 'Coming soon',
  planned: 'Planned'
}
