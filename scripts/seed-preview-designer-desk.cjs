#!/usr/bin/env node
// Seed a showcase desk into the PlexiDesk Preview profile.
//
// What it demonstrates: a graphic designer running a client website project
// entirely on one desk — brief, deliverables, budget, palette, type, sitemap,
// staging site, client feedback and the week's work, all in view at once.
//
// SAMPLE DATA, and labelled as such. The client, the people, the hours and the
// money are invented for the demo; the brief widget says so in its first line so
// nobody mistakes this desk for a real engagement. It writes only to the PREVIEW
// profile (~/Library/Application Support/PlexiDesk3Preview), never to the real
// workspace.
//
// Idempotent: re-running removes the previously seeded desk and rebuilds it, so
// this can be iterated on safely. Nothing else in the profile is touched.
//
// Usage:  node scripts/seed-preview-designer-desk.cjs [--remove]

const { DatabaseSync } = require('node:sqlite')
const { randomUUID } = require('node:crypto')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { existsSync } = require('node:fs')

const DB = join(homedir(), 'Library', 'Application Support', 'PlexiDesk3Preview', 'focusbuddy.db')
const DESK_TITLE = 'Hallow & Vine — Website Design & Build'
const now = Date.now()
const day = 86400000

if (!existsSync(DB)) {
  console.error(`No Preview profile at ${DB}\nOpen PlexiDesk 3 Preview once so it creates one, then re-run.`)
  process.exit(2)
}

const db = new DatabaseSync(DB)
const uid = () => randomUUID()

// ── clear any previous run ───────────────────────────────────────────────────
const prior = db.prepare('SELECT id FROM nodes WHERE title = ?').all(DESK_TITLE)
if (prior.length) {
  db.exec('BEGIN')
  for (const p of prior) {
    const tables = db.prepare('SELECT id FROM fb_tables WHERE task_id = ?').all(p.id)
    for (const t of tables) db.prepare('DELETE FROM fb_rows WHERE table_id = ?').run(t.id)
    db.prepare('DELETE FROM fb_tables WHERE task_id = ?').run(p.id)
    db.prepare('DELETE FROM widgets WHERE task_id = ?').run(p.id)
    db.prepare('DELETE FROM nodes WHERE id = ?').run(p.id)
  }
  db.exec('COMMIT')
  console.log(`removed ${prior.length} previously seeded desk(s)`)
}
if (process.argv.includes('--remove')) {
  db.close()
  console.log('done — nothing seeded')
  process.exit(0)
}

// ── the desk ────────────────────────────────────────────────────────────────
const deskId = uid()
db.prepare(
  `INSERT INTO nodes (id, parent_id, kind, title, description, status, priority, interest, importance,
                      sort_order, created_at, updated_at, org_id)
   VALUES (?, NULL, 'task', ?, ?, 'open', 1, 4, 5, 0, ?, ?, 'personal')`
).run(
  deskId,
  DESK_TITLE,
  'Sample showcase desk — demo data for PlexiDesk Preview.',
  now - 21 * day,
  now
)

// ── the deliverables table (the chart reads from this too) ───────────────────
const tableId = uid()
const COL = { name: 'c-name', phase: 'c-phase', owner: 'c-owner', due: 'c-due', hours: 'c-hours', status: 'c-status' }
const STATUS = [
  { id: 's-done', label: 'Approved', color: '#10b981' },
  { id: 's-review', label: 'With client', color: '#f59e0b' },
  { id: 's-wip', label: 'In progress', color: '#6366f1' },
  { id: 's-todo', label: 'Not started', color: '#94a3b8' }
]
db.prepare(
  `INSERT INTO fb_tables (id, task_id, title, schema_json, created_at, updated_at, org_id)
   VALUES (?, ?, ?, ?, ?, ?, 'personal')`
).run(
  tableId,
  deskId,
  'Deliverables',
  JSON.stringify({
    columns: [
      { id: COL.name, type: 'text-short', label: 'Deliverable', config: {} },
      { id: COL.phase, type: 'text-short', label: 'Phase', config: {} },
      { id: COL.owner, type: 'text-short', label: 'Owner', config: {} },
      { id: COL.due, type: 'text-short', label: 'Due', config: {} },
      { id: COL.hours, type: 'number', label: 'Hours', config: {} },
      { id: COL.status, type: 'single-select', label: 'Status', config: { options: STATUS } }
    ]
  }),
  now - 21 * day,
  now
)

const DELIVERABLES = [
  ['Discovery workshop + brief sign-off', 'Discovery', 'Ava', '14 Aug', 8, 's-done'],
  ['Competitor + cellar-door audit', 'Discovery', 'Ava', '16 Aug', 6, 's-done'],
  ['Moodboards — three directions', 'Concept', 'Ava', '22 Aug', 12, 's-done'],
  ['Brand palette + type system', 'Concept', 'Ava', '27 Aug', 10, 's-done'],
  ['Sitemap + wireframes (7 pages)', 'Structure', 'Ava', '3 Sep', 14, 's-done'],
  ['Homepage design — desktop', 'Design', 'Ava', '9 Sep', 16, 's-review'],
  ['Homepage design — mobile', 'Design', 'Ava', '11 Sep', 8, 's-review'],
  ['Our Wines + single-wine template', 'Design', 'Ava', '18 Sep', 18, 's-wip'],
  ['Cellar Door + Visit page', 'Design', 'Ava', '23 Sep', 10, 's-wip'],
  ['Photography art direction + shot list', 'Design', 'Ava', '25 Sep', 6, 's-wip'],
  ['Component library handoff (Figma)', 'Handoff', 'Ava', '30 Sep', 12, 's-todo'],
  ['Build QA + design sign-off', 'Handoff', 'Jonah (dev)', '9 Oct', 8, 's-todo'],
  ['Launch assets — social + email header', 'Launch', 'Ava', '14 Oct', 6, 's-todo']
]
const insertRow = db.prepare(
  `INSERT INTO fb_rows (id, table_id, cells_json, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`
)
DELIVERABLES.forEach((r, i) => {
  insertRow.run(
    uid(),
    tableId,
    JSON.stringify({
      [COL.name]: r[0], [COL.phase]: r[1], [COL.owner]: r[2],
      [COL.due]: r[3], [COL.hours]: r[4], [COL.status]: r[5]
    }),
    i,
    now - 21 * day,
    now
  )
})

// ── widgets ─────────────────────────────────────────────────────────────────
const W = []
let z = 1
const add = (kind, title, content, x, y, width, height, color = null) =>
  W.push({ id: uid(), kind, title, content, x, y, width, height, color, z: z++ })

// Band A — orientation
add('markdown', 'Project brief', `## Hallow & Vine — Website Design & Build

> **Sample showcase desk.** Client, people, hours and figures are demo data for PlexiDesk Preview.

**Client** Hallow & Vine, small-batch winery, Adelaide Hills
**Engagement** Brand site — design, art direction, dev handoff
**Fee** $18,400 + GST, fixed · **Contracted hours** 160
**Kickoff** 12 Aug · **Launch target** 21 Oct

### What we're making
A site that sells the *place* as much as the wine. Seven pages, a
single-wine template that scales to 20+ labels, and a cellar-door
booking flow that hands off to their existing system.

### Scope — in
- Visual identity extension (web only: palette, type scale, motion)
- Sitemap, wireframes, full design for 7 pages, desktop + mobile
- Photography art direction and shot list
- Component library + spec handoff to Jonah
- Launch assets: social set, email header

### Scope — out
- Logo redesign (their mark stays as-is)
- Copywriting — client supplies, we typeset
- Ongoing content updates after launch
- Ecommerce/checkout (phase 2, quoted separately)

### Working agreement
- Two rounds of revisions per deliverable, then hourly at $145
- Feedback consolidated into one document per round
- 48h turnaround on approvals or the date moves
- Fortnightly Thursday check-in, 30 min

### Where things stand
Concept and structure signed off. Homepage is with the client for
round 2. Wine templates in progress. **Watch the photography date** —
the shoot gates three deliverables.`, 60, 60, 660, 600)

add('card', 'Next milestone', JSON.stringify({
  title: 'Homepage sign-off — Thu 18 Sep',
  body: 'Round 2 is with Marguerite. If it lands by Thursday the wine templates stay on track for the 25th. If it slips past Monday, the photo shoot moves and Launch goes with it.',
  accent: '#f59e0b',
  bgFill: true,
  icon: '🎯'
}), 744, 60, 460, 200)

add('contacts', 'Client & studio', JSON.stringify({
  groups: ['Client', 'Studio', 'Suppliers'],
  activeGroup: 'All',
  contacts: [
    { name: 'Marguerite Hallow', role: 'Owner · approver', tag: 'Client', tone: 'hot', email: 'marguerite@hallowandvine.com.au', phone: '0412 448 902' },
    { name: 'Tom Vine', role: 'Cellar door manager', tag: 'Client', tone: 'warm', email: 'tom@hallowandvine.com.au' },
    { name: 'Ava Brennan', role: 'Design lead — you', tag: 'Studio', tone: 'neutral', email: 'ava@studio.com.au' },
    { name: 'Jonah Reid', role: 'Front-end build', tag: 'Studio', tone: 'warm', email: 'jonah@studio.com.au', phone: '0438 117 265' },
    { name: 'Priya Raman', role: 'Photographer', tag: 'Suppliers', tone: 'cool', email: 'priya@ramanstudio.com.au' },
    { name: 'Chris Oyelaran', role: 'Copywriter (client side)', tag: 'Suppliers', tone: 'cool', email: 'chris@oyelaran.co' }
  ]
}), 744, 284, 460, 376)

add('table', 'Deliverables', tableId, 1228, 60, 980, 600)

add('stat-card', 'Budget burn', JSON.stringify({
  title: 'Hours against the 160 contracted',
  series: [
    { label: 'Hours logged', value: 92, unit: 'h', points: [8, 14, 26, 38, 52, 64, 78, 92], caption: 'Week 1 → week 8' },
    { label: 'Fee drawn', display: '$10,580', points: [920, 1610, 2990, 4370, 5980, 7360, 8970, 10580], caption: 'of $18,400 fixed' },
    { label: 'Revisions used', value: 3, points: [0, 0, 1, 1, 2, 2, 3, 3], caption: 'of 2 included per deliverable' }
  ],
  activeIndex: 0
}), 2232, 60, 500, 290)

add('metrics', 'Project at a glance', JSON.stringify({
  title: 'Week 8 of 10',
  cells: [
    { label: 'Deliverables done', value: 5, display: '5 / 13', points: [0, 1, 2, 2, 3, 4, 5, 5] },
    { label: 'Hours left', value: 68, display: '68 h', points: [152, 146, 134, 122, 108, 96, 82, 68] },
    { label: 'Days to launch', value: 36, display: '36', points: [70, 63, 56, 49, 43, 43, 39, 36] },
    { label: 'Open feedback', value: 7, points: [0, 2, 5, 3, 9, 6, 11, 7] }
  ],
  bars: [8, 6, 12, 10, 14, 16, 8, 18],
  barsLabel: 'Hours logged per week',
  source: 'Sample data — demo desk'
}), 2232, 372, 500, 288)

// Band B — design work
add('mindmap', 'Sitemap', JSON.stringify({
  root: {
    id: 'root', label: 'hallowandvine.com.au', kind: 'idea',
    attachedWidgetIds: [], assignedAgentSlugs: [], pendingChildren: [],
    children: [
      { id: 'n-home', label: 'Home', kind: 'idea', children: [
        { id: 'n-hero', label: 'Hero — the ridge at dawn', kind: 'idea', children: [] },
        { id: 'n-story', label: 'Story strip', kind: 'idea', children: [] },
        { id: 'n-feat', label: 'Featured release', kind: 'idea', children: [] }
      ]},
      { id: 'n-wines', label: 'Our Wines', kind: 'idea', children: [
        { id: 'n-tpl', label: 'Single-wine template ×20', kind: 'task', children: [] },
        { id: 'n-vint', label: 'Vintage archive', kind: 'question', children: [] }
      ]},
      { id: 'n-visit', label: 'Visit / Cellar Door', kind: 'idea', children: [
        { id: 'n-book', label: 'Booking → existing system', kind: 'question', children: [] },
        { id: 'n-hours', label: 'Hours + map', kind: 'idea', children: [] }
      ]},
      { id: 'n-story2', label: 'Our Story', kind: 'idea', children: [] },
      { id: 'n-club', label: 'Wine Club', kind: 'idea', children: [
        { id: 'n-tiers', label: 'Three tiers', kind: 'idea', children: [] }
      ]},
      { id: 'n-journal', label: 'Journal', kind: 'idea', children: [] },
      { id: 'n-contact', label: 'Contact / Trade', kind: 'idea', children: [] }
    ]
  }
}), 60, 700, 640, 440)

add('chart', 'Hours by phase', JSON.stringify({
  tableId, type: 'bar', xColumnId: COL.phase,
  series: [{ columnId: COL.hours, agg: 'sum' }]
}), 724, 700, 480, 440)

add('webview', 'Staging — hallowandvine', 'https://www.awwwards.com/websites/wine/', 1228, 700, 980, 560)

add('note', 'Client feedback — round 2', `MARGUERITE · 11 Sep · homepage round 2

Loves the ridge-at-dawn hero. "That's the feeling."

Changes she wants:
1. Logo bigger in the header — currently reads as timid
2. The dark green feels heavy over a full-bleed photo.
   Can we try the warmer stone as the section ground?
3. Move "Book a tasting" above the fold. It's the one
   thing the cellar door actually needs from the site.
4. Vintage year should be prominent on the wine cards —
   collectors shop by year, not by name.
5. Drop the quote carousel. "Nobody reads those."

Not changing (agreed on the call):
- Serif for headings stays — she was worried it read
  old-fashioned, walked through the specimen, happy now.
- One hero image, not a slideshow.

TOM · 12 Sep
Cellar door hours need to be editable by staff without
calling us. Flag for Jonah — needs a CMS field, not hardcoded.`, 2232, 700, 500, 560)

add('sticky', 'This week', `MON  Homepage r2 revisions
TUE  Wine template — 3 labels
WED  Send shot list to Priya
THU  Client check-in 2pm
     → push for homepage sign-off
FRI  Cellar Door page start

BLOCKED
Photo shoot date — needs
Marguerite's yes before
Priya holds the 26th`, 60, 1180, 300, 300, '#fbbf24')

// Brand palette
const PALETTE = [
  ['#1F3B2C', 'Vine — headings'],
  ['#6E8B5A', 'Leaf — accents'],
  ['#C9A227', 'Harvest — CTAs'],
  ['#E8E1D4', 'Stone — grounds'],
  ['#2B2B2B', 'Ink — body']
]
PALETTE.forEach(([hex, label], i) => add('color', label, hex, 384 + i * 164, 1180, 152, 196))

add('markdown', 'Type specimen', `### Type system

**Headings — Canela Deck**
Light 300 · 56/60 · -0.02em
*Hallow & Vine*

**Body — Söhne**
Book 400 · 17/28 · 0em
The ridge holds the morning fog until ten, which is
why the fruit ripens a fortnight behind the valley
floor — and why the wine tastes like it does.

**Detail / labels — Söhne Mono**
Regular · 12/16 · 0.08em uppercase
VINTAGE 2021 · SHIRAZ · 14.1%

---
Scale 1.333 (perfect fourth)
72 · 56 · 42 · 32 · 24 · 18 · 17 · 13

Measure 62–68ch · Never below 16px on mobile.`, 60, 1512, 560, 320)

add('gallery', 'Moodboard — direction 3 (chosen)', JSON.stringify({ fileIds: [] }), 644, 1512, 560, 320)

add('task-list', 'Open tasks', JSON.stringify({ scope: 'desk', filter: 'open' }), 1228, 1284, 460, 320)

add('field', 'Scope changes', JSON.stringify({
  def: { id: 'f-scope', type: 'number', label: 'Out-of-scope hours', config: { suffix: ' h' } },
  value: 6
}), 1712, 1284, 240, 220)

add('timer', 'Design sprint', '2700', 1976, 1284, 232, 220)

add('page', 'Kickoff notes — 12 Aug', JSON.stringify({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Kickoff — Hallow & Vine' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '12 Aug · cellar door · Marguerite, Tom, Ava' }] },
    { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'What they actually want' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'More cellar-door bookings. That is the number that matters to them.' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'To stop looking like "a hobby winery" next to the valley estates.' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Somewhere to put the vintage notes Marguerite writes every year.' }] }] }
    ]},
    { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Constraints' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bookings must hand off to their existing system — no replacement.' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Staff edit hours themselves. No developer for small changes.' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing logo is not up for discussion.' }] }] }
    ]},
    { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Risks flagged on day one' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Photography is the long pole — three deliverables sit behind it. Copy is client-supplied and historically late. Both called out in the brief.' }] }
  ]
}), 2232, 1284, 500, 400)

// ── write ───────────────────────────────────────────────────────────────────
const insertWidget = db.prepare(
  `INSERT INTO widgets (id, task_id, kind, title, content, x, y, width, height, z_index, color, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
db.exec('BEGIN')
for (const w of W) {
  insertWidget.run(w.id, deskId, w.kind, w.title, w.content, w.x, w.y, w.width, w.height, w.z, w.color, now - 20 * day, now)
}
db.exec('COMMIT')

const kinds = [...new Set(W.map((w) => w.kind))].sort()
console.log(`seeded "${DESK_TITLE}"`)
console.log(`  desk id   ${deskId}`)
console.log(`  widgets   ${W.length} across ${kinds.length} kinds: ${kinds.join(', ')}`)
console.log(`  table     Deliverables — ${DELIVERABLES.length} rows, 6 columns`)
console.log('\nRestart PlexiDesk 3 Preview to see it (it reads the database at launch).')
db.close()
