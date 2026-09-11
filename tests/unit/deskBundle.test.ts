// A desk, packed and unpacked.
//
// The bundle is the whole of the ephemeral-share feature: the sender packs one,
// the server holds it for 48 hours, the recipient's browser unpacks it, and the
// same file is what they carry to the desktop app. If a round trip loses a
// widget, a table row or a picture, every one of those steps loses it too.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
const blobs = new Map<string, Uint8Array>()

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'sender@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))
vi.mock('../../src/main/db/fileBlobs', () => ({
  fileBlobs: {
    write: async (id: string, ext: string, bytes: Uint8Array) => { blobs.set(id + ext, bytes) },
    read: async (id: string, ext: string) => blobs.get(id + ext) ?? null,
    exists: async (id: string, ext: string) => blobs.has(id + ext),
    remove: async () => {},
    locate: (id: string, ext: string) => `mem:/${id}${ext}`
  }
}))

let mod: typeof import('../../src/main/db/deskBundle')
const NOW = 1_700_000_000_000

function seed(): void {
  db.prepare(`INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,sort_order,created_at,updated_at,extensions_minutes,org_id)
              VALUES ('desk-1',NULL,'task','Shared desk','',  'open',3,3,3,0,?,?,0,'personal')`).run(NOW, NOW)
  db.prepare(`INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,sort_order,created_at,updated_at,extensions_minutes,org_id)
              VALUES ('desk-child',  'desk-1','task','Sub desk','','open',3,3,3,0,?,?,0,'personal')`).run(NOW, NOW)
  db.prepare(`INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,sort_order,created_at,updated_at,extensions_minutes,org_id)
              VALUES ('desk-other',NULL,'task','Not shared','','open',3,3,3,0,?,?,0,'personal')`).run(NOW, NOW)

  const w = (id: string, task: string, kind: string, content: string): void => {
    db.prepare(`INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,created_at,updated_at)
                VALUES (?,?,?,'',?,0,0,200,200,1,?,?)`).run(id, task, kind, content, NOW, NOW)
  }
  w('w-sticky', 'desk-1', 'sticky', 'hello')
  w('w-child', 'desk-child', 'sticky', 'on the sub desk')
  w('w-doc', 'desk-1', 'doc', 'doc-1')
  w('w-file', 'desk-1', 'file', 'file-1')
  w('w-img', 'desk-1', 'image', 'fb-file://file-2')
  w('w-other', 'desk-other', 'sticky', 'must not travel')

  db.prepare(`INSERT INTO documents (id,doc_type,title,body,created_at,updated_at,org_id)
              VALUES ('doc-1','doc','A doc','{}',?,?,'personal')`).run(NOW, NOW)
  db.prepare(`INSERT INTO documents (id,doc_type,title,body,created_at,updated_at,org_id)
              VALUES ('doc-other','doc','Other','{}',?,?,'personal')`).run(NOW, NOW)

  const f = (id: string, ext: string, size: number): void => {
    db.prepare(`INSERT INTO fb_files (id,original_name,mime_type,size_bytes,ext,created_at,kind,display_name,updated_at,org_id)
                VALUES (?,?,'image/png',?,?,?,'file',?,?,'personal')`).run(id, id + ext, size, ext, NOW, id + ext, NOW)
  }
  f('file-1', '.png', 3)
  f('file-2', '.png', 4)
  blobs.set('file-1.png', new Uint8Array([1, 2, 3]))
  blobs.set('file-2.png', new Uint8Array([9, 8, 7, 6]))

  db.prepare(`INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id)
              VALUES ('t-1','desk-1','Pipeline','{"columns":[{"id":"c1","type":"text-short","label":"P","config":{}}]}',?,?,'personal')`).run(NOW, NOW)
  db.prepare(`INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at)
              VALUES ('r-1','t-1','{"c1":"row one"}',0,?,?)`).run(NOW, NOW)
}

beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(db)
  seed()
  mod = await import('../../src/main/db/deskBundle')
})

describe('packing a desk', () => {
  it('takes the desk and everything filed under it', async () => {
    const b = await mod.buildDeskBundle('desk-1')
    expect(b.tables.nodes.map((n) => n.id).sort()).toEqual(['desk-1', 'desk-child'])
    expect(b.tables.widgets.map((w) => w.id).sort()).toEqual(['w-child', 'w-doc', 'w-file', 'w-img', 'w-sticky'])
  })

  it('leaves other desks alone', async () => {
    const b = await mod.buildDeskBundle('desk-1')
    const ids = JSON.stringify(b.tables)
    expect(ids).not.toContain('desk-other')
    expect(ids).not.toContain('must not travel')
    expect(ids).not.toContain('doc-other')
  })

  it('follows what the widgets point at, since documents are not filed under a desk', async () => {
    const b = await mod.buildDeskBundle('desk-1')
    expect(b.tables.documents.map((d) => d.id)).toEqual(['doc-1'])
    expect(b.tables.fb_tables.map((t) => t.id)).toEqual(['t-1'])
    expect(b.tables.fb_rows.map((r) => r.id)).toEqual(['r-1'])
  })

  it('carries the bytes, in every shape a widget stores a file', async () => {
    // w-file holds a bare id, w-img holds an fb-file:// URL. Both must travel or
    // the recipient gets a desk of empty frames.
    const b = await mod.buildDeskBundle('desk-1')
    expect(b.files.map((f) => f.id).sort()).toEqual(['file-1', 'file-2'])
    expect(b.counts.fileBytes).toBe(7)
  })

  it('says which files it left behind rather than dropping them silently', async () => {
    const b = await mod.buildDeskBundle('desk-1', { maxBytes: 3 })
    expect(b.files.map((f) => f.id)).toEqual(['file-1'])
    expect(b.filesOmitted.map((f) => f.id)).toEqual(['file-2'])
    expect(b.filesOmitted[0].why).toMatch(/size limit/)
  })

  it('refuses a desk that is not there', async () => {
    await expect(mod.buildDeskBundle('nope')).rejects.toThrow(/no desk/)
  })
})

describe('reading a file reference', () => {
  // A candidate, not a verdict: fb_files decides which candidates are real.
  it.each([
    ['bare id', 'file-1', 'file-1'],
    ['uuid', 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d', 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d'],
    ['fb-file url', 'fb-file://abc123def456abc1', 'abc123def456abc1'],
    ['json object', '{"fileId":"11112222333344445"}', '11112222333344445'],
    ['http url', 'https://example.invalid/a.png', null],
    ['data uri', 'data:image/png;base64,AAAA', null],
    ['empty', '', null]
  ])('%s', (_label, input, expected) => {
    expect(mod.fileIdFromContent(input)).toBe(expected)
  })
})

describe('unpacking into a fresh database', () => {
  let fresh: SqliteDb

  it('restores the desk whole', async () => {
    const bundle = await mod.buildDeskBundle('desk-1')

    // A different database, as the recipient's browser would be.
    fresh = openMemoryDatabase()
    fresh.pragma('foreign_keys = ON')
    const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
    applyBrowserSchema(fresh)
    const sender = db
    db = fresh
    blobs.clear()

    const res = await mod.importDeskBundle(bundle)
    expect(res.ok, res.reason).toBe(true)
    expect(res.deskId).toBe('desk-1')
    expect(res.filesWritten).toBe(2)

    const widgets = fresh.prepare("SELECT id FROM widgets WHERE task_id IN ('desk-1','desk-child') ORDER BY id").all() as { id: string }[]
    expect(widgets.map((w) => w.id)).toEqual(['w-child', 'w-doc', 'w-file', 'w-img', 'w-sticky'])
    const row = fresh.prepare("SELECT cells_json FROM fb_rows WHERE id='r-1'").get() as { cells_json: string }
    expect(JSON.parse(row.cells_json).c1).toBe('row one')
    expect(blobs.get('file-1.png')).toEqual(new Uint8Array([1, 2, 3]))
    db = sender
  })

  it('is additive: importing twice adds nothing and destroys nothing', async () => {
    const bundle = await mod.buildDeskBundle('desk-1')
    const sender = db
    db = fresh
    // Something the recipient changed after the first import must survive.
    fresh.prepare("UPDATE widgets SET content='edited by the recipient' WHERE id='w-sticky'").run()
    const again = await mod.importDeskBundle(bundle)
    expect(again.ok).toBe(true)
    expect(again.imported).toBe(0)
    const w = fresh.prepare("SELECT content FROM widgets WHERE id='w-sticky'").get() as { content: string }
    expect(w.content).toBe('edited by the recipient')
    db = sender
  })

  it('refuses anything that is not a bundle', async () => {
    const bad = await mod.importDeskBundle({ format: 'something.else' } as never)
    expect(bad.ok).toBe(false)
    expect(bad.reason).toMatch(/not a Plexii desk bundle/)
    const old = await mod.importDeskBundle({ format: 'plexii.desk', formatVersion: 99 } as never)
    expect(old.ok).toBe(false)
    expect(old.reason).toMatch(/unsupported bundle version/)
  })
})

describe('base64', () => {
  it('survives bytes that are not text', () => {
    const bytes = new Uint8Array(1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    expect(mod.fromBase64(mod.toBase64(bytes))).toEqual(bytes)
  })
})
