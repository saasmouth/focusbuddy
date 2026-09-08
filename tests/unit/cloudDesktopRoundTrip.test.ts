// The cloud runtime's acceptance test: work created in a browser must arrive on
// the desktop as real rows, with nothing dropped on the way.
//
// The payload in tests/fixtures/cloudRoundTripItems.json is not written by
// hand. It is what the live Signal server returned from /workspace/sync after a
// browser tab -- the WebAssembly data layer, driven through the app's own UI
// and its own sync loop -- created a desk and two widgets and pushed them. This
// test feeds that recorded payload to the desktop's real applyRemote, against a
// real SQLite database built by the real migrations, and checks what lands.
//
// The interesting assertions are the column ones. applyRemote writes the
// intersection of the body and the local table, so a browser whose schema was
// narrower than the desktop's would sync successfully and silently lose every
// column it did not have -- no error, no warning, just widgets that forget they
// were pinned and deletions that do not stick. Asserting on trashed_at,
// archived, pinned and org_id is asserting that the two runtimes really do
// build the same database, which is only true because both call
// applySchemaAndMigrations rather than exec(SCHEMA) alone.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

// The engine is SQLite-WASM rather than better-sqlite3, because better-sqlite3
// is compiled against Electron's ABI and plain Node will not load it. That
// changes the bindings, not the database: the SQL executed below is the
// desktop's schema, its migrations and its applyRemote, unmodified.
let db: SqliteDb

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))

// The Worker-side session module is irrelevant here; the desktop's reads the
// account off disk, which a unit test has no business touching.
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'roundtrip@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

interface RecordedItem {
  id: string
  itemType: 'node' | 'widget'
  body: Record<string, unknown>
  rev: number
}

const recorded = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/cloudRoundTripItems.json'), 'utf-8')
) as RecordedItem[]

const deskId = recorded.find((i) => i.itemType === 'node')!.id
const widgetIds = recorded.filter((i) => i.itemType === 'widget').map((i) => i.id)

let applied = 0
let applyRemote: typeof import('../../src/main/db/workspaceSync')['applyRemote']

beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db)
  ;({ applyRemote } = await import('../../src/main/db/workspaceSync'))
  applied = applyRemote(recorded.map((i) => ({ ...i, deleted: false }))).applied
})

describe('a desk created in the browser, applied by the desktop', () => {
  it('applies every item the server returned', () => {
    expect(applied).toBe(recorded.length)
  })

  it('materialises the desk with the title typed in the browser', () => {
    const row = db.prepare('SELECT id, title, kind, parent_id FROM nodes WHERE id = ?').get(deskId) as
      | { id: string; title: string; kind: string; parent_id: string | null }
      | undefined
    expect(row).toBeDefined()
    expect(row!.title).toBe('Cloud round-trip desk')
    expect(row!.kind).toBe('folder')
    expect(row!.parent_id).toBeNull()
  })

  it('materialises both widgets, attached to that desk, with their content intact', () => {
    const rows = db
      .prepare('SELECT id, task_id, kind, title, content, x, y FROM widgets WHERE task_id = ? ORDER BY x')
      .all(deskId) as Array<{ id: string; task_id: string; kind: string; title: string; content: string; x: number }>
    expect(rows.map((r) => r.id).sort()).toEqual([...widgetIds].sort())
    expect(rows[0].kind).toBe('sticky')
    expect(rows[0].title).toBe('Written in the browser')
    expect(rows[0].content).toContain('created in a browser tab')
    expect(rows[1].kind).toBe('markdown')
    expect(rows[1].content).toContain('# Round trip')
  })

  it('carries the migration-added columns, not just the ones in SCHEMA', () => {
    // These four exist only because of ensureColumn calls that run after
    // db.exec(SCHEMA). If the browser had built its database from SCHEMA alone,
    // they would be absent from the body and silently skipped here.
    const w = db
      .prepare('SELECT trashed_at, archived, pinned, status FROM widgets WHERE id = ?')
      .get(widgetIds[0]) as { trashed_at: number | null; archived: number; pinned: number; status: string | null }
    expect(w.trashed_at).toBeNull()
    expect(w.archived).toBe(0)
    expect(w.pinned).toBe(0)

    const n = db.prepare('SELECT org_id, archived, is_plan FROM nodes WHERE id = ?').get(deskId) as {
      org_id: string
      archived: number
      is_plan: number
    }
    expect(n.org_id).toBe('personal')
    expect(n.archived).toBe(0)
    expect(n.is_plan).toBe(0)
  })

  it('marks what it applied as clean at the server revision, so it is not pushed back', () => {
    // The echo that this prevents was a real, measured bug: rows re-pushed every
    // cycle reached sync_rev 7,319 before it was found.
    const rows = db.prepare('SELECT sync_rev, needs_sync FROM widgets WHERE task_id = ?').all(deskId) as Array<{
      sync_rev: number
      needs_sync: number
    }>
    for (const r of rows) {
      expect(r.needs_sync).toBe(0)
      expect(r.sync_rev).toBe(1)
    }
  })

  it('is idempotent: applying the same payload again changes nothing', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM widgets').get() as { n: number }
    // Re-applying an already-held revision must be skipped, not rewritten --
    // a no-op UPDATE is what the dirty-marking trigger fires on.
    const again = applyRemote(recorded.map((i) => ({ ...i, deleted: false }))).applied
    const after = db.prepare('SELECT COUNT(*) AS n FROM widgets').get() as { n: number }
    expect(again).toBe(0)
    expect(after.n).toBe(before.n)
  })
})
