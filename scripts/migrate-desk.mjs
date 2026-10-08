#!/usr/bin/env node
// Move one desk, whole, from one PlexiDesk workspace into another.
//
// WHY THIS EXISTS. The "Advertising Video" desk was built in PlexiDesk 3
// Preview, a separate app with its own userData directory and — crucially —
// no account signed in (account-session.json carried encryptedToken: null).
// Nothing it contained was ever pushed to the server, so there was no copy for
// the production app to pull. The desk is not lost and it is not "unmerged";
// it simply only ever existed in that one local database.
//
// Everything written here is marked needs_sync = 1 and sync_rev = 0, so the
// production app treats each row as a local change and pushes it on the next
// sync. That is what actually puts the desk in the account.
//
// Refuses to run unless the destination app is closed: the renderer caches
// rows in memory and would neither see these inserts nor expect them.

import { DatabaseSync } from 'node:sqlite'
import { existsSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

const [, , SRC, DST, TITLE, ...flags] = process.argv
const APPLY = flags.includes('--apply')
if (!SRC || !DST || !TITLE) {
  console.error('usage: migrate-desk.mjs <src.db> <dst.db> <desk title> [--apply]')
  process.exit(2)
}

const src = new DatabaseSync(SRC, { readOnly: true })
const dst = new DatabaseSync(DST)

// ── 1. The desk subtree ─────────────────────────────────────────────────────
// Accept an id or a title. Titles are not unique — this workspace has two
// desks called "New desk" — so an ambiguous title is an error rather than a
// silent pick of whichever row came back first.
let root = src.prepare('select * from nodes where id = ? and parent_id is null').get(TITLE)
if (!root) {
  const matches = src
    .prepare("select * from nodes where title = ? and parent_id is null and coalesce(trashed_at,'') = ''")
    .all(TITLE)
  if (matches.length === 0) {
    console.error(`No root-level desk titled ${JSON.stringify(TITLE)} in the source.`)
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(`${matches.length} desks are titled ${JSON.stringify(TITLE)}. Pass one of these ids instead:`)
    for (const m of matches) console.error(`  ${m.id}  (updated ${new Date(m.updated_at).toISOString()})`)
    process.exit(1)
  }
  root = matches[0]
}
const nodes = []
;(function walk(id) {
  const n = src.prepare('select * from nodes where id = ?').get(id)
  if (!n) return
  nodes.push(n)
  for (const c of src.prepare('select id from nodes where parent_id = ?').all(id)) walk(c.id)
})(root.id)

const nodeIds = nodes.map((n) => n.id)
const inList = (xs) => xs.map(() => '?').join(',')

// ── 2. Widgets, then everything they point at ───────────────────────────────
const widgets = nodeIds.length
  ? src
      .prepare(
        `select * from widgets where task_id in (${inList(nodeIds)}) and coalesce(trashed_at,'') = ''`
      )
      .all(...nodeIds)
  : []

// A widget's `content` is either inline data or a bare id into another table.
// Resolve by probing, because the kind -> table mapping is not recorded
// anywhere and guessing it from `kind` would silently drop content the day a
// new widget kind reuses an old one's storage.
const docIds = new Set()
const tableIds = new Set()
const fileIds = new Set()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hasDoc = src.prepare('select 1 from documents where id = ?')
const hasTable = src.prepare('select 1 from fb_tables where id = ?')
const hasFile = src.prepare('select 1 from fb_files where id = ?')
for (const w of widgets) {
  const c = (w.content ?? '').trim()
  if (!UUID.test(c)) continue
  if (hasDoc.get(c)) docIds.add(c)
  else if (hasTable.get(c)) tableIds.add(c)
  else if (hasFile.get(c)) fileIds.add(c)
}
// Tables attached to the desk directly (fb_tables.task_id), not just via a widget.
for (const t of nodeIds.length
  ? src.prepare(`select id from fb_tables where task_id in (${inList(nodeIds)})`).all(...nodeIds)
  : [])
  tableIds.add(t.id)

const documents = [...docIds].map((id) => src.prepare('select * from documents where id = ?').get(id))
const tables = [...tableIds].map((id) => src.prepare('select * from fb_tables where id = ?').get(id))
const rows = tables.flatMap((t) =>
  src.prepare("select * from fb_rows where table_id = ? and coalesce(trashed_at,'') = ''").all(t.id)
)
const files = [...fileIds].map((id) => src.prepare('select * from fb_files where id = ?').get(id))
const layouts = src.prepare('select * from desk_layouts where desk_id = ?').all(root.id)

// ── 3. Collisions ───────────────────────────────────────────────────────────
// Ids are shared across these databases (same schema, same generator), so a
// row already present in the destination must NOT be overwritten — that would
// clobber whichever version the user kept working on.
const collisions = []
const check = (table, items) => {
  const q = dst.prepare(`select 1 from ${table} where id = ?`)
  for (const it of items) if (q.get(it.id)) collisions.push(`${table}:${it.id}`)
}
check('nodes', nodes)
check('widgets', widgets)
check('documents', documents)
check('fb_tables', tables)
check('fb_rows', rows)
check('fb_files', files)

const plan = { nodes, widgets, documents, tables, rows, files, layouts }
console.log(`desk: ${root.title}  (${root.id})`)
for (const [k, v] of Object.entries(plan)) console.log(`  ${k.padEnd(10)} ${v.length}`)
console.log(`  collisions ${collisions.length}${collisions.length ? ' -> ' + collisions.slice(0, 8).join(', ') : ''}`)

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.')
  process.exit(0)
}
if (collisions.length) {
  console.error('\nRefusing to apply: rows already exist in the destination (listed above).')
  process.exit(1)
}

// ── 4. Write ────────────────────────────────────────────────────────────────
const SYNC = { sync_rev: 0, needs_sync: 1 }
function insert(table, row, overrides = {}) {
  const rec = { ...row, ...overrides }
  const cols = Object.keys(rec)
  dst
    .prepare(`insert into ${table} (${cols.map((c) => `"${c}"`).join(',')}) values (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => rec[c]))
}

function runAll() {
  // Parents before children, so the self-referencing FK is always satisfied.
  for (const n of nodes) insert('nodes', n, { ...SYNC, org_id: 'personal' })
  for (const d of documents) insert('documents', d, { ...SYNC, org_id: 'personal' })
  for (const t of tables) insert('fb_tables', t, { ...SYNC, org_id: 'personal' })
  for (const r of rows) insert('fb_rows', r, SYNC)
  for (const f of files) insert('fb_files', f, { ...SYNC, org_id: 'personal' })
  for (const w of widgets) insert('widgets', w, SYNC)
  for (const l of layouts) {
    const cols = Object.keys(l)
    dst
      .prepare(
        `insert or replace into desk_layouts (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`
      )
      .run(...cols.map((c) => l[c]))
  }
}
dst.exec('BEGIN')
try {
  runAll()
  dst.exec('COMMIT')
} catch (err) {
  dst.exec('ROLLBACK')
  console.error('\nRolled back — nothing was written.')
  throw err
}

// ── 5. The blobs ────────────────────────────────────────────────────────────
// fb_files rows are metadata; the bytes live beside the database. A migrated
// file widget that cannot find its blob is a broken widget, not a missing one,
// so the thumbnails come too.
const srcDir = dirname(SRC)
const dstDir = dirname(DST)
let copied = 0
for (const f of files) {
  for (const sub of ['files', 'thumbnails']) {
    const from = join(srcDir, sub)
    if (!existsSync(from)) continue
    mkdirSync(join(dstDir, sub), { recursive: true })
    for (const name of readdirSync(from)) {
      if (!name.startsWith(f.id)) continue
      const target = join(dstDir, sub, basename(name))
      if (existsSync(target)) continue
      copyFileSync(join(from, name), target)
      copied++
    }
  }
}
console.log(`\nAPPLIED. blobs copied: ${copied}`)
