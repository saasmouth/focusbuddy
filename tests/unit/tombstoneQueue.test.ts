// A hard delete still deletes on the server (4.3.55).
//
// The owner's rule (24 Nov 2026): what you delete is erased from our server 30
// days after you delete it, and the signal counts from its tombstone. A soft
// delete pushes its tombstone on the next sync cycle. A HARD delete removed the
// row before that could happen, so the server item stayed live, content and all,
// for ever, and a new device's pull brought it back:
//
//   - "Delete permanently" on a desk (live, or trashed before its delete went up),
//     and the widgets that go with it by cascade;
//   - the Trash ageing out on a device that was offline, or set to keep its
//     workspace local, for longer than the Trash keeps things; and a desk's
//     cascaded widgets, which were never tombstoned at all;
//   - Drive "Delete forever", an org document's purge, the AI's undo.
//
// Each of those now queues a tombstone, ids and revs only, never content, for
// every row the server still holds live (sync_rev > 0, and not a pushed trash).
// The next sync sends it with its base rev, so a server copy restored or edited
// elsewhere since answers 409 and wins. markPushed clears it; a pull of the item
// at a newer rev clears it (and the item comes back); a pull at the same rev never
// resurrects the row. Personal entries go only on the personal loop, so a device
// set to keep its workspace local sends them only once sync is on. Pruning a
// shared desk you lost access to queues nothing: that is not your delete.
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
  accountEmail: () => 'tombstones@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

const sync = await import('../../src/main/db/workspaceSync')
const { createNode, deleteNode, deleteNodePermanent, purgeTrashedNodes } = await import('../../src/main/db/nodes')
const { createWidget, deleteWidget, purgeTrashedWidgets } = await import('../../src/main/db/widgets')
const { createFolder, deleteEntry, purgeEntry, purgeOldTrash } = await import('../../src/main/db/files')
const { createDocument, trashDocument, deleteDocument } = await import('../../src/main/db/documents')

const DAY = 24 * 60 * 60 * 1000
beforeAll(async () => {
  await initSqlite()
})
beforeEach(async () => {
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
})

type Table = 'nodes' | 'widgets' | 'documents' | 'fb_files'
// As the poll leaves a row: on the server at `rev`, clean.
const synced = (table: Table, id: string, rev: number): void => {
  db.prepare(`UPDATE ${table} SET sync_rev = ?, needs_sync = 0 WHERE id = ?`).run(rev, id)
}
const queued = (): Array<Record<string, unknown>> =>
  db.prepare('SELECT * FROM pending_tombstones ORDER BY item_type, id').all() as never
const deletes = (): Array<{ id: string; itemType: string; baseRev: number }> =>
  sync.collectPending().deletes.map(({ id, itemType, baseRev }) => ({ id, itemType, baseRev }))

function desk(id: string, rev = 3, widgetRev = 2): void {
  createNode({ id, parentId: null, kind: 'task', title: `Desk ${id}` } as never)
  synced('nodes', id, rev)
  createWidget({ id: `${id}-w`, taskId: id, kind: 'sticky', title: 'Notes', content: 'secret words', x: 0, y: 0, width: 1, height: 1 } as never)
  synced('widgets', `${id}-w`, widgetRev)
}

describe('"Delete permanently" tombstones on the server', () => {
  it('a live desk: the desk and its widgets are queued at their revs, ids only; the rows are gone here', () => {
    desk('d1')
    deleteNodePermanent('d1')
    expect(db.prepare("SELECT COUNT(*) n FROM nodes WHERE id = 'd1'").get()).toEqual({ n: 0 })
    expect(deletes()).toEqual(
      expect.arrayContaining([
        { id: 'd1', itemType: 'node', baseRev: 3 },
        { id: 'd1-w', itemType: 'widget', baseRev: 2 }
      ])
    )
    // Never content: the queue holds no title, body or anything a person wrote.
    expect(JSON.stringify(queued())).not.toMatch(/secret words|Desk d1|Notes/)
  })

  it('a desk trashed before its delete went up is queued; its delete already up is not queued again', () => {
    desk('d1')
    deleteNode('d1') // trashed, dirty: its DELETE has not gone up
    deleteNodePermanent('d1')
    expect(deletes()).toEqual(expect.arrayContaining([{ id: 'd1', itemType: 'node', baseRev: 3 }]))
    desk('d2')
    deleteNode('d2')
    synced('nodes', 'd2', 4) // its DELETE went up: the server holds the tombstone at rev 4
    deleteNodePermanent('d2')
    const ids = deletes().map((d) => d.id)
    expect(ids).not.toContain('d2')
    expect(ids).toContain('d2-w') // its widgets were never tombstoned: they are
  })

  it('a desk the server never had queues nothing', () => {
    createNode({ id: 'local', parentId: null, kind: 'task', title: 'Local' } as never)
    deleteNodePermanent('local')
    expect(queued()).toEqual([])
  })
})

describe('the Trash ageing out tombstones what never went up, and a desk\'s widgets', () => {
  const age = (table: Table, id: string, days: number): void => {
    db.prepare(`UPDATE ${table} SET trashed_at = ? WHERE id = ?`).run(Date.now() - days * DAY, id)
  }
  it('desks: offline-trashed is queued; pushed-trashed is not, but its cascaded widgets are', () => {
    desk('off')
    deleteNode('off') // dirty
    age('nodes', 'off', 8)
    desk('pushed')
    deleteNode('pushed')
    age('nodes', 'pushed', 8)
    synced('nodes', 'pushed', 5) // its DELETE went up (any later write would make it dirty again)
    purgeTrashedNodes()
    const ids = deletes().map((d) => d.id).sort()
    expect(ids).toEqual(['off', 'off-w', 'pushed-w'])
  })

  it('widgets and Drive files trashed while offline', () => {
    desk('d1')
    deleteWidget('d1-w') // dirty
    age('widgets', 'd1-w', 8)
    purgeTrashedWidgets()
    createFolder(null, 'Receipts', 'f1')
    synced('fb_files', 'f1', 6)
    deleteEntry('f1') // dirty
    age('fb_files', 'f1', 8)
    purgeOldTrash()
    expect(deletes()).toEqual(
      expect.arrayContaining([
        { id: 'd1-w', itemType: 'widget', baseRev: 2 },
        { id: 'f1', itemType: 'file', baseRev: 6 }
      ])
    )
  })
})

describe('the other hard deletes', () => {
  it('Drive "Delete forever" before the delete went up', () => {
    createFolder(null, 'Receipts', 'f1')
    synced('fb_files', 'f1', 6)
    deleteEntry('f1')
    purgeEntry('f1')
    expect(deletes()).toEqual([{ id: 'f1', itemType: 'file', baseRev: 6 }])
  })

  it('an org document purged before its delete went up: queued for that org, not the personal loop', () => {
    createDocument({ id: 'doc1', docType: 'doc', title: 'Plan' } as never)
    db.prepare("UPDATE documents SET org_id = 'org_team', sync_rev = 4, needs_sync = 0 WHERE id = 'doc1'").run()
    trashDocument('doc1')
    deleteDocument('doc1')
    expect(deletes()).toEqual([])
    expect(sync.collectPendingOrg('org_team').deletes.map(({ id, itemType, baseRev }) => ({ id, itemType, baseRev }))).toEqual([
      { id: 'doc1', itemType: 'document', baseRev: 4 }
    ])
  })

  it('a shared desk\'s widget goes on the shared loop with its desk', () => {
    desk('d1')
    db.prepare("UPDATE nodes SET shared_root_id = 'd1' WHERE id = 'd1'").run()
    db.prepare("UPDATE widgets SET shared_root_id = 'd1' WHERE id = 'd1-w'").run()
    deleteWidget('d1-w')
    db.prepare('UPDATE widgets SET trashed_at = ? WHERE id = ?').run(Date.now() - 8 * DAY, 'd1-w')
    purgeTrashedWidgets()
    expect(sync.collectPendingShared().deletes.map(({ id, rootId, baseRev }) => ({ id, rootId, baseRev }))).toEqual([
      { id: 'd1-w', rootId: 'd1', baseRev: 2 }
    ])
  })

  it('pruning a shared desk you lost access to queues nothing (not your delete)', () => {
    desk('d1')
    db.prepare("UPDATE nodes SET shared_root_id = 'd1' WHERE id = 'd1'").run()
    db.prepare("UPDATE widgets SET shared_root_id = 'd1' WHERE id = 'd1-w'").run()
    sync.pruneSharedDesk('d1')
    expect(queued()).toEqual([])
  })
})

describe('the queue drains safely', () => {
  it('markPushed clears it', () => {
    desk('d1')
    deleteNodePermanent('d1')
    sync.markPushed('node', 'd1', 4)
    sync.markPushed('widget', 'd1-w', 3)
    expect(queued()).toEqual([])
  })

  it('a pull of the item at the rev we deleted never brings the row back', () => {
    desk('d1')
    deleteNodePermanent('d1')
    sync.applyRemote([{ id: 'd1', itemType: 'node', rev: 3, deleted: false, body: { id: 'd1', parent_id: null, kind: 'task', title: 'Desk d1', created_at: 1, updated_at: 1 } } as never])
    expect(db.prepare("SELECT COUNT(*) n FROM nodes WHERE id = 'd1'").get()).toEqual({ n: 0 })
    expect(deletes().map((d) => d.id)).toContain('d1')
  })

  it('restored or edited elsewhere since (a newer rev) wins: it comes back here and the tombstone is dropped', () => {
    desk('d1')
    deleteNodePermanent('d1')
    sync.applyRemote([{ id: 'd1', itemType: 'node', rev: 7, deleted: false, body: { id: 'd1', parent_id: null, kind: 'task', title: 'Edited elsewhere', created_at: 1, updated_at: 2 } } as never])
    expect(db.prepare("SELECT title FROM nodes WHERE id = 'd1'").get()).toEqual({ title: 'Edited elsewhere' })
    expect(deletes().map((d) => d.id)).not.toContain('d1')
  })

  it('a pulled tombstone (deleted on the server already) drops it', () => {
    desk('d1')
    deleteNodePermanent('d1')
    sync.applyRemote([{ id: 'd1', itemType: 'node', rev: 4, deleted: true, body: {} } as never])
    expect(deletes().map((d) => d.id)).not.toContain('d1')
  })
})
