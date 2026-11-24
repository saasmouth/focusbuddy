// A delete made on another device lands in this device's Trash, recoverable
// (4.3.55; the 16 Nov case, where a Drive folder deleted by a sign-in replay had
// to be restored by an admin).
//
// Every delete that arrives by sync was already soft here (trashed_at). What was
// missing was knowing it came from elsewhere: widgets, rows, tables and time
// blocks deleted on another device vanished with no Trash entry, and nothing said
// a desk or file had been deleted elsewhere. So a delete that arrives by sync (a
// pull or the CRDT channel) stamps deleted_elsewhere_at; the device's own delete
// never does. The stamp:
//   - never travels (it is this device's knowledge, not the item's);
//   - keeps the item 30 days instead of 7;
//   - lists it in the Trash, labelled, with Restore and Delete forever;
//   - makes a Restore win over the delete it answers, even if this device has not
//     yet pulled the tombstone's rev (the push retries at the server's rev).
// "Deleted elsewhere" means deleted_elsewhere_at >= trashed_at, so a stamp left on
// a row restored and later deleted here again does not count.
//
// Runs the desktop's own schema, migrations, triggers and write functions
// (SQLite-WASM, as syncApplyNeverRepushes.test.ts does).
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
  accountEmail: () => 'sync-trash@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

const sync = await import('../../src/main/db/workspaceSync')
const { createNode, deleteNode, listTrash, purgeTrashedNodes } = await import('../../src/main/db/nodes')
const { createWidget, updateWidget, deleteWidget, purgeTrashedWidgets } = await import('../../src/main/db/widgets')
const { createTable, createRow, deleteRow, deleteTable } = await import('../../src/main/db/tables')
const { createTimeBlock, deleteTimeBlock } = await import('../../src/main/db/timeBlocks')
const { createFolder, deleteEntry, purgeOldTrash } = await import('../../src/main/db/files')
const { createDocument, trashDocument } = await import('../../src/main/db/documents')
const trash = await import('../../src/main/db/syncTrash')

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

type Table = 'nodes' | 'widgets' | 'time_blocks' | 'documents' | 'fb_tables' | 'fb_rows' | 'fb_files'
const row = (table: Table, id: string): Record<string, number | null> =>
  db.prepare(`SELECT trashed_at, deleted_elsewhere_at, needs_sync, sync_rev FROM ${table} WHERE id = ?`).get(id) as never
// A row as the poll leaves it: pulled from the server, clean at `rev`.
const clean = (table: Table, id: string, rev = 3): void => {
  db.prepare(`UPDATE ${table} SET needs_sync = 0, sync_rev = ? WHERE id = ?`).run(rev, id)
}
const tombstone = (itemType: string, id: string, rev = 9) => ({ id, itemType, body: { id }, rev, deleted: true }) as never

// One of each synced kind, all clean, on desk d1.
function seed(): void {
  createNode({ id: 'd1', parentId: null, kind: 'task', title: 'Launch plan' } as never)
  createWidget({ id: 'w1', taskId: 'd1', kind: 'sticky', title: 'Budget', content: 'x', x: 0, y: 0, width: 10, height: 10 } as never)
  createTable({ id: 't1', taskId: 'd1', title: 'Suppliers' } as never)
  createRow({ id: 'r1', tableId: 't1', cells: {} } as never)
  createTimeBlock({ id: 'b1', taskId: 'd1', title: 'Call the printer', startMs: Date.now() + DAY, durationMin: 30 } as never)
  createFolder(null, 'Receipts', 'f1')
  createDocument({ id: 'doc1', docType: 'doc', title: 'Brief' } as never)
  for (const [t, id] of [['nodes', 'd1'], ['widgets', 'w1'], ['fb_tables', 't1'], ['fb_rows', 'r1'], ['time_blocks', 'b1'], ['fb_files', 'f1'], ['documents', 'doc1']] as const) clean(t, id)
}

const KINDS = [
  ['widget', 'widgets', 'w1'],
  ['node', 'nodes', 'd1'],
  ['table', 'fb_tables', 't1'],
  ['row', 'fb_rows', 'r1'],
  ['timeblock', 'time_blocks', 'b1'],
  ['file', 'fb_files', 'f1'],
  ['document', 'documents', 'doc1']
] as const

describe('a delete that arrives by pull is marked as made elsewhere', () => {
  it.each(KINDS)('%s: trashed here, stamped, still clean', (itemType, table, id) => {
    seed()
    sync.applyRemote([tombstone(itemType, id)])
    const r = row(table, id)
    expect(r.trashed_at).not.toBeNull()
    expect(r.deleted_elsewhere_at).toBe(r.trashed_at)
    expect(r.needs_sync).toBe(0)
    expect(r.sync_rev).toBe(9)
  })

  it('a row this device trashed itself keeps its own delete: no stamp, same time', () => {
    seed()
    deleteWidget('w1')
    const mine = row('widgets', 'w1').trashed_at
    sync.applyRemote([tombstone('widget', 'w1')])
    expect(row('widgets', 'w1')).toMatchObject({ trashed_at: mine, deleted_elsewhere_at: null })
  })

  it('the org pull stamps too', () => {
    seed()
    sync.applyRemoteOrg([tombstone('widget', 'w1')], 'org_test')
    const r = row('widgets', 'w1')
    expect(r.trashed_at).not.toBeNull()
    expect(r.deleted_elsewhere_at).toBe(r.trashed_at)
  })

  it('a shared desk pull stamps a collaborator\'s delete', () => {
    seed()
    db.prepare("UPDATE nodes SET shared_root_id = 'd1' WHERE id = 'd1'").run()
    db.prepare("UPDATE widgets SET shared_root_id = 'd1' WHERE id = 'w1'").run()
    sync.applyRemoteShared([{ ...(tombstone('widget', 'w1') as object), rootId: 'd1' } as never], { sharedContainerId: 'c' })
    const r = row('widgets', 'w1')
    expect(r.trashed_at).not.toBeNull()
    expect(r.deleted_elsewhere_at).toBe(r.trashed_at)
  })
})

describe('a delete that arrives over the CRDT channel is marked too', () => {
  it.each([
    ['widget', 'widgets', 'w1', () => deleteWidget('w1')],
    ['desk', 'nodes', 'd1', () => deleteNode('d1')],
    ['row', 'fb_rows', 'r1', () => deleteRow('r1')],
    ['table', 'fb_tables', 't1', () => deleteTable('t1')],
    ['time block', 'time_blocks', 'b1', () => deleteTimeBlock('b1')],
    ['file', 'fb_files', 'f1', () => deleteEntry('f1')],
    ['document', 'documents', 'doc1', () => trashDocument('doc1')]
  ] as const)('%s deleted by sync: stamped and clean; the same delete by a person is not stamped', (_k, table, id, del) => {
    seed()
    sync.byOrigin('sync', del)
    const r = row(table, id)
    expect(r.trashed_at).not.toBeNull()
    expect(r.deleted_elsewhere_at).not.toBeNull()
    expect(r.deleted_elsewhere_at!).toBeGreaterThanOrEqual(r.trashed_at!)
    expect(r.needs_sync).toBe(0)
  })

  it('control: a person\'s own delete is not stamped', () => {
    seed()
    sync.byOrigin(undefined, () => deleteWidget('w1'))
    expect(row('widgets', 'w1').deleted_elsewhere_at).toBeNull()
  })

  it('a room deleted by sync stamps every desk that went with it (its widgets are only hidden, never trashed)', () => {
    seed()
    createNode({ id: 'room', parentId: null, kind: 'folder', title: 'Room' } as never)
    db.prepare("UPDATE nodes SET parent_id = 'room' WHERE id = 'd1'").run()
    clean('nodes', 'room')
    clean('nodes', 'd1')
    sync.byOrigin('sync', () => deleteNode('room'))
    expect(row('nodes', 'room').deleted_elsewhere_at).not.toBeNull()
    expect(row('nodes', 'd1').deleted_elsewhere_at).not.toBeNull()
    expect(row('widgets', 'w1').trashed_at).toBeNull()
  })

  it('a sync edit to a row this device trashed itself does not stamp it', () => {
    seed()
    deleteWidget('w1')
    clean('widgets', 'w1', 4)
    sync.byOrigin('sync', () => updateWidget('w1', { content: 'edited elsewhere' } as never))
    expect(row('widgets', 'w1').deleted_elsewhere_at).toBeNull()
  })
})

describe('the stamp never travels', () => {
  it('is not in a pushed body, and an incoming body cannot set it', () => {
    seed()
    sync.applyRemote([tombstone('widget', 'w1')])
    trash.restoreDeletedElsewhere('widget', 'w1')
    const up = sync.collectPending().upserts.find((u) => u.id === 'w1')
    expect(up).toBeDefined()
    expect(up!.body).not.toHaveProperty('deleted_elsewhere_at')
    sync.applyRemote([{ id: 'w2', itemType: 'widget', rev: 5, deleted: false, body: { id: 'w2', task_id: 'd1', kind: 'sticky', title: '', content: '', x: 0, y: 0, width: 1, height: 1, z_index: 0, created_at: 1, updated_at: 1, deleted_elsewhere_at: 123 } } as never])
    expect(row('widgets', 'w2').deleted_elsewhere_at).toBeNull()
  })
})

describe('items deleted elsewhere are kept 30 days; the device\'s own deletes 7', () => {
  const age = (table: Table, id: string, days: number, elsewhere: boolean): void => {
    const at = Date.now() - days * DAY
    db.prepare(`UPDATE ${table} SET trashed_at = ?, deleted_elsewhere_at = ? WHERE id = ?`).run(at, elsewhere ? at : null, id)
  }
  it.each([
    ['widgets', 'w1', () => purgeTrashedWidgets()],
    ['fb_files', 'f1', () => purgeOldTrash()]
  ] as const)('%s', (table, id, purge) => {
    seed()
    age(table, id, 8, true)
    purge()
    expect(row(table, id)).toBeDefined()
    age(table, id, 31, true)
    purge()
    expect(row(table, id)).toBeUndefined()
    seed2(table, id)
    age(table, id, 8, false)
    purge()
    expect(row(table, id)).toBeUndefined()
  })
  it('nodes', () => {
    seed()
    age('nodes', 'd1', 8, true)
    purgeTrashedNodes()
    expect(row('nodes', 'd1')).toBeDefined()
    age('nodes', 'd1', 31, true)
    purgeTrashedNodes()
    expect(row('nodes', 'd1')).toBeUndefined()
    createNode({ id: 'd2', parentId: null, kind: 'task', title: 'Mine' } as never)
    age('nodes', 'd2', 8, false)
    purgeTrashedNodes()
    expect(row('nodes', 'd2')).toBeUndefined()
  })
  // The same id again, for the own-delete half.
  function seed2(table: Table, id: string): void {
    if (table === 'widgets') createWidget({ id, taskId: 'd1', kind: 'sticky', content: 'x', x: 0, y: 0, width: 10, height: 10 } as never)
    else createFolder(null, 'Again', id)
  }
})

describe('the Trash lists what was deleted elsewhere', () => {
  it('every kind but desks and rooms (those stay in the Trash list, labelled), with where it was and when it goes', () => {
    seed()
    for (const [itemType, , id] of KINDS) if (itemType !== 'node') sync.applyRemote([tombstone(itemType, id)])
    const list = trash.listDeletedElsewhere()
    const by = Object.fromEntries(list.map((e) => [e.kind, e]))
    // The row went with its table: one entry for the table, none for the row.
    expect(Object.keys(by).sort()).toEqual(['document', 'file', 'table', 'timeblock', 'widget'])
    expect(by.widget).toMatchObject({ id: 'w1', title: 'Budget', where: 'Launch plan' })
    expect(by.table).toMatchObject({ id: 't1', title: 'Suppliers', where: 'Launch plan' })
    expect(by.timeblock).toMatchObject({ id: 'b1', title: 'Call the printer' })
    expect(by.file).toMatchObject({ id: 'f1', title: 'Receipts' })
    expect(by.document).toMatchObject({ id: 'doc1', title: 'Brief' })
    // Honest timing: widgets and files are purged at 30 days; the others never age out.
    expect(by.widget.purgeAt).toBe(by.widget.deletedAt + 30 * DAY)
    expect(by.file.purgeAt).toBe(by.file.deletedAt + 30 * DAY)
    expect(by.table.purgeAt).toBeNull()
    expect(by.document.purgeAt).toBeNull()
  })

  it('a row deleted on its own is listed with its table as where', () => {
    seed()
    sync.applyRemote([tombstone('row', 'r1')])
    expect(trash.listDeletedElsewhere()).toEqual([expect.objectContaining({ kind: 'row', id: 'r1', where: 'Suppliers' })])
  })

  it('leaves out the device\'s own deletes, and what went with a desk deleted elsewhere', () => {
    seed()
    deleteWidget('w1')
    expect(trash.listDeletedElsewhere()).toEqual([])
    sync.byOrigin('sync', () => deleteNode('d1'))
    expect(trash.listDeletedElsewhere().map((e) => e.kind)).not.toContain('widget')
  })

  it('a desk deleted elsewhere is labelled in the Trash list and kept 30 days', () => {
    seed()
    sync.applyRemote([tombstone('node', 'd1')])
    const e = listTrash().find((x) => x.id === 'd1') as { deletedElsewhere?: boolean; trashedAt: number; purgeAt: number }
    expect(e.deletedElsewhere).toBe(true)
    expect(e.purgeAt).toBe(e.trashedAt + 30 * DAY)
  })
})

describe('Restore and Delete forever', () => {
  it('a restore goes up at the tombstone\'s rev, flagged as answering a delete from elsewhere', () => {
    seed()
    sync.applyRemote([tombstone('widget', 'w1', 12)])
    expect(trash.restoreDeletedElsewhere('widget', 'w1')).toMatchObject({ restored: true, ids: ['w1'] })
    expect(row('widgets', 'w1').trashed_at).toBeNull()
    const up = sync.collectPending().upserts.find((u) => u.id === 'w1')
    expect(up).toMatchObject({ baseRev: 12, afterRemoteDelete: true })
    // Once it is up, the stamp has done its job.
    sync.markPushed('widget', 'w1', 13)
    expect(row('widgets', 'w1').deleted_elsewhere_at).toBeNull()
    expect(sync.collectPending().upserts.find((u) => u.id === 'w1')).toBeUndefined()
  })

  it('an ordinary edit is not flagged', () => {
    seed()
    updateWidget('w1', { content: 'mine' } as never)
    expect(sync.collectPending().upserts.find((u) => u.id === 'w1')?.afterRemoteDelete).toBeFalsy()
  })

  it('a tombstone sent again while the restore waits to go up does not trash it again', () => {
    seed()
    sync.applyRemote([tombstone('widget', 'w1', 12)])
    trash.restoreDeletedElsewhere('widget', 'w1')
    sync.applyRemote([tombstone('widget', 'w1', 12)])
    expect(row('widgets', 'w1').trashed_at).toBeNull()
  })

  it.each([
    ['table', 'fb_tables', 't1'],
    ['timeblock', 'time_blocks', 'b1'],
    ['file', 'fb_files', 'f1'],
    ['document', 'documents', 'doc1'],
    ['row', 'fb_rows', 'r1']
  ] as const)('restores a %s', (kind, table, id) => {
    seed()
    sync.applyRemote([tombstone(kind, id)])
    expect(trash.restoreDeletedElsewhere(kind, id).restored).toBe(true)
    expect(row(table, id).trashed_at).toBeNull()
  })

  it('restoring a table brings back the rows deleted with it', () => {
    seed()
    sync.applyRemote([tombstone('table', 't1'), tombstone('row', 'r1')])
    trash.restoreDeletedElsewhere('table', 't1')
    expect(row('fb_rows', 'r1').trashed_at).toBeNull()
  })

  it('refuses an item this device deleted itself (that is the ordinary Trash and Undo)', () => {
    seed()
    deleteWidget('w1')
    expect(trash.restoreDeletedElsewhere('widget', 'w1').restored).toBe(false)
    expect(trash.deleteForeverDeletedElsewhere('widget', 'w1')).toBe(false)
    expect(row('widgets', 'w1')).toBeDefined()
  })

  it('Delete forever removes it here and sends nothing (the server already holds the delete)', () => {
    seed()
    sync.applyRemote([tombstone('widget', 'w1'), tombstone('timeblock', 'b1'), tombstone('table', 't1')])
    expect(trash.deleteForeverDeletedElsewhere('widget', 'w1')).toBe(true)
    expect(trash.deleteForeverDeletedElsewhere('timeblock', 'b1')).toBe(true)
    expect(trash.deleteForeverDeletedElsewhere('table', 't1')).toBe(true)
    expect(row('widgets', 'w1')).toBeUndefined()
    expect(row('time_blocks', 'b1')).toBeUndefined()
    expect(row('fb_tables', 't1')).toBeUndefined()
    const p = sync.collectPending()
    expect([...p.upserts, ...p.deletes].map((x) => x.id)).not.toEqual(expect.arrayContaining(['w1', 'b1', 't1']))
  })
})

describe('the IPC boundary', () => {
  it('an unknown kind is refused, not turned into SQL', () => {
    seed()
    expect(trash.restoreDeletedElsewhere('widgets; DROP TABLE nodes' as never, 'w1')).toEqual({ restored: false, ids: [] })
    expect(trash.deleteForeverDeletedElsewhere('__proto__' as never, 'w1')).toBe(false)
    expect(row('nodes', 'd1')).toBeDefined()
  })
})

describe('where other people can delete things, the Trash does not say "another device" alone', () => {
  it('personal is sharedScope false; an org table and a shared desk\'s widget are true', () => {
    seed()
    db.prepare("UPDATE fb_tables SET org_id = 'org_team' WHERE id = 't1'").run()
    db.prepare("UPDATE widgets SET shared_root_id = 'd1' WHERE id = 'w1'").run()
    createTimeBlock({ id: 'b2', taskId: 'd1', title: 'Mine', startMs: Date.now() + DAY, durationMin: 15 } as never)
    clean('time_blocks', 'b2')
    sync.applyRemote([tombstone('table', 't1'), tombstone('widget', 'w1'), tombstone('timeblock', 'b2')])
    const by = Object.fromEntries(trash.listDeletedElsewhere().map((e) => [e.id, e.sharedScope]))
    expect(by).toEqual({ t1: true, w1: true, b2: false })
  })

  it('a desk in the Trash says so too', () => {
    seed()
    sync.applyRemote([tombstone('node', 'd1')])
    expect(listTrash().find((x) => x.id === 'd1')).toMatchObject({ deletedElsewhere: true, sharedScope: false })
  })
})

describe('a widget read by id says whether it is in the Trash', () => {
  // crdtSync's applyWidgetDelete reads local.trashedAt to decide whether a delete
  // is stale; without it the check was vacuous (it always read undefined).
  it('trashedAt when trashed, and no such key on a live widget (its shape everywhere else is unchanged)', async () => {
    seed()
    const { getWidget } = await import('../../src/main/db/widgets')
    expect(getWidget('w1')).not.toHaveProperty('trashedAt')
    deleteWidget('w1')
    const t = row('widgets', 'w1').trashed_at
    expect(getWidget('w1')?.trashedAt).toBe(t)
  })
})

describe('"Deleted by Sam Lee": an org delete names who made it (display name from the signal)', () => {
  const orgTombstone = (itemType: string, id: string, rev: number, deletedByName: string | null) =>
    ({ id, itemType, body: { id }, rev, deleted: true, deletedByName }) as never

  it('the org pull keeps the name; the Trash shows it; it never travels', () => {
    seed()
    sync.applyRemoteOrg([orgTombstone('widget', 'w1', 9, 'Sam Lee'), orgTombstone('table', 't1', 9, null)], 'org_team')
    const by = Object.fromEntries(trash.listDeletedElsewhere().map((e) => [e.id, e.deletedBy]))
    expect(by).toMatchObject({ w1: 'Sam Lee', t1: null })
    trash.restoreDeletedElsewhere('widget', 'w1')
    expect(sync.collectPendingOrg('personal').upserts.concat(sync.collectPending().upserts).find((u) => u.id === 'w1')?.body).not.toHaveProperty('deleted_by_name')
  })

  it('a personal pull never names anyone', () => {
    seed()
    sync.applyRemote([{ ...(tombstone('widget', 'w1') as object), deletedByName: 'Someone' } as never])
    expect(trash.listDeletedElsewhere().find((e) => e.id === 'w1')?.deletedBy).toBeNull()
  })

  it('a delete first seen on the CRDT channel gets its name when the pull brings it', () => {
    seed()
    sync.byOrigin('sync', () => deleteWidget('w1'))
    expect(trash.listDeletedElsewhere().find((e) => e.id === 'w1')?.deletedBy).toBeNull()
    sync.applyRemoteOrg([orgTombstone('widget', 'w1', 9, 'Sam Lee')], 'org_team')
    expect(trash.listDeletedElsewhere().find((e) => e.id === 'w1')?.deletedBy).toBe('Sam Lee')
  })

  it('a later delete by someone not yet known does not keep the old name', () => {
    seed()
    sync.applyRemoteOrg([orgTombstone('widget', 'w1', 9, 'Sam Lee')], 'org_team')
    trash.restoreDeletedElsewhere('widget', 'w1')
    sync.markPushed('widget', 'w1', 10)
    sync.byOrigin('sync', () => deleteWidget('w1'))
    expect(trash.listDeletedElsewhere().find((e) => e.id === 'w1')?.deletedBy).toBeNull()
  })

  it('a desk in the Trash says who too', () => {
    seed()
    sync.applyRemoteOrg([orgTombstone('node', 'd1', 9, 'Sam Lee')], 'org_team')
    expect(listTrash().find((x) => x.id === 'd1')).toMatchObject({ deletedElsewhere: true, deletedBy: 'Sam Lee' })
  })
})
