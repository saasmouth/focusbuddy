#!/usr/bin/env node
// Seed the persona demo rooms into a PlexiDesk workspace.
//
// One top-level Room, "Plexii Showcase · Persona demos", holding a Start-here desk
// and one Room per target persona (personas/*.json), each with worked example
// desks. Built for sharing with prospects, and SAMPLE DATA throughout: the notice
// is written into every room description, desk description and desk brief.
//
// Usage
//   node scripts/persona-demos/seed.cjs --check [files…]   validate specs, write nothing
//   node scripts/persona-demos/seed.cjs --dry-run           build + write into a temp copy of the DB
//   node scripts/persona-demos/seed.cjs                     seed the main workspace (app must be quit)
//   node scripts/persona-demos/seed.cjs --remove            trash everything this script seeded
//   --profile <dir name>   another workspace under ~/Library/Application Support (default: focusbuddy)
//   --db <path>            an explicit database file
//
// Safe to re-run. Ids are deterministic, so a re-seed updates the same rows in
// place; anything the specs no longer describe is moved to the trash rather than
// hard-deleted, so the removal syncs to the account like any user deletion.
// Every write is marked needs_sync = 1 and keeps its sync_rev, which is exactly
// what a local edit looks like to workspace sync. The database is backed up
// before the first write, and the script refuses to run while any process has
// the database open.

const { DatabaseSync } = require('node:sqlite')
const { homedir, tmpdir } = require('node:os')
const { join, basename } = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const lib = require('./lib.cjs')

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const PERSONA_DIR = join(__dirname, 'personas')
const IMAGE_DIR = join(__dirname, 'images')

// Generated images become inline data: URLs (lib.cjs explains why). A missing or
// oversized file stops the seed rather than writing an empty picture.
function imageData(file) {
  const path = join(IMAGE_DIR, file)
  if (!fs.existsSync(path)) throw new Error(`image ${file} has not been generated — run generate-images.cjs`)
  const url = `data:image/jpeg;base64,${fs.readFileSync(path).toString('base64')}`
  if (url.length > lib.MAX_IMAGE_DATA_URL) throw new Error(`image ${file} is ${url.length} chars as a data URL; limit ${lib.MAX_IMAGE_DATA_URL}`)
  return url
}

function missingImages(specs) {
  const missing = []
  for (const s of specs)
    s.desks.forEach((d, di) => (d.images ?? []).forEach((im, ii) => {
      const f = lib.imageFile(s, di, ii, im)
      if (!fs.existsSync(join(IMAGE_DIR, f))) missing.push(f)
    }))
  return missing
}

function loadSpecs(files) {
  const paths = files.length
    ? files
    : fs.readdirSync(PERSONA_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => join(PERSONA_DIR, f))
  const specs = []
  const errors = []
  for (const p of paths) {
    let spec
    try {
      spec = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (e) {
      errors.push(`${basename(p)}: invalid JSON — ${e.message}`)
      continue
    }
    const errs = lib.validateSpec(spec, basename(p))
    errors.push(...errs)
    spec.__file = basename(p)
    specs.push(spec)
  }
  errors.push(...lib.validateSet(specs))
  return { specs, errors }
}

function openHolders(dbPath) {
  try {
    return execFileSync('lsof', ['-t', '--', dbPath], { encoding: 'utf8' }).trim()
  } catch {
    return '' // lsof exits 1 when nothing holds the file
  }
}

// ── write ───────────────────────────────────────────────────────────────────
function write(db, recs, now) {
  const rootId = recs.nodes[0].id
  const has = (table, id) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)
  const counts = { inserted: 0, updated: 0, trashed: 0 }

  // Everything currently under the root, so stale rows can be trashed afterwards.
  const priorNodes = db
    .prepare(
      `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id)
       SELECT id FROM t`
    )
    .all(rootId)
    .map((r) => r.id)
    .filter((id) => has('nodes', id))
  const inList = (ids) => ids.map(() => '?').join(',') || "''"
  const priorWidgets = priorNodes.length
    ? db.prepare(`SELECT id FROM widgets WHERE task_id IN (${inList(priorNodes)})`).all(...priorNodes).map((r) => r.id)
    : []
  const priorTables = priorNodes.length
    ? db.prepare(`SELECT id FROM fb_tables WHERE task_id IN (${inList(priorNodes)})`).all(...priorNodes).map((r) => r.id)
    : []
  const priorRows = priorTables.length
    ? db.prepare(`SELECT id FROM fb_rows WHERE table_id IN (${inList(priorTables)})`).all(...priorTables).map((r) => r.id)
    : []

  // The root keeps wherever the user has dragged it; on first creation it goes
  // to the top of the room list.
  const root = recs.nodes[0]
  if (!has('nodes', root.id)) {
    const min = db.prepare(`SELECT MIN(sort_order) AS m FROM nodes WHERE parent_id IS NULL`).get().m ?? 0
    root.sort_order = min - 1
  }

  // Importance stays at the app default of 3: at 4 or more every open desk is an
  // "avoidance" task and opens behind the Pre-Task Bridge modal (PreTaskBridge.tsx),
  // which would interrupt every demo and every recording.
  const upsertNode = (n) => {
    if (has('nodes', n.id)) {
      db.prepare(
        `UPDATE nodes SET parent_id = ?, kind = ?, title = ?, description = ?,
           ${n.sort_order === null ? '' : 'sort_order = ?,'} updated_at = ?, due_date = ?,
           interest = 4, importance = 3, trashed_at = NULL, archived = 0, needs_sync = 1
         WHERE id = ?`
      ).run(
        ...[n.parent_id, n.kind, n.title, n.description],
        ...(n.sort_order === null ? [] : [n.sort_order]),
        n.updated_at,
        n.due_date,
        n.id
      )
      counts.updated++
    } else {
      db.prepare(
        `INSERT INTO nodes (id, parent_id, kind, title, description, status, priority, interest, importance,
                            sort_order, created_at, updated_at, due_date, org_id, sync_rev, needs_sync)
         VALUES (?, ?, ?, ?, ?, 'open', 3, 4, 3, ?, ?, ?, ?, 'personal', 0, 1)`
      ).run(n.id, n.parent_id, n.kind, n.title, n.description, n.sort_order ?? 0, n.created_at, n.updated_at, n.due_date)
      counts.inserted++
    }
  }
  // Parents before children so the foreign key holds at every step.
  for (const n of recs.nodes) upsertNode(n)

  for (const t of recs.tables) {
    if (has('fb_tables', t.id)) {
      db.prepare(
        `UPDATE fb_tables SET task_id = ?, title = ?, schema_json = ?, updated_at = ?, trashed_at = NULL, needs_sync = 1 WHERE id = ?`
      ).run(t.task_id, t.title, t.schema_json, t.updated_at, t.id)
      counts.updated++
    } else {
      db.prepare(
        `INSERT INTO fb_tables (id, task_id, title, schema_json, created_at, updated_at, org_id, sync_rev, needs_sync)
         VALUES (?, ?, ?, ?, ?, ?, 'personal', 0, 1)`
      ).run(t.id, t.task_id, t.title, t.schema_json, t.created_at, t.updated_at)
      counts.inserted++
    }
  }
  for (const r of recs.rows) {
    if (has('fb_rows', r.id)) {
      db.prepare(
        `UPDATE fb_rows SET table_id = ?, cells_json = ?, sort_order = ?, updated_at = ?, trashed_at = NULL, needs_sync = 1 WHERE id = ?`
      ).run(r.table_id, r.cells_json, r.sort_order, r.updated_at, r.id)
      counts.updated++
    } else {
      db.prepare(
        `INSERT INTO fb_rows (id, table_id, cells_json, sort_order, created_at, updated_at, sync_rev, needs_sync)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1)`
      ).run(r.id, r.table_id, r.cells_json, r.sort_order, r.created_at, r.updated_at)
      counts.inserted++
    }
  }
  for (const w of recs.widgets) {
    if (has('widgets', w.id)) {
      db.prepare(
        `UPDATE widgets SET task_id = ?, kind = ?, title = ?, content = ?, x = ?, y = ?, width = ?, height = ?,
           z_index = ?, color = ?, updated_at = ?, trashed_at = NULL, archived = 0, needs_sync = 1
         WHERE id = ?`
      ).run(w.task_id, w.kind, w.title, w.content, Math.round(w.x), Math.round(w.y), Math.round(w.width), Math.round(w.height), w.z_index, w.color, w.updated_at, w.id)
      counts.updated++
    } else {
      db.prepare(
        `INSERT INTO widgets (id, task_id, kind, title, content, x, y, width, height, z_index, color, created_at, updated_at, sync_rev, needs_sync)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`
      ).run(w.id, w.task_id, w.kind, w.title, w.content, Math.round(w.x), Math.round(w.y), Math.round(w.width), Math.round(w.height), w.z_index, w.color, w.created_at, w.updated_at)
      counts.inserted++
    }
  }

  // Trash whatever was seeded before and is no longer described. Only rows that
  // were found under the seeded root are candidates, so nothing the user made
  // elsewhere can be touched — but a desk the user added INSIDE a demo room is
  // also under the root, so user-made nodes are spared: only ids this script
  // could have generated are trashed.
  const generated = new Set([...recs.nodes, ...recs.widgets, ...recs.tables, ...recs.rows].map((r) => r.id))
  const ours = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
  const trash = (table, ids) => {
    for (const id of ids) {
      if (generated.has(id) || !ours(id)) continue
      const r = db.prepare(`UPDATE ${table} SET trashed_at = ?, needs_sync = 1 WHERE id = ? AND trashed_at IS NULL`).run(now, id)
      counts.trashed += Number(r.changes)
    }
  }
  trash('widgets', priorWidgets)
  trash('fb_rows', priorRows)
  trash('fb_tables', priorTables)
  trash('nodes', priorNodes)
  return counts
}

function removeAll(db, now) {
  const rootId = lib.stableId('root')
  const nodes = db
    .prepare(
      `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id) SELECT id FROM t`
    )
    .all(rootId)
    .map((r) => r.id)
  let n = 0
  for (const id of nodes) {
    n += Number(db.prepare(`UPDATE nodes SET trashed_at = ?, needs_sync = 1 WHERE id = ? AND trashed_at IS NULL`).run(now, id).changes)
    n += Number(db.prepare(`UPDATE widgets SET trashed_at = ?, needs_sync = 1 WHERE task_id = ? AND trashed_at IS NULL`).run(now, id).changes)
  }
  return n
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const files = args.filter((a) => a.endsWith('.json'))
  const { specs, errors } = loadSpecs(files)
  if (errors.length) {
    console.error(`✗ ${errors.length} problem(s):\n  ${errors.join('\n  ')}`)
    process.exit(1)
  }
  if (flag('--check')) {
    const desks = specs.reduce((n, s) => n + s.desks.length, 0)
    console.log(`✓ ${specs.length} persona spec(s) valid — ${desks} desks`)
    const missing = missingImages(specs)
    if (missing.length) console.log(`  ${missing.length} image(s) not generated yet — run generate-images.cjs before seeding`)
    return
  }

  const profile = opt('--profile') ?? 'focusbuddy'
  const live = opt('--db') ?? join(homedir(), 'Library', 'Application Support', profile, 'focusbuddy.db')
  if (!fs.existsSync(live)) {
    console.error(`No database at ${live}`)
    process.exit(2)
  }

  let target = live
  if (flag('--dry-run')) {
    // A real write, against a throwaway copy: proves the SQL against the actual
    // schema without touching the workspace. VACUUM INTO folds the WAL in.
    target = join(fs.mkdtempSync(join(tmpdir(), 'persona-demo-')), 'focusbuddy.db')
    const src = new DatabaseSync(live, { readOnly: true })
    src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    src.close()
  } else {
    const holders = openHolders(live)
    if (holders) {
      console.error(`The database is open in process(es) ${holders.split('\n').join(', ')}.\nQuit PlexiDesk first, then re-run.`)
      process.exit(3)
    }
    const dir = join(live, '..', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const backup = join(dir, `pre-persona-demos-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
    const src = new DatabaseSync(live, { readOnly: true })
    src.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
    src.close()
    console.log(`backup     ${backup}`)
  }

  const now = Date.now()
  const db = new DatabaseSync(target)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('BEGIN')
  try {
    if (flag('--remove')) {
      const n = removeAll(db, now)
      db.exec('COMMIT')
      console.log(`trashed    ${n} rows`)
      return
    }
    const recs = lib.buildRecords(specs, { now, imageData })
    const counts = write(db, recs, now)
    const fk = db.prepare('PRAGMA foreign_key_check').all()
    if (fk.length) throw new Error(`foreign key violations: ${JSON.stringify(fk.slice(0, 5))}`)
    db.exec('COMMIT')
    console.log(`${flag('--dry-run') ? 'dry run   ' : 'seeded    '} ${target}`)
    console.log(`rooms      ${recs.nodes.filter((n) => n.kind === 'folder').length} (1 showcase + ${specs.length} persona)`)
    console.log(`desks      ${recs.nodes.filter((n) => n.kind === 'task').length}`)
    console.log(`widgets    ${recs.widgets.length}`)
    console.log(`tables     ${recs.tables.length} (${recs.rows.length} rows)`)
    console.log(`changes    ${counts.inserted} inserted · ${counts.updated} updated · ${counts.trashed} trashed`)
  } catch (e) {
    db.exec('ROLLBACK')
    console.error(`✗ rolled back: ${e.message}`)
    process.exit(4)
  } finally {
    db.close()
  }
}

if (require.main === module) main()

module.exports = { write, removeAll, loadSpecs, imageData, missingImages, IMAGE_DIR }
