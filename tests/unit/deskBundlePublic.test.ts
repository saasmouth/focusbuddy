// What a desk bundle may carry, by who can fetch it.
//
// Found by 23 (2026-11-07), before 4.3.46: the desk behind a live link is
// served to anyone without signing in (GET /share/<dsk_token>/desk/bundle), and
// it was packed exactly as a "desk they can use" link -- every widget row, the
// trash included. The live view has always promised senders that private work
// widgets (mail, chat, agents, webhooks, meeting records...) show only as "not
// available publicly". A public bundle now keeps that promise, and no bundle
// carries the trash.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'
import { PRIVATE_WIDGET_KINDS } from '../../src/shared/publicDesk'

let senderDb: SqliteDb
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
const SECRETS = [
  'whsec_live_9f8e7d6c5b4a', // a webhook's signing secret
  'Re: offer letter for Sam', // an email's subject
  'Dear Sam, the salary is', // a mail thread's body
  'Always reply as the CEO', // an agent's instructions
  'binned and private' // what is in the trash
]

function node(id: string, parent: string | null, kind: string, title: string, trashed: number | null = null): void {
  db.prepare(`INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,sort_order,created_at,updated_at,extensions_minutes,org_id,trashed_at)
              VALUES (?,?,?,?,'','open',3,3,3,0,?,?,0,'personal',?)`).run(id, parent, kind, title, NOW, NOW, trashed)
}
function widget(id: string, task: string, kind: string, title: string, content: string, trashed: number | null = null): void {
  db.prepare(`INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,created_at,updated_at,trashed_at,sync_group_id)
              VALUES (?,?,?,?,?,40,60,300,200,2,?,?,?,'sync-secret-group')`).run(id, task, kind, title, content, NOW, NOW, trashed)
}

beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(db)

  node('desk', null, 'task', 'Lesson Planning')
  node('desk-live-sub', 'desk', 'task', 'Week 1')
  node('desk-binned-sub', 'desk', 'task', 'Old week', NOW)

  widget('w-note', 'desk', 'sticky', '', 'Prep the exit ticket')
  widget('w-hook', 'desk', 'webhook', 'Grades in', JSON.stringify({ url: 'https://x.test/hook', secret: SECRETS[0] }))
  widget('w-mail', 'desk', 'email', SECRETS[1], '{"query":"from:hr"}')
  widget('w-thread', 'desk', 'mail-thread', '', SECRETS[2])
  widget('w-agent', 'desk-live-sub', 'agent', 'Desk agent', SECRETS[3])
  widget('w-calc', 'desk', 'calculator', '', '2+2') // the projection cannot draw it; the full app can: it travels
  widget('w-binned', 'desk', 'sticky', '', SECRETS[4], NOW)
  widget('w-on-binned-desk', 'desk-binned-sub', 'sticky', '', SECRETS[4])
  widget('w-doc', 'desk', 'doc', '', 'doc-binned')

  db.prepare(`INSERT INTO documents (id,doc_type,title,body,created_at,updated_at,org_id,trashed_at)
              VALUES ('doc-binned','doc','Binned doc',?,?,?,'personal',?)`).run(JSON.stringify(SECRETS[4]), NOW, NOW, NOW)
  db.prepare(`INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id,trashed_at)
              VALUES ('t-binned','desk','Binned table','{"columns":[]}',?,?,'personal',?)`).run(NOW, NOW, NOW)
  db.prepare(`INSERT INTO fb_tables (id,task_id,title,schema_json,created_at,updated_at,org_id)
              VALUES ('t-live','desk','Marks','{"columns":[]}',?,?,'personal')`).run(NOW, NOW)
  db.prepare(`INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at)
              VALUES ('r-live','t-live','{"c":"kept"}',0,?,?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO fb_rows (id,table_id,cells_json,sort_order,created_at,updated_at,trashed_at)
              VALUES ('r-binned','t-live',?,1,?,?,?)`).run(JSON.stringify({ c: SECRETS[4] }), NOW, NOW, NOW)

  senderDb = db
  mod = await import('../../src/main/db/deskBundle')
})

afterEach(() => {
  db = senderDb
})

const ids = (rows: Array<Record<string, unknown>>): string[] => rows.map((r) => String(r.id)).sort()

describe('no bundle carries the trash', () => {
  it('a binned widget, a binned desk and what is on it, a binned table, row and document stay behind', async () => {
    for (const audience of [undefined, 'link', 'public'] as const) {
      const b = await mod.buildDeskBundle('desk', { audience })
      expect(ids(b.tables.nodes), String(audience)).toEqual(['desk', 'desk-live-sub'])
      expect(ids(b.tables.widgets)).not.toContain('w-binned')
      expect(ids(b.tables.widgets)).not.toContain('w-on-binned-desk')
      expect(ids(b.tables.fb_tables)).toEqual(['t-live'])
      expect(ids(b.tables.fb_rows)).toEqual(['r-live'])
      expect(b.tables.documents).toEqual([])
      expect(JSON.stringify(b)).not.toContain(SECRETS[4])
    }
  })
})

describe('a link to use carries the desk as it is (what that link says it does)', () => {
  it('private kinds travel there unchanged', async () => {
    const b = await mod.buildDeskBundle('desk')
    const hook = b.tables.widgets.find((w) => w.id === 'w-hook')!
    expect(hook.kind).toBe('webhook')
    expect(String(hook.content)).toContain(SECRETS[0])
  })
})

describe('a public bundle (the desk behind a live link)', () => {
  it('carries every private kind only as a placeholder, where it sat and the size it was', async () => {
    const b = await mod.buildDeskBundle('desk', { audience: 'public' })
    const byId = new Map(b.tables.widgets.map((w) => [String(w.id), w]))
    for (const [id, reason] of [
      ['w-hook', 'Webhook — not available publicly'],
      ['w-mail', 'Mail — not available publicly'],
      ['w-thread', 'Email — not available publicly'],
      ['w-agent', 'Agent — not available publicly']
    ] as const) {
      const w = byId.get(id)!
      expect(w, id).toBeTruthy()
      expect(w).toMatchObject({ kind: 'sticky', title: '', content: reason, color: null, x: 40, y: 60, width: 300, height: 200, z_index: 2 })
      // Nothing else of it: not the sync group, not a column added tomorrow.
      expect(w.sync_group_id, id).toBeUndefined()
    }
    for (const secret of SECRETS) expect(JSON.stringify(b)).not.toContain(secret)
  })

  it('leaves what is not private as it is, including what only the projection could not draw', async () => {
    const b = await mod.buildDeskBundle('desk', { audience: 'public' })
    const byId = new Map(b.tables.widgets.map((w) => [String(w.id), w]))
    expect(byId.get('w-note')).toMatchObject({ kind: 'sticky', content: 'Prep the exit ticket' })
    expect(byId.get('w-calc')).toMatchObject({ kind: 'calculator', content: '2+2' })
  })

  it('names every private kind the live view promises to hide', () => {
    for (const k of ['agent', 'webhook', 'inbound-hook', 'streamdeck', 'local-app-launcher', 'email', 'chat-thread', 'mail-thread', 'meeting-record']) {
      expect(PRIVATE_WIDGET_KINDS.has(k), k).toBe(true)
    }
  })

  it('still opens: the placeholders import into a database that enforces its keys', async () => {
    const b = await mod.buildDeskBundle('desk', { audience: 'public' })
    const target = openMemoryDatabase()
    target.pragma('foreign_keys = ON')
    const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
    applyBrowserSchema(target)
    db = target
    const out = await mod.importDeskBundle(JSON.parse(JSON.stringify(b)))
    expect(out.ok, out.reason).toBe(true)
    const rows = target.prepare(`SELECT id, kind, content FROM widgets WHERE id = 'w-hook'`).all() as Array<{ kind: string; content: string }>
    expect(rows).toEqual([{ id: 'w-hook', kind: 'sticky', content: 'Webhook — not available publicly' }])
  })

  it('is what a live link sends (main liveDesk:publishBundle)', () => {
    const src = readFileSync(join(__dirname, '../../src/main/ipc/index.ts'), 'utf8')
    const at = src.indexOf("ipcMain.handle('liveDesk:publishBundle'")
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 700)).toMatch(/buildDeskBundle\(id, \{ audience: 'public'/)
  })
})
