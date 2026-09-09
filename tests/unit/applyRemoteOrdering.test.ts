// Applying a whole workspace into an empty database, which is what signing in
// on the web does.
//
// The personal apply arm sorted a pulled batch by item TYPE -- nodes before
// widgets -- but not by ancestry, and nodes.parent_id points back into nodes.
// A desktop never noticed: it is applying its own workspace and already has
// every parent on disk. A browser signs in against an empty database and pulls
// everything in one unordered batch, so a Desk routinely arrived before the Room
// containing it, violated the foreign key, and was dropped. The cursor then
// advanced past the batch, so the row was never offered again -- the workspace
// was quietly missing pieces, with nothing to say so.
//
// The engine is SQLite-WASM because better-sqlite3 is built for Electron's ABI;
// the schema, the migrations and applyRemote are the desktop's own.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'ordering@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

type Apply = typeof import('../../src/main/db/workspaceSync')['applyRemote']
let applyRemote: Apply

const node = (id: string, parentId: string | null, title: string) => ({
  id,
  itemType: 'node' as const,
  rev: 1,
  deleted: false,
  body: {
    id,
    parent_id: parentId,
    kind: 'folder',
    title,
    description: '',
    status: 'open',
    priority: 3,
    interest: 3,
    importance: 3,
    sort_order: 0,
    created_at: 1,
    updated_at: 1
  }
})

beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  ;({ applyRemote } = await import('../../src/main/db/workspaceSync'))
})

describe('applying a batch whose children arrive before their parents', () => {
  it('lands every node, however the batch is ordered', () => {
    // Deliberately worst-case: deepest first, exactly what an unordered pull of
    // a nested workspace produces.
    const res = applyRemote([
      node('grandchild', 'child', 'Q3 plan'),
      node('child', 'root', 'Planning'),
      node('root', null, 'Work')
    ])
    expect(res.failed).toBe(0)
    expect(res.applied).toBe(3)
    const rows = db.prepare('SELECT id, parent_id FROM nodes ORDER BY id').all() as Array<{
      id: string
      parent_id: string | null
    }>
    expect(rows.map((r) => r.id)).toEqual(['child', 'grandchild', 'root'])
    // The tree is intact, not merely present.
    expect(rows.find((r) => r.id === 'grandchild')?.parent_id).toBe('child')
    expect(rows.find((r) => r.id === 'child')?.parent_id).toBe('root')
  })

  it('handles several unrelated trees interleaved in one batch', () => {
    const res = applyRemote([
      node('b-leaf', 'b-root', 'B leaf'),
      node('a-leaf', 'a-root', 'A leaf'),
      node('b-root', null, 'B'),
      node('a-root', null, 'A')
    ])
    expect(res.failed).toBe(0)
    expect(res.applied).toBe(4)
  })

  it('reports a genuine orphan instead of silently dropping it', () => {
    // A child whose parent is neither in the batch nor in the database cannot
    // land. What matters is that the caller is TOLD, because that is what stops
    // its cursor advancing past a row it never received.
    const res = applyRemote([node('orphan', 'nowhere', 'Orphan')])
    expect(res.applied).toBe(0)
    expect(res.failed).toBe(1)
    expect(db.prepare("SELECT 1 FROM nodes WHERE id = 'orphan'").get()).toBeUndefined()
  })

  it('lands the orphan once its parent turns up in a later batch', () => {
    applyRemote([node('nowhere', null, 'Found it')])
    const res = applyRemote([node('orphan', 'nowhere', 'Orphan')])
    expect(res.failed).toBe(0)
    expect(res.applied).toBe(1)
    expect(db.prepare("SELECT parent_id FROM nodes WHERE id = 'orphan'").get()).toEqual({
      parent_id: 'nowhere'
    })
  })
})
