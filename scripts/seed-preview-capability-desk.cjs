#!/usr/bin/env node
// Seed a showcase desk into the PlexiDesk Preview profile.
//
// What it demonstrates, on ONE desk and as one coherent job of work (shipping a
// release), the five capabilities that landed most recently:
//
//   Mail          — the inbox narrowed to this launch by a rule you can read,
//                   with AI triage available from the mailbox itself.
//   PlexiDesign   — a real design document: the launch announcement card.
//   PlexiDraw     — a real draw document: the onboarding flow, sketched.
//   Custom widget — a widget written as HTML, running in the sandbox.
//   Browser agent — a standing agent that reads a page and reports findings.
//
// HONESTY, because a showcase is the easiest place to lie:
//   - The desk says on its face that it is a showcase.
//   - The Mail widget carries a RULE, not fabricated messages. It shows whatever
//     is really in the connected mailbox; with no mailbox it says so.
//   - The browser agent carries an INSTRUCTION and has not run. It reports no
//     findings until somebody runs it.
//   - The custom widget starts with its checklist unticked. Nothing is
//     pre-ticked to make the demo look further along than it is.
//   - The only invented content is the copy inside the two design/draw
//     documents, which is what those documents ARE.
//
// Writes only to the PREVIEW profile (~/Library/Application Support/
// PlexiDesk3Preview), never to the real workspace.
//
// Idempotent: re-running removes the previously seeded desk and rebuilds it.
//
// Usage:  node scripts/seed-preview-capability-desk.cjs [--remove]

const { DatabaseSync } = require('node:sqlite')
const { randomUUID } = require('node:crypto')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { existsSync } = require('node:fs')

const DB =
  process.env.PLEXI_SEED_DB ||
  join(homedir(), 'Library', 'Application Support', 'PlexiDesk3Preview', 'focusbuddy.db')
const DESK_TITLE = 'Plexii 2.0 — Launch Command'
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
    // Documents a previous run created for this desk, found through the widgets
    // that point at them, so a re-run does not orphan them in the library.
    const docWidgets = db
      .prepare("SELECT content FROM widgets WHERE task_id = ? AND kind IN ('design','draw','doc')")
      .all(p.id)
    for (const w of docWidgets) {
      if (w.content) db.prepare('DELETE FROM documents WHERE id = ?').run(w.content)
    }
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
   VALUES (?, NULL, 'task', ?, ?, 'open', 1, 5, 5, 0, ?, ?, 'personal')`
).run(
  deskId,
  DESK_TITLE,
  'Showcase desk — demonstrates mail triage, PlexiDesign, PlexiDraw, custom widgets and the browser agent.',
  now - 9 * day,
  now
)

// ── the design document: the launch announcement ────────────────────────────
const designId = uid()
const INK = '#f8fafc'
const design = {
  schemaVersion: 1,
  width: 1200,
  height: 630,
  background: { type: 'gradient', color: '#0b1220', color2: '#3b1d6e', angle: 135 },
  elements: [
    { id: 'orb1', type: 'shape', shape: 'ellipse', x: 880, y: -170, w: 520, h: 520, z: 1,
      fill: { type: 'solid', color: '#7c3aed' }, opacity: 0.55 },
    { id: 'orb2', type: 'shape', shape: 'ellipse', x: 1010, y: 330, w: 320, h: 320, z: 1,
      fill: { type: 'solid', color: '#22d3ee' }, opacity: 0.35 },
    { id: 'rule', type: 'shape', shape: 'rect', x: 88, y: 214, w: 64, h: 5, z: 3,
      fill: { type: 'solid', color: '#22d3ee' } },
    { id: 'eyebrow', type: 'text', x: 88, y: 150, w: 700, h: 44, z: 4,
      fontFamily: 'Inter, system-ui, sans-serif', vAlign: 'top',
      paragraphs: [{ runs: [{ text: 'RELEASE ANNOUNCEMENT', bold: true, color: '#22d3ee', fontSize: 24, letterSpacing: 3 }], align: 'left' }] },
    { id: 'headline', type: 'text', x: 88, y: 252, w: 760, h: 200, z: 4,
      fontFamily: 'Inter, system-ui, sans-serif', vAlign: 'top',
      paragraphs: [{ runs: [{ text: 'Plexii 2.0', bold: true, color: INK, fontSize: 108 }], align: 'left' }] },
    { id: 'sub', type: 'text', x: 92, y: 392, w: 700, h: 120, z: 4,
      fontFamily: 'Inter, system-ui, sans-serif', vAlign: 'top',
      paragraphs: [{ runs: [{ text: 'Your desk, your mail and your agents — in one place.', color: '#cbd5e1', fontSize: 30 }], align: 'left' }] },
    { id: 'date', type: 'text', x: 92, y: 510, w: 500, h: 48, z: 4,
      fontFamily: 'Inter, system-ui, sans-serif', vAlign: 'top',
      paragraphs: [{ runs: [{ text: 'Shipping this quarter', color: '#94a3b8', fontSize: 22 }], align: 'left' }] }
  ]
}
db.prepare(
  `INSERT INTO documents (id, doc_type, title, body, archived, created_at, updated_at, org_id)
   VALUES (?, 'design', ?, ?, 0, ?, ?, 'personal')`
).run(designId, 'Launch announcement — 1200×630', JSON.stringify(design), now - 6 * day, now - 2 * day)

// ── the draw document: the onboarding flow, sketched ────────────────────────
// Rectangles are closed 4-node subpaths with no bezier handles, which is what a
// straight-edged live shape is.
const rect = (id, x, y, w, h, color, name) => ({
  id, name, type: 'path', shapeKind: 'roundRect', cornerRadius: 14,
  path: { subpaths: [{ closed: true, nodes: [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
  ] }] },
  fill: { type: 'solid', color },
  stroke: { color: '#0f172a', width: 2, cap: 'round', join: 'round' }
})
const label = (id, x, y, w, text, size, color) => ({
  id, type: 'text', x, y, w, text, fontSize: size, fontWeight: 600,
  fontFamily: 'Inter, system-ui, sans-serif', align: 'center', color: color || '#0f172a'
})
const arrow = (id, x1, y1, x2) => ({
  id, type: 'path', shapeKind: 'line',
  path: { subpaths: [{ closed: false, nodes: [{ x: x1, y: y1 }, { x: x2, y: y1 }] }] },
  fill: { type: 'none' },
  stroke: { color: '#475569', width: 3, cap: 'round', join: 'round' }
})
const draw = {
  schemaVersion: 1,
  width: 1600,
  height: 900,
  background: { type: 'solid', color: '#ffffff' },
  layers: [
    {
      id: 'lyr-flow', name: 'Flow', visible: true, locked: false, opacity: 1,
      blend: 'normal', kind: 'vector',
      objects: [
        label('t-title', 120, 96, 900, 'Onboarding — first five minutes', 44, '#0f172a'),
        rect('b1', 120, 200, 300, 150, '#e0f2fe', 'Sign in'),
        label('l1', 130, 258, 280, 'Sign in', 28),
        arrow('a1', 420, 275, 500),
        rect('b2', 500, 200, 300, 150, '#ede9fe', 'Pick a desk'),
        label('l2', 510, 258, 280, 'Pick a desk', 28),
        arrow('a2', 800, 275, 880),
        rect('b3', 880, 200, 300, 150, '#dcfce7', 'Connect mail'),
        label('l3', 890, 258, 280, 'Connect mail', 28),
        rect('b4', 500, 460, 300, 150, '#fef3c7', 'First agent'),
        label('l4', 510, 518, 280, 'First agent', 28),
        label('note', 120, 700, 1000, 'Sketched on the desk — the decision points are the three boxes across the top.', 24, '#475569')
      ]
    }
  ]
}
const drawId = uid()
db.prepare(
  `INSERT INTO documents (id, doc_type, title, body, archived, created_at, updated_at, org_id)
   VALUES (?, 'draw', ?, ?, 0, ?, ?, 'personal')`
).run(drawId, 'Onboarding flow — sketch', JSON.stringify(draw), now - 5 * day, now - 1 * day)

// ── the custom widget: launch readiness, written as HTML ─────────────────────
// Self-contained, no network, and it starts UNTICKED. A pre-ticked demo
// checklist would be claiming progress that has not happened.
const CUSTOM_CODE = `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif; color:#0f172a; background:transparent; }
  @media (prefers-color-scheme: dark) { body { color:#e2e8f0 } }
  h1 { font-size:12px; letter-spacing:.08em; text-transform:uppercase; opacity:.55; margin:2px 0 10px; font-weight:600 }
  ul { list-style:none; margin:0; padding:0 }
  li { display:flex; align-items:flex-start; gap:8px; padding:6px 0; border-bottom:1px solid rgba(128,128,128,.18) }
  li:last-child { border-bottom:0 }
  input { margin:2px 0 0; width:15px; height:15px; accent-color:#7c3aed; flex:0 0 auto; cursor:pointer }
  label { flex:1; cursor:pointer }
  .done label { opacity:.45; text-decoration:line-through }
  .bar { height:5px; border-radius:99px; background:rgba(128,128,128,.2); overflow:hidden; margin:10px 0 4px }
  .fill { height:100%; width:0; background:linear-gradient(90deg,#7c3aed,#22d3ee); transition:width .25s ease }
  .count { font-variant-numeric:tabular-nums; opacity:.6; font-size:11px }
</style>
<h1>Launch readiness</h1>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="count" id="count">0 of 7</div>
<ul id="list"></ul>
<script>
  var ITEMS = [
    'Announcement card approved',
    'Onboarding flow signed off',
    'Pricing page copy final',
    'Migration guide published',
    'Support macros written',
    'Status page ready',
    'Rollback plan agreed'
  ];
  var api = window.plexi || { getState: function(){ return {} }, setState: function(){ return false } };
  var state = api.getState() || {};
  var done = Array.isArray(state.done) ? state.done : [];
  var list = document.getElementById('list');
  function save() {
    api.setState({ done: done });
    var n = done.length;
    document.getElementById('fill').style.width = Math.round((n / ITEMS.length) * 100) + '%';
    document.getElementById('count').textContent = n + ' of ' + ITEMS.length;
  }
  ITEMS.forEach(function (text, i) {
    var li = document.createElement('li');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'c' + i;
    box.checked = done.indexOf(i) !== -1;
    var lab = document.createElement('label');
    lab.htmlFor = box.id;
    lab.textContent = text;
    if (box.checked) li.className = 'done';
    box.addEventListener('change', function () {
      if (box.checked) { if (done.indexOf(i) === -1) done.push(i); }
      else { done = done.filter(function (x) { return x !== i }); }
      li.className = box.checked ? 'done' : '';
      save();
    });
    li.appendChild(box); li.appendChild(lab); list.appendChild(li);
  });
  save();
</script>`

// ── widgets ─────────────────────────────────────────────────────────────────
const W = [
  {
    id: uid(), kind: 'note', title: 'About this desk',
    content:
      'SHOWCASE DESK — built by a seed script, not by real work.\n\n' +
      'It puts five recent capabilities on one canvas as a single job: shipping a release.\n\n' +
      '• Mail — the inbox, narrowed by the rule on the widget. Real messages from your own mailbox, or an honest empty state if none is connected. Open Mail for AI triage and one-click unsubscribe.\n' +
      '• Launch announcement — a PlexiDesign document. Double-click to open the editor.\n' +
      '• Onboarding flow — a PlexiDraw document. Double-click for DrawStudio.\n' +
      '• Launch readiness — a custom widget: HTML running in a sandbox with no network.\n' +
      '• Competitor watch — a browser agent. It has NOT run; it holds an instruction and reports findings only once you run it.\n\n' +
      'Nothing here is pre-filled to look further along than it is.',
    x: 60, y: 60, width: 420, height: 420, z: 1, color: '#f8d477'
  },
  {
    id: uid(), kind: 'inbox', title: 'Launch mail',
    // A rule, not a cache. The widget reads the real mailbox through this.
    content: JSON.stringify({
      rules: { subject: ['launch', 'release', 'plexii 2.0'], sinceDays: 30 },
      scan: 200
    }),
    x: 520, y: 60, width: 480, height: 420, z: 1, color: null
  },
  {
    id: uid(), kind: 'design', title: 'Launch announcement',
    content: designId,
    x: 1040, y: 60, width: 520, height: 420, z: 1, color: null
  },
  {
    id: uid(), kind: 'draw', title: 'Onboarding flow',
    content: drawId,
    x: 60, y: 520, width: 620, height: 440, z: 1, color: null
  },
  {
    id: uid(), kind: 'custom', title: 'Launch readiness',
    content: JSON.stringify({
      spec: 'A launch readiness checklist: seven items, a progress bar, and it remembers what I tick.',
      code: CUSTOM_CODE,
      state: {},
      net: false
    }),
    x: 720, y: 520, width: 400, height: 440, z: 1, color: null
  },
  {
    id: uid(), kind: 'agent', title: 'Competitor watch',
    // An instruction and no run history: it has genuinely done nothing yet.
    content: JSON.stringify({
      instruction:
        'You are Competitor Watch for this launch.\n\n' +
        'Read the page wired into you. Report ONLY what that page actually says:\n\n' +
        '1. POSITIONING — the one sentence they lead with.\n' +
        '2. PRICING — tiers and prices, or "not stated on this page".\n' +
        '3. CLAIMS — any capability they name that we would be compared against.\n' +
        '4. CHANGED — anything different from the last run, or "first run".\n\n' +
        'Never infer a price or a feature that is not written on the page. ' +
        '"Not stated" is a finding; a guess is not.',
      trigger: 'manual',
      history: []
    }),
    x: 1160, y: 520, width: 400, height: 440, z: 1, color: null
  }
]

const insertWidget = db.prepare(
  `INSERT INTO widgets (id, task_id, kind, title, content, x, y, width, height, z_index, color, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
db.exec('BEGIN')
for (const w of W) {
  insertWidget.run(w.id, deskId, w.kind, w.title, w.content, w.x, w.y, w.width, w.height, w.z, w.color, now - 8 * day, now)
}
db.exec('COMMIT')

const kinds = [...new Set(W.map((w) => w.kind))].sort()
console.log(`seeded "${DESK_TITLE}"`)
console.log(`  desk id   ${deskId}`)
console.log(`  widgets   ${W.length}: ${kinds.join(', ')}`)
console.log(`  documents 2 (design ${designId.slice(0, 8)}, draw ${drawId.slice(0, 8)})`)
db.close()
