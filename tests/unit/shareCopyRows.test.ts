// One link's desk in a visitor's browser, on real SQLite: replaced or removed
// without touching any other link's desk (src/web/worker/shareCopy.ts).
//
// Nothing here is a hand-written bundle. A sender database packs real desks
// with the real buildDeskBundle; a visitor database unpacks them with the real
// importDeskBundle, the visitor edits, the sender publishes a second version,
// and the visitor's copy of ONE desk is replaced. The other desk -- with the
// visitor's own edits on it -- must come through exactly as it was.
//
// The trap this exists for: importDeskBundle is INSERT OR IGNORE, so unpacking
// a new version over an old one keeps every old row. The first test shows the
// trap is real; the rest show replaceDesk gets out of it, one desk at a time.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
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
    remove: async (id: string, ext: string) => { blobs.delete(id + ext) },
    locate: (id: string, ext: string) => `mem:/${id}${ext}`
  }
}))

const NOW = 1_700_000_000_000
type Bundles = typeof import('../../src/main/db/deskBundle')
type Copy = typeof import('../../src/web/worker/shareCopy')
let bundles: Bundles
let copy: Copy

async function freshDb(): Promise<SqliteDb> {
  await initSqlite()
  const d = openMemoryDatabase()
  d.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(d)
  return d
}

// ── The sender's workspace ──────────────────────────────────────────────────

function node(d: SqliteDb, id: string, parent: string | null, title: string): void {
  d.prepare(`INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,sort_order,created_at,updated_at,extensions_minutes,org_id)
             VALUES (?,?,'task',?,'','open',3,3,3,0,?,?,0,'personal')`).run(id, parent, title, NOW, NOW)
}
function widget(d: SqliteDb, id: string, task: string, kind: string, content: string): void {
  d.prepare(`INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,created_at,updated_at)
             VALUES (?,?,?,'',?,0,0,200,200,1,?,?)`).run(id, task, kind, content, NOW, NOW)
}
function doc(d: SqliteDb, id: string, body: string): void {
  d.prepare(`INSERT INTO documents (id,doc_type,title,body,created_at,updated_at,org_id) VALUES (?,'doc',?,?,?,?,'personal')`)
    .run(id, id, body, NOW, NOW)
}
function file(d: SqliteDb, id: string, bytes: number[]): void {
  d.prepare(`INSERT INTO fb_files (id,original_name,mime_type,size_bytes,ext,created_at,kind,display_name,updated_at,org_id)
             VALUES (?,?,'image/png',?,'.png',?,'file',?,?,'personal')`).run(id, `${id}.png`, bytes.length, NOW, `${id}.png`, NOW)
  blobs.set(`${id}.png`, new Uint8Array(bytes))
}

/** Two desks a sender shares on two links. They share one document, doc-S. */
function senderV1(d: SqliteDb): void {
  node(d, 'desk-A', null, 'Desk A')
  node(d, 'desk-A2', 'desk-A', 'A, sub desk')
  widget(d, 'wA-note', 'desk-A', 'sticky', 'A v1')
  widget(d, 'wA-sub', 'desk-A2', 'sticky', 'A sub v1')
  widget(d, 'wA-doc', 'desk-A', 'doc', 'doc-A')
  widget(d, 'wA-shared', 'desk-A', 'doc', 'doc-S')
  widget(d, 'wA-file', 'desk-A', 'file', 'file-A1')
  widget(d, 'wA-img', 'desk-A', 'image', 'fb-file://file-A2')
  doc(d, 'doc-A', 'A doc v1')
  doc(d, 'doc-S', 'shared v1')
  file(d, 'file-A1', [1, 1, 1])
  file(d, 'file-A2', [2, 2])
  d.prepare(`INSERT INTO widget_links (id,source_widget_id,target_widget_id,task_id,created_at) VALUES ('lA','wA-note','wA-doc','desk-A',?)`).run(NOW)
  d.prepare(`INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id)
             VALUES ('tA','desk-A','Pipeline','{"columns":[]}',?,?,'personal')`).run(NOW, NOW)
  d.prepare(`INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at) VALUES ('rA','tA','{"c1":"row v1"}',0,?,?)`).run(NOW, NOW)

  node(d, 'desk-B', null, 'Desk B')
  widget(d, 'wB-note', 'desk-B', 'sticky', 'B v1')
  widget(d, 'wB-doc', 'desk-B', 'doc', 'doc-B')
  widget(d, 'wB-shared', 'desk-B', 'doc', 'doc-S')
  widget(d, 'wB-file', 'desk-B', 'file', 'file-B')
  doc(d, 'doc-B', 'B doc v1')
  file(d, 'file-B', [3, 3, 3, 3])
}

/** The sender fixes desk A: new words, a widget gone (and its picture), a widget added, the row and doc edited. */
function senderV2(d: SqliteDb): void {
  d.prepare("UPDATE widgets SET content='A v2' WHERE id='wA-note'").run()
  d.prepare("DELETE FROM widgets WHERE id='wA-img'").run()
  d.prepare("DELETE FROM fb_files WHERE id='file-A2'").run()
  widget(d, 'wA-new', 'desk-A', 'sticky', 'added in v2')
  d.prepare(`UPDATE fb_rows SET cells_json='{"c1":"row v2"}' WHERE id='rA'`).run()
  d.prepare("UPDATE fb_tables SET title='Pipeline v2' WHERE id='tA'").run()
  d.prepare("UPDATE documents SET body='A doc v2' WHERE id='doc-A'").run()
  d.prepare("UPDATE documents SET body='shared v2' WHERE id='doc-S'").run()
}

const one = <T>(d: SqliteDb, sql: string, ...p: unknown[]): T | undefined => d.prepare(sql).get(...p) as T | undefined
const ids = (d: SqliteDb, sql: string, ...p: unknown[]): string[] => (d.prepare(sql).all(...p) as Array<{ id: string }>).map((r) => r.id).sort()
const content = (d: SqliteDb, id: string): string | undefined => one<{ content: string }>(d, 'SELECT content FROM widgets WHERE id = ?', id)?.content
const body = (d: SqliteDb, id: string): string | undefined => one<{ body: string }>(d, 'SELECT body FROM documents WHERE id = ?', id)?.body

let sender: SqliteDb
let visitor: SqliteDb
let aV1: import('../../src/main/db/deskBundle').DeskBundle
let aV2: import('../../src/main/db/deskBundle').DeskBundle
let bV1: import('../../src/main/db/deskBundle').DeskBundle

beforeEach(async () => {
  blobs.clear()
  sender = await freshDb()
  db = sender
  senderV1(sender)
  bundles = await import('../../src/main/db/deskBundle')
  copy = await import('../../src/web/worker/shareCopy')
  aV1 = await bundles.buildDeskBundle('desk-A')
  bV1 = await bundles.buildDeskBundle('desk-B')
  senderV2(sender)
  aV2 = await bundles.buildDeskBundle('desk-A')

  // The visitor's browser: one database, both links unpacked into it.
  blobs.clear()
  visitor = await freshDb()
  db = visitor
  expect((await bundles.importDeskBundle(aV1)).ok).toBe(true)
  expect((await bundles.importDeskBundle(bV1)).ok).toBe(true)
  // ...and the visitor writes on both desks.
  visitor.prepare("UPDATE widgets SET content='my notes on A' WHERE id='wA-note'").run()
  widget(visitor, 'w-visitor', 'desk-A', 'sticky', 'a card the visitor added')
  visitor.prepare("UPDATE widgets SET content='my notes on B' WHERE id='wB-note'").run()
})

const deskBExactlyAsLeft = (): void => {
  expect(ids(visitor, "SELECT id FROM widgets WHERE task_id = 'desk-B'")).toEqual(['wB-doc', 'wB-file', 'wB-note', 'wB-shared'])
  expect(content(visitor, 'wB-note')).toBe('my notes on B')
  expect(body(visitor, 'doc-B')).toBe('B doc v1')
  expect(body(visitor, 'doc-S')).toBeDefined()
  expect(one(visitor, "SELECT id FROM fb_files WHERE id = 'file-B'")).toBeDefined()
  expect(blobs.get('file-B.png')).toEqual(new Uint8Array([3, 3, 3, 3]))
}

describe('why the old rows must go first', () => {
  it('unpacking v2 over v1 keeps v1: the import is INSERT OR IGNORE', async () => {
    const res = await bundles.importDeskBundle(aV2)
    expect(res.ok).toBe(true)
    expect(content(visitor, 'wA-note')).toBe('my notes on A') // not 'A v2'
    expect(body(visitor, 'doc-A')).toBe('A doc v1') // not 'A doc v2'
    expect(one<{ cells_json: string }>(visitor, "SELECT cells_json FROM fb_rows WHERE id='rA'")?.cells_json).toContain('row v1')
  })
})

describe('replacing one link’s desk', () => {
  it('puts v2 of desk A in place -- every table -- and leaves desk B exactly as the visitor left it', async () => {
    const out = await copy.replaceDesk(['desk-A'], aV2)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)

    // Desk A is v2, whole.
    expect(content(visitor, 'wA-note')).toBe('A v2')
    expect(content(visitor, 'wA-new')).toBe('added in v2')
    expect(content(visitor, 'wA-img')).toBeUndefined() // gone in v2
    expect(content(visitor, 'w-visitor')).toBeUndefined() // replaced, as the visitor agreed to
    expect(content(visitor, 'wA-sub')).toBe('A sub v1') // the sub desk came back with it
    expect(body(visitor, 'doc-A')).toBe('A doc v2')
    expect(one<{ cells_json: string }>(visitor, "SELECT cells_json FROM fb_rows WHERE id='rA'")?.cells_json).toContain('row v2')
    // fb_tables has no foreign key to its desk, so nothing would cascade it away:
    // left in place, INSERT OR IGNORE would keep last version's table.
    expect(one<{ title: string }>(visitor, "SELECT title FROM fb_tables WHERE id='tA'")?.title).toBe('Pipeline v2')
    expect(ids(visitor, "SELECT id FROM widget_links WHERE task_id = 'desk-A'")).toEqual(['lA'])
    expect(blobs.has('file-A2.png')).toBe(false) // only desk A used it, and v2 dropped it
    expect(blobs.get('file-A1.png')).toEqual(new Uint8Array([1, 1, 1]))

    // Desk B: untouched.
    deskBExactlyAsLeft()
    // The document both desks show is not removed from under B. It keeps the
    // version B was showing: replacing A must not rewrite what B says.
    expect(body(visitor, 'doc-S')).toBe('shared v1')
  })

  it('reports what it removed: desk A, its sub desk, and only what desk A alone used', async () => {
    const out = await copy.replaceDesk(['desk-A'], aV2)
    if (!out.ok) throw new Error(out.reason)
    expect(out.removed).toHaveLength(1)
    expect(out.removed[0]).toMatchObject({ rootId: 'desk-A', nodes: 2, documents: 1 })
    expect(out.removed[0].files.map((f) => f.id).sort()).toEqual(['file-A1', 'file-A2'])
    expect(out.imported.ok).toBe(true)
  })

  it('a version that could not be unpacked removes nothing', async () => {
    const before = JSON.stringify(visitor.prepare('SELECT * FROM widgets ORDER BY id').all())
    const bad: Array<[string, unknown]> = [
      ['not a bundle', { format: 'something.else' }],
      ['a newer format', { ...aV2, formatVersion: 99 }],
      ['a widget whose desk is not in it', { ...aV2, tables: { ...aV2.tables, widgets: [...aV2.tables.widgets, { id: 'w-x', task_id: 'nowhere' }] } }]
    ]
    for (const [what, b] of bad) {
      const out = await copy.replaceDesk(['desk-A'], b as never)
      expect(out.ok, what).toBe(false)
      expect(out.removed, what).toBeNull()
    }
    expect(JSON.stringify(visitor.prepare('SELECT * FROM widgets ORDER BY id').all())).toBe(before)
    expect(content(visitor, 'wA-note')).toBe('my notes on A')
  })

  it('a version whose desk has moved to a new id takes the old desk out too', async () => {
    const moved = JSON.parse(JSON.stringify(aV2).split('desk-A').join('desk-A-new'))
    const out = await copy.replaceDesk(['desk-A'], moved)
    expect(out.ok).toBe(true)
    expect(copy.deskPresent(visitor as never, 'desk-A')).toBe(false)
    expect(copy.deskPresent(visitor as never, 'desk-A-new')).toBe(true)
    deskBExactlyAsLeft()
  })
})

describe('removing one link’s desk', () => {
  it('takes every row of desk A, its own documents and files, and nothing of desk B’s', async () => {
    const removed = await copy.removeDesk('desk-A')
    expect(removed).toMatchObject({ rootId: 'desk-A', nodes: 2, documents: 1 })
    expect(ids(visitor, "SELECT id FROM nodes WHERE id IN ('desk-A','desk-A2')")).toEqual([])
    expect(ids(visitor, "SELECT id FROM widgets WHERE id LIKE 'wA-%' OR id = 'w-visitor'")).toEqual([])
    expect(ids(visitor, "SELECT id FROM fb_tables WHERE id = 'tA'")).toEqual([])
    expect(ids(visitor, "SELECT id FROM fb_rows WHERE id = 'rA'")).toEqual([])
    expect(ids(visitor, "SELECT id FROM widget_links WHERE id = 'lA'")).toEqual([])
    expect(ids(visitor, "SELECT id FROM documents WHERE id = 'doc-A'")).toEqual([])
    expect(ids(visitor, "SELECT id FROM fb_files WHERE id IN ('file-A1','file-A2')")).toEqual([])
    expect(blobs.has('file-A1.png')).toBe(false)
    expect(blobs.has('file-A2.png')).toBe(false)
    deskBExactlyAsLeft()
    expect(body(visitor, 'doc-S')).toBe('shared v1') // desk B still shows it
  })

  it('takes a document both desks showed once the second desk goes too', async () => {
    await copy.removeDesk('desk-A')
    await copy.removeDesk('desk-B')
    expect(ids(visitor, 'SELECT id FROM documents')).toEqual([])
    expect(ids(visitor, 'SELECT id FROM nodes')).toEqual([])
    expect(ids(visitor, 'SELECT id FROM widgets')).toEqual([])
    expect([...blobs.keys()]).toEqual([])
  })

  it('a desk that is not here removes nothing', async () => {
    expect(await copy.removeDesk('desk-nope')).toMatchObject({ nodes: 0, widgets: 0, documents: 0, files: [] })
    deskBExactlyAsLeft()
  })

  it('knows which desks are here', () => {
    expect(copy.deskPresent(visitor as never, 'desk-A')).toBe(true)
    expect(copy.deskPresent(visitor as never, 'desk-A2')).toBe(true)
    expect(copy.deskPresent(visitor as never, 'nope')).toBe(false)
    expect(copy.rootDesks(visitor as never).sort()).toEqual(['desk-A', 'desk-B'])
  })
})

// ── Where these channels sit ────────────────────────────────────────────────

const WEB = resolve(__dirname, '../../src/web')
function webFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...webFiles(p))
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

describe('the share page’s own channels', () => {
  it('are the only place under src/web that deletes from nodes, and say so where they do', () => {
    // The §2.5.3 lock (ciDeleteSiteLock.test.ts) covers src/main. This is its
    // counterpart for the visitor's copy: one site, marked, removing a subtree
    // it was asked for by root.
    const hits: string[] = []
    for (const f of webFiles(WEB)) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        if (/DELETE FROM (nodes\b|\$\{)/.test(l)) {
          const above = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
          hits.push(`${f.slice(WEB.length + 1)}:${above.includes('share-copy-delete') ? 'marked' : 'UNMARKED'}`)
        }
      })
    }
    expect(hits).toEqual(['worker/shareCopy.ts:marked'])
  })

  it('are served by the Worker beside the desktop’s table, not inside it', async () => {
    const index = readFileSync(join(WEB, 'worker/index.ts'), 'utf8')
    expect(index).toContain('HANDLERS[channel] ?? SHARE_COPY_HANDLERS[channel]')
    const { HANDLERS } = await import('../../src/web/worker/handlers')
    for (const ch of Object.keys(copy.SHARE_COPY_HANDLERS)) {
      expect(ch.startsWith('shareCopy:')).toBe(true)
      expect(ch in HANDLERS).toBe(false)
    }
  })

  it('pass the share window’s gate, and are never counted as the visitor’s edit', async () => {
    const { decideCall } = await import('../../src/web/api/readOnly')
    for (const ch of Object.keys(copy.SHARE_COPY_HANDLERS)) {
      expect(decideCall(ch, [])).toMatchObject({ allowed: true, edits: false })
    }
    expect(decideCall('shares:importBundle', [])).toMatchObject({ allowed: true, edits: false })
  })
})
