/* eslint-disable */
// Demo-workspace seeder for PlexiDesk.
//
// Adds a "Demo Workspace" folder with three desks that exercise every building
// block: a tour of all the widget kinds, a "Live Circuit" desk wiring a browser
// + notes into a desk agent that feeds a card, and a "Control Room" desk with
// live portals into the others — plus a couple of time-travel snapshots.
//
// It NEVER touches your existing data: it deletes only a previous "Demo
// Workspace" (cascade) and re-creates it, so it's safe to re-run.
//
// Run it through Electron-as-Node so the native better-sqlite3 ABI matches:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tools/seed-demo.cjs
//
// Override the DB path with DB_PATH=/abs/path if needed.

const path = require('path')
const os = require('os')
const Database = require('better-sqlite3')
const { randomUUID } = require('crypto')

const DB_PATH =
  process.env.DB_PATH ||
  path.join(os.homedir(), 'Library', 'Application Support', 'plexii', 'focusbuddy.db')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 8000')

let T = Date.now()
const now = () => T++ // monotonic-ish so sort_order/created_at are stable

// ── tiny insert helpers ─────────────────────────────────────────────────────
function node(parentId, kind, title, sort) {
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO nodes (id, parent_id, kind, title, description, status, priority, interest, importance, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'open', 3, 3, 3, ?, ?, ?)`
  ).run(id, parentId, kind, title, sort, t, t)
  return id
}

let Z = 1
function widget(taskId, kind, opts) {
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO widgets (id, task_id, kind, title, content, x, y, width, height, z_index, color, parent_section_id, created_at, updated_at)
     VALUES (@id, @taskId, @kind, @title, @content, @x, @y, @width, @height, @z, @color, @parent, @t, @t)`
  ).run({
    id,
    taskId,
    kind,
    title: opts.title || '',
    content: opts.content || '',
    x: opts.x,
    y: opts.y,
    width: opts.w,
    height: opts.h,
    z: Z++,
    color: opts.color || null,
    parent: opts.parent || null,
    t
  })
  return id
}

function link(sourceId, targetId, taskId, type, verb) {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO widget_links (id, source_widget_id, target_widget_id, task_id, created_at, type, verb, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(id, sourceId, targetId, taskId, now(), type || 'context', verb || '')
  return id
}

function table(taskId, title, columns, rows, pos) {
  const tableId = randomUUID()
  const t = now()
  // Columns are FieldDefinitions — ensure each carries a config object so the
  // cell editors (checkbox, select, etc.) always have one to read.
  const cols = columns.map((c) => ({ config: {}, ...c }))
  db.prepare(
    `INSERT INTO fb_tables (id, task_id, title, schema_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tableId, taskId, title, JSON.stringify({ columns: cols }), t, t)
  rows.forEach((cells, i) => {
    db.prepare(
      `INSERT INTO fb_rows (id, table_id, cells_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), tableId, JSON.stringify(cells), i, now(), now())
  })
  return widget(taskId, 'table', { ...pos, title, content: tableId })
}

function snapshot(taskId, label, widgetIds) {
  const rows = db
    .prepare('SELECT * FROM widgets WHERE task_id = ? AND id IN (' + widgetIds.map(() => '?').join(',') + ')')
    .all(taskId, ...widgetIds)
  const payload = rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    zIndex: r.z_index,
    color: r.color,
    parentSectionId: r.parent_section_id ?? null,
    pinned: false,
    archived: false
  }))
  db.prepare(
    `INSERT INTO canvas_snapshots (id, task_id, at, label, widget_count, payload) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), taskId, now(), label, payload.length, JSON.stringify(payload))
}

// ── wipe any previous demo (cascade drops its desks/widgets/links/snaps) ─────
const prior = db.prepare("SELECT id FROM nodes WHERE title = 'Demo Workspace' AND parent_id IS NULL").all()
for (const p of prior) db.prepare('DELETE FROM nodes WHERE id = ?').run(p.id)

const seed = db.transaction(() => {
  const folder = node(null, 'folder', 'Demo Workspace', 0)

  // ── Desk 1 — All Widgets Tour ──────────────────────────────────────────────
  const tour = node(folder, 'task', '1 · All Widgets Tour', 0)
  widget(tour, 'sticky', { x: 80, y: 100, w: 240, h: 180, color: '#fde68a', title: 'Welcome', content: 'Welcome to PlexiDesk.\n\nThis desk shows one of every building block. Drag, resize, wire them together, and dive into the others in this folder.' })
  widget(tour, 'note', { x: 360, y: 100, w: 280, h: 180, content: 'Your desk is spatial. Where you put things means something — and connections between widgets are live wires, not just lines.' })
  widget(tour, 'markdown', { x: 680, y: 100, w: 300, h: 200, title: 'Checklist', content: '## Try this\n- [x] Open the other demo desks\n- [ ] Click a wire to change its type\n- [ ] Run the desk agent\n- [ ] Open History (top bar) to time-travel' })
  widget(tour, 'card', { x: 1020, y: 100, w: 300, h: 200, content: JSON.stringify({ title: 'Card widget', body: 'A titled callout with an accent bar — good for highlights and summaries.', accent: '#6366f1' }) })
  widget(tour, 'shape', { x: 1360, y: 100, w: 240, h: 200, content: JSON.stringify({ shape: 'hexagon', fill: '#ddd6fe', stroke: '#7c3aed', strokeWidth: 2, label: 'Shape' }) })

  table(
    tour,
    'Launch tasks',
    [
      { id: 'c_task', label: 'Task', type: 'text-short' },
      { id: 'c_owner', label: 'Owner', type: 'text-short' },
      { id: 'c_done', label: 'Done', type: 'checkbox' }
    ],
    [
      { c_task: 'Draft positioning', c_owner: 'Mia', c_done: 'true' },
      { c_task: 'Build landing page', c_owner: 'Sam', c_done: 'false' },
      { c_task: 'Line up launch posts', c_owner: 'Jo', c_done: 'false' }
    ],
    { x: 80, y: 340, w: 360, h: 240 }
  )
  widget(tour, 'field', { x: 480, y: 340, w: 240, h: 140, content: JSON.stringify({ def: { id: 'f1', type: 'text-short', label: 'Sprint', config: {} }, value: 'Q3 launch' }) })
  widget(tour, 'page', { x: 760, y: 340, w: 360, h: 300, title: 'Project brief', content: JSON.stringify({ type: 'doc', content: [ { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Project brief' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'A Notion-style document widget. Headings, lists and rich text live here.' }] }, { type: 'bulletList', content: [ { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Goal: ship the live-circuit MVP' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Audience: focused makers' }] }] } ] } ] }) })
  widget(tour, 'webview', { x: 1160, y: 340, w: 520, h: 360, content: 'https://en.wikipedia.org/wiki/Getting_things_done' })
  widget(tour, 'calculator', { x: 1720, y: 340, w: 240, h: 300 })

  widget(tour, 'color', { x: 80, y: 620, w: 240, h: 240 })
  widget(tour, 'timer', { x: 360, y: 620, w: 240, h: 220 })
  widget(tour, 'scratchpad', { x: 640, y: 660, w: 360, h: 280 })
  widget(tour, 'diagram', { x: 1040, y: 660, w: 380, h: 280 })
  widget(tour, 'streamdeck', { x: 1460, y: 740, w: 460, h: 320 })

  widget(tour, 'custom-block', { x: 80, y: 900, w: 360, h: 300 })
  widget(tour, 'voice-recorder', { x: 480, y: 900, w: 280, h: 240 })
  widget(tour, 'file', { x: 800, y: 980, w: 260, h: 220 })
  widget(tour, 'mindmap', { x: 1100, y: 980, w: 420, h: 320, content: JSON.stringify({ root: { id: 'r', label: 'Launch plan', kind: 'idea', children: [ { id: 'c1', label: 'Marketing', kind: 'task', children: [] }, { id: 'c2', label: 'Engineering', kind: 'task', children: [] }, { id: 'c3', label: 'Open questions', kind: 'question', children: [] } ] } }) })

  // ── Desk 2 — Live Circuit (wires + a desk agent) ───────────────────────────
  const live = node(folder, 'task', '2 · Live Circuit', 1)
  const lbrowser = widget(live, 'webview', { x: 80, y: 120, w: 520, h: 380, title: 'Research', content: 'https://en.wikipedia.org/wiki/Pomodoro_Technique' })
  const lactions = widget(live, 'markdown', { x: 640, y: 120, w: 320, h: 240, title: 'Action items', content: '## Action items\n\n_A transform wire from the browser fills this in. Click the wire’s badge to see its instruction, then press Run._' })
  link(lbrowser, lactions, live, 'transform', 'Read the page and write a short markdown checklist of the key actionable takeaways.')

  const lnotes = widget(live, 'sticky', { x: 80, y: 540, w: 240, h: 180, color: '#bbf7d0', title: 'My notes', content: 'Things I care about:\n- 25-minute focus blocks\n- short breaks\n- protect deep work' })

  const lagent = widget(live, 'agent', { x: 660, y: 420, w: 340, h: 320, title: 'Summariser', content: JSON.stringify({ instruction: 'Using the wired browser page and my notes, write 3 crisp bullet points I can act on today.', trigger: 'onChange', intervalSec: 120, enabled: true, lastRunAt: null, lastOutput: 'Press Run to generate. Then this flows into the green card →\n\n(needs your Anthropic API key in Settings)', lastError: null, history: [] }) })
  // Inputs INTO the agent
  link(lbrowser, lagent, live, 'context', '')
  link(lnotes, lagent, live, 'context', '')
  // Output OUT of the agent into a card (mirror = deliver the agent's output)
  const lcard = widget(live, 'card', { x: 1040, y: 420, w: 320, h: 260, content: JSON.stringify({ title: 'Live summary', body: 'The agent feeds its latest output here automatically after each run.', accent: '#10b981' }) })
  link(lagent, lcard, live, 'mirror', '')

  // A simple mirror pair to show plain mirroring
  const lmA = widget(live, 'sticky', { x: 80, y: 760, w: 220, h: 160, color: '#fde68a', title: 'Edit me', content: 'Type here — the sticky on the right mirrors this live.' })
  const lmB = widget(live, 'sticky', { x: 330, y: 760, w: 220, h: 160, color: '#fef08a', title: 'Mirror', content: '' })
  link(lmA, lmB, live, 'mirror', '')

  // Time-travel: an earlier snapshot (before the agent + card) and the current one.
  snapshot(live, 'Before the agent', [lbrowser, lactions, lnotes, lmA, lmB])
  snapshot(live, 'Wired up', [lbrowser, lactions, lnotes, lagent, lcard, lmA, lmB])

  // ── Desk 3 — Control Room (live portals) ───────────────────────────────────
  const room = node(folder, 'task', '3 · Control Room', 2)
  widget(room, 'sticky', { x: 80, y: 80, w: 360, h: 150, color: '#bfdbfe', title: 'Control room', content: 'Each window below is a LIVE view of another desk. Glance at them, or click to dive in.' })
  widget(room, 'portal', { x: 80, y: 260, w: 340, h: 280, content: JSON.stringify({ targetTaskId: tour }) })
  widget(room, 'portal', { x: 460, y: 260, w: 340, h: 280, content: JSON.stringify({ targetTaskId: live }) })

  return { folder, tour, live, room }
})

try {
  const ids = seed()
  console.log('Demo workspace created:')
  console.log('  folder:', ids.folder)
  console.log('  desks :', ids.tour, ids.live, ids.room)
  console.log('\nRestart PlexiDesk (or reload) and open the "Demo Workspace" folder.')
} catch (e) {
  if (String(e.message || e).includes('locked') || String(e.code) === 'SQLITE_BUSY') {
    console.error('The database is locked — quit PlexiDesk, then run this again.')
  } else {
    console.error('Seed failed:', e)
  }
  process.exitCode = 1
} finally {
  db.close()
}
