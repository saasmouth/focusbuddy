// node --test scripts/persona-demos/
//
// Two layers: the pure pipeline (validation, records, layout) against every spec
// in personas/, and the SQL write path against a throwaway copy of a real
// workspace database — skipped when no workspace exists on this machine.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')
const lib = require('./lib.cjs')
const { write, removeAll, loadSpecs } = require('./seed.cjs')

const NOW = Date.UTC(2026, 9, 8, 2, 0, 0)
const REF = JSON.parse(fs.readFileSync(join(__dirname, 'personas', '03-software-developers.json'), 'utf8'))
const clone = (o) => JSON.parse(JSON.stringify(o))
const { specs: ALL, errors: LOAD_ERRORS } = loadSpecs([])

// ── ids and dates ───────────────────────────────────────────────────────────
test('stableId is deterministic, unique per key and v5-shaped', () => {
  assert.equal(lib.stableId('a'), lib.stableId('a'))
  assert.notEqual(lib.stableId('a'), lib.stableId('b'))
  assert.match(lib.stableId('room:x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('date tokens resolve relative to the seed time', () => {
  const day = 86_400_000
  assert.equal(lib.resolveDates('due @today', NOW), `due ${lib.formatDay(NOW)}`)
  assert.equal(lib.resolveDates('ships @+4d, review @-2d', NOW), `ships ${lib.formatDay(NOW + 4 * day)}, review ${lib.formatDay(NOW - 2 * day)}`)
  assert.equal(lib.resolveDates('email@domain stays', NOW), 'email@domain stays')
})

// ── validation ──────────────────────────────────────────────────────────────
test('the reference spec is valid', () => {
  assert.deepEqual(lib.validateSpec(REF, 'ref'), [])
})

test('every persona spec on disk is valid, and the set is consistent', () => {
  assert.deepEqual(LOAD_ERRORS, [])
  assert.ok(ALL.length >= 1)
})

const broken = [
  ['chart on an unknown column', (s) => (s.desks[0].chart.series[0].column = 'nope'), /unknown column "nope"/],
  ['sum over a text column', (s) => (s.desks[0].chart.series[0].column = 'owner'), /must be a number column/],
  ['checkbox as chart category', (s) => (s.desks[1].chart.x = 'done'), /text-short or single-select/],
  ['pie with two series', (s) => s.desks[1].chart.series.push({ column: 'effort', agg: 'max' }), /exactly one series/],
  ['select value not in options', (s) => (s.desks[0].table.rows[0].status = 'Shipped'), /not one of the column's options/],
  ['number cell given as text', (s) => (s.desks[0].table.rows[0].lines = '640'), /number expected/],
  ['unknown column in a row', (s) => (s.desks[0].table.rows[0].extra = 'x'), /unknown column/],
  ['author-written sample notice', (s) => (s.desks[0].brief += '\n\nSample desk.'), /seeder adds it/],
  ['bad mindmap kind', (s) => (s.desks[0].mindmap.root.children[0].kind = 'agent'), /kind/],
  ['bad sticky colour', (s) => (s.desks[0].stickies[0].color = '#000000'), /color/],
  ['bad category', (s) => (s.category = 'Everyone'), /category/],
  ['unknown page block', (s) => s.desks[0].page.blocks.push({ h1: 'x' }), /one of/],
  ['select field value outside options', (s) => (s.desks[0].fields[1].value = '50%'), /must be one of options/],
  ['no browser', (s) => delete s.desks[0].browsers, /1–2 browsers required/],
  ['http browser', (s) => (s.desks[0].browsers[0].url = 'http://example.com/'), /https only/],
  ['non-canonical URL', (s) => (s.desks[0].browsers[0].url = 'https://example.com'), /canonical form/],
  ['URL with a fragment', (s) => (s.desks[0].browsers[0].url = 'https://example.com/#x'), /fragment/],
  ['URL carrying a token', (s) => (s.desks[0].browsers[0].url = 'https://example.com/?access_token=1'), /query parameters/],
  ['no image', (s) => (s.desks[0].images = []), /1–2 images required/],
  ['bad image aspect', (s) => (s.desks[0].images[0].aspect = 'wide'), /aspect/],
  ['only one advanced widget', (s) => delete s.desks[0].calculator, /at least 2 of diagram/],
  ['diagram edge to a missing node', (s) => (s.desks[0].diagram.edges[0].to = 'ghost'), /must name nodes/],
  ['calculator with ×', (s) => (s.desks[0].calculator.expression = '3 × 4'), /digits and/],
  ['calculator result that does not match', (s) => (s.desks[0].calculator.result = 47), /evaluates to/],
  ['form date not a token', (s) => (s.desks[1].form.fields[4].value = '2026-11-02'), /date token/],
  ['form number as a number', (s) => (s.desks[1].form.fields[2].value = 38), /numeric string/]
]
for (const [name, mutate, expected] of broken) {
  test(`rejects: ${name}`, () => {
    const s = clone(REF)
    mutate(s)
    const errs = lib.validateSpec(s, 'ref')
    assert.ok(errs.some((e) => expected.test(e)), `expected ${expected} in:\n${errs.join('\n')}`)
  })
}

test('duplicate numbers, slugs and room titles across files are rejected', () => {
  const a = { ...clone(REF), __file: 'a.json' }
  const b = { ...clone(REF), __file: 'b.json' }
  const errs = lib.validateSet([a, b])
  assert.ok(errs.some((e) => /duplicate number/.test(e)))
  assert.ok(errs.some((e) => /duplicate slug/.test(e)))
  assert.ok(errs.some((e) => /duplicate room title/.test(e)))
})

// ── records ─────────────────────────────────────────────────────────────────
const TINY = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='
const recs = lib.buildRecords(ALL, { now: NOW, imageData: () => TINY })

test('records are deterministic across builds', () => {
  const again = lib.buildRecords(ALL, { now: NOW, imageData: () => TINY })
  assert.deepEqual(again, recs)
})

test('every id is unique', () => {
  const ids = [...recs.nodes, ...recs.widgets, ...recs.tables, ...recs.rows].map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('the tree is one showcase room → persona rooms → desks', () => {
  const root = recs.nodes[0]
  assert.equal(root.title, lib.ROOT_TITLE)
  assert.equal(root.parent_id, null)
  const byId = new Map(recs.nodes.map((n) => [n.id, n]))
  const rooms = recs.nodes.filter((n) => n.kind === 'folder' && n.parent_id === root.id)
  assert.equal(rooms.length, ALL.length)
  for (const n of recs.nodes.slice(1)) assert.ok(byId.has(n.parent_id), `${n.title} has a parent`)
  for (const d of recs.nodes.filter((n) => n.kind === 'task' && n.parent_id !== root.id))
    assert.equal(byId.get(d.parent_id).kind, 'folder')
})

test('every room, desk and brief carries the sample notice', () => {
  for (const n of recs.nodes) assert.match(n.description, /[Ss]ample/, n.title)
  const briefs = recs.widgets.filter((w) => w.title === 'Brief')
  assert.equal(briefs.length, ALL.reduce((n, s) => n + s.desks.length, 0))
  for (const b of briefs) assert.ok(b.content.startsWith(lib.SAMPLE_BRIEF_NOTICE))
})

test('only publicly renderable widget kinds are used', () => {
  // A kind publishes when PUBLIC_RENDER_POLICY maps it, or when it is in
  // PUBLIC_CAPTURE_ALLOWED (the shared canvas shows its captured markup).
  const policy = fs.readFileSync(join(__dirname, '..', '..', 'src', 'shared', 'publicDesk.ts'), 'utf8')
  const mapped = policy.slice(policy.indexOf('PUBLIC_RENDER_POLICY'), policy.indexOf('Deliberately unmapped'))
  const capture = policy.slice(policy.indexOf('PUBLIC_CAPTURE_ALLOWED'), policy.indexOf('export function mayCapture'))
  for (const kind of new Set(recs.widgets.map((w) => w.kind)))
    assert.ok(new RegExp(`(^|\\s|')${kind}'?:`).test(mapped) || capture.includes(`'${kind}'`), `${kind} publishes publicly`)
})

test('no seeded kind acts on its own, needs an account, or is an office document', () => {
  const banned = ['agent', 'living-doc', 'webhook', 'inbound-hook', 'image-gen', 'doc', 'sheet', 'slides', 'map', 'design', 'draw', 'email', 'gdoc', 'gsheet', 'gslide', 'portal', 'gallery', 'stat-card', 'metrics', 'contacts']
  for (const w of recs.widgets) assert.ok(!banned.includes(w.kind), `${w.kind} on ${w.title}`)
})

test('charts, tables and select cells all reference things that exist', () => {
  const tables = new Map(recs.tables.map((t) => [t.id, JSON.parse(t.schema_json).columns]))
  for (const w of recs.widgets.filter((w) => w.kind === 'table')) assert.ok(tables.has(w.content))
  for (const w of recs.widgets.filter((w) => w.kind === 'chart')) {
    const c = JSON.parse(w.content)
    const cols = tables.get(c.tableId)
    assert.ok(cols, 'chart table exists')
    const ids = new Set(cols.map((x) => x.id))
    if (c.xColumnId) assert.ok(ids.has(c.xColumnId))
    for (const s of c.series) assert.ok(ids.has(s.columnId))
  }
  for (const r of recs.rows) {
    const cols = tables.get(r.table_id)
    for (const [k, v] of Object.entries(JSON.parse(r.cells_json))) {
      const col = cols.find((c) => c.id === k)
      assert.ok(col, `column ${k}`)
      if (col.type === 'single-select') assert.ok(col.config.options.some((o) => o.id === v), `${v} is an option of ${k}`)
    }
  }
})

test('widget content parses the way each widget reads it', () => {
  for (const w of recs.widgets) {
    if (['card', 'chart', 'mindmap', 'page', 'field', 'timer'].includes(w.kind)) assert.doesNotThrow(() => JSON.parse(w.content), w.title)
    if (w.kind === 'mindmap') assert.equal(JSON.parse(w.content).root.id, 'root')
    if (w.kind === 'page') assert.equal(JSON.parse(w.content).type, 'doc')
    if (w.kind === 'field') assert.equal(typeof JSON.parse(w.content).def.type, 'string')
    if (w.kind === 'color') assert.match(w.content, /^#[0-9a-f]{6}$/)
    // Tiptap rejects empty text nodes.
    if (w.kind === 'page') assert.ok(!w.content.includes('"text":""'), w.title)
    assert.ok(!/@(today|[+-]\d+d)/.test(w.content), `unresolved date token in ${w.title}`)
    assert.ok(!/@(today|[+-]\d+d)/.test(w.title), `unresolved date token in title ${w.title}`)
  }
  for (const n of recs.nodes) assert.ok(!/@(today|[+-]\d+d)/.test(n.title + n.description), n.title)
  for (const t of recs.tables) assert.ok(!/@(today|[+-]\d+d)/.test(t.title + t.schema_json), t.title)
  for (const r of recs.rows) assert.ok(!/@(today|[+-]\d+d)/.test(r.cells_json), r.id)
})

test('no two widgets on a desk overlap', () => {
  const byDesk = new Map()
  for (const w of recs.widgets) byDesk.set(w.task_id, [...(byDesk.get(w.task_id) ?? []), w])
  for (const [desk, ws] of byDesk) {
    for (let i = 0; i < ws.length; i++)
      for (let j = i + 1; j < ws.length; j++) {
        const a = ws[i]
        const b = ws[j]
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        assert.ok(!overlap, `"${a.title}" overlaps "${b.title}" on desk ${desk}`)
      }
  }
})

test('every desk has a browser, an image and at least two advanced widgets', () => {
  const byDesk = new Map()
  for (const w of recs.widgets) byDesk.set(w.task_id, [...(byDesk.get(w.task_id) ?? []), w.kind])
  for (const d of recs.nodes.filter((n) => n.kind === 'task' && n.parent_id !== recs.nodes[0].id)) {
    const kinds = byDesk.get(d.id) ?? []
    assert.ok(kinds.includes('webview'), `${d.title} has a browser`)
    assert.ok(kinds.includes('image'), `${d.title} has an image`)
    assert.ok(['diagram', 'calculator', 'custom-block'].filter((k) => kinds.includes(k)).length >= 2, `${d.title} advanced`)
  }
})

test('browsers store the plain canonical URL, never JSON', () => {
  for (const w of recs.widgets.filter((w) => w.kind === 'webview')) {
    assert.equal(new URL(w.content).toString(), w.content)
    assert.ok(w.width >= 1000 && w.height >= 600, 'set explicitly, not the 1920x1080 catalog default')
  }
})

test('images are inline JPEG data URLs titled as AI illustrations', () => {
  for (const w of recs.widgets.filter((w) => w.kind === 'image')) {
    assert.ok(w.content.startsWith('data:image/jpeg;base64,'))
    assert.ok(w.title.endsWith(lib.IMAGE_TITLE_SUFFIX), w.title)
  }
})

test('generated images on disk fit inside the public capture', () => {
  const dir = join(__dirname, 'images')
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jpg'))) {
    const bytes = fs.readFileSync(join(dir, f))
    assert.equal(bytes[0], 0xff, `${f} is a JPEG`)
    assert.equal(bytes[1], 0xd8, `${f} is a JPEG`)
    assert.ok(`data:image/jpeg;base64,${bytes.toString('base64')}`.length <= lib.MAX_IMAGE_DATA_URL, `${f} size`)
  }
})

test('task links point at the other desks in the same room, titled as their target', () => {
  const byId = new Map(recs.nodes.map((n) => [n.id, n]))
  const links = recs.widgets.filter((w) => w.kind === 'task-link')
  assert.ok(links.length > 0)
  for (const w of links) {
    const target = byId.get(w.content)
    const from = byId.get(w.task_id)
    assert.ok(target && target.kind === 'task', 'target is a desk')
    assert.notEqual(target.id, from.id, 'never links a desk to itself')
    assert.equal(target.parent_id, from.parent_id, 'same room')
    assert.equal(w.title, target.title)
  }
})

test('diagrams use the app shape node and only reference their own nodes', () => {
  for (const w of recs.widgets.filter((w) => w.kind === 'diagram')) {
    const g = JSON.parse(w.content)
    const ids = new Set(g.nodes.map((n) => n.id))
    for (const n of g.nodes) {
      assert.equal(n.type, 'shape')
      assert.match(n.data.color, /^#[0-9a-f]{6}$/)
    }
    for (const e of g.edges) assert.ok(ids.has(e.source) && ids.has(e.target))
  }
})

test('calculators show a number, never "error"', () => {
  for (const w of recs.widgets.filter((w) => w.kind === 'calculator')) assert.notEqual(lib.evalExpr(w.content), null, w.content)
})

test('form blocks are canonical and their fields do not overlap', () => {
  for (const w of recs.widgets.filter((w) => w.kind === 'custom-block')) {
    const c = JSON.parse(w.content)
    assert.deepEqual(Object.keys(c), ['title', 'fields'])
    assert.equal(JSON.stringify(c), w.content, 'byte-identical to what the widget would write back')
    for (let i = 0; i < c.fields.length; i++)
      for (let j = i + 1; j < c.fields.length; j++) {
        const a = c.fields[i]
        const b = c.fields[j]
        assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.label} overlaps ${b.label}`)
      }
    const maxY = Math.max(...c.fields.map((f) => f.y + f.h))
    assert.ok(w.height >= maxY + 70, 'tall enough that grow-to-fit does not rewrite it')
    for (const f of c.fields.filter((f) => f.type === 'date')) assert.match(f.value, /^\d{4}-\d{2}-\d{2}$/)
  }
})

// ── SQL write path, against a copy of a real workspace ──────────────────────
const LIVE = join(homedir(), 'Library', 'Application Support', 'focusbuddy', 'focusbuddy.db')
test('seeding is idempotent, trashes what the specs drop, and spares user rows', { skip: !fs.existsSync(LIVE) && 'no local workspace' }, () => {
  const { DatabaseSync } = require('node:sqlite')
  const dir = fs.mkdtempSync(join(tmpdir(), 'persona-demo-test-'))
  const copy = join(dir, 'w.db')
  const src = new DatabaseSync(LIVE, { readOnly: true })
  src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
  src.close()
  const db = new DatabaseSync(copy)
  db.exec('PRAGMA foreign_keys = ON')
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n
    // The copy may already hold an earlier seed (the live workspace does), so only
    // nodes not yet present count as new.
    const fresh = recs.nodes.filter((n) => !db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(n.id)).length
    const first = write(db, lib.buildRecords(ALL, { now: NOW, imageData: () => TINY }), NOW)
    const total = recs.nodes.length + recs.widgets.length + recs.tables.length + recs.rows.length
    assert.equal(first.inserted + first.updated, total)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, before + fresh)
    // Every seeded desk sits at the app's default importance, clear of the Pre-Task Bridge.
    for (const n of recs.nodes) assert.equal(db.prepare('SELECT importance FROM nodes WHERE id = ?').get(n.id).importance, 3)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])

    // A user adds their own widget to a seeded desk.
    const desk = recs.nodes.find((n) => n.kind === 'task' && n.parent_id !== recs.nodes[0].id)
    db.prepare(
      `INSERT INTO widgets (id, task_id, kind, title, content, created_at, updated_at) VALUES ('user-own-widget', ?, 'sticky', 'mine', 'mine', ?, ?)`
    ).run(desk.id, NOW, NOW)

    // Second run: nothing new, everything updated, nothing trashed.
    const second = write(db, lib.buildRecords(ALL, { now: NOW + 1000, imageData: () => TINY }), NOW + 1000)
    assert.deepEqual(second, { inserted: 0, updated: total, trashed: 0 })

    // Drop a desk's notes from the specs: exactly those widgets go to the trash.
    const trimmed = clone(ALL)
    const dropped = trimmed[0].desks[0].notes?.length ?? 0
    trimmed[0].desks[0].notes = []
    const third = write(db, lib.buildRecords(trimmed, { now: NOW + 2000, imageData: () => TINY }), NOW + 2000)
    assert.equal(third.trashed, dropped)
    assert.equal(db.prepare(`SELECT trashed_at FROM widgets WHERE id = 'user-own-widget'`).get().trashed_at, null)

    // Every seeded row is queued for sync.
    const dirty = db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE id = ? AND needs_sync = 1`).get(recs.nodes[0].id).n
    assert.equal(dirty, 1)

    // --remove trashes the whole tree.
    removeAll(db, NOW + 3000)
    const live = db
      .prepare(
        `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id)
         SELECT COUNT(*) AS n FROM nodes WHERE id IN (SELECT id FROM t) AND trashed_at IS NULL`
      )
      .get(recs.nodes[0].id).n
    assert.equal(live, 0)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
