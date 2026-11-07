// "Download this desk on Plexii": the visitor's copy of a shared desk, carried
// from the browser into the desktop app (shared/deskHandoff.ts,
// main/deskHandoffReceiver.ts).
//
// The copy carries the SENDER's row ids. Imported as they are, they would sync
// to the visitor's account under ids that belong to someone else, and the
// sender opening their own link would get nothing at all (importDeskBundle
// skips rows that already exist). So the import gives every row a fresh id and
// rewrites every reference -- including the ones inside text.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'
import { deskHandoffLink, parseDeskHandoffLink, rekeyDeskBundle, type RekeyableBundle } from '../../src/shared/deskHandoff'

const userData = mkdtempSync(join(tmpdir(), 'handoff-'))
let db: SqliteDb
let blobs = new Map<string, Uint8Array>()

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'visitor@test.local',
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

// Real ids are UUIDs (randomUUID in nodes/widgets/files/documents/tables).
const DESK = '11111111-1111-4111-8111-111111111111'
const SUB = '22222222-2222-4222-8222-222222222222'
const W_NOTE = '33333333-3333-4333-8333-333333333333'
const W_DOC = '44444444-4444-4444-8444-444444444444'
const W_IMG = '55555555-5555-4555-8555-555555555555'
const W_DROPPED = '66666666-6666-4666-8666-666666666666'
const DOC = '77777777-7777-4777-8777-777777777777'
const FILE = '88888888-8888-4888-8888-888888888888'
const TABLE = '99999999-9999-4999-8999-999999999999'
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LINK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NOW = 1_700_000_000_000
const ACCOUNT = 'acct-visitor-0001'

function seed(target: SqliteDb, store: Map<string, Uint8Array>): void {
  const node = (id: string, parent: string | null, title: string): void => {
    target.prepare(`INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,sort_order,created_at,updated_at,extensions_minutes,org_id,needs_sync,sync_rev)
                    VALUES (?,?,'task',?,'','open',3,3,3,0,?,?,0,'org-of-the-sender',0,17)`).run(id, parent, title, NOW, NOW)
  }
  node(DESK, null, 'Day trading')
  node(SUB, DESK, 'Watchlist')
  const w = (id: string, task: string, kind: string, content: string): void => {
    target.prepare(`INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,created_at,updated_at,needs_sync,sync_rev)
                    VALUES (?,?,?,'',?,0,0,200,200,1,?,?,0,9)`).run(id, task, kind, content, NOW, NOW)
  }
  // A note that mentions a short choice id ("o2") and a longer token that only
  // CONTAINS a row id: neither may be touched.
  w(W_NOTE, DESK, 'sticky', `see o2 and x${DOC}y`)
  w(W_DOC, DESK, 'doc', DOC)
  w(W_IMG, SUB, 'image', `fb-file://${FILE}`)
  w(W_DROPPED, DESK, 'file', JSON.stringify({ fileId: FILE, name: 'chart.png' }))
  target.prepare(`INSERT INTO documents (id,doc_type,title,body,created_at,updated_at,org_id)
                  VALUES (?,'doc','Plan',?,?,?,'org-of-the-sender')`).run(DOC, JSON.stringify({ type: 'doc', content: [{ type: 'image', attrs: { src: `fb-file://${FILE}` } }] }), NOW, NOW)
  target.prepare(`INSERT INTO fb_files (id,original_name,mime_type,size_bytes,ext,created_at,kind,display_name,updated_at,org_id)
                  VALUES (?,'chart.png','image/png',3,'.png',?,'file','chart.png',?,'org-of-the-sender')`).run(FILE, NOW, NOW)
  store.set(`${FILE}.png`, new Uint8Array([1, 2, 3]))
  target.prepare(`INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id)
                  VALUES (?,?,'Tickers','{"columns":[{"id":"c1","type":"select","label":"S","config":{"options":[{"id":"o2","label":"Buy"}]}}]}',?,?,'org-of-the-sender')`).run(TABLE, DESK, NOW, NOW)
  target.prepare(`INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at)
                  VALUES (?,?,'{"c1":"o2"}',0,?,?)`).run(ROW, TABLE, NOW, NOW)
  target.prepare(`INSERT INTO widget_links (id,source_widget_id,target_widget_id,task_id,created_at)
                  VALUES (?,?,?,?,?)`).run(LINK, W_NOTE, W_DOC, DESK, NOW)
}

async function freshDb(): Promise<SqliteDb> {
  const d = openMemoryDatabase()
  d.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(d)
  const { ensureDeskLayoutSchema } = await import('../../src/main/db/deskLayoutStore')
  ensureDeskLayoutSchema(d as never)
  return d
}

let bundleMod: typeof import('../../src/main/db/deskBundle')
let receiver: typeof import('../../src/main/deskHandoffReceiver')

beforeAll(async () => {
  await initSqlite()
  bundleMod = await import('../../src/main/db/deskBundle')
  receiver = await import('../../src/main/deskHandoffReceiver')
})

describe('the link that hands a desk to the app', () => {
  it('round-trips an id', () => {
    const id = 'Hx3_kq-9ZpL0aBcD4eFgH1'
    expect(deskHandoffLink(id)).toBe(`plexii://desk?handoff=${id}`)
    expect(parseDeskHandoffLink(deskHandoffLink(id))).toBe(id)
  })

  it('answers the old scheme too, and nothing that is not a desk handoff', () => {
    expect(parseDeskHandoffLink('haptyx://desk?handoff=Hx3_kq-9ZpL0aBcD4eFgH1')).toBe('Hx3_kq-9ZpL0aBcD4eFgH1')
    expect(parseDeskHandoffLink('plexii://share?token=Hx3_kq-9ZpL0aBcD4eFgH1')).toBeNull()
    expect(parseDeskHandoffLink('https://desk?handoff=Hx3_kq-9ZpL0aBcD4eFgH1')).toBeNull()
    expect(parseDeskHandoffLink('plexii://desk?handoff=short')).toBeNull()
    expect(parseDeskHandoffLink('plexii://desk?handoff=../../etc/passwd')).toBeNull()
    expect(parseDeskHandoffLink('not a url')).toBeNull()
  })
})

describe('rekeying a copy for a workspace of its own', () => {
  let bundle: RekeyableBundle
  beforeEach(async () => {
    db = await freshDb()
    blobs = new Map()
    seed(db, blobs)
    // The visitor arranged the Workcentre in the browser ('local'); the
    // sender's own arrangement came with the link.
    db.prepare(`INSERT INTO desk_layouts (user_id,desk_id,device_class,layout_json,updated_at) VALUES ('local',?,'desktop',?,'t')`)
      .run(DESK, JSON.stringify({ items: { [W_NOTE]: { x: 1 } } }))
    db.prepare(`INSERT INTO desk_layouts (user_id,desk_id,device_class,layout_json,updated_at) VALUES ('sender-account',?,'desktop','{"items":{}}','t')`)
      .run(DESK)
    bundle = (await bundleMod.buildDeskBundle(DESK)) as unknown as RekeyableBundle
  })

  const rekey = (b: RekeyableBundle) => {
    let n = 0
    return rekeyDeskBundle(b, { newId: () => `fresh-${String(++n).padStart(4, '0')}-0000-0000-000000000000`, layoutUser: ACCOUNT, visitorLayoutUser: 'local' })
  }

  it('gives every row a new id and keeps no old one anywhere', () => {
    const { bundle: out, ids } = rekey(bundle)
    const text = JSON.stringify(out.tables) + JSON.stringify(out.files.map((f) => f.id)) + out.desk.id
    for (const old of [DESK, SUB, W_NOTE, W_DOC, W_IMG, W_DROPPED, DOC, FILE, TABLE, ROW, LINK]) {
      expect(ids.has(old)).toBe(true)
      // Only the deliberately untouched "x<id>y" token may still hold one.
      expect(text.replaceAll(`x${DOC}y`, '')).not.toContain(old)
    }
  })

  it('rewrites references in keys, in text and in JSON inside text', () => {
    const { bundle: out, ids } = rekey(bundle)
    const byId = (t: string, id: string) => out.tables[t].find((r) => r.id === ids.get(id))!
    expect(byId('nodes', SUB).parent_id).toBe(ids.get(DESK))
    expect(byId('widgets', W_DOC).content).toBe(ids.get(DOC))
    expect(byId('widgets', W_IMG).content).toBe(`fb-file://${ids.get(FILE)}`)
    expect(JSON.parse(String(byId('widgets', W_DROPPED).content)).fileId).toBe(ids.get(FILE))
    expect(String(byId('documents', DOC).body)).toContain(`fb-file://${ids.get(FILE)}`)
    expect(byId('fb_rows', ROW).table_id).toBe(ids.get(TABLE))
    expect(byId('widget_links', LINK).source_widget_id).toBe(ids.get(W_NOTE))
    expect(out.files[0].id).toBe(ids.get(FILE))
  })

  it('never touches a short id inside text, or an id inside a longer token', () => {
    const { bundle: out, ids } = rekey(bundle)
    const note = out.tables.widgets.find((r) => r.id === ids.get(W_NOTE))!
    expect(note.content).toBe(`see o2 and x${DOC}y`)
    const row = out.tables.fb_rows[0]
    expect(row.cells_json).toBe('{"c1":"o2"}')
  })

  it('drops where the rows stood with the sender\'s server', () => {
    const { bundle: out } = rekey(bundle)
    for (const t of ['nodes', 'widgets', 'documents', 'fb_files', 'fb_tables']) {
      for (const r of out.tables[t] ?? []) {
        expect(r).not.toHaveProperty('needs_sync')
        expect(r).not.toHaveProperty('sync_rev')
        expect(r).not.toHaveProperty('org_id')
      }
    }
  })

  it('keeps the visitor\'s arrangement, as the signed-in person\'s', () => {
    const { bundle: out, ids } = rekey(bundle)
    expect(out.tables.desk_layouts).toHaveLength(1)
    const l = out.tables.desk_layouts[0]
    expect(l.user_id).toBe(ACCOUNT)
    expect(l.desk_id).toBe(ids.get(DESK))
    expect(String(l.layout_json)).toContain(String(ids.get(W_NOTE)))
  })

  it('leaves how the link presented the desk behind', () => {
    const { bundle: out } = rekey({ ...bundle, presentation: { view: 'workcentre' } })
    expect(out.presentation).toBeUndefined()
  })
})

describe('importing a claimed copy', () => {
  it('arrives as a new desk beside the original, synced as the person\'s own', async () => {
    // The visitor's browser copy.
    db = await freshDb()
    blobs = new Map()
    seed(db, blobs)
    const text = JSON.stringify(await bundleMod.buildDeskBundle(DESK))

    // The person importing it already HAS the original (they sent the link).
    const recipientBlobs = new Map<string, Uint8Array>()
    db = await freshDb()
    blobs = recipientBlobs
    seed(db, recipientBlobs)
    const before = (db.prepare('SELECT COUNT(*) AS n FROM widgets').get() as { n: number }).n

    const result = await receiver.importDeskHandoff(text, ACCOUNT)
    expect(result.ok).toBe(true)
    expect(result.rootId).not.toBe(DESK)
    expect(result.rootKind).toBe('task')
    expect(result.title).toBe('Day trading')

    const after = (db.prepare('SELECT COUNT(*) AS n FROM widgets').get() as { n: number }).n
    expect(after - before).toBe(4)
    const root = db.prepare('SELECT parent_id, needs_sync, sync_rev, org_id FROM nodes WHERE id = ?').get(result.rootId) as Record<string, unknown>
    expect(root).toEqual({ parent_id: null, needs_sync: 1, sync_rev: 0, org_id: 'personal' })
    // The original is untouched.
    const original = db.prepare('SELECT needs_sync, sync_rev FROM nodes WHERE id = ?').get(DESK) as Record<string, unknown>
    expect(original).toEqual({ needs_sync: 0, sync_rev: 17 })
    // The picture came along, under its new id.
    const img = db.prepare("SELECT content FROM widgets WHERE task_id IN (SELECT id FROM nodes WHERE parent_id = ?) AND kind = 'image'").get(result.rootId) as { content: string }
    const newFile = img.content.replace('fb-file://', '')
    expect(newFile).not.toBe(FILE)
    expect(recipientBlobs.get(`${newFile}.png`)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('refuses what is not a desk, and an import with nobody signed in', async () => {
    expect((await receiver.importDeskHandoff('not json', ACCOUNT)).ok).toBe(false)
    expect((await receiver.importDeskHandoff(JSON.stringify({ format: 'x' }), ACCOUNT)).ok).toBe(false)
    db = await freshDb()
    blobs = new Map()
    seed(db, blobs)
    const text = JSON.stringify(await bundleMod.buildDeskBundle(DESK))
    expect((await receiver.importDeskHandoff(text, '')).reason).toBe('Sign in first.')
  })
})

describe('keeping the link until someone is signed in', () => {
  beforeEach(() => {
    receiver.clearDeskHandoff()
    receiver.resetDeskHandoffForTests()
  })

  it('keeps it on disk, so a quit before signing up does not lose the desk', () => {
    receiver.rememberDeskHandoff('Hx3_kq-9ZpL0aBcD4eFgH1', 1000)
    expect(existsSync(join(userData, 'desk-handoff.json'))).toBe(true)
    receiver.resetDeskHandoffForTests() // a new launch
    expect(receiver.pendingDeskHandoff(2000)).toEqual({ id: 'Hx3_kq-9ZpL0aBcD4eFgH1', at: 1000 })
    expect(JSON.parse(readFileSync(join(userData, 'desk-handoff.json'), 'utf8')).id).toBe('Hx3_kq-9ZpL0aBcD4eFgH1')
  })

  it('forgets only the one it was asked to', () => {
    receiver.rememberDeskHandoff('Hx3_kq-9ZpL0aBcD4eFgH1', 1000)
    receiver.clearDeskHandoff('Zz9_other-handoff-idXY')
    expect(receiver.pendingDeskHandoff(2000)?.id).toBe('Hx3_kq-9ZpL0aBcD4eFgH1')
    receiver.clearDeskHandoff('Hx3_kq-9ZpL0aBcD4eFgH1')
    expect(receiver.pendingDeskHandoff(2000)).toBeNull()
  })

  it('ignores an id that is not one, and drops one past its 30 days', () => {
    expect(receiver.rememberDeskHandoff('../nope')).toBeNull()
    receiver.rememberDeskHandoff('Hx3_kq-9ZpL0aBcD4eFgH1', 0)
    expect(receiver.pendingDeskHandoff(receiver.PENDING_HANDOFF_MAX_AGE_MS + 1)).toBeNull()
  })
})
