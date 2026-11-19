// A write that arrived over the CRDT channel never re-pushes (4.3.51).
//
// The CRDT engine applies other devices' events through the same IPC writes a
// person's edit uses, and those mark the row dirty (new rows default needs_sync = 1;
// the *_mark_dirty triggers flag a clean row on any content update). The poll then
// pushed replayed rows back, and up to 4.3.50 that force-wrote old state over live
// rows, brought tombstones back and deleted desks restored with Undo (2026-11-19).
// asSyncApply / byOrigin('sync') leave every row a write touched exactly as clean
// as it found it. This runs the desktop's own schema, migrations, triggers and
// write functions (SQLite-WASM, as applyRemoteOrdering.test.ts does).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'sync-apply@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

const { asSyncApply, byOrigin, collectPending } = await import('../../src/main/db/workspaceSync')
const { createNode, updateNode, deleteNode, restoreNodes } = await import('../../src/main/db/nodes')
const { createWidget, updateWidget, deleteWidget, restoreWidget } = await import('../../src/main/db/widgets')

beforeAll(async () => {
  await initSqlite()
})
beforeEach(async () => {
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
})

const flags = (table: 'nodes' | 'widgets', id: string): { needs_sync: number; sync_rev: number | null } =>
  db.prepare(`SELECT needs_sync, sync_rev FROM ${table} WHERE id = ?`).get(id) as never
// What the poll would push: a row pulled from the server, clean at rev 3.
function pulledDesk(id: string): void {
  createNode({ id, parentId: null, kind: 'task', title: id } as never)
  db.prepare('UPDATE nodes SET needs_sync = 0, sync_rev = 3 WHERE id = ?').run(id)
}
function pulledWidget(id: string, taskId: string): void {
  createWidget({ id, taskId, kind: 'sticky', content: 'x', x: 0, y: 0, width: 10, height: 10 } as never)
  db.prepare('UPDATE widgets SET needs_sync = 0, sync_rev = 2 WHERE id = ?').run(id)
}

describe('a CRDT-channel write leaves rows as clean as it found them', () => {
  it('a create made by sync is clean; the same create by a person is dirty (control)', () => {
    asSyncApply(() => createNode({ id: 'from-sync', parentId: null, kind: 'task', title: 'A' } as never))
    createNode({ id: 'by-person', parentId: null, kind: 'task', title: 'B' } as never)
    expect(flags('nodes', 'from-sync').needs_sync).toBe(0)
    expect(flags('nodes', 'by-person').needs_sync).toBe(1)
  })

  it('an update made by sync keeps a clean row clean and its rev as pulled', () => {
    pulledDesk('d1')
    pulledWidget('w1', 'd1')
    byOrigin('sync', () => updateNode('d1', { title: 'renamed elsewhere' } as never))
    byOrigin('sync', () => updateWidget('w1', { content: 'edited elsewhere' } as never))
    expect(flags('nodes', 'd1')).toEqual({ needs_sync: 0, sync_rev: 3 })
    expect(flags('widgets', 'w1')).toEqual({ needs_sync: 0, sync_rev: 2 })
    // Control: the person's own edit is still pushed.
    byOrigin(undefined, () => updateNode('d1', { title: 'renamed here' } as never))
    expect(flags('nodes', 'd1').needs_sync).toBe(1)
  })

  it('a row already dirty from a local edit stays dirty, so that edit still goes up', () => {
    pulledDesk('d1')
    updateNode('d1', { title: 'my unpushed edit' } as never)
    expect(flags('nodes', 'd1').needs_sync).toBe(1)
    asSyncApply(() => updateNode('d1', { description: 'from another device' } as never))
    expect(flags('nodes', 'd1').needs_sync).toBe(1)
  })

  it('a sync delete of a desk leaves the desk AND the widgets its cascade trashed clean: nothing to push', () => {
    pulledDesk('d1')
    pulledWidget('w1', 'd1')
    pulledWidget('w2', 'd1')
    const removed = asSyncApply(() => deleteNode('d1'))
    expect(removed).toContain('d1')
    expect(flags('nodes', 'd1').needs_sync).toBe(0)
    expect(flags('widgets', 'w1').needs_sync).toBe(0)
    expect(flags('widgets', 'w2').needs_sync).toBe(0)
    const pending = collectPending()
    expect([...pending.upserts, ...pending.deletes].map((p) => p.id)).toEqual([])
  })

  it('without the sync origin the same delete IS pushed (what 4.3.50 did with a replayed delete)', () => {
    pulledDesk('d1')
    deleteNode('d1')
    expect(collectPending().deletes.map((p) => p.id)).toContain('d1')
  })
})

describe('a restore is a change: it stamps updated_at', () => {
  it('restoreNodes and restoreWidget move updated_at past the delete', () => {
    pulledDesk('d1')
    pulledWidget('w1', 'd1')
    db.prepare('UPDATE nodes SET updated_at = 1000 WHERE id = ?').run('d1')
    db.prepare('UPDATE widgets SET updated_at = 1000 WHERE id = ?').run('w1')
    deleteWidget('w1')
    deleteNode('d1')
    const before = Date.now()
    restoreNodes(['d1'])
    restoreWidget('w1')
    const n = db.prepare('SELECT trashed_at, updated_at FROM nodes WHERE id = ?').get('d1') as { trashed_at: number | null; updated_at: number }
    const w = db.prepare('SELECT trashed_at, updated_at FROM widgets WHERE id = ?').get('w1') as { trashed_at: number | null; updated_at: number }
    expect(n.trashed_at).toBeNull()
    expect(w.trashed_at).toBeNull()
    expect(n.updated_at).toBeGreaterThanOrEqual(before)
    expect(w.updated_at).toBeGreaterThanOrEqual(before)
  })
})
