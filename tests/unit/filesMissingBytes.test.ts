// Finding the files whose bytes have not arrived.
//
// Byte transfer got this wrong twice in one day, and both times the failure was
// silent -- sync reported success while doing nothing. Both times the cause was
// the same shape: it was built around EVENTS (what turned up in this batch)
// when it needed to be built around STATE (what is missing right now).
//
//   first: download every missing file in series before advancing the cursor,
//          which on a first sign-in is the whole Drive at once.
//   then:  queue ids as their rows arrive in a pull -- but the cursor moves
//          past a row and never offers it again, and the queue was in memory
//          so a reload forgot it. 129 files sat on the server that the browser
//          was never going to ask for.
//
// So this pins the property that matters and that neither earlier version had:
// a file row without bytes is discoverable from the database alone, no matter
// how it got there or what has been forgotten since.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'
import { MAX_SYNCED_FILE_BYTES } from '../../src/shared/fileSyncLimits'

let db: SqliteDb
const present = new Set<string>()

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'bytes@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))
// A blob store whose contents the test controls, so "has bytes" is a fact this
// test sets rather than something it has to arrange on a real disk.
vi.mock('../../src/main/db/fileBlobs', () => ({
  fileBlobs: {
    write: async () => {},
    read: async () => null,
    exists: async (id: string) => present.has(id),
    remove: async () => {},
    locate: (id: string, ext: string) => `mem:/${id}${ext}`
  }
}))
vi.mock('../../src/main/db/imageDownsample', () => ({
  downsampleImage: async (bytes: Uint8Array) => ({ bytes, changed: false, width: 0, height: 0 }),
  isDownsampleable: () => false
}))

let filesMissingBytes: (limit?: number) => Promise<string[]>

const addFile = (id: string, sizeBytes: number, trashed = false): void => {
  db.prepare(
    `INSERT INTO fb_files (id, original_name, mime_type, size_bytes, ext, created_at, kind, display_name, updated_at, org_id, trashed_at)
     VALUES (@id, @name, 'image/png', @size, '.png', 1, 'file', @name, @updated, 'personal', @trashed)`
  ).run({ id, name: `${id}.png`, size: sizeBytes, updated: Date.now(), trashed: trashed ? Date.now() : null })
}

beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  ;({ filesMissingBytes } = await import('../../src/main/db/files'))
})

describe('filesMissingBytes', () => {
  it('finds a file whose row is here and whose bytes are not', async () => {
    addFile('missing-1', 1024)
    expect(await filesMissingBytes(10)).toContain('missing-1')
  })

  it('stops reporting it once the bytes arrive', async () => {
    present.add('missing-1')
    expect(await filesMissingBytes(10)).not.toContain('missing-1')
  })

  it('finds rows regardless of when or how they arrived', async () => {
    // The point of asking the database instead of remembering: a row that
    // synced long ago, before byte transfer existed, is just as findable as one
    // that arrived in the last pull. Nothing here records how it got here.
    addFile('ancient', 2048)
    expect(await filesMissingBytes(10)).toContain('ancient')
  })

  it('ignores files the server would refuse, rather than asking forever', async () => {
    addFile('too-big', MAX_SYNCED_FILE_BYTES + 1)
    expect(await filesMissingBytes(50)).not.toContain('too-big')
    // And one exactly at the limit IS requested, matching the server's `>`.
    addFile('exactly-at-limit', MAX_SYNCED_FILE_BYTES)
    expect(await filesMissingBytes(50)).toContain('exactly-at-limit')
  })

  it('ignores trashed files', async () => {
    addFile('binned', 512, true)
    expect(await filesMissingBytes(50)).not.toContain('binned')
  })

  it('honours the limit, so a cycle never takes on a long list', async () => {
    for (let i = 0; i < 20; i++) addFile(`bulk-${i}`, 1024)
    expect((await filesMissingBytes(6)).length).toBe(6)
    expect((await filesMissingBytes(3)).length).toBe(3)
  })

  it('drains completely when called repeatedly, which is how a cycle works', async () => {
    // The real loop calls this each cycle and fetches what it gets. Marking
    // those as present must eventually empty the set -- if it did not, a Drive
    // would never finish arriving.
    let guard = 0
    while (guard++ < 50) {
      const batch = await filesMissingBytes(6)
      if (batch.length === 0) break
      for (const id of batch) present.add(id)
    }
    expect(await filesMissingBytes(50)).toEqual([])
    expect(guard).toBeLessThan(50)
  })
})
